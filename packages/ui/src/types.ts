import type { CustomerRetainedHistory } from "@sportsdesk-ops/contracts"
import type {
  AgentDetailApiResponse,
  AutomationScheduleSummary,
  AutomationsSnapshot,
  BetTickerApiResponse,
  BetTickerBridge3aSnapshot,
  BetTickerChannelBucket,
  BetTickerTicketRow,
  BetTickerTypeBucket,
  BridgeJobStatusSummary,
  BunRuntimeSurfaceAuditSnapshot,
  CustomersApiResponse,
  CustomersCohortsSummary,
  Daemon4020State,
  Daemon4020Status,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  DashboardWsTopic,
  LiveWagersApiResponse,
  R2PipelineApiResponse,
  R2PipelineHistoryApiResponse,
  R2SinkDetail,
  R2SinkHistory,
  R2SinkHistorySample,
  R2SinkSlaStatus,
  RedactedNpmrcStatusSummary,
  SlabPolicySummary,
  TicketVerificationMode,
  TicketVerificationSummary,
  WagerChannel,
  WagerTier,
  WagersWireContractSummary,
  WorkspaceYamlConfigSummary,
} from "@sportsdesk-ops/contracts"

export type {
  AgentDetailApiResponse,
  AutomationScheduleSummary,
  AutomationsSnapshot,
  BetTickerApiResponse,
  BetTickerBridge3aSnapshot,
  BetTickerChannelBucket,
  BetTickerTicketRow,
  BetTickerTypeBucket,
  BridgeJobStatusSummary,
  BunRuntimeSurfaceAuditSnapshot,
  CustomersApiResponse,
  CustomersCohortsSummary,
  Daemon4020State,
  Daemon4020Status,
  DashboardFeedProvenanceKind,
  DashboardSourceProvenance,
  DashboardWsTopic,
  LiveWagersApiResponse,
  R2PipelineApiResponse,
  R2PipelineHistoryApiResponse,
  R2SinkDetail,
  R2SinkHistory,
  R2SinkHistorySample,
  R2SinkSlaStatus,
  RedactedNpmrcStatusSummary,
  SlabPolicySummary,
  TicketVerificationMode,
  TicketVerificationSummary,
  WagersWireContractSummary,
}

export interface DashboardData {
  readonly markdown: string
  readonly html: string
  readonly renderDurationMs?: number
  readonly markdownBytes?: number
  readonly htmlBytes?: number
  readonly nonAsciiChars?: number
  readonly updatedAt: string
}

export interface DnsData {
  readonly success?: boolean
  readonly telemetry: {
    readonly source?: string
    readonly capacity?: number
    readonly size: number
    readonly hitRatePercent: number
    readonly cacheHitsCompleted: number
    readonly cacheHitsInflight: number
    readonly cacheMisses: number
    readonly defaultTtlSeconds: number
    readonly errors?: number
    readonly totalCount?: number
  }
  readonly hosts?: readonly {
    readonly hostname: string
    readonly port?: number
    readonly serviceName?: string
  }[]
  readonly coreHosts?: readonly {
    readonly hostname: string
    readonly port?: number
    readonly serviceName?: string
  }[]
  readonly updatedAt?: string
  readonly generatedAt?: string
}

export interface DnsBenchmark {
  readonly fastestBackend: string | null
  readonly speedupFactor: number | null
  readonly metrics: readonly { backend: string; meanMs: number | null }[]
}

export interface CustomerPortalReconciliation {
  readonly creditLimitUsd: number
  readonly currentBalanceUsd: number
  readonly pendingWagerBalanceUsd: number
  readonly pendingWagerCount: number
  readonly availableBalanceUsd: number
  readonly creditEquationBalanced: boolean
  readonly carryOverUsd: number
  readonly previousBalanceUsd: number
  readonly carryOverParityMatched: boolean
  readonly carryOverWindow: string
  readonly postCarryOverWindow: string
  readonly postCarryOverNetUsd: number
  readonly net31dUsd: number
  readonly activeDays31d: number
  readonly winDays31d: number
  readonly lossDays31d: number
  readonly wagerLimitUsd: number
  readonly settleFigureUsd: number
  readonly confirmationDelaySec: number
  readonly wiseLineMovementWeight: number
  readonly inetTarget: string
  readonly assignedParlayName: string
  readonly postureFlags: readonly string[]
}

export interface CustomerBacktestParlayMetrics {
  readonly rank: number | null
  readonly contextType: string
  readonly ipSubnet: string | null
  readonly cfbParlayTickets: number
  readonly cfbParlayHandleUsd: number
  readonly cfbBaselineDeskNetUsd: number
  readonly cfbProtectedDeskNetUsd: number
  readonly nbaParlayTickets: number
  readonly nbaParlayHandleUsd: number
  readonly nbaBaselineDeskNetUsd: number
  readonly nbaProtectedDeskNetUsd: number
  readonly totalParlayTickets: number
  readonly totalParlayLegs: number
  readonly totalParlayHandleUsd: number
  readonly avgClvBps: number
  readonly baselineDeskNetUsd: number
  readonly baselineHoldPct: number
  readonly protectedDeskNetUsd: number
  readonly protectedHoldPct: number
  readonly deskSavingsUsd: number
  readonly dominantComboFamily: string
  readonly primaryGuardTriggered: string
  readonly sampleComboSelection: string
  readonly probitRho: number | null
  readonly lastActiveAt: string | null
  readonly proxyWallet: string | null
  readonly shortWallet: string | null
  readonly polymarketProfileUrl: string | null
  readonly polymarketPositionsApiUrl: string | null
  readonly f402CustomerProfileUrl: string | null
}

export interface CustomerCrossOfficeTwin {
  readonly loginId: string
  readonly officeAgentId: string
}

export interface CustomerBeardBridgeForensics {
  readonly groupId: string | null
  readonly matchClassification: string
  readonly scope: string | null
  readonly officeAgentId: string
  readonly masterAgentId: string | null
  readonly sharedIpOrSubnet: string
  readonly normalizedIp: string | null
  readonly subnetCidr: string | null
  readonly dateWindowStartMdy: string | null
  readonly dateWindowEndMdy: string | null
  readonly matchedLoginsInOffice: readonly string[]
  readonly crossOfficeTwins: readonly CustomerCrossOfficeTwin[]
  readonly bridgedPolymarketWallets: readonly string[]
  readonly modeASessionDwellSeconds: number | null
  readonly mfcsCompositeScore: number | null
  readonly activeRotations: readonly string[]
  readonly recommendedDeskAction: string
  readonly supportingObservations: readonly string[]
}

export interface CustomerActivityOverlapEvent {
  readonly accountId: string
  readonly officeAgentId: string
  readonly windowKind: string
  readonly startUtc: string
  readonly endUtc: string
  readonly ipAddress: string
  readonly actionSummary: string
}

export interface CustomerActivityOverlapForensics {
  readonly distinctionVerdict: string
  readonly overlapDurationSeconds: number
  readonly gapBetweenWindowsSeconds: number
  readonly explanation: string
  readonly primaryWindow: CustomerActivityOverlapEvent
  readonly secondaryWindow: CustomerActivityOverlapEvent
}

export interface CustomerMode1TelemetryOverview {
  readonly officeAgentId: string
  readonly gsLivePlayerId: string | null
  readonly polymarketWallet: string | null
  readonly validatedNetUsd: number
  readonly pendingStakeUsd: number
  readonly pendingDefinedLiabilityUsd: number
  readonly lastAccessUtc: string | null
  readonly accessFreshnessSeconds: number | null
  readonly isAccessFresh: boolean
  readonly missingDataWarnings: readonly string[]
  readonly summaryVerdict: string | null
  readonly f402CustomerUrl: string | null
  readonly gsLiveProfileUrl: string | null
  readonly gsLiveBetHistoryUrl: string | null
  readonly polymarketProfileUrl: string | null
  readonly polygonscanUrl: string | null
  readonly archetype: string | null
}

export interface CustomerFlaggedTicketForensics {
  readonly ticketId: string
  readonly sourceVenue: string
  readonly sportAndPeriod: string
  readonly canonicalMarket: string
  readonly oddsAmerican: string
  readonly riskUsd: number
  readonly toWinUsd: number
  readonly pmEntryVsFair: string
  readonly placedAtUtc: string
  readonly deskVerdict: string
}

export interface CustomerForensicDossier {
  readonly parlayBacktest?: CustomerBacktestParlayMetrics | undefined
  readonly beardBridge?: CustomerBeardBridgeForensics | undefined
  readonly activityOverlap?: CustomerActivityOverlapForensics | undefined
  readonly telemetryOverview?: CustomerMode1TelemetryOverview | undefined
  readonly flaggedTickets: readonly CustomerFlaggedTicketForensics[]
}

export interface ShowcaseCustomer {
  readonly retainedHistory?: CustomerRetainedHistory | undefined
  readonly id: string
  readonly name: string
  readonly agentId: string
  readonly masterAgent: string
  readonly tier:
    | "TIER_1_ELITE_ORIGINATOR"
    | "TIER_2_STEAM_SYNDICATE"
    | "TIER_3_SHARP_DISCIPLINED"
    | "TIER_4_SEMI_SHARP"
    | "TIER_5_RECREATIONAL"
  readonly score: number
  readonly clvScore: number
  readonly skillScore: number
  readonly sizingScore: number
  readonly sigScore: number
  readonly timingScore: number
  readonly sizingStrategy: string
  readonly gini: number
  readonly meanStake: number
  readonly specialization: string
  readonly timingArchetype: string
  readonly correlatedRisk: "NONE" | "MODERATE" | "HIGH" | "CRITICAL"
  readonly correlatedExploitRate: number
  readonly syndicateRisk: "LOW" | "ELEVATED" | "HIGH"
  readonly syndicateProb: number
  readonly subAccountIndex: number | null
  readonly var95Usd: number
  readonly cvar95Usd: number
  readonly holdPct: number
  readonly ltvUsd: number
  readonly recommendedLimitUsd: number
  readonly inPlayDelaySec: number
  readonly lineShadeCents: number
  readonly shadowCopyMultiplier: number
  readonly action: string
  readonly ipAddress: string
  readonly portalReconciliation?: CustomerPortalReconciliation | undefined
  readonly forensicDossier?: CustomerForensicDossier | undefined
  /** Fields the customer book did not carry; set by profile_rows, never guessed. */
  readonly unknown?: readonly string[] | undefined
  /** Where the row came from; book includes the configured projected live manager roster. */
  readonly source?: "book" | "fixture" | "backtest" | "rankings" | "live-open" | undefined
  /** Human tier label when the API carried one (30d rankings). */
  readonly tierLabel?: string | undefined
  /** Open risk in USD when synthesized from the live wager tape (`?matrix=1` overlay). */
  readonly openRiskUsd?: number | undefined
}

export interface RankedPlayer30d {
  readonly rank: number
  readonly id: string
  readonly agentId: string
  readonly masterAgent: string
  readonly handleUsd: number
  readonly wagers: number
  readonly gini: number
  readonly alertRate: number
  readonly score: number
  readonly tier: string
  readonly tierLabel: string
  readonly dominantSport: string
  readonly isProxy: boolean
  readonly limitUsd: number
  readonly netUsd?: number | undefined
  readonly clvBps?: number | undefined
  readonly contextType?: string | undefined
  readonly handleDelta24hPct?: number | undefined
}

export interface SubAgentDownline30d {
  readonly agentId: string
  readonly masterAgent: string
  readonly handleUsd: number
  readonly wagers: number
  readonly customerCount: number
  readonly topCust: string
  readonly concPct: number
  readonly isProxyConduit: boolean
  readonly avgScore?: number | undefined
  readonly totalNetUsd?: number | undefined
  readonly handleDelta24hPct?: number | undefined
}

export interface MasterAgentDownline30d {
  readonly masterAgent: string
  readonly subAgentCount: number
  readonly customerCount: number
  readonly conduitCount: number
  readonly handleUsd: number
  readonly wagers: number
  readonly handleDelta24hPct?: number | undefined
}

export interface ProxyConduit30d {
  readonly agentId: string
  readonly masterAgent: string
  readonly handleUsd: number
  readonly wagers: number
  readonly topCust: string
  readonly concPct: number
  readonly handleDelta24hPct?: number | undefined
}

export interface LiveWager {
  readonly ticketId: string
  readonly timestamp: string
  readonly customerId: string
  readonly agentId: string
  readonly masterAgent: string
  readonly ticketWriter?: string | undefined
  /** Channel family derived from `ticketWriter` (shared vocabulary with ingest). */
  readonly writer?: WagerChannel | undefined
  readonly sport: string
  /** League / sub-sport when the source carries it; null when unknown. */
  readonly subSport?: string | null | undefined
  readonly betType: string
  readonly event: string
  readonly selection: string
  readonly lineDisplay: string
  readonly oddsAmerican: string
  readonly riskUsd: number
  readonly volumeUsd?: number | undefined
  readonly toWinUsd: number
  /** Real CLV in cents, or null when no closing-line comparison exists. */
  readonly clvCents: number | null
  readonly vip?: boolean | undefined
  readonly alertTier: WagerTier
  readonly alertBadge: string
  readonly operatorDirective: string
  readonly maxRecommendedStake: number
  readonly autoExecute: false
}

export interface DashboardAlertRecord {
  readonly deliveryId: string
  readonly wagerId: string
  readonly tier: WagerTier
  readonly status: "queued" | "delivered" | "dead" | "acknowledged"
  readonly payload: {
    readonly customerId: string
    readonly sport?: string | undefined
    readonly event?: string | undefined
    readonly selection?: string | undefined
    readonly oddsAmerican?: string | undefined
    readonly amountUsd?: number | undefined
    readonly clvCents?: number | undefined
    readonly directive?: string | undefined
  }
  readonly createdAt: string
  readonly updatedAt: string
  readonly attempts?: number | undefined
  readonly finalError?: string | undefined
  readonly retriedFrom?: string | undefined
  readonly acknowledgedBy?: string | undefined
  readonly acknowledgedNotes?: string | undefined
  readonly messageId?: number | undefined
}

export interface HealthData {
  readonly status: "ok" | "warning" | "degraded" | "healthy" | "down"
  readonly version?: string | undefined
  readonly runtime?: string | undefined
  readonly db?: string | undefined
  readonly operationalStatus?: "ok" | "degraded" | "down" | undefined
  readonly dataStatus?: "ok" | "stale" | undefined
  readonly httpStatus?: number | undefined
  readonly uptimeSeconds?: number | undefined
  readonly timestamp?: string | undefined
  readonly alerts?:
    | {
        readonly status: "ok" | "warning" | "degraded"
        readonly queued: number
        readonly delivered: number
        readonly dead: number
        readonly backlog: number
        readonly acknowledged?: number | undefined
      }
    | {
        readonly status: "unavailable"
        readonly dead?: undefined
        readonly backlog?: undefined
        readonly queued?: undefined
        readonly delivered?: undefined
        readonly acknowledged?: undefined
      }
    | undefined
  readonly degradedReasons?:
    | readonly {
        readonly message: string
        readonly kind: string
        readonly severity: string
        readonly action?: string | undefined
      }[]
    | undefined
}

export interface ShiftSummaryData {
  readonly date: string
  readonly operatorId: string
  readonly windowHours?: number | undefined
  readonly windowStartIso?: string | undefined
  readonly windowEndIso?: string | undefined
  readonly totalAlerts: number
  readonly deliveredAlerts: number
  readonly failedAttempts: number
  readonly deadLetterAlerts: number
  readonly acknowledgedAlerts: number
  readonly alertsLast8h?: number | undefined
  readonly acknowledgedAlertsLast8h?: number | undefined
  readonly deliveredAlertsLast8h?: number | undefined
  readonly deadLetterAlertsLast8h?: number | undefined
  readonly wagerTicketsProcessedLast8h?: number | undefined
  readonly terminalCommandsCount: number
  readonly loginEventsCount: number
}

export type ShiftSessionAction =
  | "login"
  | "logout"
  | "handoff_initiated"
  | "handoff_synced"
  | "handoff_report_copied"
  | "alert_ack"
  | "alert_retry"
  | "alert_sweep"
  | "operator_switch"
  | "terminal_cmd"

export interface ShiftSessionLogEntry {
  readonly id: string
  readonly timestamp: string
  readonly action: ShiftSessionAction
  readonly label: string
  readonly operatorId: string
  readonly summary: string
  readonly detail?: string | undefined
  readonly targetId?: string | undefined
  readonly source: "server" | "client"
}

export interface ShiftSessionLogsResponse {
  readonly operatorId: string | null
  readonly sinceIso: string | null
  readonly count: number
  readonly totalCaptured: number
  readonly logs: readonly ShiftSessionLogEntry[]
  readonly generatedAt: string
}

export interface BuildMatrixRow {
  readonly target: string
  readonly features: readonly string[]
  readonly totalJsBytes: number
  readonly totalCssBytes: number
  readonly gzipJsBytes?: number | undefined
  readonly inputFileCount?: number | null | undefined
  readonly bundleHash8?: string | undefined
  readonly hasDebugSentinel: boolean
  readonly hasExperimentalSentinel: boolean
  readonly hasProdSentinel: boolean
  readonly hasTestSentinel?: boolean | undefined
  readonly hasAnalyticsSentinel?: boolean | undefined
}

export interface StaticDirectoryProbeSummary {
  readonly wildcardPath: string
  readonly dir: string
  readonly caseInsensitiveHostFs: boolean
  readonly totalFiles: number
  readonly totalBytes: number
  readonly files: readonly {
    readonly relativePath: string
    readonly urlPath: string
    readonly bytes: number
    readonly contentType: string
    readonly lastModifiedIso: string | null
  }[]
  readonly liveCheck: {
    readonly origin: string
    readonly elapsedMs: number
    readonly allPassed: boolean
    readonly etag: string | null
    readonly contentRange: string | null
    readonly checks: readonly {
      readonly name: string
      readonly requestPath: string
      readonly expectedStatus: number
      readonly status: number | null
      readonly ok: boolean
      readonly detail: string
    }[]
  } | null
}

/**
 * Canonical ordered registry of top-level SportsDesk Dashboard tab identifiers.
 * Single source of truth for URL `?tab=` routing, `dashboard.toml` `panels.default_tab`,
 * keyboard shortcuts, and legacy route aliases.
 */
export const DASHBOARD_TAB_IDS = [
  "customers",
  "shadow",
  "surveillance",
  "terminal",
  "rankings",
  "wagers",
  "bet-ticker",
  "r2",
  "alerts",
  "assets",
  "risk-overview",
  "churn-simulation",
  "system-logs",
  "status-dashboard",
] as const

export type DashboardTabId = (typeof DASHBOARD_TAB_IDS)[number]

export interface DashboardTabSpec {
  readonly id: DashboardTabId
  readonly label: string
  readonly icon: string
  readonly shortcut: string
  readonly description: string
  readonly aliases: readonly string[]
}

export const DASHBOARD_TAB_SPECS: Readonly<Record<DashboardTabId, DashboardTabSpec>> = {
  customers: {
    id: "customers",
    label: "Profiles",
    icon: "👥",
    shortcut: "Ctrl+1",
    description: "Sharp originator profiling, sizing Gini & Bayesian skill",
    aliases: ["profiles", "bettors", "customer"],
  },
  surveillance: {
    id: "surveillance",
    label: "Telemetry",
    icon: "📊",
    shortcut: "Ctrl+2",
    description: "Bun.dns cache telemetry, dispatch thresholds & risk brief",
    aliases: ["telemetry", "dns", "overview"],
  },
  terminal: {
    id: "terminal",
    label: "Terminal (PTY)",
    icon: "💻",
    shortcut: "Ctrl+3",
    description: "Native Bun.Terminal interactive operator PTY engine",
    aliases: ["pty", "cli", "console"],
  },
  rankings: {
    id: "rankings",
    label: "Downlines",
    icon: "🏆",
    shortcut: "Ctrl+4",
    description: "30-day sub-agent handle rankings & proxy conduit trees",
    aliases: ["downlines", "agents", "conduits"],
  },
  wagers: {
    id: "wagers",
    label: "Live Wagers",
    icon: "⚡",
    shortcut: "Ctrl+5",
    description: "Real-time incoming wager tape, CLV ramp & slice leaders",
    aliases: ["live-wagers", "tape"],
  },
  "bet-ticker": {
    id: "bet-ticker",
    label: "Bet Ticker",
    icon: "🎟️",
    shortcut: "Ctrl+6",
    description: "Portal bet-ticker wire stream & R2 capture snapshots",
    aliases: ["ticker", "bet_ticker"],
  },
  shadow: {
    id: "shadow",
    label: "Shadow Pricing",
    icon: "⚖️",
    shortcut: "Ctrl+7",
    description: "Counterfactual shadow pricing & slice hold-floor cube",
    aliases: ["shadow-pricing", "slices", "hold-floors"],
  },
  r2: {
    id: "r2",
    label: "R2 Pipeline",
    icon: "☁️",
    shortcut: "Ctrl+8",
    description: "Multi-sink Cloudflare R2 artifact freshness & Last-Modified",
    aliases: ["r2-pipeline", "pipeline", "storage"],
  },
  alerts: {
    id: "alerts",
    label: "DLQ & Alerts",
    icon: "🚨",
    shortcut: "Ctrl+9",
    description: "Operator alert delivery queue, dead-letter retry & acks",
    aliases: ["dlq", "notifications"],
  },
  assets: {
    id: "assets",
    label: "Bun Assets",
    icon: "🖼️",
    shortcut: "Ctrl+0",
    description: "Bun.Image asset attributes for the served dashboard images",
    aliases: ["images", "image-assets", "bun-assets", "image-metadata"],
  },
  "risk-overview": {
    id: "risk-overview",
    label: "Risk Overview",
    icon: "🛡️",
    shortcut: "",
    description: "Consolidated risk exposure across sports, live tape & sharp cohorts",
    aliases: ["risk"],
  },
  "churn-simulation": {
    id: "churn-simulation",
    label: "Bettor Churn Simulation",
    icon: "📈",
    shortcut: "",
    description: "Counterfactual bettor attrition & retention simulator",
    aliases: ["bettor-churn", "simulation"],
  },
  "system-logs": {
    id: "system-logs",
    label: "System Logs",
    icon: "📜",
    shortcut: "",
    description: "Unified operational event and audit log stream",
    aliases: ["logs"],
  },
  "status-dashboard": {
    id: "status-dashboard",
    label: "Status & Config",
    icon: "🧭",
    shortcut: "",
    description:
      "Environment variables (.env.example), constants, runtime config & component traceability",
    aliases: ["status", "config", "env", "constants"],
  },
}

const DASHBOARD_TAB_ID_SET: ReadonlySet<string> = new Set(DASHBOARD_TAB_IDS)

const LEGACY_TAB_ALIAS_MAP: Readonly<Record<string, DashboardTabId>> = Object.freeze(
  Object.fromEntries(
    DASHBOARD_TAB_IDS.flatMap((id) =>
      DASHBOARD_TAB_SPECS[id].aliases.map((alias) => [alias, id] as const),
    ),
  ),
)

export function isDashboardTabId(value: unknown): value is DashboardTabId {
  return typeof value === "string" && DASHBOARD_TAB_ID_SET.has(value)
}

/**
 * Resolves a raw `?tab=`, hash slug, or legacy alias to a canonical `DashboardTabId`,
 * falling back to `fallback` (`"customers"` by default) when empty or unknown.
 */
export function resolveDashboardTabId(
  raw: unknown,
  fallback: DashboardTabId = "customers",
): DashboardTabId {
  if (typeof raw !== "string") return fallback
  const cleaned = raw
    .trim()
    .replace(/^[#/]+/, "")
    .toLowerCase()
  if (!cleaned) return fallback
  if (isDashboardTabId(cleaned)) return cleaned
  return LEGACY_TAB_ALIAS_MAP[cleaned] ?? fallback
}

export const RANKINGS_FILTERS = ["ALL", "CONDUITS", "TIER3", "WHALES"] as const
export type RankingsFilter = (typeof RANKINGS_FILTERS)[number]

export const TERMINAL_CATEGORIES = ["ALL", "SHARPS", "DOWNLINES", "RISK", "NET"] as const
export type TerminalCategory = (typeof TERMINAL_CATEGORIES)[number]

export const ALERT_FILTERS = ["ALL", "DEAD", "QUEUED", "DELIVERED", "ACKNOWLEDGED"] as const
export type AlertFilter = (typeof ALERT_FILTERS)[number]

export const CUSTOMER_SORT_KEYS = ["id", "score", "gini", "var95Usd", "holdPct"] as const
export type CustomerSortKey = (typeof CUSTOMER_SORT_KEYS)[number]

export const WAGER_SORT_FIELDS = [
  "timestamp",
  "riskUsd",
  "toWinUsd",
  "clvCents",
  "alertTier",
] as const
export type WagerSortField = (typeof WAGER_SORT_FIELDS)[number]

const WAGER_SORT_FIELD_SET: ReadonlySet<string> = new Set(WAGER_SORT_FIELDS)

export function isWagerSortField(value: unknown): value is WagerSortField {
  return typeof value === "string" && WAGER_SORT_FIELD_SET.has(value)
}

export interface AlertToastState {
  readonly message: string
  readonly type: "success" | "error" | "info"
}

export interface TerminalHistoryEntry {
  readonly command: string
  readonly stdout: string
  readonly exitCode: number
  readonly durationMs: number
  readonly timestamp: number
  /**
   * True for the seeded welcome buffer, which never executed. A real run can
   * legitimately report `durationMs: 0` (sub-millisecond command), so run
   * statistics must not infer "did not execute" from the duration.
   */
  readonly synthetic?: boolean
}

export interface TierSwatchStyle {
  readonly fg: string
  readonly bg: string
  readonly border: string
}

export type TierStyleConfig = Readonly<Record<string, TierSwatchStyle>>

export const PROFILE_TYPE_IDS = [
  "UNMEASURED",
  "ORIGINATOR",
  "STEAM_SYNDICATE",
  "SHARP_DISCIPLINED",
  "SEMI_SHARP",
  "HIGH_HOLD_WHALE",
  "RECREATIONAL",
] as const

export type ProfileTypeId = (typeof PROFILE_TYPE_IDS)[number]

export const PROFILE_TAG_CATEGORIES = ["RISK", "BEHAVIOR", "NETWORK", "POLICY", "CUSTOM"] as const

export type ProfileTagCategory = (typeof PROFILE_TAG_CATEGORIES)[number]

export type ProfileTagTone = "red" | "amber" | "sky" | "emerald" | "violet" | "slate"

export interface ProfileTypeSpec {
  readonly id: ProfileTypeId
  readonly label: string
  readonly shortLabel: string
  readonly icon: string
  readonly description: string
  readonly fg: string
  readonly bg: string
  readonly border: string
}

export interface ProfileTag {
  readonly id: string
  readonly label: string
  readonly category: ProfileTagCategory
  readonly tone: ProfileTagTone
  readonly description: string
  readonly isCustom?: boolean | undefined
}

export interface CustomerProfileClassification {
  readonly type: ProfileTypeSpec
  readonly tags: readonly ProfileTag[]
  readonly tagIds: ReadonlySet<string>
}

export interface TelemetryRefreshSnapshot {
  readonly probing: boolean
  readonly lastProbedAt: string | null
  readonly lastProbeMs: number | null
  readonly daemonState: Daemon4020State | "probing"
  readonly daemonLabel: string
  readonly daemonColor: string
  readonly r2Label: string
  readonly r2OverallStatus: "fresh" | "stale" | "degraded" | "probing"
  readonly wsConnected: boolean
  readonly wsLastHeartbeatAt?: string | null | undefined
  readonly wsLatencyMs?: number | null | undefined
  readonly error: string | null
}

export type ConfigItemKind = "env" | "constant" | "variable"

export type ConfigItemCategory =
  | "Server & Runtime"
  | "Security & Auth"
  | "Fantasy402 Gateway"
  | "Telemetry & Thresholds"
  | "UI & Desk Controls"
  | "Storage & R2"
  | "Integrations"

export type ConfigValueType = "string" | "number" | "boolean" | "url" | "list"

export interface ConfigComponentTrace {
  readonly component: string
  readonly layer: "ui" | "api" | "server" | "config"
  readonly usage: string
  readonly tabId?: string | undefined
}

export interface ConfigStatusItem {
  readonly key: string
  readonly label: string
  readonly kind: ConfigItemKind
  readonly category: ConfigItemCategory
  readonly valueType: ConfigValueType
  readonly description: string
  readonly sourceFile: string
  readonly sensitive: boolean
  readonly editable: boolean
  readonly configured: boolean
  readonly overridden: boolean
  readonly status: "configured" | "overridden" | "default" | "unset"
  readonly value: string | null
  readonly defaultValue: string
  readonly envExampleLine?: string | undefined
  readonly consumers: readonly ConfigComponentTrace[]
}

export interface ComponentTraceSummary {
  readonly component: string
  readonly layer: "ui" | "api" | "server" | "config"
  readonly tabId?: string | undefined
  readonly itemCount: number
  readonly envCount: number
  readonly constantCount: number
  readonly variableCount: number
  readonly secretCount: number
  readonly items: readonly {
    readonly key: string
    readonly kind: ConfigItemKind
    readonly status: ConfigStatusItem["status"]
    readonly sensitive: boolean
    readonly usage: string
  }[]
}

export interface ConfigStatusSummary {
  readonly totalItems: number
  readonly envCount: number
  readonly constantCount: number
  readonly variableCount: number
  readonly configuredCount: number
  readonly overriddenCount: number
  readonly unsetCount: number
  readonly secretCount: number
  readonly secretConfiguredCount: number
  readonly componentCount: number
}

export interface ConfigStatusSnapshot {
  readonly items: readonly ConfigStatusItem[]
  readonly components: readonly ComponentTraceSummary[]
  readonly summary: ConfigStatusSummary
  readonly overrides: Readonly<Record<string, string>>
  readonly envExampleText: string
  readonly npmrc?: RedactedNpmrcStatusSummary | undefined
  readonly yamlConfig?: WorkspaceYamlConfigSummary | undefined
  readonly runtimeSurface?: BunRuntimeSurfaceAuditSnapshot | undefined
  readonly updatedAt: string
}
