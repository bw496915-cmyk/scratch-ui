import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  parseDashboardWsSignal,
  resolveDaemon4020State,
  wagerChannelOf,
} from "@sportsdesk-ops/contracts"

import { copyText } from "./clipboard.ts"
import { stripAnsi } from "./terminal_transcript.ts"
import "./desk.css"
import {
  Activity,
  AlertTriangle,
  Menu,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  X,
} from "lucide-react"

import type { ReverseDnsClassification } from "../../../lib/bun_dns.ts"
import {
  buildReverseDnsForensicsView,
  type ReverseDnsForensicsView,
} from "../../../lib/reverse_dns_forensics.ts"
import {
  getDevCsrfToken,
  getDevSessionToken,
  registerUnauthorizedListener,
  setDevCsrfToken,
  setDevSessionToken,
  trackedFetch,
} from "./api_usage.ts"
import { getDashboardBuildInfo } from "./build_info.ts"
import { DASHBOARD_API, DASHBOARD_META, dashboardApiUrl } from "./config/dashboard.ts"
import { applyGraphForensicsToProfiles, indexGraphLiveFeedForensics } from "./customer_forensics.ts"
import { styles } from "./dashboard_styles.ts"
import { DEMO_CUSTOMER_COUNT } from "./data/demo_customers.ts"
import {
  applyShadowSliceToLocation,
  buildBookdeskopsDirectoryRouteHref,
  buildBookdeskopsTokensDeskHref,
  buildDashboardShadowSliceUrl,
  formatShadowSliceRibbonLabel,
  NFL_1H_PREGAME_SLICE,
  shadowSliceHasTapeFocus,
  sportFilterForSlice,
  summarizeSliceWagers,
  wagerSearchHintForSlice,
} from "./desk_quick_jump.ts"
import {
  buildFastSignInBookmarkUrl,
  extractAndScrubFastSignInToken,
  extractFastSignInTokenFromInput,
} from "./fast_signin.ts"
import {
  fetchRankingsSlice,
  normalizeCustomersCohortResponse,
  type NormalizedRankingsResult,
  normalizeLiveWagersResponse,
  PENDING_WAGERS_PROVENANCE,
  unavailableProvenance,
} from "./hydration.ts"
import { newTicketIds as diffNewTicketIds } from "./live_stream.ts"
import logo from "./logo.svg"
import {
  BRAND_ASSETS,
  formatShiftSecondsClock,
  resolveOperatorProfile,
} from "./operator_profiles.ts"
import {
  AgentInspectorModal,
  AlertsTabPanel,
  applyDashboardThemeToDocument,
  BetTickerTabPanel,
  BettorChurnSimulationPanel,
  type BreadcrumbAction,
  BuildMatrixDrawer,
  BunAssetsTabPanel,
  CustomersTabPanel,
  DashboardAuthShellSkeleton,
  DashboardBreadcrumbs,
  type DashboardTheme,
  GlobalHeaderSearch,
  HeaderThemeToggle,
  LiveWagersTabPanel,
  OperatorProfileMenu,
  PanelErrorBoundary,
  parseStoredRankingsHeatMapValue,
  type R2AutoRefreshIntervalSec,
  R2PipelineTabPanel,
  RANKINGS_HEATMAP_STORAGE_KEY,
  RankingsTabPanel,
  readStoredDashboardTheme,
  readStoredR2AutoRefreshSeconds,
  readStoredRankingsHeatMap,
  RiskOverviewPanel,
  ShiftDurationTimer,
  ShiftHandoffModal,
  ShiftHandoffReminderToast,
  shouldTriggerShiftHandoffAlert,
  SignInModalQrGenerator,
  StatusDashboardPanel,
  SurveillanceTabPanel,
  SystemLogsPanel,
  TerminalTabPanel,
  type WebLogSeverityCounts,
  type WebLogSeverityFilter,
  writeStoredR2AutoRefreshSeconds,
  writeStoredRankingsHeatMap,
} from "./panels/index.tsx"
import { WsSyncStatusIndicator } from "./panels/WsSyncStatusIndicator.tsx"
import {
  backtestRowsToProfiles,
  bookRowsToProfiles,
  mergeMatrixProfileOverlay,
  mergeProfileRows,
} from "./profile_rows.ts"
import {
  classifyCustomerProfile,
  customerMatchesSearch,
  loadCustomProfileTagsMap,
  matchesProfileTypeFilter,
  normalizeCustomTagLabel,
  saveCustomProfileTagsMap,
} from "./profile_taxonomy.ts"
import { feedFreshnessTitle, quickJumpFeedState } from "./quick_jump_feed.ts"
import { buildRolling60MinRiskSeries, formatRiskCompactUsd } from "./risk_exposure_series.ts"
import {
  evaluateRiskExposureThreshold,
  readStoredRiskExposureThresholds,
  type RiskExposureThresholds,
  writeStoredRiskExposureThresholds,
} from "./risk_threshold_alert.ts"
import { debugDashboardTrace, getDashboardRuntimeFlags } from "./runtime_flags.ts"
import { ShadowPricingPanel } from "./ShadowPricingPanel.tsx"
import {
  buildSharpestOnChainXrefReport,
  type CrossDomainBridgeSnapshot,
  parseCrossDomainBridgeSnapshot,
} from "./sharpest_onchain_xref.ts"
import {
  buildSurveillanceEndpointUrls,
  buildSurveillanceHeaderSyncRecord,
  type SurveillanceHeaderSyncRecord,
} from "./surveillance_api.ts"
import {
  CLIENT_AUTOCOMPLETE_COMMANDS,
  TERMINAL_INITIAL_COMMANDS,
  TERMINAL_WELCOME_HELP_STDOUT,
} from "./terminal_catalog.ts"
import { findWagerByTicketParam, syncTicketInspectorToLocation } from "./ticket_inspector.ts"
import { TOKENS_TOML_VERSION } from "./tokens.registry.generated.ts"
import {
  type AlertFilter,
  type AlertToastState,
  type BetTickerApiResponse,
  type BuildMatrixRow,
  type ConfigStatusSnapshot,
  type CustomerProfileClassification,
  type CustomersApiResponse,
  type CustomerSortKey,
  type DashboardAlertRecord,
  type DashboardData,
  type DashboardSourceProvenance,
  type DashboardTabId,
  type DnsData,
  type HealthData,
  type LiveWager,
  type ProfileTagCategory,
  type R2PipelineApiResponse,
  type R2PipelineHistoryApiResponse,
  type RankingsFilter,
  resolveDashboardTabId,
  type ShiftSessionAction,
  type ShiftSessionLogEntry,
  type ShiftSessionLogsResponse,
  type ShiftSummaryData,
  type ShowcaseCustomer,
  type SlabPolicySummary,
  type StaticDirectoryProbeSummary,
  type TelemetryRefreshSnapshot,
  type TerminalCategory,
  type TerminalHistoryEntry,
  type TierStyleConfig,
  type WagerSortField,
  type WagersWireContractSummary,
} from "./types.ts"
import {
  type DashboardUrlState,
  DEFAULT_DASHBOARD_URL_STATE,
  readDashboardUrlState,
  SURVEILLANCE_URL_DEFAULTS,
  type SurveillanceViewMode,
  writeDashboardUrl,
} from "./url_state.ts"
import { useActiveShadowSlice } from "./use_active_shadow_slice.ts"
import { useSportsDeskWebMcp } from "./use_web_mcp.ts"
import {
  CLOCK_DRIFT_WINDOW_MS,
  type ClockDriftPoint,
  ClockDriftSparkline,
} from "./viz/ClockDriftSparkline.tsx"

export * from "./types.ts"

/**
 * Why the profile cards are empty: no endpoint serves the per-customer card list, and two of the
 * three fields the UI used to promise have no source at all — the cohort file carries a scalar
 * `sharp_score` (no components) and no VaR. The copy names only what the data supports, so filling
 * the cards later cannot quietly omit them.
 * `GET /api/customer/profile?id=` returns one book profile by ID in a different shape.
 */
export const PROFILES_UNAVAILABLE_REASON =
  "Profile cards are limited to what the curated cohort file records: wager limit, delay, CLV and " +
  "sharpness score. VaR and sharpness components have no source yet, so they stay blank rather than " +
  `computed from nothing. The cohort is ${DEMO_CUSTOMER_COUNT} synthetic fixtures — a demo surface, not the book. ` +
  "Real-account profiles are a separate surface, blocked on the same exposure constraint as #242."

function getCsrfToken(): string {
  if (typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)sd_csrf=([^;]+)/)
    if (match?.[1]) return decodeURIComponent(match[1])
  }
  return getDevCsrfToken() ?? ""
}

function apiPostHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  const csrf = getCsrfToken()
  if (csrf) {
    headers["x-csrf-token"] = csrf
  }
  return headers
}

function initialDashboardUrlState(): DashboardUrlState {
  if (typeof window === "undefined") return DEFAULT_DASHBOARD_URL_STATE
  return readDashboardUrlState(
    window.location.search,
    window.location.pathname,
    window.location.hash,
  )
}

function resolveInitialUrlParam(name: string): string {
  if (typeof window === "undefined") return ""
  return new URLSearchParams(window.location.search).get(name)?.trim() ?? ""
}

interface ClockDriftSample {
  readonly offsetMs: number
  readonly rttMs: number
  readonly serverIso: string
  readonly measuredAtIso: string
}

const CLOCK_DRIFT_HISTORY_STORAGE_KEY = "sportsdesk_clock_drift_history_v1"

function loadClockDriftHistory(): readonly ClockDriftPoint[] {
  if (typeof sessionStorage === "undefined") return []
  try {
    const raw = sessionStorage.getItem(CLOCK_DRIFT_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const cutoff = Date.now() - CLOCK_DRIFT_WINDOW_MS
    return parsed
      .filter(
        (item): item is ClockDriftPoint =>
          typeof item === "object" &&
          item !== null &&
          typeof item.tsMs === "number" &&
          typeof item.offsetMs === "number" &&
          typeof item.rttMs === "number" &&
          Number.isFinite(item.tsMs) &&
          Number.isFinite(item.offsetMs) &&
          item.tsMs >= cutoff,
      )
      .slice(-120)
  } catch {
    return []
  }
}

function formatClockDrift(offsetMs: number): string {
  const rounded = Math.round(offsetMs)
  if (rounded === 0) return "±0ms"
  const sign = rounded > 0 ? "+" : "-"
  const abs = Math.abs(rounded)
  if (abs < 1000) return `${sign}${abs}ms`
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(abs < 10_000 ? 2 : 1)}s`
  return `${sign}${(abs / 60_000).toFixed(1)}m`
}

export function App(): React.ReactElement {
  const runtimeFlags = getDashboardRuntimeFlags()
  const buildInfo = getDashboardBuildInfo()
  const initialUrl = initialDashboardUrlState()
  const [activeTab, setActiveTab] = useState<DashboardTabId>(() => initialUrl.tab)
  const [showBuildMatrix, setShowBuildMatrix] = useState<boolean>(() => initialUrl.matrix)
  const [buildMatrixRows, setBuildMatrixRows] = useState<readonly BuildMatrixRow[] | null>(null)
  const [buildMatrixLoading, setBuildMatrixLoading] = useState<boolean>(false)
  const [buildMatrixError, setBuildMatrixError] = useState<string | null>(null)
  const [buildMatrixGeneratedAt, setBuildMatrixGeneratedAt] = useState<string | null>(null)
  const [buildMatrixCompiledMs, setBuildMatrixCompiledMs] = useState<number | null>(null)
  const [buildMatrixStaticDir, setBuildMatrixStaticDir] =
    useState<StaticDirectoryProbeSummary | null>(null)
  const [rankingsFilter, setRankingsFilter] = useState<RankingsFilter>("ALL")
  const [rankingsSearch, setRankingsSearch] = useState<string>(() => initialUrl.agent)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() =>
    initialUrl.agent ? initialUrl.agent.toUpperCase() : null,
  )
  const [selectedDownlineAgentIds, setSelectedDownlineAgentIds] = useState<readonly string[]>(
    () => initialUrl.downlineAgents ?? [],
  )
  const [rankingsHeatMapEnabled, setRankingsHeatMapEnabled] = useState<boolean>(
    () => initialUrl.rankingsHeatmap ?? readStoredRankingsHeatMap() ?? true,
  )
  const [riskThresholds, setRiskThresholds] = useState<RiskExposureThresholds>(() =>
    readStoredRiskExposureThresholds(),
  )
  const [riskClockMs, setRiskClockMs] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setRiskClockMs(Date.now())
    }, 15_000)
    return () => clearInterval(id)
  }, [])
  const handleChangeRiskExposureThresholds = (next: RiskExposureThresholds) => {
    const persisted = writeStoredRiskExposureThresholds(next)
    setRiskThresholds(persisted)
  }
  const handleChangeRiskExposureLimitUsd = (nextLimitUsd: number) => {
    const persisted = writeStoredRiskExposureThresholds({
      breachLimitUsd: nextLimitUsd,
      warningLimitUsd: riskThresholds.warningLimitUsd,
    })
    setRiskThresholds(persisted)
  }
  const [focusedCustomerId, setFocusedCustomerId] = useState<string | null>(() =>
    initialUrl.customer ? initialUrl.customer.toUpperCase() : null,
  )
  const [wagerSearch, setWagerSearch] = useState("")
  const [wagerSportFilter, setWagerSportFilter] = useState<string>(() => initialUrl.wSport)
  const [wagerAlertFilter, setWagerAlertFilter] = useState<string>(() => initialUrl.wAlert)
  const [wagerTypeFilter, setWagerTypeFilter] = useState<string>(() => initialUrl.wType)
  const [wagerChannelFilter, setWagerChannelFilter] = useState<string>(() => initialUrl.wChannel)
  const [copiedTicketId, setCopiedTicketId] = useState<string | null>(null)
  const [selectedWager, setSelectedWager] = useState<LiveWager | null>(null)
  // Default sort comes from packages/ui/src/config/wagers.toml ([table] table).
  const [wagerSortField, setWagerSortField] = useState<WagerSortField>(() => initialUrl.wSort)
  const [wagerSortDir, setWagerSortDir] = useState<"asc" | "desc">(() => initialUrl.wDir)
  const [clockTime, setClockTime] = useState<string>("")
  const [clockDrift, setClockDrift] = useState<ClockDriftSample | null>(null)
  const [clockDriftHistory, setClockDriftHistory] = useState<readonly ClockDriftPoint[]>(() =>
    loadClockDriftHistory(),
  )
  const [systemLogSeverityFilter, setSystemLogSeverityFilter] =
    useState<WebLogSeverityFilter>("ALL")
  const [systemLogSeverityCounts, setSystemLogSeverityCounts] =
    useState<WebLogSeverityCounts | null>(null)
  const [terminalCategory, setTerminalCategory] = useState<TerminalCategory>("ALL")
  const [copiedCommandIdx, setCopiedCommandIdx] = useState<number | null>(null)
  const [copiedTerminalIdx, setCopiedTerminalIdx] = useState<number | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [dnsData, setDnsData] = useState<DnsData | null>(null)
  const [dnsRefreshing, setDnsRefreshing] = useState(false)
  const [dnsError, setDnsError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<SurveillanceViewMode>(
    () => initialUrl.survView ?? SURVEILLANCE_URL_DEFAULTS.view,
  )
  const [connected, setConnected] = useState(false)
  /** Wager-stream bookkeeping: when the feed last landed and which tickets are new. */
  const seenWagerIdsRef = useRef<Set<string>>(new Set())
  const hasLoadedWagersRef = useRef(false)
  const freshTicketsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [newTicketIds, setNewTicketIds] = useState<ReadonlySet<string>>(new Set())
  const [wagersUpdatedAt, setWagersUpdatedAt] = useState<number | null>(null)
  const [benchHost, setBenchHost] = useState<string>(
    () => initialUrl.survHost ?? SURVEILLANCE_URL_DEFAULTS.host,
  )
  const [benchResult, setBenchResult] = useState<string | null>(null)
  const [benchLoading, setBenchLoading] = useState(false)
  const [reverseIp, setReverseIp] = useState(
    () => initialUrl.survIp ?? SURVEILLANCE_URL_DEFAULTS.ip,
  )
  const [reverseForensics, setReverseForensics] = useState<ReverseDnsForensicsView | null>(null)
  const [surveillanceHeaderSync, setSurveillanceHeaderSync] =
    useState<SurveillanceHeaderSyncRecord | null>(null)

  // Global Header & Bet Ticker Search state
  const [globalSearch, setGlobalSearch] = useState<string>("")
  const [betTickerSearch, setBetTickerSearch] = useState<string>("")

  // Customer Showcase state
  const [searchQuery, setSearchQuery] = useState(() => resolveInitialUrlParam("search"))
  const [filterTier, setFilterTier] = useState<string>("ALL")
  const [activeProfileTagIds, setActiveProfileTagIds] = useState<readonly string[]>([])
  const [profileTagCategoryFilter, setProfileTagCategoryFilter] = useState<
    "ALL" | ProfileTagCategory
  >("ALL")
  const [customProfileTags, setCustomProfileTags] = useState<Record<string, readonly string[]>>(
    () => loadCustomProfileTagsMap(),
  )
  const [copiedCliId, setCopiedCliId] = useState<string | null>(null)
  const [selectedCustomer, setSelectedCustomer] = useState<ShowcaseCustomer | null>(null)
  const [customerLookupNotice, setCustomerLookupNotice] = useState<string | null>(null)
  const [customerReverseForensics, setCustomerReverseForensics] =
    useState<ReverseDnsForensicsView | null>(null)
  /** HMR/back-compat: older dashboard bundles referenced this name. */
  const customerForensicResult = customerReverseForensics

  // Manual Telemetry Refresh & WebSocket Reconnect state
  const [telemetryRefreshing, setTelemetryRefreshing] = useState<boolean>(false)
  const [lastTelemetryProbeAt, setLastTelemetryProbeAt] = useState<string | null>(null)
  const [lastTelemetryProbeMs, setLastTelemetryProbeMs] = useState<number | null>(null)
  const [telemetryProbeError, setTelemetryProbeError] = useState<string | null>(null)
  const [wsReconnectNonce, setWsReconnectNonce] = useState<number>(0)
  const [wsLatencyMs, setWsLatencyMs] = useState<number | null>(null)
  const [wsJitterMs, setWsJitterMs] = useState<number | null>(null)
  const [wsLastPongAt, setWsLastPongAt] = useState<string | null>(null)
  const [wsSyncTick, setWsSyncTick] = useState<number>(0)
  const [wsLastSyncAt, setWsLastSyncAt] = useState<number | null>(null)
  const [r2LastUpdatedAt, setR2LastUpdatedAt] = useState<string | null>(null)
  const [daemon4020LastUpdatedAt, setDaemon4020LastUpdatedAt] = useState<string | null>(null)
  const [daemon4020LastProbedAt, setDaemon4020LastProbedAt] = useState<string | null>(null)
  const [healthLastUpdatedAt, setHealthLastUpdatedAt] = useState<string | null>(null)

  // Runtime Declarative Wager Tiers + Live API Hydration state
  const [tiersConfig, setTiersConfig] = useState<TierStyleConfig | null>(null)
  const [liveWagers, setLiveWagers] = useState<readonly LiveWager[]>([])
  const [wagersProvenance, setWagersProvenance] =
    useState<DashboardSourceProvenance>(PENDING_WAGERS_PROVENANCE)
  const [wagersError, setWagersError] = useState<string | null>(null)
  const [wireContract, setWireContract] = useState<WagersWireContractSummary | null>(null)
  const [slabPolicy, setSlabPolicy] = useState<SlabPolicySummary | null>(null)
  const [betTickerData, setBetTickerData] = useState<BetTickerApiResponse | null>(null)
  const [betTickerLoading, setBetTickerLoading] = useState<boolean>(false)
  const [betTickerError, setBetTickerError] = useState<string | null>(null)
  const [r2PipelineData, setR2PipelineData] = useState<R2PipelineApiResponse | null>(null)
  const [r2PipelineLoading, setR2PipelineLoading] = useState<boolean>(false)
  const [r2PipelineError, setR2PipelineError] = useState<string | null>(null)
  const [r2PipelineHistory, setR2PipelineHistory] = useState<R2PipelineHistoryApiResponse | null>(
    null,
  )
  const [r2PipelineHistoryError, setR2PipelineHistoryError] = useState<string | null>(null)
  const [r2AutoRefreshSeconds, setR2AutoRefreshSeconds] = useState<R2AutoRefreshIntervalSec>(() =>
    readStoredR2AutoRefreshSeconds(),
  )
  const [r2NextRefreshAtMs, setR2NextRefreshAtMs] = useState<number | null>(null)
  const [r2RefreshCycleNonce, setR2RefreshCycleNonce] = useState<number>(0)
  const r2PollInFlightRef = useRef<boolean>(false)
  const [verifyingTickets, setVerifyingTickets] = useState<boolean>(false)
  const [verifyTicketsError, setVerifyTicketsError] = useState<string | null>(null)
  const [cohortsReport, setCohortsReport] = useState<CustomersApiResponse | null>(null)
  const [cohortsStatus, setCohortsStatus] = useState<"pending" | "ready" | "unavailable">("pending")
  const [cohortsError, setCohortsError] = useState<string | null>(null)
  const [graphLiveFeedRaw, setGraphLiveFeedRaw] = useState<unknown>(null)
  const [crossDomainBridge, setCrossDomainBridge] = useState<CrossDomainBridgeSnapshot | null>(null)
  const graphForensicsByCustomer = useMemo(
    () => indexGraphLiveFeedForensics(graphLiveFeedRaw),
    [graphLiveFeedRaw],
  )
  // Every customer row the desk actually has: fixture-book rows first (richer), then the
  // full backtest cohort. A missing/unavailable payload leaves this empty, which is what
  // keeps the Profiles tab in its explicit "no source" state.
  const activeShadowSlice = useActiveShadowSlice()
  const shadowSliceTape = useMemo(
    () => summarizeSliceWagers(liveWagers, activeShadowSlice),
    [liveWagers, activeShadowSlice],
  )
  const tapeRiskUsd = shadowSliceHasTapeFocus(activeShadowSlice)
    ? shadowSliceTape.riskUsd
    : liveWagers.reduce((s, w) => s + w.riskUsd, 0)
  const tapeTicketCount = shadowSliceHasTapeFocus(activeShadowSlice)
    ? shadowSliceTape.count
    : liveWagers.length

  // Quick-Jump ribbon freshness. The App re-renders on the per-second clock, so
  // the age is recomputed without a second timer; `wagersUpdatedAt` is the last
  // successful snapshot, never the render time.
  const quickJumpFeed = quickJumpFeedState(wagersUpdatedAt, Date.now())
  const quickJumpNcaabActive = activeTab === "wagers" && wagerSportFilter.toUpperCase() === "NCAAB"
  const quickJumpChannelFilter = wagerChannelFilter.toUpperCase()
  const quickJumpAuditActive =
    activeTab === "customers" && (selectedCustomer?.id ?? "").toUpperCase() === "BRT106"

  // Real-time 60-minute rolling aggregate risk exposure & configurable threshold alert
  const hasLiveWagerSnapshot =
    wagersProvenance.kind !== "pending" && wagersProvenance.kind !== "unavailable"
  const rolling60mAnchorMs = useMemo(() => {
    const latestFeed = Math.max(wsLastSyncAt ?? 0, wagersUpdatedAt ?? 0)
    return Math.max(latestFeed, riskClockMs)
  }, [wsSyncTick, wsLastSyncAt, wagersUpdatedAt, riskClockMs])

  const rolling60mRiskSeries = useMemo(
    () =>
      buildRolling60MinRiskSeries(liveWagers, {
        anchorMs: rolling60mAnchorMs,
        windowMinutes: 60,
      }),
    [liveWagers, rolling60mAnchorMs],
  )

  const riskThresholdEvaluation = useMemo(
    () =>
      evaluateRiskExposureThreshold(
        rolling60mRiskSeries.totalRiskUsd,
        riskThresholds.breachLimitUsd,
        {
          warningLimitUsd: riskThresholds.warningLimitUsd,
          hasData: hasLiveWagerSnapshot && rolling60mRiskSeries.includedTickets > 0,
        },
      ),
    [
      rolling60mRiskSeries.totalRiskUsd,
      rolling60mRiskSeries.includedTickets,
      riskThresholds.breachLimitUsd,
      riskThresholds.warningLimitUsd,
      hasLiveWagerSnapshot,
    ],
  )

  const [quickLinkCopyState, setQuickLinkCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const quickLinkCopyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (quickLinkCopyTimer.current !== null) {
        clearTimeout(quickLinkCopyTimer.current)
      }
    },
    [],
  )
  const handleCopyQuickLink = () => {
    if (typeof window === "undefined") return
    void copyText(window.location.href).then((result) => {
      setQuickLinkCopyState(result.ok ? "copied" : "failed")
      if (quickLinkCopyTimer.current !== null) {
        clearTimeout(quickLinkCopyTimer.current)
      }
      quickLinkCopyTimer.current = setTimeout(() => setQuickLinkCopyState("idle"), 1_800)
    })
  }

  const viewIsDefault =
    activeTab === DEFAULT_DASHBOARD_URL_STATE.tab &&
    !showBuildMatrix &&
    (selectedAgentId ?? "") === "" &&
    selectedDownlineAgentIds.length === 0 &&
    (focusedCustomerId ?? "") === "" &&
    wagerSportFilter === DEFAULT_DASHBOARD_URL_STATE.wSport &&
    wagerAlertFilter === DEFAULT_DASHBOARD_URL_STATE.wAlert &&
    wagerTypeFilter === DEFAULT_DASHBOARD_URL_STATE.wType &&
    wagerChannelFilter === DEFAULT_DASHBOARD_URL_STATE.wChannel &&
    wagerSortField === DEFAULT_DASHBOARD_URL_STATE.wSort &&
    wagerSortDir === DEFAULT_DASHBOARD_URL_STATE.wDir

  const handleResetView = () => {
    setActiveTab(DEFAULT_DASHBOARD_URL_STATE.tab)
    setShowBuildMatrix(false)
    setWagerSportFilter(DEFAULT_DASHBOARD_URL_STATE.wSport)
    setWagerAlertFilter(DEFAULT_DASHBOARD_URL_STATE.wAlert)
    setWagerTypeFilter(DEFAULT_DASHBOARD_URL_STATE.wType)
    setWagerChannelFilter(DEFAULT_DASHBOARD_URL_STATE.wChannel)
    setWagerSortField(DEFAULT_DASHBOARD_URL_STATE.wSort)
    setWagerSortDir(DEFAULT_DASHBOARD_URL_STATE.wDir)
    setSelectedAgentId(null)
    setSelectedDownlineAgentIds([])
    setFocusedCustomerId(null)
    setCustomerLookupNotice(null)
    setSearchQuery("")
    setRankingsFilter("ALL")
    setRankingsSearch("")
    setGlobalSearch("")
    setBetTickerSearch("")
    setSystemLogSeverityFilter("ALL")
  }

  const openWagersForShadowSlice = () => {
    setWagerChannelFilter("ALL")
    setWagerAlertFilter("ALL")
    setWagerTypeFilter("ALL")
    setWagerSportFilter(sportFilterForSlice(activeShadowSlice))
    const searchHint = wagerSearchHintForSlice(activeShadowSlice)
    setWagerSearch(searchHint)
    setActiveTab("wagers")
  }

  const [rankings, setRankings] = useState<NormalizedRankingsResult | null>(null)
  const [rankingsStatus, setRankingsStatus] = useState<"pending" | "ready" | "unavailable">(
    "pending",
  )
  const [rankingsError, setRankingsError] = useState<string | null>(null)

  const cohortProfileRows = useMemo<readonly ShowcaseCustomer[]>(() => {
    if (cohortsReport === null) return []
    const merged = mergeProfileRows(
      bookRowsToProfiles(cohortsReport.fixtures, "fixture"),
      backtestRowsToProfiles(cohortsReport.backtestAll),
    )
    return applyGraphForensicsToProfiles(merged, graphForensicsByCustomer)
  }, [cohortsReport, graphForensicsByCustomer])

  const profileCustomers = useMemo<readonly ShowcaseCustomer[]>(() => {
    if (!showBuildMatrix) return cohortProfileRows
    return mergeMatrixProfileOverlay(cohortProfileRows, rankings?.players ?? null, liveWagers)
  }, [cohortsReport, cohortProfileRows, showBuildMatrix, rankings?.players, liveWagers])

  const sharpestOnChainXref = useMemo(
    () =>
      buildSharpestOnChainXrefReport({
        profiles: profileCustomers,
        rawGraphFeed: graphLiveFeedRaw,
        bridgeSnapshot: crossDomainBridge,
      }),
    [profileCustomers, graphLiveFeedRaw, crossDomainBridge],
  )

  const matrixProfileOverlay = useMemo(() => {
    if (!showBuildMatrix) return null
    const ids = new Set(profileCustomers.map((c) => c.id.toUpperCase()))
    let liveOnly = 0
    let rankedOnly = 0
    for (const c of profileCustomers) {
      if (c.source === "live-open") liveOnly += 1
      if (c.source === "rankings") rankedOnly += 1
    }
    return {
      total: ids.size,
      liveOpen: liveOnly,
      ranked: rankedOnly,
      cohort: cohortProfileRows.length,
      liveWagersDistinct: new Set(liveWagers.map((w) => w.customerId.toUpperCase())).size,
    }
  }, [showBuildMatrix, profileCustomers, cohortProfileRows.length, liveWagers])

  const profilesProvenance =
    profileCustomers.length === 0
      ? null
      : showBuildMatrix && matrixProfileOverlay
        ? `${profileCustomers.length} profiles · matrix overlay: ${matrixProfileOverlay.cohort} cohort + ${matrixProfileOverlay.ranked} ranked + ${matrixProfileOverlay.liveOpen} live-open (${matrixProfileOverlay.liveWagersDistinct} on tape) · GET /api/customers + /api/rankings/all + /api/wagers`
        : cohortsReport === null
          ? null
          : `${profileCustomers.length} cohort customers · ${cohortsReport.fixtures.length} fixture rows + ${cohortsReport.backtestAll.length} backtest rows · ${cohortsReport.provenance.label} · GET /api/customers`

  const fetchTiersConfig = async () => {
    try {
      const res = await trackedFetch(dashboardApiUrl(DASHBOARD_API.tiers))
      if (!res.ok) return
      const cfg = (await res.json()) as { tiers?: TierStyleConfig } | null
      if (cfg?.tiers) {
        setTiersConfig(cfg.tiers)
      }
    } catch (err) {
      console.warn("[dashboard] failed to load /api/config/tiers, keeping defaults:", err)
    }
  }

  const failLiveWagers = (message: string) => {
    setWagersError(message)
    setWagersProvenance(unavailableProvenance("/api/wagers", message))
  }

  const fetchLiveWagers = async () => {
    try {
      const res = await trackedFetch(dashboardApiUrl(DASHBOARD_API.wagers))
      if (!res.ok) {
        failLiveWagers(`GET /api/wagers returned HTTP ${res.status} (${res.statusText || "error"})`)
        return
      }
      const normalized = normalizeLiveWagersResponse(await res.json())
      if (!normalized) {
        failLiveWagers("GET /api/wagers returned unexpected LiveWagersApiResponse payload")
        return
      }
      setLiveWagers(normalized.wagers)
      setWagersProvenance(normalized.provenance)
      setWireContract(normalized.wireContract)
      setSlabPolicy(normalized.slabPolicy)
      setWagersError(null)

      // Streaming: mark tickets that were not in the previous snapshot. The first load
      // is not "new" — every row would otherwise flash.
      const nextIds = new Set(normalized.wagers.map((w) => w.ticketId))
      if (hasLoadedWagersRef.current) {
        const fresh = diffNewTicketIds(seenWagerIdsRef.current, nextIds)
        if (fresh.length > 0) {
          setNewTicketIds(new Set(fresh))
          if (freshTicketsTimerRef.current !== null) {
            clearTimeout(freshTicketsTimerRef.current)
          }
          freshTicketsTimerRef.current = setTimeout(() => {
            setNewTicketIds(new Set())
            freshTicketsTimerRef.current = null
          }, 15_000)
        }
      }
      hasLoadedWagersRef.current = true
      seenWagerIdsRef.current = nextIds
      setWagersUpdatedAt(Date.now())
      if (normalized.wagers.length > 0) {
        const ticketFromUrl =
          typeof window !== "undefined"
            ? (new URLSearchParams(window.location.search).get("ticket")?.trim() ?? "")
            : ""
        const urlPick =
          ticketFromUrl !== "" ? findWagerByTicketParam(normalized.wagers, ticketFromUrl) : null
        setSelectedWager((prev) => {
          if (urlPick !== null) {
            return urlPick
          }
          if (prev && normalized.wagers.some((w) => w.ticketId === prev.ticketId)) {
            return prev
          }
          return normalized.wagers[0] ?? null
        })
      }
    } catch (err) {
      failLiveWagers(`GET /api/wagers failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const fetchCustomersCohorts = async () => {
    try {
      const res = await trackedFetch(dashboardApiUrl(DASHBOARD_API.customers))
      if (!res.ok) {
        setCohortsStatus("unavailable")
        setCohortsError(
          `GET /api/customers returned HTTP ${res.status} (${res.statusText || "error"})`,
        )
        return
      }
      const normalized = normalizeCustomersCohortResponse(await res.json())
      if (!normalized) {
        setCohortsStatus("unavailable")
        setCohortsError("GET /api/customers returned unexpected CustomersApiResponse payload")
        return
      }
      setCohortsReport(normalized)
      setCohortsStatus("ready")
      setCohortsError(null)
    } catch (err) {
      setCohortsStatus("unavailable")
      setCohortsError(
        `GET /api/customers failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const fetchGraphLiveFeedForensics = async () => {
    const [graphResult, bridgeResult] = await Promise.allSettled([
      trackedFetch("/api/graph/live-feed"),
      trackedFetch("/api/bridge/value"),
    ])
    if (graphResult.status === "fulfilled" && graphResult.value.ok) {
      try {
        const payload = (await graphResult.value.json()) as unknown
        setGraphLiveFeedRaw(payload)
      } catch {
        // Optional forensic feed; profiles continue cleanly with /api/customers backtest data.
      }
    }
    if (bridgeResult.status === "fulfilled" && bridgeResult.value.ok) {
      try {
        const bridgePayload = (await bridgeResult.value.json()) as unknown
        setCrossDomainBridge(parseCrossDomainBridgeSnapshot(bridgePayload))
      } catch {
        // Optional cross-domain bridge feed.
      }
    }
  }

  const fetchRankings = async () => {
    const slice = await fetchRankingsSlice(trackedFetch)
    if (slice.ok) {
      setRankings(slice.data)
      setRankingsStatus("ready")
      setRankingsError(null)
    } else {
      setRankingsStatus("unavailable")
      setRankingsError(slice.error)
    }
  }

  const fetchBetTicker = async () => {
    setBetTickerLoading(true)
    try {
      const res = await trackedFetch(dashboardApiUrl(DASHBOARD_API.bet_ticker))
      if (!res.ok) {
        setBetTickerError(
          `GET /api/bet-ticker returned HTTP ${res.status} (${res.statusText || "error"})`,
        )
        return
      }
      const payload = (await res.json()) as BetTickerApiResponse
      setBetTickerData(payload)
      setBetTickerError(null)
    } catch (err) {
      setBetTickerError(
        `GET /api/bet-ticker failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setBetTickerLoading(false)
    }
  }

  const fetchR2Pipeline = async (force = false) => {
    setR2PipelineLoading(true)
    try {
      const res = await trackedFetch(force ? "/api/r2/pipeline?refresh=1" : "/api/r2/pipeline")
      if (!res.ok) {
        setR2PipelineError(
          `GET /api/r2/pipeline returned HTTP ${res.status} (${res.statusText || "error"})`,
        )
        return
      }
      const payload = (await res.json()) as R2PipelineApiResponse
      const observedIso = payload.observedAt || new Date().toISOString()
      setR2PipelineData(payload)
      setR2PipelineError(null)
      setR2LastUpdatedAt(observedIso)
      setDaemon4020LastProbedAt(observedIso)
      const nextDaemonState = resolveDaemon4020State(payload.daemon4020)
      if (nextDaemonState === "online" || nextDaemonState === "degraded") {
        setDaemon4020LastUpdatedAt(observedIso)
      }
    } catch (err) {
      setR2PipelineError(
        `GET /api/r2/pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setR2PipelineLoading(false)
    }
  }

  const fetchR2PipelineHistory = async (refresh = false) => {
    try {
      const res = await trackedFetch(
        `/api/r2/pipeline/history?limit=60${refresh ? "&refresh=1" : ""}`,
      )
      if (!res.ok) {
        setR2PipelineHistoryError(`GET /api/r2/pipeline/history returned HTTP ${res.status}`)
        return
      }
      setR2PipelineHistory((await res.json()) as R2PipelineHistoryApiResponse)
      setR2PipelineHistoryError(null)
    } catch (err) {
      setR2PipelineHistoryError(
        `GET /api/r2/pipeline/history failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const runTicketVerification = async (dryRun = true) => {
    setVerifyingTickets(true)
    try {
      const res = await trackedFetch("/api/gslive/verify-tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      })
      if (!res.ok) {
        setVerifyTicketsError(`POST /api/gslive/verify-tickets returned HTTP ${res.status}`)
        return
      }
      setVerifyTicketsError(null)
      await fetchR2Pipeline(true)
    } catch (err) {
      setVerifyTicketsError(
        `POST /api/gslive/verify-tickets failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      setVerifyingTickets(false)
    }
  }

  const fetchBuildMatrix = (force = false) => {
    setBuildMatrixLoading(true)
    setBuildMatrixError(null)
    const startedAt = performance.now()
    trackedFetch(force ? "/api/build-matrix?refresh=1" : "/api/build-matrix")
      .then(async (r) => {
        if (!r.ok) {
          throw new Error(
            `GET /api/build-matrix${force ? "?refresh=1" : ""} returned HTTP ${r.status}`,
          )
        }
        return (await r.json()) as {
          targets?: readonly BuildMatrixRow[]
          generatedAt?: string
          staticDir?: StaticDirectoryProbeSummary
        }
      })
      .then((json) => {
        if (json?.targets) {
          debugDashboardTrace("loaded DCE build matrix", json)
          setBuildMatrixRows(json.targets)
          setBuildMatrixGeneratedAt(typeof json.generatedAt === "string" ? json.generatedAt : null)
          setBuildMatrixCompiledMs(Math.round(performance.now() - startedAt))
          setBuildMatrixStaticDir(json.staticDir ?? null)
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn("Build matrix probe unavailable:", err)
        setBuildMatrixError(msg)
      })
      .finally(() => setBuildMatrixLoading(false))
  }

  // UI enhancement states: banner dismissal & collapsible KPI cards
  const [bannerDismissed, setBannerDismissed] = useState(
    () =>
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem("portalBannerDismissed") === "1",
  )
  const [kpisCollapsed, setKpisCollapsed] = useState(() => {
    try {
      return localStorage.getItem("kpisCollapsed") === "1"
    } catch {
      return false
    }
  })

  // Alerts, DLQ, and Operator Shift state
  const [alertRecords, setAlertRecords] = useState<DashboardAlertRecord[]>([])
  const [alertFilter, setAlertFilter] = useState<AlertFilter>("ALL")
  const [alertLoading, setAlertLoading] = useState(false)
  const [alertToast, setAlertToast] = useState<AlertToastState | null>(null)
  const [healthData, setHealthData] = useState<HealthData | null>(null)
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false)
  const [dashboardTheme, setDashboardTheme] = useState<DashboardTheme>(() =>
    readStoredDashboardTheme(),
  )
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  useEffect(() => {
    if (!mobileNavOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [mobileNavOpen])
  const [handoffInitiatedShiftAt, setHandoffInitiatedShiftAt] = useState<number | null>(null)
  const [handoffAlertDismissedShiftAt, setHandoffAlertDismissedShiftAt] = useState<number | null>(
    null,
  )
  const [shiftSummary, setShiftSummary] = useState<ShiftSummaryData | null>(null)
  const [shiftLogs, setShiftLogs] = useState<readonly ShiftSessionLogEntry[]>([])
  const [shiftLogsLoading, setShiftLogsLoading] = useState(false)
  const [shiftLogsError, setShiftLogsError] = useState<string | null>(null)
  const loggedShiftStartRef = useRef<number | null>(null)
  const [configStatusSnapshot, setConfigStatusSnapshot] = useState<ConfigStatusSnapshot | null>(
    null,
  )
  const [configStatusLoading, setConfigStatusLoading] = useState(false)
  const [configStatusError, setConfigStatusError] = useState<string | null>(null)
  const [configStatusSaving, setConfigStatusSaving] = useState(false)
  const [configStatusNotice, setConfigStatusNotice] = useState<{
    readonly type: "success" | "error"
    readonly message: string
  } | null>(null)
  const [shiftOperator, setShiftOperator] = useState<string>(() => {
    try {
      const saved =
        typeof localStorage !== "undefined"
          ? localStorage.getItem("sportsdesk_operator")?.trim()
          : ""
      return saved || "operator"
    } catch {
      return "operator"
    }
  })
  const [operatorSignedOut, setOperatorSignedOut] = useState(false)
  const [operatorSignedInAt, setOperatorSignedInAt] = useState<number | null>(() => {
    try {
      if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem("sportsdesk_shift_started_at")
        const parsed = raw ? Number(raw) : NaN
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= Date.now()) {
          return parsed
        }
        const now = Date.now()
        localStorage.setItem("sportsdesk_shift_started_at", String(now))
        return now
      }
    } catch {}
    return Date.now()
  })
  const [activeShiftSeconds, setActiveShiftSeconds] = useState<number>(() =>
    operatorSignedInAt !== null
      ? Math.max(0, Math.floor((Date.now() - operatorSignedInAt) / 1000))
      : 0,
  )
  const [operatorLoginInput, setOperatorLoginInput] = useState<string>("")
  const [operatorTokenInput, setOperatorTokenInput] = useState<string>("")
  const [showTokenPlaintext, setShowTokenPlaintext] = useState<boolean>(false)
  const [authSubmitError, setAuthSubmitError] = useState<string | null>(null)
  const [authSubmitting, setAuthSubmitting] = useState<boolean>(false)
  const [devAutoSignIn, setDevAutoSignIn] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("sportsdesk_dev_auto_signin")
      return saved === null ? true : saved === "1"
    } catch {
      return true
    }
  })
  const [devPreferredRole, setDevPreferredRole] = useState<"OPERATOR" | "ADMIN">(() => {
    try {
      return localStorage.getItem("sportsdesk_dev_role") === "ADMIN" ? "ADMIN" : "OPERATOR"
    } catch {
      return "OPERATOR"
    }
  })
  const initialFastSignInTokenRef = useRef<string | null | undefined>(undefined)
  if (initialFastSignInTokenRef.current === undefined) {
    initialFastSignInTokenRef.current = extractAndScrubFastSignInToken().token
  }
  const [fastSignInPending, setFastSignInPending] = useState<boolean>(
    () => initialFastSignInTokenRef.current !== null,
  )
  const [currentFastBookmarkUrl, setCurrentFastBookmarkUrl] = useState<string | null>(null)
  const devAutoAttemptedRef = useRef<boolean>(false)
  const [terminalAdminToken, setTerminalAdminToken] = useState<string>("")
  const [serverAuthState, setServerAuthState] = useState<{
    readonly checked: boolean
    readonly authenticated: boolean
    readonly authRequired: boolean
    readonly authConfigured: boolean
    readonly adminConfigured: boolean
    readonly devQuickLoginAvailable: boolean
    readonly role: string | null
  }>({
    checked: false,
    authenticated: false,
    authRequired: true,
    authConfigured: true,
    adminConfigured: false,
    devQuickLoginAvailable: false,
    role: null,
  })
  const [shiftLoading, setShiftLoading] = useState(false)

  const authReady =
    serverAuthState.checked && (!serverAuthState.authRequired || serverAuthState.authenticated)

  useEffect(() => {
    if (!authReady) return
    setWagersError(null)
    setWagersProvenance(PENDING_WAGERS_PROVENANCE)
    setCohortsStatus("pending")
    setCohortsError(null)
    setRankingsStatus("pending")
    setRankingsError(null)
    setBetTickerError(null)
    setR2PipelineError(null)
    setR2PipelineHistoryError(null)
    void fetchTiersConfig()
    void fetchLiveWagers()
    void fetchCustomersCohorts()
    void fetchGraphLiveFeedForensics()
    void fetchRankings()
    void fetchBetTicker()
    // The pipeline probe records the first history sample, so read history after it.
    void fetchR2Pipeline().then(() => fetchR2PipelineHistory())
  }, [authReady])

  useEffect(() => {
    if (authReady && showBuildMatrix && !buildMatrixRows && !buildMatrixLoading) {
      fetchBuildMatrix()
    }
  }, [showBuildMatrix, authReady])

  const toggleDevAutoSignIn = (nextVal: boolean) => {
    setDevAutoSignIn(nextVal)
    try {
      localStorage.setItem("sportsdesk_dev_auto_signin", nextVal ? "1" : "0")
    } catch {}
  }

  const performDevQuickSignIn = async (
    role: "OPERATOR" | "ADMIN",
    customOperatorId?: string,
  ): Promise<boolean> => {
    setAuthSubmitError(null)
    setAuthSubmitting(true)
    const desiredOp =
      (customOperatorId ?? operatorLoginInput).trim() ||
      (role === "ADMIN" ? "dev-admin" : "dev-operator")
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          devQuickLogin: true,
          role,
          operatorId: desiredOp,
        }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        authenticated?: boolean
        operatorId?: string
        role?: string
        adminConfigured?: boolean
        devSessionToken?: string
        csrfToken?: string
        error?: string
      }
      if (!res.ok || !payload.authenticated) {
        setAuthSubmitError(payload.error || `Dev sign-in failed (HTTP ${res.status})`)
        return false
      }
      if (typeof payload.devSessionToken === "string") {
        setDevSessionToken(payload.devSessionToken)
      }
      if (typeof payload.csrfToken === "string") {
        setDevCsrfToken(payload.csrfToken)
      }
      setDevPreferredRole(role)
      try {
        localStorage.setItem("sportsdesk_dev_role", role)
      } catch {}
      const resolvedOp =
        typeof payload.operatorId === "string" && payload.operatorId.trim()
          ? payload.operatorId.trim()
          : desiredOp
      const startedAt = Date.now()
      handleOperatorChange(resolvedOp)
      setOperatorSignedInAt(startedAt)
      setOperatorSignedOut(false)
      try {
        localStorage.setItem("sportsdesk_shift_started_at", String(startedAt))
      } catch {}
      setServerAuthState((prev) => ({
        ...prev,
        checked: true,
        authenticated: true,
        role: typeof payload.role === "string" ? payload.role : role,
        adminConfigured:
          typeof payload.adminConfigured === "boolean"
            ? payload.adminConfigured
            : prev.adminConfigured,
      }))
      setWsReconnectNonce((n) => n + 1)
      return true
    } catch (err) {
      setAuthSubmitError(err instanceof Error ? err.message : "Unable to reach auth server")
      return false
    } finally {
      setAuthSubmitting(false)
    }
  }

  useEffect(() => {
    let active = true
    const abortController = new AbortController()

    const loadAuthMe = async () => {
      const devToken = getDevSessionToken()
      const meHeaders: Record<string, string> = {}
      if (devToken) {
        meHeaders.Authorization = `Bearer ${devToken}`
      }
      try {
        const res = await fetch("/api/auth/me", {
          credentials: "include",
          cache: "no-store",
          headers: meHeaders,
          signal: abortController.signal,
        })
        const payload = res.ok
          ? ((await res.json()) as {
              authenticated?: boolean
              authRequired?: boolean
              authConfigured?: boolean
              adminConfigured?: boolean
              devQuickLoginAvailable?: boolean
              operatorId?: string | null
              role?: string | null
            })
          : null
        if (!active) return
        if (!payload) {
          setServerAuthState({
            checked: true,
            authenticated: false,
            authRequired: true,
            authConfigured: false,
            adminConfigured: false,
            devQuickLoginAvailable: false,
            role: null,
          })
          return
        }
        const authenticated = payload.authenticated === true
        const authRequired = payload.authRequired !== false
        const devQuickLoginAvailable = payload.devQuickLoginAvailable === true
        if (!authenticated && devToken) {
          setDevSessionToken(null)
          setDevCsrfToken(null)
        }
        setServerAuthState({
          checked: true,
          authenticated,
          authRequired,
          authConfigured: payload.authConfigured !== false,
          adminConfigured: payload.adminConfigured === true,
          devQuickLoginAvailable,
          role: typeof payload.role === "string" ? payload.role : null,
        })
        if (authenticated && typeof payload.operatorId === "string" && payload.operatorId.trim()) {
          handleOperatorChange(payload.operatorId.trim())
        }
      } catch {
        if (!active) return
        setServerAuthState((prev) => ({
          ...prev,
          checked: true,
          authenticated: false,
          authRequired: true,
        }))
      }
    }

    const bootstrapAuth = async () => {
      const pendingFastToken = initialFastSignInTokenRef.current
      if (pendingFastToken) {
        try {
          const res = await fetch("/api/auth/login", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fastToken: pendingFastToken }),
            signal: abortController.signal,
          })
          const payload = (await res.json().catch(() => ({}))) as {
            ok?: boolean
            authenticated?: boolean
            authRequired?: boolean
            authConfigured?: boolean
            adminConfigured?: boolean
            devQuickLoginAvailable?: boolean
            operatorId?: string
            role?: string
            devSessionToken?: string
            csrfToken?: string
            error?: string
          }
          if (!active) return
          initialFastSignInTokenRef.current = null
          if (res.ok && payload.authenticated) {
            if (typeof payload.devSessionToken === "string") {
              setDevSessionToken(payload.devSessionToken)
            }
            if (typeof payload.csrfToken === "string") {
              setDevCsrfToken(payload.csrfToken)
            }
            const resolvedOp =
              typeof payload.operatorId === "string" && payload.operatorId.trim()
                ? payload.operatorId.trim()
                : "desk-operator"
            const startedAt = Date.now()
            handleOperatorChange(resolvedOp)
            setOperatorSignedInAt(startedAt)
            setOperatorSignedOut(false)
            setAuthSubmitError(null)
            try {
              localStorage.setItem("sportsdesk_shift_started_at", String(startedAt))
            } catch {}
            setServerAuthState({
              checked: true,
              authenticated: true,
              authRequired: payload.authRequired !== false,
              authConfigured: payload.authConfigured !== false,
              adminConfigured: payload.adminConfigured === true,
              devQuickLoginAvailable: payload.devQuickLoginAvailable === true,
              role: typeof payload.role === "string" ? payload.role : "OPERATOR",
            })
            setCurrentFastBookmarkUrl(
              buildFastSignInBookmarkUrl(window.location.href, pendingFastToken),
            )
            setFastSignInPending(false)
            setWsReconnectNonce((n) => n + 1)
            return
          }
          setAuthSubmitError(
            payload.error ||
              "Fast Sign-In token is invalid or expired. Sign in manually to continue.",
          )
          setFastSignInPending(false)
        } catch (err) {
          if (!active || abortController.signal.aborted) return
          initialFastSignInTokenRef.current = null
          setAuthSubmitError(
            err instanceof Error ? err.message : "Unable to verify Fast Sign-In token.",
          )
          setFastSignInPending(false)
        }
      } else {
        setFastSignInPending(false)
      }
      await loadAuthMe()
    }

    void bootstrapAuth()

    const unregister = registerUnauthorizedListener(() => {
      setDevSessionToken(null)
      setDevCsrfToken(null)
      setServerAuthState((prev) =>
        prev.authRequired && prev.authenticated
          ? { ...prev, authenticated: false, role: null }
          : prev,
      )
      setAuthSubmitError("Session expired or unauthorized. Sign in to continue.")
    })

    return () => {
      active = false
      abortController.abort()
      unregister()
    }
  }, [])

  // Fast dev workflow: when running on the explicit dev server and auto sign-in
  // is enabled, establish a dev session automatically on initial load so
  // reloads don't interrupt development (unless the user explicitly signed out).
  useEffect(() => {
    if (
      fastSignInPending ||
      !serverAuthState.checked ||
      serverAuthState.authenticated ||
      !serverAuthState.authRequired ||
      !serverAuthState.devQuickLoginAvailable ||
      !devAutoSignIn ||
      operatorSignedOut ||
      devAutoAttemptedRef.current
    ) {
      return
    }
    devAutoAttemptedRef.current = true
    void performDevQuickSignIn(devPreferredRole)
  }, [
    fastSignInPending,
    serverAuthState.checked,
    serverAuthState.authenticated,
    serverAuthState.authRequired,
    serverAuthState.devQuickLoginAvailable,
    devAutoSignIn,
    operatorSignedOut,
    devPreferredRole,
  ])

  useEffect(() => {
    if (operatorSignedInAt === null || operatorSignedOut) {
      setActiveShiftSeconds(0)
      return
    }
    const syncShiftSeconds = () => {
      setActiveShiftSeconds(Math.max(0, Math.floor((Date.now() - operatorSignedInAt) / 1000)))
    }
    syncShiftSeconds()
    const timerId = setInterval(syncShiftSeconds, 1000)
    return () => clearInterval(timerId)
  }, [operatorSignedInAt, operatorSignedOut])

  useEffect(() => {
    applyDashboardThemeToDocument(dashboardTheme)
  }, [dashboardTheme])

  const handleOperatorChange = (nextOperator: string) => {
    setShiftOperator(nextOperator)
    try {
      const trimmed = nextOperator.trim()
      if (trimmed) {
        localStorage.setItem("sportsdesk_operator", trimmed)
      }
    } catch {}
  }

  const handleOperatorLogout = () => {
    const devToken = getDevSessionToken()
    const csrf = getCsrfToken()
    const logoutHeaders: Record<string, string> = {
      "X-Operator-Id": shiftOperator,
    }
    if (csrf) {
      logoutHeaders["x-csrf-token"] = csrf
    }
    if (devToken) {
      logoutHeaders.Authorization = `Bearer ${devToken}`
    }
    void fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
      headers: logoutHeaders,
    }).catch(() => {})
    setDevSessionToken(null)
    setDevCsrfToken(null)
    setOperatorLoginInput(shiftOperator)
    setOperatorTokenInput("")
    setTerminalAdminToken("")
    setAuthSubmitError(null)
    setOperatorSignedOut(true)
    setOperatorSignedInAt(null)
    setCurrentFastBookmarkUrl(null)
    setIsShiftModalOpen(false)
    setSelectedAgentId(null)
    setGlobalSearch("")
    setServerAuthState((prev) => ({
      ...prev,
      authenticated: !prev.authRequired,
      role: null,
    }))
    try {
      localStorage.removeItem("sportsdesk_operator")
      localStorage.removeItem("sportsdesk_shift_started_at")
    } catch {}
  }

  const handleOperatorSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setAuthSubmitError(null)
    const next = operatorLoginInput.trim() || shiftOperator.trim() || "operator"

    if (serverAuthState.authRequired) {
      setAuthSubmitting(true)
      try {
        const trimmedTokenInput = operatorTokenInput.trim()
        const urlFastToken = trimmedTokenInput.includes("fast_signin=")
          ? extractFastSignInTokenFromInput(trimmedTokenInput)
          : null
        const res = await fetch("/api/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            urlFastToken
              ? { operatorId: next, fastToken: urlFastToken }
              : { operatorId: next, token: operatorTokenInput },
          ),
        })
        const payload = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          authenticated?: boolean
          operatorId?: string
          role?: string
          adminConfigured?: boolean
          devSessionToken?: string
          csrfToken?: string
          error?: string
        }
        if (!res.ok || !payload.authenticated) {
          setAuthSubmitError(payload.error || `Sign-in failed (HTTP ${res.status})`)
          return
        }
        if (typeof payload.devSessionToken === "string") {
          setDevSessionToken(payload.devSessionToken)
        }
        if (typeof payload.csrfToken === "string") {
          setDevCsrfToken(payload.csrfToken)
        }
        setOperatorTokenInput("")
        setServerAuthState((prev) => ({
          ...prev,
          checked: true,
          authenticated: true,
          role: typeof payload.role === "string" ? payload.role : "OPERATOR",
          adminConfigured:
            typeof payload.adminConfigured === "boolean"
              ? payload.adminConfigured
              : prev.adminConfigured,
        }))
        setWsReconnectNonce((n) => n + 1)
      } catch (err) {
        setAuthSubmitError(err instanceof Error ? err.message : "Unable to reach auth server")
        return
      } finally {
        setAuthSubmitting(false)
      }
    }

    const startedAt = Date.now()
    handleOperatorChange(next)
    setOperatorSignedInAt(startedAt)
    try {
      localStorage.setItem("sportsdesk_shift_started_at", String(startedAt))
    } catch {}
    setOperatorSignedOut(false)
  }

  const handleMintSignInModalQrBookmark = async (ttlMinutes: number) => {
    const trimmedCredential = operatorTokenInput.trim()
    if (!serverAuthState.devQuickLoginAvailable && trimmedCredential.length === 0) {
      return {
        ok: false,
        error:
          "Enter your Desk Access Token above first, or paste an existing Fast Sign-In bookmark URL below.",
      }
    }

    const desiredOperator =
      operatorLoginInput.trim() ||
      shiftOperator.trim() ||
      (devPreferredRole === "ADMIN" ? "dev-admin" : "desk-operator")

    const requestBody =
      trimmedCredential.length > 0
        ? {
            token: trimmedCredential,
            operatorId: desiredOperator,
            mintFastSignInOnly: true,
            ttlMinutes,
          }
        : {
            devQuickLogin: true,
            role: devPreferredRole,
            operatorId: desiredOperator,
            mintFastSignInOnly: true,
            ttlMinutes,
          }

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        fastToken?: string
        expiresAtIso?: string
        role?: string
        error?: string
      }
      if (!res.ok || !payload.ok || typeof payload.fastToken !== "string") {
        return {
          ok: false,
          error: payload.error || `Unable to mint Fast Sign-In QR (HTTP ${res.status})`,
        }
      }
      const bookmarkUrl = buildFastSignInBookmarkUrl(window.location.href, payload.fastToken)
      setCurrentFastBookmarkUrl(bookmarkUrl)
      return {
        ok: true,
        bookmarkUrl,
        expiresAtIso: payload.expiresAtIso,
        role: payload.role,
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Unable to reach auth server for QR bookmark",
      }
    }
  }

  const handleRedeemFastSignInToken = async (fastToken: string): Promise<boolean> => {
    setAuthSubmitError(null)
    setAuthSubmitting(true)
    try {
      const desiredOp = operatorLoginInput.trim() || undefined
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fastToken,
          ...(desiredOp ? { operatorId: desiredOp } : {}),
        }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        authenticated?: boolean
        authRequired?: boolean
        authConfigured?: boolean
        adminConfigured?: boolean
        devQuickLoginAvailable?: boolean
        operatorId?: string
        role?: string
        devSessionToken?: string
        csrfToken?: string
        error?: string
      }
      if (!res.ok || !payload.authenticated) {
        setAuthSubmitError(payload.error || "Fast Sign-In bookmark token is invalid or expired.")
        return false
      }
      if (typeof payload.devSessionToken === "string") {
        setDevSessionToken(payload.devSessionToken)
      }
      if (typeof payload.csrfToken === "string") {
        setDevCsrfToken(payload.csrfToken)
      }
      const resolvedOp =
        typeof payload.operatorId === "string" && payload.operatorId.trim()
          ? payload.operatorId.trim()
          : desiredOp || "desk-operator"
      const startedAt = Date.now()
      handleOperatorChange(resolvedOp)
      setOperatorSignedInAt(startedAt)
      setOperatorSignedOut(false)
      setCurrentFastBookmarkUrl(buildFastSignInBookmarkUrl(window.location.href, fastToken))
      try {
        localStorage.setItem("sportsdesk_shift_started_at", String(startedAt))
      } catch {}
      setServerAuthState({
        checked: true,
        authenticated: true,
        authRequired: payload.authRequired !== false,
        authConfigured: payload.authConfigured !== false,
        adminConfigured: payload.adminConfigured === true,
        devQuickLoginAvailable: payload.devQuickLoginAvailable === true,
        role: typeof payload.role === "string" ? payload.role : "OPERATOR",
      })
      setWsReconnectNonce((n) => n + 1)
      return true
    } catch (err) {
      setAuthSubmitError(
        err instanceof Error ? err.message : "Unable to redeem Fast Sign-In bookmark",
      )
      return false
    } finally {
      setAuthSubmitting(false)
    }
  }

  const handleMintFastSignInBookmark = async (ttlMinutes: number) => {
    try {
      const res = await trackedFetch("/api/auth/fast-signin", {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({
          ttlMinutes,
          operatorId: shiftOperator,
          role: serverAuthState.role === "ADMIN" ? "ADMIN" : "OPERATOR",
        }),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        token?: string
        expiresAtIso?: string
        activeCount?: number
        error?: string
      }
      if (!res.ok || !payload.ok || typeof payload.token !== "string") {
        return {
          ok: false,
          error: payload.error || `Failed to generate Fast Sign-In token (HTTP ${res.status})`,
        }
      }
      const bookmarkUrl = buildFastSignInBookmarkUrl(window.location.href, payload.token)
      setCurrentFastBookmarkUrl(bookmarkUrl)
      return {
        ok: true,
        bookmarkUrl,
        expiresAtIso: payload.expiresAtIso,
        activeCount: payload.activeCount,
      }
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "Unable to reach auth server for bookmark token",
      }
    }
  }

  const handleRevokeFastSignInBookmarks = async () => {
    try {
      const res = await trackedFetch("/api/auth/fast-signin", {
        method: "DELETE",
        headers: apiPostHeaders(),
      })
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        revokedCount?: number
        error?: string
      }
      if (!res.ok || !payload.ok) {
        return {
          ok: false,
          error: payload.error || `Failed to revoke Fast Sign-In links (HTTP ${res.status})`,
        }
      }
      setCurrentFastBookmarkUrl(null)
      return {
        ok: true,
        revokedCount: payload.revokedCount ?? 0,
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Unable to revoke active links",
      }
    }
  }

  const fetchHealth = () => {
    const requestStartedAt = Date.now()
    const healthEndpoint = authReady ? "/api/health/detail" : "/api/health"
    return trackedFetch(healthEndpoint)
      .then(async (res) => {
        const responseReceivedAt = Date.now()
        if (!res.ok) return null
        const contentType = res.headers.get("content-type") ?? ""
        if (contentType !== "" && !contentType.toLowerCase().includes("json")) {
          return null
        }
        const dateHeader = res.headers.get("date")
        const health = (await res.json().catch(() => null)) as HealthData | null
        if (!health) return null
        return {
          health,
          requestStartedAt,
          responseReceivedAt,
          dateHeader,
        }
      })
      .then((result) => {
        if (!result) return
        const { health, requestStartedAt, responseReceivedAt, dateHeader } = result
        const measuredAtIso = new Date(responseReceivedAt).toISOString()
        setHealthData(health)
        setHealthLastUpdatedAt(measuredAtIso)
        const serverSource = health.timestamp ?? dateHeader ?? undefined
        const serverMs = serverSource ? Date.parse(serverSource) : NaN
        if (Number.isFinite(serverMs)) {
          const rttMs = Math.max(0, responseReceivedAt - requestStartedAt)
          const clientMidpointMs = Math.round((requestStartedAt + responseReceivedAt) / 2)
          const offsetMs = clientMidpointMs - serverMs
          setClockDrift({
            offsetMs,
            rttMs,
            serverIso: new Date(serverMs).toISOString(),
            measuredAtIso,
          })
          setClockDriftHistory((prev) => {
            const cutoff = responseReceivedAt - CLOCK_DRIFT_WINDOW_MS
            const next = [
              ...prev.filter((pt) => pt.tsMs >= cutoff),
              { tsMs: responseReceivedAt, offsetMs, rttMs },
            ].slice(-120)
            try {
              if (typeof sessionStorage !== "undefined") {
                sessionStorage.setItem(CLOCK_DRIFT_HISTORY_STORAGE_KEY, JSON.stringify(next))
              }
            } catch {}
            return next
          })
        }
      })
      .catch(() => {})
  }

  const handleRefreshTelemetry = async () => {
    if (telemetryRefreshing) return
    setTelemetryRefreshing(true)
    setTelemetryProbeError(null)
    const startedAt = performance.now()
    try {
      if (!connected) {
        setWsReconnectNonce((n) => n + 1)
      }
      const results = await Promise.allSettled([
        fetchR2Pipeline(true),
        fetchR2PipelineHistory(true),
        fetchHealth(),
        fetchCustomersCohorts(),
        fetchGraphLiveFeedForensics(),
        fetchLiveWagers(),
      ])
      const rejected = results.find((r) => r.status === "rejected")
      if (rejected && rejected.status === "rejected") {
        setTelemetryProbeError(
          rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
        )
      }
      setLastTelemetryProbeAt(new Date().toISOString())
      setLastTelemetryProbeMs(Math.max(1, Math.round(performance.now() - startedAt)))
    } finally {
      setTelemetryRefreshing(false)
    }
  }

  useSportsDeskWebMcp(
    {
      activeTab,
      hasLiveWagerSnapshot,
      liveWagers,
      profileCustomers,
      alertRecords,
      riskThresholds,
      riskThresholdEvaluation,
      rolling60mIncludedTickets: rolling60mRiskSeries.includedTickets,
      rolling60mAnchorMs,
      sharpestOnChainXref,
      wsConnected: connected,
      wsLastPongAt,
      wsLastSyncAt,
      wsLatencyMs,
      wagersUpdatedAt,
      lastTelemetryProbeAt,
    },
    {
      setActiveTab,
      applyWagerFilters: (filters) => {
        if (filters.sport !== undefined) setWagerSportFilter(filters.sport)
        if (filters.alert !== undefined) setWagerAlertFilter(filters.alert)
        if (filters.search !== undefined) setWagerSearch(filters.search)
      },
      focusCustomer: (customerId) => {
        setFocusedCustomerId(customerId)
      },
      updateRiskThresholds: handleChangeRiskExposureThresholds,
      refreshTelemetry: handleRefreshTelemetry,
      fetchApi: (path, init) => {
        const isPost = (init?.method ?? "GET").toUpperCase() === "POST"
        const headers = isPost
          ? {
              ...(apiPostHeaders() as Record<string, string>),
              ...(init?.headers as Record<string, string> | undefined),
            }
          : init?.headers
        return trackedFetch(dashboardApiUrl(path), {
          ...init,
          headers,
        })
      },
    },
  )

  const handleToggleProfileTag = (tagId: string) => {
    setActiveProfileTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId],
    )
  }

  const handleClearProfileTags = () => {
    setActiveProfileTagIds([])
    setProfileTagCategoryFilter("ALL")
  }

  const handleAddCustomProfileTag = (customerId: string, rawLabel: string) => {
    const label = normalizeCustomTagLabel(rawLabel)
    if (!label) return
    const key = customerId.toUpperCase()
    setCustomProfileTags((prev) => {
      const existing = prev[key] ?? []
      if (existing.includes(label)) return prev
      const next = { ...prev, [key]: [...existing, label] }
      saveCustomProfileTagsMap(next)
      return next
    })
  }

  const handleRemoveCustomProfileTag = (customerId: string, tagLabel: string) => {
    const key = customerId.toUpperCase()
    const target = normalizeCustomTagLabel(tagLabel)
    setCustomProfileTags((prev) => {
      const existing = prev[key] ?? []
      const filtered = existing.filter((item) => item !== target)
      const next = { ...prev }
      if (filtered.length > 0) {
        next[key] = filtered
      } else {
        delete next[key]
      }
      saveCustomProfileTagsMap(next)
      return next
    })
  }

  const fetchAlerts = (filter = alertFilter) => {
    setAlertLoading(true)
    const param = filter.toLowerCase()
    trackedFetch(`/api/alerts?status=${param}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((res) => {
        if (res?.alerts) {
          setAlertRecords(res.alerts)
        }
      })
      .catch((err) => {
        console.warn("[alerts] fetch failed:", err)
      })
      .finally(() => setAlertLoading(false))
  }

  const fetchShiftSummary = async (operatorId = shiftOperator) => {
    setShiftLoading(true)
    try {
      const res = await trackedFetch(
        `/api/shift/summary?operatorId=${encodeURIComponent(operatorId)}`,
      )
      if (res.ok) {
        const summary = await res.json()
        setShiftSummary(summary)
      }
    } catch (e) {
      console.warn("[shift] summary fetch failed:", e)
    } finally {
      setShiftLoading(false)
    }
  }

  const fetchShiftLogs = async (sinceMs = operatorSignedInAt) => {
    setShiftLogsLoading(true)
    setShiftLogsError(null)
    try {
      const qs = new URLSearchParams({ limit: "100" })
      if (typeof sinceMs === "number" && Number.isFinite(sinceMs) && sinceMs > 0) {
        qs.set("since", String(sinceMs))
      }
      const res = await trackedFetch(`/api/shift/logs?${qs.toString()}`)
      if (res.ok) {
        const payload = (await res.json()) as ShiftSessionLogsResponse
        setShiftLogs(Array.isArray(payload.logs) ? payload.logs : [])
      } else {
        setShiftLogsError(`Unable to load session logs (HTTP ${res.status})`)
      }
    } catch (e) {
      console.warn("[shift] session logs fetch failed:", e)
      setShiftLogsError("Unable to load session logs from server.")
    } finally {
      setShiftLogsLoading(false)
    }
  }

  const recordShiftSessionLog = async (input: {
    readonly action: ShiftSessionAction
    readonly operatorId?: string | undefined
    readonly summary: string
    readonly detail?: string | undefined
    readonly targetId?: string | undefined
    readonly timestamp?: number | string | undefined
  }): Promise<ShiftSessionLogEntry | null> => {
    try {
      const res = await trackedFetch("/api/shift/logs", {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({
          action: input.action,
          operatorId: input.operatorId ?? shiftOperator,
          summary: input.summary,
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.targetId ? { targetId: input.targetId } : {}),
          ...(input.timestamp !== undefined ? { timestamp: input.timestamp } : {}),
        }),
      })
      if (!res.ok) return null
      const payload = (await res.json()) as {
        ok?: boolean
        entry?: ShiftSessionLogEntry
      }
      if (payload?.entry) {
        const created = payload.entry
        setShiftLogs((prev) => [created, ...prev.filter((item) => item.id !== created.id)])
        return created
      }
      return null
    } catch (e) {
      console.warn("[shift] session log record failed:", e)
      return null
    }
  }

  useEffect(() => {
    if (!authReady || operatorSignedOut || operatorSignedInAt === null) return
    if (loggedShiftStartRef.current === operatorSignedInAt) return
    loggedShiftStartRef.current = operatorSignedInAt
    let active = true
    const shiftStart = operatorSignedInAt
    const op = shiftOperator
    void (async () => {
      try {
        const checkRes = await trackedFetch(
          `/api/shift/logs?since=${encodeURIComponent(String(shiftStart))}&action=login&limit=1`,
        )
        if (!active || !checkRes.ok) return
        const payload = (await checkRes.json()) as ShiftSessionLogsResponse
        if (active && payload.count === 0) {
          await recordShiftSessionLog({
            action: "login",
            operatorId: op,
            summary: `Operator ${op} shift session active`,
            timestamp: shiftStart,
          })
        }
      } catch {
        // Non-blocking shift login seed
      }
    })()
    return () => {
      active = false
    }
  }, [authReady, operatorSignedOut, operatorSignedInAt])

  const openShiftHandoffModal = (operatorId = shiftOperator) => {
    if (operatorSignedInAt !== null) {
      setHandoffInitiatedShiftAt(operatorSignedInAt)
    }
    setIsShiftModalOpen(true)
    void fetchShiftSummary(operatorId)
    void (async () => {
      await recordShiftSessionLog({
        action: "handoff_initiated",
        operatorId,
        summary: `Shift handoff opened (${formatShiftSecondsClock(activeShiftSeconds)} elapsed)`,
      })
      await fetchShiftLogs(operatorSignedInAt)
    })()
  }

  const shiftHandoffInitiated =
    operatorSignedInAt !== null && handoffInitiatedShiftAt === operatorSignedInAt
  const shiftHandoffAlertDismissed =
    operatorSignedInAt !== null && handoffAlertDismissedShiftAt === operatorSignedInAt
  const showShiftHandoffAlert =
    authReady &&
    shouldTriggerShiftHandoffAlert({
      operatorSignedInAt,
      elapsedSeconds: activeShiftSeconds,
      signedOut: operatorSignedOut,
      handoffInitiated: shiftHandoffInitiated,
      dismissed: shiftHandoffAlertDismissed,
      isShiftModalOpen,
    })

  const handleAckAlert = async (deliveryId: string, notes?: string) => {
    try {
      const res = await trackedFetch(`/api/alerts/${deliveryId}/ack`, {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ operatorId: shiftOperator, notes }),
      })
      if (res.ok) {
        setAlertToast({
          message: `Alert ${deliveryId.slice(0, 8)} acknowledged`,
          type: "success",
        })
        fetchAlerts(alertFilter)
        fetchHealth()
        if (isShiftModalOpen) {
          void fetchShiftLogs(operatorSignedInAt)
        }
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }))
        setAlertToast({
          message: `Ack failed: ${err.error ?? res.statusText}`,
          type: "error",
        })
      }
    } catch (e) {
      setAlertToast({ message: `Ack failed: ${String(e)}`, type: "error" })
    }
  }

  const handleRetryAlert = async (deliveryId: string) => {
    try {
      const res = await trackedFetch(`/api/alerts/${deliveryId}/retry`, {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ operatorId: shiftOperator }),
      })
      if (res.ok) {
        const payload = await res.json()
        setAlertToast({
          message: `DLQ Replayed! New UUID: ${payload.newDeliveryId?.slice(0, 8)}`,
          type: "success",
        })
        fetchAlerts(alertFilter)
        fetchHealth()
        if (isShiftModalOpen) {
          void fetchShiftLogs(operatorSignedInAt)
        }
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }))
        setAlertToast({
          message: `Retry failed: ${err.error ?? res.statusText}`,
          type: "error",
        })
      }
    } catch (e) {
      setAlertToast({ message: `Retry failed: ${String(e)}`, type: "error" })
    }
  }

  const handleSweepAlerts = async () => {
    try {
      const res = await trackedFetch(`/api/alerts/sweep`, {
        method: "POST",
        headers: {
          ...apiPostHeaders(),
          "X-Operator-Id": shiftOperator,
        },
      })
      if (res.ok) {
        const payload = await res.json()
        setAlertToast({
          message: `Queue Swept: ${payload.sweep?.sent ?? 0} sent, ${payload.sweep?.failed ?? 0} failed, ${payload.sweep?.dead ?? 0} dead`,
          type: "info",
        })
        fetchAlerts(alertFilter)
        fetchHealth()
        if (isShiftModalOpen) {
          void fetchShiftLogs(operatorSignedInAt)
        }
      }
    } catch (e) {
      setAlertToast({ message: `Sweep failed: ${String(e)}`, type: "error" })
    }
  }

  const fetchConfigStatus = async () => {
    setConfigStatusLoading(true)
    setConfigStatusError(null)
    try {
      const res = await trackedFetch("/api/config/status")
      if (res.ok) {
        const snapshot = (await res.json()) as ConfigStatusSnapshot
        setConfigStatusSnapshot(snapshot)
      } else {
        setConfigStatusError(`Unable to load configuration status (HTTP ${res.status})`)
      }
    } catch (e) {
      console.warn("[config-status] fetch failed:", e)
      setConfigStatusError("Unable to load configuration status from server.")
    } finally {
      setConfigStatusLoading(false)
    }
  }

  const handleSaveConfigOverrides = async (
    overrides: Readonly<Record<string, string>>,
  ): Promise<boolean> => {
    setConfigStatusSaving(true)
    setConfigStatusNotice(null)
    try {
      const res = await trackedFetch("/api/config/status", {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({ overrides }),
      })
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean
        savedKeys?: readonly string[]
        snapshot?: ConfigStatusSnapshot
        error?: string
      } | null
      if (res.ok && payload?.ok && payload.snapshot) {
        setConfigStatusSnapshot(payload.snapshot)
        const count = payload.savedKeys?.length ?? Object.keys(overrides).length
        setConfigStatusNotice({
          type: "success",
          message: `Saved ${count} configuration ${count === 1 ? "entry" : "entries"} and synced .env.example template.`,
        })
        return true
      }
      setConfigStatusNotice({
        type: "error",
        message: payload?.error ?? `Unable to save configuration changes (HTTP ${res.status}).`,
      })
      return false
    } catch (e) {
      setConfigStatusNotice({
        type: "error",
        message: `Save failed: ${String(e)}`,
      })
      return false
    } finally {
      setConfigStatusSaving(false)
    }
  }

  const handleResetConfigOverrides = async (keys?: readonly string[]) => {
    setConfigStatusSaving(true)
    setConfigStatusNotice(null)
    try {
      const res = await trackedFetch("/api/config/status", {
        method: "DELETE",
        headers: apiPostHeaders(),
        body: keys && keys.length > 0 ? JSON.stringify({ keys }) : undefined,
      })
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean
        snapshot?: ConfigStatusSnapshot
        error?: string
      } | null
      if (res.ok && payload?.ok && payload.snapshot) {
        setConfigStatusSnapshot(payload.snapshot)
        setConfigStatusNotice({
          type: "success",
          message:
            keys && keys.length > 0
              ? `Reset ${keys.join(", ")} to default.`
              : "Reset all saved configuration overrides to defaults.",
        })
      } else {
        setConfigStatusNotice({
          type: "error",
          message:
            payload?.error ?? `Unable to reset configuration overrides (HTTP ${res.status}).`,
        })
      }
    } catch (e) {
      setConfigStatusNotice({
        type: "error",
        message: `Reset failed: ${String(e)}`,
      })
    } finally {
      setConfigStatusSaving(false)
    }
  }

  useEffect(() => {
    if (!authReady || activeTab !== "status-dashboard") return
    void fetchConfigStatus()
  }, [authReady, activeTab])

  // Poll /health every 15s (0 disk I/O, in-memory probe); re-run on authReady so
  // /api/health/detail replaces the minimal public /api/health payload right after sign-in.
  useEffect(() => {
    void fetchHealth()
    const interval = setInterval(() => {
      void fetchHealth()
    }, 15000)
    return () => clearInterval(interval)
  }, [authReady])

  // Prime System Logs status counts (CRIT/HIGH/WATCH/NORM) for the Operations Command Ribbon
  useEffect(() => {
    if (!authReady) return
    let active = true
    trackedFetch("/api/weblogs?depth=1&options=false")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { summary?: { severityCounts?: WebLogSeverityCounts } } | null) => {
        if (active && json?.summary?.severityCounts) {
          setSystemLogSeverityCounts(json.summary.severityCounts)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [authReady])

  // When switching to alerts tab, fetch alerts
  useEffect(() => {
    if (!authReady || activeTab !== "alerts") return
    fetchAlerts(alertFilter)
  }, [activeTab, alertFilter, authReady])

  // Hydrate R2 freshness history immediately when opening the R2 Pipeline tab.
  useEffect(() => {
    if (!authReady || activeTab !== "r2") return
    void fetchR2PipelineHistory()
  }, [activeTab, authReady])

  // Configurable auto-refresh polling for R2 pipeline freshness & history while the R2 tab is open.
  useEffect(() => {
    if (!authReady || activeTab !== "r2" || r2AutoRefreshSeconds === 0) {
      setR2NextRefreshAtMs(null)
      return
    }
    let cancelled = false
    const intervalMs = r2AutoRefreshSeconds * 1000
    setR2NextRefreshAtMs(Date.now() + intervalMs)

    const interval = setInterval(() => {
      if (cancelled || r2PollInFlightRef.current) return
      r2PollInFlightRef.current = true
      void (async () => {
        try {
          await fetchR2Pipeline(true)
          await fetchR2PipelineHistory(false)
        } finally {
          r2PollInFlightRef.current = false
          if (!cancelled) {
            setR2NextRefreshAtMs(Date.now() + intervalMs)
          }
        }
      })()
    }, intervalMs)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [activeTab, authReady, r2AutoRefreshSeconds, r2RefreshCycleNonce])

  // Auto-dismiss toast after 4s
  useEffect(() => {
    if (!alertToast) return
    const t = setTimeout(() => setAlertToast(null), 4000)
    return () => clearTimeout(t)
  }, [alertToast])

  // Terminal Emulator state
  const [terminalHistory, setTerminalHistory] = useState<TerminalHistoryEntry[]>([
    {
      command: "help",
      stdout: TERMINAL_WELCOME_HELP_STDOUT,
      exitCode: 0,
      durationMs: 0,
      timestamp: Date.now(),
      synthetic: true,
    },
  ])
  const [terminalCommand, setTerminalCommand] = useState("")
  const [commandHistory, setCommandHistory] = useState<string[]>(TERMINAL_INITIAL_COMMANDS)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [terminalLoading, setTerminalLoading] = useState(false)
  const terminalBottomRef = useRef<HTMLDivElement>(null)
  const initialTerminalQueryRan = useRef(false)

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey && e.key === "`") ||
        ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")
      ) {
        e.preventDefault()
        setActiveTab("terminal")
        setTimeout(() => {
          const inputEl = document.querySelector<HTMLInputElement>("input[data-terminal-input]")
          inputEl?.focus()
        }, 50)
      } else if (e.ctrlKey && e.key === "1") {
        e.preventDefault()
        setActiveTab("customers")
      } else if (e.ctrlKey && e.key === "2") {
        e.preventDefault()
        setActiveTab("surveillance")
      } else if (e.ctrlKey && e.key === "3") {
        e.preventDefault()
        setActiveTab("terminal")
        setTimeout(() => {
          const inputEl = document.querySelector<HTMLInputElement>("input[data-terminal-input]")
          inputEl?.focus()
        }, 50)
      } else if (e.ctrlKey && e.key === "4") {
        e.preventDefault()
        setActiveTab("rankings")
      } else if (e.ctrlKey && e.key === "5") {
        e.preventDefault()
        setActiveTab("wagers")
      } else if (e.ctrlKey && e.key === "6") {
        e.preventDefault()
        setActiveTab("alerts")
      } else if (e.ctrlKey && e.key === "7") {
        e.preventDefault()
        setActiveTab("shadow")
      } else if (e.ctrlKey && e.key === "8") {
        e.preventDefault()
        setActiveTab("bet-ticker")
      } else if (e.ctrlKey && e.key === "9") {
        e.preventDefault()
        setActiveTab("r2")
      } else if (e.ctrlKey && e.key === "0") {
        e.preventDefault()
        setActiveTab("assets")
      }
    }
    window.addEventListener("keydown", handleGlobalKeyDown)
    return () => window.removeEventListener("keydown", handleGlobalKeyDown)
  }, [])

  useEffect(() => {
    const updateTime = () => {
      const now = new Date()
      const et = now.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
      const ct = now.toLocaleTimeString("en-US", {
        timeZone: "America/Chicago",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })
      setClockTime(`${et} ET · ${ct} CT`)
    }
    updateTime()
    const interval = setInterval(updateTime, 1000)
    return () => clearInterval(interval)
  }, [])

  const handleWagerSort = (field: WagerSortField) => {
    if (wagerSortField === field) {
      setWagerSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setWagerSortField(field)
      setWagerSortDir("desc")
    }
  }

  const knownCustomerIds = (): readonly string[] => [
    ...new Set([
      ...liveWagers.map((w) => w.customerId),
      ...(rankings?.players ?? []).map((p) => p.id),
    ]),
  ]

  const handleAutocomplete = () => {
    const trimmed = terminalCommand.trimStart()
    if (!trimmed) {
      setTerminalCommand("help")
      return
    }

    const tokens = trimmed.split(/\s+/)
    if (tokens.length === 1) {
      const prefix = tokens[0]!.toLowerCase()
      const cmdMatch = CLIENT_AUTOCOMPLETE_COMMANDS.find((c) => c.toLowerCase().startsWith(prefix))
      if (cmdMatch) {
        setTerminalCommand(cmdMatch + " ")
        return
      }
      const idMatch = knownCustomerIds().find((id) => id.toLowerCase().startsWith(prefix))
      if (idMatch) {
        setTerminalCommand("p " + idMatch)
        return
      }
    } else if (tokens.length === 2) {
      const cmd = tokens[0]!.toLowerCase()
      const argPrefix = tokens[1]!.toUpperCase()
      if (cmd === "profile" || cmd === "p" || cmd === "c") {
        const idMatch = knownCustomerIds().find((id) => id.toUpperCase().startsWith(argPrefix))
        if (idMatch) {
          setTerminalCommand(`${tokens[0]} ${idMatch}`)
          return
        }
      } else if (cmd === "find" || cmd === "f") {
        const candidates = ["-t", "-s", "-a", "sharp", "syndicate", "CFB", "NFL"]
        const match = candidates.find((c) => c.toLowerCase().startsWith(tokens[1]!.toLowerCase()))
        if (match) {
          setTerminalCommand(`${tokens[0]} ${match} `)
          return
        }
      }
    }
  }

  const runTerminalCommand = async (cmd: string) => {
    const trimmed = cmd.trim()
    if (!trimmed) return

    if (trimmed.toLowerCase() === "clear") {
      setTerminalHistory([])
      setTerminalCommand("")
      return
    }

    setCommandHistory((prev) => [...prev.filter((c) => c !== trimmed), trimmed])
    setHistoryIndex(-1)
    setTerminalLoading(true)

    try {
      const headers: Record<string, string> = {
        ...(apiPostHeaders() as Record<string, string>),
      }
      if (terminalAdminToken.trim()) {
        headers["x-admin-token"] = terminalAdminToken.trim()
      }
      const res = await trackedFetch("/api/terminal/exec", {
        method: "POST",
        headers,
        body: JSON.stringify({ command: trimmed, cols: 100, rows: 30 }),
      })

      if (res.ok) {
        const json = (await res.json()) as Partial<TerminalHistoryEntry> & {
          error?: string
        }
        const stdout = json.stdout
        if (typeof stdout !== "string") {
          setTerminalHistory((prev) => [
            ...prev,
            {
              command: trimmed,
              stdout: `\x1b[31m[TERMINAL_BAD_PAYLOAD] POST /api/terminal/exec returned no stdout string\x1b[0m\n\x1b[90mThe command did not produce a renderable result; nothing was added verbatim.\x1b[0m`,
              exitCode: 1,
              durationMs: 0,
              timestamp: Date.now(),
            },
          ])
        } else {
          setTerminalHistory((prev) => [
            ...prev,
            {
              command:
                typeof json.command === "string" && json.command.length > 0
                  ? json.command
                  : trimmed,
              stdout,
              exitCode: typeof json.exitCode === "number" ? json.exitCode : 0,
              durationMs: typeof json.durationMs === "number" ? json.durationMs : 0,
              timestamp: typeof json.timestamp === "number" ? json.timestamp : Date.now(),
            },
          ])
        }
      } else {
        const rawBody = await res.text().catch(() => "")
        let parsedErr: { error?: unknown; code?: unknown } = {}
        if (rawBody.trim()) {
          try {
            const candidate = JSON.parse(rawBody) as {
              error?: unknown
              code?: unknown
            }
            if (candidate && typeof candidate === "object") {
              parsedErr = candidate
            }
          } catch {
            // Non-JSON error body (e.g., proxy HTML/text response)
          }
        }
        const errorMessage =
          typeof parsedErr.error === "string" && parsedErr.error.trim().length > 0
            ? parsedErr.error.trim()
            : res.statusText.trim() ||
              rawBody
                .replace(/<[^>]+>/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 160) ||
              `HTTP ${res.status} execution error`
        const errorCode =
          typeof parsedErr.code === "string" && parsedErr.code.trim().length > 0
            ? parsedErr.code.trim()
            : `HTTP_${res.status}`
        const hintLine =
          res.status === 403 || res.status === 503
            ? serverAuthState.devQuickLoginAvailable && serverAuthState.role !== "ADMIN"
              ? `\n\x1b[90mTip: Currently signed in as ${serverAuthState.role ?? "OPERATOR"}. Click "Elevate to Dev Admin" above or enter x-admin-token.\x1b[0m`
              : `\n\x1b[90mTip: Provide a valid SPORTSDESK_ADMIN_TOKEN in the x-admin-token field above.\x1b[0m`
            : res.status === 401
              ? `\n\x1b[90mTip: Session expired or missing — sign in again to restore terminal access.\x1b[0m`
              : ""
        setTerminalHistory((prev) => [
          ...prev,
          {
            command: trimmed,
            stdout: `\x1b[31m[TERMINAL_ERROR ${res.status} · ${errorCode}] ${errorMessage}\x1b[0m${hintLine}`,
            exitCode: 1,
            durationMs: 0,
            timestamp: Date.now(),
          },
        ])
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      setTerminalHistory((prev) => [
        ...prev,
        {
          command: trimmed,
          stdout: `\x1b[31m[TERMINAL_UNAVAILABLE] POST /api/terminal/exec failed: ${reason}\x1b[0m\n\x1b[90mNothing was executed. Start the dashboard server ('bun run dev') for the live Bun.Terminal PTY.\x1b[0m`,
          exitCode: 1,
          durationMs: 0,
          timestamp: Date.now(),
        },
      ])
    } finally {
      setTerminalLoading(false)
      setTerminalCommand("")
    }
  }

  useEffect(() => {
    if (!authReady) return
    const cmd = resolveInitialUrlParam("terminal")
    if (cmd === "" || initialTerminalQueryRan.current) {
      return
    }
    initialTerminalQueryRan.current = true
    setActiveTab("terminal")
    void runTerminalCommand(cmd)
  }, [authReady])

  const runBenchmark = async (hostToBench?: string) => {
    const targetHost = (hostToBench ?? benchHost).trim() || SURVEILLANCE_URL_DEFAULTS.host
    setBenchLoading(true)
    try {
      const urls = buildSurveillanceEndpointUrls({
        host: targetHost,
        ip: reverseIp,
      })
      const res = await trackedFetch(urls.benchmark)
      setSurveillanceHeaderSync(buildSurveillanceHeaderSyncRecord(res, urls.benchmark))
      if (res.ok) {
        const json = await res.json()
        const metricsStr = (json.metrics as Array<{ backend: string; meanMs: number }>)
          .map((m) => `${m.backend}: ${m.meanMs}ms`)
          .join(" vs ")
        setBenchResult(
          `⚡ Fastest: ${json.fastestBackend} (${json.speedupFactor}x speedup) | ${metricsStr}`,
        )
      } else {
        setBenchResult(`Benchmark failed (HTTP ${res.status})`)
      }
    } catch {
      setBenchResult("Benchmark failed")
    } finally {
      setBenchLoading(false)
    }
  }

  const runReverseLookup = async (ipToLookup?: string) => {
    const ip = (ipToLookup ?? reverseIp).trim() || SURVEILLANCE_URL_DEFAULTS.ip
    try {
      const urls = buildSurveillanceEndpointUrls({
        host: benchHost,
        ip,
      })
      const res = await trackedFetch(urls.reverse)
      setSurveillanceHeaderSync(buildSurveillanceHeaderSyncRecord(res, urls.reverse))
      if (res.ok) {
        const json = (await res.json()) as ReverseDnsClassification
        const view = buildReverseDnsForensicsView(json)
        if (ipToLookup) {
          setCustomerReverseForensics(view)
        } else {
          setReverseForensics(view)
        }
      }
    } catch {
      if (ipToLookup) {
        setCustomerReverseForensics(null)
      } else {
        setReverseForensics(null)
      }
    }
  }

  const fetchDnsTelemetry = async () => {
    setDnsRefreshing(true)
    setDnsError(null)
    try {
      const urls = buildSurveillanceEndpointUrls({
        host: benchHost,
        ip: reverseIp,
      })
      let targetUrl = urls.dns
      const dnsRes = await trackedFetch(urls.dns).then(async (res) => {
        if (!res.ok) {
          const fallbackUrl = new URL(DASHBOARD_API.dns, urls.baseUrl)
          targetUrl = fallbackUrl
          return trackedFetch(fallbackUrl)
        }
        return res
      })
      setSurveillanceHeaderSync(buildSurveillanceHeaderSyncRecord(dnsRes, targetUrl))
      if (dnsRes.ok) {
        const json = (await dnsRes.json()) as DnsData
        setDnsData(json)
      } else {
        setDnsError(`HTTP ${dnsRes.status}`)
      }
    } catch (err) {
      setDnsError(err instanceof Error ? err.message : String(err))
    } finally {
      setDnsRefreshing(false)
    }
  }

  const fetchDashboard = async () => {
    try {
      const urls = buildSurveillanceEndpointUrls({
        host: benchHost,
        ip: reverseIp,
      })
      const [dashRes] = await Promise.all([trackedFetch(urls.brief), fetchDnsTelemetry()])
      setSurveillanceHeaderSync((prev) =>
        dashRes.ok ? buildSurveillanceHeaderSyncRecord(dashRes, urls.brief) : prev,
      )
      if (dashRes.ok) {
        const json = (await dashRes.json()) as DashboardData
        setData(json)
      }
    } catch (err) {
      console.error("Failed to load dashboard data:", err)
    }
  }

  useEffect(() => {
    return () => {
      if (freshTicketsTimerRef.current !== null) {
        clearTimeout(freshTicketsTimerRef.current)
        freshTicketsTimerRef.current = null
      }
    }
  }, [])

  // Streaming: the socket is primary, but a timed refresh is the backstop — a watcher that
  // misses a write (or a host with no watcher at all) must not leave the logs stale. The
  // endpoint is stat-cached server-side, so an unchanged capture costs a stat.
  useEffect(() => {
    if (!authReady || activeTab !== "wagers") return
    // The socket pushes on capture changes; this timed refetch keeps the visible table
    // fresh even when a watcher miss or a dropped socket frame would otherwise freeze it.
    const interval = setInterval(() => {
      void fetchLiveWagers()
    }, 10_000)
    return () => clearInterval(interval)
  }, [activeTab, connected, authReady])

  useEffect(() => {
    if (!authReady) return
    void fetchDashboard()

    // Hot-reload WebSocket connection with React StrictMode-safe lifecycle
    let isMounted = true
    const rttWindow: number[] = []
    let pingTimer: ReturnType<typeof setInterval> | null = null
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
    const devSessionTok = getDevSessionToken()
    const wsQuery = devSessionTok ? `?dev_session=${encodeURIComponent(devSessionTok)}` : ""
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws${wsQuery}`)

    const sendWsPing = () => {
      if (ws.readyState !== WebSocket.OPEN) return
      try {
        ws.send(JSON.stringify({ action: "ping", sentAt: performance.now() }))
      } catch {
        // socket closing
      }
    }

    ws.onopen = () => {
      if (isMounted) {
        setConnected(true)
        setWsLastSyncAt(Date.now())
        setWsSyncTick((tick) => tick + 1)
        try {
          ws.send(
            JSON.stringify({
              action: "subscribe",
              topics: ["dashboard", "live-bets", "syndicate-alerts", "tiers-updated"],
            }),
          )
        } catch {
          // signal-honesty: intentional-ignore-ws-subscribe-on-closing
        }
        sendWsPing()
        pingTimer = setInterval(sendWsPing, 5000)
      } else {
        ws.close()
      }
    }
    ws.onclose = () => {
      if (pingTimer !== null) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      if (isMounted) {
        setConnected(false)
        setWsLatencyMs(null)
        setWsJitterMs(null)
      }
    }
    ws.onmessage = (event) => {
      if (!isMounted || typeof event.data !== "string") return
      if (event.data.includes('"pong"')) {
        try {
          const parsed = JSON.parse(event.data) as {
            type?: unknown
            sentAt?: unknown
          }
          if (parsed.type === "pong" && typeof parsed.sentAt === "number") {
            const rtt = Math.max(1, Math.round(performance.now() - parsed.sentAt))
            rttWindow.push(rtt)
            if (rttWindow.length > 8) rttWindow.shift()
            let jitter = 0
            if (rttWindow.length >= 2) {
              let diffSum = 0
              for (let i = 1; i < rttWindow.length; i += 1) {
                diffSum += Math.abs(rttWindow[i]! - rttWindow[i - 1]!)
              }
              jitter = Math.round(diffSum / (rttWindow.length - 1))
            }
            setWsLatencyMs(rtt)
            setWsJitterMs(jitter)
            const nowMs = Date.now()
            setWsLastPongAt(new Date(nowMs).toISOString())
            setWsLastSyncAt(nowMs)
            setWsSyncTick((tick) => tick + 1)
            return
          }
        } catch {
          // fall through to standard signal parser
        }
      }
      const action = parseDashboardWsSignal(event.data)
      switch (action.kind) {
        case "reload":
          setWsLastSyncAt(Date.now())
          setWsSyncTick((tick) => tick + 1)
          void fetchDashboard()
          void fetchLiveWagers()
          void fetchBetTicker()
          void fetchCustomersCohorts()
          void fetchRankings()
          void fetchTiersConfig()
          break
        case "dashboard-updated":
          void fetchDashboard()
          break
        case "wagers-updated":
          setWsLastSyncAt(Date.now())
          setWsSyncTick((tick) => tick + 1)
          void fetchLiveWagers()
          void fetchBetTicker()
          break
        case "tiers-updated":
          if (action.tiers) {
            setTiersConfig(action.tiers as unknown as TierStyleConfig)
          } else {
            void fetchTiersConfig()
          }
          break
        case "alerts-updated":
          fetchAlerts()
          fetchHealth()
          break
        case "automations-updated":
          void fetchR2Pipeline(true)
          break
        case "ack":
        case "ignore":
          break
      }
    }

    return () => {
      isMounted = false
      if (pingTimer !== null) {
        clearInterval(pingTimer)
        pingTimer = null
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      } else if (ws.readyState === WebSocket.CONNECTING) {
        // Wait for handshake to finish before closing to avoid browser
        // "WebSocket is closed before the connection is established" warning in React StrictMode
        ws.onopen = () => ws.close()
      }
    }
  }, [wsReconnectNonce, authReady])

  const profileClassifications = useMemo(() => {
    const map = new Map<string, CustomerProfileClassification>()
    for (const cust of profileCustomers) {
      map.set(cust.id, classifyCustomerProfile(cust, customProfileTags))
    }
    return map
  }, [profileCustomers, customProfileTags])

  const filteredCustomers = useMemo(() => {
    return profileCustomers.filter((cust) => {
      const classification =
        profileClassifications.get(cust.id) ?? classifyCustomerProfile(cust, customProfileTags)
      if (!customerMatchesSearch(cust, searchQuery, classification)) {
        return false
      }
      if (!matchesProfileTypeFilter(cust, filterTier, classification.type.id)) {
        return false
      }
      if (
        profileTagCategoryFilter !== "ALL" &&
        !classification.tags.some((tag) => tag.category === profileTagCategoryFilter)
      ) {
        return false
      }
      if (activeProfileTagIds.length > 0) {
        for (const tagId of activeProfileTagIds) {
          if (!classification.tagIds.has(tagId)) return false
        }
      }
      return true
    })
  }, [
    profileCustomers,
    profileClassifications,
    customProfileTags,
    searchQuery,
    filterTier,
    profileTagCategoryFilter,
    activeProfileTagIds,
  ])

  const [customerSort, setCustomerSort] = useState<{
    key: CustomerSortKey
    dir: 1 | -1
  }>({ key: "score", dir: -1 })

  const onCustomerSort = (key: CustomerSortKey) =>
    setCustomerSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }))

  const sortedCustomers = useMemo(() => {
    return [...filteredCustomers].sort((a, b) => {
      const v =
        customerSort.key === "id"
          ? a.id.localeCompare(b.id)
          : (a[customerSort.key] as number) - (b[customerSort.key] as number)
      return v * customerSort.dir
    })
  }, [filteredCustomers, customerSort])

  const appliedCustomerFocusRef = useRef<string | null>(null)

  const handleSelectCustomerById = (customerId: string) => {
    const raw = customerId.trim()
    if (raw === "") return
    const upper = raw.toUpperCase()
    const found = profileCustomers.find((c) => c.id.toUpperCase() === upper)
    appliedCustomerFocusRef.current = upper
    setFocusedCustomerId(upper)
    setSelectedCustomer(found ?? null)
    setSearchQuery(raw)
    setFilterTier("ALL")
    setCustomerLookupNotice(found ? null : upper)
    setActiveTab("customers")
  }

  const handleFocusCustomerInDownlines = (customerId: string) => {
    const upper = customerId.trim().toUpperCase()
    if (upper === "") return
    appliedCustomerFocusRef.current = upper
    setFocusedCustomerId(upper)
    const found = profileCustomers.find((c) => c.id.toUpperCase() === upper)
    if (found) {
      setSelectedCustomer(found)
      setCustomerLookupNotice(null)
    }
  }

  const handleClearFocusedCustomer = () => {
    appliedCustomerFocusRef.current = null
    setFocusedCustomerId(null)
    setCustomerLookupNotice(null)
    setSearchQuery("")
  }

  // Resolve an explicit `?customer=` deep link once when cohort rows hydrate,
  // without re-locking searchQuery/selection on every subsequent telemetry tick.
  useEffect(() => {
    if (!focusedCustomerId || profileCustomers.length === 0) return
    if (appliedCustomerFocusRef.current === focusedCustomerId) return
    appliedCustomerFocusRef.current = focusedCustomerId
    const found = profileCustomers.find((c) => c.id.toUpperCase() === focusedCustomerId)
    setSelectedCustomer(found ?? null)
    setCustomerLookupNotice(found ? null : focusedCustomerId)
    if (activeTab === "customers") {
      setSearchQuery(focusedCustomerId)
    }
  }, [focusedCustomerId, profileCustomers, activeTab])

  // Default preview in Profiles when no customer is focused yet — does NOT
  // stamp `?customer=` into the URL so switching tabs never traps a default id.
  useEffect(() => {
    if (
      selectedCustomer === null &&
      customerLookupNotice === null &&
      focusedCustomerId === null &&
      sortedCustomers.length > 0
    ) {
      setSelectedCustomer(sortedCustomers[0] ?? null)
    }
  }, [selectedCustomer, customerLookupNotice, focusedCustomerId, sortedCustomers])

  const previousTabRef = useRef(activeTab)
  useEffect(() => {
    if (typeof window === "undefined") return
    const tabChanged = previousTabRef.current !== activeTab
    previousTabRef.current = activeTab
    writeDashboardUrl(
      {
        tab: activeTab,
        matrix: showBuildMatrix,
        agent: selectedAgentId ?? "",
        downlineAgents: selectedDownlineAgentIds,
        rankingsHeatmap: rankingsHeatMapEnabled,
        customer: focusedCustomerId ?? "",
        wSport: wagerSportFilter,
        wAlert: wagerAlertFilter,
        wType: wagerTypeFilter,
        wChannel: wagerChannelFilter,
        wSort: wagerSortField,
        wDir: wagerSortDir,
        survView: viewMode,
        survIp: reverseIp,
        survHost: benchHost,
      },
      window,
      { push: tabChanged },
    )
  }, [
    activeTab,
    showBuildMatrix,
    selectedAgentId,
    selectedDownlineAgentIds,
    rankingsHeatMapEnabled,
    focusedCustomerId,
    wagerSportFilter,
    wagerAlertFilter,
    wagerTypeFilter,
    wagerChannelFilter,
    wagerSortField,
    wagerSortDir,
    viewMode,
    reverseIp,
    benchHost,
  ])

  useEffect(() => {
    if (typeof window === "undefined") return
    const apply = () => {
      const next = readDashboardUrlState(
        window.location.search,
        window.location.pathname,
        window.location.hash,
      )
      setActiveTab(next.tab)
      setShowBuildMatrix(next.matrix)
      setWagerSportFilter(next.wSport)
      setWagerAlertFilter(next.wAlert)
      setWagerTypeFilter(next.wType)
      setWagerChannelFilter(next.wChannel)
      setWagerSortField(next.wSort)
      setWagerSortDir(next.wDir)
      setSelectedAgentId(next.agent ? next.agent.toUpperCase() : null)
      setSelectedDownlineAgentIds(next.downlineAgents ?? [])
      if (next.rankingsHeatmap !== undefined) {
        setRankingsHeatMapEnabled(next.rankingsHeatmap)
        writeStoredRankingsHeatMap(next.rankingsHeatmap)
      }
      setRankingsSearch(next.agent)
      setViewMode(next.survView ?? SURVEILLANCE_URL_DEFAULTS.view)
      setReverseIp(next.survIp ?? SURVEILLANCE_URL_DEFAULTS.ip)
      setBenchHost(next.survHost ?? SURVEILLANCE_URL_DEFAULTS.host)

      const customerId = (next.customer ?? "").trim().toUpperCase()
      appliedCustomerFocusRef.current = customerId || null
      setFocusedCustomerId(customerId || null)
      if (customerId !== "") {
        const found = profileCustomers.find((customer) => customer.id.toUpperCase() === customerId)
        setSelectedCustomer(found ?? null)
        if (next.tab === "customers") {
          setSearchQuery(customerId)
        }
        setCustomerLookupNotice(found ? null : customerId)
      } else {
        setCustomerLookupNotice(null)
      }
      const params = new URLSearchParams(window.location.search)
      const ticketId = params.get("ticket")?.trim() ?? ""
      if (ticketId !== "") {
        const pick = findWagerByTicketParam(liveWagers, ticketId)
        if (pick !== null) setSelectedWager(pick)
      }
    }
    const applyHash = () => {
      const hash = window.location.hash
      if (!hash) return
      const resolved = resolveDashboardTabId(hash, activeTab)
      setActiveTab(resolved)
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== RANKINGS_HEATMAP_STORAGE_KEY) return
      const parsed = parseStoredRankingsHeatMapValue(event.newValue)
      if (parsed !== null) {
        setRankingsHeatMapEnabled(parsed)
      }
    }
    window.addEventListener("popstate", apply)
    window.addEventListener("hashchange", applyHash)
    window.addEventListener("storage", onStorage)
    return () => {
      window.removeEventListener("popstate", apply)
      window.removeEventListener("hashchange", applyHash)
      window.removeEventListener("storage", onStorage)
    }
  }, [profileCustomers, liveWagers, activeTab])

  const navigatePrimaryRoute = (
    routeId: "risk-overview" | "churn-simulation" | "system-logs" | "status-dashboard",
  ) => {
    setActiveTab(routeId)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set("tab", routeId)
      url.hash = `#${routeId}`
      window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`)
    }
  }

  const formatSourceUpdate = (iso: string | null) => {
    if (!iso) {
      return {
        clock: "Never",
        relative: "no successful update yet",
        summary: "Never",
      }
    }
    const parsed = Date.parse(iso)
    if (!Number.isFinite(parsed)) {
      return { clock: iso, relative: "", summary: iso }
    }
    const clock = new Date(parsed).toLocaleTimeString()
    const diffSec = Math.max(0, Math.floor((Date.now() - parsed) / 1000))
    const relative =
      diffSec < 5
        ? "just now"
        : diffSec < 60
          ? `${diffSec}s ago`
          : diffSec < 3600
            ? `${Math.floor(diffSec / 60)}m ${diffSec % 60}s ago`
            : `${Math.floor(diffSec / 3600)}h ${Math.floor((diffSec % 3600) / 60)}m ago`
    return {
      clock,
      relative,
      summary: `${clock} (${relative})`,
    }
  }

  const daemonUpdateInfo = formatSourceUpdate(daemon4020LastUpdatedAt)
  const daemonProbeInfo = formatSourceUpdate(daemon4020LastProbedAt)
  const r2UpdateInfo = formatSourceUpdate(r2LastUpdatedAt ?? r2PipelineData?.observedAt ?? null)
  const healthUpdateInfo = formatSourceUpdate(healthLastUpdatedAt)

  const daemon4020 = r2PipelineData?.daemon4020
  const daemonState = resolveDaemon4020State(daemon4020)
  const daemonLatency = daemon4020?.latencyMs ?? 1
  const daemonPill =
    daemonState === "online"
      ? {
          color: "#4ade80",
          label: `● API :4020 (${daemonLatency}ms)`,
          statusText: "ONLINE",
          title: `SportsDesk Daemon :4020 online (${daemonLatency}ms) · Last successful update: ${daemonUpdateInfo.summary}`,
        }
      : daemonState === "degraded"
        ? {
            color: "#fbbf24",
            label: `◐ API :4020 ${daemon4020?.operationalStatus === "down" ? "Auth Down" : "Degraded"} (${daemonLatency}ms)`,
            statusText: daemon4020?.operationalStatus === "down" ? "AUTH DOWN" : "DEGRADED",
            title: `SportsDesk Daemon :4020 reachable (HTTP ${daemon4020?.status ?? 503}, ${daemonLatency}ms)${daemon4020?.reason ? ` — ${daemon4020.reason}` : ""} · Last successful update: ${daemonUpdateInfo.summary}`,
          }
        : daemonState === "offline"
          ? {
              color: "#fbbf24",
              label: "○ API :4020 Offline",
              statusText: "OFFLINE",
              title: `SportsDesk Daemon :4020 offline (${daemon4020?.reason ?? "unreachable"}) · Last successful update: ${daemonUpdateInfo.summary}${daemon4020LastProbedAt ? ` · Last probe: ${daemonProbeInfo.clock}` : ""}`,
            }
          : {
              color: "#94a3b8",
              label: "◌ API :4020 Probing...",
              statusText: "PROBING",
              title: `SportsDesk Daemon :4020 probing... · Last successful update: ${daemonUpdateInfo.summary}`,
            }

  const r2SummaryLabel = r2PipelineData
    ? `R2 ${r2PipelineData.freshCount}/${r2PipelineData.totalCount} Fresh`
    : "R2 Probing..."

  const telemetryRefreshSnapshot: TelemetryRefreshSnapshot = {
    probing: telemetryRefreshing || r2PipelineLoading,
    lastProbedAt: lastTelemetryProbeAt ?? r2PipelineData?.observedAt ?? null,
    lastProbeMs: lastTelemetryProbeMs,
    daemonState,
    daemonLabel: daemonPill.label,
    daemonColor: daemonPill.color,
    r2Label: r2SummaryLabel,
    r2OverallStatus: r2PipelineData?.overallStatus ?? "probing",
    wsConnected: connected,
    wsLastHeartbeatAt: wsLastPongAt,
    wsLatencyMs,
    error: telemetryProbeError ?? r2PipelineError,
  }

  const alertsStatus = healthData?.alerts?.status
  const opStatus = healthData?.operationalStatus
  const isHealthError =
    alertsStatus === "degraded" || opStatus === "down" || healthData?.status === "down"
  const isHealthWarn =
    !isHealthError &&
    (alertsStatus === "warning" || opStatus === "degraded" || healthData?.status === "degraded")
  const degradedReasonSummary = healthData?.degradedReasons
    ?.map((r) => r.message)
    .slice(0, 3)
    .join("; ")
  const systemHealthUi = isHealthError
    ? {
        border: "#ef4444",
        bg: "rgba(239, 68, 68, 0.15)",
        color: "#f87171",
        label: alertsStatus === "degraded" ? "🚨 DEGRADED" : "🚨 AUTH DOWN",
        statusText: alertsStatus === "degraded" ? "DEGRADED" : "AUTH DOWN",
      }
    : isHealthWarn
      ? {
          border: "#f59e0b",
          bg: "rgba(245, 158, 11, 0.15)",
          color: "#fbbf24",
          label: alertsStatus === "warning" ? "⚠️ WARNING" : "⚠️ DEGRADED",
          statusText: alertsStatus === "warning" ? "WARNING" : "DEGRADED",
        }
      : {
          border: "#22c55e",
          bg: "rgba(34, 197, 94, 0.15)",
          color: "#4ade80",
          label: "● System OK",
          statusText: "HEALTHY",
        }

  const renderWorkspaceNavItems = (closeDrawerOnSelect: boolean) => (
    <>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={styles.tabBtn(activeTab === "customers")}
        onClick={() => {
          setActiveTab("customers")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Inspect individual sharp originators, sizing models, and risk (Ctrl+1)"
      >
        <span>👥 Profiles ({profileCustomers.length > 0 ? profileCustomers.length : "—"})</span>
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+1
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={styles.tabBtn(activeTab === "surveillance")}
        onClick={() => {
          setActiveTab("surveillance")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Bun.dns latency benchmarks and surveillance markdown (Ctrl+2)"
      >
        <span>📊 Telemetry</span>
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+2
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={styles.tabBtn(activeTab === "terminal")}
        onClick={() => {
          setActiveTab("terminal")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Native Bun.Terminal PTY query engine (Ctrl+3 or Cmd+K)"
      >
        <span>💻 Terminal (PTY)</span>
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+3
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={styles.tabBtn(activeTab === "rankings")}
        onClick={() => {
          setActiveTab("rankings")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Rolling 30-day handle rankings & proxy conduits (Ctrl+4)"
      >
        <span>🏆 Downlines ({rankings ? rankings.conduits.length : "—"})</span>
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+4
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={{
          ...styles.tabBtn(activeTab === "wagers"),
          position: "relative",
        }}
        onClick={() => {
          setActiveTab("wagers")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Real-time incoming wager tape with CLV alerts (Ctrl+5)"
      >
        <span>⚡ Live Wagers ({liveWagers.length})</span>
        <span
          className="live-alert-pulse"
          style={{
            fontSize: "10px",
            padding: "1px 5px",
            borderRadius: "8px",
            backgroundColor: "#ef4444",
            color: "#ffffff",
            fontWeight: 700,
            marginLeft: "4px",
          }}
        >
          🚨{" "}
          {
            liveWagers.filter((w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM")
              .length
          }
        </span>
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+5
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={{
          ...styles.tabBtn(activeTab === "alerts"),
          position: "relative",
        }}
        onClick={() => {
          setActiveTab("alerts")
          fetchAlerts()
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Surveillance Alert Queue, Dead-Letter Queue (DLQ), and Replay Controls (Ctrl+6)"
      >
        <span>🚨 DLQ &amp; Alerts ({alertRecords.length})</span>
        {healthData?.alerts?.dead && healthData.alerts.dead > 0 ? (
          <span
            style={{
              fontSize: "10px",
              padding: "1px 5px",
              borderRadius: "8px",
              backgroundColor: "#ef4444",
              color: "#ffffff",
              fontWeight: 700,
              marginLeft: "4px",
            }}
          >
            {healthData.alerts.dead} DEAD
          </span>
        ) : null}
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+6
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={styles.tabBtn(activeTab === "shadow")}
        onClick={() => {
          setActiveTab("shadow")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Counterfactual Shadow Pricing & Slice Hold-Floor Cube (Ctrl+7)"
      >
        <span>⚖️ Shadow Pricing (#135)</span>
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+7
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={styles.tabBtn(activeTab === "bet-ticker")}
        onClick={() => {
          setActiveTab("bet-ticker")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Actionable Bet Ticker feed (Ctrl+8)"
      >
        <span>📡 Bet Ticker ({betTickerData?.localFeed.actionableTicketCount ?? "…"})</span>
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+8
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={styles.tabBtn(activeTab === "r2")}
        onClick={() => {
          setActiveTab("r2")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="R2 Pipeline Freshness Monitor (Ctrl+9)"
      >
        <span>☁️ R2 Pipeline</span>
        {r2PipelineData?.staleKeys && r2PipelineData.staleKeys.length > 0 ? (
          <span
            style={{
              fontSize: "10px",
              padding: "1px 5px",
              borderRadius: "8px",
              backgroundColor: "#f59e0b",
              color: "#090d16",
              fontWeight: 700,
              marginLeft: "4px",
            }}
          >
            {r2PipelineData.staleKeys.length} STALE
          </span>
        ) : null}
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+9
        </kbd>
      </button>
      <button
        type="button"
        className="sd-workspace-nav-btn"
        style={styles.tabBtn(activeTab === "assets")}
        onClick={() => {
          setActiveTab("assets")
          if (closeDrawerOnSelect) setMobileNavOpen(false)
        }}
        title="Bun.Image width, height, format and backend for the served dashboard assets (Ctrl+0)"
      >
        <span>🖼️ Assets</span>
        <kbd className="sd-kbd-shortcut" style={styles.keyShortcutBadge}>
          Ctrl+0
        </kbd>
      </button>
    </>
  )

  const renderOperatorMenu = () => (
    <OperatorProfileMenu
      username={shiftOperator}
      signedInAt={operatorSignedInAt}
      activeShiftSeconds={activeShiftSeconds}
      onSwitchOperator={(nextOp) => {
        handleOperatorChange(nextOp)
        void fetchShiftSummary(nextOp)
      }}
      onOpenShiftHandoff={() => {
        setMobileNavOpen(false)
        openShiftHandoffModal()
      }}
      onMintFastSignInBookmark={
        serverAuthState.authenticated ? handleMintFastSignInBookmark : undefined
      }
      onRevokeFastSignInBookmarks={
        serverAuthState.authenticated ? handleRevokeFastSignInBookmarks : undefined
      }
      onLogout={() => {
        setMobileNavOpen(false)
        handleOperatorLogout()
      }}
    />
  )

  return (
    <div data-dashboard-theme={dashboardTheme} className="sd-app-shell" style={styles.container}>
      {/* Global Header */}
      <header className="sd-app-header" style={styles.header}>
        {/* Row 1: Compact 1-row App Title Bar (logo, title, theme toggle, mobile menu button) */}
        <div className="sd-header-title-row" data-header-title-row="true">
          <a
            href="#risk-overview"
            className="sd-logo-home-link"
            onClick={(e) => {
              e.preventDefault()
              navigatePrimaryRoute("risk-overview")
            }}
            title="SportsDesk & Fantasy402 Operations — Risk Overview"
          >
            <img
              src={BRAND_ASSETS.emblemWebp}
              alt={BRAND_ASSETS.emblemAlt}
              width={32}
              height={32}
              decoding="async"
              referrerPolicy="no-referrer"
              onError={(e) => {
                const target = e.currentTarget
                if (target.dataset.fallbackApplied !== "1") {
                  target.dataset.fallbackApplied = "1"
                  target.src = logo
                }
              }}
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                objectFit: "cover",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "rgba(56, 189, 248, 0.28)",
                boxShadow: "0 0 12px rgba(56, 189, 248, 0.22)",
                flexShrink: 0,
                display: "block",
              }}
            />
            <h1 className="sd-app-title" style={styles.title} data-brand-version={BRAND_ASSETS.version}>
              {BRAND_ASSETS.shortName}
            </h1>
          </a>

          <div className="sd-header-title-actions">
            <HeaderThemeToggle
              theme={dashboardTheme}
              onToggle={(next) => setDashboardTheme(next)}
            />
            <button
              type="button"
              className="sd-mobile-menu-btn"
              data-mobile-nav-trigger="true"
              aria-expanded={mobileNavOpen}
              aria-controls="sd-mobile-nav-drawer"
              aria-label={mobileNavOpen ? "Close workspace navigation menu" : "Open workspace navigation menu"}
              onClick={() => setMobileNavOpen((prev) => !prev)}
            >
              {mobileNavOpen ? (
                <X size={18} aria-hidden="true" />
              ) : (
                <Menu size={18} aria-hidden="true" />
              )}
              <span className="sd-mobile-menu-btn-label">Menu</span>
            </button>
          </div>
        </div>

        {/* Row 2: Single-line horizontally scrollable Telemetry Strip */}
        <div
          className="sd-telemetry-strip"
          data-telemetry-strip="true"
          role="region"
          aria-label="Live telemetry status strip"
        >
          <span className="sd-telemetry-item" style={{ color: "#38bdf8", fontWeight: 600 }}>
            ● Local :4022 SPA
          </span>
          <span className="sd-telemetry-sep" aria-hidden="true">
            ·
          </span>
          <span className="sd-status-tip-wrap sd-telemetry-item">
            <span
              tabIndex={0}
              style={{
                color: daemonPill.color,
                fontWeight: 600,
                cursor: "help",
              }}
              title={daemonPill.title}
            >
              {daemonPill.label}
            </span>
            <span role="tooltip" className="sd-status-tip-popover">
              <span className="sd-status-tip-title">
                <span>Daemon :4020</span>
                <span style={{ color: daemonPill.color }}>{daemonPill.statusText}</span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">Last success</span>
                <span className="sd-status-tip-value">{daemonUpdateInfo.clock}</span>
              </span>
              <span className="sd-status-tip-meta">
                {daemon4020LastUpdatedAt
                  ? `Updated ${daemonUpdateInfo.relative}${daemonState === "online" || daemonState === "degraded" ? ` · Latency ${daemonLatency}ms` : ""}`
                  : daemon4020LastProbedAt
                    ? `No successful response yet · Last probe ${daemonProbeInfo.clock} (${daemonProbeInfo.relative})`
                    : "Awaiting first :4020 probe"}
              </span>
              {daemonState === "offline" && daemon4020?.reason && (
                <span
                  className="sd-status-tip-meta"
                  style={{ display: "block", color: "#fbbf24" }}
                >
                  {daemon4020.reason}
                </span>
              )}
            </span>
          </span>
          <span className="sd-telemetry-sep" aria-hidden="true">
            ·
          </span>
          <span className="sd-status-tip-wrap sd-telemetry-item">
            <button
              type="button"
              onClick={() => setActiveTab("r2")}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                fontSize: "11px",
                fontWeight: 600,
                whiteSpace: "nowrap",
                color:
                  r2PipelineData?.overallStatus === "fresh"
                    ? "#4ade80"
                    : r2PipelineData?.overallStatus === "stale"
                      ? "#fbbf24"
                      : r2PipelineData
                        ? "#f87171"
                        : "#94a3b8",
              }}
              title={`Open R2 Pipeline Monitor · Last successful update: ${r2UpdateInfo.summary}`}
            >
              {r2PipelineData
                ? `☁️ R2 ${r2PipelineData.freshCount}/${r2PipelineData.totalCount} Fresh`
                : "☁️ R2 Probing..."}
            </button>
            <span role="tooltip" className="sd-status-tip-popover">
              <span className="sd-status-tip-title">
                <span>R2 Pipeline</span>
                <span
                  style={{
                    color:
                      r2PipelineData?.overallStatus === "fresh"
                        ? "#4ade80"
                        : r2PipelineData?.overallStatus === "stale"
                          ? "#fbbf24"
                          : "#f87171",
                  }}
                >
                  {(r2PipelineData?.overallStatus ?? "probing").toUpperCase()}
                </span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">Last success</span>
                <span className="sd-status-tip-value">{r2UpdateInfo.clock}</span>
              </span>
              <span className="sd-status-tip-meta">
                {r2PipelineData
                  ? `Updated ${r2UpdateInfo.relative} · ${r2PipelineData.freshCount}/${r2PipelineData.totalCount} sinks fresh · Click to inspect`
                  : "Awaiting first R2 pipeline snapshot"}
              </span>
            </span>
          </span>
          <button
            type="button"
            className="sd-refresh-telemetry-btn sd-telemetry-item"
            onClick={() => {
              void handleRefreshTelemetry()
            }}
            disabled={telemetryRefreshing}
            aria-label="Refresh Telemetry"
            title={
              telemetryRefreshSnapshot.lastProbedAt
                ? `Force immediate probe of :4020 daemon status, R2 pipeline freshness, health & profiles · Last probe: ${new Date(telemetryRefreshSnapshot.lastProbedAt).toLocaleTimeString()}${telemetryRefreshSnapshot.lastProbeMs ? ` (${telemetryRefreshSnapshot.lastProbeMs}ms)` : ""}`
                : "Force immediate probe of :4020 daemon status, R2 pipeline freshness, health & profiles"
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "2px 8px",
              borderRadius: "5px",
              fontSize: "10.5px",
              fontWeight: 600,
              letterSpacing: "0.01em",
              backgroundColor: telemetryRefreshing
                ? "rgba(56, 189, 248, 0.16)"
                : "rgba(15, 23, 42, 0.86)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: telemetryRefreshing
                ? "rgba(56, 189, 248, 0.55)"
                : "rgba(56, 189, 248, 0.28)",
              color: telemetryRefreshing ? "#e0f2fe" : "#7dd3fc",
              cursor: telemetryRefreshing ? "wait" : "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            <RefreshCw size={11} className={telemetryRefreshing ? "sd-spin" : undefined} />
            <span>{telemetryRefreshing ? "Probing..." : "Refresh Telemetry"}</span>
            {telemetryRefreshSnapshot.lastProbeMs !== null && !telemetryRefreshing && (
              <span
                style={{
                  fontSize: "9.5px",
                  color: "#64748b",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                }}
              >
                {telemetryRefreshSnapshot.lastProbeMs}ms
              </span>
            )}
          </button>
          <span className="sd-telemetry-item">
            <WsSyncStatusIndicator
              wsConnected={connected}
              lastHeartbeatAt={wsLastPongAt}
              latencyMs={wsLatencyMs}
            />
          </span>
          <span className="sd-status-tip-wrap sd-telemetry-item">
            <span
              tabIndex={0}
              data-ws-status-pill="true"
              style={{
                ...styles.badge(connected),
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                whiteSpace: "nowrap",
                cursor: "help",
              }}
              title={
                connected
                  ? wsLatencyMs !== null
                    ? `WebSocket stream connected · RTT ${wsLatencyMs}ms · Jitter ±${wsJitterMs ?? 0}ms`
                    : "WebSocket stream connected · Measuring latency…"
                  : "WebSocket stream disconnected"
              }
            >
              <span>{connected ? "● Live Hot-Reload Connected" : "○ Disconnected"}</span>
              {connected ? (
                <span
                  data-ws-latency-indicator="true"
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontVariantNumeric: "tabular-nums",
                    fontSize: "11px",
                    fontWeight: 600,
                    color:
                      wsLatencyMs === null
                        ? "#94a3b8"
                        : wsLatencyMs > 200 || (wsJitterMs ?? 0) > 60
                          ? "#f87171"
                          : wsLatencyMs > 80 || (wsJitterMs ?? 0) > 25
                            ? "#fbbf24"
                            : "#86efac",
                    borderLeftWidth: "1px",
                    borderLeftStyle: "solid",
                    borderLeftColor: "rgba(74, 222, 128, 0.28)",
                    paddingLeft: "6px",
                  }}
                >
                  {wsLatencyMs !== null ? `${wsLatencyMs}ms · ±${wsJitterMs ?? 0}ms` : "probing…"}
                </span>
              ) : null}
            </span>
            <span role="tooltip" className="sd-status-tip-popover">
              <span className="sd-status-tip-title">
                <span>WebSocket Stream</span>
                <span
                  style={{
                    color: !connected
                      ? "#f87171"
                      : wsLatencyMs !== null && (wsLatencyMs > 200 || (wsJitterMs ?? 0) > 60)
                        ? "#f87171"
                        : wsLatencyMs !== null && (wsLatencyMs > 80 || (wsJitterMs ?? 0) > 25)
                          ? "#fbbf24"
                          : "#4ade80",
                  }}
                >
                  {!connected
                    ? "OFFLINE"
                    : wsLatencyMs === null
                      ? "PROBING"
                      : wsLatencyMs > 200 || (wsJitterMs ?? 0) > 60
                        ? "DEGRADED"
                        : wsLatencyMs > 80 || (wsJitterMs ?? 0) > 25
                          ? "ELEVATED"
                          : "OPTIMAL"}
                </span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">RTT Latency</span>
                <span className="sd-status-tip-value">
                  {connected && wsLatencyMs !== null ? `${wsLatencyMs} ms` : "—"}
                </span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">Stream Jitter</span>
                <span className="sd-status-tip-value">
                  {connected && wsJitterMs !== null ? `±${wsJitterMs} ms` : "—"}
                </span>
              </span>
              <span className="sd-status-tip-meta">
                {connected && wsLastPongAt
                  ? `Last pong ${new Date(wsLastPongAt).toLocaleTimeString([], { hour12: false })} · 5s heartbeat`
                  : connected
                    ? "Awaiting initial WebSocket pong heartbeat"
                    : "Reconnecting to /ws stream"}
              </span>
            </span>
          </span>
          {/* Live Alert Health Pill */}
          <span className="sd-status-tip-wrap sd-telemetry-item">
            <button
              type="button"
              onClick={() => {
                openShiftHandoffModal()
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 10px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
                border: `1px solid ${systemHealthUi.border}`,
                background: systemHealthUi.bg,
                color: systemHealthUi.color,
              }}
              title={
                degradedReasonSummary
                  ? `Health probe: ${degradedReasonSummary} · Last successful update: ${healthUpdateInfo.summary} · Click to view Shift Handoff Summary`
                  : `Surveillance Alert Health (O(1) in-memory probe) · Last successful update: ${healthUpdateInfo.summary} · Click to view Shift Handoff Summary`
              }
            >
              <span>{systemHealthUi.label}</span>
              {healthData?.alerts && (
                <span style={{ color: "#94a3b8", fontSize: "10px" }}>
                  (DLQ: {healthData.alerts.dead} · Backlog: {healthData.alerts.backlog})
                </span>
              )}
            </button>
            <span role="tooltip" className="sd-status-tip-popover sd-status-tip-popover--right">
              <span className="sd-status-tip-title">
                <span>Health Probe</span>
                <span style={{ color: systemHealthUi.color }}>{systemHealthUi.statusText}</span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">Last success</span>
                <span className="sd-status-tip-value">{healthUpdateInfo.clock}</span>
              </span>
              <span className="sd-status-tip-meta">
                {healthLastUpdatedAt
                  ? `Updated ${healthUpdateInfo.relative}${typeof healthData?.uptimeSeconds === "number" ? ` · Uptime ${Math.floor(healthData.uptimeSeconds)}s` : ""}`
                  : "Awaiting first /health response"}
              </span>
              {degradedReasonSummary && (
                <span className="sd-status-tip-meta" style={{ display: "block", color: "#fbbf24" }}>
                  {degradedReasonSummary}
                </span>
              )}
            </span>
          </span>
          {/* Persistent 60-Minute Aggregate Risk Exposure Threshold Indicator */}
          <span className="sd-status-tip-wrap sd-telemetry-item">
            <button
              type="button"
              data-risk-threshold-indicator="true"
              data-risk-threshold-status={riskThresholdEvaluation.status}
              aria-live="polite"
              onClick={() => {
                navigatePrimaryRoute("risk-overview")
              }}
              className={`sd-risk-threshold-pill sd-risk-threshold-pill--${riskThresholdEvaluation.status}`}
              title={
                riskThresholdEvaluation.isBreached
                  ? `60m aggregate risk (${formatRiskCompactUsd(riskThresholdEvaluation.totalRiskUsd)}) exceeds ${formatRiskCompactUsd(riskThresholdEvaluation.limitUsd)} limit by +${formatRiskCompactUsd(riskThresholdEvaluation.excessUsd)} — click to open Risk Overview`
                  : `60m aggregate risk: ${formatRiskCompactUsd(riskThresholdEvaluation.totalRiskUsd)} / ${formatRiskCompactUsd(riskThresholdEvaluation.limitUsd)} limit — click to configure in Risk Overview`
              }
            >
              {riskThresholdEvaluation.isBreached || riskThresholdEvaluation.isWarning ? (
                <AlertTriangle size={13} aria-hidden="true" />
              ) : (
                <ShieldCheck size={13} aria-hidden="true" />
              )}
              <span>
                {riskThresholdEvaluation.status === "breach"
                  ? "60m Risk Breach"
                  : riskThresholdEvaluation.status === "warn"
                    ? "60m Risk High"
                    : "60m Risk"}
              </span>
              <span className="sd-risk-threshold-pill-val">
                {riskThresholdEvaluation.status === "idle"
                  ? `Limit ${formatRiskCompactUsd(riskThresholdEvaluation.limitUsd)}`
                  : `${formatRiskCompactUsd(riskThresholdEvaluation.totalRiskUsd)} / ${formatRiskCompactUsd(riskThresholdEvaluation.limitUsd)}`}
                {riskThresholdEvaluation.isBreached
                  ? ` (+${Math.round(riskThresholdEvaluation.utilizationPct - 100)}%)`
                  : riskThresholdEvaluation.isWarning
                    ? ` (${Math.round(riskThresholdEvaluation.utilizationPct)}%)`
                    : ""}
              </span>
            </button>
            <span role="tooltip" className="sd-status-tip-popover sd-status-tip-popover--right">
              <span className="sd-status-tip-title">
                <span>60m Risk Threshold</span>
                <span
                  style={{
                    color:
                      riskThresholdEvaluation.status === "breach"
                        ? "#f87171"
                        : riskThresholdEvaluation.status === "warn"
                          ? "#fbbf24"
                          : riskThresholdEvaluation.status === "ok"
                            ? "#4ade80"
                            : "#38bdf8",
                  }}
                >
                  {riskThresholdEvaluation.status === "breach"
                    ? "BREACHED"
                    : riskThresholdEvaluation.status === "warn"
                      ? "APPROACHING"
                      : riskThresholdEvaluation.status === "ok"
                        ? "WITHIN LIMIT"
                        : "ARMED"}
                </span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">60m Exposure</span>
                <span className="sd-status-tip-value">
                  ${Math.round(riskThresholdEvaluation.totalRiskUsd).toLocaleString()}
                </span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">Warning Limit</span>
                <span className="sd-status-tip-value">
                  ${riskThresholdEvaluation.warningLimitUsd.toLocaleString()}
                </span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">Breach Limit</span>
                <span className="sd-status-tip-value">
                  ${riskThresholdEvaluation.limitUsd.toLocaleString()}
                </span>
              </span>
              <span className="sd-status-tip-row">
                <span className="sd-status-tip-label">
                  {riskThresholdEvaluation.isBreached ? "Over Limit By" : "Headroom Left"}
                </span>
                <span
                  className="sd-status-tip-value"
                  style={{
                    color: riskThresholdEvaluation.isBreached ? "#f87171" : undefined,
                  }}
                >
                  {riskThresholdEvaluation.isBreached
                    ? `+$${Math.round(riskThresholdEvaluation.excessUsd).toLocaleString()}`
                    : `$${Math.round(riskThresholdEvaluation.remainingUsd).toLocaleString()}`}
                </span>
              </span>
              <span className="sd-status-tip-meta">
                Click to inspect 60m chart &amp; adjust threshold in Risk Overview
              </span>
            </span>
          </span>
          <button
            type="button"
            className="sd-telemetry-item"
            onClick={() => {
              openShiftHandoffModal()
            }}
            style={{
              padding: "4px 9px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 600,
              background: "#1e293b",
              color: "#94a3b8",
              border: "1px solid #334155",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
            title="Operator Shift Summary Handoff"
          >
            📋 Shift Handoff
          </button>
          <span className="sd-telemetry-item">
            <ShiftDurationTimer
              operatorSignedInAt={operatorSignedInAt}
              signedOut={operatorSignedOut}
              handoffInitiated={shiftHandoffInitiated}
              onClick={() => {
                openShiftHandoffModal()
              }}
            />
          </span>
          <button
            type="button"
            className="sd-telemetry-item"
            data-copy-view-link="true"
            onClick={handleCopyQuickLink}
            style={{
              padding: "4px 9px",
              borderRadius: "6px",
              fontSize: "11px",
              fontWeight: 600,
              background: "#1e293b",
              color: quickLinkCopyState === "failed" ? "#fca5a5" : "#4ade80",
              border: "1px solid #334155",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
            title="Copy this exact view — tab, filters, sort and overlay — as a shareable link"
          >
            {quickLinkCopyState === "copied"
              ? "✓ View link copied"
              : quickLinkCopyState === "failed"
                ? "⚠ Copy failed"
                : "⧉ Copy view"}
          </button>
          {!viewIsDefault && (
            <button
              type="button"
              className="sd-telemetry-item"
              data-reset-view="true"
              onClick={handleResetView}
              style={{
                padding: "4px 9px",
                borderRadius: "6px",
                fontSize: "11px",
                fontWeight: 600,
                background: "#1e293b",
                color: "#94a3b8",
                border: "1px solid #334155",
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
              title="Reset tab, filters, sort and overlays to defaults"
            >
              ↺ Reset view
            </button>
          )}
          <button
            type="button"
            className="sd-pill sd-mono sd-telemetry-item"
            style={{ cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 }}
            onClick={() => {
              const next = !showBuildMatrix
              setShowBuildMatrix(next)
              if (next && !buildMatrixRows && !buildMatrixLoading) {
                fetchBuildMatrix()
              }
            }}
            title="Inspect compile-time bun:bundle dead-code elimination & tokens.toml CSS Houdini registry"
          >
            🧬 Target: {runtimeFlags.target.toUpperCase()} (
            {runtimeFlags.enabledFeatures.length > 0
              ? runtimeFlags.enabledFeatures.join("+")
              : "HMR"}
            )
          </button>
          <span className="sd-telemetry-sep" aria-hidden="true">
            ·
          </span>
          <a
            href="/live-bets"
            target="_blank"
            rel="noreferrer"
            className="sd-telemetry-item"
            style={{
              color: "#38bdf8",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            📈 Live Bets ↗
          </a>
          <a
            href="/graph"
            target="_blank"
            rel="noreferrer"
            className="sd-telemetry-item"
            style={{
              color: "#38bdf8",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            🕸️ Graph ↗
          </a>
          <a
            href="/status"
            target="_blank"
            rel="noreferrer"
            className="sd-telemetry-item"
            style={{
              color: "#38bdf8",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            🩺 Status ↗
          </a>
          <span className="sd-telemetry-sep" aria-hidden="true">
            ·
          </span>
          <span className="sd-telemetry-item" style={{ color: "#f59e0b", fontWeight: 600 }}>
            🛡️ autoExecute: false
          </span>
          {clockTime && (
            <>
              <span className="sd-telemetry-sep" aria-hidden="true">
                ·
              </span>
              <span
                className="sd-telemetry-item"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontFamily:
                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontVariantNumeric: "tabular-nums",
                  color: "#f1f5f9",
                }}
              >
                <span>🕒 {clockTime}</span>
                {(() => {
                  const absDrift = clockDrift ? Math.abs(clockDrift.offsetMs) : null
                  const driftUi =
                    absDrift === null
                      ? {
                          color: "#94a3b8",
                          borderColor: "rgba(148, 163, 184, 0.28)",
                          bg: "rgba(15, 23, 42, 0.72)",
                          status: "PROBING",
                          label: "Δ …",
                        }
                      : absDrift > 2000
                        ? {
                            color: "#f87171",
                            borderColor: "rgba(248, 113, 113, 0.38)",
                            bg: "rgba(127, 29, 29, 0.28)",
                            status: "DRIFT",
                            label: `Δ ${formatClockDrift(clockDrift!.offsetMs)}`,
                          }
                        : absDrift > 250
                          ? {
                              color: "#fbbf24",
                              borderColor: "rgba(251, 191, 36, 0.38)",
                              bg: "rgba(120, 53, 15, 0.25)",
                              status: "SKEW",
                              label: `Δ ${formatClockDrift(clockDrift!.offsetMs)}`,
                            }
                          : {
                              color: "#4ade80",
                              borderColor: "rgba(74, 222, 128, 0.3)",
                              bg: "rgba(20, 83, 45, 0.24)",
                              status: "SYNCED",
                              label: `Δ ${formatClockDrift(clockDrift!.offsetMs)}`,
                            }
                  const driftDirection =
                    clockDrift === null
                      ? "Awaiting /health server timestamp"
                      : Math.abs(clockDrift.offsetMs) < 1
                        ? "Local browser clock matches server time"
                        : clockDrift.offsetMs > 0
                          ? "Local browser clock is ahead of server"
                          : "Local browser clock is behind server"
                  return (
                    <span className="sd-status-tip-wrap">
                      <span
                        tabIndex={0}
                        data-clock-drift-indicator="true"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          padding: "1px 5px",
                          borderRadius: "4px",
                          fontSize: "10px",
                          fontWeight: 600,
                          lineHeight: 1.3,
                          fontVariantNumeric: "tabular-nums",
                          color: driftUi.color,
                          backgroundColor: driftUi.bg,
                          borderWidth: "1px",
                          borderStyle: "solid",
                          borderColor: driftUi.borderColor,
                          cursor: "help",
                          whiteSpace: "nowrap",
                        }}
                        title={
                          clockDrift
                            ? `Clock drift (Local − Server): ${formatClockDrift(clockDrift.offsetMs)} · RTT ${clockDrift.rttMs}ms · Server UTC ${clockDrift.serverIso}`
                            : "Measuring local browser vs /health server clock drift…"
                        }
                      >
                        {driftUi.label}
                      </span>
                      <span
                        role="tooltip"
                        className="sd-status-tip-popover sd-status-tip-popover--right"
                        style={{ minWidth: "264px", maxWidth: "300px" }}
                      >
                        <span className="sd-status-tip-title">
                          <span>Clock Drift</span>
                          <span style={{ color: driftUi.color }}>{driftUi.status}</span>
                        </span>
                        <span className="sd-status-tip-row">
                          <span className="sd-status-tip-label">Local − Server</span>
                          <span className="sd-status-tip-value">
                            {clockDrift ? formatClockDrift(clockDrift.offsetMs) : "—"}
                          </span>
                        </span>
                        <span className="sd-status-tip-row">
                          <span className="sd-status-tip-label">Probe RTT</span>
                          <span className="sd-status-tip-value">
                            {clockDrift ? `${clockDrift.rttMs} ms` : "—"}
                          </span>
                        </span>
                        <span className="sd-status-tip-row">
                          <span className="sd-status-tip-label">Server UTC</span>
                          <span className="sd-status-tip-value">
                            {clockDrift ? `${clockDrift.serverIso.slice(11, 23)}Z` : "—"}
                          </span>
                        </span>
                        <ClockDriftSparkline
                          samples={clockDriftHistory}
                          accentColor={driftUi.color}
                        />
                        <span className="sd-status-tip-meta">
                          {driftDirection}
                          {clockDrift
                            ? ` · Sampled via /health (${healthUpdateInfo.relative})`
                            : ""}
                        </span>
                      </span>
                    </span>
                  )
                })()}
              </span>
            </>
          )}
        </div>

        {/* Row 3: Primary Scrollable Tab Bar & Global Search */}
        <div className="sd-header-primary-row">
          <nav
            aria-label="Primary Surveillance Navigation"
            data-header-primary-nav="true"
            className="sd-primary-nav"
          >
            {(
              [
                {
                  id: "risk-overview",
                  label: "Risk Overview",
                  icon: ShieldAlert,
                },
                {
                  id: "churn-simulation",
                  label: "Bettor Churn Simulation",
                  icon: Activity,
                },
                {
                  id: "system-logs",
                  label: "System Logs",
                  icon: ScrollText,
                },
                {
                  id: "status-dashboard",
                  label: "Status & Config",
                  icon: SlidersHorizontal,
                },
              ] as const
            ).map((item) => {
              const active = activeTab === item.id
              const Icon = item.icon
              return (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  aria-current={active ? "page" : undefined}
                  className="sd-primary-nav-link"
                  onClick={(e) => {
                    e.preventDefault()
                    navigatePrimaryRoute(item.id)
                  }}
                >
                  <Icon
                    size={13}
                    aria-hidden="true"
                    style={{
                      color:
                        item.id === "risk-overview" && riskThresholdEvaluation.isBreached
                          ? "#f87171"
                          : active
                            ? "#38BDF8"
                            : "currentColor",
                    }}
                  />
                  <span>{item.label}</span>
                  {item.id === "risk-overview" &&
                  (riskThresholdEvaluation.isBreached || riskThresholdEvaluation.isWarning) ? (
                    <span
                      className={`sd-nav-alert-badge sd-nav-alert-badge--${riskThresholdEvaluation.status}`}
                    >
                      {riskThresholdEvaluation.isBreached ? "LIMIT" : "WARN"}
                    </span>
                  ) : null}
                </a>
              )
            })}
          </nav>

          <GlobalHeaderSearch
            query={globalSearch}
            onQueryChange={setGlobalSearch}
            wagers={liveWagers}
            customers={profileCustomers}
            tickers={betTickerData?.localFeed.tickets ?? []}
            onSelectCustomer={(customer) => {
              setSelectedCustomer(customer)
              setSearchQuery(customer.id)
              setFilterTier("ALL")
              setCustomerLookupNotice(null)
              setActiveTab("customers")
            }}
            onSelectWager={(wager) => {
              setWagerSportFilter("ALL")
              setWagerAlertFilter("ALL")
              setWagerTypeFilter("ALL")
              setWagerChannelFilter("ALL")
              setWagerSearch(wager.ticketId)
              setSelectedWager(wager)
              syncTicketInspectorToLocation(wager.ticketId)
              setActiveTab("wagers")
            }}
            onSelectTicker={(ticket) => {
              setBetTickerSearch(ticket.ticketId)
              setActiveTab("bet-ticker")
            }}
            onViewAllInTab={(tab, q) => {
              if (tab === "customers") {
                setFilterTier("ALL")
                setSearchQuery(q)
                setCustomerLookupNotice(null)
                setActiveTab("customers")
              } else if (tab === "bet-ticker") {
                setBetTickerSearch(q)
                setActiveTab("bet-ticker")
              } else {
                setWagerSportFilter("ALL")
                setWagerAlertFilter("ALL")
                setWagerTypeFilter("ALL")
                setWagerChannelFilter("ALL")
                setWagerSearch(q)
                setActiveTab("wagers")
              }
            }}
          />
        </div>

        {/* Row 4: Desktop (>= 1024px) 10-Item Workspace Navigation + Operator Session Pill */}
        <div
          className="sd-desktop-tab-bar"
          data-desktop-workspace-nav="true"
          style={styles.tabNav}
        >
          {renderWorkspaceNavItems(false)}
          {renderOperatorMenu()}
        </div>
      </header>

      {/* Mobile (< 1024px) Slide-Over Workspace Navigation Drawer */}
      {mobileNavOpen && (
        <div
          className="sd-mobile-drawer-backdrop"
          data-mobile-nav-backdrop="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setMobileNavOpen(false)
            }
          }}
        >
          <aside
            id="sd-mobile-nav-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace navigation"
            className="sd-mobile-drawer"
            data-mobile-nav-drawer="true"
          >
            <div className="sd-mobile-drawer-header">
              <div className="sd-mobile-drawer-title">Workspace Navigation</div>
              <button
                type="button"
                className="sd-mobile-drawer-close"
                aria-label="Close navigation menu"
                onClick={() => setMobileNavOpen(false)}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="sd-mobile-drawer-session" data-mobile-drawer-session="true">
              {renderOperatorMenu()}
            </div>
            <nav
              className="sd-mobile-drawer-list"
              aria-label="Workspace modules"
              data-mobile-drawer-list="true"
            >
              {renderWorkspaceNavItems(true)}
            </nav>
          </aside>
        </div>
      )}

      {showBuildMatrix ? (
        <BuildMatrixDrawer
          dceMarker={runtimeFlags.dceMarker}
          activeSentinels={runtimeFlags.sentinels}
          loading={buildMatrixLoading}
          rows={buildMatrixRows}
          staticDir={buildMatrixStaticDir}
          target={runtimeFlags.target}
          enabledFeatures={runtimeFlags.enabledFeatures}
          error={buildMatrixError}
          generatedAt={buildMatrixGeneratedAt}
          compiledMs={buildMatrixCompiledMs}
          onRefresh={() => fetchBuildMatrix(true)}
        />
      ) : null}

      {/* Cross-Desk Operations Command Ribbon */}
      <section
        aria-label="Operations Command Ribbon"
        className="sd-quickjump-ribbon"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px 14px",
          padding: "8px 20px",
          backgroundColor: "#0b1120",
          borderBottom: "1px solid #1e293b",
          fontSize: "11px",
          color: "#cbd5e1",
        }}
      >
        <div className="sd-quickjump-strip">
          <span
            className="sd-quickjump-label"
            style={{
              fontWeight: 700,
              color: "#38bdf8",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            🧭 Desk Quick-Jump:
          </span>
          <button
            type="button"
            className={`sd-quickjump-pill ${shadowSliceHasTapeFocus(activeShadowSlice) ? "sd-quickjump-pill--amber" : "sd-quickjump-pill--sky"}`}
            data-desk-quickjump="active-risk"
            onClick={openWagersForShadowSlice}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: shadowSliceHasTapeFocus(activeShadowSlice)
                ? "1px solid rgba(251, 191, 36, 0.45)"
                : "1px solid rgba(56, 189, 248, 0.35)",
              backgroundColor: shadowSliceHasTapeFocus(activeShadowSlice)
                ? "rgba(251, 191, 36, 0.14)"
                : "rgba(56, 189, 248, 0.1)",
              color: shadowSliceHasTapeFocus(activeShadowSlice) ? "#fde68a" : "#7dd3fc",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
            title={
              shadowSliceHasTapeFocus(activeShadowSlice)
                ? `Filter Live Wagers to URL shadow slice: ${buildDashboardShadowSliceUrl(activeShadowSlice, { matrix: showBuildMatrix })}`
                : "Open full Live Wagers tape"
            }
          >
            ⚡{" "}
            {shadowSliceHasTapeFocus(activeShadowSlice)
              ? `Slice Risk (${formatShadowSliceRibbonLabel(activeShadowSlice)}):`
              : "Active Risk:"}{" "}
            ${tapeRiskUsd.toLocaleString()} ({tapeTicketCount} tickets
            {shadowSliceTape.criticalOrSteam > 0
              ? ` · ${shadowSliceTape.criticalOrSteam} crit/steam`
              : ""}
            )
            <span
              data-quickjump-feed-age="true"
              className="sd-quickjump-feed-age"
              style={{
                marginLeft: "4px",
                color: quickJumpFeed.stale ? "#fbbf24" : "#64748b",
                fontWeight: 400,
              }}
              title={feedFreshnessTitle(quickJumpFeed, wagersProvenance.label)}
            >
              {" "}
              · {quickJumpFeed.label}
              {quickJumpFeed.stale ? " ⚠" : ""}
            </span>
          </button>
          <button
            type="button"
            className="sd-quickjump-pill sd-quickjump-pill--amber"
            data-desk-quickjump="nfl-1h-pregame"
            onClick={() => {
              applyShadowSliceToLocation(NFL_1H_PREGAME_SLICE, {
                matrix: showBuildMatrix,
              })
              setActiveTab("shadow")
            }}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(234, 179, 8, 0.4)",
              backgroundColor: "rgba(234, 179, 8, 0.12)",
              color: "#facc15",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
            title="Shadow matrix: NFL · 1H · Pregame (matches ?matrix=1&sport=Football&subSport=NFL&period=1h&regime=pregame)"
          >
            🏈 NFL 1H Pregame
          </button>
          <a
            href={buildBookdeskopsTokensDeskHref(
              shadowSliceHasTapeFocus(activeShadowSlice) ? activeShadowSlice : undefined,
            )}
            target="_blank"
            rel="noreferrer"
            className="sd-quickjump-pill sd-quickjump-pill--neutral"
            data-desk-quickjump="bookdeskops-tokens"
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(148, 163, 184, 0.35)",
              backgroundColor: "rgba(148, 163, 184, 0.1)",
              color: "#e2e8f0",
              fontSize: "11px",
              fontWeight: 600,
              textDecoration: "none",
            }}
            title="BookDeskOps serve-local tokens desk (DCE compile-time anchor)"
          >
            📎 BookDeskOps tokens
          </a>
          <a
            href={buildBookdeskopsDirectoryRouteHref()}
            target="_blank"
            rel="noreferrer"
            className="sd-quickjump-pill sd-quickjump-pill--sky"
            data-desk-quickjump="bookdeskops-directory"
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(56, 189, 248, 0.35)",
              backgroundColor: "rgba(56, 189, 248, 0.1)",
              color: "#38bdf8",
              fontSize: "11px",
              fontWeight: 600,
              textDecoration: "none",
            }}
            title="BookDeskOps serve-local /static/* directory route inspector & HTTP probes"
          >
            📁 /static/* Dir
          </a>
          <button
            type="button"
            className="sd-quickjump-pill sd-quickjump-pill--amber"
            data-desk-quickjump="ncaab"
            data-quickjump-active={quickJumpNcaabActive ? "true" : undefined}
            aria-current={quickJumpNcaabActive ? "page" : undefined}
            onClick={() => {
              setWagerSportFilter("NCAAB")
              setWagerSearch("")
              setWagerChannelFilter("ALL")
              setActiveTab("wagers")
            }}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: quickJumpNcaabActive
                ? "1px solid #fbbf24"
                : "1px solid rgba(245, 158, 11, 0.35)",
              backgroundColor: quickJumpNcaabActive
                ? "rgba(245, 158, 11, 0.26)"
                : "rgba(245, 158, 11, 0.12)",
              color: "#fbbf24",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: quickJumpNcaabActive ? "0 0 0 1px rgba(251, 191, 36, 0.35)" : undefined,
            }}
            title="Filter Live Wagers to College Basketball (NCAAB 1H & Game)"
          >
            🏀 NCAAB Slice ({liveWagers.filter((w) => w.sport.toUpperCase() === "NCAAB").length})
          </button>
          {(
            [
              {
                id: "GSLIVE",
                label: "🔴 GSLIVE",
                title: "Filter Live Wagers to GSLIVE (Partner 118 in-play)",
              },
              {
                id: "GSBUILDER",
                label: "🧩 GS Builder",
                title: "Filter Live Wagers to GS Builder (Partner 118 SGP builder)",
              },
            ] as const
          ).map((channel) => {
            const count = liveWagers.filter(
              (w) => (w.writer ?? wagerChannelOf(w.ticketWriter)) === channel.id.toLowerCase(),
            ).length
            const channelActive = activeTab === "wagers" && quickJumpChannelFilter === channel.id
            return (
              <button
                key={channel.id}
                type="button"
                className="sd-quickjump-pill sd-quickjump-pill--violet"
                data-desk-quickjump={channel.id.toLowerCase()}
                data-quickjump-active={channelActive ? "true" : undefined}
                aria-current={channelActive ? "page" : undefined}
                onClick={() => {
                  setWagerSportFilter("ALL")
                  setWagerSearch("")
                  setWagerChannelFilter(channel.id)
                  setActiveTab("wagers")
                }}
                style={{
                  padding: "3px 9px",
                  borderRadius: "999px",
                  border: channelActive
                    ? "1px solid #d8b4fe"
                    : "1px solid rgba(192, 132, 252, 0.35)",
                  backgroundColor: channelActive
                    ? "rgba(192, 132, 252, 0.26)"
                    : "rgba(192, 132, 252, 0.12)",
                  color: "#d8b4fe",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  boxShadow: channelActive ? "0 0 0 1px rgba(216, 180, 254, 0.35)" : undefined,
                }}
                title={channel.title}
              >
                {channel.label} ({count})
              </button>
            )
          })}
          <button
            type="button"
            className="sd-quickjump-pill sd-quickjump-pill--green"
            data-desk-quickjump="audit"
            data-quickjump-active={quickJumpAuditActive ? "true" : undefined}
            aria-current={quickJumpAuditActive ? "page" : undefined}
            onClick={() => {
              handleSelectCustomerById("BRT106")
            }}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: quickJumpAuditActive
                ? "1px solid #4ade80"
                : "1px solid rgba(34, 197, 94, 0.38)",
              backgroundColor: quickJumpAuditActive
                ? "rgba(34, 197, 94, 0.26)"
                : "rgba(34, 197, 94, 0.12)",
              color: "#4ade80",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: quickJumpAuditActive ? "0 0 0 1px rgba(74, 222, 128, 0.35)" : undefined,
            }}
            title="Inspect BRT106 (BGMASTER / BILLY666) 3-endpoint portal & figureDate reconciliation"
          >
            🧾 Figure-Date Audit: BRT106
          </button>
          <div
            role="group"
            aria-label="System Logs Quick-Jump Status Filters"
            className="sd-quickjump-group-logs"
            data-desk-quickjump="system-logs"
            data-quickjump-active={activeTab === "system-logs" ? "true" : undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "2px 4px 2px 8px",
              borderRadius: "999px",
              border:
                activeTab === "system-logs"
                  ? "1px solid rgba(56, 189, 248, 0.7)"
                  : "1px solid rgba(56, 189, 248, 0.34)",
              backgroundColor:
                activeTab === "system-logs" ? "rgba(56, 189, 248, 0.16)" : "rgba(15, 23, 42, 0.78)",
              boxShadow:
                activeTab === "system-logs" ? "0 0 0 1px rgba(56, 189, 248, 0.28)" : undefined,
            }}
          >
            <button
              type="button"
              onClick={() => {
                setSystemLogSeverityFilter("ALL")
                navigatePrimaryRoute("system-logs")
              }}
              aria-current={
                activeTab === "system-logs" && systemLogSeverityFilter === "ALL"
                  ? "page"
                  : undefined
              }
              title="Open System Logs & Weblogs Inspector (all statuses)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                background: "none",
                border: "none",
                padding: "1px 4px 1px 0",
                color: activeTab === "system-logs" ? "#e0f2fe" : "#7dd3fc",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <ScrollText size={11} aria-hidden="true" />
              <span>System Logs</span>
            </button>
            {(
              [
                {
                  id: "CRITICAL",
                  short: "CRIT",
                  toneClass: "sd-quickjump-pill--red",
                  fg: "#fca5a5",
                  bg: "rgba(239, 68, 68, 0.18)",
                  activeBg: "rgba(239, 68, 68, 0.36)",
                  border: "rgba(239, 68, 68, 0.45)",
                },
                {
                  id: "HIGH",
                  short: "HIGH",
                  toneClass: "sd-quickjump-pill--amber",
                  fg: "#fcd34d",
                  bg: "rgba(245, 158, 11, 0.16)",
                  activeBg: "rgba(245, 158, 11, 0.34)",
                  border: "rgba(245, 158, 11, 0.45)",
                },
                {
                  id: "WATCH",
                  short: "WATCH",
                  toneClass: "sd-quickjump-pill--sky",
                  fg: "#7dd3fc",
                  bg: "rgba(56, 189, 248, 0.14)",
                  activeBg: "rgba(56, 189, 248, 0.32)",
                  border: "rgba(56, 189, 248, 0.42)",
                },
                {
                  id: "NORMAL",
                  short: "NORM",
                  toneClass: "sd-quickjump-pill--green",
                  fg: "#86efac",
                  bg: "rgba(34, 197, 94, 0.14)",
                  activeBg: "rgba(34, 197, 94, 0.3)",
                  border: "rgba(34, 197, 94, 0.42)",
                },
              ] as const
            ).map((sev) => {
              const isSelected = activeTab === "system-logs" && systemLogSeverityFilter === sev.id
              const count = systemLogSeverityCounts?.[sev.id]
              return (
                <button
                  key={sev.id}
                  type="button"
                  className={`sd-quickjump-pill ${sev.toneClass}`}
                  data-desk-quickjump={`system-logs-${sev.short.toLowerCase()}`}
                  aria-pressed={isSelected}
                  onClick={() => {
                    const next: WebLogSeverityFilter = isSelected ? "ALL" : sev.id
                    setSystemLogSeverityFilter(next)
                    navigatePrimaryRoute("system-logs")
                  }}
                  title={`Jump to System Logs filtered by ${sev.id}${typeof count === "number" ? ` (${count} entries)` : ""}`}
                  style={{
                    padding: "1px 6px",
                    borderRadius: "999px",
                    border: `1px solid ${isSelected ? sev.fg : sev.border}`,
                    backgroundColor: isSelected ? sev.activeBg : sev.bg,
                    color: sev.fg,
                    fontSize: "10px",
                    fontWeight: 700,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontVariantNumeric: "tabular-nums",
                    lineHeight: 1.4,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    boxShadow: isSelected ? `0 0 0 1px ${sev.border}` : undefined,
                  }}
                >
                  {sev.short}
                  {typeof count === "number" ? `:${count}` : ""}
                </button>
              )
            })}
          </div>
        </div>
        <div
          className="sd-quickjump-meta"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px 12px",
            color: "#94a3b8",
          }}
        >
          <span>
            Bridge 3a Watermark:{" "}
            <code style={{ color: "#e2e8f0" }}>
              {betTickerData?.bridge3aR2.watermark ?? "pending"}
            </code>
          </span>
          <span>·</span>
          <span>
            Top Conduit:{" "}
            {rankings?.conduits[0] ? (
              <button
                type="button"
                onClick={() => setSelectedAgentId(rankings.conduits[0]?.agentId ?? null)}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "#38bdf8",
                  fontWeight: 600,
                  fontSize: "11px",
                  cursor: "pointer",
                }}
              >
                {rankings.conduits[0].agentId} ({rankings.conduits[0].concPct.toFixed(1)}%) ↗
              </button>
            ) : (
              <code style={{ color: "#94a3b8" }} title={rankingsError ?? ""}>
                {rankingsStatus === "pending"
                  ? "pending"
                  : rankingsStatus === "ready"
                    ? "none flagged"
                    : "unavailable"}
              </code>
            )}
          </span>
          <span>·</span>
          <span
            data-quickjump-feed="true"
            style={quickJumpFeed.stale ? { color: "#fbbf24", fontWeight: 600 } : undefined}
            title={feedFreshnessTitle(quickJumpFeed, wagersProvenance.label)}
          >
            feed: {wagersProvenance.label} · {quickJumpFeed.label}
            {quickJumpFeed.stale ? " ⚠" : ""}
          </span>
          <button
            type="button"
            className="sd-quickjump-pill sd-quickjump-pill--neutral"
            data-desk-quickjump="copy-link"
            onClick={handleCopyQuickLink}
            style={{
              padding: "3px 9px",
              borderRadius: "999px",
              border: "1px solid rgba(148, 163, 184, 0.35)",
              backgroundColor: "rgba(148, 163, 184, 0.12)",
              color: "#cbd5e1",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
            title="Copy this exact view — tab, filters and shadow slice — as a deep link"
          >
            {quickLinkCopyState === "copied"
              ? "✓ Copied"
              : quickLinkCopyState === "failed"
                ? "⚠ Copy blocked"
                : "⧉ Copy link"}
          </button>
        </div>
      </section>

      {/* Main View Area */}
      <main className="sd-main-canvas" style={styles.main}>
        <DashboardBreadcrumbs
          activeTab={activeTab}
          selectedCustomerId={selectedCustomer?.id ?? focusedCustomerId}
          customerTierFilter={filterTier}
          selectedWagerTicketId={selectedWager?.ticketId ?? null}
          wagerChannelFilter={wagerChannelFilter}
          wagerSportFilter={wagerSportFilter}
          selectedAgentId={selectedAgentId}
          alertFilter={alertFilter}
          systemLogSeverityFilter={systemLogSeverityFilter}
          onBreadcrumbAction={(action: BreadcrumbAction) => {
            switch (action.kind) {
              case "navigate-tab":
                if (action.clearContext) {
                  setSelectedCustomer(null)
                  setFocusedCustomerId(null)
                  setFilterTier("ALL")
                  setSelectedWager(null)
                  setWagerChannelFilter("ALL")
                  setWagerSportFilter("ALL")
                  setSelectedAgentId(null)
                  setAlertFilter("ALL")
                  setSystemLogSeverityFilter("ALL")
                }
                setActiveTab(action.tab)
                break
              case "clear-customer":
                setSelectedCustomer(null)
                setFocusedCustomerId(null)
                break
              case "clear-customer-tier":
                setFilterTier("ALL")
                break
              case "clear-wager":
                setSelectedWager(null)
                break
              case "clear-wager-filters":
                setWagerChannelFilter("ALL")
                setWagerSportFilter("ALL")
                break
              case "clear-agent":
                setSelectedAgentId(null)
                break
              case "clear-alert-filter":
                setAlertFilter("ALL")
                break
              case "clear-log-severity":
                setSystemLogSeverityFilter("ALL")
                break
            }
          }}
        />
        <PanelErrorBoundary
          panelKey={activeTab}
          resetKeys={[activeTab]}
          onError={(error, info, panelKey) => {
            console.error(
              `[SportsDeskOps] Panel render failure in "${panelKey ?? activeTab}":`,
              error,
              info.componentStack,
            )
          }}
          onReset={(panelKey) => {
            if (panelKey === "wagers") void fetchLiveWagers()
            else if (panelKey === "alerts") void fetchAlerts(alertFilter)
            else if (panelKey === "bet-ticker") void fetchBetTicker()
            else if (panelKey === "r2") void fetchR2Pipeline(true)
            else if (panelKey === "surveillance") void fetchDnsTelemetry()
          }}
          onReturnSafeTab={activeTab !== "wagers" ? () => setActiveTab("wagers") : undefined}
        >
          {!authReady ? (
            <DashboardAuthShellSkeleton activeTab={activeTab} />
          ) : activeTab === "customers" ? (
            <CustomersTabPanel
              bannerDismissed={bannerDismissed}
              onDismissBanner={() => {
                setBannerDismissed(true)
                try {
                  sessionStorage.setItem("portalBannerDismissed", "1")
                } catch {}
              }}
              kpisCollapsed={kpisCollapsed}
              onToggleKpis={() => {
                const next = !kpisCollapsed
                setKpisCollapsed(next)
                try {
                  localStorage.setItem("kpisCollapsed", next ? "1" : "0")
                } catch {}
              }}
              cohortsReport={cohortsReport}
              cohortsStatus={cohortsStatus}
              cohortsError={cohortsError}
              searchQuery={searchQuery}
              onSearchQueryChange={(value) => {
                setSearchQuery(value)
                setCustomerLookupNotice(null)
              }}
              customerLookupNotice={customerLookupNotice}
              onClearCustomerLookupNotice={() => {
                setCustomerLookupNotice(null)
              }}
              filterTier={filterTier}
              onFilterTierChange={setFilterTier}
              allProfileCustomers={profileCustomers}
              profileClassifications={profileClassifications}
              activeProfileTagIds={activeProfileTagIds}
              onToggleProfileTag={handleToggleProfileTag}
              onClearProfileTags={handleClearProfileTags}
              profileTagCategoryFilter={profileTagCategoryFilter}
              onProfileTagCategoryFilterChange={setProfileTagCategoryFilter}
              onAddCustomProfileTag={handleAddCustomProfileTag}
              onRemoveCustomProfileTag={handleRemoveCustomProfileTag}
              telemetryRefresh={telemetryRefreshSnapshot}
              onRefreshTelemetry={() => {
                void handleRefreshTelemetry()
              }}
              sharpestOnChainXref={sharpestOnChainXref}
              sortedCustomers={sortedCustomers}
              customerSort={customerSort}
              onCustomerSort={onCustomerSort}
              selectedCustomer={
                selectedCustomer
                  ? (profileCustomers.find(
                      (c) => c.id.toUpperCase() === selectedCustomer.id.toUpperCase(),
                    ) ?? selectedCustomer)
                  : null
              }
              onSelectCustomer={(customer) => {
                const upper = customer.id.toUpperCase()
                appliedCustomerFocusRef.current = upper
                setFocusedCustomerId(upper)
                setSelectedCustomer(customer)
                setCustomerLookupNotice(null)
              }}
              onSelectCustomerById={(customerId) => {
                const upper = customerId.trim().toUpperCase()
                if (!upper) return
                const matched = profileCustomers.find((c) => c.id.toUpperCase() === upper)
                if (matched) {
                  appliedCustomerFocusRef.current = upper
                  setFocusedCustomerId(upper)
                  setSelectedCustomer(matched)
                  setCustomerLookupNotice(null)
                  setSearchQuery("")
                  setFilterTier("ALL")
                  handleClearProfileTags()
                } else {
                  setSearchQuery(upper)
                  setCustomerLookupNotice(upper)
                }
              }}
              copiedCliId={copiedCliId}
              onCopyCli={(customerId) => {
                const cmd = `bun run cli -C ${customerId}`
                void copyText(cmd)
                setCopiedCliId(customerId)
                setTimeout(() => setCopiedCliId(null), 2000)
              }}
              customerReverseForensics={customerForensicResult}
              onClearForensicResult={() => setCustomerReverseForensics(null)}
              onRunReverseLookup={(ipAddress) => {
                void runReverseLookup(ipAddress)
              }}
              onOpenTerminalProfile={(customerId) => {
                setActiveTab("terminal")
                void runTerminalCommand(`profile ${customerId}`)
              }}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              profilesUnavailableReason={
                cohortsStatus === "ready" && profileCustomers.length === 0
                  ? PROFILES_UNAVAILABLE_REASON
                  : null
              }
              profilesProvenance={profilesProvenance}
              matrixMode={showBuildMatrix}
              matrixProfileOverlay={matrixProfileOverlay}
              onOpenTerminalRadar={(customerId) => {
                setActiveTab("terminal")
                void runTerminalCommand(`profile ${customerId} --radar`)
              }}
              onRunTerminalCommand={(cmd) => {
                setActiveTab("terminal")
                void runTerminalCommand(cmd)
              }}
              onViewCustomerWagers={(customerId) => {
                setWagerSportFilter("ALL")
                setWagerAlertFilter("ALL")
                setWagerTypeFilter("ALL")
                setWagerSearch(customerId)
                const match = liveWagers.find(
                  (w) => w.customerId.toUpperCase() === customerId.toUpperCase(),
                )
                if (match) {
                  setSelectedWager(match)
                }
                setActiveTab("wagers")
              }}
              liveWagers={liveWagers}
              onSelectWager={(wager) => {
                setWagerSportFilter("ALL")
                setWagerAlertFilter("ALL")
                setWagerTypeFilter("ALL")
                setWagerChannelFilter("ALL")
                setWagerSearch(wager.ticketId)
                setSelectedWager(wager)
                syncTicketInspectorToLocation(wager.ticketId)
                setActiveTab("wagers")
              }}
            />
          ) : activeTab === "surveillance" ? (
            <SurveillanceTabPanel
              dnsData={dnsData}
              dnsRefreshing={dnsRefreshing}
              dnsError={dnsError}
              onRefreshDns={() => {
                void fetchDnsTelemetry()
              }}
              benchHost={benchHost}
              onBenchHostChange={setBenchHost}
              benchLoading={benchLoading}
              benchResult={benchResult}
              onRunBenchmark={() => {
                void runBenchmark()
              }}
              reverseIp={reverseIp}
              onReverseIpChange={setReverseIp}
              reverseForensics={reverseForensics}
              onRunReverseLookup={() => {
                void runReverseLookup()
              }}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              data={data}
              headerSync={surveillanceHeaderSync}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
            />
          ) : activeTab === "terminal" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {serverAuthState.authRequired &&
                !(serverAuthState.devQuickLoginAvailable && serverAuthState.role === "ADMIN") && (
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "10px",
                      padding: "8px 12px",
                      borderRadius: "8px",
                      backgroundColor: "rgba(15, 23, 42, 0.85)",
                      border: "1px solid rgba(245, 158, 11, 0.35)",
                      fontSize: "12px",
                      color: "#cbd5e1",
                    }}
                  >
                    <span>
                      Admin credential required for{" "}
                      <code style={{ color: "#fbbf24" }}>POST /api/terminal/exec</code> (held in
                      memory only, never persisted).
                    </span>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        flexWrap: "wrap",
                      }}
                    >
                      {serverAuthState.devQuickLoginAvailable && (
                        <button
                          type="button"
                          disabled={authSubmitting}
                          onClick={() => {
                            void performDevQuickSignIn("ADMIN")
                          }}
                          style={{
                            padding: "5px 10px",
                            borderRadius: "6px",
                            border: "1px solid rgba(56, 189, 248, 0.55)",
                            backgroundColor: "rgba(2, 132, 199, 0.28)",
                            color: "#e0f2fe",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: authSubmitting ? "wait" : "pointer",
                          }}
                        >
                          {authSubmitting ? "Elevating..." : "Elevate to Dev Admin"}
                        </button>
                      )}
                      <input
                        type="password"
                        value={terminalAdminToken}
                        onChange={(e) => setTerminalAdminToken(e.target.value)}
                        placeholder="Enter x-admin-token..."
                        autoComplete="off"
                        style={{
                          minWidth: "220px",
                          padding: "5px 9px",
                          borderRadius: "6px",
                          backgroundColor: "#070b14",
                          border: "1px solid #334155",
                          color: "#f8fafc",
                          fontSize: "12px",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        }}
                      />
                    </div>
                  </div>
                )}
              <TerminalTabPanel
                terminalCategory={terminalCategory}
                onTerminalCategoryChange={setTerminalCategory}
                terminalHistory={terminalHistory}
                onClearHistory={() => setTerminalHistory([])}
                copiedTerminalIdx={copiedTerminalIdx}
                onCopyOutput={(idx, stdout) => {
                  void copyText(stripAnsi(stdout))
                  setCopiedTerminalIdx(idx)
                  setTimeout(() => setCopiedTerminalIdx(null), 1500)
                }}
                copiedCommandIdx={copiedCommandIdx}
                onCopyCommand={(idx, command) => {
                  void copyText(command)
                  setCopiedCommandIdx(idx)
                  setTimeout(() => setCopiedCommandIdx(null), 1500)
                }}
                terminalLoading={terminalLoading}
                terminalBottomRef={terminalBottomRef}
                terminalCommand={terminalCommand}
                onTerminalCommandChange={setTerminalCommand}
                commandHistory={commandHistory}
                historyIndex={historyIndex}
                onHistoryIndexChange={setHistoryIndex}
                onAutocomplete={handleAutocomplete}
                onRunCommand={(cmd) => {
                  void runTerminalCommand(cmd)
                }}
              />
            </div>
          ) : activeTab === "rankings" ? (
            <RankingsTabPanel
              rankingsSearch={rankingsSearch}
              onRankingsSearchChange={setRankingsSearch}
              rankingsFilter={rankingsFilter}
              onRankingsFilterChange={setRankingsFilter}
              onInspectPty={(customerId) => {
                setActiveTab("terminal")
                void runTerminalCommand(`p ${customerId} --radar`)
              }}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              onSelectCustomerById={handleSelectCustomerById}
              focusedCustomerId={focusedCustomerId}
              onFocusCustomer={handleFocusCustomerInDownlines}
              onClearFocusedCustomer={handleClearFocusedCustomer}
              selectedAgentIds={selectedDownlineAgentIds}
              onSelectedAgentIdsChange={setSelectedDownlineAgentIds}
              heatMapEnabled={rankingsHeatMapEnabled}
              onHeatMapEnabledChange={(enabled) => {
                setRankingsHeatMapEnabled(enabled)
                writeStoredRankingsHeatMap(enabled)
              }}
              rankings={rankings}
              rankingsStatus={rankingsStatus}
              rankingsError={rankingsError}
            />
          ) : activeTab === "alerts" ? (
            <AlertsTabPanel
              alertToast={alertToast}
              onDismissToast={() => setAlertToast(null)}
              onCopyDeliveryId={(deliveryId) => {
                void copyText(deliveryId)
                setAlertToast({
                  message: `Copied delivery UUID: ${deliveryId}`,
                  type: "info",
                })
              }}
              healthData={healthData}
              alertFilter={alertFilter}
              onFilterChange={(filter) => {
                setAlertFilter(filter)
                fetchAlerts(filter)
              }}
              alertLoading={alertLoading}
              onSweepAlerts={() => {
                void handleSweepAlerts()
              }}
              onRefreshAlerts={() => fetchAlerts(alertFilter)}
              onOpenShiftModal={() => {
                openShiftHandoffModal()
              }}
              alertRecords={alertRecords}
              tiersConfig={tiersConfig}
              onAckAlert={(deliveryId, notes) => {
                void handleAckAlert(deliveryId, notes)
              }}
              onRetryAlert={(deliveryId) => {
                void handleRetryAlert(deliveryId)
              }}
            />
          ) : activeTab === "shadow" ? (
            <ShadowPricingPanel
              onInspectAccount={handleSelectCustomerById}
              onRunPtyCommand={(cmd) => {
                setActiveTab("terminal")
                void runTerminalCommand(cmd)
              }}
            />
          ) : activeTab === "bet-ticker" ? (
            <BetTickerTabPanel
              data={betTickerData}
              loading={betTickerLoading}
              error={betTickerError}
              onRefresh={() => {
                void fetchBetTicker()
              }}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              onSelectCustomerById={handleSelectCustomerById}
              onInspectPty={(customerId) => {
                setActiveTab("terminal")
                void runTerminalCommand(`profile ${customerId} --radar`)
              }}
              searchQuery={betTickerSearch}
              onSearchQueryChange={setBetTickerSearch}
            />
          ) : activeTab === "r2" ? (
            <R2PipelineTabPanel
              data={r2PipelineData}
              history={r2PipelineHistory}
              historyError={r2PipelineHistoryError}
              loading={r2PipelineLoading}
              error={r2PipelineError}
              autoRefreshSeconds={r2AutoRefreshSeconds}
              nextRefreshAtMs={r2NextRefreshAtMs}
              onAutoRefreshChange={(seconds) => {
                setR2AutoRefreshSeconds(seconds)
                writeStoredR2AutoRefreshSeconds(seconds)
              }}
              onRefresh={(force) => {
                void (async () => {
                  await fetchR2Pipeline(Boolean(force))
                  await fetchR2PipelineHistory(false)
                  if (r2AutoRefreshSeconds > 0) {
                    setR2RefreshCycleNonce((n) => n + 1)
                  }
                })()
              }}
              onVerifyTickets={(dryRun) => {
                void runTicketVerification(dryRun ?? true)
              }}
              verifyingTickets={verifyingTickets}
              verifyTicketsError={verifyTicketsError}
            />
          ) : activeTab === "assets" ? (
            <BunAssetsTabPanel />
          ) : activeTab === "risk-overview" ? (
            <RiskOverviewPanel
              snapshotStatus={wagersProvenance.label}
              hasWagerSnapshot={hasLiveWagerSnapshot}
              wagers={liveWagers}
              customers={profileCustomers}
              alertRecords={alertRecords}
              wagersLastUpdatedAt={wagersUpdatedAt}
              wsSyncTick={wsSyncTick}
              wsLastSyncAt={wsLastSyncAt}
              streamingConnected={connected}
              exposureLimitUsd={riskThresholds.breachLimitUsd}
              warningLimitUsd={riskThresholds.warningLimitUsd}
              onChangeExposureLimitUsd={handleChangeRiskExposureLimitUsd}
              onChangeExposureThresholds={handleChangeRiskExposureThresholds}
              riskThresholdEvaluation={riskThresholdEvaluation}
              onRefreshWagers={() => {
                void fetchLiveWagers()
              }}
              onSelectWager={(wager) => {
                setWagerSportFilter("ALL")
                setWagerAlertFilter("ALL")
                setWagerTypeFilter("ALL")
                setWagerChannelFilter("ALL")
                setWagerSearch(wager.ticketId)
                setSelectedWager(wager)
                syncTicketInspectorToLocation(wager.ticketId)
                setActiveTab("wagers")
              }}
              onSelectCustomer={(customer) => {
                setSelectedCustomer(customer)
                setSearchQuery(customer.id)
                setFilterTier("ALL")
                setCustomerLookupNotice(null)
                setActiveTab("customers")
              }}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              onInvestigateWagers={(filter) => {
                setWagerSportFilter(filter.sport ?? "ALL")
                setWagerAlertFilter(filter.alert ?? "ALL")
                setWagerTypeFilter("ALL")
                setWagerChannelFilter("ALL")
                setWagerSearch(filter.search ?? "")
                setActiveTab("wagers")
              }}
              onNavigateTab={(tab) => {
                if (tab === "churn-simulation") {
                  navigatePrimaryRoute("churn-simulation")
                } else {
                  setActiveTab(tab)
                }
              }}
            />
          ) : activeTab === "churn-simulation" ? (
            <BettorChurnSimulationPanel
              customers={profileCustomers}
              wagers={liveWagers}
              onSelectCustomer={(customer) => {
                setSelectedCustomer(customer)
                setSearchQuery(customer.id)
                setFilterTier("ALL")
                setCustomerLookupNotice(null)
                setActiveTab("customers")
              }}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
            />
          ) : activeTab === "system-logs" ? (
            <SystemLogsPanel
              alertRecords={alertRecords}
              terminalHistory={terminalHistory}
              r2PipelineData={r2PipelineData}
              healthData={healthData}
              wagersProvenance={wagersProvenance}
              weblogSeverityFilter={systemLogSeverityFilter}
              onWeblogSeverityFilterChange={setSystemLogSeverityFilter}
              onWeblogSeverityCountsChange={setSystemLogSeverityCounts}
              onNavigateTab={(tab) => setActiveTab(tab)}
              onRunTerminalCommand={(cmd) => {
                setActiveTab("terminal")
                void runTerminalCommand(cmd)
              }}
            />
          ) : activeTab === "status-dashboard" ? (
            <StatusDashboardPanel
              snapshot={configStatusSnapshot}
              loading={configStatusLoading}
              error={configStatusError}
              saving={configStatusSaving}
              saveNotice={configStatusNotice}
              onRefresh={() => {
                void fetchConfigStatus()
              }}
              onSaveOverrides={handleSaveConfigOverrides}
              onResetOverrides={handleResetConfigOverrides}
              onNavigateTab={(tab) => setActiveTab(tab)}
            />
          ) : (
            <LiveWagersTabPanel
              wagers={liveWagers}
              provenance={wagersProvenance}
              wagersError={wagersError}
              wagersLastUpdatedAt={wagersUpdatedAt}
              wsSyncTick={wsSyncTick}
              wsLastSyncAt={wsLastSyncAt}
              newTicketIds={newTicketIds}
              streamingConnected={connected}
              wireContract={wireContract}
              slabPolicy={slabPolicy}
              onRefreshWagers={() => {
                void fetchLiveWagers()
              }}
              wagerSearch={wagerSearch}
              onWagerSearchChange={setWagerSearch}
              wagerSportFilter={wagerSportFilter}
              onWagerSportFilterChange={setWagerSportFilter}
              wagerAlertFilter={wagerAlertFilter}
              onWagerAlertFilterChange={setWagerAlertFilter}
              wagerChannelFilter={wagerChannelFilter}
              onWagerChannelFilterChange={setWagerChannelFilter}
              wagerTypeFilter={wagerTypeFilter}
              onWagerTypeFilterChange={setWagerTypeFilter}
              wagerSortField={wagerSortField}
              wagerSortDir={wagerSortDir}
              onWagerSort={handleWagerSort}
              selectedWager={selectedWager}
              onSelectWager={(wager) => {
                setSelectedWager(wager)
                syncTicketInspectorToLocation(wager.ticketId)
              }}
              alertRecords={alertRecords}
              copiedTicketId={copiedTicketId}
              onCopyText={(ticketId, text) => {
                void copyText(text)
                setCopiedTicketId(ticketId)
                setTimeout(() => setCopiedTicketId(null), 1500)
              }}
              tiersConfig={tiersConfig}
              onSelectCustomerById={handleSelectCustomerById}
              onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
              onInspectPty={(customerId) => {
                setActiveTab("terminal")
                void runTerminalCommand(`profile ${customerId} --radar`)
              }}
              onRunPtyCommand={(cmd) => {
                setActiveTab("terminal")
                void runTerminalCommand(cmd)
              }}
            />
          )}
        </PanelErrorBoundary>
      </main>

      {/* Global Footer */}
      <footer style={styles.footer}>
        <span>Updated: {data?.updatedAt ?? "—"}</span>
        <span>
          Native Bun HTML Bundler + Bun.serve Routes + bun:bundle ({runtimeFlags.target}) +
          tokens.toml v{TOKENS_TOML_VERSION} · dashboard.toml v{DASHBOARD_META.version}
          {buildInfo
            ? ` · build ${buildInfo.target}@${buildInfo.commit} · ${buildInfo.builtAt} · bun ${buildInfo.bunVersion}+${buildInfo.bunRevision.slice(0, 9)} on ${buildInfo.builtOn}`
            : ""}{" "}
          · autoExecute: false invariant active
        </span>
      </footer>

      {selectedAgentId !== null && (
        <AgentInspectorModal
          agentId={selectedAgentId}
          rankings={rankings}
          onClose={() => setSelectedAgentId(null)}
          onSelectAgent={(agentId) => setSelectedAgentId(agentId)}
          onSelectCustomerById={(customerId) => {
            setSelectedAgentId(null)
            handleSelectCustomerById(customerId)
          }}
          onInspectPty={(customerId) => {
            setSelectedAgentId(null)
            setActiveTab("terminal")
            void runTerminalCommand(`profile ${customerId} --radar`)
          }}
        />
      )}

      {/* Subtle 8-Hour Shift Handoff Reminder Notification */}
      {showShiftHandoffAlert && (
        <ShiftHandoffReminderToast
          elapsedSeconds={activeShiftSeconds}
          operatorId={shiftOperator}
          onInitiateHandoff={() => {
            openShiftHandoffModal()
          }}
          onDismiss={() => {
            if (operatorSignedInAt !== null) {
              setHandoffAlertDismissedShiftAt(operatorSignedInAt)
            }
          }}
        />
      )}

      {/* Operator Shift Summary & Handoff Modal */}
      {isShiftModalOpen && (
        <ShiftHandoffModal
          shiftOperator={shiftOperator}
          onShiftOperatorChange={handleOperatorChange}
          shiftLoading={shiftLoading}
          onRefresh={(operatorId) => {
            void fetchShiftSummary(operatorId)
            void (async () => {
              await recordShiftSessionLog({
                action: "handoff_synced",
                operatorId,
                summary: `Synced 8h shift telemetry for ${operatorId}`,
              })
              await fetchShiftLogs(operatorSignedInAt)
            })()
          }}
          shiftSummary={shiftSummary}
          shiftLogs={shiftLogs}
          shiftLogsLoading={shiftLogsLoading}
          shiftLogsError={shiftLogsError}
          shiftStartedAtMs={operatorSignedInAt}
          onRefreshShiftLogs={() => {
            void fetchShiftLogs(operatorSignedInAt)
          }}
          onCopyReportLogged={() => {
            void recordShiftSessionLog({
              action: "handoff_report_copied",
              operatorId: shiftOperator,
              summary: `Copied 8h shift handoff report (${formatShiftSecondsClock(activeShiftSeconds)})`,
            })
          }}
          onOperatorSwitched={(nextOperatorId, previousOperatorId) => {
            void recordShiftSessionLog({
              action: "operator_switch",
              operatorId: nextOperatorId,
              summary: `Switched handoff operator from ${previousOperatorId} to ${nextOperatorId}`,
            })
          }}
          alerts={alertRecords}
          wagers={liveWagers}
          activeShiftSeconds={activeShiftSeconds}
          onClose={() => setIsShiftModalOpen(false)}
        />
      )}

      {/* Operator Authentication & Session Gate */}
      {!fastSignInPending &&
        (operatorSignedOut ||
          (serverAuthState.checked &&
            serverAuthState.authRequired &&
            !serverAuthState.authenticated)) && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Operator authentication required"
            style={{
              position: "fixed",
              inset: 0,
              backgroundColor: "rgba(2, 6, 23, 0.88)",
              backdropFilter: "blur(6px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "20px",
              zIndex: 2000,
            }}
          >
            <form
              onSubmit={(e) => {
                void handleOperatorSignIn(e)
              }}
              style={{
                width: "100%",
                maxWidth: "432px",
                maxHeight: "calc(100vh - 32px)",
                overflowY: "auto",
                backgroundColor: "#030303",
                border: "1px solid #334155",
                borderRadius: "10px",
                padding: "22px",
                boxShadow: "0 20px 50px rgba(2, 6, 23, 0.85)",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <img
                  src={resolveOperatorProfile(operatorLoginInput || shiftOperator).avatarUrl}
                  alt={resolveOperatorProfile(operatorLoginInput || shiftOperator).avatarAlt}
                  width={42}
                  height={42}
                  decoding="async"
                  referrerPolicy="no-referrer"
                  style={{
                    width: "42px",
                    height: "42px",
                    borderRadius: "50%",
                    objectFit: "cover",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "rgba(56, 189, 248, 0.45)",
                    flexShrink: 0,
                  }}
                />
                <div>
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 700,
                      letterSpacing: "0.04em",
                      color: "#38bdf8",
                      marginBottom: "2px",
                    }}
                  >
                    {BRAND_ASSETS.shortName} · {BRAND_ASSETS.version}
                  </div>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: "17px",
                      fontWeight: 700,
                      color: "#f8fafc",
                    }}
                  >
                    {serverAuthState.authRequired
                      ? "Operator Authentication Required"
                      : "Operator Signed Out"}
                  </h2>
                </div>
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: "12px",
                  color: "#94a3b8",
                  lineHeight: 1.5,
                }}
              >
                {serverAuthState.authRequired
                  ? serverAuthState.devQuickLoginAvailable
                    ? "Development server detected. Use one-click dev sign-in for instant access, or sign in with a configured desk token below."
                    : "Sign in with your operator ID and desk access token to establish an authenticated session."
                  : "Enter an operator username to resume your desk shift session."}
              </p>
              {serverAuthState.authRequired && serverAuthState.devQuickLoginAvailable && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "10px",
                    padding: "12px",
                    borderRadius: "8px",
                    backgroundColor: "rgba(56, 189, 248, 0.08)",
                    border: "1px solid rgba(56, 189, 248, 0.3)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "11px",
                      color: "#cbd5e1",
                    }}
                  >
                    <span style={{ fontWeight: 600, color: "#7dd3fc" }}>
                      Quick Development Sign-In
                    </span>
                    <span style={{ color: "#94a3b8" }}>Dev Server Only</span>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: "8px",
                    }}
                  >
                    <button
                      type="button"
                      disabled={authSubmitting}
                      onClick={() => void performDevQuickSignIn("OPERATOR")}
                      style={{
                        padding: "9px 12px",
                        borderRadius: "6px",
                        border: "1px solid #38bdf8",
                        backgroundColor: "#0284c7",
                        color: "#f8fafc",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: authSubmitting ? "wait" : "pointer",
                        whiteSpace: "nowrap",
                        opacity: authSubmitting ? 0.65 : 1,
                      }}
                    >
                      {authSubmitting ? "Signing In…" : "Dev Operator"}
                    </button>
                    <button
                      type="button"
                      disabled={authSubmitting}
                      onClick={() => void performDevQuickSignIn("ADMIN")}
                      style={{
                        padding: "9px 12px",
                        borderRadius: "6px",
                        border: "1px solid #4ade80",
                        backgroundColor: "rgba(34, 197, 94, 0.16)",
                        color: "#86efac",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: authSubmitting ? "wait" : "pointer",
                        whiteSpace: "nowrap",
                        opacity: authSubmitting ? 0.65 : 1,
                      }}
                    >
                      {authSubmitting ? "Signing In…" : "Dev Admin"}
                    </button>
                  </div>
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "11px",
                      color: "#cbd5e1",
                      cursor: "pointer",
                      userSelect: "none",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={devAutoSignIn}
                      onChange={(e) => toggleDevAutoSignIn(e.target.checked)}
                      style={{ accentColor: "#38bdf8", cursor: "pointer" }}
                    />
                    <span>Auto sign-in on page reload during development</span>
                  </label>
                </div>
              )}
              {serverAuthState.authRequired &&
                !serverAuthState.authConfigured &&
                !serverAuthState.devQuickLoginAvailable && (
                  <div
                    role="alert"
                    style={{
                      padding: "10px 12px",
                      borderRadius: "6px",
                      backgroundColor: "rgba(239, 68, 68, 0.14)",
                      border: "1px solid rgba(239, 68, 68, 0.4)",
                      color: "#fca5a5",
                      fontSize: "12px",
                      lineHeight: 1.45,
                    }}
                  >
                    Fail-closed mode active: no operator or admin token is configured on the server.
                    Set <code>SPORTSDESK_DASHBOARD_TOKEN</code> or{" "}
                    <code>SPORTSDESK_ADMIN_TOKEN</code> in the server environment.
                  </div>
                )}
              {authSubmitError && (
                <div
                  role="alert"
                  style={{
                    padding: "8px 10px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(239, 68, 68, 0.14)",
                    border: "1px solid rgba(239, 68, 68, 0.4)",
                    color: "#fca5a5",
                    fontSize: "12px",
                  }}
                >
                  {authSubmitError}
                </div>
              )}
              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#cbd5e1",
                }}
              >
                Operator ID
                <input
                  type="text"
                  autoFocus={!serverAuthState.devQuickLoginAvailable}
                  value={operatorLoginInput}
                  onChange={(e) => setOperatorLoginInput(e.target.value)}
                  placeholder={shiftOperator || "desk-operator"}
                  style={{
                    padding: "8px 10px",
                    borderRadius: "6px",
                    backgroundColor: "#070b14",
                    border: "1px solid #334155",
                    color: "#f8fafc",
                    fontSize: "13px",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    outline: "none",
                  }}
                />
              </label>
              {serverAuthState.authRequired && (
                <label
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    fontSize: "11px",
                    fontWeight: 600,
                    color: "#cbd5e1",
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span>Desk Access Token</span>
                    <button
                      type="button"
                      onClick={() => setShowTokenPlaintext((v) => !v)}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        color: "#38bdf8",
                        fontSize: "11px",
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      {showTokenPlaintext ? "Hide" : "Show"}
                    </button>
                  </span>
                  <input
                    type={showTokenPlaintext ? "text" : "password"}
                    required
                    autoComplete="current-password"
                    value={operatorTokenInput}
                    onChange={(e) => setOperatorTokenInput(e.target.value)}
                    placeholder={
                      serverAuthState.authConfigured
                        ? "Enter operator or admin token"
                        : "Optional when using Quick Dev Sign-In above"
                    }
                    style={{
                      padding: "8px 10px",
                      borderRadius: "6px",
                      backgroundColor: "#070b14",
                      border: "1px solid #334155",
                      color: "#f8fafc",
                      fontSize: "13px",
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      outline: "none",
                    }}
                  />
                </label>
              )}
              <button
                type="submit"
                disabled={
                  authSubmitting ||
                  (serverAuthState.authRequired && !serverAuthState.authConfigured)
                }
                style={{
                  ...styles.actionBtn,
                  width: "100%",
                  padding: "9px 14px",
                  fontSize: "13px",
                  opacity:
                    authSubmitting ||
                    (serverAuthState.authRequired && !serverAuthState.authConfigured)
                      ? 0.55
                      : 1,
                }}
              >
                {authSubmitting ? "Authenticating…" : "Sign In with Token"}
              </button>
              <SignInModalQrGenerator
                currentHref={
                  typeof window !== "undefined" ? window.location.href : "http://127.0.0.1:3000/"
                }
                initialBookmarkUrl={currentFastBookmarkUrl}
                devQuickLoginAvailable={serverAuthState.devQuickLoginAvailable}
                authConfigured={serverAuthState.authConfigured}
                authRequired={serverAuthState.authRequired}
                hasEnteredCredentialToken={operatorTokenInput.trim().length > 0}
                onMintBookmarkUrl={handleMintSignInModalQrBookmark}
                onRedeemFastToken={handleRedeemFastSignInToken}
                onBookmarkUrlChange={setCurrentFastBookmarkUrl}
              />
            </form>
          </div>
        )}
    </div>
  )
}
