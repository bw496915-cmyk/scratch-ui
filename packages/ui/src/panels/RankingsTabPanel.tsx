import type React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  Layers,
  Minus,
  RotateCcw,
  Search,
  Terminal,
  Users,
  X,
} from "lucide-react"
import { copyText } from "../clipboard.ts"
import { styles } from "../dashboard_styles.ts"
import { getFantasy402PortalLinkProps } from "../portal_link.ts"
import { type NormalizedRankingsResult, RANKINGS_ENDPOINT } from "../hydration.ts"
import { getLocalAgentHref, getLocalCustomerHref } from "../links.ts"
import type {
  MasterAgentDownline30d,
  ProxyConduit30d,
  RankedPlayer30d,
  RankingsFilter,
  SubAgentDownline30d,
} from "../types.ts"
import {
  type AgentFilterOption,
  AgentMultiSelectFilter,
  buildF402TransactionHistoryParams,
  normalizeAgentIdList,
} from "./AgentMultiSelectFilter.tsx"
import { SkeletonBlock, SkeletonTableRows } from "./PanelSkeleton.tsx"
import { PopulationStrip } from "./PopulationStrip.tsx"
import {
  HEAT_BUCKETS,
  RANKINGS_HEATMAP_STORAGE_KEY,
  type HandleHeatCellMetrics,
  type HandleHeatScale,
  buildHandleHeatLookup,
  evaluateHandleHeatCell,
  formatHeatCurrencyCompact,
  parseStoredRankingsHeatMapValue,
  readStoredRankingsHeatMap,
  writeStoredRankingsHeatMap,
} from "./rankings_heatmap.ts"

export type RankingsSourceStatus = "pending" | "ready" | "unavailable"

export type DownlinesViewMode = "ALL" | "TREE" | "PLAYERS" | "CONDUITS"

export type DownlinesSortField = "rank" | "handleUsd" | "wagers" | "gini" | "alertRate" | "score"

export interface DownlineSubAgentNode {
  readonly agentId: string
  readonly masterAgent: string
  readonly handleUsd: number
  readonly wagers: number
  readonly customerCount: number
  readonly topCust: string
  readonly concPct: number
  readonly isProxyConduit: boolean
  readonly avgScore: number | null
  readonly totalNetUsd: number | null
  readonly handleDelta24hPct: number | null
  readonly players: readonly RankedPlayer30d[]
}

export interface DownlineMasterForestNode {
  readonly masterAgent: string
  readonly subAgentCount: number
  readonly customerCount: number
  readonly conduitCount: number
  readonly handleUsd: number
  readonly wagers: number
  readonly handleDelta24hPct: number | null
  readonly subAgents: readonly DownlineSubAgentNode[]
}

export interface RankingsTabPanelProps {
  readonly rankingsSearch: string
  readonly onRankingsSearchChange: (value: string) => void
  readonly rankingsFilter: RankingsFilter
  readonly onRankingsFilterChange: (filter: RankingsFilter) => void
  readonly onInspectPty: (customerId: string) => void
  readonly onSelectAgent?: ((agentId: string) => void) | undefined
  readonly onSelectCustomerById?: ((customerId: string) => void) | undefined
  readonly focusedCustomerId?: string | null | undefined
  readonly onFocusCustomer?: ((customerId: string) => void) | undefined
  readonly onClearFocusedCustomer?: (() => void) | undefined
  readonly selectedAgentIds?: readonly string[] | undefined
  readonly onSelectedAgentIdsChange?: ((agentIds: readonly string[]) => void) | undefined
  readonly heatMapEnabled?: boolean | undefined
  readonly onHeatMapEnabledChange?: ((enabled: boolean) => void) | undefined
  readonly rankings?: NormalizedRankingsResult | null | undefined
  readonly rankingsStatus?: RankingsSourceStatus | undefined
  readonly rankingsError?: string | null | undefined
}

const TABULAR_NUMS: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
}

function rankingsFilterControls(
  conduitCount: number | null,
): readonly { readonly id: RankingsFilter; readonly label: string }[] {
  return [
    { id: "ALL", label: "All Accounts" },
    {
      id: "CONDUITS",
      label: `Proxy Conduits (${conduitCount ?? "—"})`,
    },
    { id: "TIER3", label: "Tier 3 Sharps" },
    { id: "WHALES", label: "Whales (≥$1M)" },
  ]
}

function formatUsdCompact(usd: number): string {
  const abs = Math.abs(usd)
  const sign = usd < 0 ? "-" : ""
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toLocaleString()}`
}

function formatSignedUsd(usd: number): string {
  if (usd === 0) return "$0"
  const sign = usd > 0 ? "+" : "-"
  return `${sign}$${Math.abs(usd).toLocaleString()}`
}

export type HandleTrendDirection = "up" | "down" | "flat"

export interface HandleTrendSummary {
  readonly direction: HandleTrendDirection
  readonly formatted: string
  readonly color: string
  readonly deltaPct: number
}

/**
 * Format a 24-hour handle percentage shift into direction, signed text, and
 * accessible semantic color.
 */
export function resolveHandleTrend24h(
  deltaPct: number | null | undefined,
): HandleTrendSummary | null {
  if (typeof deltaPct !== "number" || !Number.isFinite(deltaPct)) {
    return null
  }
  const rounded = Number(deltaPct.toFixed(1))
  if (rounded > 0.05) {
    return {
      direction: "up",
      formatted: `+${rounded.toFixed(1)}%`,
      color: "#4ade80",
      deltaPct: rounded,
    }
  }
  if (rounded < -0.05) {
    return {
      direction: "down",
      formatted: `${rounded.toFixed(1)}%`,
      color: "#f87171",
      deltaPct: rounded,
    }
  }
  return {
    direction: "flat",
    formatted: "0.0%",
    color: "#94a3b8",
    deltaPct: 0,
  }
}

export function HandleTrendIndicator({
  deltaPct,
  label = "24h performance shift",
  compact = false,
}: {
  readonly deltaPct: number | null | undefined
  readonly label?: string | undefined
  readonly compact?: boolean | undefined
}): React.ReactElement | null {
  const trend = resolveHandleTrend24h(deltaPct)
  if (!trend) return null

  const iconSize = compact ? 11 : 12
  const dirWord = trend.direction === "up" ? "up" : trend.direction === "down" ? "down" : "flat"

  return (
    <span
      data-handle-trend-24h={trend.direction}
      data-handle-trend-value={trend.formatted}
      aria-label={`${label}: ${dirWord} ${trend.formatted} over last 24h`}
      title={`${label}: ${trend.formatted} over last 24h`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        fontSize: compact ? "10px" : "11px",
        fontWeight: 600,
        color: trend.color,
        whiteSpace: "nowrap",
        ...TABULAR_NUMS,
      }}
    >
      {trend.direction === "up" ? (
        <ArrowUp
          size={iconSize}
          strokeWidth={2.5}
          data-handle-trend-arrow="up"
          aria-hidden="true"
        />
      ) : trend.direction === "down" ? (
        <ArrowDown
          size={iconSize}
          strokeWidth={2.5}
          data-handle-trend-arrow="down"
          aria-hidden="true"
        />
      ) : (
        <Minus
          size={iconSize - 1}
          strokeWidth={2.2}
          data-handle-trend-arrow="flat"
          aria-hidden="true"
        />
      )}
      <span>{trend.formatted}</span>
    </span>
  )
}

/**
 * Derive a deterministic Master Forest -> Sub-Agent -> Customer hierarchy from
 * normalized rankings payloads (falling back gracefully when a legacy payload
 * omits `subAgents` or `masterAgents`).
 */
export function buildDownlineForests(
  players: readonly RankedPlayer30d[],
  subAgentsInput: readonly SubAgentDownline30d[] = [],
  masterAgentsInput: readonly MasterAgentDownline30d[] = [],
): readonly DownlineMasterForestNode[] {
  const playersByAgent = new Map<string, RankedPlayer30d[]>()
  for (const p of players) {
    const key = (p.agentId || "UNASSIGNED").trim().toUpperCase()
    const list = playersByAgent.get(key) ?? []
    list.push(p)
    playersByAgent.set(key, list)
  }
  for (const list of playersByAgent.values()) {
    list.sort((a, b) => b.handleUsd - a.handleUsd || b.score - a.score)
  }

  const subMap = new Map<string, DownlineSubAgentNode>()
  for (const sa of subAgentsInput) {
    const key = sa.agentId.trim().toUpperCase()
    const members = playersByAgent.get(key) ?? []
    subMap.set(key, {
      agentId: sa.agentId,
      masterAgent: sa.masterAgent || members[0]?.masterAgent || "UNASSIGNED",
      handleUsd: sa.handleUsd,
      wagers: sa.wagers,
      customerCount: Math.max(sa.customerCount, members.length),
      topCust: sa.topCust || members[0]?.id || "",
      concPct: sa.concPct,
      isProxyConduit: sa.isProxyConduit,
      avgScore:
        sa.avgScore ??
        (members.length > 0
          ? Number((members.reduce((s, m) => s + m.score, 0) / members.length).toFixed(2))
          : null),
      totalNetUsd:
        sa.totalNetUsd ??
        (members.some((m) => m.netUsd !== undefined)
          ? members.reduce((s, m) => s + (m.netUsd ?? 0), 0)
          : null),
      handleDelta24hPct:
        sa.handleDelta24hPct ??
        (members.some((m) => m.handleDelta24hPct !== undefined)
          ? Number(
              (
                members.reduce(
                  (s, m) => s + (m.handleDelta24hPct ?? 0) * Math.max(1, m.handleUsd),
                  0,
                ) / members.reduce((s, m) => s + Math.max(1, m.handleUsd), 0)
              ).toFixed(1),
            )
          : null),
      players: members,
    })
  }

  // Include any agents seen on player rows that weren't in topSubAgents
  for (const [agentKey, members] of playersByAgent.entries()) {
    if (subMap.has(agentKey)) continue
    const totalHandle = members.reduce((s, m) => s + m.handleUsd, 0)
    const totalWagers = members.reduce((s, m) => s + m.wagers, 0)
    const top = members[0]
    const concPct =
      totalHandle > 0 && top
        ? Number(((top.handleUsd / totalHandle) * 100).toFixed(1))
        : members.length === 1
          ? 100
          : 0
    subMap.set(agentKey, {
      agentId: top?.agentId || agentKey,
      masterAgent: top?.masterAgent || "UNASSIGNED",
      handleUsd: totalHandle,
      wagers: totalWagers,
      customerCount: members.length,
      topCust: top?.id ?? "",
      concPct,
      isProxyConduit: concPct >= 80 && members.length <= 3,
      avgScore:
        members.length > 0
          ? Number((members.reduce((s, m) => s + m.score, 0) / members.length).toFixed(2))
          : null,
      totalNetUsd: members.some((m) => m.netUsd !== undefined)
        ? members.reduce((s, m) => s + (m.netUsd ?? 0), 0)
        : null,
      handleDelta24hPct: members.some((m) => m.handleDelta24hPct !== undefined)
        ? Number(
            (
              members.reduce(
                (s, m) => s + (m.handleDelta24hPct ?? 0) * Math.max(1, m.handleUsd),
                0,
              ) / members.reduce((s, m) => s + Math.max(1, m.handleUsd), 0)
            ).toFixed(1),
          )
        : null,
      players: members,
    })
  }

  const subsByMaster = new Map<string, DownlineSubAgentNode[]>()
  for (const sa of subMap.values()) {
    const masterKey = (sa.masterAgent || "UNASSIGNED").trim().toUpperCase()
    const list = subsByMaster.get(masterKey) ?? []
    list.push(sa)
    subsByMaster.set(masterKey, list)
  }
  for (const list of subsByMaster.values()) {
    list.sort((a, b) => b.handleUsd - a.handleUsd || b.wagers - a.wagers)
  }

  const masterMeta = new Map<string, MasterAgentDownline30d>()
  for (const ma of masterAgentsInput) {
    masterMeta.set(ma.masterAgent.trim().toUpperCase(), ma)
  }

  const allMasterKeys = new Set<string>([...subsByMaster.keys(), ...masterMeta.keys()])

  const forests: DownlineMasterForestNode[] = []
  for (const key of allMasterKeys) {
    const subs = subsByMaster.get(key) ?? []
    const meta = masterMeta.get(key)
    const derivedMasterDelta = subs.some((x) => x.handleDelta24hPct !== null)
      ? Number(
          (
            subs.reduce((s, x) => s + (x.handleDelta24hPct ?? 0) * Math.max(1, x.handleUsd), 0) /
            subs.reduce((s, x) => s + Math.max(1, x.handleUsd), 0)
          ).toFixed(1),
        )
      : null
    forests.push({
      masterAgent: meta?.masterAgent ?? subs[0]?.masterAgent ?? key,
      subAgentCount: Math.max(meta?.subAgentCount ?? 0, subs.length),
      customerCount: Math.max(
        meta?.customerCount ?? 0,
        subs.reduce((s, x) => s + x.customerCount, 0),
      ),
      conduitCount: Math.max(meta?.conduitCount ?? 0, subs.filter((x) => x.isProxyConduit).length),
      handleUsd: meta?.handleUsd ?? subs.reduce((s, x) => s + x.handleUsd, 0),
      wagers: meta?.wagers ?? subs.reduce((s, x) => s + x.wagers, 0),
      handleDelta24hPct: meta?.handleDelta24hPct ?? derivedMasterDelta,
      subAgents: subs,
    })
  }

  return forests.sort((a, b) => b.handleUsd - a.handleUsd || b.customerCount - a.customerCount)
}

function escapeCsvCell(val: string | number | boolean | null | undefined): string {
  if (val === undefined || val === null) return ""
  if (typeof val === "number") {
    return Number.isFinite(val) ? String(val) : ""
  }
  if (typeof val === "boolean") {
    return val ? "true" : "false"
  }
  const str = String(val)
  // Prevent CSV spreadsheet formula injection on untrusted string cells
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export interface BuildDownlinesCsvOptions {
  readonly totalDeskHandle?: number | undefined
  readonly heatByKey?: ReadonlyMap<string, HandleHeatCellMetrics> | undefined
}

/**
 * Format filtered downline player rows as RFC-4180 CSV for instant Blob export.
 */
export function buildDownlinesCsv(
  players: readonly RankedPlayer30d[],
  options: BuildDownlinesCsvOptions = {},
): string {
  const totalDeskHandle = options.totalDeskHandle ?? 0
  const heatByKey = options.heatByKey
  const header = [
    "rank",
    "customer_id",
    "sub_agent",
    "master_forest",
    "handle_usd",
    "wagers",
    "stake_gini",
    "alert_rate_pct",
    "composite_score",
    "tier",
    "dominant_sport",
    "proxy_flag",
    "limit_usd",
    "net_usd",
    "clv_bps",
    "handle_delta_24h_pct",
    "desk_handle_share_pct",
    "heat_bucket",
    "visible_handle_percentile",
  ]
  const lines = [header.join(",")]
  for (const p of players) {
    const heat = heatByKey?.get(p.id.trim().toUpperCase())
    const deskSharePct =
      totalDeskHandle > 0 ? Number(((p.handleUsd / totalDeskHandle) * 100).toFixed(2)) : ""
    lines.push(
      [
        p.rank,
        p.id,
        p.agentId,
        p.masterAgent,
        p.handleUsd,
        p.wagers,
        p.gini.toFixed(3),
        p.alertRate,
        p.score.toFixed(2),
        p.tierLabel,
        p.dominantSport,
        p.isProxy ? "PROXY" : "STANDARD",
        p.limitUsd,
        p.netUsd ?? "",
        p.clvBps ?? "",
        p.handleDelta24hPct !== undefined ? Number(p.handleDelta24hPct.toFixed(1)) : "",
        deskSharePct,
        heat ? heat.bucket : "",
        heat ? (heat.isInactive ? 0 : heat.percentileRank) : "",
      ]
        .map(escapeCsvCell)
        .join(","),
    )
  }
  return lines.join("\r\n")
}

/**
 * Format filtered proxy conduit rows as RFC-4180 CSV when exporting from the
 * Agencies view mode.
 */
export function buildConduitsCsv(
  conduits: readonly ProxyConduit30d[],
  heatByKey?: ReadonlyMap<string, HandleHeatCellMetrics> | undefined,
): string {
  const header = [
    "sub_agent_id",
    "master_forest",
    "handle_usd",
    "wagers",
    "top_customer",
    "concentration_pct",
    "handle_delta_24h_pct",
    "heat_bucket",
    "visible_handle_percentile",
  ]
  const lines = [header.join(",")]
  for (const c of conduits) {
    const heat = heatByKey?.get(c.agentId.trim().toUpperCase())
    lines.push(
      [
        c.agentId,
        c.masterAgent,
        c.handleUsd,
        c.wagers,
        c.topCust,
        Number(c.concPct.toFixed(1)),
        c.handleDelta24hPct !== undefined ? Number(c.handleDelta24hPct.toFixed(1)) : "",
        heat ? heat.bucket : "",
        heat ? (heat.isInactive ? 0 : heat.percentileRank) : "",
      ]
        .map(escapeCsvCell)
        .join(","),
    )
  }
  return lines.join("\r\n")
}

/**
 * Format filtered sub-agent hierarchy rows as RFC-4180 CSV when exporting from
 * the Hierarchy (`TREE`) view mode.
 */
export function buildSubAgentsCsv(
  subAgents: readonly DownlineSubAgentNode[],
  options: BuildDownlinesCsvOptions = {},
): string {
  const totalDeskHandle = options.totalDeskHandle ?? 0
  const heatByKey = options.heatByKey
  const header = [
    "sub_agent_id",
    "master_forest",
    "handle_usd",
    "wagers",
    "customer_count",
    "top_customer",
    "concentration_pct",
    "is_proxy_conduit",
    "avg_score",
    "total_net_usd",
    "handle_delta_24h_pct",
    "desk_handle_share_pct",
    "heat_bucket",
    "visible_handle_percentile",
  ]
  const lines = [header.join(",")]
  for (const sa of subAgents) {
    const heat = heatByKey?.get(sa.agentId.trim().toUpperCase())
    const deskSharePct =
      totalDeskHandle > 0 ? Number(((sa.handleUsd / totalDeskHandle) * 100).toFixed(2)) : ""
    lines.push(
      [
        sa.agentId,
        sa.masterAgent,
        sa.handleUsd,
        sa.wagers,
        sa.customerCount,
        sa.topCust,
        Number(sa.concPct.toFixed(1)),
        sa.isProxyConduit ? "PROXY" : "STANDARD",
        sa.avgScore !== null ? Number(sa.avgScore.toFixed(2)) : "",
        sa.totalNetUsd ?? "",
        sa.handleDelta24hPct !== null ? Number(sa.handleDelta24hPct.toFixed(1)) : "",
        deskSharePct,
        heat ? heat.bucket : "",
        heat ? (heat.isInactive ? 0 : heat.percentileRank) : "",
      ]
        .map(escapeCsvCell)
        .join(","),
    )
  }
  return lines.join("\r\n")
}

export function buildRankingsCsvFilename(options: {
  readonly viewMode: DownlinesViewMode
  readonly filter: RankingsFilter
  readonly selectedAgentIds?: readonly string[] | undefined
  readonly masterForest?: string | undefined
  readonly dateIso?: string | undefined
}): string {
  const slug = (raw: string): string =>
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)

  const parts = ["sportsdesk-rankings"]
  if (options.viewMode === "CONDUITS") {
    parts.push("conduits")
  } else if (options.viewMode === "TREE") {
    parts.push("hierarchy")
  } else if (options.filter !== "ALL") {
    parts.push(slug(options.filter))
  }
  if (options.masterForest && options.masterForest.trim().toUpperCase() !== "ALL") {
    parts.push(slug(options.masterForest))
  }
  if (options.selectedAgentIds && options.selectedAgentIds.length > 0) {
    const agentPart =
      options.selectedAgentIds.length === 1
        ? slug(options.selectedAgentIds[0]!)
        : `${options.selectedAgentIds.length}-agents`
    if (agentPart) parts.push(agentPart)
  }
  const dateStamp = (options.dateIso ?? new Date().toISOString()).slice(0, 10) || "export"
  parts.push(dateStamp)
  return `${parts.filter(Boolean).join("-")}.csv`
}

export interface CsvDownloadEnvironment {
  readonly document?: {
    createElement(tag: "a"): {
      href: string
      download: string
      style: { display: string }
      click(): void
      remove?(): void
    }
    body?: {
      appendChild(node: unknown): void
      removeChild?(node: unknown): void
    } | null
  }
  readonly createObjectURL?: ((blob: Blob) => string) | undefined
  readonly revokeObjectURL?: ((url: string) => void) | undefined
}

/**
 * Trigger a client-side CSV file download with UTF-8 BOM for spreadsheet
 * compatibility and clean ObjectURL revocation.
 */
export function downloadRankingsCsvBlob(
  csvContent: string,
  filename: string,
  env?: CsvDownloadEnvironment | undefined,
): boolean {
  const doc =
    env?.document ??
    (typeof document !== "undefined"
      ? (document as unknown as CsvDownloadEnvironment["document"])
      : undefined)
  const createUrl =
    env?.createObjectURL ??
    (typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? (b: Blob) => URL.createObjectURL(b)
      : undefined)
  const revokeUrl =
    env?.revokeObjectURL ??
    (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function"
      ? (u: string) => URL.revokeObjectURL(u)
      : undefined)

  if (!doc || !doc.body || !createUrl || typeof Blob === "undefined") {
    return false
  }

  const blob = new Blob([`\uFEFF${csvContent}`], {
    type: "text/csv;charset=utf-8;",
  })
  const objectUrl = createUrl(blob)
  const anchor = doc.createElement("a")
  anchor.href = objectUrl
  anchor.download = filename
  anchor.style.display = "none"
  doc.body.appendChild(anchor)
  anchor.click()
  if (typeof anchor.remove === "function") {
    anchor.remove()
  } else if (typeof doc.body.removeChild === "function") {
    doc.body.removeChild(anchor)
  }
  if (revokeUrl) {
    setTimeout(() => revokeUrl(objectUrl), 10_000)
  }
  return true
}

function RankingsSourceNotice({
  status,
  error,
  rejectedRows,
}: {
  readonly status: RankingsSourceStatus
  readonly error: string | null
  readonly rejectedRows: number
}): React.ReactElement | null {
  if (status === "ready" && rejectedRows === 0) return null
  const unavailable = status === "unavailable"
  const message =
    status === "pending"
      ? `Waiting for GET ${RANKINGS_ENDPOINT}…`
      : unavailable
        ? `Rankings unavailable — GET ${RANKINGS_ENDPOINT}: ${error ?? "no response"}`
        : `${rejectedRows} ranking row(s) from GET ${RANKINGS_ENDPOINT} were rejected (missing or non-numeric fields) and are not shown.`
  return (
    <div
      role={unavailable ? "alert" : "status"}
      data-rankings-source={status}
      style={{
        padding: "10px 14px",
        borderRadius: "8px",
        backgroundColor: unavailable ? "rgba(239, 68, 68, 0.14)" : "rgba(56, 189, 248, 0.12)",
        border: unavailable
          ? "1px solid rgba(239, 68, 68, 0.4)"
          : "1px solid rgba(56, 189, 248, 0.35)",
        color: unavailable ? "#fca5a5" : "#7dd3fc",
        fontSize: "12px",
      }}
    >
      {message}
    </div>
  )
}

const HEAT_BUCKET_LABELS: readonly string[] = [
  "Inactive / $0",
  "Low (B1)",
  "Low-Mid (B2)",
  "Median (B3)",
  "High (B4)",
  "P95+ (B5)",
]

function HandleHeatTooltip({
  metrics,
  entityLabel,
  placement = "right",
}: {
  readonly metrics: HandleHeatCellMetrics
  readonly entityLabel: string
  readonly placement?: "left" | "right" | undefined
}): React.ReactElement {
  return (
    <div
      role="tooltip"
      data-heat-tooltip="true"
      className={`sd-heat-tooltip sd-heat-tooltip--${placement}`}
    >
      <div className="sd-heat-tooltip-header">
        <span>{entityLabel}</span>
        <span>{metrics.isInactive ? "Inactive" : `Intensity ${metrics.bucket}/5`}</span>
      </div>
      <div className="sd-heat-tooltip-row">
        <span className="sd-heat-tooltip-label">Exact Handle</span>
        <span className="sd-heat-tooltip-value">{metrics.exactHandleLabel}</span>
      </div>
      <div className="sd-heat-tooltip-row">
        <span className="sd-heat-tooltip-label">% Visible Handle</span>
        <span className="sd-heat-tooltip-value">{metrics.shareLabel}</span>
      </div>
      <div className="sd-heat-tooltip-row">
        <span className="sd-heat-tooltip-label">Percentile Rank</span>
        <span className="sd-heat-tooltip-value">{metrics.percentileLabel}</span>
      </div>
    </div>
  )
}

export function RankingsHeatMapLegend({
  scale,
  scopeLabel,
}: {
  readonly scale: HandleHeatScale
  readonly scopeLabel: string
}): React.ReactElement {
  const hasPositive = scale.positiveCount > 0
  const minText = hasPositive ? formatHeatCurrencyCompact(scale.min) : "—"
  const medianText = hasPositive ? formatHeatCurrencyCompact(scale.median) : "—"
  const p95Text = hasPositive ? `${formatHeatCurrencyCompact(scale.p95)}+` : "—"

  return (
    <div
      className="sd-heat-legend"
      data-heatmap-legend="true"
      aria-label={`Handle heat map intensity scale for ${scopeLabel}`}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontWeight: 700, color: "#cbd5e1", whiteSpace: "nowrap" }}>
          Handle Heat Map
        </span>
        <span style={{ color: "#64748b" }} aria-hidden="true">
          ·
        </span>
        <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}>
          {scopeLabel} ({scale.positiveCount} active)
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span
            className="sd-heat-legend-swatch"
            data-legend-bucket="0"
            title={HEAT_BUCKET_LABELS[0]}
            aria-hidden="true"
          />
          <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}>0 / Inactive</span>
        </div>

        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <span
            data-heat-legend-threshold="min"
            style={{ color: "#cbd5e1", fontWeight: 600, whiteSpace: "nowrap" }}
          >
            Min {minText}
          </span>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
            }}
            aria-hidden="true"
          >
            {HEAT_BUCKETS.slice(1).map((bucket) => (
              <span
                key={bucket}
                className="sd-heat-legend-swatch"
                data-legend-bucket={bucket}
                title={HEAT_BUCKET_LABELS[bucket]}
              />
            ))}
          </div>
          <span
            data-heat-legend-threshold="median"
            style={{ color: "#94a3b8", whiteSpace: "nowrap" }}
          >
            Median {medianText}
          </span>
          <span style={{ color: "#64748b" }} aria-hidden="true">
            ·
          </span>
          <span
            data-heat-legend-threshold="p95"
            style={{ color: "#e2e8f0", fontWeight: 600, whiteSpace: "nowrap" }}
          >
            P95+ {p95Text}
          </span>
        </div>
      </div>

      <span style={{ color: "#64748b", whiteSpace: "nowrap" }}>log10 · P5–P95 clamped</span>
    </div>
  )
}

export function RankingsTabPanel({
  rankingsSearch,
  onRankingsSearchChange,
  rankingsFilter,
  onRankingsFilterChange,
  onInspectPty,
  onSelectAgent,
  onSelectCustomerById,
  focusedCustomerId = null,
  onFocusCustomer,
  onClearFocusedCustomer,
  selectedAgentIds,
  onSelectedAgentIdsChange,
  heatMapEnabled,
  onHeatMapEnabledChange,
  rankings = null,
  rankingsStatus = rankings ? "ready" : "pending",
  rankingsError = null,
}: RankingsTabPanelProps): React.ReactElement {
  const summary = rankings?.summary ?? null
  const players = rankings?.players ?? []
  const conduits = rankings?.conduits ?? []
  const subAgentsRaw = rankings?.subAgents ?? []
  const masterAgentsRaw = rankings?.masterAgents ?? []

  const [viewMode, setViewMode] = useState<DownlinesViewMode>("ALL")
  const [selectedMasterForest, setSelectedMasterForest] = useState<string>("ALL")
  const [internalAgentIds, setInternalAgentIds] = useState<readonly string[]>([])
  const [internalHeatMapEnabled, setInternalHeatMapEnabled] = useState<boolean>(
    () => readStoredRankingsHeatMap() ?? true,
  )
  const [copiedTxAgentId, setCopiedTxAgentId] = useState<string | null>(null)
  const [exportedCsvCount, setExportedCsvCount] = useState<number | null>(null)
  const [isolateFocusedLineage, setIsolateFocusedLineage] = useState<boolean>(false)
  const [sortField, setSortField] = useState<DownlinesSortField>("rank")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc")
  const [collapsedMasters, setCollapsedMasters] = useState<Readonly<Record<string, boolean>>>({})

  const effectiveHeatMapEnabled = heatMapEnabled ?? internalHeatMapEnabled

  useEffect(() => {
    if (typeof window === "undefined" || heatMapEnabled !== undefined) return
    const onStorage = (event: StorageEvent) => {
      if (event.key !== RANKINGS_HEATMAP_STORAGE_KEY) return
      const parsed = parseStoredRankingsHeatMapValue(event.newValue)
      if (parsed !== null) {
        setInternalHeatMapEnabled(parsed)
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [heatMapEnabled])

  const handleToggleHeatMap = () => {
    const next = !effectiveHeatMapEnabled
    writeStoredRankingsHeatMap(next)
    if (onHeatMapEnabledChange) {
      onHeatMapEnabledChange(next)
    } else {
      setInternalHeatMapEnabled(next)
    }
  }

  const normalizedFocusId = focusedCustomerId?.trim().toUpperCase() || null

  const effectiveAgentIds = useMemo(
    () => normalizeAgentIdList(selectedAgentIds ?? internalAgentIds),
    [selectedAgentIds, internalAgentIds],
  )
  const effectiveAgentIdSet = useMemo(() => new Set(effectiveAgentIds), [effectiveAgentIds])

  const updateSelectedAgentIds = (nextIds: readonly string[]) => {
    const normalized = normalizeAgentIdList(nextIds)
    if (onSelectedAgentIdsChange) {
      onSelectedAgentIdsChange(normalized)
    } else {
      setInternalAgentIds(normalized)
    }
  }

  const toggleSelectedAgentId = (agentId: string) => {
    const upper = agentId.trim().toUpperCase()
    if (effectiveAgentIdSet.has(upper)) {
      updateSelectedAgentIds(effectiveAgentIds.filter((id) => id !== upper))
    } else {
      updateSelectedAgentIds([...effectiveAgentIds, upper])
    }
  }

  const allForests = useMemo(
    () => buildDownlineForests(players, subAgentsRaw, masterAgentsRaw),
    [players, subAgentsRaw, masterAgentsRaw],
  )

  const agentFilterOptions = useMemo<readonly AgentFilterOption[]>(() => {
    const seen = new Set<string>()
    const options: AgentFilterOption[] = []

    for (const forest of allForests) {
      for (const sa of forest.subAgents) {
        const key = sa.agentId.trim().toUpperCase()
        if (key === "" || seen.has(key)) continue
        seen.add(key)
        options.push({
          agentId: sa.agentId,
          masterAgent: sa.masterAgent,
          role: "sub-agent",
          handleUsd: sa.handleUsd,
          customerCount: sa.customerCount,
          concPct: sa.concPct,
          isProxyConduit: sa.isProxyConduit,
          handleDelta24hPct: sa.handleDelta24hPct,
        })
      }
    }

    for (const forest of allForests) {
      const key = forest.masterAgent.trim().toUpperCase()
      if (key === "" || seen.has(key)) continue
      seen.add(key)
      options.push({
        agentId: forest.masterAgent,
        masterAgent: forest.masterAgent,
        role: "master-forest",
        handleUsd: forest.handleUsd,
        customerCount: forest.customerCount,
        concPct: null,
        isProxyConduit: false,
        handleDelta24hPct: forest.handleDelta24hPct,
      })
    }

    for (const selectedId of effectiveAgentIds) {
      if (seen.has(selectedId)) continue
      seen.add(selectedId)
      options.push({
        agentId: selectedId,
        masterAgent: selectedId,
        role: "master-forest",
        handleUsd: 0,
        customerCount: 0,
        concPct: null,
        isProxyConduit: false,
      })
    }

    return options.sort((a, b) => {
      if (a.role !== b.role) {
        return a.role === "sub-agent" ? -1 : 1
      }
      return b.handleUsd - a.handleUsd || a.agentId.localeCompare(b.agentId)
    })
  }, [allForests, effectiveAgentIds])

  const focusedPlayer = useMemo(
    () =>
      normalizedFocusId
        ? (players.find((p) => p.id.toUpperCase() === normalizedFocusId) ?? null)
        : null,
    [normalizedFocusId, players],
  )

  const focusedSubAgent = useMemo(() => {
    if (!focusedPlayer) return null
    for (const f of allForests) {
      for (const sa of f.subAgents) {
        if (sa.agentId.toUpperCase() === focusedPlayer.agentId.toUpperCase()) {
          return sa
        }
      }
    }
    return null
  }, [focusedPlayer, allForests])

  const focusedSharePct = useMemo(() => {
    if (!focusedPlayer || !focusedSubAgent) return null
    if (focusedSubAgent.handleUsd <= 0) {
      return focusedSubAgent.customerCount === 1 ? 100 : 0
    }
    return Number(((focusedPlayer.handleUsd / focusedSubAgent.handleUsd) * 100).toFixed(1))
  }, [focusedPlayer, focusedSubAgent])

  const filteredPlayersUnsorted = useMemo(() => {
    const q = rankingsSearch.trim().toLowerCase()
    return players.filter((p) => {
      if (
        selectedMasterForest !== "ALL" &&
        p.masterAgent.toUpperCase() !== selectedMasterForest.toUpperCase()
      ) {
        return false
      }
      if (
        effectiveAgentIdSet.size > 0 &&
        !effectiveAgentIdSet.has(p.agentId.toUpperCase()) &&
        !effectiveAgentIdSet.has(p.masterAgent.toUpperCase())
      ) {
        return false
      }
      if (isolateFocusedLineage && normalizedFocusId) {
        if (focusedPlayer) {
          if (p.agentId.toUpperCase() !== focusedPlayer.agentId.toUpperCase()) {
            return false
          }
        } else if (p.id.toUpperCase() !== normalizedFocusId) {
          return false
        }
      }
      const matchesSearch =
        !q ||
        p.id.toLowerCase().includes(q) ||
        p.agentId.toLowerCase().includes(q) ||
        p.masterAgent.toLowerCase().includes(q) ||
        p.dominantSport.toLowerCase().includes(q)
      if (!matchesSearch) return false
      if (rankingsFilter === "CONDUITS") return p.isProxy
      if (rankingsFilter === "TIER3") return p.tier.startsWith("TIER_3")
      if (rankingsFilter === "WHALES") return p.handleUsd >= 1_000_000
      return true
    })
  }, [
    players,
    rankingsSearch,
    rankingsFilter,
    selectedMasterForest,
    effectiveAgentIdSet,
    isolateFocusedLineage,
    normalizedFocusId,
    focusedPlayer,
  ])

  const filteredPlayers = useMemo(() => {
    const dirMul = sortDir === "asc" ? 1 : -1
    return [...filteredPlayersUnsorted].sort((a, b) => {
      const delta = a[sortField] - b[sortField]
      if (delta !== 0) return delta * dirMul
      return a.rank - b.rank
    })
  }, [filteredPlayersUnsorted, sortField, sortDir])

  const visibleForests = useMemo(() => {
    const q = rankingsSearch.trim().toLowerCase()
    return allForests
      .filter((f) => {
        if (
          selectedMasterForest !== "ALL" &&
          f.masterAgent.toUpperCase() !== selectedMasterForest.toUpperCase()
        ) {
          return false
        }
        if (effectiveAgentIdSet.size > 0) {
          const masterSelected = effectiveAgentIdSet.has(f.masterAgent.toUpperCase())
          const hasSelectedSub = f.subAgents.some((sa) =>
            effectiveAgentIdSet.has(sa.agentId.toUpperCase()),
          )
          if (!masterSelected && !hasSelectedSub) return false
        }
        if (isolateFocusedLineage && focusedPlayer) {
          return f.masterAgent.toUpperCase() === focusedPlayer.masterAgent.toUpperCase()
        }
        return true
      })
      .map((f) => {
        const masterSelected = effectiveAgentIdSet.has(f.masterAgent.toUpperCase())
        const subAgents = f.subAgents.filter((sa) => {
          if (
            effectiveAgentIdSet.size > 0 &&
            !masterSelected &&
            !effectiveAgentIdSet.has(sa.agentId.toUpperCase())
          ) {
            return false
          }
          if (isolateFocusedLineage && focusedPlayer) {
            if (sa.agentId.toUpperCase() !== focusedPlayer.agentId.toUpperCase()) {
              return false
            }
          }
          if (rankingsFilter === "CONDUITS" && !sa.isProxyConduit) {
            return false
          }
          if (!q) return true
          return (
            f.masterAgent.toLowerCase().includes(q) ||
            sa.agentId.toLowerCase().includes(q) ||
            sa.topCust.toLowerCase().includes(q) ||
            sa.players.some((p) => p.id.toLowerCase().includes(q))
          )
        })
        return { ...f, subAgents }
      })
      .filter(
        (f) =>
          f.subAgents.length > 0 ||
          (!q &&
            (effectiveAgentIdSet.size === 0 ||
              effectiveAgentIdSet.has(f.masterAgent.toUpperCase()))),
      )
  }, [
    allForests,
    selectedMasterForest,
    effectiveAgentIdSet,
    isolateFocusedLineage,
    focusedPlayer,
    rankingsFilter,
    rankingsSearch,
  ])

  const visibleSubAgents = useMemo(() => {
    const q = rankingsSearch.trim().toLowerCase()
    const flat = allForests.flatMap((f) => f.subAgents)
    return flat.filter((sa) => {
      if (
        selectedMasterForest !== "ALL" &&
        sa.masterAgent.toUpperCase() !== selectedMasterForest.toUpperCase()
      ) {
        return false
      }
      if (
        effectiveAgentIdSet.size > 0 &&
        !effectiveAgentIdSet.has(sa.agentId.toUpperCase()) &&
        !effectiveAgentIdSet.has(sa.masterAgent.toUpperCase())
      ) {
        return false
      }
      if (rankingsFilter === "CONDUITS" && !sa.isProxyConduit) return false
      if (!q) return true
      return (
        sa.agentId.toLowerCase().includes(q) ||
        sa.masterAgent.toLowerCase().includes(q) ||
        sa.topCust.toLowerCase().includes(q)
      )
    })
  }, [allForests, selectedMasterForest, effectiveAgentIdSet, rankingsFilter, rankingsSearch])

  const filteredConduits = useMemo(() => {
    const q = rankingsSearch.trim().toLowerCase()
    return conduits.filter((c) => {
      if (
        selectedMasterForest !== "ALL" &&
        c.masterAgent.toUpperCase() !== selectedMasterForest.toUpperCase()
      ) {
        return false
      }
      if (
        effectiveAgentIdSet.size > 0 &&
        !effectiveAgentIdSet.has(c.agentId.toUpperCase()) &&
        !effectiveAgentIdSet.has(c.masterAgent.toUpperCase())
      ) {
        return false
      }
      if (!q) return true
      return (
        c.agentId.toLowerCase().includes(q) ||
        c.masterAgent.toLowerCase().includes(q) ||
        c.topCust.toLowerCase().includes(q)
      )
    })
  }, [conduits, selectedMasterForest, effectiveAgentIdSet, rankingsSearch])

  // Precompute heat-map scales & bucket lookups strictly when visible filtered datasets change.
  const subAgentHeat = useMemo(
    () =>
      buildHandleHeatLookup(
        visibleSubAgents,
        (sa) => sa.agentId.trim().toUpperCase(),
        (sa) => sa.handleUsd,
      ),
    [visibleSubAgents],
  )

  const masterForestHeat = useMemo(
    () =>
      buildHandleHeatLookup(
        visibleForests,
        (f) => f.masterAgent.trim().toUpperCase(),
        (f) => f.handleUsd,
      ),
    [visibleForests],
  )

  const playerHeat = useMemo(
    () =>
      buildHandleHeatLookup(
        filteredPlayersUnsorted,
        (p) => p.id.trim().toUpperCase(),
        (p) => p.handleUsd,
      ),
    [filteredPlayersUnsorted],
  )

  const conduitHeat = useMemo(
    () =>
      buildHandleHeatLookup(
        filteredConduits,
        (c) => c.agentId.trim().toUpperCase(),
        (c) => c.handleUsd,
      ),
    [filteredConduits],
  )

  const activeLegendHeat = useMemo(() => {
    if (viewMode === "PLAYERS") {
      return { scopeLabel: "Filtered Accounts", scale: playerHeat.scale }
    }
    if (viewMode === "CONDUITS") {
      return { scopeLabel: "Filtered Conduits", scale: conduitHeat.scale }
    }
    if (subAgentHeat.scale.totalCount > 0) {
      return { scopeLabel: "Filtered Sub-Agents", scale: subAgentHeat.scale }
    }
    if (conduitHeat.scale.totalCount > 0) {
      return { scopeLabel: "Filtered Conduits", scale: conduitHeat.scale }
    }
    return { scopeLabel: "Filtered Accounts", scale: playerHeat.scale }
  }, [viewMode, subAgentHeat.scale, conduitHeat.scale, playerHeat.scale])

  const handleCopyF402TxQuery = (agentId: string) => {
    const matchedOpt = agentFilterOptions.find(
      (o) => o.agentId.toUpperCase() === agentId.toUpperCase(),
    )
    const agentOwner = matchedOpt?.role === "sub-agent" ? matchedOpt.masterAgent : agentId
    const params = buildF402TransactionHistoryParams({
      agentId,
      agentOwner,
      customerId: normalizedFocusId ?? "",
      startDate: summary?.windowStart,
      endDate: summary?.windowEnd,
    })
    void copyText(params.toString()).then((res) => {
      if (!res.ok) return
      setCopiedTxAgentId(agentId)
      setTimeout(() => {
        setCopiedTxAgentId((prev) => (prev === agentId ? null : prev))
      }, 1_800)
    })
  }

  const toggleSort = (field: DownlinesSortField) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortDir(field === "rank" ? "asc" : "desc")
    }
  }

  const sortIndicator = (field: DownlinesSortField): string => {
    if (sortField !== field) return ""
    return sortDir === "asc" ? " ↑" : " ↓"
  }

  const exportMode: "CONDUITS" | "SUB_AGENTS" | "PLAYERS" =
    viewMode === "CONDUITS"
      ? "CONDUITS"
      : viewMode === "TREE" && visibleSubAgents.length > 0
        ? "SUB_AGENTS"
        : filteredPlayers.length > 0
          ? "PLAYERS"
          : visibleSubAgents.length > 0
            ? "SUB_AGENTS"
            : "PLAYERS"

  const exportRowCount =
    exportMode === "CONDUITS"
      ? filteredConduits.length
      : exportMode === "SUB_AGENTS"
        ? visibleSubAgents.length
        : filteredPlayers.length

  const shouldIgnoreRowClick = (target: EventTarget | null): boolean => {
    if (!target || typeof (target as { closest?: unknown }).closest !== "function") {
      return false
    }
    return Boolean(
      (target as Element).closest(
        'button, a, input, select, textarea, [role="button"], [role="menuitem"]',
      ),
    )
  }

  const handleAgentRowClick = (event: React.MouseEvent<HTMLElement>, agentId: string) => {
    if (!onSelectAgent || event.metaKey || event.ctrlKey || event.button !== 0) {
      return
    }
    if (shouldIgnoreRowClick(event.target)) return
    onSelectAgent(agentId)
  }

  const handleAgentRowKeyDown = (event: React.KeyboardEvent<HTMLElement>, agentId: string) => {
    if (!onSelectAgent) return
    if (event.target !== event.currentTarget) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onSelectAgent(agentId)
    }
  }

  const handleDownloadCsv = () => {
    if (exportRowCount === 0) return
    const csv =
      exportMode === "CONDUITS"
        ? buildConduitsCsv(filteredConduits, conduitHeat.byKey)
        : exportMode === "SUB_AGENTS"
          ? buildSubAgentsCsv(visibleSubAgents, {
              totalDeskHandle,
              heatByKey: subAgentHeat.byKey,
            })
          : buildDownlinesCsv(filteredPlayers, {
              totalDeskHandle,
              heatByKey: playerHeat.byKey,
            })
    const filename = buildRankingsCsvFilename({
      viewMode,
      filter: rankingsFilter,
      selectedAgentIds: effectiveAgentIds,
      masterForest: selectedMasterForest,
    })
    const downloaded = downloadRankingsCsvBlob(csv, filename)
    if (downloaded) {
      setExportedCsvCount(exportRowCount)
      setTimeout(() => {
        setExportedCsvCount((prev) => (prev === exportRowCount ? null : prev))
      }, 2_000)
    }
  }

  const handleResetFilters = () => {
    onRankingsSearchChange("")
    onRankingsFilterChange("ALL")
    setSelectedMasterForest("ALL")
    updateSelectedAgentIds([])
    setIsolateFocusedLineage(false)
    setSortField("rank")
    setSortDir("asc")
    if (onClearFocusedCustomer) {
      onClearFocusedCustomer()
    }
  }

  const totalDeskHandle =
    summary?.totalHandleUsd && summary.totalHandleUsd > 0
      ? summary.totalHandleUsd
      : players.reduce((sum, p) => sum + p.handleUsd, 0)

  const hasActiveFilters =
    rankingsSearch.trim() !== "" ||
    rankingsFilter !== "ALL" ||
    selectedMasterForest !== "ALL" ||
    effectiveAgentIds.length > 0 ||
    isolateFocusedLineage ||
    normalizedFocusId !== null

  const unmeasured = "—"
  const isPending = rankingsStatus === "pending" && players.length === 0
  const showTree = viewMode === "ALL" || viewMode === "TREE"
  const showPlayers = viewMode === "ALL" || viewMode === "PLAYERS"
  const showConduits = viewMode === "ALL" || viewMode === "CONDUITS"

  return (
    <div
      data-heatmap-enabled={effectiveHeatMapEnabled ? "true" : "false"}
      style={{ display: "flex", flexDirection: "column", gap: "18px" }}
      aria-busy={isPending ? "true" : undefined}
    >
      <RankingsSourceNotice
        status={rankingsStatus}
        error={rankingsError}
        rejectedRows={rankings?.rejectedRows ?? 0}
      />

      {/* Focused Customer Downline Bar (resolves /?customer=<ID>&tab=rankings cleanly) */}
      {normalizedFocusId && (
        <div
          data-downline-customer-focus={normalizedFocusId}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            padding: "12px 16px",
            borderRadius: "8px",
            backgroundColor: "rgba(15, 23, 42, 0.92)",
            border: "1px solid rgba(56, 189, 248, 0.4)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              minWidth: "240px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
                fontSize: "13px",
              }}
            >
              <GitBranch size={14} style={{ color: "#38bdf8" }} aria-hidden="true" />
              <span style={{ color: "#94a3b8", fontWeight: 500 }}>Focused Customer Lineage:</span>
              {focusedPlayer ? (
                <>
                  <button
                    type="button"
                    onClick={() => setSelectedMasterForest(focusedPlayer.masterAgent)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "#cbd5e1",
                      fontWeight: 600,
                      cursor: "pointer",
                      fontSize: "13px",
                    }}
                    title="Filter downlines to this Master Forest"
                  >
                    {focusedPlayer.masterAgent}
                  </button>
                  <span style={{ color: "#64748b" }} aria-hidden="true">
                    /
                  </span>
                  <button
                    type="button"
                    onClick={() => onSelectAgent?.(focusedPlayer.agentId)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "#38bdf8",
                      fontWeight: 600,
                      cursor: "pointer",
                      fontSize: "13px",
                    }}
                    title="Open Sub-Agent Inspector"
                  >
                    {focusedPlayer.agentId}
                  </button>
                  <span style={{ color: "#64748b" }} aria-hidden="true">
                    /
                  </span>
                  <strong style={{ color: "#f8fafc", ...TABULAR_NUMS }}>{focusedPlayer.id}</strong>
                </>
              ) : (
                <strong style={{ color: "#f8fafc" }}>{normalizedFocusId}</strong>
              )}
            </div>
            <div
              style={{
                fontSize: "12px",
                color: "#94a3b8",
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
                ...TABULAR_NUMS,
              }}
            >
              {focusedPlayer ? (
                <>
                  <span>Handle: ${focusedPlayer.handleUsd.toLocaleString()}</span>
                  <span aria-hidden="true">·</span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                    }}
                  >
                    <span>
                      Sub-Agent Share: {focusedSharePct !== null ? `${focusedSharePct}%` : "—"}
                    </span>
                    <HandleTrendIndicator
                      deltaPct={focusedPlayer.handleDelta24hPct}
                      label={`${focusedPlayer.id} 24h handle shift`}
                      compact
                    />
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Score: {focusedPlayer.score.toFixed(2)}</span>
                  <span aria-hidden="true">·</span>
                  <span>Downline Peers: {focusedSubAgent ? focusedSubAgent.customerCount : 1}</span>
                  {focusedPlayer.clvBps !== undefined && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>
                        CLV: {focusedPlayer.clvBps > 0 ? "+" : ""}
                        {focusedPlayer.clvBps} bps
                      </span>
                    </>
                  )}
                </>
              ) : (
                <span>
                  {normalizedFocusId} is not in the current 30d top-rankings slice — full downlines
                  remain visible below.
                </span>
              )}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            {focusedPlayer && (
              <button
                type="button"
                data-downline-isolate-toggle="true"
                onClick={() => setIsolateFocusedLineage((prev) => !prev)}
                style={{
                  ...styles.actionBtn,
                  padding: "5px 10px",
                  fontSize: "12px",
                  whiteSpace: "nowrap",
                  backgroundColor: isolateFocusedLineage ? "rgba(56, 189, 248, 0.2)" : undefined,
                  borderColor: isolateFocusedLineage ? "#38bdf8" : undefined,
                }}
              >
                {isolateFocusedLineage ? "Showing Lineage Only" : "Isolate Lineage"}
              </button>
            )}
            {onSelectCustomerById && (
              <button
                type="button"
                onClick={() => onSelectCustomerById(normalizedFocusId)}
                style={{
                  ...styles.actionBtn,
                  padding: "5px 10px",
                  fontSize: "12px",
                  whiteSpace: "nowrap",
                }}
              >
                Open Profile
              </button>
            )}
            <button
              type="button"
              onClick={() => onInspectPty(normalizedFocusId)}
              style={{
                ...styles.actionBtn,
                padding: "5px 10px",
                fontSize: "12px",
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
              }}
            >
              <Terminal size={12} aria-hidden="true" />
              <span>PTY</span>
            </button>
            {onClearFocusedCustomer && (
              <button
                type="button"
                data-downline-clear-focus="true"
                onClick={() => {
                  setIsolateFocusedLineage(false)
                  onClearFocusedCustomer()
                }}
                style={{
                  ...styles.actionBtn,
                  padding: "5px 10px",
                  fontSize: "12px",
                  whiteSpace: "nowrap",
                  borderColor: "#64748b",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                }}
              >
                <X size={12} aria-hidden="true" />
                <span>Clear Focus</span>
              </button>
            )}
          </div>
        </div>
      )}

      <PopulationStrip />

      {/* 30-Day Sharps & Agency Downlines KPI Strip */}
      <div style={styles.kpiGrid}>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>30-Day Total Handle</div>
          <div style={{ ...styles.kpiVal, ...TABULAR_NUMS }}>
            {summary ? (
              formatUsdCompact(summary.totalHandleUsd)
            ) : isPending ? (
              <SkeletonBlock width="62%" height={24} tone="accent" />
            ) : (
              unmeasured
            )}
          </div>
          <div style={{ ...styles.kpiSub, ...TABULAR_NUMS }}>
            {summary ? (
              `${summary.inWindowWagers.toLocaleString()} Wagers (${summary.windowStart} – ${summary.windowEnd})`
            ) : isPending ? (
              <SkeletonBlock width="84%" height={11} tone="subtle" />
            ) : (
              `No source: GET ${RANKINGS_ENDPOINT}`
            )}
          </div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Active Player Downline</div>
          <div style={{ ...styles.kpiVal, ...TABULAR_NUMS }}>
            {summary ? (
              `${summary.activeCustomerCount.toLocaleString()} Accounts`
            ) : isPending ? (
              <SkeletonBlock width="66%" height={24} tone="accent" />
            ) : (
              unmeasured
            )}
          </div>
          <div style={{ ...styles.kpiSub, ...TABULAR_NUMS }}>
            {summary ? (
              `${summary.activeSubAgentCount.toLocaleString()} Sub-Agents · ${summary.activeMasterAgentCount.toLocaleString()} Master Forests`
            ) : isPending ? (
              <SkeletonBlock width="78%" height={11} tone="subtle" />
            ) : (
              `No source: GET ${RANKINGS_ENDPOINT}`
            )}
          </div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Proxy Conduits Detected</div>
          <div style={{ ...styles.kpiVal, color: "#f87171", ...TABULAR_NUMS }}>
            {summary ? (
              `${summary.conduitSubAgentCount.toLocaleString()} Agencies`
            ) : isPending ? (
              <SkeletonBlock width="58%" height={24} />
            ) : (
              unmeasured
            )}
          </div>
          <div style={styles.kpiSub}>Single-Customer Concentration ≥ 80%</div>
        </div>
        <div style={styles.kpiCard}>
          <div style={styles.kpiLabel}>Desk Exposure (ToWin)</div>
          <div style={{ ...styles.kpiVal, ...TABULAR_NUMS }}>
            {summary ? (
              formatUsdCompact(summary.totalToWinUsd)
            ) : isPending ? (
              <SkeletonBlock width="60%" height={24} tone="accent" />
            ) : (
              unmeasured
            )}
          </div>
          <div style={{ ...styles.kpiSub, ...TABULAR_NUMS }}>
            {summary ? (
              `Generated ${summary.generatedAtIso || "(no timestamp)"}`
            ) : isPending ? (
              <SkeletonBlock width="72%" height={11} tone="subtle" />
            ) : (
              `No source: GET ${RANKINGS_ENDPOINT}`
            )}
          </div>
        </div>
      </div>

      {/* Unified Filter Bar, View Switcher & Export Controls */}
      <div
        style={{
          ...styles.filterBar,
          display: "flex",
          flexWrap: "wrap",
          gap: "10px",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "10px",
            alignItems: "center",
            flex: "1 1 360px",
          }}
        >
          <div style={{ ...styles.searchBox, flex: "1 1 220px" }}>
            <Search
              size={14}
              style={{ color: "#64748b", flexShrink: 0, marginLeft: "10px" }}
              aria-hidden="true"
            />
            <input
              style={styles.searchInput}
              value={rankingsSearch}
              onChange={(e) => onRankingsSearchChange(e.target.value)}
              placeholder="Filter by Customer, Sub-Agent, Master Forest, or Sport..."
              aria-label="Filter customer downlines"
            />
          </div>

          <AgentMultiSelectFilter
            options={agentFilterOptions}
            selectedAgentIds={effectiveAgentIds}
            onChange={updateSelectedAgentIds}
          />

          <div style={styles.tierFilterGroup}>
            {rankingsFilterControls(summary?.conduitSubAgentCount ?? null).map((item) => (
              <button
                key={item.id}
                type="button"
                style={{
                  ...styles.filterPill(rankingsFilter === item.id),
                  whiteSpace: "nowrap",
                }}
                onClick={() => onRankingsFilterChange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          {/* Segmented View Mode Control */}
          <div
            role="group"
            aria-label="Downlines layout view"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
              padding: "3px",
              borderRadius: "7px",
              backgroundColor: "rgba(15, 23, 42, 0.7)",
              border: "1px solid #334155",
            }}
          >
            {(
              [
                { id: "ALL", label: "All Views" },
                { id: "TREE", label: "Hierarchy" },
                { id: "PLAYERS", label: "Customers" },
                { id: "CONDUITS", label: "Agencies" },
              ] as const
            ).map((mode) => (
              <button
                key={mode.id}
                type="button"
                data-downlines-view={mode.id}
                onClick={() => setViewMode(mode.id)}
                style={{
                  padding: "4px 9px",
                  borderRadius: "5px",
                  border: "none",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  backgroundColor: viewMode === mode.id ? "rgba(56, 189, 248, 0.2)" : "transparent",
                  color: viewMode === mode.id ? "#38bdf8" : "#94a3b8",
                }}
              >
                {mode.label}
              </button>
            ))}
          </div>

          {/* Dedicated Heat Map Toggle (persisted in localStorage) */}
          <button
            type="button"
            className="sd-heatmap-toggle"
            data-heatmap-toggle="true"
            data-heatmap-storage-key={RANKINGS_HEATMAP_STORAGE_KEY}
            aria-pressed={effectiveHeatMapEnabled}
            onClick={handleToggleHeatMap}
            title={
              effectiveHeatMapEnabled
                ? "Disable handle volume heat-map overlay (saved in localStorage)"
                : "Enable handle volume heat-map overlay (saved in localStorage)"
            }
          >
            <Layers size={12} aria-hidden="true" />
            <span>Heat Map: {effectiveHeatMapEnabled ? "On" : "Off"}</span>
            <span className="sd-heatmap-toggle-track" aria-hidden="true">
              <span className="sd-heatmap-toggle-thumb" />
            </span>
          </button>

          <button
            type="button"
            className="sd-export-csv-btn"
            data-rankings-export-csv="true"
            data-export-row-count={exportRowCount}
            data-export-confirmed={exportedCsvCount !== null ? "true" : "false"}
            onClick={handleDownloadCsv}
            disabled={exportRowCount === 0}
            aria-label={
              exportRowCount > 0
                ? `Export to CSV (${exportRowCount} filtered row${exportRowCount === 1 ? "" : "s"})`
                : "Export to CSV (no filtered rows available)"
            }
            title={
              exportRowCount > 0
                ? `Export ${exportRowCount} currently filtered ${viewMode === "CONDUITS" ? "proxy conduit" : "ranking"} row${exportRowCount === 1 ? "" : "s"} to CSV`
                : "No filtered rankings rows available to export"
            }
          >
            {exportedCsvCount !== null ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <Download size={12} aria-hidden="true" />
            )}
            <span>
              {exportedCsvCount !== null
                ? `Exported ${exportedCsvCount} row${exportedCsvCount === 1 ? "" : "s"}`
                : exportRowCount > 0
                  ? `Export to CSV (${exportRowCount})`
                  : "Export to CSV"}
            </span>
          </button>

          {hasActiveFilters && (
            <button
              type="button"
              data-downlines-reset="true"
              onClick={handleResetFilters}
              style={{
                ...styles.actionBtn,
                padding: "5px 10px",
                fontSize: "11px",
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                borderColor: "#64748b",
              }}
            >
              <RotateCcw size={12} aria-hidden="true" />
              <span>Reset</span>
            </button>
          )}
        </div>
      </div>

      {/* Inline 6-Step Handle Heat-Map Legend Strip */}
      {effectiveHeatMapEnabled && (
        <RankingsHeatMapLegend
          scale={activeLegendHeat.scale}
          scopeLabel={activeLegendHeat.scopeLabel}
        />
      )}

      {/* Active Agent ID Multi-Select Filter Bar */}
      {effectiveAgentIds.length > 0 && (
        <div
          data-downline-agent-filter-bar="true"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "9px 14px",
            borderRadius: "8px",
            backgroundColor: "rgba(15, 23, 42, 0.9)",
            border: "1px solid rgba(56, 189, 248, 0.35)",
            fontSize: "12px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "6px",
            }}
          >
            <span
              style={{
                color: "#94a3b8",
                fontWeight: 600,
                whiteSpace: "nowrap",
                marginRight: "2px",
              }}
            >
              Agent Filter ({effectiveAgentIds.length}):
            </span>
            {effectiveAgentIds.map((agentId) => (
              <button
                key={agentId}
                type="button"
                data-selected-agent-chip={agentId}
                onClick={() => toggleSelectedAgentId(agentId)}
                title={`Remove ${agentId} from Agent ID filter`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "3px 8px",
                  borderRadius: "6px",
                  border: "1px solid rgba(56, 189, 248, 0.45)",
                  backgroundColor: "rgba(56, 189, 248, 0.14)",
                  color: "#7dd3fc",
                  fontSize: "11px",
                  fontWeight: 700,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  ...TABULAR_NUMS,
                }}
              >
                <span>{agentId}</span>
                <X size={11} aria-hidden="true" />
              </button>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            {onSelectAgent && effectiveAgentIds[0] && (
              <button
                type="button"
                data-inspect-selected-agent={effectiveAgentIds[0]}
                onClick={() => onSelectAgent(effectiveAgentIds[0]!)}
                style={{
                  ...styles.actionBtn,
                  padding: "4px 9px",
                  fontSize: "11px",
                  whiteSpace: "nowrap",
                }}
              >
                Inspect {effectiveAgentIds[0]}
              </button>
            )}
            {effectiveAgentIds[0] && (
              <button
                type="button"
                data-copy-f402-tx-query="true"
                onClick={() => handleCopyF402TxQuery(effectiveAgentIds[0]!)}
                style={{
                  ...styles.actionBtn,
                  padding: "4px 9px",
                  fontSize: "11px",
                  whiteSpace: "nowrap",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                }}
                title="Copy Fantasy402 getTransactionHistory query parameters for this Agent ID"
              >
                {copiedTxAgentId === effectiveAgentIds[0] ? (
                  <Check size={11} aria-hidden="true" />
                ) : (
                  <Copy size={11} aria-hidden="true" />
                )}
                <span>
                  {copiedTxAgentId === effectiveAgentIds[0]
                    ? "Copied Tx Query"
                    : "Copy F402 Tx Query"}
                </span>
              </button>
            )}
            <button
              type="button"
              data-clear-selected-agents="true"
              onClick={() => updateSelectedAgentIds([])}
              style={{
                ...styles.actionBtn,
                padding: "4px 9px",
                fontSize: "11px",
                whiteSpace: "nowrap",
                borderColor: "#64748b",
              }}
            >
              Clear Agents
            </button>
          </div>
        </div>
      )}

      {/* Master Forest Quick-Filter Bar */}
      {allForests.length > 0 && (
        <div
          data-downlines-master-bar="true"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            flexWrap: "wrap",
            fontSize: "12px",
          }}
        >
          <span
            style={{
              color: "#94a3b8",
              fontWeight: 600,
              marginRight: "4px",
              whiteSpace: "nowrap",
            }}
          >
            Master Forests:
          </span>
          <button
            type="button"
            onClick={() => setSelectedMasterForest("ALL")}
            style={{
              ...styles.filterPill(selectedMasterForest === "ALL"),
              padding: "4px 10px",
              fontSize: "11px",
              whiteSpace: "nowrap",
            }}
          >
            All ({allForests.length})
          </button>
          {allForests.map((forest) => {
            const active = selectedMasterForest.toUpperCase() === forest.masterAgent.toUpperCase()
            return (
              <button
                key={forest.masterAgent}
                type="button"
                onClick={() => setSelectedMasterForest(active ? "ALL" : forest.masterAgent)}
                style={{
                  ...styles.filterPill(active),
                  padding: "4px 10px",
                  fontSize: "11px",
                  whiteSpace: "nowrap",
                  ...TABULAR_NUMS,
                }}
              >
                {forest.masterAgent} · {forest.subAgentCount} ag ·{" "}
                {formatUsdCompact(forest.handleUsd)}
              </button>
            )
          })}
        </div>
      )}

      {/* Interactive Customer Downline Hierarchy Tree */}
      {showTree && (
        <div style={styles.tableCard} data-downlines-hierarchy="true">
          <div style={styles.tableHeader}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <GitBranch size={15} style={{ color: "#38bdf8" }} aria-hidden="true" />
              <h3 style={styles.tableTitle}>
                Customer Downline Hierarchy (Master Forest → Sub-Agent → Accounts)
              </h3>
            </div>
            <span style={{ fontSize: "12px", color: "#94a3b8", ...TABULAR_NUMS }}>
              {visibleForests.length} forest{visibleForests.length === 1 ? "" : "s"} ·{" "}
              {visibleSubAgents.length} sub-agent{visibleSubAgents.length === 1 ? "" : "s"} ·{" "}
              {filteredPlayers.length} account{filteredPlayers.length === 1 ? "" : "s"}
            </span>
          </div>

          <div
            style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: "12px" }}
          >
            {visibleForests.length === 0 ? (
              <div
                style={{
                  textAlign: "center",
                  color: "#94a3b8",
                  fontSize: "12px",
                  padding: "16px 0",
                }}
              >
                {isPending
                  ? `Waiting for GET ${RANKINGS_ENDPOINT}…`
                  : "No downline hierarchy matches the active filters."}
              </div>
            ) : (
              visibleForests.map((forest) => {
                const isCollapsed = Boolean(collapsedMasters[forest.masterAgent])
                const deskSharePct =
                  totalDeskHandle > 0
                    ? Math.min(100, (forest.handleUsd / totalDeskHandle) * 100)
                    : 0
                return (
                  <div
                    key={forest.masterAgent}
                    data-downline-forest={forest.masterAgent}
                    style={{
                      border: "1px solid #1e293b",
                      borderRadius: "8px",
                      overflow: "hidden",
                    }}
                  >
                    {/* Master Forest Row */}
                    <div
                      className={onSelectAgent ? "sd-rankings-clickable-row" : undefined}
                      data-downline-master-row={forest.masterAgent}
                      data-rankings-row-agent={forest.masterAgent}
                      tabIndex={onSelectAgent ? 0 : undefined}
                      title={
                        onSelectAgent
                          ? `Click row to inspect Master Forest ${forest.masterAgent}`
                          : undefined
                      }
                      onClick={(e) => handleAgentRowClick(e, forest.masterAgent)}
                      onKeyDown={(e) => handleAgentRowKeyDown(e, forest.masterAgent)}
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                        padding: "10px 14px",
                        backgroundColor: "rgba(15, 23, 42, 0.7)",
                        borderBottom: isCollapsed ? "none" : "1px solid #1e293b",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          minWidth: "200px",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedMasters((prev) => ({
                              ...prev,
                              [forest.masterAgent]: !isCollapsed,
                            }))
                          }
                          aria-expanded={!isCollapsed}
                          aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${forest.masterAgent} downline`}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#94a3b8",
                            cursor: "pointer",
                            padding: "2px",
                            display: "inline-flex",
                            alignItems: "center",
                          }}
                        >
                          {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => onSelectAgent?.(forest.masterAgent)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            color: "#f8fafc",
                            fontWeight: 700,
                            fontSize: "13px",
                            cursor: "pointer",
                          }}
                          title="Inspect Master Forest in Agent Inspector"
                        >
                          {forest.masterAgent}
                        </button>
                        <span
                          style={{
                            fontSize: "12px",
                            color: "#94a3b8",
                            ...TABULAR_NUMS,
                          }}
                        >
                          {forest.subAgentCount} sub-agent
                          {forest.subAgentCount === 1 ? "" : "s"} · {forest.customerCount} account
                          {forest.customerCount === 1 ? "" : "s"}
                          {forest.conduitCount > 0
                            ? ` · ${forest.conduitCount} proxy conduit${forest.conduitCount === 1 ? "" : "s"}`
                            : ""}
                        </span>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "14px",
                          fontSize: "12px",
                          ...TABULAR_NUMS,
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                            minWidth: "140px",
                          }}
                        >
                          <div
                            style={{
                              width: "72px",
                              height: "6px",
                              borderRadius: "3px",
                              backgroundColor: "rgba(51, 65, 85, 0.7)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${deskSharePct.toFixed(1)}%`,
                                height: "100%",
                                backgroundColor: "#38bdf8",
                              }}
                            />
                          </div>
                          <span
                            style={{
                              color: "#94a3b8",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            <span>{deskSharePct.toFixed(1)}% desk</span>
                            <HandleTrendIndicator
                              deltaPct={forest.handleDelta24hPct}
                              label={`${forest.masterAgent} 24h handle shift`}
                            />
                          </span>
                        </div>
                        {(() => {
                          const masterKey = forest.masterAgent.trim().toUpperCase()
                          const forestHeat =
                            masterForestHeat.byKey.get(masterKey) ??
                            evaluateHandleHeatCell(masterForestHeat.scale, forest.handleUsd)
                          return (
                            <span
                              className="sd-heat-cell sd-heat-cell--inline"
                              data-heat-cell="true"
                              data-heat-bucket={forestHeat.bucket}
                              tabIndex={0}
                              title={forestHeat.summaryTitle}
                              style={{ fontWeight: 700, ...TABULAR_NUMS }}
                            >
                              <span>${forest.handleUsd.toLocaleString()}</span>
                              <HandleHeatTooltip
                                metrics={forestHeat}
                                entityLabel={`Master ${forest.masterAgent}`}
                                placement="left"
                              />
                            </span>
                          )
                        })()}
                      </div>
                    </div>

                    {/* Sub-Agents & Nested Customers */}
                    {!isCollapsed && (
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        {forest.subAgents.map((sa, saIdx) => {
                          const concColor = sa.isProxyConduit
                            ? "#ef4444"
                            : sa.concPct >= 60
                              ? "#f59e0b"
                              : "#4ade80"
                          const concStatus = sa.isProxyConduit
                            ? "PROXY CONDUIT"
                            : sa.concPct >= 60
                              ? "CONCENTRATED"
                              : "DIVERSIFIED"
                          return (
                            <div
                              key={sa.agentId}
                              data-downline-agent={sa.agentId}
                              style={{
                                borderTop: saIdx === 0 ? "none" : "1px solid #1e293b",
                                padding: "10px 14px 10px 30px",
                              }}
                            >
                              <div
                                className={onSelectAgent ? "sd-rankings-clickable-row" : undefined}
                                data-downline-agent-row={sa.agentId}
                                data-rankings-row-agent={sa.agentId}
                                tabIndex={onSelectAgent ? 0 : undefined}
                                title={
                                  onSelectAgent
                                    ? `Click row to inspect agent ${sa.agentId}`
                                    : undefined
                                }
                                onClick={(e) => handleAgentRowClick(e, sa.agentId)}
                                onKeyDown={(e) => handleAgentRowKeyDown(e, sa.agentId)}
                                style={{
                                  display: "flex",
                                  flexWrap: "wrap",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "10px",
                                  padding: "4px 6px",
                                  margin: "-4px -6px",
                                  borderRadius: "6px",
                                  marginBottom: sa.players.length > 0 ? "8px" : 0,
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "10px",
                                    flexWrap: "wrap",
                                  }}
                                >
                                  <Users
                                    size={13}
                                    style={{ color: "#38bdf8" }}
                                    aria-hidden="true"
                                  />
                                  <a
                                    href={getLocalAgentHref(sa.agentId)}
                                    onClick={(e) => {
                                      if (
                                        onSelectAgent &&
                                        !e.metaKey &&
                                        !e.ctrlKey &&
                                        e.button === 0
                                      ) {
                                        e.preventDefault()
                                        onSelectAgent(sa.agentId)
                                      }
                                    }}
                                    style={{
                                      color: "#38bdf8",
                                      fontWeight: 700,
                                      fontSize: "13px",
                                      textDecoration: "none",
                                    }}
                                    title="Open Sub-Agent Inspector"
                                  >
                                    {sa.agentId} ↗
                                  </a>
                                  <span
                                    style={{
                                      fontSize: "11px",
                                      fontWeight: 700,
                                      color: concColor,
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: "6px",
                                      ...TABULAR_NUMS,
                                    }}
                                  >
                                    <span>
                                      {concStatus} ({sa.concPct.toFixed(1)}%)
                                    </span>
                                    <HandleTrendIndicator
                                      deltaPct={sa.handleDelta24hPct}
                                      label={`${sa.agentId} 24h performance shift`}
                                    />
                                  </span>
                                  <span
                                    style={{
                                      fontSize: "12px",
                                      color: "#94a3b8",
                                      ...TABULAR_NUMS,
                                    }}
                                  >
                                    {sa.customerCount} acct
                                    {sa.customerCount === 1 ? "" : "s"} ·{" "}
                                    {sa.wagers.toLocaleString()} wagers
                                    {sa.avgScore !== null
                                      ? ` · avg score ${sa.avgScore.toFixed(2)}`
                                      : ""}
                                  </span>
                                </div>

                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "10px",
                                    fontSize: "12px",
                                    ...TABULAR_NUMS,
                                  }}
                                >
                                  {(() => {
                                    const saKey = sa.agentId.trim().toUpperCase()
                                    const saHeat =
                                      subAgentHeat.byKey.get(saKey) ??
                                      evaluateHandleHeatCell(subAgentHeat.scale, sa.handleUsd)
                                    const saForestSharePct =
                                      forest.handleUsd > 0
                                        ? (sa.handleUsd / forest.handleUsd) * 100
                                        : 0
                                    return (
                                      <span
                                        className="sd-heat-cell sd-heat-cell--inline"
                                        data-heat-cell="true"
                                        data-heat-bucket={saHeat.bucket}
                                        tabIndex={0}
                                        title={saHeat.summaryTitle}
                                        style={{
                                          fontWeight: 600,
                                          ...TABULAR_NUMS,
                                        }}
                                      >
                                        <span>${sa.handleUsd.toLocaleString()}</span>
                                        <span
                                          className="sd-heat-subtext"
                                          style={{
                                            fontSize: "11px",
                                            fontWeight: 500,
                                            color: "#94a3b8",
                                          }}
                                        >
                                          {saForestSharePct.toFixed(1)}%
                                        </span>
                                        <HandleTrendIndicator
                                          deltaPct={sa.handleDelta24hPct}
                                          label={`${sa.agentId} 24h handle shift`}
                                          compact
                                        />
                                        <HandleHeatTooltip
                                          metrics={saHeat}
                                          entityLabel={`Agent ${sa.agentId}`}
                                          placement="left"
                                        />
                                      </span>
                                    )
                                  })()}
                                  {sa.totalNetUsd !== null && (
                                    <span
                                      style={{
                                        color:
                                          sa.totalNetUsd > 0
                                            ? "#f87171"
                                            : sa.totalNetUsd < 0
                                              ? "#4ade80"
                                              : "#94a3b8",
                                      }}
                                    >
                                      Net {formatSignedUsd(sa.totalNetUsd)}
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => toggleSelectedAgentId(sa.agentId)}
                                    style={{
                                      ...styles.actionBtn,
                                      padding: "3px 8px",
                                      fontSize: "11px",
                                      whiteSpace: "nowrap",
                                      borderColor: effectiveAgentIdSet.has(sa.agentId.toUpperCase())
                                        ? "#38bdf8"
                                        : undefined,
                                      backgroundColor: effectiveAgentIdSet.has(
                                        sa.agentId.toUpperCase(),
                                      )
                                        ? "rgba(56, 189, 248, 0.16)"
                                        : undefined,
                                    }}
                                  >
                                    {effectiveAgentIdSet.has(sa.agentId.toUpperCase())
                                      ? "Filtered"
                                      : "Filter Agent"}
                                  </button>
                                </div>
                              </div>

                              {/* Nested Customer Accounts under Sub-Agent */}
                              {sa.players.length > 0 && (
                                <div
                                  style={{
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: "4px",
                                    paddingLeft: "18px",
                                    borderTop: "1px solid rgba(30, 41, 59, 0.7)",
                                    paddingTop: "6px",
                                  }}
                                >
                                  {sa.players.map((p) => {
                                    const share =
                                      sa.handleUsd > 0
                                        ? (p.handleUsd / sa.handleUsd) * 100
                                        : sa.players.length === 1
                                          ? 100
                                          : 0
                                    const isFocused = normalizedFocusId === p.id.toUpperCase()
                                    return (
                                      <div
                                        key={p.id}
                                        className={
                                          onSelectAgent ? "sd-rankings-clickable-row" : undefined
                                        }
                                        data-downline-customer-row={p.id}
                                        data-rankings-row-agent={p.agentId}
                                        tabIndex={onSelectAgent ? 0 : undefined}
                                        title={
                                          onSelectAgent
                                            ? `Click row to inspect agent ${p.agentId}`
                                            : undefined
                                        }
                                        onClick={(e) => handleAgentRowClick(e, p.agentId)}
                                        onKeyDown={(e) => handleAgentRowKeyDown(e, p.agentId)}
                                        style={{
                                          display: "grid",
                                          gridTemplateColumns:
                                            "minmax(140px, 1.4fr) minmax(130px, 1fr) minmax(110px, 1fr) minmax(90px, 0.8fr) auto",
                                          alignItems: "center",
                                          gap: "10px",
                                          padding: "5px 8px",
                                          borderRadius: "6px",
                                          backgroundColor: isFocused
                                            ? "rgba(56, 189, 248, 0.12)"
                                            : "transparent",
                                          border: isFocused
                                            ? "1px solid rgba(56, 189, 248, 0.45)"
                                            : "1px solid transparent",
                                          fontSize: "12px",
                                          ...TABULAR_NUMS,
                                        }}
                                      >
                                        <div
                                          style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "6px",
                                            minWidth: 0,
                                          }}
                                        >
                                          <a
                                            href={getLocalCustomerHref(p.id)}
                                            onClick={(e) => {
                                              if (
                                                onSelectCustomerById &&
                                                !e.metaKey &&
                                                !e.ctrlKey &&
                                                e.button === 0
                                              ) {
                                                e.preventDefault()
                                                onSelectCustomerById(p.id)
                                              }
                                            }}
                                            style={{
                                              color: "#f8fafc",
                                              fontWeight: 700,
                                              textDecoration: "none",
                                            }}
                                          >
                                            {p.id}
                                          </a>
                                          <span
                                            style={{
                                              color: "#64748b",
                                              fontSize: "11px",
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            {p.dominantSport}
                                            {p.contextType
                                              ? ` · ${p.contextType.replace(/_/g, " ")}`
                                              : ""}
                                          </span>
                                        </div>

                                        <div
                                          style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "6px",
                                          }}
                                        >
                                          <div
                                            style={{
                                              width: "48px",
                                              height: "5px",
                                              borderRadius: "3px",
                                              backgroundColor: "rgba(51, 65, 85, 0.7)",
                                              overflow: "hidden",
                                              flexShrink: 0,
                                            }}
                                          >
                                            <div
                                              style={{
                                                width: `${Math.min(100, share).toFixed(0)}%`,
                                                height: "100%",
                                                backgroundColor:
                                                  share >= 80 ? "#f87171" : "#38bdf8",
                                              }}
                                            />
                                          </div>
                                          <span
                                            style={{
                                              color: "#94a3b8",
                                              display: "inline-flex",
                                              alignItems: "center",
                                              gap: "4px",
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            <span>{share.toFixed(0)}%</span>
                                            <HandleTrendIndicator
                                              deltaPct={p.handleDelta24hPct}
                                              label={`${p.id} 24h handle shift`}
                                              compact
                                            />
                                          </span>
                                          {(() => {
                                            const pKey = p.id.trim().toUpperCase()
                                            const custHeat =
                                              playerHeat.byKey.get(pKey) ??
                                              evaluateHandleHeatCell(playerHeat.scale, p.handleUsd)
                                            return (
                                              <span
                                                className="sd-heat-cell sd-heat-cell--inline"
                                                data-heat-cell="true"
                                                data-heat-bucket={custHeat.bucket}
                                                tabIndex={0}
                                                title={custHeat.summaryTitle}
                                                style={{
                                                  fontWeight: 600,
                                                  ...TABULAR_NUMS,
                                                }}
                                              >
                                                <span>${p.handleUsd.toLocaleString()}</span>
                                                <HandleHeatTooltip
                                                  metrics={custHeat}
                                                  entityLabel={p.id}
                                                  placement="left"
                                                />
                                              </span>
                                            )
                                          })()}
                                        </div>

                                        <div style={{ color: "#94a3b8" }}>
                                          Score{" "}
                                          <strong
                                            style={{
                                              color: p.score >= 7.5 ? "#f59e0b" : "#38bdf8",
                                            }}
                                          >
                                            {p.score.toFixed(2)}
                                          </strong>{" "}
                                          · {p.wagers} wgr
                                        </div>

                                        <div style={{ color: "#94a3b8" }}>
                                          Lim ${p.limitUsd.toLocaleString()}
                                        </div>

                                        <div
                                          style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "6px",
                                            justifyContent: "flex-end",
                                          }}
                                        >
                                          {onFocusCustomer && (
                                            <button
                                              type="button"
                                              onClick={() =>
                                                isFocused && onClearFocusedCustomer
                                                  ? onClearFocusedCustomer()
                                                  : onFocusCustomer(p.id)
                                              }
                                              style={{
                                                ...styles.actionBtn,
                                                padding: "3px 7px",
                                                fontSize: "11px",
                                                whiteSpace: "nowrap",
                                                borderColor: isFocused ? "#38bdf8" : undefined,
                                              }}
                                            >
                                              {isFocused ? "Focused" : "Focus"}
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            onClick={() => onInspectPty(p.id)}
                                            style={{
                                              ...styles.actionBtn,
                                              padding: "3px 7px",
                                              fontSize: "11px",
                                              whiteSpace: "nowrap",
                                            }}
                                          >
                                            PTY
                                          </button>
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}

      {/* Main Sortable Customer Rankings Table */}
      {showPlayers && (
        <div style={styles.tableCard}>
          <div style={styles.tableHeader}>
            <h3 style={styles.tableTitle}>30-Day Sharp Bettor Rankings & Downline Profiling</h3>
            <span style={{ fontSize: "11px", color: "#64748b", ...TABULAR_NUMS }}>
              Showing {filteredPlayers.length} of {players.length} accounts · Click any row to
              inspect agent · Click headers to sort · autoExecute: false
            </span>
          </div>

          <div style={styles.tableScroll}>
            <table className="sd-rankings-table" style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("rank")}
                      style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      Rank{sortIndicator("rank")}
                    </button>
                  </th>
                  <th style={styles.th}>Customer ID</th>
                  <th style={styles.th}>Sub-Agent / Master</th>
                  <th style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("handleUsd")}
                      style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      30d Volume{sortIndicator("handleUsd")}
                    </button>
                  </th>
                  <th style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("wagers")}
                      style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      Wagers{sortIndicator("wagers")}
                    </button>
                  </th>
                  <th style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("gini")}
                      style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      Stake Gini{sortIndicator("gini")}
                    </button>
                  </th>
                  <th style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("alertRate")}
                      style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      Alert Rate{sortIndicator("alertRate")}
                    </button>
                  </th>
                  <th style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("score")}
                      style={{
                        background: "none",
                        border: "none",
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      Composite Score{sortIndicator("score")}
                    </button>
                  </th>
                  <th style={styles.th}>Classification & Tier</th>
                  <th style={styles.th}>Risk Directives</th>
                  <th style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {players.length === 0 ? (
                  <>
                    {isPending ? (
                      <SkeletonTableRows
                        columnWidths={[
                          "48%",
                          "78%",
                          "82%",
                          "64%",
                          "54%",
                          "54%",
                          "58%",
                          "60%",
                          "76%",
                          "72%",
                          "64%",
                        ]}
                        rowCount={6}
                        rowHeight={42}
                        skeletonId="rankings-rows"
                      />
                    ) : null}
                    <tr>
                      <td
                        colSpan={11}
                        data-rankings-empty="players"
                        style={{
                          ...styles.td,
                          textAlign: "center",
                          color: "#94a3b8",
                        }}
                      >
                        {rankingsStatus === "ready"
                          ? `GET ${RANKINGS_ENDPOINT} returned no ranked players for this window.`
                          : rankingsStatus === "pending"
                            ? `Waiting for GET ${RANKINGS_ENDPOINT}…`
                            : `Unavailable — GET ${RANKINGS_ENDPOINT}: ${rankingsError ?? "no response"}`}
                      </td>
                    </tr>
                  </>
                ) : filteredPlayers.length === 0 ? (
                  <tr>
                    <td
                      colSpan={11}
                      style={{
                        ...styles.td,
                        textAlign: "center",
                        color: "#94a3b8",
                      }}
                    >
                      No accounts match the active downline filter.{" "}
                      <button
                        type="button"
                        onClick={handleResetFilters}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#38bdf8",
                          cursor: "pointer",
                          textDecoration: "underline",
                          fontSize: "12px",
                        }}
                      >
                        Reset filters
                      </button>
                    </td>
                  </tr>
                ) : null}
                {filteredPlayers.map((p) => {
                  const isFocused = normalizedFocusId === p.id.toUpperCase()
                  return (
                    <tr
                      key={p.id}
                      className={onSelectAgent ? "sd-rankings-clickable-row" : undefined}
                      data-rankings-row-agent={p.agentId}
                      tabIndex={onSelectAgent ? 0 : undefined}
                      title={onSelectAgent ? `Click row to inspect agent ${p.agentId}` : undefined}
                      onClick={(e) => handleAgentRowClick(e, p.agentId)}
                      onKeyDown={(e) => handleAgentRowKeyDown(e, p.agentId)}
                      style={isFocused ? { backgroundColor: "rgba(56, 189, 248, 0.1)" } : undefined}
                    >
                      <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                        <span style={{ fontWeight: 700, color: "#38bdf8" }}>#{p.rank}</span>
                      </td>
                      <td style={styles.td}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <a
                            href={getLocalCustomerHref(p.id)}
                            onClick={(e) => {
                              if (
                                onSelectCustomerById &&
                                !e.metaKey &&
                                !e.ctrlKey &&
                                e.button === 0
                              ) {
                                e.preventDefault()
                                onSelectCustomerById(p.id)
                              }
                            }}
                            style={{
                              ...styles.custLogin,
                              textDecoration: "none",
                            }}
                            title="Inspect Customer in SportsDesk Profiles"
                          >
                            {p.id}
                          </a>
                          <a
                            {...getFantasy402PortalLinkProps(p.id)}
                            style={{
                              color: "#64748b",
                              textDecoration: "none",
                              fontSize: "11px",
                              display: "inline-flex",
                              alignItems: "center",
                            }}
                            title="Open in active Fantasy402 Manager session tab"
                          >
                            <ExternalLink size={11} aria-hidden="true" />
                          </a>
                          {p.isProxy && (
                            <span
                              style={{
                                fontSize: "10px",
                                color: "#ef4444",
                                fontWeight: 700,
                              }}
                            >
                              · PROXY
                            </span>
                          )}
                        </div>
                        <div style={styles.custSub}>
                          {p.dominantSport}
                          {p.clvBps !== undefined
                            ? ` · CLV ${p.clvBps > 0 ? "+" : ""}${p.clvBps} bps`
                            : ""}
                        </div>
                      </td>
                      <td style={styles.td}>
                        <div style={{ fontWeight: 600 }}>
                          <a
                            href={getLocalAgentHref(p.agentId)}
                            onClick={(e) => {
                              if (onSelectAgent && !e.metaKey && !e.ctrlKey && e.button === 0) {
                                e.preventDefault()
                                onSelectAgent(p.agentId)
                              }
                            }}
                            style={{
                              color: "#38bdf8",
                              textDecoration: "none",
                            }}
                            title="Open SportsDesk Agent Inspector"
                          >
                            {p.agentId} ↗
                          </a>
                        </div>
                        <div style={styles.custSub}>
                          Master:{" "}
                          <button
                            type="button"
                            onClick={() => setSelectedMasterForest(p.masterAgent)}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              color: "inherit",
                              cursor: "pointer",
                              textDecoration: "underline",
                              fontSize: "inherit",
                            }}
                          >
                            {p.masterAgent}
                          </button>
                        </div>
                      </td>
                      {(() => {
                        const pKey = p.id.trim().toUpperCase()
                        const rowHeat =
                          playerHeat.byKey.get(pKey) ??
                          evaluateHandleHeatCell(playerHeat.scale, p.handleUsd)
                        return (
                          <td
                            className="sd-heat-cell"
                            data-heat-cell="true"
                            data-heat-bucket={rowHeat.bucket}
                            tabIndex={0}
                            title={rowHeat.summaryTitle}
                            style={{ ...styles.td, ...TABULAR_NUMS }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                fontWeight: 600,
                              }}
                            >
                              <span>${p.handleUsd.toLocaleString()}</span>
                              {totalDeskHandle > 0 && (
                                <span
                                  className="sd-heat-subtext"
                                  style={{
                                    fontSize: "11px",
                                    fontWeight: 500,
                                    color: "#cbd5e1",
                                  }}
                                >
                                  {((p.handleUsd / totalDeskHandle) * 100).toFixed(1)}%
                                </span>
                              )}
                              <HandleTrendIndicator
                                deltaPct={p.handleDelta24hPct}
                                label={`${p.id} 24h handle shift`}
                                compact
                              />
                            </div>
                            <div
                              className="sd-heat-subtext"
                              style={{ ...styles.custSub, color: "#cbd5e1" }}
                            >
                              {p.netUsd !== undefined
                                ? `Net: ${formatSignedUsd(p.netUsd)}`
                                : `Avg: ${p.wagers > 0 ? `$${(p.handleUsd / p.wagers).toFixed(0)}` : "—"}`}
                            </div>
                            <HandleHeatTooltip
                              metrics={rowHeat}
                              entityLabel={`${p.id} · ${p.agentId}`}
                              placement="right"
                            />
                          </td>
                        )
                      })()}
                      <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                        <div>{p.wagers.toLocaleString()}</div>
                      </td>
                      <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                        <span
                          style={{
                            color: p.gini <= 0.15 ? "#4ade80" : "#f59e0b",
                            fontWeight: 600,
                          }}
                        >
                          {p.gini.toFixed(3)}
                        </span>
                        <div style={styles.custSub}>
                          {p.gini <= 0.15 ? "Flat-Unit" : "Variable"}
                        </div>
                      </td>
                      <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                        <span
                          style={{
                            color: p.alertRate >= 50 ? "#ef4444" : "#94a3b8",
                            fontWeight: 600,
                          }}
                        >
                          {p.alertRate}%
                        </span>
                      </td>
                      <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                        <span
                          style={{
                            fontSize: "14px",
                            fontWeight: 700,
                            color: p.score >= 7.0 ? "#f59e0b" : "#38bdf8",
                          }}
                        >
                          {p.score.toFixed(2)}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span style={styles.tierBadge(p.tier)}>{p.tierLabel}</span>
                      </td>
                      <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                        <div style={{ fontSize: "11px", color: "#f87171" }}>
                          Limit: ${p.limitUsd.toLocaleString()}
                        </div>
                        <div style={styles.custSub}>Live Delay: 2-3s</div>
                      </td>
                      <td style={styles.td}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          {onFocusCustomer && (
                            <button
                              type="button"
                              style={{
                                ...styles.actionBtn,
                                padding: "4px 8px",
                                fontSize: "11px",
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                                borderColor: isFocused ? "#38bdf8" : undefined,
                              }}
                              onClick={() =>
                                isFocused && onClearFocusedCustomer
                                  ? onClearFocusedCustomer()
                                  : onFocusCustomer(p.id)
                              }
                            >
                              {isFocused ? "Focused" : "Focus"}
                            </button>
                          )}
                          <button
                            type="button"
                            style={{
                              ...styles.actionBtn,
                              padding: "4px 8px",
                              fontSize: "11px",
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                            onClick={() => onInspectPty(p.id)}
                          >
                            Inspect PTY
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Sub-Agent Proxy Conduits & Agency Concentration Section */}
      {showConduits && (
        <div style={styles.tableCard}>
          <div style={styles.tableHeader}>
            <h3 style={{ ...styles.tableTitle, color: "#f87171" }}>
              Identified Agency Proxy Conduits (Top Customer Concentration ≥ 80%)
            </h3>
            <span style={{ fontSize: "11px", color: "#64748b" }}>
              Click any conduit row to inspect handle trends & sub-conduits
            </span>
          </div>

          <div style={styles.tableScroll}>
            <table className="sd-rankings-table" style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Sub-Agent ID</th>
                  <th style={styles.th}>Master Forest</th>
                  <th style={styles.th}>30d Handle (USD)</th>
                  <th style={styles.th}>Tickets</th>
                  <th style={styles.th}>Top Customer</th>
                  <th style={styles.th}>Concentration (%)</th>
                  <th style={styles.th}>Risk Assessment & Countermeasure</th>
                </tr>
              </thead>
              <tbody>
                {conduits.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      data-rankings-empty="conduits"
                      style={{
                        ...styles.td,
                        textAlign: "center",
                        color: "#94a3b8",
                      }}
                    >
                      {rankingsStatus === "ready"
                        ? `GET ${RANKINGS_ENDPOINT} flagged no proxy conduits for this window.`
                        : rankingsStatus === "pending"
                          ? `Waiting for GET ${RANKINGS_ENDPOINT}…`
                          : `Unavailable — GET ${RANKINGS_ENDPOINT}: ${rankingsError ?? "no response"}`}
                    </td>
                  </tr>
                ) : filteredConduits.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      style={{
                        ...styles.td,
                        textAlign: "center",
                        color: "#94a3b8",
                      }}
                    >
                      No proxy conduits match the active Agent ID or search filter.
                    </td>
                  </tr>
                ) : null}
                {filteredConduits.map((c) => (
                  <tr
                    key={c.agentId}
                    className={onSelectAgent ? "sd-rankings-clickable-row" : undefined}
                    data-rankings-row-agent={c.agentId}
                    tabIndex={onSelectAgent ? 0 : undefined}
                    title={onSelectAgent ? `Click row to inspect agent ${c.agentId}` : undefined}
                    onClick={(e) => handleAgentRowClick(e, c.agentId)}
                    onKeyDown={(e) => handleAgentRowKeyDown(e, c.agentId)}
                  >
                    <td style={styles.td}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={{ fontWeight: 700, color: "#f59e0b" }}>
                          <a
                            href={getLocalAgentHref(c.agentId)}
                            onClick={(e) => {
                              if (onSelectAgent && !e.metaKey && !e.ctrlKey && e.button === 0) {
                                e.preventDefault()
                                onSelectAgent(c.agentId)
                              }
                            }}
                            style={{
                              color: "#f59e0b",
                              textDecoration: "none",
                            }}
                            title="Open SportsDesk Agent Inspector"
                          >
                            {c.agentId} ↗
                          </a>
                        </span>
                        <button
                          type="button"
                          data-conduit-filter-toggle={c.agentId}
                          onClick={() => toggleSelectedAgentId(c.agentId)}
                          style={{
                            ...styles.actionBtn,
                            padding: "2px 7px",
                            fontSize: "10px",
                            whiteSpace: "nowrap",
                            borderColor: effectiveAgentIdSet.has(c.agentId.toUpperCase())
                              ? "#38bdf8"
                              : undefined,
                            backgroundColor: effectiveAgentIdSet.has(c.agentId.toUpperCase())
                              ? "rgba(56, 189, 248, 0.16)"
                              : undefined,
                          }}
                        >
                          {effectiveAgentIdSet.has(c.agentId.toUpperCase()) ? "Filtered" : "Filter"}
                        </button>
                      </div>
                    </td>
                    <td style={styles.td}>
                      <span>{c.masterAgent}</span>
                    </td>
                    {(() => {
                      const cKey = c.agentId.trim().toUpperCase()
                      const cHeat =
                        conduitHeat.byKey.get(cKey) ??
                        evaluateHandleHeatCell(conduitHeat.scale, c.handleUsd)
                      return (
                        <td
                          className="sd-heat-cell"
                          data-heat-cell="true"
                          data-heat-bucket={cHeat.bucket}
                          tabIndex={0}
                          title={cHeat.summaryTitle}
                          style={{ ...styles.td, ...TABULAR_NUMS }}
                        >
                          <span style={{ fontWeight: 600 }}>${c.handleUsd.toLocaleString()}</span>
                          <HandleHeatTooltip
                            metrics={cHeat}
                            entityLabel={`Conduit ${c.agentId}`}
                            placement="right"
                          />
                        </td>
                      )
                    })()}
                    <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                      <span>{c.wagers.toLocaleString()}</span>
                    </td>
                    <td style={styles.td}>
                      <span style={{ fontWeight: 700, color: "#38bdf8" }}>
                        <a
                          href={getLocalCustomerHref(c.topCust)}
                          onClick={(e) => {
                            if (
                              onSelectCustomerById &&
                              !e.metaKey &&
                              !e.ctrlKey &&
                              e.button === 0
                            ) {
                              e.preventDefault()
                              onSelectCustomerById(c.topCust)
                            }
                          }}
                          style={{
                            color: "#38bdf8",
                            textDecoration: "none",
                          }}
                          title="Inspect Customer in SportsDesk Profiles"
                        >
                          {c.topCust}
                        </a>{" "}
                        <a
                          {...getFantasy402PortalLinkProps(c.topCust)}
                          style={{
                            color: "#64748b",
                            textDecoration: "none",
                            fontSize: "11px",
                          }}
                          title="Open in active Fantasy402 Manager session tab"
                        >
                          ↗
                        </a>
                      </span>
                    </td>
                    <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <div
                          style={{
                            width: "52px",
                            height: "6px",
                            borderRadius: "3px",
                            backgroundColor: "rgba(51, 65, 85, 0.7)",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.min(100, c.concPct)}%`,
                              height: "100%",
                              backgroundColor: c.concPct >= 95 ? "#ef4444" : "#f59e0b",
                            }}
                          />
                        </div>
                        <span
                          style={{
                            fontWeight: 700,
                            color: c.concPct >= 95 ? "#ef4444" : "#f59e0b",
                          }}
                        >
                          {c.concPct.toFixed(1)}%
                        </span>
                        <HandleTrendIndicator
                          deltaPct={c.handleDelta24hPct}
                          label={`${c.agentId} 24h conduit shift`}
                        />
                      </div>
                    </td>
                    <td style={styles.td}>
                      <div
                        style={{
                          color: "#ef4444",
                          fontWeight: 600,
                          fontSize: "12px",
                        }}
                      >
                        SINGLE BETTOR PROXY CONDUIT
                      </div>
                      <div style={styles.custSub}>
                        Cap sub-agent total exposure to prevent account rotation
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
