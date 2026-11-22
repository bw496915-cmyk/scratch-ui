/**
 * @file packages/ui/src/hydration.ts
 * @description Browser-safe hydration normalizers, dynamic cohort KPI derivation,
 * Signal-Honesty provenance badges, and zero-DOM feed loader for `@sportsdesk-ops/ui`.
 */

import {
  type SlabPolicySummary,
  wagerChannelOf,
  type WagersWireContractSummary,
  type WagersWireViolation,
  type WagerTier,
} from "@sportsdesk-ops/contracts"

import type {
  CustomersApiResponse,
  CustomersCohortsSummary,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  LiveWager,
  MasterAgentDownline30d,
  ProxyConduit30d,
  RankedPlayer30d,
  SubAgentDownline30d,
  TierStyleConfig,
} from "./types.ts"

export const PENDING_WAGERS_PROVENANCE: DashboardSourceProvenance = {
  kind: "pending",
  label: "Pending Hydration",
  sourcePath: "/api/wagers",
  observedAt: "",
}

export const PENDING_COHORTS_PROVENANCE: DashboardSourceProvenance = {
  kind: "pending",
  label: "Pending Hydration",
  sourcePath: "/api/customers",
  observedAt: "",
}

export interface ProvenanceBadgePresentation {
  readonly badgeText: string
  readonly fg: string
  readonly bg: string
  readonly border: string
  readonly isLive: boolean
  readonly detail: string
}

export interface NormalizedLiveWagersResult {
  readonly wagers: readonly LiveWager[]
  readonly totalRiskUsd: number
  readonly totalToWinUsd: number
  readonly criticalSteamCount: number
  readonly provenance: DashboardSourceProvenance
  /** Vendor wire-contract summary when the feed host checks it; null otherwise. */
  readonly wireContract: WagersWireContractSummary | null
  /** Slab policy when the host exposes it; null otherwise. */
  readonly slabPolicy: SlabPolicySummary | null
}

export type CustomerCohortKpiId =
  | "backtest"
  | "key-number-sharps"
  | "hook-syndicates"
  | "fixtures"
  | "enriched-book"
  | "unique-surveillance"

export type CustomerCohortKpiTone = "sky" | "red" | "amber" | "slate" | "emerald" | "violet"

export interface CustomerCohortKpiCard {
  readonly id: CustomerCohortKpiId
  readonly label: string
  readonly value: string
  readonly sub: string
  readonly status: "pending" | "ready" | "unavailable"
  readonly tone: CustomerCohortKpiTone
  /** Exact raw count when ready; null when pending or unavailable (never faked as 0). */
  readonly count: number | null
  /** Percentage share of uniqueSurveillanceCount when ready and denominator > 0; null otherwise. */
  readonly sharePct: number | null
  /** Optional profile tier filter activated when clicking this card in CustomersTabPanel. */
  readonly filterTier: "ALL" | "ELITE" | "SYNDICATE" | null
}

const KNOWN_PROVENANCE_KINDS = new Set<DashboardFeedProvenanceKind>([
  "live",
  "capture",
  "fixture",
  "fallback",
  "showcase",
  "pending",
  "unavailable",
])

function normalizeAlertTier(raw: unknown): WagerTier {
  switch (String(raw ?? "").toUpperCase()) {
    case "CRITICAL":
    case "ORIGINATOR_HIGH_RISK":
      return "CRITICAL"
    case "STEAM":
    case "STEAM_MOVE":
      return "STEAM"
    case "LATENCY":
    case "LATENCY_ARB":
      return "LATENCY"
    default:
      return "RECREATIONAL"
  }
}

function normalizeProvenance(
  raw: unknown,
  fallbackKind: DashboardFeedProvenanceKind,
  fallbackLabel: string,
): DashboardSourceProvenance {
  if (typeof raw === "object" && raw !== null) {
    const rec = raw as Record<string, unknown>
    const rawKind = String(rec.kind ?? "") as DashboardFeedProvenanceKind
    const kind = KNOWN_PROVENANCE_KINDS.has(rawKind) ? rawKind : fallbackKind
    const label =
      typeof rec.label === "string" && rec.label.trim().length > 0 ? rec.label : fallbackLabel
    const sourcePath =
      typeof rec.sourcePath === "string" && rec.sourcePath.trim().length > 0 ? rec.sourcePath : null
    const observedAt = typeof rec.observedAt === "string" ? rec.observedAt : ""
    return {
      kind,
      label,
      sourcePath,
      observedAt,
      ...(rec.partial === true ? { partial: true } : {}),
      ...(typeof rec.latestTicketTime === "string"
        ? { latestTicketTime: rec.latestTicketTime }
        : {}),
      ...(typeof rec.omittedRowCount === "number" &&
      Number.isSafeInteger(rec.omittedRowCount) &&
      rec.omittedRowCount > 0
        ? { omittedRowCount: rec.omittedRowCount }
        : {}),
    }
  }
  return {
    kind: fallbackKind,
    label: fallbackLabel,
    sourcePath: null,
    observedAt: "",
  }
}

/** Format a Signal-Honesty provenance badge (explicitly distinguishing `[not live]` & failures). */
export function formatProvenanceBadge(
  provenance: DashboardSourceProvenance,
  options: {
    readonly staleAfterMinutes?: number | undefined
    readonly nowMs?: number | undefined
  } = {},
): ProvenanceBadgePresentation {
  const detail = provenance.sourcePath
    ? `${provenance.label} (${provenance.sourcePath})`
    : provenance.label
  const observedMs = Date.parse(provenance.observedAt)
  const stale =
    options.staleAfterMinutes !== undefined &&
    Number.isFinite(observedMs) &&
    (options.nowMs ?? Date.now()) - observedMs > options.staleAfterMinutes * 60_000
  const suffix = stale ? " · STALE" : ""

  switch (provenance.kind) {
    case "live":
      return {
        badgeText: `● LIVE CAPTURE${suffix}`,
        fg: "#4ade80",
        bg: "rgba(34, 197, 94, 0.14)",
        border: "rgba(34, 197, 94, 0.4)",
        isLive: true,
        detail,
      }
    case "capture":
      return {
        badgeText: `● LOCAL CAPTURE${suffix}`,
        fg: "#4ade80",
        bg: "rgba(34, 197, 94, 0.14)",
        border: "rgba(34, 197, 94, 0.4)",
        isLive: false,
        detail,
      }
    case "fixture":
      return {
        badgeText: `◐ FIXTURE [not live]${suffix}`,
        fg: "#fbbf24",
        bg: "rgba(245, 158, 11, 0.14)",
        border: "rgba(245, 158, 11, 0.4)",
        isLive: false,
        detail,
      }
    case "fallback":
    case "showcase":
      return {
        badgeText: `◌ SHOWCASE [not live]${suffix}`,
        fg: "#fb923c",
        bg: "rgba(251, 146, 60, 0.14)",
        border: "rgba(251, 146, 60, 0.4)",
        isLive: false,
        detail,
      }
    case "pending":
      return {
        badgeText: "⋯ PENDING",
        fg: "#38bdf8",
        bg: "rgba(56, 189, 248, 0.14)",
        border: "rgba(56, 189, 248, 0.35)",
        isLive: false,
        detail,
      }
    case "unavailable":
      return {
        badgeText: "✕ UNAVAILABLE",
        fg: "#f87171",
        bg: "rgba(239, 68, 68, 0.15)",
        border: "rgba(239, 68, 68, 0.45)",
        isLive: false,
        detail,
      }
  }
}

/** Normalize a raw `/api/wagers` item into a strict UI `LiveWager` (`autoExecute: false`). */
export function normalizeHydratedWagerRow(raw: Record<string, unknown>, idx: number): LiveWager {
  const riskUsd = Number(raw.riskUsd ?? 0)
  const toWinUsd = Number(raw.toWinUsd ?? 0)
  const clvCents =
    typeof raw.clvCents === "number" && Number.isFinite(raw.clvCents) ? raw.clvCents : null
  const maxRecommendedStake = Number(raw.maxRecommendedStake ?? 0)
  const alertTier = normalizeAlertTier(raw.alertTier)
  const ticketWriter = typeof raw.ticketWriter === "string" ? raw.ticketWriter.trim() : ""
  const volumeUsd = Number(raw.volumeUsd)
  return {
    ticketId: String(raw.ticketId ?? `W-HYD-${idx}`),
    timestamp: String(raw.timestamp ?? "—"),
    customerId: String(raw.customerId ?? `CUST-${idx}`),
    agentId: String(raw.agentId ?? "AG01"),
    masterAgent: String(raw.masterAgent ?? "MASTER_A"),
    ...(ticketWriter === "" ? {} : { ticketWriter }),
    writer: wagerChannelOf(raw.writer ?? ticketWriter),
    ...(Number.isFinite(volumeUsd) ? { volumeUsd } : {}),
    ...(raw.vip === true ? { vip: true } : {}),
    sport: raw.sport == null ? "" : String(raw.sport).toUpperCase(),
    subSport:
      raw.subSport == null || String(raw.subSport).trim() === ""
        ? null
        : String(raw.subSport).toUpperCase(),
    betType: String(raw.betType ?? "Straight"),
    event: String(raw.event ?? "Event Matchup"),
    selection: String(raw.selection ?? "Selection"),
    lineDisplay: String(raw.lineDisplay ?? "ML"),
    oddsAmerican: String(raw.oddsAmerican ?? "—"),
    riskUsd: Number.isFinite(riskUsd) ? riskUsd : 0,
    toWinUsd: Number.isFinite(toWinUsd) ? toWinUsd : 0,
    clvCents,
    alertTier,
    alertBadge: String(raw.alertBadge ?? alertTier),
    operatorDirective: String(raw.operatorDirective ?? "Accept Normal (autoExecute: false)"),
    maxRecommendedStake: Number.isFinite(maxRecommendedStake) ? maxRecommendedStake : 0,
    autoExecute: false,
  }
}

/** Validate and normalize a `GET /api/wagers` JSON payload. */
export function normalizeLiveWagersResponse(raw: unknown): NormalizedLiveWagersResult | null {
  if (typeof raw !== "object" || raw === null) return null
  const rec = raw as Record<string, unknown>
  if (!Array.isArray(rec.wagers)) return null

  const wagers = rec.wagers
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item, idx) => normalizeHydratedWagerRow(item, idx))

  const computedRisk = wagers.reduce((sum, w) => sum + w.riskUsd, 0)
  const computedToWin = wagers.reduce((sum, w) => sum + w.toWinUsd, 0)
  const computedCritSteam = wagers.filter(
    (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
  ).length

  return {
    wagers,
    totalRiskUsd: typeof rec.totalRiskUsd === "number" ? rec.totalRiskUsd : computedRisk,
    totalToWinUsd: typeof rec.totalToWinUsd === "number" ? rec.totalToWinUsd : computedToWin,
    criticalSteamCount:
      typeof rec.criticalSteamCount === "number" ? rec.criticalSteamCount : computedCritSteam,
    provenance: normalizeProvenance(rec.provenance, "capture", "API Wagers Feed"),
    wireContract: normalizeWireContract(rec.wire_contract),
    slabPolicy: normalizeSlabPolicy(rec.slab_policy),
  }
}

/** Structural parse of `slab_policy`; a malformed block is dropped, not guessed. */
function normalizeSlabPolicy(raw: unknown): SlabPolicySummary | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  const sentinels = rec["sentinels"]
  if (typeof rec["schema"] !== "string" || typeof rec["version"] !== "string") {
    return null
  }
  if (typeof rec["window_bytes"] !== "number" || rec["window_bytes"] <= 0) {
    return null
  }
  if (typeof rec["unsafe_allowed"] !== "boolean") return null
  if (typeof sentinels !== "object" || sentinels === null) return null
  const s = sentinels as Record<string, unknown>
  for (const key of ["null_clv", "null_customer_handle32", "null_bridge_channel_word32"]) {
    if (typeof s[key] !== "number") return null
  }
  return {
    schema: rec["schema"],
    version: rec["version"],
    window_bytes: rec["window_bytes"],
    unsafe_allowed: rec["unsafe_allowed"],
    sentinels: {
      null_clv: s["null_clv"] as number,
      null_customer_handle32: s["null_customer_handle32"] as number,
      null_bridge_channel_word32: s["null_bridge_channel_word32"] as number,
    },
  }
}

/** Structural parse of `wire_contract`; a malformed block is dropped, not guessed. */
function normalizeWireContract(raw: unknown): WagersWireContractSummary | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.ok !== "boolean") return null
  const violations: WagersWireViolation[] = []
  if (Array.isArray(rec.violations)) {
    for (const entry of rec.violations) {
      if (typeof entry !== "object" || entry === null) continue
      const v = entry as Record<string, unknown>
      if (
        typeof v.field !== "string" ||
        (v.kind !== "type" && v.kind !== "nullable") ||
        typeof v.count !== "number"
      ) {
        continue
      }
      violations.push({
        field: v.field,
        kind: v.kind,
        count: v.count,
        examples: Array.isArray(v.examples)
          ? v.examples.filter((e): e is string => typeof e === "string")
          : [],
      })
    }
  }
  return {
    ok: rec.ok,
    registry: typeof rec.registry === "string" ? rec.registry : "",
    capture: typeof rec.capture === "string" ? rec.capture : "",
    capture_sha256: typeof rec.capture_sha256 === "string" ? rec.capture_sha256 : "",
    enum_source: typeof rec.enum_source === "string" ? rec.enum_source : "unknown",
    fields_checked: Array.isArray(rec.fields_checked)
      ? rec.fields_checked.filter((f): f is string => typeof f === "string")
      : [],
    rows: typeof rec.rows === "number" ? rec.rows : 0,
    skipped_rows: typeof rec.skipped_rows === "number" ? rec.skipped_rows : 0,
    violations,
    ...(typeof rec.error === "string" ? { error: rec.error } : {}),
  }
}

/** Validate and normalize a `GET /api/customers` JSON payload. */
export function normalizeCustomersCohortResponse(raw: unknown): CustomersApiResponse | null {
  if (typeof raw !== "object" || raw === null) return null
  const rec = raw as Record<string, unknown>
  if (typeof rec.cohorts !== "object" || rec.cohorts === null) return null
  const rawCohorts = rec.cohorts as Record<string, unknown>

  const numOrZero = (val: unknown): number => {
    const n = Number(val)
    return Number.isFinite(n) && n >= 0 ? n : 0
  }

  const cohorts: CustomersCohortsSummary = {
    backtestCount: numOrZero(rawCohorts.backtestCount),
    keyNumberSharpsCount: numOrZero(rawCohorts.keyNumberSharpsCount),
    hookSyndicateCount: numOrZero(rawCohorts.hookSyndicateCount),
    fixtureCount: numOrZero(rawCohorts.fixtureCount),
    fullBookSpecCount: numOrZero(rawCohorts.fullBookSpecCount),
    uniqueSurveillanceCount: numOrZero(rawCohorts.uniqueSurveillanceCount),
  }

  return {
    cohorts,
    backtestTop: Array.isArray(rec.backtestTop)
      ? (rec.backtestTop as ReadonlyArray<Record<string, unknown>>)
      : [],
    backtestAll: Array.isArray(rec.backtestAll)
      ? (rec.backtestAll as ReadonlyArray<Record<string, unknown>>)
      : Array.isArray(rec.backtestTop)
        ? (rec.backtestTop as ReadonlyArray<Record<string, unknown>>)
        : [],
    bookRows: Array.isArray(rec.bookRows)
      ? rec.bookRows.filter(
          (row): row is Record<string, unknown> =>
            typeof row === "object" && row !== null && !Array.isArray(row),
        )
      : [],
    fixtures: Array.isArray(rec.fixtures)
      ? (rec.fixtures as ReadonlyArray<Record<string, unknown>>)
      : [],
    provenance: normalizeProvenance(rec.provenance, "fixture", "API Customer Cohorts"),
  }
}

interface CustomerCohortKpiSpec {
  readonly id: CustomerCohortKpiId
  readonly label: string
  readonly tone: CustomerCohortKpiTone
  readonly filterTier: "ALL" | "ELITE" | "SYNDICATE" | null
}

const CUSTOMER_COHORT_KPI_SPECS: readonly CustomerCohortKpiSpec[] = [
  {
    id: "backtest",
    label: "Backtest Cohort",
    tone: "sky",
    filterTier: "ALL",
  },
  {
    id: "key-number-sharps",
    label: "Key Number Sharps",
    tone: "red",
    filterTier: "ELITE",
  },
  {
    id: "hook-syndicates",
    label: "Hook Syndicates",
    tone: "amber",
    filterTier: "SYNDICATE",
  },
  {
    id: "fixtures",
    label: "CI Synthetic Fixtures",
    tone: "slate",
    filterTier: null,
  },
  {
    id: "enriched-book",
    label: "Enriched Book Spec",
    tone: "emerald",
    filterTier: null,
  },
  {
    id: "unique-surveillance",
    label: "Unique Surveillance",
    tone: "violet",
    filterTier: "ALL",
  },
]

function computeSharePct(count: number, total: number): number | null {
  if (total <= 0) return null
  return Math.round((count / total) * 1000) / 10
}

/** Derive the 6 customer cohort KPI cards dynamically (missing is never hardcoded as non-zero or zero). */
export function deriveCustomerCohortKpiCards(options: {
  readonly report: CustomersApiResponse | null
  readonly status: "pending" | "ready" | "unavailable"
  readonly error?: string | null | undefined
}): readonly CustomerCohortKpiCard[] {
  if (options.status === "unavailable") {
    const reason =
      options.error && options.error.trim().length > 0
        ? options.error
        : "GET /api/customers unreachable"
    return CUSTOMER_COHORT_KPI_SPECS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      value: "Unavailable",
      sub: reason,
      status: "unavailable",
      tone: spec.tone,
      count: null,
      sharePct: null,
      filterTier: spec.filterTier,
    }))
  }

  if (options.status === "pending" || options.report === null) {
    return CUSTOMER_COHORT_KPI_SPECS.map((spec) => ({
      id: spec.id,
      label: spec.label,
      value: "Pending…",
      sub: "Awaiting GET /api/customers",
      status: "pending",
      tone: spec.tone,
      count: null,
      sharePct: null,
      filterTier: spec.filterTier,
    }))
  }

  const { cohorts, provenance } = options.report
  const sourceSuffix = provenance.sourcePath ? `Source: ${provenance.sourcePath}` : provenance.label
  const totalUnique = cohorts.uniqueSurveillanceCount

  const readyRows: Record<
    CustomerCohortKpiId,
    { readonly count: number; readonly value: string; readonly sub: string }
  > = {
    backtest: {
      count: cohorts.backtestCount,
      value: `${cohorts.backtestCount.toLocaleString()} Accounts`,
      sub: "4-Wk CFB/NBA Leaderboard (/api/customers)",
    },
    "key-number-sharps": {
      count: cohorts.keyNumberSharpsCount,
      value: `${cohorts.keyNumberSharpsCount.toLocaleString()} Elite Accounts`,
      sub: "Football Key Numbers Watchlist",
    },
    "hook-syndicates": {
      count: cohorts.hookSyndicateCount,
      value: `${cohorts.hookSyndicateCount.toLocaleString()} Downlines`,
      sub: "Half-Point Syndicate Clusters",
    },
    fixtures: {
      count: cohorts.fixtureCount,
      value: `${cohorts.fixtureCount.toLocaleString()} Accounts`,
      sub: "Deterministic Fixture Corpus",
    },
    "enriched-book": {
      count: cohorts.fullBookSpecCount,
      value: `${cohorts.fullBookSpecCount.toLocaleString()} Accounts`,
      sub: sourceSuffix,
    },
    "unique-surveillance": {
      count: totalUnique,
      value: `${totalUnique.toLocaleString()} IDs`,
      sub: `Deduplicated Across Cohorts (${provenance.kind})`,
    },
  }

  return CUSTOMER_COHORT_KPI_SPECS.map((spec) => {
    if (
      (options.report?.bookRows?.length ?? 0) > 0 &&
      (spec.id === "key-number-sharps" || spec.id === "hook-syndicates")
    )
      return {
        id: spec.id,
        label: spec.label,
        value: "Unmeasured",
        sub: "The live roster provides identity, not risk classification",
        status: "unavailable" as const,
        tone: spec.tone,
        count: null,
        sharePct: null,
        filterTier: null,
      }
    const row = readyRows[spec.id]
    return {
      id: spec.id,
      label: spec.label,
      value: row.value,
      sub: row.sub,
      status: "ready",
      tone: spec.tone,
      count: row.count,
      sharePct: computeSharePct(row.count, totalUnique),
      filterTier: spec.filterTier,
    }
  })
}

export type HydratedSliceResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string }

export interface DashboardFeedsHydrationBundle {
  readonly wagers: HydratedSliceResult<NormalizedLiveWagersResult>
  readonly customers: HydratedSliceResult<CustomersApiResponse>
  readonly tiers: HydratedSliceResult<TierStyleConfig>
}

async function fetchJsonSlice<T>(
  fetchImpl: (input: string) => Promise<Response>,
  url: string,
  parse: (json: unknown) => T | null,
  expectedShapeName: string,
): Promise<HydratedSliceResult<T>> {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) {
      return {
        ok: false,
        error: `GET ${url} returned HTTP ${res.status} (${res.statusText || "error"})`,
      }
    }
    const json: unknown = await res.json()
    const normalized = parse(json)
    if (normalized === null) {
      return {
        ok: false,
        error: `GET ${url} returned unexpected ${expectedShapeName} payload`,
      }
    }
    return { ok: true, data: normalized }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: `GET ${url} failed: ${message}`,
    }
  }
}

/** Hydrate `/api/wagers`, `/api/customers`, and `/api/config/tiers` in parallel using any `fetch` implementation. */
export async function hydrateDashboardFeeds(
  fetchImpl: (input: string) => Promise<Response>,
): Promise<DashboardFeedsHydrationBundle> {
  const [wagers, customers, tiers] = await Promise.all([
    fetchJsonSlice(fetchImpl, "/api/wagers", normalizeLiveWagersResponse, "LiveWagersApiResponse"),
    fetchJsonSlice(
      fetchImpl,
      "/api/customers",
      normalizeCustomersCohortResponse,
      "CustomersApiResponse",
    ),
    fetchJsonSlice<TierStyleConfig>(
      fetchImpl,
      "/api/config/tiers",
      (raw) => {
        if (typeof raw !== "object" || raw === null) return null
        const rec = raw as { tiers?: unknown }
        if (typeof rec.tiers !== "object" || rec.tiers === null) return null
        return rec.tiers as TierStyleConfig
      },
      "TiersConfig",
    ),
  ])
  return { wagers, customers, tiers }
}

/** Provenance for a feed that failed: names the endpoint and the error, never a substitute dataset. */
export function unavailableProvenance(
  endpoint: string,
  error: string,
  observedAt: string = new Date().toISOString(),
): DashboardSourceProvenance {
  return {
    kind: "unavailable",
    label: error,
    sourcePath: endpoint,
    observedAt,
  }
}

/** Endpoint the Downlines tab reads: `runBatchedRanking` over the F402 bets corpus. */
export const RANKINGS_ENDPOINT = "/api/rankings/all"

export interface RankingsSummary {
  readonly generatedAtIso: string
  readonly windowStart: string
  readonly windowEnd: string
  readonly inWindowWagers: number
  readonly totalHandleUsd: number
  readonly totalToWinUsd: number
  readonly activeCustomerCount: number
  readonly activeSubAgentCount: number
  readonly activeMasterAgentCount: number
  readonly conduitSubAgentCount: number
}

export interface NormalizedRankingsResult {
  readonly summary: RankingsSummary
  readonly players: readonly RankedPlayer30d[]
  readonly conduits: readonly ProxyConduit30d[]
  readonly subAgents: readonly SubAgentDownline30d[]
  readonly masterAgents: readonly MasterAgentDownline30d[]
  /** Rows dropped because a required field was missing or non-numeric. */
  readonly rejectedRows: number
}

function finiteOrNull(val: unknown): number | null {
  if (typeof val !== "number" || !Number.isFinite(val)) return null
  return val
}

function nonEmptyString(val: unknown): string | null {
  return typeof val === "string" && val.trim().length > 0 ? val.trim() : null
}

/**
 * Normalize a `GET /api/rankings/all` (`BatchedRankingResult`) payload. Returns null when the
 * envelope is not that shape; rows missing a required field are counted in `rejectedRows`
 * instead of being coerced.
 */
export function normalizeRankingsResponse(raw: unknown): NormalizedRankingsResult | null {
  if (typeof raw !== "object" || raw === null) return null
  const rec = raw as Record<string, unknown>
  const rawPlayers = Array.isArray(rec.topRankedPlayers)
    ? rec.topRankedPlayers
    : Array.isArray(rec.topPlayers)
      ? rec.topPlayers
      : null
  if (rawPlayers === null || !Array.isArray(rec.topSubAgents)) {
    return null
  }

  let rejectedRows = 0
  const players: RankedPlayer30d[] = []
  for (const entry of rawPlayers as unknown[]) {
    const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >
    const id = nonEmptyString(row.customerId)
    const rank = finiteOrNull(row.rank)
    const handleUsd = finiteOrNull(row.handleUsd ?? row.totalHandleUsd)
    const wagers = finiteOrNull(row.totalWagers)
    const gini = finiteOrNull(row.stakeGini ?? row.giniCoefficient)
    const alertRate = finiteOrNull(row.alertRatePct)
    const score = finiteOrNull(row.compositeScore)
    const limitUsd = finiteOrNull(row.recommendedLimitUsd)
    const tier = nonEmptyString(row.tier)
    if (
      id === null ||
      rank === null ||
      handleUsd === null ||
      wagers === null ||
      gini === null ||
      alertRate === null ||
      score === null ||
      limitUsd === null ||
      tier === null
    ) {
      rejectedRows++
      continue
    }
    const netUsd = finiteOrNull(row.netUsd)
    const clvBps = finiteOrNull(row.clvBps)
    const contextType = nonEmptyString(row.contextType)
    const handleDelta24hPct = finiteOrNull(
      row.handleDelta24hPct ?? row.delta24hPct ?? row.trend24hPct,
    )
    players.push({
      rank,
      id,
      agentId: nonEmptyString(row.agentId) ?? "",
      masterAgent: nonEmptyString(row.masterAgent) ?? "",
      handleUsd,
      wagers,
      gini,
      alertRate,
      score,
      tier,
      tierLabel: nonEmptyString(row.tierLabel) ?? tier,
      dominantSport: nonEmptyString(row.dominantSport) ?? "",
      isProxy: row.isProxyConduit === true || row.isProxyAccount === true,
      limitUsd,
      netUsd: netUsd ?? undefined,
      clvBps: clvBps ?? undefined,
      contextType: contextType ?? undefined,
      handleDelta24hPct: handleDelta24hPct ?? undefined,
    })
  }

  const conduits: ProxyConduit30d[] = []
  const subAgents: SubAgentDownline30d[] = []
  let subAgentWagers = 0
  const masterSet = new Set<string>()
  for (const entry of rec.topSubAgents as unknown[]) {
    const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >
    const rowWagers = finiteOrNull(row.totalWagers)
    if (rowWagers !== null) subAgentWagers += rowWagers
    const masterId = nonEmptyString(row.masterAgent)
    if (masterId) masterSet.add(masterId)

    const agentId = nonEmptyString(row.agentId)
    const handleUsd = finiteOrNull(row.totalHandleUsd ?? row.handleUsd)
    const concPct = finiteOrNull(row.topCustomerConcentrationPct ?? row.concPct)
    const isProxyConduit = row.isProxyConduit === true
    const topCust = nonEmptyString(row.topCustomer ?? row.topCust) ?? ""
    const customerCount = finiteOrNull(row.customerCount) ?? 1
    const avgScore = finiteOrNull(row.avgScore)
    const totalNetUsd = finiteOrNull(row.totalNetUsd)
    const handleDelta24hPct = finiteOrNull(
      row.handleDelta24hPct ?? row.delta24hPct ?? row.trend24hPct,
    )

    if (agentId !== null && handleUsd !== null && rowWagers !== null && concPct !== null) {
      subAgents.push({
        agentId,
        masterAgent: masterId ?? "",
        handleUsd,
        wagers: rowWagers,
        customerCount,
        topCust,
        concPct,
        isProxyConduit,
        avgScore: avgScore ?? undefined,
        totalNetUsd: totalNetUsd ?? undefined,
        handleDelta24hPct: handleDelta24hPct ?? undefined,
      })
    } else if (isProxyConduit) {
      rejectedRows++
      continue
    }

    if (!isProxyConduit) continue
    if (agentId === null || handleUsd === null || rowWagers === null || concPct === null) {
      continue
    }
    conduits.push({
      agentId,
      masterAgent: masterId ?? "",
      handleUsd,
      wagers: rowWagers,
      topCust,
      concPct,
      handleDelta24hPct: handleDelta24hPct ?? undefined,
    })
  }

  const masterAgents: MasterAgentDownline30d[] = []
  if (Array.isArray(rec.topMasterAgents)) {
    for (const entry of rec.topMasterAgents as unknown[]) {
      const row = (typeof entry === "object" && entry !== null ? entry : {}) as Record<
        string,
        unknown
      >
      const masterAgent = nonEmptyString(row.masterAgent)
      const subAgentCount = finiteOrNull(row.subAgentCount)
      const handleUsd = finiteOrNull(row.totalHandleUsd ?? row.handleUsd)
      const wagers = finiteOrNull(row.totalWagers ?? row.wagers)
      if (masterAgent === null || subAgentCount === null || handleUsd === null || wagers === null) {
        continue
      }
      const subsForMaster = subAgents.filter(
        (s) => s.masterAgent.toUpperCase() === masterAgent.toUpperCase(),
      )
      const explicitMasterDelta = finiteOrNull(
        row.handleDelta24hPct ?? row.delta24hPct ?? row.trend24hPct,
      )
      const derivedMasterDelta = subsForMaster.some((s) => s.handleDelta24hPct !== undefined)
        ? Number(
            (
              subsForMaster.reduce(
                (sum, s) => sum + (s.handleDelta24hPct ?? 0) * Math.max(1, s.handleUsd),
                0,
              ) / subsForMaster.reduce((sum, s) => sum + Math.max(1, s.handleUsd), 0)
            ).toFixed(1),
          )
        : undefined
      masterAgents.push({
        masterAgent,
        subAgentCount,
        customerCount:
          finiteOrNull(row.customerCount) ??
          subsForMaster.reduce((sum, s) => sum + s.customerCount, 0),
        conduitCount:
          finiteOrNull(row.conduitCount) ?? subsForMaster.filter((s) => s.isProxyConduit).length,
        handleUsd,
        wagers,
        handleDelta24hPct: explicitMasterDelta ?? derivedMasterDelta,
      })
    }
  } else if (subAgents.length > 0) {
    const grouped = new Map<string, SubAgentDownline30d[]>()
    for (const sa of subAgents) {
      const key = sa.masterAgent || "UNASSIGNED"
      const list = grouped.get(key) ?? []
      list.push(sa)
      grouped.set(key, list)
    }
    for (const [masterAgent, subs] of grouped.entries()) {
      const derivedMasterDelta = subs.some((s) => s.handleDelta24hPct !== undefined)
        ? Number(
            (
              subs.reduce(
                (sum, s) => sum + (s.handleDelta24hPct ?? 0) * Math.max(1, s.handleUsd),
                0,
              ) / subs.reduce((sum, s) => sum + Math.max(1, s.handleUsd), 0)
            ).toFixed(1),
          )
        : undefined
      masterAgents.push({
        masterAgent,
        subAgentCount: subs.length,
        customerCount: subs.reduce((s, x) => s + x.customerCount, 0),
        conduitCount: subs.filter((x) => x.isProxyConduit).length,
        handleUsd: subs.reduce((s, x) => s + x.handleUsd, 0),
        wagers: subs.reduce((s, x) => s + x.wagers, 0),
        handleDelta24hPct: derivedMasterDelta,
      })
    }
    masterAgents.sort((a, b) => b.handleUsd - a.handleUsd)
  }

  const totalHandleUsd =
    finiteOrNull(rec.totalHandleUsd) ?? players.reduce((sum, p) => sum + p.handleUsd, 0)
  const playerWagers = players.reduce((sum, p) => sum + p.wagers, 0)
  const inWindowWagers =
    finiteOrNull(rec.inWindowWagers) ?? (subAgentWagers > 0 ? subAgentWagers : playerWagers)
  const totalToWinUsd = finiteOrNull(rec.totalToWinUsd) ?? Math.round(totalHandleUsd * 0.909)
  const activeCustomerCount =
    finiteOrNull(rec.activeCustomerCount) ??
    finiteOrNull(rec.totalPlayersEvaluated) ??
    players.length
  const activeSubAgentCount = finiteOrNull(rec.activeSubAgentCount) ?? rec.topSubAgents.length
  const activeMasterAgentCount =
    finiteOrNull(rec.activeMasterAgentCount) ??
    (masterAgents.length > 0 ? masterAgents.length : masterSet.size)
  const conduitSubAgentCount = finiteOrNull(rec.conduitSubAgentCount) ?? conduits.length

  return {
    summary: {
      generatedAtIso: nonEmptyString(rec.generatedAtIso) ?? "",
      windowStart: nonEmptyString(rec.windowStart) ?? "30d",
      windowEnd: nonEmptyString(rec.windowEnd) ?? "live",
      inWindowWagers,
      totalHandleUsd,
      totalToWinUsd,
      activeCustomerCount,
      activeSubAgentCount,
      activeMasterAgentCount,
      conduitSubAgentCount,
    },
    players,
    conduits,
    subAgents,
    masterAgents,
    rejectedRows,
  }
}

/**
 * Fetch and normalize `GET /api/rankings/all`. A non-2xx reply carries the server's
 * `{ error }` text (for example a missing bets corpus) into the failure message.
 */
export async function fetchRankingsSlice(
  fetchImpl: (input: string) => Promise<Response>,
  limit = 100,
): Promise<HydratedSliceResult<NormalizedRankingsResult>> {
  const url = `${RANKINGS_ENDPOINT}?limit=${limit}`
  try {
    const res = await fetchImpl(url)
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: unknown
      } | null
      const detail = typeof body?.error === "string" ? `: ${body.error}` : ""
      return {
        ok: false,
        error: `GET ${RANKINGS_ENDPOINT} returned HTTP ${res.status} (${res.statusText || "error"})${detail}`,
      }
    }
    const normalized = normalizeRankingsResponse(await res.json())
    if (normalized === null) {
      return {
        ok: false,
        error: `GET ${RANKINGS_ENDPOINT} returned an unexpected BatchedRankingResult payload`,
      }
    }
    return { ok: true, data: normalized }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `GET ${RANKINGS_ENDPOINT} failed: ${message}` }
  }
}
