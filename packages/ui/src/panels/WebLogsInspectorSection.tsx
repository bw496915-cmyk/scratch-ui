import {
  WEBLOG_OPERATIONS,
  WEBLOG_SEVERITY_RULES,
  type ParsedParlayLeg,
  type WebLogClientSummary,
  type WebLogEvent,
  type WebLogEventKind,
} from "@sportsdesk-ops/contracts"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  Copy,
  Cpu,
  Download,
  Globe,
  Network,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  Terminal,
} from "lucide-react"
import { renderAnsiReact } from "../ansi.tsx"
import { getDevCsrfToken, trackedFetch } from "../api_usage.ts"
import { styles } from "../dashboard_styles.ts"
import { copyText } from "../clipboard.ts"
import { WebLogActionDictionary } from "./WebLogActionDictionary.tsx"
import { ParlayComparisonSection } from "./ParlayComparisonSection.tsx"

import {
  buildBitwiseLogIndex,
  LOG_SEVERITY_MASK_ALL,
  parseBitwiseSeverityQuery,
  severityLabelToBit,
  type BitwiseLogFilterStore,
  type BitwiseLogIndex,
} from "../system_log_bitwise_filter.ts"
import {
  buildSystemLogsJsonExportPayload,
  buildSystemLogsJsonFilename,
  downloadSystemLogsJsonBlob,
  formatSystemLogsJson,
  selectBitwiseFilteredRows,
} from "../system_logs_json_export.ts"
import { useBitwiseTableDomFilter } from "./SystemLogBitwiseSearchBar.tsx"
import { SkeletonBlock, SkeletonTableRows } from "./PanelSkeleton.tsx"

export type WebLogSortField =
  | "time"
  | "severity"
  | "ip"
  | "ipFamily"
  | "account"
  | "gameId"
  | "botKey"
  | "event"
  | "period"
  | "market"
  | "pick"
  | "kind"
  | "cadence"
  | "score"

export type WebLogSortDir = "asc" | "desc"

export interface ParsedBotKey {
  readonly rawKey: string
  readonly prefix: string
  readonly gameId: string
  readonly periodCode: string
  readonly periodLabel: string
  readonly marketCode: string
  readonly marketLabel: string
  readonly sideCode: string
  readonly sideLabel: string
  readonly seq: number
}

export interface WebLogIpMeta {
  readonly family: "IPv4" | "IPv6" | "Unknown"
  readonly ip: string
  readonly subnet24: string
  readonly classification: "PRIVATE" | "UNMEASURED"
  readonly asnLabel: string
}

export interface ParsedWebLogActionMeta {
  readonly ticketId?: string | null
  readonly gameId?: string | null
  readonly riskUsd?: number | null
  readonly winUsd?: number | null
  readonly limitUsd?: number | null
  readonly attemptedUsd?: number | null
  readonly channel?: "mobile" | "desktop" | null
  readonly selectionSummary?: string | null
}

export interface WebLogEntry {
  readonly id: string
  readonly dateLabel: string
  readonly timeEst: string
  readonly sourceTime: string | null
  readonly sourceSortMs: number
  readonly ip: string
  readonly ipMeta: WebLogIpMeta
  readonly rawAction: string
  readonly event: WebLogEvent
  readonly eventKind: WebLogEventKind
  readonly accountId: string
  readonly botKey: ParsedBotKey | null
  readonly selection: {
    readonly source: "bot-key" | "chosen-team" | "bet-description"
    readonly gameId: string | null
    readonly period: string | null
    readonly market: string | null
    readonly pick: string | null
    readonly listedNumber?: string
  } | null
  readonly parlayLegs?: readonly ParsedParlayLeg[]
  readonly ticketNumber: string | null

  readonly gameId?: string | null
  readonly ticketId?: string | null
  readonly actionMeta?: ParsedWebLogActionMeta | null
  readonly clientVersion: string | null
  readonly portalHost: string | null
  readonly deviceMarker: "M" | "D" | null
  readonly apiMarked: boolean
  readonly interArrivalSec: number | null
  readonly vectorScore: number
  readonly severity: "CRITICAL" | "HIGH" | "WATCH" | "NORMAL"
  readonly clusterLabel: string
  readonly source: "capture" | "ingested"
}

export interface WebLogVectorProfile {
  readonly vectorId: string
  readonly ip: string
  readonly subnet24: string
  readonly ipMeta: WebLogIpMeta
  readonly accountId: string
  readonly eventCount: number
  readonly blockCount: number
  readonly loginCount: number
  readonly tokenCount: number
  readonly uniqueGames: readonly string[]
  readonly uniqueBotKeys: readonly string[]
  readonly medianCadenceSec: number | null
  readonly minCadenceSec: number | null
  readonly axes: {
    readonly blockRatio: number
    readonly burstCadence: number
    readonly cadenceRegularity: number
    readonly gameConcentration: number
    readonly tokenChurn: number
    readonly marketSpread: number
  }
  readonly vector: readonly [number, number, number, number, number, number]
  readonly botScore: number
  readonly archetype: string
  readonly severity: "CRITICAL" | "HIGH" | "WATCH" | "NORMAL"
}

export interface WebLogCosinePair {
  readonly leftId: string
  readonly rightId: string
  readonly leftIp: string
  readonly rightIp: string
  readonly leftAccount: string
  readonly rightAccount: string
  readonly cosine: number
  readonly sharedGames: readonly string[]
  readonly verdict: string
}

export type WebLogSeverityFilter = "ALL" | "CRITICAL" | "HIGH" | "WATCH" | "NORMAL"

export interface WebLogSeverityCounts {
  readonly CRITICAL: number
  readonly HIGH: number
  readonly WATCH: number
  readonly NORMAL: number
}

export interface WebLogApiResponse {
  readonly source: "retained-mode-a" | "operator-import" | "mixed" | "unavailable"
  readonly entries: readonly WebLogEntry[]
  readonly page: { readonly offset: number; readonly nextOffset: number | null }
  readonly vectors: readonly WebLogVectorProfile[]
  readonly cosinePairs: readonly WebLogCosinePair[]
  readonly availableIps: readonly string[]
  readonly availableAccounts: readonly string[]
  readonly kinds: readonly { readonly kind: WebLogEventKind; readonly count: number }[]
  readonly clients: WebLogClientSummary
  readonly summary: {
    readonly totalEntries: number
    readonly filteredEntries: number
    readonly uniqueIps: number
    readonly uniqueSubnets: number
    readonly botBlockCount: number
    readonly loginEventCount: number
    readonly medianBotCadenceSec: number | null
    readonly peakBotScore: number
    readonly correlatedPairsCount: number
    readonly severityCounts?: WebLogSeverityCounts | undefined
  }
  readonly inspectAnsi: string
  readonly vectorInspectAnsi: string
  readonly tableInspectAnsi: string
  readonly optionsJsLiteral?: string
  readonly cliFlags?: string
  readonly generatedAt: string
}

export interface WebLogSnapshot {
  readonly entries: readonly WebLogEntry[]
  readonly loading: boolean
  readonly bitwiseIndex: BitwiseLogIndex
}

export interface WebLogsInspectorSectionProps {
  readonly onOpenTerminal?: () => void
  readonly onRunTerminalCommand?: (cmd: string) => void
  readonly severityFilter?: WebLogSeverityFilter | undefined
  readonly onSeverityFilterChange?: ((severity: WebLogSeverityFilter) => void) | undefined
  readonly onSeverityCountsChange?: ((counts: WebLogSeverityCounts) => void) | undefined
  readonly bitwiseFilterStore?: BitwiseLogFilterStore | undefined
  readonly exportFilteredRef?: React.MutableRefObject<(() => number) | null> | undefined
  readonly onWeblogSnapshot?: ((snapshot: WebLogSnapshot) => void) | undefined
  readonly refreshRef?: React.MutableRefObject<(() => void) | null> | undefined
}

const WEBLOG_PAGE_SIZE = 100
const WEBLOG_COLUMNS = [
  { field: "time", label: "Source time" },
  { field: "severity", label: "Rule severity" },
  { field: "account", label: "Login ID" },
  { field: "ipFamily", label: "IP family" },
  { field: "ip", label: "IP address" },
  { field: "event", label: "Event" },
  { field: "kind", label: "Kind" },
  { field: "gameId", label: "Game" },
  { field: "botKey", label: "Bot key" },
  { field: "period", label: "Period" },
  { field: "market", label: "Market" },
  { field: "pick", label: "Pick" },
  { field: "cadence", label: "Δt" },
  { field: "score", label: "Score" },
] as const satisfies readonly { field: WebLogSortField; label: string }[]
const WEBLOG_CELL_STYLE = { padding: "7px 8px", whiteSpace: "nowrap", color: "#cbd5e1" } as const

const SAMPLE_INGEST_SNIPPET = `November 19, 2026
08:25:12 AM\t198.51.100.42\tAPI LOG | BLOCK BET | BOT BLOCK LINE ST | #[{"key":"bot_619137349_0_L_U_0","val":"BB55103"}]
08:25:08 AM\t198.51.100.42\tAPI LOG | BLOCK BET | BOT BLOCK LINE ST | #[{"key":"bot_619137349_0_L_U_0","val":"BB55103"}]
08:25:04 AM\t198.51.100.42\tLogin successful [ v43.0.27 | www.fantasy402.com ]`

const SAMPLE_INGEST_LIST_JSON = JSON.stringify(
  {
    LIST: [
      {
        AccessDateTime: "2026-11-16 18:01:43.700",
        ClientCode: "www.example-book.ag",
        LoginID: "DEMO42",
        Operation: "Round Robin [ v1.0.287 | www.example-book.ag ]",
        Data: "Ticket : 1081067734 | ",
        IPAddress: "198.51.100.42",
      },
      {
        AccessDateTime: "2026-11-16 18:01:43.547",
        ClientCode: "www.example-book.ag",
        LoginID: "DEMO42",
        Operation: "API LOG | ROUND ROBIN | Ticket: 1081067734",
        Data: "Selections : Football #285 Chargers +4½ -110 | Risk : 150 Win : 3000",
        IPAddress: "198.51.100.42",
      },
    ],
    INFO: "",
  },
  null,
  2,
)

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

function severityColors(severity: WebLogVectorProfile["severity"]): {
  fg: string
  bg: string
  borderColor: string
} {
  if (severity === "CRITICAL") {
    return {
      fg: "#fca5a5",
      bg: "rgba(239, 68, 68, 0.16)",
      borderColor: "rgba(239, 68, 68, 0.45)",
    }
  }
  if (severity === "HIGH") {
    return {
      fg: "#fcd34d",
      bg: "rgba(245, 158, 11, 0.16)",
      borderColor: "rgba(245, 158, 11, 0.45)",
    }
  }
  if (severity === "WATCH") {
    return {
      fg: "#7dd3fc",
      bg: "rgba(56, 189, 248, 0.14)",
      borderColor: "rgba(56, 189, 248, 0.4)",
    }
  }
  return {
    fg: "#86efac",
    bg: "rgba(34, 197, 94, 0.14)",
    borderColor: "rgba(34, 197, 94, 0.4)",
  }
}

function eventKindTone(kind: WebLogEntry["eventKind"]): {
  fg: string
  bg: string
  borderColor: string
} {
  switch (kind) {
    case "BOT_BLOCK_LINE_ST":
      return {
        fg: "#fca5a5",
        bg: "rgba(239, 68, 68, 0.16)",
        borderColor: "rgba(239, 68, 68, 0.42)",
      }
    case "LOGIN_TOKEN":
      return {
        fg: "#fcd34d",
        bg: "rgba(245, 158, 11, 0.14)",
        borderColor: "rgba(245, 158, 11, 0.38)",
      }
    case "LOGIN_SUCCESS":
      return {
        fg: "#86efac",
        bg: "rgba(34, 197, 94, 0.14)",
        borderColor: "rgba(34, 197, 94, 0.38)",
      }
    case "API_BLOCK_BET":
      return {
        fg: "#fdba74",
        bg: "rgba(249, 115, 22, 0.14)",
        borderColor: "rgba(249, 115, 22, 0.38)",
      }
    case "WAGER_LIMIT":
      return {
        fg: "#fda4af",
        bg: "rgba(244, 63, 94, 0.16)",
        borderColor: "rgba(244, 63, 94, 0.42)",
      }
    case "API_ROUND_ROBIN":
      return {
        fg: "#7dd3fc",
        bg: "rgba(56, 189, 248, 0.14)",
        borderColor: "rgba(56, 189, 248, 0.38)",
      }
    case "API_PARLAY":
      return {
        fg: "#d8b4fe",
        bg: "rgba(168, 85, 247, 0.14)",
        borderColor: "rgba(168, 85, 247, 0.38)",
      }
    case "LINES_DISPLAYED":
      return {
        fg: "#93c5fd",
        bg: "rgba(59, 130, 246, 0.12)",
        borderColor: "rgba(59, 130, 246, 0.34)",
      }
    case "RATE_LIMIT":
      return {
        fg: "#fcd34d",
        bg: "rgba(245, 158, 11, 0.14)",
        borderColor: "rgba(245, 158, 11, 0.38)",
      }
    default:
      return {
        fg: "#cbd5e1",
        bg: "rgba(148, 163, 184, 0.14)",
        borderColor: "rgba(148, 163, 184, 0.35)",
      }
  }
}

export function WebLogsInspectorSection({
  onOpenTerminal,
  onRunTerminalCommand,
  severityFilter: controlledSeverityFilter,
  onSeverityFilterChange,
  onSeverityCountsChange,
  bitwiseFilterStore,
  exportFilteredRef,
  onWeblogSnapshot,
  refreshRef,
}: WebLogsInspectorSectionProps): React.ReactElement {
  const [data, setData] = useState<WebLogApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const weblogTbodyRef = useRef<HTMLTableSectionElement | null>(null)

  // Sorting & filtering state
  const [sortField, setSortField] = useState<WebLogSortField>("time")
  const [sortDir, setSortDir] = useState<WebLogSortDir>("desc")
  const [ipFilter, setIpFilter] = useState<string>("ALL")
  const [ipFamily, setIpFamily] = useState("all")
  const requestRef = useRef<AbortController | null>(null)
  const [kindFilter, setKindFilter] = useState<string>("ALL")
  const [clientFilter, setClientFilter] = useState<{ site: string; version: string } | null>(null)
  const [marketFilter, setMarketFilter] = useState<string>("ALL")
  const [internalSeverityFilter, setInternalSeverityFilter] = useState<WebLogSeverityFilter>("ALL")
  const [searchQuery, setSearchQuery] = useState<string>("")

  const severityFilter = controlledSeverityFilter ?? internalSeverityFilter
  const setSeverityFilter = useCallback(
    (next: WebLogSeverityFilter) => {
      if (onSeverityFilterChange) {
        onSeverityFilterChange(next)
      } else {
        setInternalSeverityFilter(next)
      }
    },
    [onSeverityFilterChange],
  )

  // Bun.inspect.custom preview state
  const [inspectMode, setInspectMode] = useState<"weblog" | "vector" | "table" | "json">("weblog")
  const [inspectColors, setInspectColors] = useState(true)
  const [inspectCompact, setInspectCompact] = useState(false)
  const [inspectSorted, setInspectSorted] = useState(false)
  const [inspectShowHidden, setInspectShowHidden] = useState(false)
  const [inspectNumericSeparator, setInspectNumericSeparator] = useState(false)
  const [inspectGetters, setInspectGetters] = useState(false)
  const [inspectShowOptions, setInspectShowOptions] = useState(false)
  const [inspectDepth, setInspectDepth] = useState<0 | 1 | 2 | 3 | 4>(2)
  const [inspectMaxArrayLength, setInspectMaxArrayLength] = useState<number>(10)
  const [inspectMaxStringLength, setInspectMaxStringLength] = useState(42)
  const [inspectBreakLength, setInspectBreakLength] = useState<number>(96)
  const [copiedInspect, setCopiedInspect] = useState<
    false | "plain" | "ansi" | "options" | "failed"
  >(false)

  // Row detail expansion & raw ingest drawer
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null)
  const [showIngest, setShowIngest] = useState(false)
  const [rawIngestText, setRawIngestText] = useState("")
  const [ingestNotice, setIngestNotice] = useState<string | null>(null)

  const fetchWebLogs = useCallback(
    async (offset = 0) => {
      requestRef.current?.abort()
      const request = new AbortController()
      requestRef.current = request
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({
          sort: sortField,
          dir: sortDir,
          offset: String(offset),
          limit: String(WEBLOG_PAGE_SIZE),
          colors: String(inspectColors),
          compact: String(inspectCompact),
          sorted: String(inspectSorted),
          depth: String(inspectDepth),
          showHidden: String(inspectShowHidden),
          numericSeparator: String(inspectNumericSeparator),
          getters: String(inspectGetters),
          maxArrayLength: String(inspectMaxArrayLength),
          maxStringLength: String(inspectMaxStringLength),
          breakLength: String(inspectBreakLength),
          options: String(inspectShowOptions),
        })
        if (ipFilter !== "ALL") params.set("ip", ipFilter)
        if (ipFamily !== "all") params.set("ipFamily", ipFamily)
        if (kindFilter !== "ALL") params.set("kind", kindFilter)
        if (clientFilter) {
          params.set("site", clientFilter.site)
          params.set("version", clientFilter.version)
        }
        if (marketFilter !== "ALL") params.set("market", marketFilter)
        if (severityFilter !== "ALL") params.set("severity", severityFilter)
        if (searchQuery.trim()) params.set("q", searchQuery.trim())

        const res = await trackedFetch(`/api/weblogs?${params.toString()}`, {
          cache: "no-store",
          signal: request.signal,
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const json = (await res.json()) as WebLogApiResponse
        if (request.signal.aborted) return
        setExpandedRowId(null)
        setData(json)
        if (json.summary.severityCounts && onSeverityCountsChange) {
          onSeverityCountsChange(json.summary.severityCounts)
        }
      } catch (err) {
        if (!request.signal.aborted) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (requestRef.current === request) setLoading(false)
      }
    },
    [
      sortField,
      sortDir,
      ipFilter,
      ipFamily,
      kindFilter,
      clientFilter,
      marketFilter,
      severityFilter,
      searchQuery,
      inspectColors,
      inspectCompact,
      inspectSorted,
      inspectDepth,
      inspectShowHidden,
      inspectNumericSeparator,
      inspectGetters,
      inspectMaxArrayLength,
      inspectMaxStringLength,
      inspectBreakLength,
      inspectShowOptions,
      onSeverityCountsChange,
    ],
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchWebLogs()
    }, 80)
    return () => {
      clearTimeout(timer)
      requestRef.current?.abort()
    }
  }, [fetchWebLogs])

  const handleSortClick = (field: WebLogSortField) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"))
    } else {
      setSortField(field)
      setSortDir(field === "cadence" ? "asc" : "desc")
    }
  }

  const getCsrfHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (typeof document !== "undefined") {
      const match = document.cookie.match(/(?:^|;\s*)sd_csrf=([^;]+)/)
      if (match?.[1]) {
        headers["x-csrf-token"] = decodeURIComponent(match[1])
        return headers
      }
    }
    const devCsrf = getDevCsrfToken()
    if (devCsrf) {
      headers["x-csrf-token"] = devCsrf
    }
    return headers
  }

  const handleIngest = async () => {
    setIngestNotice(null)
    try {
      const res = await trackedFetch("/api/weblogs/ingest", {
        method: "POST",
        credentials: "include",
        headers: getCsrfHeaders(),
        body: JSON.stringify({ rawText: rawIngestText }),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(errBody.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as { ingestedCount: number }
      setIngestNotice(`Parsed & vectorized ${json.ingestedCount} new Fantasy402 weblog line(s).`)
      await fetchWebLogs()
    } catch (err) {
      setIngestNotice(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleReset = async () => {
    setIngestNotice(null)
    try {
      const res = await trackedFetch("/api/weblogs/reset", {
        method: "POST",
        credentials: "include",
        headers: getCsrfHeaders(),
      })
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(errBody.error ?? `HTTP ${res.status}`)
      }
      setIpFilter("ALL")
      setIpFamily("all")
      setKindFilter("ALL")
      setClientFilter(null)
      setMarketFilter("ALL")
      setSearchQuery("")
      bitwiseFilterStore?.reset()
      setSortField("time")
      setSortDir("desc")
      await fetchWebLogs()
    } catch (err) {
      setIngestNotice(`Reset failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const page = data?.page
  const pageRange =
    data && page && data.entries.length > 0
      ? `${page.offset + 1}–${page.offset + data.entries.length} of ${data.summary.filteredEntries.toLocaleString()}`
      : "No matching rows"

  // Pre-indexed SoA severity bitmask + haystack table rebuilt only when entries change.
  const weblogBitwiseIndex = useMemo(() => {
    const entries = data?.entries ?? []
    return buildBitwiseLogIndex(
      entries,
      (row) => severityLabelToBit(row.severity),
      (row) =>
        `${row.severity} ${row.dateLabel} ${row.timeEst} ${row.sourceTime ?? ""} ${row.accountId} ${row.ip} ${row.ipMeta.classification} ${row.ipMeta.asnLabel} ${row.event} ${row.eventKind} ${row.portalHost ?? ""} ${row.clientVersion ?? ""} ${row.ticketId ?? ""} ${row.ticketNumber ?? ""} ${row.gameId ?? ""} ${row.botKey ? `${row.botKey.rawKey} ${row.botKey.gameId} ${row.botKey.marketLabel} ${row.botKey.periodLabel} ${row.botKey.sideLabel}` : ""} ${row.selection ? `${row.selection.period ?? ""} ${row.selection.market ?? ""} ${row.selection.pick ?? ""} ${row.selection.listedNumber ?? ""}` : ""} ${row.actionMeta?.selectionSummary ?? ""} ${row.parlayLegs ? row.parlayLegs.map((leg) => `${leg.sport ?? ""} ${leg.period ?? ""} ${leg.market ?? ""} ${leg.selection ?? ""}`).join(" ") : ""} ${row.clusterLabel} ${row.rawAction}`,
    )
  }, [data?.entries])

  useBitwiseTableDomFilter({
    tbodyRef: weblogTbodyRef,
    index: weblogBitwiseIndex,
    store: bitwiseFilterStore,
    revision: expandedRowId,
  })

  const exportFilteredWeblogsJson = useCallback((): number => {
    const entries = data?.entries ?? []
    const parsedQuery =
      bitwiseFilterStore?.getSnapshot().parsed ??
      parseBitwiseSeverityQuery("", LOG_SEVERITY_MASK_ALL)
    const filtered = selectBitwiseFilteredRows(entries, weblogBitwiseIndex, parsedQuery)
    if (filtered.length === 0) return 0

    const payload = buildSystemLogsJsonExportPayload({
      mode: "weblogs",
      entries: filtered,
      totalRows: entries.length,
      parsedQuery,
      weblogFilters: {
        severityFilter,
        ipFilter,
        ipFamily,
        kindFilter,
        marketFilter,
        searchQuery,
        clientFilter,
        sortField,
        sortDir,
      },
    })
    const filename = buildSystemLogsJsonFilename({
      mode: "weblogs",
      effectiveMask: parsedQuery.effectiveMask,
      severityFilter,
      ipFilter,
      kindFilter,
      marketFilter,
      query: parsedQuery.rawQuery || searchQuery,
    })
    const ok = downloadSystemLogsJsonBlob(formatSystemLogsJson(payload), filename)
    return ok ? filtered.length : 0
  }, [
    data?.entries,
    bitwiseFilterStore,
    weblogBitwiseIndex,
    severityFilter,
    ipFilter,
    ipFamily,
    kindFilter,
    marketFilter,
    searchQuery,
    clientFilter,
    sortField,
    sortDir,
  ])

  useEffect(() => {
    if (!exportFilteredRef) return
    exportFilteredRef.current = exportFilteredWeblogsJson
    return () => {
      if (exportFilteredRef.current === exportFilteredWeblogsJson) {
        exportFilteredRef.current = null
      }
    }
  }, [exportFilteredRef, exportFilteredWeblogsJson])

  useEffect(() => {
    if (!refreshRef) return
    const triggerRefresh = () => {
      void fetchWebLogs(data?.page.offset ?? 0)
    }
    refreshRef.current = triggerRefresh
    return () => {
      if (refreshRef.current === triggerRefresh) {
        refreshRef.current = null
      }
    }
  }, [refreshRef, fetchWebLogs, data?.page.offset])

  useEffect(() => {
    onWeblogSnapshot?.({
      entries: data?.entries ?? [],
      loading,
      bitwiseIndex: weblogBitwiseIndex,
    })
  }, [onWeblogSnapshot, data?.entries, loading, weblogBitwiseIndex])

  const activeAnsi =
    inspectMode === "weblog"
      ? (data?.inspectAnsi ?? "")
      : inspectMode === "vector"
        ? (data?.vectorInspectAnsi ?? "")
        : inspectMode === "table"
          ? (data?.tableInspectAnsi ?? "")
          : data
            ? JSON.stringify(data.entries.slice(0, inspectMaxArrayLength), null, 2)
            : ""

  const cliCommand = useMemo(() => {
    const base =
      inspectMode === "vector"
        ? "weblog-vectors"
        : inspectMode === "table"
          ? "weblogs --table"
          : inspectMode === "json"
            ? "weblogs --json"
            : "weblogs"
    const parts: string[] = [base]
    if (inspectMode !== "vector") {
      if (sortField !== "time") parts.push(`--sort=${sortField}`)
      if (sortDir === "asc") parts.push("--asc")
      if (ipFilter !== "ALL") parts.push(`--ip=${ipFilter}`)
      if (ipFamily !== "all") parts.push(`--ip-family=${ipFamily}`)
      if (kindFilter !== "ALL") parts.push(`--kind=${kindFilter}`)
      if (clientFilter)
        parts.push(`--site=${clientFilter.site}`, `--version=${clientFilter.version}`)
      if (marketFilter !== "ALL") parts.push(`--market=${marketFilter}`)
      if (severityFilter !== "ALL") parts.push(`--severity=${severityFilter}`)
      if (searchQuery.trim()) parts.push(`--q=${searchQuery.trim()}`)
    }
    const flags = (data?.cliFlags ?? "").trim()
    if (flags) parts.push(flags)
    if (inspectShowOptions && !/(?:^|\s)--options(?:$|\s|=)/.test(flags)) {
      parts.push("--options")
    }
    return parts.join(" ")
  }, [
    inspectMode,
    sortField,
    sortDir,
    ipFilter,
    ipFamily,
    kindFilter,
    clientFilter,
    marketFilter,
    searchQuery,
    severityFilter,
    data?.cliFlags,
    inspectShowOptions,
  ])

  const handleCopyInspect = async (mode: "plain" | "ansi" | "options" = "plain") => {
    const text =
      mode === "options"
        ? cliCommand
        : mode === "ansi"
          ? activeAnsi
          : activeAnsi.replace(/\x1b\[[0-9;]*m/g, "")
    if (!text) return
    const result = await copyText(text)
    setCopiedInspect(result.ok ? mode : "failed")
    setTimeout(() => setCopiedInspect(false), 1500)
  }

  const handleDownloadInspect = () => {
    if (!activeAnsi) return
    const plain = activeAnsi.replace(/\x1b\[[0-9;]*m/g, "")
    const isJson = inspectMode === "json"
    const blob = new Blob([plain], {
      type: isJson ? "application/json" : "text/plain;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = isJson
      ? "fantasy402-weblogs-parsed.json"
      : `fantasy402-${inspectMode}-d${inspectDepth}.txt`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const inspectStats = useMemo(() => {
    if (!activeAnsi) return { lines: 0, bytes: 0, plainChars: 0 }
    const plain = activeAnsi.replace(/\x1b\[[0-9;]*m/g, "")
    return {
      lines: activeAnsi.split("\n").length,
      bytes: new TextEncoder().encode(activeAnsi).length,
      plainChars: plain.length,
    }
  }, [activeAnsi])

  const inspectInvocation = useMemo(() => {
    const opts =
      data?.optionsJsLiteral ??
      `{ colors: ${inspectColors}, compact: ${inspectCompact}, depth: ${inspectDepth}, sorted: ${inspectSorted}, showHidden: ${inspectShowHidden}, numericSeparator: ${inspectNumericSeparator}, getters: ${inspectGetters}, maxArrayLength: ${inspectMaxArrayLength}, maxStringLength: ${inspectMaxStringLength}, breakLength: ${inspectBreakLength} }`
    if (inspectMode === "weblog") {
      return `inspectDeskValue(new WebLogView(entries, metadata), ${opts})`
    }
    if (inspectMode === "vector") {
      return `inspectDeskValue(new WebLogVectorView(vectors), ${opts})`
    }
    if (inspectMode === "json")
      return `JSON.stringify(entries.slice(0, ${inspectMaxArrayLength}), null, 2)`
    return `Bun.inspect.table(entries, columns, ${opts})`
  }, [
    data?.optionsJsLiteral,
    inspectMode,
    inspectColors,
    inspectCompact,
    inspectSorted,
    inspectDepth,
    inspectShowHidden,
    inspectNumericSeparator,
    inspectGetters,
    inspectMaxArrayLength,
    inspectMaxStringLength,
    inspectBreakLength,
  ])

  const sortIcon = (field: WebLogSortField) => {
    if (sortField !== field) {
      return (
        <ChevronsUpDown
          size={12}
          style={{ marginLeft: "4px", opacity: 0.42, flexShrink: 0 }}
          aria-hidden="true"
        />
      )
    }
    return sortDir === "asc" ? (
      <ChevronUp
        size={13}
        strokeWidth={2.5}
        style={{ marginLeft: "4px", color: "#38bdf8", flexShrink: 0 }}
        aria-hidden="true"
      />
    ) : (
      <ChevronDown
        size={13}
        strokeWidth={2.5}
        style={{ marginLeft: "4px", color: "#38bdf8", flexShrink: 0 }}
        aria-hidden="true"
      />
    )
  }

  const axisMeta = [
    { key: "blockRatio", label: "Block Ratio", color: "#f87171" },
    { key: "burstCadence", label: "Burst Cadence", color: "#fbbf24" },
    { key: "cadenceRegularity", label: "Regularity", color: "#38bdf8" },
    { key: "gameConcentration", label: "Game Focus", color: "#c084fc" },
    { key: "tokenChurn", label: "Token Churn", color: "#fb923c" },
    { key: "marketSpread", label: "Market Spread", color: "#4ade80" },
  ] as const

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* KPI Telemetry Strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))",
          gap: "10px",
        }}
      >
        {[
          {
            label: "Parsed Weblogs",
            value:
              data && data.source !== "unavailable"
                ? `${data.summary.filteredEntries} / ${data.summary.totalEntries}`
                : "—",
            sub:
              data && data.source !== "unavailable"
                ? `${data.summary.botBlockCount} BOT_BLOCK · ${data.summary.loginEventCount} logins`
                : "Access capture unavailable",
            accent: "#38bdf8",
          },
          {
            label: "Tracked IPs & Subnets",
            value: data && data.source !== "unavailable" ? `${data.summary.uniqueIps} IPs` : "—",
            sub:
              data && data.source !== "unavailable"
                ? `${data.summary.uniqueSubnets} distinct redacted prefixes`
                : "—",
            accent: "#818cf8",
          },
          {
            label: "Median Bot Cadence (Δt)",
            value:
              data?.summary.medianBotCadenceSec !== null &&
              data?.summary.medianBotCadenceSec !== undefined
                ? `${data.summary.medianBotCadenceSec}s`
                : "—",
            sub: "Observed time between blocked requests",
            accent: (data?.summary.medianBotCadenceSec ?? 99) <= 6 ? "#f87171" : "#4ade80",
          },
          {
            label: "Peak Access Rule Score",
            value: data?.vectors.length ? `${data.summary.peakBotScore} / 100` : "—",
            sub: data?.vectors[0]
              ? `${data.vectors[0].ip} (${data.vectors[0].accountId})`
              : "No active vector",
            accent: (data?.summary.peakBotScore ?? 0) >= 78 ? "#f87171" : "#fbbf24",
          },
          {
            label: "Correlated Vector Pairs",
            value:
              data && data.source !== "unavailable"
                ? String(data.summary.correlatedPairsCount)
                : "—",
            sub: "Cosine similarity ≥ 0.85 among up to 64 blocked-request groups",
            accent: "#c084fc",
          },
        ].map((kpi) => (
          <div
            key={kpi.label}
            style={{
              backgroundColor: "#0d1527",
              borderTopWidth: "1px",
              borderRightWidth: "1px",
              borderBottomWidth: "1px",
              borderLeftWidth: "3px",
              borderTopStyle: "solid",
              borderRightStyle: "solid",
              borderBottomStyle: "solid",
              borderLeftStyle: "solid",
              borderTopColor: "#1e293b",
              borderRightColor: "#1e293b",
              borderBottomColor: "#1e293b",
              borderLeftColor: kpi.accent,
              borderRadius: "8px",
              padding: "10px 12px",
            }}
          >
            <div
              style={{
                fontSize: "10px",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: "#94a3b8",
                fontWeight: 600,
              }}
            >
              {kpi.label}
            </div>
            <div
              style={{
                fontSize: "18px",
                fontWeight: 700,
                color: "#f8fafc",
                marginTop: "3px",
                fontFamily: MONO_FONT,
              }}
            >
              {loading && !data ? (
                <SkeletonBlock width="62%" height={20} tone="accent" />
              ) : (
                kpi.value
              )}
            </div>
            <div style={{ fontSize: "11px", color: "#64748b", marginTop: "2px" }}>
              {loading && !data ? <SkeletonBlock width="78%" height={11} tone="subtle" /> : kpi.sub}
            </div>
          </div>
        ))}
      </div>

      {/* Behavioral Vectoring & Cosine Similarity Clustering */}
      <div
        style={{
          backgroundColor: "#0b1220",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "#1e293b",
          borderRadius: "8px",
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Cpu size={16} style={{ color: "#38bdf8" }} />
            <span style={{ fontSize: "13px", fontWeight: 700, color: "#f8fafc" }}>
              IP × Account Behavioral Vectoring (6-Axis Feature Embeddings &amp; Cosine Clusters)
            </span>
          </div>
          <span
            style={{
              fontSize: "11px",
              color: "#94a3b8",
              fontFamily: MONO_FONT,
            }}
          >
            Click any vector card to filter weblogs by IP
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))",
            gap: "10px",
          }}
        >
          {(data?.vectors ?? []).map((vp) => {
            const sev = severityColors(vp.severity)
            const isSelected = ipFilter === vp.ip
            return (
              <button
                key={vp.vectorId}
                type="button"
                onClick={() => setIpFilter((curr) => (curr === vp.ip ? "ALL" : vp.ip))}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  backgroundColor: isSelected ? "rgba(56, 189, 248, 0.10)" : "#0d1527",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: isSelected ? "#38bdf8" : "#1e293b",
                  borderRadius: "8px",
                  padding: "12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    gap: "8px",
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        fontFamily: MONO_FONT,
                        fontSize: "13px",
                        fontWeight: 700,
                        color: "#38bdf8",
                      }}
                    >
                      <Globe size={13} />
                      {vp.ip}
                      <span
                        style={{
                          fontSize: "11px",
                          color: "#f8fafc",
                          backgroundColor: "#1e293b",
                          padding: "1px 6px",
                          borderRadius: "4px",
                        }}
                      >
                        {vp.accountId}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: "#94a3b8",
                        marginTop: "2px",
                      }}
                    >
                      {vp.subnet24} · {vp.ipMeta.asnLabel}
                    </div>
                  </div>
                  <div
                    style={{
                      padding: "3px 7px",
                      borderRadius: "5px",
                      fontSize: "11px",
                      fontWeight: 700,
                      fontFamily: MONO_FONT,
                      color: sev.fg,
                      backgroundColor: sev.bg,
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: sev.borderColor,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {vp.severity} {vp.botScore}
                  </div>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: "11px",
                    color: "#cbd5e1",
                  }}
                >
                  <span>
                    Activity: <strong style={{ color: "#f8fafc" }}>{vp.archetype}</strong>
                  </span>
                </div>

                {/* 6-Axis Vector Dimension Bars */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                    gap: "5px 10px",
                  }}
                >
                  {axisMeta.map((axis) => {
                    const val = vp.axes[axis.key]
                    return (
                      <div
                        key={axis.key}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "2px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            fontSize: "10px",
                            color: "#94a3b8",
                          }}
                        >
                          <span>{axis.label}</span>
                          <span style={{ fontFamily: MONO_FONT, color: "#e2e8f0" }}>
                            {val.toFixed(2)}
                          </span>
                        </div>
                        <div
                          style={{
                            height: "5px",
                            backgroundColor: "#1e293b",
                            borderRadius: "3px",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.round(val * 100)}%`,
                              height: "100%",
                              backgroundColor: axis.color,
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    fontSize: "10px",
                    color: "#64748b",
                    fontFamily: MONO_FONT,
                    borderTopWidth: "1px",
                    borderTopStyle: "solid",
                    borderTopColor: "rgba(30,41,59,0.8)",
                    paddingTop: "6px",
                  }}
                >
                  <span>vec=[{vp.vector.map((n) => n.toFixed(2)).join(", ")}]</span>
                  <span>
                    Δt=
                    {vp.medianCadenceSec !== null ? `${vp.medianCadenceSec}s` : "—"} ·{" "}
                    {vp.blockCount}/{vp.eventCount} blk
                  </span>
                </div>
              </button>
            )
          })}
        </div>

        {/* Pairwise Cosine Similarity Clusters */}
        {(data?.cosinePairs ?? []).length > 0 && (
          <div
            style={{
              backgroundColor: "#070b14",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#1e293b",
              borderRadius: "6px",
              padding: "10px 12px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "11px",
                fontWeight: 700,
                color: "#cbd5e1",
                marginBottom: "8px",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              <Network size={13} style={{ color: "#c084fc" }} />
              Pairwise IP Vector Cosine Similarity Matrix
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {(data?.cosinePairs ?? []).slice(0, 4).map((pair) => {
                const hot = pair.cosine >= 0.85
                return (
                  <div
                    key={`${pair.leftId}::${pair.rightId}`}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "8px",
                      fontSize: "11px",
                      fontFamily: MONO_FONT,
                      padding: "6px 8px",
                      borderRadius: "5px",
                      backgroundColor: hot ? "rgba(239, 68, 68, 0.08)" : "rgba(30, 41, 59, 0.4)",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: hot ? "rgba(239, 68, 68, 0.32)" : "rgba(30, 41, 59, 0.8)",
                    }}
                  >
                    <span style={{ color: "#e2e8f0" }}>
                      <strong style={{ color: "#38bdf8" }}>{pair.leftIp}</strong> (
                      {pair.leftAccount}){" ↔ "}
                      <strong style={{ color: "#38bdf8" }}>{pair.rightIp}</strong> (
                      {pair.rightAccount})
                    </span>
                    <span style={{ color: "#94a3b8" }}>
                      {pair.verdict}
                      {pair.sharedGames.length > 0
                        ? ` · Shared Games: ${pair.sharedGames.join(", ")}`
                        : ""}
                    </span>
                    <span
                      style={{
                        fontWeight: 700,
                        color: hot ? "#fca5a5" : "#94a3b8",
                      }}
                    >
                      cos = {pair.cosine.toFixed(3)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Filter, Sort & Raw Weblog Ingest Controls */}
      <div
        style={{
          backgroundColor: "#0d1527",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "#1e293b",
          borderRadius: "8px",
          padding: "12px 14px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "10px",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <span style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 600 }}>IP:</span>
            {["ALL", ...(data?.availableIps ?? [])].map((ip) => (
              <button
                key={ip}
                type="button"
                onClick={() => setIpFilter(ip)}
                style={{
                  padding: "4px 8px",
                  borderRadius: "5px",
                  fontSize: "11px",
                  fontWeight: 600,
                  fontFamily: MONO_FONT,
                  cursor: "pointer",
                  backgroundColor: ipFilter === ip ? "rgba(56, 189, 248, 0.16)" : "#070b14",
                  color: ipFilter === ip ? "#7dd3fc" : "#94a3b8",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: ipFilter === ip ? "#38bdf8" : "#1e293b",
                }}
              >
                {ip}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => setShowIngest((v) => !v)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 10px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                backgroundColor: showIngest ? "rgba(56, 189, 248, 0.18)" : "#1e293b",
                color: showIngest ? "#7dd3fc" : "#e2e8f0",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: showIngest ? "#38bdf8" : "#334155",
              }}
            >
              <PlusCircle size={12} />
              Ingest Raw Weblog
            </button>
            <button
              type="button"
              onClick={() => void handleReset()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 10px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                backgroundColor: "#1e293b",
                color: "#cbd5e1",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
              }}
            >
              <RotateCcw size={12} />
              Clear imports
            </button>
            <button
              type="button"
              onClick={() => void fetchWebLogs()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 10px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                backgroundColor: "#1e293b",
                color: "#cbd5e1",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
              }}
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: "6px",
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <label
              style={{
                display: "inline-flex",
                gap: "6px",
                alignItems: "center",
                fontSize: "11px",
                color: "#94a3b8",
              }}
            >
              Kind
              <select
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value)}
                style={{
                  background: "#070b14",
                  color: "#cbd5e1",
                  border: "1px solid #334155",
                  borderRadius: "5px",
                  padding: "4px 6px",
                }}
              >
                <option value="ALL">All operations</option>
                {[...(data?.kinds ?? [])]
                  .sort((a, b) =>
                    WEBLOG_OPERATIONS[a.kind].label.localeCompare(WEBLOG_OPERATIONS[b.kind].label),
                  )
                  .map(({ kind, count }) => (
                    <option key={kind} value={kind}>
                      {WEBLOG_OPERATIONS[kind].label} ({count.toLocaleString()})
                    </option>
                  ))}
              </select>
            </label>

            <span
              style={{
                fontSize: "11px",
                color: "#94a3b8",
                fontWeight: 600,
                marginLeft: "6px",
              }}
            >
              Market:
            </span>
            {[
              { id: "ALL", label: "ALL" },
              { id: "S", label: "Spread (S)" },
              { id: "L", label: "Total (L)" },
              { id: "M", label: "ML (M)" },
            ].map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMarketFilter(m.id)}
                style={{
                  padding: "4px 8px",
                  borderRadius: "5px",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  backgroundColor: marketFilter === m.id ? "rgba(245, 158, 11, 0.16)" : "#070b14",
                  color: marketFilter === m.id ? "#fcd34d" : "#94a3b8",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: marketFilter === m.id ? "#f59e0b" : "#1e293b",
                }}
              >
                {m.label}
              </button>
            ))}
            <span
              style={{
                fontSize: "11px",
                color: "#94a3b8",
                fontWeight: 600,
                marginLeft: "6px",
              }}
            >
              Status:
            </span>
            {(
              [
                {
                  id: "ALL",
                  label: "ALL",
                  fg: "#e2e8f0",
                  bg: "rgba(148, 163, 184, 0.16)",
                  border: "#64748b",
                },
                {
                  id: "CRITICAL",
                  label: "CRIT",
                  fg: "#fca5a5",
                  bg: "rgba(239, 68, 68, 0.18)",
                  border: "#ef4444",
                },
                {
                  id: "HIGH",
                  label: "HIGH",
                  fg: "#fcd34d",
                  bg: "rgba(245, 158, 11, 0.18)",
                  border: "#f59e0b",
                },
                {
                  id: "WATCH",
                  label: "WATCH",
                  fg: "#7dd3fc",
                  bg: "rgba(56, 189, 248, 0.18)",
                  border: "#38bdf8",
                },
                {
                  id: "NORMAL",
                  label: "NORM",
                  fg: "#86efac",
                  bg: "rgba(34, 197, 94, 0.18)",
                  border: "#22c55e",
                },
              ] as const
            ).map((s) => {
              const active = severityFilter === s.id
              const sevCounts = data?.summary.severityCounts
              const count = s.id === "ALL" ? data?.summary.totalEntries : sevCounts?.[s.id]
              return (
                <button
                  key={s.id}
                  type="button"
                  data-weblog-status-filter={s.id}
                  aria-pressed={active}
                  onClick={() => setSeverityFilter(s.id)}
                  style={{
                    padding: "4px 8px",
                    borderRadius: "5px",
                    fontSize: "11px",
                    fontWeight: 600,
                    fontFamily: MONO_FONT,
                    fontVariantNumeric: "tabular-nums",
                    cursor: "pointer",
                    backgroundColor: active ? s.bg : "#070b14",
                    color: active ? s.fg : "#94a3b8",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: active ? s.border : "#1e293b",
                  }}
                >
                  {s.label}
                  {typeof count === "number" ? ` (${count})` : ""}
                </button>
              )
            })}
          </div>

          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search login, site, version, game, ticket, or operation…"
            style={{
              ...styles.input,
              minWidth: "260px",
              fontSize: "12px",
            }}
          />
        </div>

        {/* Collapsible Raw Fantasy402 Weblog Ingest Drawer */}
        {showIngest && (
          <div
            style={{
              backgroundColor: "#070b14",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              borderRadius: "6px",
              padding: "10px 12px",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              <div style={{ fontSize: "11px", color: "#cbd5e1", fontWeight: 600 }}>
                Paste Fantasy402 Weblog lines OR AccessLog API JSON (
                <code>{'{ "LIST": [...], "INFO": "" }'}</code>) to parse, redact IPs, sort &amp;
                re-vectorize live:
              </div>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => setRawIngestText(SAMPLE_INGEST_SNIPPET)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "5px",
                    backgroundColor: "#1e293b",
                    color: "#cbd5e1",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "#334155",
                    fontSize: "10.5px",
                    cursor: "pointer",
                  }}
                >
                  Load Text Sample
                </button>
                <button
                  type="button"
                  onClick={() => setRawIngestText(SAMPLE_INGEST_LIST_JSON)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "5px",
                    backgroundColor: "#1e293b",
                    color: "#7dd3fc",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "#334155",
                    fontSize: "10.5px",
                    cursor: "pointer",
                  }}
                >
                  Load LIST JSON Sample
                </button>
              </div>
            </div>
            <textarea
              rows={5}
              value={rawIngestText}
              onChange={(e) => setRawIngestText(e.target.value)}
              placeholder={
                'Paste raw weblog lines or { "LIST": [ { "AccessDateTime": "...", "ClientCode": "...", "LoginID": "...", "Operation": "...", "Data": "...", "IPAddress": "..." } ] }'
              }
              style={{
                width: "100%",
                boxSizing: "border-box",
                backgroundColor: "#0b1220",
                color: "#e2e8f0",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#1e293b",
                borderRadius: "6px",
                padding: "8px",
                fontFamily: MONO_FONT,
                fontSize: "11px",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <button
                type="button"
                onClick={() => void handleIngest()}
                style={{
                  padding: "6px 12px",
                  borderRadius: "6px",
                  backgroundColor: "#0284c7",
                  color: "#f8fafc",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "#38bdf8",
                  fontSize: "11px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Parse, Sort &amp; Vectorize
              </button>
              {ingestNotice && (
                <span style={{ fontSize: "11px", color: "#7dd3fc" }}>{ingestNotice}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sortable Parsed Weblogs Table (Date-Grouped Fantasy402 Style) */}
      <div
        style={{
          backgroundColor: "#070b14",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "#1e293b",
          borderRadius: "8px",
          overflowX: "auto",
        }}
      >
        {data && (
          <p className="sd-muted">
            {data.source === "retained-mode-a"
              ? "Retained Fantasy402 access capture"
              : data.source === "operator-import"
                ? "Operator-imported access logs"
                : data.source === "mixed"
                  ? "Retained Fantasy402 access capture and operator imports"
                  : "Access capture unavailable"}
          </p>
        )}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px",
            padding: "8px 10px",
          }}
        >
          <label>
            IP family{" "}
            <select
              value={ipFamily}
              onChange={(event) => {
                setIpFamily(event.target.value)
                setIpFilter("ALL")
              }}
            >
              <option value="all">All</option>
              <option value="IPv4">IPv4</option>
              <option value="IPv6">IPv6</option>
              <option value="Unknown">Unknown</option>
            </select>
          </label>
          <details>
            <summary>Severity key</summary>
            <p>Dashboard rule score for the IP and login group.</p>
            <ul>
              {WEBLOG_SEVERITY_RULES.map(({ severity, range }) => (
                <li key={severity}>
                  {severity} {range}
                </li>
              ))}
            </ul>
          </details>
          {page && (
            <nav
              aria-label="Weblog pages"
              style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto" }}
            >
              <button
                type="button"
                disabled={loading || page.offset === 0}
                onClick={() => void fetchWebLogs(Math.max(0, page.offset - WEBLOG_PAGE_SIZE))}
              >
                Previous
              </button>
              <span aria-live="polite">{pageRange}</span>
              <button
                type="button"
                disabled={loading || page.nextOffset === null}
                onClick={() => {
                  if (page.nextOffset !== null) void fetchWebLogs(page.nextOffset)
                }}
              >
                Next
              </button>
            </nav>
          )}
        </div>
        {data && (
          <WebLogActionDictionary
            kinds={data.kinds}
            clients={data.clients}
            onSelectKind={setKindFilter}
            onSelectClient={({ site, version }) => {
              setKindFilter("ALL")
              setClientFilter({ site, version })
            }}
          />
        )}
        <ParlayComparisonSection />
        {clientFilter && (
          <div style={{ padding: "8px 10px", fontSize: "12px", color: "#cbd5e1" }}>
            Logged site and version {clientFilter.site} · {clientFilter.version}{" "}
            <button type="button" onClick={() => setClientFilter(null)}>
              Clear site and version
            </button>
          </div>
        )}
        {error && (
          <div style={{ padding: "12px", color: "#fca5a5", fontSize: "12px" }}>
            Failed to load weblogs: {error}
          </div>
        )}
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: "12px",
            fontFamily: MONO_FONT,
          }}
        >
          <thead>
            <tr
              style={{
                backgroundColor: "#0f172a",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "#1e293b",
              }}
            >
              {WEBLOG_COLUMNS.map((col) => (
                <th
                  key={col.field}
                  aria-sort={
                    sortField === col.field
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                  style={{
                    textAlign: "left",
                    padding: "9px 10px",
                    color: sortField === col.field ? "#38bdf8" : "#94a3b8",
                    fontSize: "11px",
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  <button
                    type="button"
                    title={
                      col.field === "time"
                        ? "Provider wall time, including milliseconds when supplied"
                        : col.field === "cadence"
                          ? "Elapsed time since the prior retained event for this IP and login"
                          : undefined
                    }
                    onClick={() => handleSortClick(col.field)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      background: "transparent",
                      borderWidth: "0px",
                      color: "inherit",
                      font: "inherit",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    {col.label}
                    {sortIcon(col.field)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={weblogTbodyRef}>
            {loading && !data ? (
              <SkeletonTableRows
                columnWidths={[
                  "64%",
                  "58%",
                  "70%",
                  "76%",
                  "56%",
                  "72%",
                  "52%",
                  "78%",
                  "54%",
                  "56%",
                  "66%",
                ]}
                rowCount={6}
                rowHeight={38}
                skeletonId="weblogs-rows"
              />
            ) : (data?.entries ?? []).length === 0 ? (
              <tr>
                <td
                  colSpan={WEBLOG_COLUMNS.length}
                  style={{
                    padding: "18px",
                    textAlign: "center",
                    color: "#64748b",
                  }}
                >
                  No weblog entries match the current filters.
                </td>
              </tr>
            ) : (
              (() => {
                let lastDateLabel = ""
                return (data?.entries ?? []).map((row, rowIdx) => {
                  const showDateHeader = sortField === "time" && row.dateLabel !== lastDateLabel
                  lastDateLabel = row.dateLabel
                  const kindStyle = eventKindTone(row.eventKind)
                  const sevStyle = severityColors(row.severity)
                  const expanded = expandedRowId === row.id
                  const gameId = row.selection?.gameId
                  const isRapidCadence = row.interArrivalSec !== null && row.interArrivalSec <= 6

                  return (
                    <React.Fragment key={row.id}>
                      {showDateHeader && (
                        <tr data-date-group={row.dateLabel} style={{ backgroundColor: "#111c33" }}>
                          <td
                            colSpan={WEBLOG_COLUMNS.length}
                            style={{
                              padding: "6px 12px",
                              fontSize: "11px",
                              fontWeight: 700,
                              color: "#e2e8f0",
                              borderTopWidth: "1px",
                              borderBottomWidth: "1px",
                              borderTopStyle: "solid",
                              borderBottomStyle: "solid",
                              borderTopColor: "#1e293b",
                              borderBottomColor: "#1e293b",
                            }}
                          >
                            {row.dateLabel}
                          </td>
                        </tr>
                      )}
                      <tr
                        data-log-idx={rowIdx}
                        onClick={() =>
                          setExpandedRowId((curr) => (curr === row.id ? null : row.id))
                        }
                        style={{
                          cursor: "pointer",
                          backgroundColor: expanded ? "rgba(56, 189, 248, 0.08)" : "transparent",
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.7)",
                        }}
                      >
                        <td
                          style={{
                            padding: "7px 10px",
                            color: "#cbd5e1",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                            }}
                          >
                            {expanded ? (
                              <ChevronDown size={12} style={{ color: "#38bdf8" }} />
                            ) : (
                              <ChevronRight size={12} style={{ color: "#475569" }} />
                            )}
                            {row.timeEst}
                          </span>
                        </td>
                        <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              fontSize: "10px",
                              fontWeight: 700,
                              padding: "2px 6px",
                              borderRadius: "4px",
                              color: sevStyle.fg,
                              backgroundColor: sevStyle.bg,
                              borderWidth: "1px",
                              borderStyle: "solid",
                              borderColor: sevStyle.borderColor,
                            }}
                          >
                            {row.severity}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "7px 10px",
                            color: "#f8fafc",
                            fontWeight: 700,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.accountId}
                        </td>
                        <td style={WEBLOG_CELL_STYLE}>{row.ipMeta.family}</td>
                        <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              color: "#38bdf8",
                              textDecoration: "underline",
                            }}
                          >
                            <Globe size={12} style={{ color: "#64748b" }} />
                            {row.ip}
                          </span>
                        </td>
                        <td style={WEBLOG_CELL_STYLE}>{row.event}</td>
                        <td style={{ padding: "7px 10px", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              fontSize: "10px",
                              fontWeight: 700,
                              padding: "2px 6px",
                              borderRadius: "4px",
                              color: kindStyle.fg,
                              backgroundColor: kindStyle.bg,
                              borderWidth: "1px",
                              borderStyle: "solid",
                              borderColor: kindStyle.borderColor,
                            }}
                          >
                            {row.rawAction}
                          </span>
                        </td>
                        <td style={WEBLOG_CELL_STYLE}>{gameId ?? "—"}</td>
                        <td style={WEBLOG_CELL_STYLE}>
                          <span
                            title={row.botKey ? "Fantasy402 bot-block selection key" : undefined}
                          >
                            {row.botKey?.rawKey ?? "—"}
                          </span>
                        </td>
                        <td style={WEBLOG_CELL_STYLE}>{row.selection?.period ?? "—"}</td>
                        <td style={WEBLOG_CELL_STYLE}>{row.selection?.market ?? "—"}</td>
                        <td style={WEBLOG_CELL_STYLE}>{row.selection?.pick ?? "—"}</td>
                        <td
                          style={{
                            padding: "7px 10px",
                            whiteSpace: "nowrap",
                            fontWeight: isRapidCadence ? 700 : 400,
                            color: isRapidCadence
                              ? "#fca5a5"
                              : row.interArrivalSec !== null && row.interArrivalSec <= 15
                                ? "#fcd34d"
                                : "#64748b",
                          }}
                        >
                          {row.interArrivalSec !== null ? `${row.interArrivalSec}s` : "—"}
                        </td>
                        <td
                          style={{
                            padding: "7px 10px",
                            whiteSpace: "nowrap",
                            fontWeight: 700,
                            color:
                              row.vectorScore >= 78
                                ? "#f87171"
                                : row.vectorScore >= 56
                                  ? "#fbbf24"
                                  : "#4ade80",
                          }}
                        >
                          {row.vectorScore}
                        </td>
                      </tr>

                      {expanded && (
                        <tr
                          data-log-idx={rowIdx}
                          data-log-detail="true"
                          style={{ backgroundColor: "#0b1220" }}
                        >
                          <td
                            colSpan={WEBLOG_COLUMNS.length}
                            style={{
                              padding: "10px 14px",
                              borderBottomWidth: "1px",
                              borderBottomStyle: "solid",
                              borderBottomColor: "#1e293b",
                            }}
                          >
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                                gap: "10px",
                                fontSize: "11px",
                              }}
                            >
                              <div>
                                <div
                                  style={{
                                    color: "#64748b",
                                    marginBottom: "3px",
                                  }}
                                >
                                  IP &amp; Network Forensics
                                </div>
                                <div style={{ color: "#e2e8f0" }}>
                                  IP: <strong>{row.ip}</strong> ({row.ipMeta.subnet24})
                                </div>
                                <div style={{ color: "#94a3b8" }}>
                                  Class: {row.ipMeta.classification} · {row.ipMeta.asnLabel}
                                </div>
                              </div>

                              <div>
                                <div
                                  style={{
                                    color: "#64748b",
                                    marginBottom: "3px",
                                  }}
                                >
                                  Source evidence
                                </div>
                                {row.sourceTime && (
                                  <div title="Provider timestamp with no timezone offset in the retained capture">
                                    Source time {row.sourceTime}
                                  </div>
                                )}
                                <div style={{ color: "#e2e8f0" }}>{row.rawAction}</div>
                                {row.botKey && (
                                  <div>
                                    Bot key fields: prefix · game ID · period · market · pick ·
                                    sequence. The row records a blocked request.
                                  </div>
                                )}
                                {row.parlayLegs && (
                                  <ol
                                    aria-label="Parsed parlay legs"
                                    style={{
                                      margin: "4px 0",
                                      paddingLeft: "18px",
                                      color: "#e2e8f0",
                                    }}
                                  >
                                    {row.parlayLegs.map((leg, index) => (
                                      <li key={index}>
                                        {[
                                          leg.sport,
                                          leg.listedNumber && `#${leg.listedNumber}`,
                                          leg.period,
                                          leg.market,
                                          leg.selection,
                                          leg.priceAmerican,
                                          leg.pointsBought && `buy ${leg.pointsBought}`,
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")}
                                      </li>
                                    ))}
                                  </ol>
                                )}
                                {row.selection?.source === "chosen-team" && (
                                  <div>Game and pick come from the recorded team selection.</div>
                                )}
                                {row.selection?.listedNumber && (
                                  <div>
                                    Number listed on bet description #{row.selection.listedNumber}
                                  </div>
                                )}
                                {row.ticketNumber && <div>Ticket reference {row.ticketNumber}</div>}
                                {row.eventKind === "LOGIN_TOKEN" && (
                                  <div>
                                    Source marker: <code>Login successful Token</code>. The marker
                                    records a token login. Refresh status is unverified.
                                  </div>
                                )}
                                {(row.clientVersion || row.portalHost) && (
                                  <div>
                                    Logged site: {row.portalHost ?? "—"} · Version:{" "}
                                    {row.clientVersion ?? "—"}
                                  </div>
                                )}
                                {(row.deviceMarker || row.apiMarked) && (
                                  <div>
                                    Action markers{" "}
                                    {[
                                      row.apiMarked && "API LOG",
                                      row.deviceMarker && `(${row.deviceMarker})`,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </div>
                                )}
                                {row.actionMeta &&
                                  (row.actionMeta.riskUsd != null ||
                                    row.actionMeta.limitUsd != null ||
                                    row.actionMeta.selectionSummary) && (
                                    <div style={{ color: "#e2e8f0" }}>
                                      {row.actionMeta.limitUsd != null &&
                                      row.actionMeta.attemptedUsd != null
                                        ? `Limit Rejection: Max $${row.actionMeta.limitUsd} vs Attempted $${row.actionMeta.attemptedUsd}`
                                        : row.actionMeta.riskUsd != null
                                          ? `Stake: Risk $${row.actionMeta.riskUsd} → Win $${row.actionMeta.winUsd ?? "—"}`
                                          : ""}
                                      {row.actionMeta.selectionSummary
                                        ? ` · ${row.actionMeta.selectionSummary}`
                                        : ""}
                                    </div>
                                  )}
                                <div style={{ color: "#94a3b8" }}>
                                  Activity: {row.clusterLabel} (Rule Score {row.vectorScore}/100)
                                </div>
                              </div>

                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  flexWrap: "wrap",
                                  justifyContent: "flex-end",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setIpFilter(row.ip)
                                  }}
                                  style={{
                                    padding: "4px 8px",
                                    borderRadius: "5px",
                                    fontSize: "11px",
                                    backgroundColor: "#1e293b",
                                    color: "#7dd3fc",
                                    borderWidth: "1px",
                                    borderStyle: "solid",
                                    borderColor: "#334155",
                                    cursor: "pointer",
                                  }}
                                >
                                  Filter IP
                                </button>
                                {gameId && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setSearchQuery(gameId)
                                    }}
                                    style={{
                                      padding: "4px 8px",
                                      borderRadius: "5px",
                                      fontSize: "11px",
                                      backgroundColor: "#1e293b",
                                      color: "#fcd34d",
                                      borderWidth: "1px",
                                      borderStyle: "solid",
                                      borderColor: "#334155",
                                      cursor: "pointer",
                                    }}
                                  >
                                    Filter Game {gameId}
                                  </button>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })
              })()
            )}
            <tr data-bitwise-empty="true" hidden>
              <td
                colSpan={WEBLOG_COLUMNS.length}
                style={{
                  padding: "18px",
                  textAlign: "center",
                  color: "#64748b",
                  fontSize: "12px",
                }}
              >
                No weblog entries match the active bitwise severity mask and search terms.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Live Bun.inspect.custom Output Renderer */}
      <div
        style={{
          backgroundColor: "#070b14",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "#1e293b",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "8px",
            padding: "10px 14px",
            backgroundColor: "#0d1527",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "#1e293b",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <Terminal size={14} style={{ color: "#38bdf8" }} />
            <span
              style={{
                fontSize: "12px",
                fontWeight: 700,
                color: "#f8fafc",
                fontFamily: MONO_FONT,
              }}
            >
              Bun.inspect.custom Live Output
            </span>
            {(
              [
                { id: "weblog", label: "WebLogView" },
                { id: "vector", label: "WebLogVectorView" },
                { id: "table", label: "Table" },
                { id: "json", label: "Parsed JSON" },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setInspectMode(m.id)}
                style={{
                  padding: "3px 8px",
                  borderRadius: "5px",
                  fontSize: "11px",
                  fontWeight: 600,
                  fontFamily: MONO_FONT,
                  cursor: "pointer",
                  backgroundColor: inspectMode === m.id ? "rgba(56, 189, 248, 0.18)" : "#070b14",
                  color: inspectMode === m.id ? "#7dd3fc" : "#94a3b8",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: inspectMode === m.id ? "#38bdf8" : "#1e293b",
                }}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flexWrap: "wrap",
            }}
          >
            <button
              type="button"
              onClick={() => void handleCopyInspect("plain")}
              title="Copy ANSI-stripped plain text output"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "4px 8px",
                borderRadius: "5px",
                fontSize: "11px",
                backgroundColor: "#1e293b",
                color: copiedInspect === "plain" ? "#4ade80" : "#e2e8f0",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: copiedInspect === "plain" ? "#22c55e" : "#334155",
                cursor: "pointer",
              }}
            >
              <Copy size={11} />
              {copiedInspect === "failed"
                ? "Copy failed"
                : copiedInspect === "plain"
                  ? "Copied"
                  : "Copy Plain"}
            </button>
            <button
              type="button"
              onClick={() => void handleCopyInspect("ansi")}
              title="Copy raw ANSI escape sequences for terminal playback"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "4px 8px",
                borderRadius: "5px",
                fontSize: "11px",
                fontFamily: MONO_FONT,
                backgroundColor: "#1e293b",
                color: copiedInspect === "ansi" ? "#4ade80" : "#cbd5e1",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: copiedInspect === "ansi" ? "#22c55e" : "#334155",
                cursor: "pointer",
              }}
            >
              <Copy size={11} />
              {copiedInspect === "ansi" ? "Copied ANSI" : "ANSI"}
            </button>
            <button
              type="button"
              onClick={() => void handleCopyInspect("options")}
              title="Copy full CLI command with --options flags"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "4px 8px",
                borderRadius: "5px",
                fontSize: "11px",
                fontFamily: MONO_FONT,
                backgroundColor: "#1e293b",
                color: copiedInspect === "options" ? "#4ade80" : "#fcd34d",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: copiedInspect === "options" ? "#22c55e" : "#334155",
                cursor: "pointer",
              }}
            >
              <Copy size={11} />
              {copiedInspect === "options" ? "Copied CLI" : "Copy --options"}
            </button>
            <button
              type="button"
              onClick={handleDownloadInspect}
              title="Export rendered Bun.inspect report (.txt)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "4px 8px",
                borderRadius: "5px",
                fontSize: "11px",
                backgroundColor: "#1e293b",
                color: "#e2e8f0",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
                cursor: "pointer",
              }}
            >
              <Download size={11} />
              Export
            </button>
            {(onRunTerminalCommand || onOpenTerminal) && (
              <button
                type="button"
                onClick={() => {
                  if (onRunTerminalCommand) {
                    onRunTerminalCommand(cliCommand)
                  } else {
                    onOpenTerminal?.()
                  }
                }}
                title={`Execute "${cliCommand}" in the interactive PTY terminal`}
                style={{
                  padding: "4px 8px",
                  borderRadius: "5px",
                  fontSize: "11px",
                  fontWeight: 600,
                  backgroundColor: "rgba(56, 189, 248, 0.14)",
                  color: "#7dd3fc",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "rgba(56, 189, 248, 0.4)",
                  cursor: "pointer",
                }}
              >
                Run in Terminal ↗
              </button>
            )}
          </div>
        </div>

        {/* Full Bun.inspect.options Control Strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "8px 12px",
            padding: "7px 14px",
            backgroundColor: "#0a1120",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "#172033",
            fontSize: "11px",
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
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: "10px",
                fontWeight: 700,
                color: "#64748b",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              Bun.inspect.options
            </span>
            {(
              [
                {
                  label: "colors",
                  checked: inspectColors,
                  set: setInspectColors,
                  title: "Toggle ANSI color formatting (--colors / --no-color)",
                },
                {
                  label: "compact",
                  checked: inspectCompact,
                  set: setInspectCompact,
                  title: "Compact dense output (--compact)",
                },
                {
                  label: "sorted",
                  checked: inspectSorted,
                  set: setInspectSorted,
                  title: "Sort inspector rows by IP (--sorted)",
                },
                {
                  label: "showHidden",
                  checked: inspectShowHidden,
                  set: setInspectShowHidden,
                  title: "Show redacted prefixes and source metadata (--show-hidden)",
                },
                {
                  label: "numericSeparator",
                  checked: inspectNumericSeparator,
                  set: setInspectNumericSeparator,
                  title: "Use _ numeric separators for large IDs & counts (--numeric-separator)",
                },
                {
                  label: "getters",
                  checked: inspectGetters,
                  set: setInspectGetters,
                  title: "Show the computed activity label (--getters)",
                },
                {
                  label: "--options",
                  checked: inspectShowOptions,
                  set: setInspectShowOptions,
                  title: "Append resolved Bun.inspect.options diagnostic footer (--options)",
                },
              ] as const
            ).map((opt) => (
              <label
                key={opt.label}
                title={opt.title}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  color: opt.checked ? "#e2e8f0" : "#94a3b8",
                  fontFamily: MONO_FONT,
                  fontSize: "11px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <input
                  type="checkbox"
                  checked={opt.checked}
                  onChange={(e) => opt.set(e.target.checked)}
                />
                {opt.label}
              </label>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <div
              role="group"
              aria-label="Bun.inspect depth level"
              style={{
                display: "inline-flex",
                alignItems: "center",
                borderRadius: "5px",
                overflow: "hidden",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
                backgroundColor: "#070b14",
              }}
            >
              <span
                style={{
                  padding: "3px 6px",
                  fontSize: "10px",
                  fontFamily: MONO_FONT,
                  color: "#64748b",
                  borderRightWidth: "1px",
                  borderRightStyle: "solid",
                  borderRightColor: "#1e293b",
                }}
              >
                depth
              </span>
              {([0, 1, 2, 3, 4] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setInspectDepth(d)}
                  title={
                    d === 0
                      ? "Depth 0: Counts only"
                      : d === 1
                        ? "Depth 1: Event lines and selection evidence"
                        : d === 2
                          ? "Depth 2: Add score and cadence"
                          : d === 3
                            ? "Depth 3: Add redacted network and bot key"
                            : "Depth 4: Add capture source and redacted prefix"
                  }
                  style={{
                    padding: "3px 7px",
                    fontSize: "11px",
                    fontWeight: inspectDepth === d ? 700 : 500,
                    fontFamily: MONO_FONT,
                    backgroundColor: inspectDepth === d ? "rgba(56, 189, 248, 0.2)" : "transparent",
                    color: inspectDepth === d ? "#7dd3fc" : "#94a3b8",
                    borderWidth: 0,
                    cursor: "pointer",
                  }}
                >
                  d{d}
                </button>
              ))}
            </div>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontFamily: MONO_FONT,
                fontSize: "10.5px",
                color: "#94a3b8",
              }}
              title="Maximum rows/items rendered (--max-array-length)"
            >
              Rows
              <select
                value={inspectMaxArrayLength}
                onChange={(e) => setInspectMaxArrayLength(Number(e.target.value))}
                style={{
                  backgroundColor: "#070b14",
                  color: "#e2e8f0",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "#334155",
                  borderRadius: "4px",
                  padding: "2px 4px",
                  fontFamily: MONO_FONT,
                  fontSize: "10.5px",
                }}
              >
                {[10, 22, 32, 50].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>

            <label
              title="Maximum characters per pick or table cell (--max-string)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontFamily: MONO_FONT,
                fontSize: "10.5px",
                color: "#94a3b8",
              }}
            >
              Text
              <select
                value={inspectMaxStringLength}
                onChange={(event) => setInspectMaxStringLength(Number(event.target.value))}
              >
                {[24, 42, 64, 96].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontFamily: MONO_FONT,
                fontSize: "10.5px",
                color: "#94a3b8",
              }}
              title="Line-wrap / box width target in columns (--break-length)"
            >
              cols
              <select
                value={inspectBreakLength}
                onChange={(e) => setInspectBreakLength(Number(e.target.value))}
                style={{
                  backgroundColor: "#070b14",
                  color: "#e2e8f0",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "#334155",
                  borderRadius: "4px",
                  padding: "2px 4px",
                  fontFamily: MONO_FONT,
                  fontSize: "10.5px",
                }}
              >
                {[56, 76, 96, 116, 132].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            padding: "7px 14px",
            backgroundColor: "#070d19",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "#172033",
            fontFamily: MONO_FONT,
            fontSize: "10.5px",
            color: "#94a3b8",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "#38bdf8", overflowWrap: "anywhere" }}>
              $ {inspectInvocation}
            </span>
            <span
              style={{
                color: "#64748b",
                whiteSpace: "nowrap",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {inspectStats.lines} lines · {inspectStats.bytes.toLocaleString()} B ansi ·
              Symbol.for("Bun.inspect.custom")
            </span>
          </div>
          <span style={{ color: "#fcd34d", overflowWrap: "anywhere" }}>cli&gt; {cliCommand}</span>
        </div>

        <pre
          style={{
            margin: 0,
            padding: "12px 14px",
            overflowX: "auto",
            fontSize: "11.5px",
            lineHeight: 1.45,
            fontFamily: MONO_FONT,
            color: "#e2e8f0",
            backgroundColor: "#050912",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {activeAnsi ? renderAnsiReact(activeAnsi) : "Rendering Bun.inspect.custom view..."}
        </pre>
      </div>
    </div>
  )
}
