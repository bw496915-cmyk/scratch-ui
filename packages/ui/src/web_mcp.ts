/**
 * @file packages/ui/src/web_mcp.ts
 * @description W3C / Chrome WebMCP (`navigator.modelContext` / `document.modelContext`)
 * browser-native tool registry for Sports Ops Desk.
 *
 * Exposes structured, JSON-Schema-backed operational tools directly inside the
 * authenticated operator tab without screen scraping, fragile DOM actuation, or
 * separate external API tokens. Fails closed on invalid inputs, gates sensitive
 * mutations through `ModelContextClient.requestUserInteraction()` when available,
 * and never exposes cookies, CSRF tokens, session tokens, or raw PII.
 */

import { wagerChannelOf } from "@sportsdesk-ops/contracts"

import { readStoredRiskBreachSoundPrefs } from "./risk_breach_audio.ts"
import { buildRiskOverviewAccountsCsv, buildRiskOverviewCsvFilename } from "./risk_csv_export.ts"
import {
  buildRecentRiskAlerts,
  filterRecentRiskAlerts,
  type RecentRiskAlertStatusFilter,
  resolveAlertWagerContext,
} from "./risk_recent_alerts.ts"
import {
  MAX_RISK_EXPOSURE_LIMIT_USD,
  MIN_RISK_EXPOSURE_LIMIT_USD,
  MIN_RISK_EXPOSURE_WARNING_LIMIT_USD,
  parseRiskThresholdPairInput,
  type RiskExposureThresholds,
  type RiskThresholdEvaluation,
} from "./risk_threshold_alert.ts"
import type { OnChainXrefStatus, SharpestOnChainXrefReport } from "./sharpest_onchain_xref.ts"
import {
  DASHBOARD_TAB_IDS,
  type DashboardAlertRecord,
  type DashboardTabId,
  type LiveWager,
  type ShowcaseCustomer,
} from "./types.ts"
import { evaluateWsSyncStatus } from "./ws_sync_status.ts"

// ---------------------------------------------------------------------------
// Declarative WebMCP HTML attribute augmentation (React 19 JSX)
// ---------------------------------------------------------------------------
declare module "react" {
  interface FormHTMLAttributes<T> {
    toolname?: string | undefined
    tooldescription?: string | undefined
    toolautosubmit?: boolean | "true" | "false" | undefined
  }

  interface InputHTMLAttributes<T> {
    toolparamdescription?: string | undefined
  }
}

// ---------------------------------------------------------------------------
// W3C / Chrome WebMCP Imperative API Contracts
// ---------------------------------------------------------------------------

export interface WebMcpTextContent {
  readonly type: "text"
  readonly text: string
}

export interface WebMcpToolResult {
  readonly content: readonly WebMcpTextContent[]
  readonly isError?: boolean | undefined
  readonly structuredContent?: Readonly<Record<string, unknown>> | undefined
}

export interface WebMcpToolAnnotations {
  readonly readOnlyHint?: boolean | undefined
  readonly destructiveHint?: boolean | undefined
  readonly idempotentHint?: boolean | undefined
  readonly openWorldHint?: boolean | undefined
}

export interface WebMcpModelContextClient {
  requestUserInteraction?<T = unknown>(callback: () => Promise<T> | T): Promise<T>
}

export interface WebMcpToolRegistration {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations?: WebMcpToolAnnotations | undefined
  readonly execute: (
    input: unknown,
    client?: WebMcpModelContextClient,
  ) => Promise<WebMcpToolResult> | WebMcpToolResult
}

export interface WebMcpRegisterOptions {
  readonly signal?: AbortSignal | undefined
}

export interface WebMcpModelContext {
  registerTool(tool: WebMcpToolRegistration, options?: WebMcpRegisterOptions): void
  unregisterTool?(name: string): void
  provideContext?(options: { readonly tools: readonly WebMcpToolRegistration[] }): void
  clearContext?(): void
}

export interface WebMcpRegistrationHandle {
  readonly supported: boolean
  readonly toolNames: readonly string[]
  readonly unregister: () => void
}

// ---------------------------------------------------------------------------
// Sports Ops Desk Snapshot & Action Contracts
// ---------------------------------------------------------------------------

export interface SportsDeskWebMcpSnapshot {
  readonly activeTab: DashboardTabId
  readonly hasLiveWagerSnapshot: boolean
  readonly liveWagers: readonly LiveWager[]
  readonly profileCustomers: readonly ShowcaseCustomer[]
  readonly alertRecords: readonly DashboardAlertRecord[]
  readonly riskThresholds: RiskExposureThresholds
  readonly riskThresholdEvaluation: RiskThresholdEvaluation
  readonly rolling60mIncludedTickets: number
  readonly rolling60mAnchorMs: number
  readonly sharpestOnChainXref: SharpestOnChainXrefReport
  readonly wsConnected: boolean
  readonly wsLastPongAt: string | null
  readonly wsLastSyncAt: number | null
  readonly wsLatencyMs: number | null
  readonly wagersUpdatedAt: number | null
  readonly lastTelemetryProbeAt: string | null
}

export interface SportsDeskWebMcpActions {
  readonly setActiveTab: (tab: DashboardTabId) => void
  readonly applyWagerFilters: (filters: {
    readonly sport?: string | undefined
    readonly alert?: string | undefined
    readonly search?: string | undefined
  }) => void
  readonly focusCustomer: (customerId: string | null) => void
  readonly updateRiskThresholds: (next: RiskExposureThresholds) => void
  readonly refreshTelemetry: () => Promise<void> | void
  readonly fetchApi?: ((path: string, init?: RequestInit) => Promise<Response>) | undefined
}

// ---------------------------------------------------------------------------
// Feature Detection (Zero Polyfill / Zero Mock)
// ---------------------------------------------------------------------------

export interface BrowserModelContextEnv {
  readonly navigator?: { readonly modelContext?: unknown } | undefined
  readonly document?: { readonly modelContext?: unknown } | undefined
}

function isWebMcpModelContext(value: unknown): value is WebMcpModelContext {
  return (
    value !== null &&
    typeof value === "object" &&
    (typeof (value as { registerTool?: unknown }).registerTool === "function" ||
      typeof (value as { provideContext?: unknown }).provideContext === "function")
  )
}

/**
 * Resolves the browser's native WebMCP `ModelContext` surface, checking
 * `navigator.modelContext` first (W3C / Chrome primary entry point) and
 * falling back to `document.modelContext` (updated draft alias).
 * Returns `null` cleanly when WebMCP is unavailable.
 */
export function resolveBrowserModelContext(
  env?: BrowserModelContextEnv,
): WebMcpModelContext | null {
  const nav =
    env && "navigator" in env
      ? env.navigator
      : typeof navigator !== "undefined"
        ? (navigator as unknown as { modelContext?: unknown })
        : undefined
  if (isWebMcpModelContext(nav?.modelContext)) {
    return nav.modelContext
  }

  const doc =
    env && "document" in env
      ? env.document
      : typeof document !== "undefined"
        ? (document as unknown as { modelContext?: unknown })
        : undefined
  if (isWebMcpModelContext(doc?.modelContext)) {
    return doc.modelContext
  }

  return null
}

// ---------------------------------------------------------------------------
// Strict Input Validation Helpers
// ---------------------------------------------------------------------------

const MAX_QUERY_LEN = 200
const MAX_LIMIT = 50
const DEFAULT_LIMIT = 20
const VALID_TAB_SET = new Set<string>(DASHBOARD_TAB_IDS)
const VALID_ALERT_SEVERITY_FILTERS = new Set<RecentRiskAlertStatusFilter>(["ALL", "WARN", "BREACH"])
const VALID_XREF_STATUSES = new Set<OnChainXrefStatus | "ALL">([
  "ALL",
  "DIVERGENCE_ALERT",
  "VERIFIED_LIVE",
  "QUARANTINED_WALLET",
  "UNLINKED_SHARP",
])

function asInputRecord(input: unknown): Record<string, unknown> | null {
  if (input === undefined || input === null) return {}
  if (typeof input !== "object" || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

function okResult(payload: Record<string, unknown>): WebMcpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function errorResult(code: string, message: string): WebMcpToolResult {
  const payload = { error: code, message }
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function parseOptionalString(
  raw: unknown,
  fieldName: string,
):
  | { readonly ok: true; readonly value: string | undefined }
  | { readonly ok: false; readonly error: WebMcpToolResult } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: undefined }
  }
  if (typeof raw !== "string") {
    return {
      ok: false,
      error: errorResult("ERR_INVALID_INPUT", `${fieldName} must be a string.`),
    }
  }
  const trimmed = raw.trim()
  if (trimmed.length > MAX_QUERY_LEN) {
    return {
      ok: false,
      error: errorResult(
        "ERR_INVALID_INPUT",
        `${fieldName} exceeds maximum length of ${MAX_QUERY_LEN} characters.`,
      ),
    }
  }
  return { ok: true, value: trimmed || undefined }
}

function parseOptionalLimit(
  raw: unknown,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly error: WebMcpToolResult } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: DEFAULT_LIMIT }
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_LIMIT) {
    return {
      ok: false,
      error: errorResult(
        "ERR_INVALID_INPUT",
        `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      ),
    }
  }
  return { ok: true, value: raw }
}

function parseOptionalNonNegativeNumber(
  raw: unknown,
  fieldName: string,
):
  | { readonly ok: true; readonly value: number | undefined }
  | { readonly ok: false; readonly error: WebMcpToolResult } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined }
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    return {
      ok: false,
      error: errorResult("ERR_INVALID_INPUT", `${fieldName} must be a non-negative finite number.`),
    }
  }
  return { ok: true, value: raw }
}

// ---------------------------------------------------------------------------
// Sports Ops Desk WebMCP Tool Definitions
// ---------------------------------------------------------------------------

const VALID_WEBLOG_SORTS = new Set<string>([
  "time",
  "severity",
  "ip",
  "ipCategory",
  "ipFamily",
  "account",
  "gameId",
  "botKey",
  "event",
  "period",
  "market",
  "pick",
  "kind",
  "cadence",
  "score",
])
const VALID_WEBLOG_SEVERITIES = new Set<string>(["ALL", "CRITICAL", "HIGH", "WATCH", "NORMAL"])
const VALID_S3_STORAGE_CLASSES = new Set<string>([
  "STANDARD",
  "STANDARD_IA",
  "ONEZONE_IA",
  "INTELLIGENT_TIERING",
  "GLACIER",
  "GLACIER_IR",
  "DEEP_ARCHIVE",
  "REDUCED_REDUNDANCY",
  "EXPRESS_ONEZONE",
])

function resolveApiFetcher(
  actions: SportsDeskWebMcpActions,
): ((path: string, init?: RequestInit) => Promise<Response>) | null {
  if (typeof actions.fetchApi === "function") return actions.fetchApi
  if (typeof fetch === "function") {
    return (path, init) => fetch(path, { credentials: "same-origin", ...init })
  }
  return null
}

function hasUnsafeKeySegments(value: string): boolean {
  if (value.length > 512 || /[\x00-\x1f\x7f\\]/.test(value)) return true
  return value.split("/").some((seg) => seg === "." || seg === "..")
}

export const SPORTS_DESK_WEB_MCP_TOOL_NAMES = [
  "desk_get_risk_overview",
  "desk_list_recent_risk_alerts",
  "desk_search_live_wagers",
  "desk_get_sharpest_onchain_xref",
  "desk_navigate_view",
  "desk_set_risk_thresholds",
  "desk_refresh_telemetry",
  "desk_export_risk_csv",
  "desk_query_weblogs",
  "desk_get_weblog_vectors",
  "desk_inspect_bun_s3",
  "desk_archive_weblogs_to_s3",
] as const

export type SportsDeskWebMcpToolName = (typeof SPORTS_DESK_WEB_MCP_TOOL_NAMES)[number]

export function buildSportsDeskWebMcpTools(
  getSnapshot: () => SportsDeskWebMcpSnapshot,
  actions: SportsDeskWebMcpActions,
): readonly WebMcpToolRegistration[] {
  return [
    {
      name: "desk_get_risk_overview",
      description:
        "Returns the real-time 60-minute aggregate risk threshold status, rolling USD exposure, configured warning/breach limits, breach sound notification status, and WebSocket heartbeat sync status.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      execute: (input) => {
        const record = asInputRecord(input)
        if (!record) {
          return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")
        }
        const snap = getSnapshot()
        const wallNowMs = Date.now()
        const sync = evaluateWsSyncStatus({
          wsConnected: snap.wsConnected,
          lastHeartbeatAt: snap.wsLastPongAt ?? snap.wsLastSyncAt,
          nowMs: wallNowMs,
          latencyMs: snap.wsLatencyMs,
        })
        const soundPrefs = readStoredRiskBreachSoundPrefs()

        return okResult({
          activeTab: snap.activeTab,
          wallEpochMs: wallNowMs,
          hasLiveWagerSnapshot: snap.hasLiveWagerSnapshot,
          riskThreshold: {
            status: snap.riskThresholdEvaluation.status,
            isBreached: snap.riskThresholdEvaluation.isBreached,
            isWarning: snap.riskThresholdEvaluation.isWarning,
            totalRiskUsd: snap.riskThresholdEvaluation.totalRiskUsd,
            warningLimitUsd: snap.riskThresholdEvaluation.warningLimitUsd,
            breachLimitUsd: snap.riskThresholdEvaluation.limitUsd,
            utilizationPct: Number(snap.riskThresholdEvaluation.utilizationPct.toFixed(2)),
            excessUsd: snap.riskThresholdEvaluation.excessUsd,
            remainingUsd: snap.riskThresholdEvaluation.remainingUsd,
            includedTickets60m: snap.rolling60mIncludedTickets,
          },
          breachSoundAlert: {
            enabled: soundPrefs.enabled,
            tone: soundPrefs.tone,
            volumePct: Math.round(soundPrefs.volume * 100),
            cooldownSec: soundPrefs.cooldownSec,
          },
          wsSync: {
            state: sync.state,
            statusLabel: sync.statusLabel,
            elapsedMs: sync.elapsedMs,
            elapsedLabel: sync.elapsedLabel,
            latencyMs: snap.wsLatencyMs,
          },
          totals: {
            liveWagersCount: snap.liveWagers.length,
            profileCustomersCount: snap.profileCustomers.length,
            alertRecordsCount: snap.alertRecords.length,
          },
        })
      },
    },

    {
      name: "desk_list_recent_risk_alerts",
      description:
        "Lists historical risk breaches and threshold warnings from the last 60 minutes, linked to wager context (ticket ID, customer ID, stake, payout, effective line, and odds).",
      inputSchema: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["ALL", "WARN", "BREACH"],
            description: "Optional severity status filter (ALL, WARN, or BREACH).",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            description: "Maximum number of recent alerts to return (default 20, max 50).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      execute: (input) => {
        const record = asInputRecord(input)
        if (!record) {
          return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")
        }

        let severity: RecentRiskAlertStatusFilter = "ALL"
        if (record.severity !== undefined && record.severity !== null) {
          if (typeof record.severity !== "string") {
            return errorResult("ERR_INVALID_INPUT", "severity must be ALL, WARN, or BREACH.")
          }
          const normalized = record.severity.trim().toUpperCase() as RecentRiskAlertStatusFilter
          if (!VALID_ALERT_SEVERITY_FILTERS.has(normalized)) {
            return errorResult("ERR_INVALID_INPUT", "severity must be ALL, WARN, or BREACH.")
          }
          severity = normalized
        }

        const limitParsed = parseOptionalLimit(record.limit)
        if (!limitParsed.ok) return limitParsed.error

        const snap = getSnapshot()
        const fullFeed = buildRecentRiskAlerts({
          wagers: snap.liveWagers,
          alertRecords: snap.alertRecords,
          breachLimitUsd: snap.riskThresholds.breachLimitUsd,
          warningLimitUsd: snap.riskThresholds.warningLimitUsd,
          anchorMs: snap.rolling60mAnchorMs,
        })
        const filtered = filterRecentRiskAlerts(fullFeed, severity)
        const sliced = filtered.items.slice(0, limitParsed.value).map((item) => {
          const ctx = resolveAlertWagerContext(item)
          return {
            id: item.id,
            kind: item.kind,
            severity: item.severity,
            title: item.title,
            detail: item.detail,
            clockLabel: item.clockLabel,
            relativeAgeLabel: item.relativeAgeLabel,
            ticketId: ctx.ticketId,
            customerId: ctx.customerId,
            agentId: ctx.agentId,
            sport: ctx.sport,
            event: ctx.event,
            effectiveLine: ctx.effectiveLine,
            oddsAmerican: ctx.oddsAmerican,
            riskUsd: ctx.riskUsd,
            toWinUsd: ctx.toWinUsd,
            totalPayoutUsd: ctx.totalPayoutUsd,
            cumulativeRiskUsd: item.cumulativeRiskUsd,
            thresholdLimitUsd: item.thresholdLimitUsd,
            clvCents: ctx.clvCents,
          }
        })

        return okResult({
          severityFilter: severity,
          windowMode: filtered.windowMode,
          totalMatching: filtered.items.length,
          breachCount: fullFeed.breachCount,
          warnCount: fullFeed.warnCount,
          breachLimitUsd: fullFeed.breachLimitUsd,
          warningLimitUsd: fullFeed.warningLimitUsd,
          totalWindowRiskUsd: fullFeed.totalWindowRiskUsd,
          thresholdCrossedClockLabel: fullFeed.thresholdCrossedClockLabel,
          items: sliced,
        })
      },
    },

    {
      name: "desk_search_live_wagers",
      description:
        "Searches and filters the live open wager tape by free-text query, sport, alert tier, wager channel, or minimum USD risk.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Matches ticket ID, customer ID, agent ID, event, or selection.",
          },
          sport: {
            type: "string",
            description: "Filter by sport code (e.g. NBA, NFL, NCAAB, MLB).",
          },
          alert: {
            type: "string",
            description: "Filter by alert tier (e.g. CRITICAL, STEAM, HIGH).",
          },
          channel: {
            type: "string",
            description: "Filter by channel code (e.g. MOBILE, WEB, API).",
          },
          minRiskUsd: {
            type: "number",
            minimum: 0,
            description: "Minimum USD stake/risk amount.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            description: "Maximum rows to return (default 20, max 50).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      execute: (input) => {
        const record = asInputRecord(input)
        if (!record) {
          return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")
        }
        const query = parseOptionalString(record.query, "query")
        if (!query.ok) return query.error
        const sport = parseOptionalString(record.sport, "sport")
        if (!sport.ok) return sport.error
        const alert = parseOptionalString(record.alert, "alert")
        if (!alert.ok) return alert.error
        const channel = parseOptionalString(record.channel, "channel")
        if (!channel.ok) return channel.error
        const minRiskUsd = parseOptionalNonNegativeNumber(record.minRiskUsd, "minRiskUsd")
        if (!minRiskUsd.ok) return minRiskUsd.error
        const limit = parseOptionalLimit(record.limit)
        if (!limit.ok) return limit.error

        const qLower = query.value?.toLowerCase()
        const sportUpper = sport.value?.toUpperCase()
        const alertUpper = alert.value?.toUpperCase()
        const channelUpper = channel.value?.toUpperCase()

        const snap = getSnapshot()
        const matches = snap.liveWagers.filter((w) => {
          if (sportUpper && sportUpper !== "ALL" && w.sport.toUpperCase() !== sportUpper) {
            return false
          }
          if (alertUpper && alertUpper !== "ALL" && w.alertTier.toUpperCase() !== alertUpper) {
            return false
          }
          if (channelUpper && channelUpper !== "ALL") {
            const ch = (wagerChannelOf(w) ?? w.ticketWriter ?? "").toUpperCase()
            if (ch !== channelUpper) return false
          }
          if (minRiskUsd.value !== undefined && w.riskUsd < minRiskUsd.value) {
            return false
          }
          if (qLower) {
            const haystack = [
              w.ticketId,
              w.customerId,
              w.agentId,
              w.masterAgent,
              w.sport,
              w.event,
              w.selection,
            ]
              .join(" ")
              .toLowerCase()
            if (!haystack.includes(qLower)) return false
          }
          return true
        })

        const rows = matches.slice(0, limit.value).map((w) => ({
          ticketId: w.ticketId,
          timestamp: w.timestamp,
          customerId: w.customerId,
          agentId: w.agentId,
          sport: w.sport,
          betType: w.betType,
          channel: wagerChannelOf(w) ?? w.ticketWriter ?? null,
          event: w.event,
          selection: w.selection,
          lineDisplay: w.lineDisplay ?? null,
          oddsAmerican: w.oddsAmerican,
          riskUsd: w.riskUsd,
          toWinUsd: w.toWinUsd,
          totalPayoutUsd: w.riskUsd + w.toWinUsd,
          clvCents: w.clvCents,
          alertTier: w.alertTier,
        }))

        return okResult({
          totalMatching: matches.length,
          returned: rows.length,
          wagers: rows,
        })
      },
    },

    {
      name: "desk_get_sharpest_onchain_xref",
      description:
        "Returns the cross-reference check report comparing Sharpest sportsbook profiles against live on-chain wager tracking and bridge divergence leads.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [
              "ALL",
              "DIVERGENCE_ALERT",
              "VERIFIED_LIVE",
              "QUARANTINED_WALLET",
              "UNLINKED_SHARP",
            ],
            description: "Filter cross-reference rows by reconciliation status.",
          },
          query: {
            type: "string",
            description: "Filter by customer ID, agent ID, or wallet prefix.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            description: "Maximum rows to return (default 20, max 50).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      execute: (input) => {
        const record = asInputRecord(input)
        if (!record) {
          return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")
        }

        let status: OnChainXrefStatus | "ALL" = "ALL"
        if (record.status !== undefined && record.status !== null) {
          if (typeof record.status !== "string") {
            return errorResult("ERR_INVALID_INPUT", "status must be a valid xref status enum.")
          }
          const normalized = record.status.trim().toUpperCase() as OnChainXrefStatus | "ALL"
          if (!VALID_XREF_STATUSES.has(normalized)) {
            return errorResult(
              "ERR_INVALID_INPUT",
              "status must be ALL, DIVERGENCE_ALERT, VERIFIED_LIVE, QUARANTINED_WALLET, or UNLINKED_SHARP.",
            )
          }
          status = normalized
        }

        const query = parseOptionalString(record.query, "query")
        if (!query.ok) return query.error
        const limit = parseOptionalLimit(record.limit)
        if (!limit.ok) return limit.error

        const qLower = query.value?.toLowerCase()
        const report = getSnapshot().sharpestOnChainXref
        const matching = report.rows.filter((row) => {
          if (status !== "ALL" && row.status !== status) return false
          if (qLower) {
            const hay = [
              row.customerId,
              row.agentId,
              row.masterAgent,
              row.proxyWallet ?? "",
              row.bridgeVerdict ?? "",
            ]
              .join(" ")
              .toLowerCase()
            if (!hay.includes(qLower)) return false
          }
          return true
        })

        return okResult({
          summary: report.summary,
          statusFilter: status,
          totalMatching: matching.length,
          rows: matching.slice(0, limit.value).map((row) => ({
            customerId: row.customerId,
            agentId: row.agentId,
            tier: row.tier,
            sharpScore: row.sharpScore,
            status: row.status,
            statusLabel: row.statusLabel,
            flags: row.flags,
            checksPassed: row.checksPassed,
            checksTotal: row.checksTotal,
            shortWallet: row.shortWallet,
            walletFormatValid: row.walletFormatValid,
            walletSourceMismatch: row.walletSourceMismatch,
            dataSource: row.dataSource,
            openVolumeUsd: row.openVolumeUsd,
            positionsValueUsd: row.positionsValueUsd,
            trackedTicketCount: row.trackedTicketCount,
            trackedTicketRiskUsd: row.trackedTicketRiskUsd,
            bridgeVerdict: row.bridgeVerdict,
            bridgePriorityUsd: row.bridgePriorityUsd,
          })),
        })
      },
    },

    {
      name: "desk_navigate_view",
      description:
        "Navigates the Sports Ops Desk dashboard to a specific tab and optionally applies live wager filters or focuses a customer ID.",
      inputSchema: {
        type: "object",
        properties: {
          tab: {
            type: "string",
            enum: [...DASHBOARD_TAB_IDS],
            description: "Target dashboard tab identifier.",
          },
          sport: {
            type: "string",
            description: "Optional wager sport filter to apply.",
          },
          alert: {
            type: "string",
            description: "Optional wager alert tier filter to apply.",
          },
          search: {
            type: "string",
            description: "Optional wager search query to apply.",
          },
          customerId: {
            type: "string",
            description: "Optional customer ID to focus.",
          },
        },
        required: ["tab"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      execute: (input) => {
        const record = asInputRecord(input)
        if (!record || typeof record.tab !== "string") {
          return errorResult("ERR_INVALID_INPUT", "tab is required and must be a valid tab ID.")
        }
        const tab = record.tab.trim() as DashboardTabId
        if (!VALID_TAB_SET.has(tab)) {
          return errorResult(
            "ERR_INVALID_TAB",
            `tab must be one of: ${DASHBOARD_TAB_IDS.join(", ")}.`,
          )
        }

        const sport = parseOptionalString(record.sport, "sport")
        if (!sport.ok) return sport.error
        const alert = parseOptionalString(record.alert, "alert")
        if (!alert.ok) return alert.error
        const search = parseOptionalString(record.search, "search")
        if (!search.ok) return search.error
        const customerId = parseOptionalString(record.customerId, "customerId")
        if (!customerId.ok) return customerId.error

        if (sport.value !== undefined || alert.value !== undefined || search.value !== undefined) {
          actions.applyWagerFilters({
            sport: sport.value,
            alert: alert.value,
            search: search.value,
          })
        }
        if (customerId.value !== undefined) {
          actions.focusCustomer(customerId.value.toUpperCase())
        }
        actions.setActiveTab(tab)

        return okResult({
          navigatedTo: tab,
          appliedFilters: {
            sport: sport.value ?? null,
            alert: alert.value ?? null,
            search: search.value ?? null,
            customerId: customerId.value ? customerId.value.toUpperCase() : null,
          },
        })
      },
    },

    {
      name: "desk_set_risk_thresholds",
      description:
        "Updates and persists the custom 60-minute aggregate risk Warning and Breach USD threshold limits in browser storage. Requests explicit operator confirmation when supported by the WebMCP host.",
      inputSchema: {
        type: "object",
        properties: {
          warningLimitUsd: {
            type: "number",
            minimum: MIN_RISK_EXPOSURE_WARNING_LIMIT_USD,
            maximum: MAX_RISK_EXPOSURE_LIMIT_USD,
            description:
              "Custom 60-minute warning threshold in USD (must be below breachLimitUsd).",
          },
          breachLimitUsd: {
            type: "number",
            minimum: MIN_RISK_EXPOSURE_LIMIT_USD,
            maximum: MAX_RISK_EXPOSURE_LIMIT_USD,
            description: "Custom 60-minute breach threshold in USD.",
          },
        },
        required: ["warningLimitUsd", "breachLimitUsd"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      execute: async (input, client) => {
        const record = asInputRecord(input)
        if (!record) {
          return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")
        }
        if (
          typeof record.warningLimitUsd !== "number" ||
          typeof record.breachLimitUsd !== "number"
        ) {
          return errorResult(
            "ERR_INVALID_INPUT",
            "warningLimitUsd and breachLimitUsd must both be finite USD numbers.",
          )
        }

        const parsed = parseRiskThresholdPairInput(
          String(record.warningLimitUsd),
          String(record.breachLimitUsd),
        )
        if (!parsed.ok) {
          return errorResult("ERR_INVALID_THRESHOLDS", parsed.error)
        }

        if (typeof client?.requestUserInteraction === "function") {
          const approved = await client.requestUserInteraction(() => true)
          if (!approved) {
            return errorResult(
              "ERR_USER_CANCELLED",
              "Operator cancelled the 60-minute risk threshold update.",
            )
          }
        }

        actions.updateRiskThresholds(parsed.value)
        return okResult({
          updated: true,
          warningLimitUsd: parsed.value.warningLimitUsd,
          breachLimitUsd: parsed.value.breachLimitUsd,
        })
      },
    },

    {
      name: "desk_refresh_telemetry",
      description:
        "Triggers a live telemetry refresh across wagers, customer cohorts, R2 pipeline health, and WebSocket sync status.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
      execute: async (input) => {
        const record = asInputRecord(input)
        if (!record) {
          return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")
        }
        const startedMonoMs = performance.now()
        await actions.refreshTelemetry()
        const durationMs = Number((performance.now() - startedMonoMs).toFixed(2))
        const snap = getSnapshot()
        return okResult({
          refreshed: true,
          durationMs,
          wallEpochMs: Date.now(),
          wsConnected: snap.wsConnected,
          lastTelemetryProbeAt: snap.lastTelemetryProbeAt,
          liveWagersCount: snap.liveWagers.length,
        })
      },
    },

    {
      name: "desk_export_risk_csv",
      description:
        "Generates the current Risk Overview accounts breach dataset as an RFC 4180 formula-safe CSV string and recommended filename.",
      inputSchema: {
        type: "object",
        properties: {
          maxRows: {
            type: "integer",
            minimum: 1,
            maximum: 250,
            description: "Optional cap on customer rows included in the CSV output (default 100).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      execute: (input) => {
        const record = asInputRecord(input)
        if (!record) {
          return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")
        }
        let maxRows = 100
        if (record.maxRows !== undefined && record.maxRows !== null) {
          if (
            typeof record.maxRows !== "number" ||
            !Number.isInteger(record.maxRows) ||
            record.maxRows < 1 ||
            record.maxRows > 250
          ) {
            return errorResult("ERR_INVALID_INPUT", "maxRows must be an integer between 1 and 250.")
          }
          maxRows = record.maxRows
        }

        const snap = getSnapshot()
        const customers = snap.profileCustomers.slice(0, maxRows)
        const csv = buildRiskOverviewAccountsCsv(customers, snap.liveWagers)
        const filename = buildRiskOverviewCsvFilename()

        return okResult({
          filename,
          rowCount: customers.length,
          totalCustomersAvailable: snap.profileCustomers.length,
          csv,
        })
      },
    },

    {
      name: "desk_query_weblogs",
      description:
        "Queries redacted Fantasy402 / SportsDesk surveillance weblogs via /api/weblogs with multi-field sorting, severity/account/kind/market filtering, and subnet-redacted IP forensics.",
      inputSchema: {
        type: "object",
        properties: {
          sort: {
            type: "string",
            enum: [...VALID_WEBLOG_SORTS],
            description: "Sort field (default: time).",
          },
          dir: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Sort direction (default: desc).",
          },
          severity: {
            type: "string",
            enum: ["ALL", "CRITICAL", "HIGH", "WATCH", "NORMAL"],
            description: "Filter weblog entries by severity.",
          },
          account: {
            type: "string",
            description: "Filter by account / customer ID.",
          },
          kind: {
            type: "string",
            description: "Filter by weblog event kind.",
          },
          market: {
            type: "string",
            description: "Filter by market code.",
          },
          ipFamily: {
            type: "string",
            enum: ["IPv4", "IPv6", "Unknown"],
            description: "Filter by IP family.",
          },
          query: {
            type: "string",
            description: "Free-text search over redacted weblog actions and game IDs.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MAX_LIMIT,
            description: "Maximum entries to return (default 20, max 50).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      execute: async (input) => {
        const record = asInputRecord(input)
        if (!record) return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")

        const sortRaw = parseOptionalString(record.sort, "sort")
        if (!sortRaw.ok) return sortRaw.error
        const sort = sortRaw.value ?? "time"
        if (!VALID_WEBLOG_SORTS.has(sort)) {
          return errorResult("ERR_INVALID_INPUT", "Invalid weblog sort field.")
        }

        const dirRaw = parseOptionalString(record.dir, "dir")
        if (!dirRaw.ok) return dirRaw.error
        const dir = dirRaw.value === "asc" ? "asc" : "desc"

        const severityRaw = parseOptionalString(record.severity, "severity")
        if (!severityRaw.ok) return severityRaw.error
        const severity = severityRaw.value ? severityRaw.value.toUpperCase() : undefined
        if (severity && !VALID_WEBLOG_SEVERITIES.has(severity)) {
          return errorResult(
            "ERR_INVALID_INPUT",
            "severity must be ALL, CRITICAL, HIGH, WATCH, or NORMAL.",
          )
        }

        const account = parseOptionalString(record.account, "account")
        if (!account.ok) return account.error
        const kind = parseOptionalString(record.kind, "kind")
        if (!kind.ok) return kind.error
        const market = parseOptionalString(record.market, "market")
        if (!market.ok) return market.error
        const ipFamily = parseOptionalString(record.ipFamily, "ipFamily")
        if (!ipFamily.ok) return ipFamily.error
        const query = parseOptionalString(record.query, "query")
        if (!query.ok) return query.error
        const limit = parseOptionalLimit(record.limit)
        if (!limit.ok) return limit.error

        const fetcher = resolveApiFetcher(actions)
        if (!fetcher) return errorResult("ERR_FETCH_UNAVAILABLE", "Browser fetch API unavailable.")

        const params = new URLSearchParams({ sort, dir, limit: String(limit.value) })
        if (severity && severity !== "ALL") params.set("severity", severity)
        if (account.value) params.set("account", account.value)
        if (kind.value) params.set("kind", kind.value)
        if (market.value) params.set("market", market.value)
        if (ipFamily.value) params.set("ipFamily", ipFamily.value)
        if (query.value) params.set("q", query.value)

        const res = await fetcher(`/api/weblogs?${params.toString()}`)
        if (!res.ok) {
          return errorResult("ERR_WEBLOGS_HTTP", `Weblogs query failed with HTTP ${res.status}.`)
        }
        const data = (await res.json()) as {
          source?: string
          summary?: Record<string, unknown>
          entries?: Array<Record<string, unknown>>
          generatedAt?: string
        }
        const entries = (data.entries ?? []).slice(0, limit.value).map((entry) => {
          const ipMeta = (entry.ipMeta ?? {}) as Record<string, unknown>
          return {
            id: entry.id ?? null,
            dateLabel: entry.dateLabel ?? null,
            timeEst: entry.timeEst ?? null,
            ipRedacted: ipMeta.ip ?? entry.ip ?? null,
            ipFamily: ipMeta.family ?? null,
            subnet: ipMeta.subnet24 ?? null,
            accountId: entry.accountId ?? null,
            eventKind: entry.eventKind ?? null,
            severity: entry.severity ?? null,
            vectorScore: entry.vectorScore ?? null,
            interArrivalSec: entry.interArrivalSec ?? null,
            clusterLabel: entry.clusterLabel ?? null,
            ticketId: entry.ticketId ?? entry.ticketNumber ?? null,
            gameId: entry.gameId ?? null,
          }
        })

        return okResult({
          source: data.source ?? "unknown",
          generatedAt: data.generatedAt ?? null,
          summary: data.summary ?? null,
          returned: entries.length,
          entries,
        })
      },
    },

    {
      name: "desk_get_weblog_vectors",
      description:
        "Returns 6-axis behavioral bot vector clusters and cosine similarity pairs derived from Fantasy402 / SportsDesk weblogs.",
      inputSchema: {
        type: "object",
        properties: {
          minBotScore: {
            type: "number",
            minimum: 0,
            maximum: 100,
            description: "Minimum 0..100 behavioral bot score to include.",
          },
          account: {
            type: "string",
            description: "Optional account ID filter.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 25,
            description: "Maximum vector clusters to return (default 15, max 25).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      execute: async (input) => {
        const record = asInputRecord(input)
        if (!record) return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")

        const minBotScore = parseOptionalNonNegativeNumber(record.minBotScore, "minBotScore")
        if (!minBotScore.ok) return minBotScore.error
        if (minBotScore.value !== undefined && minBotScore.value > 100) {
          return errorResult("ERR_INVALID_INPUT", "minBotScore must be between 0 and 100.")
        }
        const account = parseOptionalString(record.account, "account")
        if (!account.ok) return account.error

        let limit = 15
        if (record.limit !== undefined && record.limit !== null) {
          if (
            typeof record.limit !== "number" ||
            !Number.isInteger(record.limit) ||
            record.limit < 1 ||
            record.limit > 25
          ) {
            return errorResult("ERR_INVALID_INPUT", "limit must be an integer between 1 and 25.")
          }
          limit = record.limit
        }

        const fetcher = resolveApiFetcher(actions)
        if (!fetcher) return errorResult("ERR_FETCH_UNAVAILABLE", "Browser fetch API unavailable.")

        const params = new URLSearchParams({ sort: "score", dir: "desc" })
        if (account.value) params.set("account", account.value)

        const res = await fetcher(`/api/weblogs?${params.toString()}`)
        if (!res.ok) {
          return errorResult(
            "ERR_WEBLOGS_HTTP",
            `Weblog vectors query failed with HTTP ${res.status}.`,
          )
        }
        const data = (await res.json()) as {
          source?: string
          summary?: Record<string, unknown>
          vectors?: Array<Record<string, unknown>>
          cosinePairs?: Array<Record<string, unknown>>
        }
        const floor = minBotScore.value ?? 0
        const vectors = (data.vectors ?? [])
          .filter((v) => Number(v.botScore ?? 0) >= floor)
          .slice(0, limit)
          .map((v) => ({
            vectorId: v.vectorId ?? null,
            accountId: v.accountId ?? null,
            ipRedacted: v.ip ?? null,
            subnet: v.subnet24 ?? null,
            eventCount: v.eventCount ?? 0,
            blockCount: v.blockCount ?? 0,
            medianCadenceSec: v.medianCadenceSec ?? null,
            botScore: v.botScore ?? 0,
            axes: v.axes ?? null,
          }))

        return okResult({
          source: data.source ?? "unknown",
          summary: data.summary ?? null,
          vectorCount: vectors.length,
          vectors,
          cosinePairs: (data.cosinePairs ?? []).slice(0, limit),
        })
      },
    },

    {
      name: "desk_inspect_bun_s3",
      description:
        "Inspects Bun's native S3Client runtime capabilities (list, stat, write, storageClass, requestPayer, sealed Bun.s3 posture), or lists/stats R2 objects when admin-authorized.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["capabilities", "list", "stat"],
            description:
              "Operation mode: capabilities (default), list (ListObjectsV2), or stat (HEAD metadata).",
          },
          prefix: {
            type: "string",
            description: "Optional object prefix when action=list.",
          },
          key: {
            type: "string",
            description: "Required object key when action=stat.",
          },
          maxKeys: {
            type: "integer",
            minimum: 1,
            maximum: 200,
            description: "Optional page size when action=list (default 50, max 200).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      execute: async (input) => {
        const record = asInputRecord(input)
        if (!record) return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")

        const actionRaw = parseOptionalString(record.action, "action")
        if (!actionRaw.ok) return actionRaw.error
        const action = actionRaw.value ?? "capabilities"
        if (action !== "capabilities" && action !== "list" && action !== "stat") {
          return errorResult("ERR_INVALID_INPUT", "action must be capabilities, list, or stat.")
        }

        const fetcher = resolveApiFetcher(actions)
        if (!fetcher) return errorResult("ERR_FETCH_UNAVAILABLE", "Browser fetch API unavailable.")

        if (action === "capabilities") {
          const res = await fetcher("/api/r2/client/inspect")
          if (!res.ok) {
            return errorResult("ERR_S3_INSPECT_HTTP", `S3 inspect failed with HTTP ${res.status}.`)
          }
          return okResult((await res.json()) as Record<string, unknown>)
        }

        if (action === "list") {
          const prefix = parseOptionalString(record.prefix, "prefix")
          if (!prefix.ok) return prefix.error
          if (prefix.value && hasUnsafeKeySegments(prefix.value)) {
            return errorResult("ERR_S3_INVALID_PREFIX", "prefix contains disallowed path segments.")
          }
          let maxKeys = 50
          if (record.maxKeys !== undefined && record.maxKeys !== null) {
            if (
              typeof record.maxKeys !== "number" ||
              !Number.isInteger(record.maxKeys) ||
              record.maxKeys < 1 ||
              record.maxKeys > 200
            ) {
              return errorResult(
                "ERR_INVALID_INPUT",
                "maxKeys must be an integer between 1 and 200.",
              )
            }
            maxKeys = record.maxKeys
          }
          const params = new URLSearchParams({ maxKeys: String(maxKeys) })
          if (prefix.value) params.set("prefix", prefix.value)
          const res = await fetcher(`/api/r2/client/list?${params.toString()}`)
          if (!res.ok) {
            return errorResult("ERR_S3_LIST_HTTP", `S3 list failed with HTTP ${res.status}.`)
          }
          return okResult((await res.json()) as Record<string, unknown>)
        }

        const key = parseOptionalString(record.key, "key")
        if (!key.ok) return key.error
        if (!key.value || hasUnsafeKeySegments(key.value)) {
          return errorResult(
            "ERR_S3_INVALID_KEY",
            "key is required for action=stat and cannot contain traversal segments.",
          )
        }
        const res = await fetcher(`/api/r2/client/stat?key=${encodeURIComponent(key.value)}`)
        if (!res.ok) {
          return errorResult("ERR_S3_STAT_HTTP", `S3 stat failed with HTTP ${res.status}.`)
        }
        return okResult((await res.json()) as Record<string, unknown>)
      },
    },

    {
      name: "desk_archive_weblogs_to_s3",
      description:
        "Archives redacted surveillance weblogs directly to Cloudflare R2 as NDJSON via Bun's native S3Client with configurable storageClass. Requests operator approval when supported.",
      inputSchema: {
        type: "object",
        properties: {
          severity: {
            type: "string",
            enum: ["ALL", "CRITICAL", "HIGH", "WATCH", "NORMAL"],
            description: "Optional severity filter for entries included in the archive.",
          },
          account: {
            type: "string",
            description: "Optional account ID filter.",
          },
          query: {
            type: "string",
            description: "Optional search query filter.",
          },
          storageClass: {
            type: "string",
            enum: [...VALID_S3_STORAGE_CLASSES],
            description: "Target Bun S3 storageClass (default: STANDARD_IA).",
          },
          maxEntries: {
            type: "integer",
            minimum: 1,
            maximum: 2000,
            description: "Maximum redacted weblog rows to include (default 500, max 2000).",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
      execute: async (input, client) => {
        const record = asInputRecord(input)
        if (!record) return errorResult("ERR_INVALID_INPUT", "Input must be a JSON object.")

        const severityRaw = parseOptionalString(record.severity, "severity")
        if (!severityRaw.ok) return severityRaw.error
        const severity = severityRaw.value ? severityRaw.value.toUpperCase() : undefined
        if (severity && !VALID_WEBLOG_SEVERITIES.has(severity)) {
          return errorResult(
            "ERR_INVALID_INPUT",
            "severity must be ALL, CRITICAL, HIGH, WATCH, or NORMAL.",
          )
        }
        const account = parseOptionalString(record.account, "account")
        if (!account.ok) return account.error
        const query = parseOptionalString(record.query, "query")
        if (!query.ok) return query.error

        const storageClassRaw = parseOptionalString(record.storageClass, "storageClass")
        if (!storageClassRaw.ok) return storageClassRaw.error
        const storageClass = storageClassRaw.value ?? "STANDARD_IA"
        if (!VALID_S3_STORAGE_CLASSES.has(storageClass)) {
          return errorResult("ERR_S3_INVALID_STORAGE_CLASS", "Unsupported S3 storageClass.")
        }

        let maxEntries = 500
        if (record.maxEntries !== undefined && record.maxEntries !== null) {
          if (
            typeof record.maxEntries !== "number" ||
            !Number.isInteger(record.maxEntries) ||
            record.maxEntries < 1 ||
            record.maxEntries > 2000
          ) {
            return errorResult(
              "ERR_INVALID_INPUT",
              "maxEntries must be an integer between 1 and 2000.",
            )
          }
          maxEntries = record.maxEntries
        }

        if (typeof client?.requestUserInteraction === "function") {
          const approved = await client.requestUserInteraction(() => true)
          if (!approved) {
            return errorResult(
              "ERR_USER_CANCELLED",
              "Operator cancelled the weblogs-to-R2 S3 archive operation.",
            )
          }
        }

        const fetcher = resolveApiFetcher(actions)
        if (!fetcher) return errorResult("ERR_FETCH_UNAVAILABLE", "Browser fetch API unavailable.")

        const res = await fetcher("/api/weblogs/archive-s3", {
          method: "POST",
          body: JSON.stringify({
            severity: severity && severity !== "ALL" ? severity : undefined,
            account: account.value,
            q: query.value,
            storageClass,
            maxEntries,
          }),
        })
        if (!res.ok) {
          return errorResult(
            "ERR_S3_ARCHIVE_HTTP",
            `Weblogs S3 archive failed with HTTP ${res.status}.`,
          )
        }
        return okResult((await res.json()) as Record<string, unknown>)
      },
    },
  ]
}

/**
 * Registers all Sports Ops Desk WebMCP tools on the given browser `ModelContext`
 * using `registerTool` + `AbortSignal` (or `provideContext` fallback) for clean
 * teardown and duplicate prevention.
 */
export function registerSportsDeskWebMcpTools(
  modelContext: WebMcpModelContext | null,
  getSnapshot: () => SportsDeskWebMcpSnapshot,
  actions: SportsDeskWebMcpActions,
): WebMcpRegistrationHandle {
  if (!modelContext) {
    return {
      supported: false,
      toolNames: [],
      unregister: () => {},
    }
  }

  const controller = new AbortController()
  const tools = buildSportsDeskWebMcpTools(getSnapshot, actions)
  const registered: string[] = []

  if (typeof modelContext.registerTool === "function") {
    for (const tool of tools) {
      modelContext.registerTool(tool, { signal: controller.signal })
      registered.push(tool.name)
    }
  } else if (typeof modelContext.provideContext === "function") {
    modelContext.provideContext({ tools })
    for (const tool of tools) {
      registered.push(tool.name)
    }
  }

  let tornDown = false
  return {
    supported: true,
    toolNames: registered,
    unregister: () => {
      if (tornDown) return
      tornDown = true
      controller.abort()
      if (typeof modelContext.unregisterTool === "function") {
        for (const name of registered) {
          try {
            modelContext.unregisterTool(name)
          } catch {
            // Browser may already have removed tools when AbortSignal fired.
          }
        }
      } else if (typeof modelContext.clearContext === "function") {
        try {
          modelContext.clearContext()
        } catch {
          // Ignore teardown errors from host implementation.
        }
      }
    },
  }
}
