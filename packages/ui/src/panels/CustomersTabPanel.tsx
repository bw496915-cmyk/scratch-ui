import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Flame,
  Globe,
  Plus,
  Radio,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Tag,
  X,
} from "lucide-react"
import React, { useEffect, useMemo, useState } from "react"

import type { ReverseDnsForensicsView } from "../../../../lib/reverse_dns_forensics.ts"
import { DASHBOARD_FRESHNESS } from "../config/dashboard.ts"
import {
  computeProfileRiskHeadroom,
  summarizeCustomerLiveActivity,
} from "../customer_drilldown_summary.ts"
import { styles } from "../dashboard_styles.ts"
import {
  type CustomerCohortKpiTone,
  deriveCustomerCohortKpiCards,
  formatProvenanceBadge,
  type NormalizedRankingsResult,
  PENDING_COHORTS_PROVENANCE,
} from "../hydration.ts"
import { getLocalAgentHref } from "../links.ts"
import {
  buildFantasy402PortalEntryUrl,
  FANTASY402_PORTAL_WINDOW_TARGET,
  getFantasy402PortalLinkProps,
} from "../portal_link.ts"
import { evaluateProfileQuantitativeModel, summarizeSharpnessHeatmap } from "../profile_formulas.ts"
import {
  classifyCustomerProfile,
  PROFILE_TAG_CATEGORY_META,
  PROFILE_TAG_TONE_STYLES,
  PROFILE_TYPE_ORDER,
  PROFILE_TYPE_SPECS,
  SUGGESTED_OPERATOR_TAGS,
} from "../profile_taxonomy.ts"
import type { SharpestOnChainXrefReport } from "../sharpest_onchain_xref.ts"
import {
  type CustomerProfileClassification,
  type CustomersApiResponse,
  type CustomerSortKey,
  type LiveWager,
  PROFILE_TAG_CATEGORIES,
  type ProfileTag,
  type ProfileTagCategory,
  type ProfileTypeId,
  type ShowcaseCustomer,
  type TelemetryRefreshSnapshot,
} from "../types.ts"
import { SharpnessDecomposition } from "../viz/SharpnessDecomposition.tsx"
import {
  ForensicBridgeSummaryCallout,
  ForensicFlaggedTicketsPanel,
  GraphForensicsDossierPanel,
  ParlayProtectionImpactPanel,
} from "./CustomerForensicDossierSection.tsx"
import { SkeletonBlock, SkeletonSplitWorkspace } from "./PanelSkeleton.tsx"
import {
  OverviewFormulaAuditStrip,
  ProfileFormulaDrilldownPanel,
} from "./ProfileFormulaDrilldownPanel.tsx"
import { ProfilesInspectSection } from "./ProfilesInspectSection.tsx"
import { ReverseDnsForensicsCard } from "./ReverseDnsForensicsCard.tsx"
import { ProfileOnChainXrefCard, SharpestOnChainXrefPanel } from "./SharpestOnChainXrefPanel.tsx"
import { WsSyncStatusIndicator } from "./WsSyncStatusIndicator.tsx"

export interface CustomersTabPanelProps {
  readonly bannerDismissed: boolean
  readonly onDismissBanner: () => void
  readonly kpisCollapsed: boolean
  readonly onToggleKpis: () => void
  readonly cohortsReport?: CustomersApiResponse | null | undefined
  readonly cohortsStatus?: "pending" | "ready" | "unavailable" | undefined
  readonly cohortsError?: string | null | undefined
  readonly searchQuery: string
  readonly onSearchQueryChange: (value: string) => void
  readonly filterTier: string
  readonly onFilterTierChange: (tier: string) => void
  readonly allProfileCustomers?: readonly ShowcaseCustomer[] | undefined
  readonly profileClassifications?: ReadonlyMap<string, CustomerProfileClassification> | undefined
  readonly activeProfileTagIds?: readonly string[] | undefined
  readonly onToggleProfileTag?: ((tagId: string) => void) | undefined
  readonly onClearProfileTags?: (() => void) | undefined
  readonly profileTagCategoryFilter?: "ALL" | ProfileTagCategory | undefined
  readonly onProfileTagCategoryFilterChange?:
    ((category: "ALL" | ProfileTagCategory) => void) | undefined
  readonly onAddCustomProfileTag?: ((customerId: string, rawLabel: string) => void) | undefined
  readonly onRemoveCustomProfileTag?: ((customerId: string, tagLabel: string) => void) | undefined
  readonly telemetryRefresh?: TelemetryRefreshSnapshot | null | undefined
  readonly onRefreshTelemetry?: (() => void) | undefined
  readonly sortedCustomers: readonly ShowcaseCustomer[]
  readonly customerSort: {
    readonly key: CustomerSortKey
    readonly dir: 1 | -1
  }
  readonly onCustomerSort: (key: CustomerSortKey) => void
  readonly selectedCustomer: ShowcaseCustomer | null
  readonly onSelectCustomer: (cust: ShowcaseCustomer) => void
  readonly onSelectCustomerById?: ((customerId: string) => void) | undefined
  /** Account id the operator tried to inspect but the curated cohort lacks. */
  readonly customerLookupNotice?: string | null | undefined
  readonly onClearCustomerLookupNotice?: (() => void) | undefined
  readonly copiedCliId: string | null
  readonly onCopyCli: (customerId: string) => void
  readonly customerReverseForensics?: ReverseDnsForensicsView | null | undefined
  readonly onClearForensicResult: () => void
  readonly onRunReverseLookup: (ipAddress: string) => void
  readonly onOpenTerminalProfile: (customerId: string) => void
  readonly onSelectAgent?: ((agentId: string) => void) | undefined
  readonly onViewCustomerWagers?: ((customerId: string) => void) | undefined
  /** Set when no live per-customer profile source exists; replaces the table and inspector. */
  readonly profilesUnavailableReason?: string | null | undefined
  /** One-line provenance for the rows on screen (counts + source endpoint). */
  readonly profilesProvenance?: string | null | undefined
  readonly matrixMode?: boolean | undefined
  readonly matrixProfileOverlay?:
    | {
        readonly total: number
        readonly liveOpen: number
        readonly ranked: number
        readonly cohort: number
        readonly liveWagersDistinct: number
      }
    | null
    | undefined
  readonly onOpenTerminalRadar?: ((customerId: string) => void) | undefined
  readonly onRunTerminalCommand?: ((cmd: string) => void) | undefined
  /** Real-time open wager tape for per-customer live activity drilldown. */
  readonly liveWagers?: readonly LiveWager[] | undefined
  /** Jump directly to a specific wager in the Live Wagers Ticket Inspector. */
  readonly onSelectWager?: ((wager: LiveWager) => void) | undefined
  /** Sharpest profiles cross-referenced against live on-chain wager tracking and bridge leads. */
  readonly sharpestOnChainXref?: SharpestOnChainXrefReport | null | undefined
  /** 30-day leaderboard rankings payload used by the Sharpness Heatmap overlay. */
  readonly rankings?: NormalizedRankingsResult | null | undefined
  /** Whether the dockable Live Ticker Overlay is open. */
  readonly tickerOverlayOpen?: boolean | undefined
  /** Toggle the dockable Live Ticker Overlay without leaving Profiles context. */
  readonly onToggleTickerOverlay?: (() => void) | undefined
}

type ProfileDrilldownTab = "overview" | "formulas" | "activity" | "reconciliation" | "tags"

const SORT_KEY_LABELS: Readonly<Record<CustomerSortKey, string>> = {
  score: "Sharp Score",
  clvScore: "CLV Margin",
  var95Usd: "7d VaR 95%",
  holdPct: "Lifetime Hold %",
  ltvUsd: "Desk LTV ($)",
  gini: "Stake Gini",
  meanStake: "Mean Stake ($)",
  syndicateProb: "Syndicate Prob",
  recommendedLimitUsd: "Wager Cap ($)",
  id: "Customer ID",
}

interface CustomerCohortSummary {
  readonly totalVarUsd: number
  readonly totalCapUsd: number
  /** Rows that actually carry a measured VaR / cap; the rest list them in `unknown`. */
  readonly varRows: number
  readonly capRows: number
  readonly alertCount: number
  readonly avgSharpness: string
}

function summarizeDisplayedCustomers(rows: readonly ShowcaseCustomer[]): CustomerCohortSummary {
  let totalVarUsd = 0
  let totalCapUsd = 0
  let varRows = 0
  let capRows = 0
  let alertCount = 0
  let sharpSum = 0
  for (const row of rows) {
    const unknown = row.unknown ?? []
    // A row that never measured VaR or a limit is not a zero-dollar contribution.
    if (!unknown.includes("var95")) {
      totalVarUsd += row.var95Usd
      varRows += 1
    }
    if (!unknown.includes("limit")) {
      totalCapUsd += row.recommendedLimitUsd
      capRows += 1
    }
    if (row.action.includes("ALERT")) alertCount++
    sharpSum += row.score
  }
  return {
    totalVarUsd,
    totalCapUsd,
    varRows,
    capRows,
    alertCount,
    avgSharpness: rows.length > 0 ? (sharpSum / rows.length).toFixed(1) : "n/a",
  }
}

export interface SurveillancePulseSummary {
  readonly activeAlertsTotal: number
  readonly cohortAlertCount: number
  readonly liveAlertTicketCount: number
  readonly criticalTicketCount: number
  readonly steamTicketCount: number
  readonly ticketVelocityValue: string
  readonly ticketVelocitySub: string
  readonly liveTicketCount: number
  readonly openTapeRiskUsd: number
  readonly profiledActiveOnTape: number
  readonly avgGini: number | null
  readonly skewedSizingCount: number
  readonly topAlertCustomer: ShowcaseCustomer | null
}

/**
 * Derive real-time surveillance summary statistics (Active Alerts, Ticket Velocity,
 * Open Tape Risk, and Sizing Gini concentration) directly from live in-memory props.
 */
export function summarizeSurveillancePulse(
  rows: readonly ShowcaseCustomer[],
  liveWagers: readonly LiveWager[],
): SurveillancePulseSummary {
  let cohortAlertCount = 0
  let topAlertCustomer: ShowcaseCustomer | null = null
  let giniSum = 0
  let giniCount = 0
  let skewedSizingCount = 0
  const displayedIds = new Set<string>()

  for (const row of rows) {
    displayedIds.add(row.id.toUpperCase())
    const unknown = row.unknown ?? []
    if (!unknown.includes("gini") && Number.isFinite(row.gini)) {
      giniSum += row.gini
      giniCount += 1
      if (row.gini >= 0.45) {
        skewedSizingCount += 1
      }
    }
    if (row.action.includes("ALERT")) {
      cohortAlertCount += 1
      if (
        topAlertCustomer === null ||
        row.score > topAlertCustomer.score ||
        (row.score === topAlertCustomer.score && row.var95Usd > topAlertCustomer.var95Usd)
      ) {
        topAlertCustomer = row
      }
    }
  }

  let liveAlertTicketCount = 0
  let criticalTicketCount = 0
  let steamTicketCount = 0
  let openTapeRiskUsd = 0
  const activeCustomerIds = new Set<string>()
  const timestamps: number[] = []

  for (const wager of liveWagers) {
    if (
      wager.alertTier === "CRITICAL" ||
      wager.alertTier === "STEAM" ||
      wager.alertTier === "LATENCY"
    ) {
      liveAlertTicketCount += 1
    }
    if (wager.alertTier === "CRITICAL") criticalTicketCount += 1
    if (wager.alertTier === "STEAM") steamTicketCount += 1
    if (Number.isFinite(wager.riskUsd)) {
      openTapeRiskUsd += wager.riskUsd
    }
    const custUpper = wager.customerId.toUpperCase()
    if (displayedIds.has(custUpper)) {
      activeCustomerIds.add(custUpper)
    }
    const parsedTs = Date.parse(wager.timestamp)
    if (Number.isFinite(parsedTs)) {
      timestamps.push(parsedTs)
    }
  }

  let ticketVelocityValue = "0.0 / min"
  let ticketVelocitySub = "awaiting live tape"

  if (liveWagers.length > 0) {
    if (timestamps.length >= 2) {
      let minTs = timestamps[0]!
      let maxTs = timestamps[0]!
      for (let i = 1; i < timestamps.length; i += 1) {
        const ts = timestamps[i]!
        if (ts < minTs) minTs = ts
        if (ts > maxTs) maxTs = ts
      }
      const spanMin = Math.max(1, (maxTs - minTs) / 60_000)
      if (spanMin <= 60) {
        const ratePerMin = liveWagers.length / spanMin
        ticketVelocityValue = `${ratePerMin.toFixed(1)} / min`
        ticketVelocitySub = `${liveWagers.length} tix · ${Math.round(spanMin)}m span`
      } else {
        const recent15m = timestamps.filter((ts) => maxTs - ts <= 15 * 60_000).length
        if (recent15m > 0) {
          ticketVelocityValue = `${(recent15m / 15).toFixed(1)} / min`
          ticketVelocitySub = `${recent15m} in 15m · ${liveWagers.length} total`
        } else {
          const ratePerHr = liveWagers.length / (spanMin / 60)
          ticketVelocityValue = `${ratePerHr.toFixed(1)} / hr`
          ticketVelocitySub = `${liveWagers.length} open tickets`
        }
      }
    } else {
      ticketVelocityValue = `${liveWagers.length} open`
      ticketVelocitySub =
        liveWagers.length === 1 ? "1 live ticket" : `${liveWagers.length} live tickets`
    }
  }

  return {
    activeAlertsTotal: cohortAlertCount + liveAlertTicketCount,
    cohortAlertCount,
    liveAlertTicketCount,
    criticalTicketCount,
    steamTicketCount,
    ticketVelocityValue,
    ticketVelocitySub,
    liveTicketCount: liveWagers.length,
    openTapeRiskUsd,
    profiledActiveOnTape: activeCustomerIds.size,
    avgGini: giniCount > 0 ? giniSum / giniCount : null,
    skewedSizingCount,
    topAlertCustomer,
  }
}

interface RadarAxisSpec {
  readonly label: string
  readonly valueKey: "clvScore" | "skillScore" | "sizingScore" | "sigScore" | "timingScore"
  readonly max: number
}

const RADAR_AXES: readonly RadarAxisSpec[] = [
  {
    label: "CLV Beat Margin",
    valueKey: "clvScore",
    max: 3.0,
  },
  {
    label: "Bayesian Skill",
    valueKey: "skillScore",
    max: 2.5,
  },
  {
    label: "Sizing Discipline",
    valueKey: "sizingScore",
    max: 1.5,
  },
  {
    label: "Signature Specialization",
    valueKey: "sigScore",
    max: 2.0,
  },
  {
    label: "Timing / Parlay Exploitation",
    valueKey: "timingScore",
    max: 1.0,
  },
]

const KPI_TONE_ACCENT: Record<CustomerCohortKpiTone, string> = {
  sky: "#38bdf8",
  red: "#f87171",
  amber: "#fbbf24",
  slate: "#94a3b8",
  emerald: "#34d399",
  violet: "#a78bfa",
}

function resolveBadgeModifier(raw: string): string {
  const key = raw.toLowerCase()
  if (key.includes("originator")) return "originator"
  if (key.includes("syndicate") || key.includes("bridge") || key.includes("beard")) {
    return "syndicate-link"
  }
  if (key.includes("clv")) return "clv-leader"
  if (key.includes("parlay") || key.includes("sgp") || key.includes("corr")) {
    return "parlay-critical"
  }
  if (key.includes("arb") || key.includes("scalp") || key.includes("latency")) {
    return "syndicate-link"
  }
  if (key.includes("whale") || key.includes("vip") || key.includes("high_hold")) return "whale"
  if (
    key.includes("alert") ||
    key.includes("restrict") ||
    key.includes("shadow") ||
    key.includes("gap")
  ) {
    return "alert-operator"
  }
  return "sharp"
}

function resolveProfileRowStatus(cust: ShowcaseCustomer): "critical" | "warning" | "healthy" {
  if (cust.score >= 7.5 || cust.action.includes("ALERT")) return "critical"
  if (
    cust.score >= 5.5 ||
    cust.action.includes("MONITOR") ||
    cust.action.includes("THROTTLE") ||
    cust.action.includes("RESTRICT")
  ) {
    return "warning"
  }
  return "healthy"
}

function ProfileScoreSparkline({
  cust,
  status,
}: {
  readonly cust: ShowcaseCustomer
  readonly status: "critical" | "warning" | "healthy"
}): React.ReactElement {
  const normalized = [
    Math.min(1, Math.max(0, cust.clvScore / 3.0)),
    Math.min(1, Math.max(0, cust.skillScore / 2.5)),
    Math.min(1, Math.max(0, cust.sizingScore / 1.5)),
    Math.min(1, Math.max(0, cust.sigScore / 2.0)),
    Math.min(1, Math.max(0, cust.timingScore / 1.0)),
  ]
  const width = 54
  const height = 16
  const step = width / (normalized.length - 1)
  const points = normalized
    .map((v, idx) => `${(idx * step).toFixed(1)},${(height - 2 - v * (height - 4)).toFixed(1)}`)
    .join(" ")
  const stroke = status === "critical" ? "#f87171" : status === "warning" ? "#fbbf24" : "#38bdf8"
  return (
    <svg
      className="sd-profile-row__sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  )
}

export function CustomersTabPanel({
  bannerDismissed,
  onDismissBanner,
  kpisCollapsed,
  onToggleKpis,
  cohortsReport = null,
  cohortsStatus,
  cohortsError = null,
  searchQuery,
  onSearchQueryChange,
  filterTier,
  onFilterTierChange,
  allProfileCustomers,
  profileClassifications,
  activeProfileTagIds = [],
  onToggleProfileTag,
  onClearProfileTags,
  profileTagCategoryFilter = "ALL",
  onProfileTagCategoryFilterChange,
  onAddCustomProfileTag,
  onRemoveCustomProfileTag,
  telemetryRefresh = null,
  onRefreshTelemetry,
  sortedCustomers,
  customerSort,
  onCustomerSort,
  selectedCustomer,
  onSelectCustomer,
  onSelectCustomerById,
  customerLookupNotice = null,
  onClearCustomerLookupNotice,
  copiedCliId,
  onCopyCli,
  customerReverseForensics = null,
  onClearForensicResult,
  onRunReverseLookup,
  onOpenTerminalProfile,
  onSelectAgent,
  onViewCustomerWagers,
  profilesUnavailableReason = null,
  profilesProvenance = null,
  matrixMode = false,
  matrixProfileOverlay = null,
  onOpenTerminalRadar,
  onRunTerminalCommand,
  liveWagers = [],
  onSelectWager,
  sharpestOnChainXref = null,
  rankings = null,
  tickerOverlayOpen = false,
  onToggleTickerOverlay,
}: CustomersTabPanelProps): React.ReactElement {
  const [profilePage, setProfilePage] = useState(0)
  const [drilldownTab, setDrilldownTab] = useState<ProfileDrilldownTab>("overview")
  const [activitySportFilter, setActivitySportFilter] = useState<string>("ALL")
  const [filtersExpanded, setFiltersExpanded] = useState<boolean>(false)
  const [showRowSparklines, setShowRowSparklines] = useState<boolean>(true)
  const [sharpnessHeatmapEnabled, setSharpnessHeatmapEnabled] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("sportsdesk.profiles.sharpness_heatmap") === "1"
    } catch {
      return false
    }
  })
  const toggleSharpnessHeatmap = () => {
    setSharpnessHeatmapEnabled((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem("sportsdesk.profiles.sharpness_heatmap", next ? "1" : "0")
      } catch {
        // Ignore storage write errors in restricted browsing contexts.
      }
      return next
    })
  }
  const sharpnessHeatmapData = useMemo(
    () => summarizeSharpnessHeatmap(sortedCustomers, rankings),
    [sortedCustomers, rankings],
  )
  const pageSize = 100
  const page = Math.min(profilePage, Math.max(0, Math.ceil(sortedCustomers.length / pageSize) - 1))
  useEffect(() => {
    setProfilePage(0)
  }, [searchQuery, filterTier, activeProfileTagIds])
  useEffect(() => {
    setActivitySportFilter("ALL")
  }, [selectedCustomer?.id])
  const [customTagInput, setCustomTagInput] = useState("")
  const sourceProfiles = allProfileCustomers ?? sortedCustomers

  const selectedLiveActivity = useMemo(
    () =>
      selectedCustomer ? summarizeCustomerLiveActivity(selectedCustomer.id, liveWagers) : null,
    [selectedCustomer, liveWagers],
  )

  const selectedRiskHeadroom = useMemo(
    () => (selectedCustomer ? computeProfileRiskHeadroom(selectedCustomer) : null),
    [selectedCustomer],
  )

  const selectedQuantModel = useMemo(
    () =>
      selectedCustomer
        ? evaluateProfileQuantitativeModel(selectedCustomer, sourceProfiles, selectedLiveActivity)
        : null,
    [selectedCustomer, sourceProfiles, selectedLiveActivity],
  )

  const selectedOnChainXref = useMemo(
    () =>
      selectedCustomer && sharpestOnChainXref
        ? (sharpestOnChainXref.byCustomerId.get(selectedCustomer.id.toUpperCase()) ?? null)
        : null,
    [selectedCustomer, sharpestOnChainXref],
  )

  const getClassification = (cust: ShowcaseCustomer): CustomerProfileClassification =>
    profileClassifications?.get(cust.id) ?? classifyCustomerProfile(cust)

  const profileTypeCounts = useMemo(() => {
    const counts: Record<ProfileTypeId, number> = {
      UNMEASURED: 0,
      ORIGINATOR: 0,
      STEAM_SYNDICATE: 0,
      CORRELATED_PARLAY_EXPLOITER: 0,
      SHARP_DISCIPLINED: 0,
      BONUS_ARB_SCALPER: 0,
      SEMI_SHARP: 0,
      HIGH_HOLD_WHALE: 0,
      RECREATIONAL: 0,
    }
    for (const cust of sourceProfiles) {
      const cls = profileClassifications?.get(cust.id) ?? classifyCustomerProfile(cust)
      counts[cls.type.id] += 1
    }
    return counts
  }, [sourceProfiles, profileClassifications])

  const tagCatalog = useMemo(() => {
    const byId = new Map<string, { tag: ProfileTag; count: number }>()
    for (const cust of sourceProfiles) {
      const cls = profileClassifications?.get(cust.id) ?? classifyCustomerProfile(cust)
      for (const tag of cls.tags) {
        if (profileTagCategoryFilter !== "ALL" && tag.category !== profileTagCategoryFilter) {
          continue
        }
        const entry = byId.get(tag.id)
        if (entry) {
          entry.count += 1
        } else {
          byId.set(tag.id, { tag, count: 1 })
        }
      }
    }
    return Array.from(byId.values()).sort((a, b) => {
      const aActive = activeProfileTagIds.includes(a.tag.id) ? 1 : 0
      const bActive = activeProfileTagIds.includes(b.tag.id) ? 1 : 0
      if (aActive !== bActive) return bActive - aActive
      if (a.tag.isCustom && !b.tag.isCustom) return -1
      if (!a.tag.isCustom && b.tag.isCustom) return 1
      if (b.count !== a.count) return b.count - a.count
      return a.tag.label.localeCompare(b.tag.label)
    })
  }, [sourceProfiles, profileClassifications, profileTagCategoryFilter, activeProfileTagIds])

  const showOpenRisk = matrixMode && sortedCustomers.some((c) => (c.openRiskUsd ?? 0) > 0)
  const effectiveStatus: "pending" | "ready" | "unavailable" =
    cohortsStatus ?? (cohortsReport !== null ? "ready" : "pending")
  const kpiCards = deriveCustomerCohortKpiCards({
    report: cohortsReport,
    status: effectiveStatus,
    error: cohortsError,
  })
  const isUnknown = (cust: ShowcaseCustomer, field: string): boolean =>
    cust.unknown?.includes(field) ?? false
  const provenanceBadge = formatProvenanceBadge(
    effectiveStatus === "unavailable"
      ? {
          kind: "unavailable",
          label: cohortsError || "GET /api/customers failed",
          sourcePath: "/api/customers",
          observedAt: "",
        }
      : (cohortsReport?.provenance ?? PENDING_COHORTS_PROVENANCE),
    { staleAfterMinutes: DASHBOARD_FRESHNESS.stale_after_minutes },
  )

  const selectedClassification = selectedCustomer ? getClassification(selectedCustomer) : null

  const activeInspectFilters = useMemo(
    () => [
      ...(filterTier !== "ALL" ? [`type=${filterTier}`] : []),
      ...(searchQuery.trim() ? [`q=${searchQuery.trim()}`] : []),
      ...activeProfileTagIds.map((t) => `tag=${t}`),
    ],
    [filterTier, searchQuery, activeProfileTagIds],
  )

  return (
    <div>
      {/* Session Notice Banner (Dismissible) */}
      {!bannerDismissed && (
        <div className="sd-portal-session-notice" data-portal-session-notice="true">
          <div
            className="sd-alert-banner sd-alert-banner--session-expired"
            data-alert="session-expired"
            data-severity="warning"
            data-status="warning"
            role="status"
          >
            <div className="sd-alert-banner__body">
              <AlertTriangle size={14} className="sd-alert-banner__icon" aria-hidden="true" />
              <span className="sd-alert-banner__text">
                <strong>Portal Session:</strong> Direct jumps reuse a single Fantasy402 manager tab.
                If expired, re-authenticate before opening customer portal links.
              </span>
            </div>
            <div className="sd-alert-banner__actions">
              <a
                href={buildFantasy402PortalEntryUrl()}
                target={FANTASY402_PORTAL_WINDOW_TARGET}
                className="sd-portal-session-notice-link"
              >
                Re-Auth Portal ↗
              </a>
              <button
                type="button"
                className="sd-portal-session-notice-dismiss"
                onClick={onDismissBanner}
                title="Dismiss portal session notice"
                aria-label="Dismiss portal session notice"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Collapsible KPI Strip Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{
              fontSize: "11px",
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontWeight: 600,
            }}
          >
            Corpora & Surveillance Cohorts
          </span>
          <span
            title={provenanceBadge.detail}
            style={{
              fontSize: "10px",
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: "999px",
              color: provenanceBadge.fg,
              backgroundColor: provenanceBadge.bg,
              border: `1px solid ${provenanceBadge.border}`,
            }}
          >
            {provenanceBadge.badgeText}
          </span>
          {cohortsReport?.provenance.sourcePath ? (
            <span style={{ fontSize: "10px", color: "#64748b" }}>
              {cohortsReport.provenance.sourcePath}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            color: "#38bdf8",
            fontSize: "11px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 6px",
          }}
          onClick={onToggleKpis}
        >
          {kpisCollapsed ? "Show Corpora ▼" : "Hide Corpora ▲"}
        </button>
      </div>

      {/* KPI Summary Cards (Collapsible, hydrated dynamically from /api/customers) */}
      {!kpisCollapsed && (
        <div className="kpi-strip" style={styles.kpiGrid}>
          {kpiCards.map((card) => {
            const accent =
              card.status === "unavailable"
                ? "#f87171"
                : card.status === "pending"
                  ? "#64748b"
                  : KPI_TONE_ACCENT[card.tone]
            const isInteractive = card.status === "ready" && card.filterTier !== null
            const isActiveFilter =
              isInteractive && card.filterTier !== "ALL" && filterTier === card.filterTier
            const edgeColor = isActiveFilter ? accent : "#1e293b"
            const { border: _kpiCardBorder, ...kpiCardRest } = styles.kpiCard
            const cardStyle: React.CSSProperties = {
              ...kpiCardRest,
              borderTop: `1px solid ${edgeColor}`,
              borderRight: `1px solid ${edgeColor}`,
              borderBottom: `1px solid ${edgeColor}`,
              borderLeft: `3px solid ${accent}`,
              textAlign: "left",
              width: "100%",
              cursor: isInteractive ? "pointer" : "default",
            }
            const content = (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <span style={styles.kpiLabel}>{card.label}</span>
                  {card.sharePct !== null && card.id !== "unique-surveillance" && (
                    <span
                      style={{
                        fontSize: "10px",
                        fontWeight: 700,
                        color: accent,
                        backgroundColor: "rgba(15, 23, 42, 0.85)",
                        border: "1px solid #1e293b",
                        borderRadius: "999px",
                        padding: "1px 6px",
                        whiteSpace: "nowrap",
                      }}
                      title={`${card.sharePct}% of Unique Surveillance (${card.count?.toLocaleString() ?? "?"})`}
                    >
                      {card.sharePct}%
                    </span>
                  )}
                </div>
                <div
                  style={{
                    ...styles.kpiVal,
                    color:
                      card.status === "ready"
                        ? "#f1f5f9"
                        : card.status === "unavailable"
                          ? "#fca5a5"
                          : "#94a3b8",
                  }}
                >
                  {card.status === "pending" ? (
                    <SkeletonBlock
                      width="58%"
                      height={22}
                      tone="accent"
                      style={{ margin: "2px 0" }}
                    />
                  ) : (
                    card.value
                  )}
                </div>
                <div style={styles.kpiSub}>
                  {card.status === "pending" ? (
                    <SkeletonBlock width="76%" height={11} tone="subtle" />
                  ) : (
                    card.sub
                  )}
                </div>
              </>
            )
            return isInteractive ? (
              <button
                key={card.id}
                type="button"
                style={cardStyle}
                onClick={() => {
                  if (card.filterTier) {
                    onFilterTierChange(card.filterTier)
                  }
                }}
                title={
                  card.filterTier === "ALL"
                    ? "Show all customer profiles"
                    : `Filter profiles to ${card.filterTier}`
                }
              >
                {content}
              </button>
            ) : (
              <div key={card.id} style={cardStyle}>
                {content}
              </div>
            )
          })}
        </div>
      )}

      {/* Connected Telemetry & Profile Sync Bar */}
      {telemetryRefresh && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px 12px",
            marginBottom: "10px",
            padding: "8px 12px",
            borderRadius: "8px",
            backgroundColor: "rgba(15, 23, 42, 0.72)",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#1e293b",
            fontSize: "11px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "10px",
              color: "#94a3b8",
            }}
          >
            <span
              style={{
                fontWeight: 700,
                color: "#e2e8f0",
                letterSpacing: "0.03em",
                textTransform: "uppercase",
                fontSize: "10px",
              }}
            >
              Telemetry Sync
            </span>
            <span style={{ color: telemetryRefresh.daemonColor, fontWeight: 600 }}>
              {telemetryRefresh.daemonLabel}
            </span>
            <span>·</span>
            <span
              style={{
                color:
                  telemetryRefresh.r2OverallStatus === "fresh"
                    ? "#4ade80"
                    : telemetryRefresh.r2OverallStatus === "stale"
                      ? "#fbbf24"
                      : telemetryRefresh.r2OverallStatus === "degraded"
                        ? "#f87171"
                        : "#94a3b8",
                fontWeight: 600,
              }}
            >
              ☁️ {telemetryRefresh.r2Label}
            </span>
            <span>·</span>
            <span
              style={{
                color: telemetryRefresh.wsConnected ? "#4ade80" : "#fbbf24",
                fontWeight: 600,
              }}
            >
              {telemetryRefresh.wsConnected ? "● Stream Live" : "○ Stream Idle"}
            </span>
            {telemetryRefresh.lastProbedAt && (
              <>
                <span>·</span>
                <span
                  style={{
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    color: "#64748b",
                    fontSize: "10.5px",
                  }}
                >
                  Last probe: {new Date(telemetryRefresh.lastProbedAt).toLocaleTimeString()}
                  {telemetryRefresh.lastProbeMs !== null
                    ? ` (${telemetryRefresh.lastProbeMs}ms)`
                    : ""}
                </span>
              </>
            )}
            {telemetryRefresh.error && (
              <span style={{ color: "#fca5a5" }}>⚠️ {telemetryRefresh.error}</span>
            )}
          </div>
          <div
            style={{ display: "inline-flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}
          >
            <WsSyncStatusIndicator
              wsConnected={telemetryRefresh.wsConnected}
              lastHeartbeatAt={telemetryRefresh.wsLastHeartbeatAt}
              latencyMs={telemetryRefresh.wsLatencyMs}
              compact
            />
            {onRefreshTelemetry && (
              <button
                type="button"
                className="sd-refresh-telemetry-btn"
                onClick={onRefreshTelemetry}
                disabled={telemetryRefresh.probing}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "4px 10px",
                  borderRadius: "6px",
                  fontSize: "11px",
                  fontWeight: 600,
                  backgroundColor: "rgba(56, 189, 248, 0.12)",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "rgba(56, 189, 248, 0.35)",
                  color: "#7dd3fc",
                  cursor: telemetryRefresh.probing ? "wait" : "pointer",
                }}
              >
                <RefreshCw size={12} className={telemetryRefresh.probing ? "sd-spin" : undefined} />
                <span>
                  {telemetryRefresh.probing ? "Probing :4020 & R2..." : "Refresh Telemetry"}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Collapsible Filter Bar: Search + Profile Types + Categorized Profile Tags */}
      <div className="sd-filter-drawer" data-type="profile-filters">
        <div className="sd-filter-drawer__top">
          <input
            style={{
              ...styles.searchInput,
              flex: "1 1 260px",
              minWidth: "220px",
            }}
            placeholder="Search Customer ID, Name, Agent, Profile Type, IP, or Tag..."
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
          />
          <button
            type="button"
            className={`sd-action-btn ${filtersExpanded || filterTier !== "ALL" || activeProfileTagIds.length > 0 ? "sd-action-btn--active" : ""}`}
            aria-expanded={filtersExpanded}
            onClick={() => setFiltersExpanded((prev) => !prev)}
            title="Expand or collapse Profile Type and Tag filters"
          >
            <SlidersHorizontal size={12} aria-hidden="true" />
            <span>Filters</span>
            {(filterTier !== "ALL" || activeProfileTagIds.length > 0) && (
              <span className="sd-tabular sd-filter-drawer__count">
                {(filterTier !== "ALL" ? 1 : 0) + activeProfileTagIds.length}
              </span>
            )}
            {filtersExpanded ? (
              <ChevronUp size={12} aria-hidden="true" />
            ) : (
              <ChevronDown size={12} aria-hidden="true" />
            )}
          </button>
          {filterTier !== "ALL" && (
            <button
              type="button"
              className="sd-badge sd-badge--originator"
              onClick={() => onFilterTierChange("ALL")}
              title="Clear active profile type filter"
            >
              <span>Type: {filterTier}</span>
              <span aria-hidden="true">×</span>
            </button>
          )}
          {activeProfileTagIds.slice(0, 4).map((tagId) => (
            <button
              key={tagId}
              type="button"
              className={`sd-badge sd-badge--${resolveBadgeModifier(tagId)}`}
              onClick={() => onToggleProfileTag?.(tagId)}
              title={`Remove ${tagId} tag filter`}
            >
              <span>{tagId}</span>
              <span aria-hidden="true">×</span>
            </button>
          ))}
          {(activeProfileTagIds.length > 0 ||
            filterTier !== "ALL" ||
            profileTagCategoryFilter !== "ALL") && (
            <button
              type="button"
              className="sd-action-btn sd-action-btn--warning"
              onClick={() => {
                onFilterTierChange("ALL")
                onClearProfileTags?.()
              }}
            >
              Reset
            </button>
          )}
        </div>

        {filtersExpanded && (
          <div className="sd-filter-drawer__body">
            <div className="sd-filter-drawer__row">
              <span className="sd-filter-drawer__label">Types:</span>
              <button
                type="button"
                style={styles.pill(filterTier === "ALL")}
                onClick={() => onFilterTierChange("ALL")}
              >
                All (<span className="sd-tabular">{sourceProfiles.length}</span>)
              </button>
              {PROFILE_TYPE_ORDER.map((typeId) => {
                const spec = PROFILE_TYPE_SPECS[typeId]
                const count = profileTypeCounts[typeId]
                const isActive = filterTier === typeId
                return (
                  <button
                    key={typeId}
                    type="button"
                    onClick={() => onFilterTierChange(isActive ? "ALL" : typeId)}
                    title={spec.description}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                      padding: "4px 9px",
                      borderRadius: "5px",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                      backgroundColor: isActive ? spec.bg : "#0b1120",
                      color: isActive ? spec.fg : "#94a3b8",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: isActive ? spec.border : "#243247",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span>{spec.icon}</span>
                    <span>{spec.shortLabel}</span>
                    <span className="sd-tabular" style={{ fontSize: "10px", opacity: 0.85 }}>
                      {count}
                    </span>
                  </button>
                )
              })}
              {matrixMode ? (
                <>
                  {(["TIER_1", "TIER_2", "TIER_3", "TIER_4", "TIER_5"] as const).map((tier) => (
                    <button
                      key={tier}
                      type="button"
                      style={styles.pill(filterTier === tier)}
                      onClick={() => onFilterTierChange(tier)}
                      title={`Filter by data tier ${tier} (30d rankings)`}
                    >
                      {tier.replace("TIER_", "T")}
                    </button>
                  ))}
                </>
              ) : null}
            </div>

            {/* Categorized Profile Tags Filter Row */}
            <div className="sd-filter-drawer__row sd-filter-drawer__row--tags">
              <span className="sd-filter-drawer__label">
                <Tag size={11} aria-hidden="true" />
                <span>Tags:</span>
              </span>
              {(["ALL", ...PROFILE_TAG_CATEGORIES] as const).map((cat) => {
                const active = profileTagCategoryFilter === cat
                const meta = cat === "ALL" ? null : PROFILE_TAG_CATEGORY_META[cat]
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => onProfileTagCategoryFilterChange?.(cat)}
                    style={{
                      padding: "2px 7px",
                      borderRadius: "4px",
                      fontSize: "10px",
                      fontWeight: 700,
                      cursor: "pointer",
                      backgroundColor: active
                        ? (meta?.bg ?? "rgba(56, 189, 248, 0.16)")
                        : "transparent",
                      color: active ? (meta?.fg ?? "#7dd3fc") : "#64748b",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: active ? (meta?.border ?? "rgba(56, 189, 248, 0.4)") : "#1e293b",
                    }}
                  >
                    {cat === "ALL" ? "All" : meta?.label}
                  </button>
                )
              })}
              <span style={{ color: "#334155", margin: "0 2px" }}>|</span>
              {tagCatalog.slice(0, 14).map(({ tag, count }) => {
                const isSelected = activeProfileTagIds.includes(tag.id)
                const mod = resolveBadgeModifier(tag.id || tag.label)
                return (
                  <button
                    key={tag.id}
                    type="button"
                    className={`sd-badge sd-badge--${mod}${isSelected ? " sd-badge--selected" : ""}`}
                    onClick={() => onToggleProfileTag?.(tag.id)}
                    title={`${tag.category} · ${tag.description}`}
                  >
                    <span>{tag.label}</span>
                    <span className="sd-tabular" style={{ opacity: 0.78 }}>
                      {count}
                    </span>
                  </button>
                )
              })}
              {(activeProfileTagIds.length > 0 || profileTagCategoryFilter !== "ALL") && (
                <button
                  type="button"
                  className="sd-action-btn sd-action-btn--warning"
                  onClick={() => onClearProfileTags?.()}
                >
                  ✕ Clear tags ({activeProfileTagIds.length})
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {matrixMode && matrixProfileOverlay ? (
        <div
          data-customers-matrix="overlay"
          style={{
            margin: "0 12px 10px",
            padding: "10px 12px",
            borderRadius: "8px",
            border: "1px solid rgba(56, 189, 248, 0.35)",
            background: "linear-gradient(90deg, rgba(56, 189, 248, 0.1), rgba(168, 85, 247, 0.08))",
            fontSize: "12px",
            color: "#cbd5e1",
          }}
        >
          <strong style={{ color: "#7dd3fc" }}>Matrix overlay</strong> merges{" "}
          <b>{matrixProfileOverlay.cohort}</b> cohort rows, <b>{matrixProfileOverlay.ranked}</b>{" "}
          ranked players, and <b>{matrixProfileOverlay.liveOpen}</b> live-open customers (
          {matrixProfileOverlay.liveWagersDistinct} on the wager tape). Tiers and scores follow API
          payloads — not hardcoded cutoffs.
        </div>
      ) : null}

      {profilesProvenance !== null && (
        <div
          role="status"
          data-profiles-source="cohort"
          style={{
            margin: "0 12px 8px",
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          {profilesProvenance}
        </div>
      )}

      {customerLookupNotice !== null ? (
        <div
          role="status"
          data-customer-lookup-notice={customerLookupNotice}
          className="sd-card"
          style={{
            margin: "0 12px 10px",
            padding: "10px 14px",
            border: "1px solid rgba(245, 158, 11, 0.45)",
            backgroundColor: "rgba(245, 158, 11, 0.10)",
            color: "#fcd34d",
            fontSize: "12px",
          }}
        >
          <strong>
            No curated cohort profile for <code>{customerLookupNotice}</code>.
          </strong>{" "}
          The shadow buyer table contains accounts outside the profile cohort; the search is set to
          this id so a partial match is still visible.
          <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
            <button
              type="button"
              className="sd-preset-btn"
              onClick={() => onOpenTerminalProfile(customerLookupNotice)}
            >
              💻 Open terminal profile
            </button>
            {onClearCustomerLookupNotice ? (
              <button type="button" className="sd-preset-btn" onClick={onClearCustomerLookupNotice}>
                Dismiss
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Two-Column Grid: Customer Table & Deep Inspector */}
      {(() => {
        if (
          effectiveStatus === "pending" &&
          sourceProfiles.length === 0 &&
          !(matrixMode && sortedCustomers.length > 0)
        ) {
          return (
            <SkeletonSplitWorkspace
              statusMessage="Hydrating Customer Cohorts & Surveillance Profiles…"
              endpointLabel="GET /api/customers"
              rowCount={6}
              skeletonId="customers-workspace"
            />
          )
        }
        if (
          effectiveStatus === "unavailable" &&
          sourceProfiles.length === 0 &&
          !(matrixMode && sortedCustomers.length > 0)
        ) {
          return (
            <div
              role="alert"
              data-profiles-source="error"
              style={{
                ...styles.tablePanel,
                textAlign: "center",
                color: "#cbd5e1",
                fontSize: "13px",
                padding: "24px",
              }}
            >
              <h3
                style={{
                  margin: "0 0 8px",
                  fontSize: "16px",
                  color: "#fca5a5",
                }}
              >
                Unable to load customer cohorts
              </h3>
              <div style={{ marginBottom: "14px", color: "#94a3b8" }}>
                {cohortsError || "GET /api/customers returned an error."}
              </div>
              {onRefreshTelemetry && (
                <button
                  type="button"
                  onClick={onRefreshTelemetry}
                  style={{
                    ...styles.actionBtn,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    padding: "8px 14px",
                    fontSize: "12px",
                  }}
                >
                  <RefreshCw size={13} />
                  <span>Retry Profile Hydration</span>
                </button>
              )}
            </div>
          )
        }
        if (profilesUnavailableReason !== null && !(matrixMode && sortedCustomers.length > 0)) {
          return (
            <div
              role="status"
              data-profiles-source="unavailable"
              style={{
                ...styles.tablePanel,
                textAlign: "center",
                color: "#94a3b8",
                fontSize: "13px",
              }}
            >
              <h3
                style={{
                  margin: "0 0 8px",
                  fontSize: "16px",
                  color: "#f8fafc",
                }}
              >
                No live profile source yet
              </h3>
              <div>{profilesUnavailableReason}</div>
            </div>
          )
        }
        const cohortSummary = summarizeDisplayedCustomers(sortedCustomers)
        const surveillancePulse = summarizeSurveillancePulse(sortedCustomers, liveWagers)
        const hasActiveFilter =
          searchQuery.trim() !== "" ||
          filterTier !== "ALL" ||
          activeProfileTagIds.length > 0 ||
          profileTagCategoryFilter !== "ALL"
        const selectedIndex = selectedCustomer
          ? sortedCustomers.findIndex((c) => c.id === selectedCustomer.id)
          : -1
        const canStepPrev = selectedIndex > 0
        const canStepNext = selectedIndex >= 0 && selectedIndex < sortedCustomers.length - 1
        const resetFilters = () => {
          onSearchQueryChange("")
          onFilterTierChange("ALL")
          onClearProfileTags?.()
        }
        const stepCustomer = (delta: -1 | 1) => {
          if (sortedCustomers.length === 0) return
          const nextIdx =
            selectedIndex < 0
              ? 0
              : Math.min(sortedCustomers.length - 1, Math.max(0, selectedIndex + delta))
          const next = sortedCustomers[nextIdx]
          if (next) {
            onSelectCustomer(next)
            onClearForensicResult()
          }
        }

        return (
          <div style={styles.showcaseGrid}>
            {/* Left Column: Profiled Bettors List (.sd-profile-list) */}
            <div
              className="sd-profile-list"
              style={styles.tablePanel}
              data-type="profile-list"
              data-sharpness-heatmap={sharpnessHeatmapEnabled ? "true" : "false"}
            >
              <div className="sd-profile-list__header">
                <div className="sd-profile-list__title-group">
                  <h3 className="sd-profile-list__title">
                    Profiled Bettors{" "}
                    <span className="sd-tabular sd-profile-list__count">
                      ({sortedCustomers.length})
                    </span>
                  </h3>
                  <span className="sd-badge sd-badge--sharp sd-tabular">
                    Avg {cohortSummary.avgSharpness}
                  </span>
                  <span className="sd-badge sd-badge--alert-operator sd-tabular">
                    {cohortSummary.alertCount} Alerts
                  </span>
                  <span className="sd-profile-list__totals sd-tabular">
                    Σ VaR ({cohortSummary.varRows}/{sortedCustomers.length}):{" "}
                    <strong>${cohortSummary.totalVarUsd.toLocaleString()}</strong> · Σ Caps (
                    {cohortSummary.capRows}/{sortedCustomers.length}):{" "}
                    <strong>${cohortSummary.totalCapUsd.toLocaleString()}</strong>
                  </span>
                </div>
                <div className="sd-profile-list__controls">
                  <select
                    aria-label="Sort profiled bettors by metric"
                    className="sd-profile-sort-select"
                    value={customerSort.key}
                    onChange={(e) => onCustomerSort(e.target.value as CustomerSortKey)}
                    title="Sort Profiled Bettors by quantitative metric"
                  >
                    {(Object.keys(SORT_KEY_LABELS) as CustomerSortKey[]).map((key) => (
                      <option key={key} value={key}>
                        Sort: {SORT_KEY_LABELS[key]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={`sd-action-btn sd-heatmap-toggle${sharpnessHeatmapEnabled ? " sd-action-btn--primary sd-heatmap-toggle--active" : ""}`}
                    aria-pressed={sharpnessHeatmapEnabled}
                    data-sharpness-heatmap-toggle="true"
                    onClick={toggleSharpnessHeatmap}
                    title={
                      rankings && rankings.players.length > 0
                        ? `Overlay 30d rankings CLV-leader sharpness signals (${sharpnessHeatmapData.summary.sharpCount} sharp · ${sharpnessHeatmapData.summary.clvLeaderCount} CLV leaders)`
                        : "Toggle CLV-leader sharpness heatmap overlay across profiled bettors"
                    }
                  >
                    <Flame size={11} aria-hidden="true" />
                    <span>Sharpness Heatmap</span>
                    {sharpnessHeatmapEnabled && (
                      <span className="sd-tabular">
                        ({sharpnessHeatmapData.summary.sharpCount})
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`sd-action-btn ${showRowSparklines ? "sd-action-btn--active" : ""}`}
                    aria-pressed={showRowSparklines}
                    onClick={() => setShowRowSparklines((prev) => !prev)}
                    title="Toggle inline 5-axis sharpness sparklines in profile rows"
                  >
                    <Activity size={11} aria-hidden="true" />
                    <span>Sparklines</span>
                  </button>
                  {onToggleTickerOverlay && (
                    <button
                      type="button"
                      className={`sd-action-btn ${tickerOverlayOpen ? "sd-action-btn--primary" : ""}`}
                      aria-pressed={tickerOverlayOpen}
                      onClick={onToggleTickerOverlay}
                      title="Dock live sharp/whale wager ticker without leaving Profiles"
                    >
                      <Radio size={11} aria-hidden="true" />
                      <span>Ticker</span>
                      <span className="sd-tabular">({liveWagers.length})</span>
                    </button>
                  )}
                  {hasActiveFilter && (
                    <button
                      type="button"
                      className="sd-action-btn sd-action-btn--warning"
                      onClick={resetFilters}
                    >
                      ✕ Reset
                    </button>
                  )}
                </div>
              </div>
              {sharpnessHeatmapEnabled && (
                <div
                  className="sd-sharp-heatmap-strip sd-tabular"
                  data-sharpness-heatmap-strip="true"
                >
                  <span className="sd-badge sd-badge--clv-leader">CLV-LEADER OVERLAY</span>
                  <span>
                    Highlighted rows: <strong>{sharpnessHeatmapData.summary.sharpCount}</strong>{" "}
                    sharp · <strong>{sharpnessHeatmapData.summary.clvLeaderCount}</strong> CLV
                    leaders ·{" "}
                    {sharpnessHeatmapData.summary.rankedTotal > 0 ? (
                      <>
                        <strong>{sharpnessHeatmapData.summary.matchedCount}</strong> /{" "}
                        {sharpnessHeatmapData.summary.rankedTotal} 30d rankings correlated
                      </>
                    ) : (
                      "30d rankings feed pending (using profile CLV & score signals)"
                    )}
                  </span>
                </div>
              )}
              <div className="profiles-wrap">
                <div
                  className="sd-surveillance-summary-bar sd-tabular"
                  data-surveillance-summary-bar="true"
                  role="region"
                  aria-label="Real-time surveillance summary statistics"
                >
                  <div className="sd-surveillance-summary-bar__metrics">
                    {surveillancePulse.topAlertCustomer ? (
                      <button
                        type="button"
                        className={`sd-surveillance-stat sd-surveillance-stat--alert${surveillancePulse.activeAlertsTotal > 0 ? " sd-surveillance-stat--elevated" : ""}`}
                        data-surveillance-stat="active-alerts"
                        onClick={() => {
                          if (surveillancePulse.topAlertCustomer) {
                            onSelectCustomer(surveillancePulse.topAlertCustomer)
                            onClearForensicResult()
                          }
                        }}
                        title={`Focus highest-priority alerted account (${surveillancePulse.topAlertCustomer.id}) · ${surveillancePulse.cohortAlertCount} alerted profiles, ${surveillancePulse.liveAlertTicketCount} flagged tape tickets`}
                      >
                        <span className="sd-surveillance-stat__label">
                          <ShieldAlert size={11} aria-hidden="true" />
                          <span>Active Alerts</span>
                        </span>
                        <span className="sd-surveillance-stat__value">
                          {surveillancePulse.activeAlertsTotal}
                        </span>
                        <span className="sd-surveillance-stat__sub">
                          {surveillancePulse.cohortAlertCount} profiles ·{" "}
                          {surveillancePulse.liveAlertTicketCount} tape
                          {surveillancePulse.criticalTicketCount > 0
                            ? ` (${surveillancePulse.criticalTicketCount} crit)`
                            : ""}
                        </span>
                      </button>
                    ) : (
                      <div
                        className={`sd-surveillance-stat sd-surveillance-stat--alert${surveillancePulse.activeAlertsTotal > 0 ? " sd-surveillance-stat--elevated" : ""}`}
                        data-surveillance-stat="active-alerts"
                        title={`${surveillancePulse.cohortAlertCount} alerted profiles · ${surveillancePulse.liveAlertTicketCount} flagged tape tickets`}
                      >
                        <span className="sd-surveillance-stat__label">
                          <ShieldAlert size={11} aria-hidden="true" />
                          <span>Active Alerts</span>
                        </span>
                        <span className="sd-surveillance-stat__value">
                          {surveillancePulse.activeAlertsTotal}
                        </span>
                        <span className="sd-surveillance-stat__sub">
                          {surveillancePulse.cohortAlertCount} profiles ·{" "}
                          {surveillancePulse.liveAlertTicketCount} tape
                        </span>
                      </div>
                    )}

                    {onToggleTickerOverlay ? (
                      <button
                        type="button"
                        className="sd-surveillance-stat sd-surveillance-stat--velocity"
                        data-surveillance-stat="ticket-velocity"
                        aria-pressed={tickerOverlayOpen}
                        onClick={onToggleTickerOverlay}
                        title="Toggle docked live wager ticker to inspect incoming ticket flow"
                      >
                        <span className="sd-surveillance-stat__label">
                          <Activity size={11} aria-hidden="true" />
                          <span>Ticket Velocity</span>
                        </span>
                        <span className="sd-surveillance-stat__value">
                          {surveillancePulse.ticketVelocityValue}
                        </span>
                        <span className="sd-surveillance-stat__sub">
                          {surveillancePulse.ticketVelocitySub}
                        </span>
                      </button>
                    ) : (
                      <div
                        className="sd-surveillance-stat sd-surveillance-stat--velocity"
                        data-surveillance-stat="ticket-velocity"
                      >
                        <span className="sd-surveillance-stat__label">
                          <Activity size={11} aria-hidden="true" />
                          <span>Ticket Velocity</span>
                        </span>
                        <span className="sd-surveillance-stat__value">
                          {surveillancePulse.ticketVelocityValue}
                        </span>
                        <span className="sd-surveillance-stat__sub">
                          {surveillancePulse.ticketVelocitySub}
                        </span>
                      </div>
                    )}

                    <div
                      className="sd-surveillance-stat sd-surveillance-stat--risk"
                      data-surveillance-stat="open-tape-risk"
                      title={`Total open risk across ${surveillancePulse.liveTicketCount} live tape tickets (${surveillancePulse.profiledActiveOnTape} matched to visible profiles)`}
                    >
                      <span className="sd-surveillance-stat__label">
                        <Radio size={11} aria-hidden="true" />
                        <span>Open Tape Risk</span>
                      </span>
                      <span className="sd-surveillance-stat__value">
                        ${Math.round(surveillancePulse.openTapeRiskUsd).toLocaleString()}
                      </span>
                      <span className="sd-surveillance-stat__sub">
                        {surveillancePulse.profiledActiveOnTape} profiled on tape
                      </span>
                    </div>

                    <button
                      type="button"
                      className={`sd-surveillance-stat sd-surveillance-stat--sizing${customerSort.key === "gini" ? " sd-surveillance-stat--active" : ""}`}
                      data-surveillance-stat="sizing-gini"
                      onClick={() => onCustomerSort("gini")}
                      title="Sort table by Sizing Strategy (Gini stake-concentration index)"
                    >
                      <span className="sd-surveillance-stat__label">
                        <Flame size={11} aria-hidden="true" />
                        <span>Sizing Gini</span>
                      </span>
                      <span className="sd-surveillance-stat__value">
                        {surveillancePulse.avgGini !== null
                          ? surveillancePulse.avgGini.toFixed(2)
                          : "—"}
                      </span>
                      <span className="sd-surveillance-stat__sub">
                        {surveillancePulse.skewedSizingCount} skewed (&ge;0.45)
                      </span>
                    </button>
                  </div>

                  <div
                    className={`sd-surveillance-summary-bar__status${telemetryRefresh?.wsConnected ? " sd-surveillance-summary-bar__status--live" : ""}`}
                    data-surveillance-stream={telemetryRefresh?.wsConnected ? "live" : "snapshot"}
                    title={
                      telemetryRefresh?.wsConnected
                        ? "Live WebSocket telemetry stream connected"
                        : "Summary reflects latest captured snapshot"
                    }
                  >
                    <span className="sd-surveillance-summary-bar__dot" aria-hidden="true" />
                    <span>{telemetryRefresh?.wsConnected ? "Live Pulse" : "Snapshot"}</span>
                  </div>
                </div>
                <table style={styles.table}>
                  <thead>
                    <tr style={styles.thRow}>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("id")}
                      >
                        Customer
                        <span className="sort-arrow">
                          {customerSort.key === "id" ? (customerSort.dir === 1 ? "▲" : "▼") : ""}
                        </span>
                      </th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("score")}
                      >
                        Profile Type &amp; Score
                        <span className="sort-arrow">
                          {customerSort.key === "score" ? (customerSort.dir === 1 ? "▲" : "▼") : ""}
                        </span>
                      </th>
                      <th
                        className={`sortable sd-th-sizing-strategy${customerSort.key === "gini" ? " sd-th-sizing-strategy--active" : ""}`}
                        style={styles.th}
                        onClick={() => onCustomerSort("gini")}
                        title={
                          surveillancePulse.avgGini !== null
                            ? `Sort by Sizing Strategy · Cohort mean Gini ${surveillancePulse.avgGini.toFixed(2)} (${surveillancePulse.skewedSizingCount} high-conviction skewed accounts)`
                            : "Sort by Sizing Strategy (Gini stake-concentration index)"
                        }
                      >
                        <span className="sd-th-sizing-strategy__inner">
                          <span>Sizing Strategy</span>
                          {surveillancePulse.avgGini !== null && (
                            <span className="sd-th-sizing-strategy__metric sd-tabular">
                              μ {surveillancePulse.avgGini.toFixed(2)}
                            </span>
                          )}
                          <span className="sort-arrow">
                            {customerSort.key === "gini"
                              ? customerSort.dir === 1
                                ? "▲"
                                : "▼"
                              : ""}
                          </span>
                        </span>
                      </th>
                      <th style={styles.th}>Specialization</th>
                      {showOpenRisk ? (
                        <th style={styles.th} title="Open risk from live tape">
                          24h Open
                        </th>
                      ) : null}
                      <th style={styles.th}>Correlated Par</th>
                      <th
                        className="sortable"
                        style={styles.th}
                        onClick={() => onCustomerSort("var95Usd")}
                      >
                        7d VaR (95%)
                        <span className="sort-arrow">
                          {customerSort.key === "var95Usd"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                      <th
                        className="sortable directive"
                        style={styles.th}
                        onClick={() => onCustomerSort("holdPct")}
                      >
                        Desk Directive
                        <span className="sort-arrow">
                          {customerSort.key === "holdPct"
                            ? customerSort.dir === 1
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCustomers.slice(page * pageSize, (page + 1) * pageSize).map((cust) => {
                      const isSelected = selectedCustomer?.id === cust.id
                      const classification = getClassification(cust)
                      const typeSpec = classification.type
                      const rowStatus = resolveProfileRowStatus(cust)
                      const scorePct = isUnknown(cust, "sharpness")
                        ? 0
                        : Math.min(100, Math.max(4, Math.round((cust.score / 10) * 100)))
                      const typeMod = resolveBadgeModifier(typeSpec.id || typeSpec.shortLabel)
                      const heatmapOverlay = sharpnessHeatmapData.overlaysById.get(cust.id)
                      const isSharpHeatmapRow =
                        sharpnessHeatmapEnabled && Boolean(heatmapOverlay?.isSharp)

                      const actionClass = cust.action.includes("ALERT")
                        ? "action-alert"
                        : cust.action.includes("MONITOR") || cust.action.includes("THROTTLE")
                          ? "action-monitor"
                          : "action-accept"

                      return (
                        <tr
                          key={cust.id}
                          className={`sd-profile-row${isSelected ? " sd-profile-row--selected" : ""}${isSharpHeatmapRow ? " sd-profile-row--sharp" : ""}`}
                          data-status={rowStatus}
                          data-severity={rowStatus}
                          data-sharp-overlay={isSharpHeatmapRow ? "true" : undefined}
                          data-clv-leader={
                            isSharpHeatmapRow && heatmapOverlay?.isClvLeader ? "true" : undefined
                          }
                          data-sharp-heat={
                            isSharpHeatmapRow ? String(heatmapOverlay?.heatLevel ?? 1) : undefined
                          }
                          title={
                            isSharpHeatmapRow && heatmapOverlay
                              ? heatmapOverlay.summaryTitle
                              : undefined
                          }
                          style={styles.tr(isSelected)}
                          onClick={() => {
                            onSelectCustomer(cust)
                            onClearForensicResult()
                          }}
                        >
                          <td style={styles.td}>
                            <div style={styles.custCell}>
                              <span
                                style={{
                                  ...styles.custLink,
                                  cursor: "pointer",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onSelectCustomer(cust)
                                  onClearForensicResult()
                                }}
                              >
                                {cust.id}
                              </span>
                              <a
                                {...getFantasy402PortalLinkProps(cust.id)}
                                style={{
                                  color: "#94a3b8",
                                  textDecoration: "none",
                                  fontSize: "11px",
                                }}
                                onClick={(e) => e.stopPropagation()}
                                title="Open in active Fantasy402 Manager session tab"
                              >
                                ↗
                              </a>
                              {cust.source !== undefined && (
                                <span
                                  style={{
                                    ...styles.subBadge,
                                    backgroundColor: "rgba(56, 189, 248, 0.14)",
                                    color: "#7dd3fc",
                                  }}
                                  title={`Row source: ${cust.source}`}
                                >
                                  {cust.source.toUpperCase()}
                                </span>
                              )}
                              {cust.subAccountIndex !== null && (
                                <span style={styles.subBadge}>Seat #{cust.subAccountIndex}</span>
                              )}
                            </div>
                            <div style={styles.custAgent}>
                              Agent:{" "}
                              <a
                                href={getLocalAgentHref(cust.agentId)}
                                style={{
                                  color: "#38bdf8",
                                  textDecoration: "none",
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  if (onSelectAgent && !e.metaKey && !e.ctrlKey && e.button === 0) {
                                    e.preventDefault()
                                    onSelectAgent(cust.agentId)
                                  }
                                }}
                                title="Open SportsDesk Agent Inspector"
                              >
                                {cust.agentId} ↗
                              </a>
                            </div>
                            {isSharpHeatmapRow && heatmapOverlay && (
                              <div
                                className="sd-profile-row__sharp-overlay sd-tabular"
                                title={heatmapOverlay.summaryTitle}
                              >
                                {heatmapOverlay.isClvLeader && (
                                  <span className="sd-badge sd-badge--clv-leader">CLV-LEADER</span>
                                )}
                                {heatmapOverlay.rankLabel && (
                                  <span className="sd-sharp-overlay-chip">
                                    {heatmapOverlay.rankLabel}
                                  </span>
                                )}
                                {heatmapOverlay.clvSignalLabel && (
                                  <span className="sd-sharp-overlay-chip sd-sharp-overlay-chip--clv">
                                    {heatmapOverlay.clvSignalLabel}
                                  </span>
                                )}
                              </div>
                            )}
                            {classification.tags.length > 0 && (
                              <div className="sd-profile-row__badges">
                                {classification.tags.slice(0, 3).map((tag) => {
                                  const tagActive = activeProfileTagIds.includes(tag.id)
                                  const badgeMod = resolveBadgeModifier(tag.id || tag.label)
                                  return (
                                    <button
                                      key={tag.id}
                                      type="button"
                                      className={`sd-badge sd-badge--${badgeMod}${tagActive ? " sd-badge--selected" : ""}`}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        onToggleProfileTag?.(tag.id)
                                      }}
                                      title={`${tag.category}: ${tag.description} (click to filter)`}
                                    >
                                      {tag.label}
                                    </button>
                                  )
                                })}
                                {classification.tags.length > 3 && (
                                  <span
                                    className="sd-tabular"
                                    style={{
                                      fontSize: "9.5px",
                                      color: "#64748b",
                                      padding: "1px 3px",
                                    }}
                                  >
                                    +{classification.tags.length - 3}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={styles.td}>
                            <div className="sd-profile-row__score-cell">
                              <span
                                className={`sd-badge sd-badge--${typeMod}`}
                                title={typeSpec.description}
                              >
                                <span>{typeSpec.icon}</span>
                                <span>{typeSpec.shortLabel}</span>
                              </span>
                              <span
                                className={`sd-profile-row__score sd-profile-row__score--${rowStatus} sd-tabular`}
                                data-severity={rowStatus}
                              >
                                {isUnknown(cust, "sharpness") ? "—" : cust.score.toFixed(1)}
                              </span>
                              {showRowSparklines && !isUnknown(cust, "sharpness") && (
                                <ProfileScoreSparkline cust={cust} status={rowStatus} />
                              )}
                            </div>
                            <div
                              className="sd-risk-gauge"
                              data-severity={rowStatus}
                              title={`Sharpness heat ${isUnknown(cust, "sharpness") ? "unmeasured" : `${cust.score.toFixed(1)} / 10.0`}`}
                            >
                              <div
                                className={`sd-risk-gauge__fill sd-risk-gauge__fill--${rowStatus}`}
                                style={{ width: `${scorePct}%` }}
                              />
                            </div>
                            <div
                              style={{
                                fontSize: "10px",
                                color: "#94a3b8",
                                marginTop: "3px",
                              }}
                            >
                              {cust.tierLabel ?? cust.tier.replace("TIER_", "T")}
                            </div>
                          </td>
                          <td style={styles.td}>
                            <div>{cust.sizingStrategy}</div>
                            <div className="sd-tabular" style={styles.custSub}>
                              {isUnknown(cust, "gini")
                                ? "Gini: —"
                                : `Gini: ${cust.gini.toFixed(3)}`}
                            </div>
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              maxWidth: "168px",
                              whiteSpace: "normal",
                              overflowWrap: "anywhere",
                            }}
                          >
                            <div>{cust.specialization}</div>
                            <div style={styles.custSub}>{cust.timingArchetype}</div>
                          </td>
                          {showOpenRisk ? (
                            <td className="sd-tabular" style={styles.td}>
                              {(cust.openRiskUsd ?? 0) > 0
                                ? `$${cust.openRiskUsd!.toLocaleString()}`
                                : "—"}
                            </td>
                          ) : null}
                          <td style={styles.td}>
                            {isUnknown(cust, "correlation") ? (
                              <span style={{ color: "#64748b" }}>—</span>
                            ) : (
                              <span
                                className={
                                  cust.correlatedRisk.toUpperCase().includes("HIGH") ||
                                  cust.correlatedRisk.toUpperCase().includes("CRIT")
                                    ? "sd-badge sd-badge--parlay-critical"
                                    : undefined
                                }
                                style={
                                  cust.correlatedRisk.toUpperCase().includes("HIGH") ||
                                  cust.correlatedRisk.toUpperCase().includes("CRIT")
                                    ? undefined
                                    : styles.corrBadge(cust.correlatedRisk)
                                }
                              >
                                {cust.correlatedRisk}
                              </span>
                            )}
                          </td>
                          <td style={styles.td}>
                            <div className="sd-tabular" style={{ fontWeight: 600 }}>
                              {isUnknown(cust, "var95")
                                ? "—"
                                : `$${cust.var95Usd.toLocaleString()}`}
                            </div>
                            <div
                              className={`sd-tabular ${cust.holdPct < 0 ? "hold-neg" : "hold-pos"}`}
                              style={{ fontSize: "11px" }}
                            >
                              {isUnknown(cust, "holdPct") ? "Hold: —" : `Hold: ${cust.holdPct}%`}
                            </div>
                          </td>
                          <td className="directive" style={styles.td}>
                            <span className={`chip ${actionClass}`}>{cust.action}</span>
                            <div className="sd-tabular" style={styles.custSub}>
                              {isUnknown(cust, "limit")
                                ? "Cap: —"
                                : `Cap: $${cust.recommendedLimitUsd.toLocaleString()}`}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                    {sortedCustomers.length === 0 && (
                      <tr>
                        <td
                          colSpan={7}
                          style={{
                            padding: "24px 16px",
                            textAlign: "center",
                            color: "#94a3b8",
                            fontSize: "12px",
                          }}
                        >
                          No profiled bettors match current filters.{" "}
                          {hasActiveFilter && (
                            <button
                              type="button"
                              onClick={resetFilters}
                              style={{
                                marginLeft: "8px",
                                padding: "3px 10px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(56, 189, 248, 0.16)",
                                border: "1px solid rgba(56, 189, 248, 0.4)",
                                color: "#7dd3fc",
                                fontSize: "11px",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              Reset filters
                            </button>
                          )}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 12, padding: 12, alignItems: "center" }}>
                  <button disabled={page === 0} onClick={() => setProfilePage(page - 1)}>
                    Previous accounts
                  </button>
                  <span>
                    {sortedCustomers.length === 0 ? 0 : page * pageSize + 1}–
                    {Math.min((page + 1) * pageSize, sortedCustomers.length)} of{" "}
                    {sortedCustomers.length.toLocaleString()} matching accounts
                  </span>
                  <button
                    disabled={(page + 1) * pageSize >= sortedCustomers.length}
                    onClick={() => setProfilePage(page + 1)}
                  >
                    Next accounts
                  </button>
                </div>
              </div>
            </div>

            {/* Right Column: Structured Profile Drilldown Inspector (.sd-profile-detail) */}
            <div
              className="detail-panel sd-profile-detail"
              style={styles.inspectorPanel}
              data-profile-drilldown="true"
              data-type="profile-detail"
            >
              {selectedCustomer?.source === "book" &&
              selectedCustomer.unknown?.includes("sharpness") &&
              selectedCustomer.unknown?.includes("holdPct") ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  {/* Identity-Only Header with Stepper & Agent Conduit Link */}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                      gap: "10px",
                      paddingBottom: "12px",
                      borderBottom: "1px solid #1e293b",
                    }}
                  >
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <h2 style={styles.inspectorTitle}>{selectedCustomer.id}</h2>
                        {selectedIndex >= 0 && (
                          <span className="sd-drilldown-rank">
                            #{selectedIndex + 1} / {sortedCustomers.length}
                          </span>
                        )}
                        <span
                          style={{
                            fontSize: "10px",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            backgroundColor: "rgba(148, 163, 184, 0.14)",
                            color: "#94a3b8",
                            fontWeight: 600,
                          }}
                        >
                          ROSTER IDENTITY ONLY
                        </span>
                      </div>
                      <div style={styles.inspectorSub}>
                        Login: <b>{selectedCustomer.name}</b> · Agent:{" "}
                        {onSelectAgent ? (
                          <button
                            type="button"
                            onClick={() => onSelectAgent(selectedCustomer.agentId)}
                            className="sd-drilldown-inline-link"
                          >
                            {selectedCustomer.agentId}
                          </button>
                        ) : (
                          <b>{selectedCustomer.agentId}</b>
                        )}
                      </div>
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
                        disabled={!canStepPrev}
                        onClick={() => stepCustomer(-1)}
                        className="sd-drilldown-step-btn"
                        title="Previous customer in current sort order"
                      >
                        <ChevronLeft size={13} aria-hidden="true" />
                        <span>Prev</span>
                      </button>
                      <button
                        type="button"
                        disabled={!canStepNext}
                        onClick={() => stepCustomer(1)}
                        className="sd-drilldown-step-btn"
                        title="Next customer in current sort order"
                      >
                        <span>Next</span>
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                      {onViewCustomerWagers && (
                        <button
                          type="button"
                          style={{ ...styles.actionBtn, padding: "4px 9px", fontSize: "11px" }}
                          onClick={() => onViewCustomerWagers(selectedCustomer.id)}
                        >
                          ⚡ Wager Tape
                        </button>
                      )}
                    </div>
                  </div>

                  <div
                    style={{
                      padding: "12px 14px",
                      borderRadius: "6px",
                      backgroundColor: "rgba(15, 23, 42, 0.65)",
                      border: "1px solid #1e293b",
                      fontSize: "12px",
                      color: "#94a3b8",
                      lineHeight: 1.5,
                    }}
                  >
                    Observed in the projected live manager roster. This source provides account
                    identity and assigned agent only. Sharpness, CLV, limits, balance, hold,
                    lifetime value, sizing, and risk classification are unmeasured; no trading
                    directive is inferred.
                  </div>

                  {selectedLiveActivity && selectedLiveActivity.ticketCount > 0 ? (
                    <div
                      style={{
                        padding: "12px 14px",
                        borderRadius: "6px",
                        backgroundColor: "rgba(14, 165, 233, 0.08)",
                        border: "1px solid rgba(56, 189, 248, 0.3)",
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
                          fontSize: "12px",
                        }}
                      >
                        <strong style={{ color: "#e0f2fe" }}>
                          Live Open Tape ({selectedLiveActivity.ticketCount} ticket
                          {selectedLiveActivity.ticketCount === 1 ? "" : "s"})
                        </strong>
                        <span
                          style={{
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontVariantNumeric: "tabular-nums",
                            color: "#38bdf8",
                            fontWeight: 700,
                          }}
                        >
                          ${selectedLiveActivity.totalRiskUsd.toLocaleString()} risk
                        </span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                        {selectedLiveActivity.tickets.slice(0, 5).map((ticket) => (
                          <button
                            key={ticket.ticketId}
                            type="button"
                            onClick={() =>
                              onSelectWager
                                ? onSelectWager(ticket)
                                : onViewCustomerWagers?.(selectedCustomer.id)
                            }
                            className="sd-drilldown-ticket-row"
                          >
                            <span style={{ fontWeight: 600, color: "#e2e8f0" }}>
                              {ticket.sport} · {ticket.selection || ticket.event}
                            </span>
                            <span
                              style={{
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                fontVariantNumeric: "tabular-nums",
                                color: "#38bdf8",
                                whiteSpace: "nowrap",
                              }}
                            >
                              ${ticket.riskUsd.toLocaleString()}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {selectedCustomer.retainedHistory ? (
                    <RetainedHistorySummary history={selectedCustomer.retainedHistory} />
                  ) : (
                    <div
                      style={{
                        fontSize: "12px",
                        color: "#64748b",
                        padding: "10px 12px",
                        borderRadius: "6px",
                        border: "1px dashed #1e293b",
                      }}
                    >
                      No unambiguous retained wager-history match is available for this account.
                    </div>
                  )}
                </div>
              ) : selectedCustomer ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  {/* 1. Sticky Drilldown Identity, Evidence Chips & Action Toolbar */}
                  <div className="sd-profile-detail__header">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "flex-start",
                        flexWrap: "wrap",
                        gap: "10px",
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "8px",
                          }}
                        >
                          <h2 style={styles.inspectorTitle}>{selectedCustomer.id}</h2>
                          {selectedIndex >= 0 && (
                            <span className="sd-drilldown-rank sd-tabular">
                              #{selectedIndex + 1} / {sortedCustomers.length}
                            </span>
                          )}
                          {selectedClassification ? (
                            <span
                              className={`sd-badge sd-badge--${resolveBadgeModifier(selectedClassification.type.id || selectedClassification.type.shortLabel)}`}
                              title={selectedClassification.type.description}
                            >
                              <span>{selectedClassification.type.icon}</span>
                              <span>{selectedClassification.type.label}</span>
                            </span>
                          ) : (
                            <span style={styles.tierBadge(selectedCustomer.tier)}>
                              {selectedCustomer.tierLabel ?? selectedCustomer.tier}
                            </span>
                          )}
                          {selectedCustomer.source ? (
                            <span
                              style={{
                                fontSize: "10px",
                                padding: "2px 6px",
                                borderRadius: "4px",
                                backgroundColor: "rgba(148, 163, 184, 0.12)",
                                color: "#94a3b8",
                              }}
                            >
                              {selectedCustomer.source}
                            </span>
                          ) : null}
                        </div>
                        <div style={styles.inspectorSub}>
                          {selectedCustomer.name} · Agent:{" "}
                          {onSelectAgent ? (
                            <button
                              type="button"
                              onClick={() => onSelectAgent(selectedCustomer.agentId)}
                              className="sd-drilldown-inline-link"
                              title={`Inspect Agent Conduit ${selectedCustomer.agentId}`}
                            >
                              {selectedCustomer.agentId}
                            </button>
                          ) : (
                            <b>{selectedCustomer.agentId}</b>
                          )}{" "}
                          (Master: <b>{selectedCustomer.masterAgent}</b>)
                        </div>
                        {(selectedCustomer.forensicDossier || selectedOnChainXref) && (
                          <div className="sd-evidence-strip" data-forensic-header-summary="true">
                            {selectedCustomer.forensicDossier?.parlayBacktest?.rank !== null &&
                              selectedCustomer.forensicDossier?.parlayBacktest?.rank !==
                                undefined && (
                                <span className="sd-badge sd-badge--parlay-critical sd-tabular">
                                  Backtest #{selectedCustomer.forensicDossier.parlayBacktest.rank}
                                </span>
                              )}
                            {selectedCustomer.forensicDossier?.parlayBacktest?.deskSavingsUsd ? (
                              <span className="sd-badge sd-badge--clv-leader sd-tabular">
                                +$
                                {Math.round(
                                  selectedCustomer.forensicDossier.parlayBacktest.deskSavingsUsd,
                                ).toLocaleString()}{" "}
                                savings
                              </span>
                            ) : null}
                            {selectedCustomer.forensicDossier?.beardBridge && (
                              <span className="sd-badge sd-badge--syndicate-link">
                                {selectedCustomer.forensicDossier.beardBridge.crossOfficeTwins
                                  .length > 0
                                  ? `Bridge: ${selectedCustomer.forensicDossier.beardBridge.crossOfficeTwins.map((t) => t.loginId).join(", ")}`
                                  : selectedCustomer.forensicDossier.beardBridge
                                      .matchClassification}
                              </span>
                            )}
                            {selectedOnChainXref && (
                              <button
                                type="button"
                                onClick={() => setDrilldownTab("reconciliation")}
                                className={`sd-badge ${
                                  selectedOnChainXref.status === "DIVERGENCE_ALERT"
                                    ? "sd-badge--alert-operator"
                                    : "sd-badge--sharp"
                                } sd-tabular`}
                                data-onchain-xref-header="true"
                                title="Open On-Chain Wager Tracking Cross-Reference checks"
                              >
                                On-Chain {selectedOnChainXref.statusLabel} ·{" "}
                                {selectedOnChainXref.checksPassed}/{selectedOnChainXref.checksTotal}
                                {selectedOnChainXref.shortWallet
                                  ? ` · ${selectedOnChainXref.shortWallet}`
                                  : ""}
                              </button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Stepper Controls */}
                      <div style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
                        <button
                          type="button"
                          disabled={!canStepPrev}
                          onClick={() => stepCustomer(-1)}
                          className="sd-drilldown-step-btn"
                          title="Previous customer in current sort order"
                        >
                          <ChevronLeft size={13} aria-hidden="true" />
                          <span>Prev</span>
                        </button>
                        <button
                          type="button"
                          disabled={!canStepNext}
                          onClick={() => stepCustomer(1)}
                          className="sd-drilldown-step-btn"
                          title="Next customer in current sort order"
                        >
                          <span>Next</span>
                          <ChevronRight size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </div>

                    {/* Action Toolbar (.sd-action-bar) */}
                    <div className="sd-action-bar" role="toolbar" aria-label="Profile actions">
                      {onViewCustomerWagers && (
                        <button
                          type="button"
                          className="sd-action-btn sd-action-btn--primary"
                          onClick={() => onViewCustomerWagers(selectedCustomer.id)}
                          title="Filter Live Wagers tape to this customer"
                        >
                          <span>⚡ Wager Tape</span>
                          {selectedLiveActivity && selectedLiveActivity.ticketCount > 0 ? (
                            <span className="sd-tabular">({selectedLiveActivity.ticketCount})</span>
                          ) : null}
                        </button>
                      )}
                      <button
                        type="button"
                        className="sd-action-btn"
                        onClick={() => onOpenTerminalProfile(selectedCustomer.id)}
                        title="Inspect this customer in Bun.Terminal emulator"
                      >
                        💻 Terminal
                      </button>
                      {onOpenTerminalRadar ? (
                        <button
                          type="button"
                          className="sd-action-btn"
                          onClick={() => onOpenTerminalRadar(selectedCustomer.id)}
                          title="Run profile <id> --radar in Bun.Terminal"
                        >
                          📊 Radar
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="sd-action-btn"
                        onClick={() => onCopyCli(selectedCustomer.id)}
                        title="Copy terminal CLI command to clipboard"
                      >
                        {copiedCliId === selectedCustomer.id ? "✓ Copied CLI" : "📋 Copy CLI"}
                      </button>
                      <a
                        {...getFantasy402PortalLinkProps(selectedCustomer.id)}
                        className="sd-action-btn"
                        title="Open in active Fantasy402 Manager session tab (reuses logged-in portal tab)"
                      >
                        Portal ↗
                      </a>
                    </div>
                  </div>

                  {/* Elevated Divergence / Cross-Office Bridge Alert */}
                  {(selectedOnChainXref?.status === "DIVERGENCE_ALERT" ||
                    (selectedCustomer.forensicDossier?.beardBridge?.crossOfficeTwins.length ?? 0) >
                      0) && (
                    <div
                      className="sd-profile-detail__alert--divergence sd-alert-banner sd-alert-banner--divergence"
                      data-alert="divergence"
                      data-severity="critical"
                      data-status="critical"
                      role="alert"
                    >
                      <div className="sd-alert-banner__body">
                        <AlertTriangle
                          size={15}
                          className="sd-alert-banner__icon"
                          aria-hidden="true"
                        />
                        <div className="sd-alert-banner__stack">
                          <div className="sd-alert-banner__title">
                            DIVERGENCE ALERT — ELEVATED FORENSIC SIGNAL
                          </div>
                          <div className="sd-alert-banner__evidence sd-tabular">
                            {selectedOnChainXref?.status === "DIVERGENCE_ALERT" && (
                              <span>
                                On-Chain Xref: {selectedOnChainXref.checksPassed}/
                                {selectedOnChainXref.checksTotal} checks
                                {selectedOnChainXref.shortWallet
                                  ? ` · Wallet ${selectedOnChainXref.shortWallet}`
                                  : ""}
                                {selectedOnChainXref.sharedWithCustomerIds.length > 0
                                  ? ` · Shared w/ ${selectedOnChainXref.sharedWithCustomerIds.join(", ")}`
                                  : ""}
                              </span>
                            )}
                            {(selectedCustomer.forensicDossier?.beardBridge?.crossOfficeTwins
                              .length ?? 0) > 0 && (
                              <span>
                                Cross-Office Bridge Twins:{" "}
                                {selectedCustomer
                                  .forensicDossier!.beardBridge!.crossOfficeTwins.map(
                                    (t) => `${t.loginId} (${t.officeAgentId})`,
                                  )
                                  .join(", ")}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="sd-alert-banner__actions">
                        <button
                          type="button"
                          className="sd-action-btn sd-action-btn--critical"
                          onClick={() => setDrilldownTab("reconciliation")}
                        >
                          Inspect Evidence ↗
                        </button>
                      </div>
                    </div>
                  )}

                  {/* 2. Executive Tabular KPI Strip (4 compact single-elevation cells) */}
                  <div className="sd-drilldown-kpi-strip">
                    <div className="sd-drilldown-kpi-cell">
                      <span className="sd-drilldown-kpi-label">Sharp Score</span>
                      <span
                        className="sd-drilldown-kpi-val sd-tabular"
                        style={{
                          color:
                            selectedCustomer.score >= 7.5
                              ? "#f87171"
                              : selectedCustomer.score >= 5.5
                                ? "#fbbf24"
                                : "#38bdf8",
                        }}
                      >
                        {selectedCustomer.score.toFixed(1)}
                        <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 500 }}>
                          /10
                        </span>
                      </span>
                      <div
                        className="sd-risk-gauge"
                        data-severity={resolveProfileRowStatus(selectedCustomer)}
                      >
                        <div
                          className={`sd-risk-gauge__fill sd-risk-gauge__fill--${resolveProfileRowStatus(selectedCustomer)}`}
                          style={{
                            width: `${Math.min(100, Math.max(4, Math.round((selectedCustomer.score / 10) * 100)))}%`,
                          }}
                        />
                      </div>
                      <span className="sd-drilldown-kpi-sub">
                        {selectedCustomer.timingArchetype}
                      </span>
                    </div>

                    <div className="sd-drilldown-kpi-cell">
                      <span className="sd-drilldown-kpi-label">7d 95% VaR</span>
                      <span
                        className="sd-drilldown-kpi-val sd-tabular"
                        style={{
                          color: selectedRiskHeadroom?.isVarOverCap ? "#f87171" : "#f1f5f9",
                        }}
                      >
                        {selectedRiskHeadroom?.hasMeasuredVar
                          ? `$${selectedCustomer.var95Usd.toLocaleString()}`
                          : "—"}
                      </span>
                      <span
                        className="sd-drilldown-kpi-sub sd-tabular"
                        style={{
                          color: selectedRiskHeadroom?.isVarOverCap ? "#fca5a5" : "#94a3b8",
                        }}
                      >
                        {selectedRiskHeadroom?.varToCapPct !== null &&
                        selectedRiskHeadroom?.varToCapPct !== undefined
                          ? `${selectedRiskHeadroom.varToCapPct}% of cap`
                          : "Cap unmeasured"}
                      </span>
                    </div>

                    <div className="sd-drilldown-kpi-cell">
                      <span className="sd-drilldown-kpi-label">Lifetime Hold</span>
                      <span
                        className="sd-drilldown-kpi-val sd-tabular"
                        style={{
                          color: !selectedRiskHeadroom?.hasMeasuredHold
                            ? "#94a3b8"
                            : selectedCustomer.holdPct < 0
                              ? "#f87171"
                              : "#4ade80",
                        }}
                      >
                        {selectedRiskHeadroom?.hasMeasuredHold
                          ? `${selectedCustomer.holdPct}%`
                          : "—"}
                      </span>
                      <span className="sd-drilldown-kpi-sub sd-tabular">
                        {selectedRiskHeadroom?.hasMeasuredLtv
                          ? `$${Math.abs(selectedCustomer.ltvUsd).toLocaleString()} ${selectedCustomer.ltvUsd < 0 ? "Loss" : "Hold"}`
                          : "LTV unmeasured"}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => setDrilldownTab("activity")}
                      className="sd-drilldown-kpi-cell sd-drilldown-kpi-cell--interactive"
                      title="Inspect live open wagers for this customer"
                    >
                      <span className="sd-drilldown-kpi-label">Live Open Tape</span>
                      <span
                        className="sd-drilldown-kpi-val sd-tabular"
                        style={{
                          color:
                            (selectedLiveActivity?.criticalCount ?? 0) > 0
                              ? "#f87171"
                              : (selectedLiveActivity?.ticketCount ?? 0) > 0
                                ? "#38bdf8"
                                : "#94a3b8",
                        }}
                      >
                        ${(selectedLiveActivity?.totalRiskUsd ?? 0).toLocaleString()}
                      </span>
                      <span className="sd-drilldown-kpi-sub sd-tabular">
                        {selectedLiveActivity?.ticketCount ?? 0} ticket
                        {selectedLiveActivity?.ticketCount === 1 ? "" : "s"}
                        {(selectedLiveActivity?.criticalCount ?? 0) > 0
                          ? ` · ${selectedLiveActivity?.criticalCount} crit`
                          : ""}
                      </span>
                    </button>
                  </div>

                  {/* 3. Trading Directive Summary Strip (always visible above tabs) */}
                  <div className="sd-drilldown-directive-bar">
                    <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <ShieldAlert size={13} color="#38bdf8" aria-hidden="true" />
                      <span style={{ fontSize: "11px", color: "#94a3b8", fontWeight: 600 }}>
                        Directive:
                      </span>
                      <span style={styles.actionBadge(selectedCustomer.action)}>
                        {selectedCustomer.action}
                      </span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: "12px",
                        fontSize: "11px",
                        color: "#cbd5e1",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      <span>
                        Cap:{" "}
                        <b>
                          {isUnknown(selectedCustomer, "limit")
                            ? "—"
                            : `$${selectedCustomer.recommendedLimitUsd.toLocaleString()}`}
                        </b>
                      </span>
                      <span>
                        Delay:{" "}
                        <b>
                          {isUnknown(selectedCustomer, "delay")
                            ? "—"
                            : `${selectedCustomer.inPlayDelaySec}s`}
                        </b>
                      </span>
                      <span>
                        Shade: <b>{selectedCustomer.lineShadeCents}¢</b>
                      </span>
                      <span>
                        Shadow: <b>{selectedCustomer.shadowCopyMultiplier.toFixed(2)}x</b>
                      </span>
                    </div>
                  </div>

                  {/* 4. Segmented Drilldown Navigation Tabs */}
                  <div
                    role="tablist"
                    aria-label="Customer profile drilldown sections"
                    className="sd-drilldown-tabs"
                  >
                    {(
                      [
                        { id: "overview", label: "Overview & Risk" },
                        {
                          id: "formulas",
                          label:
                            selectedQuantModel && selectedQuantModel.exposure.policyGapCount > 0
                              ? `Formulas & Sim (${selectedQuantModel.exposure.policyGapCount})`
                              : "Formulas & Sim",
                        },
                        {
                          id: "activity",
                          label: `Live Activity (${(selectedLiveActivity?.ticketCount ?? 0) + (selectedCustomer.forensicDossier?.flaggedTickets.length ?? 0)})`,
                        },
                        {
                          id: "reconciliation",
                          label: selectedCustomer.forensicDossier?.beardBridge
                            ? "Forensics & Bridge"
                            : selectedOnChainXref
                              ? "Forensics & On-Chain"
                              : selectedCustomer.portalReconciliation
                                ? "Reconciliation & IP"
                                : "Forensics & IP",
                        },
                        {
                          id: "tags",
                          label: `Tags (${selectedClassification?.tags.length ?? 0})`,
                        },
                      ] as const
                    ).map((tab) => {
                      const active = drilldownTab === tab.id
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          data-drilldown-tab={tab.id}
                          onClick={() => setDrilldownTab(tab.id)}
                          className={`sd-drilldown-tab-btn${active ? " sd-drilldown-tab-btn--active" : ""}`}
                        >
                          {tab.label}
                        </button>
                      )
                    })}
                  </div>

                  {/* TAB 1: Overview & Sharpness */}
                  {drilldownTab === "overview" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {selectedCustomer.forensicDossier && (
                        <ForensicBridgeSummaryCallout
                          dossier={selectedCustomer.forensicDossier}
                          onOpenForensicsTab={() => setDrilldownTab("reconciliation")}
                          onJumpToCustomer={onSelectCustomerById}
                        />
                      )}

                      {selectedQuantModel && selectedClassification && (
                        <OverviewFormulaAuditStrip
                          customer={selectedCustomer}
                          model={selectedQuantModel}
                          typeSpec={selectedClassification.type}
                          onNavigateTab={(nextTab) => setDrilldownTab(nextTab)}
                        />
                      )}

                      {/* Compact Activity Timeline Strip */}
                      <div className="sd-activity-timeline" data-type="activity-timeline">
                        <div className="sd-activity-timeline__header">
                          <span className="sd-activity-timeline__title">
                            Recent Activity Timeline
                          </span>
                          <button
                            type="button"
                            className="sd-drilldown-inline-link sd-tabular"
                            onClick={() => setDrilldownTab("activity")}
                          >
                            {selectedLiveActivity && selectedLiveActivity.ticketCount > 0
                              ? `All ${selectedLiveActivity.ticketCount} live tickets ↗`
                              : "Activity tab ↗"}
                          </button>
                        </div>
                        {selectedLiveActivity && selectedLiveActivity.tickets.length > 0 ? (
                          <div className="sd-activity-timeline__list">
                            {selectedLiveActivity.tickets.slice(0, 4).map((ticket) => {
                              const isWhale = ticket.riskUsd >= 2500
                              const isSharp =
                                ticket.alertTier === "CRITICAL" ||
                                ticket.alertTier === "STEAM" ||
                                (typeof ticket.clvCents === "number" && ticket.clvCents > 0)
                              return (
                                <button
                                  key={ticket.ticketId}
                                  type="button"
                                  className="sd-activity-timeline__row"
                                  onClick={() =>
                                    onSelectWager
                                      ? onSelectWager(ticket)
                                      : onViewCustomerWagers?.(selectedCustomer.id)
                                  }
                                >
                                  <span className="sd-activity-timeline__time sd-tabular">
                                    {ticket.timestamp ? ticket.timestamp.slice(11, 19) : "LIVE"}
                                  </span>
                                  <span className="sd-activity-timeline__market">
                                    <strong>{ticket.sport}</strong> ·{" "}
                                    {ticket.selection || ticket.event}
                                  </span>
                                  <span className="sd-activity-timeline__flags">
                                    {isWhale && (
                                      <span className="sd-badge sd-badge--whale">WHALE</span>
                                    )}
                                    {isSharp && (
                                      <span className="sd-badge sd-badge--sharp">SHARP</span>
                                    )}
                                  </span>
                                  <span className="sd-activity-timeline__amount sd-tabular">
                                    ${Math.round(ticket.riskUsd).toLocaleString()}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        ) : (
                          <div className="sd-activity-timeline__empty sd-tabular">
                            No open live tickets in current window · Last backtest sample:{" "}
                            {selectedCustomer.timingArchetype} ({selectedCustomer.specialization})
                          </div>
                        )}
                      </div>

                      {/* Decomposed Sharpness Radar */}
                      <div style={{ ...styles.radarCard, marginBottom: 0 }}>
                        <h4 style={styles.cardHeader}>Decomposed Sharpness Signals</h4>
                        <SharpnessDecomposition
                          score={selectedCustomer.score}
                          components={RADAR_AXES.map((axis) => ({
                            key: axis.valueKey,
                            label: axis.label,
                            value: selectedCustomer[axis.valueKey],
                            cap: axis.max,
                          }))}
                        />
                      </div>

                      {selectedCustomer.forensicDossier?.parlayBacktest && (
                        <ParlayProtectionImpactPanel
                          metrics={selectedCustomer.forensicDossier.parlayBacktest}
                        />
                      )}

                      {/* Clean 2-Column Tabular Metrics */}
                      <div style={{ ...styles.detailGrid, marginBottom: 0 }}>
                        <div style={styles.detailCard}>
                          <h4 style={styles.cardHeader}>Stake Sizing &amp; Variance</h4>
                          <div className="sd-drilldown-kv-list">
                            <div className="sd-drilldown-kv-row">
                              <span>Sizing Strategy</span>
                              <b>
                                {isUnknown(selectedCustomer, "sizing")
                                  ? "—"
                                  : selectedCustomer.sizingStrategy}
                              </b>
                            </div>
                            <div className="sd-drilldown-kv-row">
                              <span>Gini Inequality</span>
                              <b>
                                {isUnknown(selectedCustomer, "gini") ? "—" : selectedCustomer.gini}
                              </b>
                            </div>
                            <div className="sd-drilldown-kv-row">
                              <span>Mean Stake</span>
                              <b>
                                {isUnknown(selectedCustomer, "meanStake")
                                  ? "—"
                                  : `$${selectedCustomer.meanStake.toLocaleString()}`}
                              </b>
                            </div>
                            <div className="sd-drilldown-kv-row">
                              <span>Expected Shortfall (CVaR)</span>
                              <b>
                                {isUnknown(selectedCustomer, "var95")
                                  ? "—"
                                  : `$${selectedCustomer.cvar95Usd.toLocaleString()}`}
                              </b>
                            </div>
                          </div>
                        </div>

                        <div style={styles.detailCard}>
                          <h4 style={styles.cardHeader}>Correlation &amp; Syndicate Signals</h4>
                          <div className="sd-drilldown-kv-list">
                            <div className="sd-drilldown-kv-row">
                              <span>Correlated Parlay Risk</span>
                              <span style={styles.corrBadge(selectedCustomer.correlatedRisk)}>
                                {selectedCustomer.correlatedRisk}
                              </span>
                            </div>
                            <div className="sd-drilldown-kv-row">
                              <span>Exploit Rate</span>
                              <b>{(selectedCustomer.correlatedExploitRate * 100).toFixed(0)}%</b>
                            </div>
                            <div className="sd-drilldown-kv-row">
                              <span>Timing Archetype</span>
                              <b>{selectedCustomer.timingArchetype}</b>
                            </div>
                            <div className="sd-drilldown-kv-row">
                              <span>Downline Syndicate Prob</span>
                              <b
                                style={{
                                  color:
                                    selectedCustomer.syndicateProb >= 0.6
                                      ? "#f87171"
                                      : selectedCustomer.syndicateProb >= 0.35
                                        ? "#fbbf24"
                                        : "#cbd5e1",
                                }}
                              >
                                {(selectedCustomer.syndicateProb * 100).toFixed(0)}%
                              </b>
                            </div>
                          </div>
                        </div>
                      </div>

                      {selectedCustomer.retainedHistory ? (
                        <div style={styles.detailCard}>
                          <RetainedHistorySummary history={selectedCustomer.retainedHistory} />
                        </div>
                      ) : null}
                    </div>
                  )}

                  {/* TAB 2: Quantitative Formulas, Policy Gaps & Countermeasure Simulator */}
                  {drilldownTab === "formulas" && selectedQuantModel && selectedClassification && (
                    <ProfileFormulaDrilldownPanel
                      customer={selectedCustomer}
                      model={selectedQuantModel}
                      typeSpec={selectedClassification.type}
                      onSelectCustomerById={onSelectCustomerById}
                      onRunTerminalCommand={onRunTerminalCommand}
                    />
                  )}

                  {/* TAB 3: Live Activity & Exposure Breakdown */}
                  {drilldownTab === "activity" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {selectedLiveActivity && selectedLiveActivity.ticketCount > 0 ? (
                        <>
                          <div className="sd-drilldown-kpi-strip">
                            <div className="sd-drilldown-kpi-cell">
                              <span className="sd-drilldown-kpi-label">Open Risk</span>
                              <span className="sd-drilldown-kpi-val" style={{ color: "#38bdf8" }}>
                                ${selectedLiveActivity.totalRiskUsd.toLocaleString()}
                              </span>
                              <span className="sd-drilldown-kpi-sub">
                                Max ticket $
                                {selectedLiveActivity.maxSingleStakeUsd.toLocaleString()}
                              </span>
                            </div>
                            <div className="sd-drilldown-kpi-cell">
                              <span className="sd-drilldown-kpi-label">To Win Liability</span>
                              <span className="sd-drilldown-kpi-val" style={{ color: "#fbbf24" }}>
                                ${selectedLiveActivity.totalToWinUsd.toLocaleString()}
                              </span>
                              <span className="sd-drilldown-kpi-sub">
                                {selectedLiveActivity.liveInPlayCount} in-play
                              </span>
                            </div>
                            <div className="sd-drilldown-kpi-cell">
                              <span className="sd-drilldown-kpi-label">Critical / Steam</span>
                              <span
                                className="sd-drilldown-kpi-val"
                                style={{
                                  color:
                                    selectedLiveActivity.criticalCount > 0 ? "#f87171" : "#4ade80",
                                }}
                              >
                                {selectedLiveActivity.criticalCount}
                              </span>
                              <span className="sd-drilldown-kpi-sub">
                                of {selectedLiveActivity.ticketCount} open
                              </span>
                            </div>
                            <div className="sd-drilldown-kpi-cell">
                              <span className="sd-drilldown-kpi-label">Avg Live CLV</span>
                              <span
                                className="sd-drilldown-kpi-val"
                                style={{
                                  color:
                                    selectedLiveActivity.avgClvCents === null
                                      ? "#94a3b8"
                                      : selectedLiveActivity.avgClvCents > 0
                                        ? "#f87171"
                                        : "#4ade80",
                                }}
                              >
                                {selectedLiveActivity.avgClvCents !== null
                                  ? `${selectedLiveActivity.avgClvCents >= 0 ? "+" : ""}${selectedLiveActivity.avgClvCents.toFixed(1)}¢`
                                  : "—"}
                              </span>
                              <span className="sd-drilldown-kpi-sub">
                                {selectedLiveActivity.channelBreakdown
                                  .slice(0, 2)
                                  .map((c) => c.channel)
                                  .join(", ") || "—"}
                              </span>
                            </div>
                          </div>

                          {/* Live vs Historical Stake Context */}
                          {!isUnknown(selectedCustomer, "meanStake") &&
                            selectedCustomer.meanStake > 0 &&
                            selectedLiveActivity.avgRiskUsd > 0 && (
                              <div className="sd-policy-matrix-meta sd-tabular">
                                <span>
                                  Live Avg Stake:{" "}
                                  <strong>
                                    ${selectedLiveActivity.avgRiskUsd.toLocaleString()}
                                  </strong>
                                </span>
                                <span>·</span>
                                <span>
                                  vs Hist Mean:{" "}
                                  <strong
                                    style={{
                                      color:
                                        selectedLiveActivity.avgRiskUsd /
                                          selectedCustomer.meanStake >=
                                        1.5
                                          ? "#f87171"
                                          : "#7dd3fc",
                                    }}
                                  >
                                    {(
                                      selectedLiveActivity.avgRiskUsd / selectedCustomer.meanStake
                                    ).toFixed(2)}
                                    ×
                                  </strong>
                                </span>
                                {selectedLiveActivity.avgToWinRatio !== null && (
                                  <>
                                    <span>·</span>
                                    <span>
                                      To-Win / Risk:{" "}
                                      <strong>
                                        {selectedLiveActivity.avgToWinRatio.toFixed(2)}×
                                      </strong>
                                    </span>
                                  </>
                                )}
                              </div>
                            )}

                          {/* Sport & Channel Exposure Breakdowns (Interactive Sport Filter) */}
                          {selectedLiveActivity.sportBreakdown.length > 0 && (
                            <div style={styles.detailCard}>
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  marginBottom: "8px",
                                }}
                              >
                                <h4 style={{ ...styles.cardHeader, margin: 0 }}>
                                  Sport Exposure Mix (Click to Filter Tickets)
                                </h4>
                                {activitySportFilter !== "ALL" && (
                                  <button
                                    type="button"
                                    className="sd-drilldown-inline-link"
                                    onClick={() => setActivitySportFilter("ALL")}
                                  >
                                    Clear {activitySportFilter} filter
                                  </button>
                                )}
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                                {selectedLiveActivity.sportBreakdown.slice(0, 6).map((row) => {
                                  const isSportActive = activitySportFilter === row.sport
                                  return (
                                    <button
                                      key={row.sport}
                                      type="button"
                                      onClick={() =>
                                        setActivitySportFilter(isSportActive ? "ALL" : row.sport)
                                      }
                                      className={`sd-activity-sport-btn${isSportActive ? " sd-activity-sport-btn--active" : ""}`}
                                    >
                                      <div
                                        style={{
                                          display: "flex",
                                          justifyContent: "space-between",
                                          color: "#cbd5e1",
                                          width: "100%",
                                        }}
                                      >
                                        <span>
                                          <b>{row.sport}</b> · {row.ticketCount} ticket
                                          {row.ticketCount === 1 ? "" : "s"}
                                          {row.criticalCount > 0 ? (
                                            <span style={{ color: "#f87171", marginLeft: "6px" }}>
                                              ({row.criticalCount} crit)
                                            </span>
                                          ) : null}
                                          {row.avgClvCents !== null ? (
                                            <span style={{ color: "#94a3b8", marginLeft: "6px" }}>
                                              CLV {row.avgClvCents >= 0 ? "+" : ""}
                                              {row.avgClvCents.toFixed(1)}¢
                                            </span>
                                          ) : null}
                                        </span>
                                        <span className="sd-tabular">
                                          ${row.riskUsd.toLocaleString()} ({row.sharePct.toFixed(0)}
                                          %)
                                        </span>
                                      </div>
                                      <div
                                        style={{
                                          height: "5px",
                                          borderRadius: "3px",
                                          backgroundColor: "#0f172a",
                                          overflow: "hidden",
                                          width: "100%",
                                        }}
                                      >
                                        <div
                                          style={{
                                            width: `${Math.max(4, Math.min(100, row.sharePct))}%`,
                                            height: "100%",
                                            backgroundColor:
                                              row.criticalCount > 0 ? "#ef4444" : "#38bdf8",
                                          }}
                                        />
                                      </div>
                                    </button>
                                  )
                                })}
                              </div>
                            </div>
                          )}

                          {selectedLiveActivity.channelBreakdown.length > 0 && (
                            <div style={styles.detailCard}>
                              <h4 style={styles.cardHeader}>Submission Channel Mix</h4>
                              <div className="sd-policy-matrix-meta sd-tabular">
                                {selectedLiveActivity.channelBreakdown.map((ch) => (
                                  <span key={ch.channel}>
                                    <strong>{ch.channel}</strong>: ${ch.riskUsd.toLocaleString()} (
                                    {ch.ticketCount} · {ch.sharePct.toFixed(0)}%)
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Recent Live Tickets List */}
                          <div style={styles.detailCard}>
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                marginBottom: "8px",
                              }}
                            >
                              <h4 style={{ ...styles.cardHeader, margin: 0 }}>
                                Open Wagers (
                                {activitySportFilter === "ALL"
                                  ? selectedLiveActivity.ticketCount
                                  : selectedLiveActivity.tickets.filter(
                                      (t) =>
                                        (t.sport || "OTHER").trim().toUpperCase() ===
                                        activitySportFilter,
                                    ).length}
                                {activitySportFilter !== "ALL" ? ` · ${activitySportFilter}` : ""})
                              </h4>
                              {onViewCustomerWagers && (
                                <button
                                  type="button"
                                  onClick={() => onViewCustomerWagers(selectedCustomer.id)}
                                  className="sd-drilldown-inline-link"
                                  style={{ fontSize: "11px" }}
                                >
                                  Filter Full Tape <ArrowUpRight size={11} aria-hidden="true" />
                                </button>
                              )}
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                              {selectedLiveActivity.tickets
                                .filter(
                                  (w) =>
                                    activitySportFilter === "ALL" ||
                                    (w.sport || "OTHER").trim().toUpperCase() ===
                                      activitySportFilter,
                                )
                                .slice(0, 10)
                                .map((wager) => {
                                  const isCrit =
                                    wager.alertTier === "CRITICAL" || wager.alertTier === "STEAM"
                                  return (
                                    <button
                                      key={wager.ticketId}
                                      type="button"
                                      onClick={() =>
                                        onSelectWager
                                          ? onSelectWager(wager)
                                          : onViewCustomerWagers?.(selectedCustomer.id)
                                      }
                                      className="sd-drilldown-ticket-row"
                                    >
                                      <div
                                        style={{
                                          display: "flex",
                                          flexDirection: "column",
                                          alignItems: "flex-start",
                                          gap: "2px",
                                          minWidth: 0,
                                        }}
                                      >
                                        <div
                                          style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: "6px",
                                            fontSize: "11.5px",
                                            fontWeight: 600,
                                            color: "#f1f5f9",
                                          }}
                                        >
                                          <span style={{ color: "#38bdf8" }}>{wager.sport}</span>
                                          <span
                                            style={{
                                              overflow: "hidden",
                                              textOverflow: "ellipsis",
                                              whiteSpace: "nowrap",
                                              maxWidth: "250px",
                                            }}
                                          >
                                            {wager.selection || wager.event}
                                          </span>
                                          {isCrit ? (
                                            <span
                                              style={{
                                                fontSize: "9.5px",
                                                fontWeight: 700,
                                                padding: "1px 5px",
                                                borderRadius: "3px",
                                                backgroundColor: "rgba(239, 68, 68, 0.18)",
                                                color: "#fca5a5",
                                              }}
                                            >
                                              {wager.alertTier}
                                            </span>
                                          ) : null}
                                        </div>
                                        <span
                                          style={{
                                            fontSize: "10.5px",
                                            color: "#94a3b8",
                                            fontFamily:
                                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                          }}
                                        >
                                          #{wager.ticketId} · {wager.betType} ·{" "}
                                          {wager.writer ?? wager.ticketWriter ?? "DIRECT"}
                                          {wager.oddsAmerican ? ` · ${wager.oddsAmerican}` : ""}
                                        </span>
                                      </div>
                                      <div
                                        style={{
                                          display: "flex",
                                          flexDirection: "column",
                                          alignItems: "flex-end",
                                          fontVariantNumeric: "tabular-nums",
                                          fontFamily:
                                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                          flexShrink: 0,
                                        }}
                                      >
                                        <span
                                          style={{
                                            fontSize: "12px",
                                            fontWeight: 700,
                                            color: isCrit ? "#fca5a5" : "#e2e8f0",
                                          }}
                                        >
                                          ${wager.riskUsd.toLocaleString()}
                                        </span>
                                        <span style={{ fontSize: "10px", color: "#64748b" }}>
                                          win ${wager.toWinUsd.toLocaleString()}
                                        </span>
                                      </div>
                                    </button>
                                  )
                                })}
                            </div>
                          </div>
                        </>
                      ) : (
                        <>
                          {selectedCustomer.forensicDossier &&
                          selectedCustomer.forensicDossier.flaggedTickets.length > 0 ? null : (
                            <div
                              style={{
                                ...styles.detailCard,
                                textAlign: "center",
                                padding: "24px 16px",
                                color: "#94a3b8",
                                display: "flex",
                                flexDirection: "column",
                                alignItems: "center",
                                gap: "10px",
                              }}
                            >
                              <Activity size={18} color="#64748b" aria-hidden="true" />
                              <div style={{ fontSize: "12px" }}>
                                No live open wagers currently on the ticker snapshot for{" "}
                                <b style={{ color: "#e2e8f0" }}>{selectedCustomer.id}</b>.
                              </div>
                              {onViewCustomerWagers && (
                                <button
                                  type="button"
                                  style={{
                                    ...styles.actionBtn,
                                    padding: "5px 10px",
                                    fontSize: "11px",
                                  }}
                                  onClick={() => onViewCustomerWagers(selectedCustomer.id)}
                                >
                                  Search Full Wager Tape ↗
                                </button>
                              )}
                            </div>
                          )}
                        </>
                      )}

                      {selectedCustomer.forensicDossier &&
                        selectedCustomer.forensicDossier.flaggedTickets.length > 0 && (
                          <ForensicFlaggedTicketsPanel
                            tickets={selectedCustomer.forensicDossier.flaggedTickets}
                          />
                        )}
                    </div>
                  )}

                  {/* TAB 3: Reconciliation & Reverse DNS Forensics */}
                  {drilldownTab === "reconciliation" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {selectedOnChainXref && (
                        <ProfileOnChainXrefCard
                          xref={selectedOnChainXref}
                          onJumpToCustomer={onSelectCustomerById}
                        />
                      )}
                      {selectedCustomer.forensicDossier && (
                        <GraphForensicsDossierPanel
                          customerId={selectedCustomer.id}
                          dossier={selectedCustomer.forensicDossier}
                          onSelectAgent={onSelectAgent}
                          onJumpToCustomer={onSelectCustomerById}
                          onRunReverseLookup={onRunReverseLookup}
                        />
                      )}
                      {selectedCustomer.portalReconciliation ? (
                        <div
                          style={{
                            ...styles.detailCard,
                            border: "1px solid rgba(56, 189, 248, 0.32)",
                            backgroundColor: "rgba(15, 23, 42, 0.72)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              flexWrap: "wrap",
                              gap: "6px",
                              marginBottom: "10px",
                            }}
                          >
                            <h4 style={{ ...styles.cardHeader, margin: 0 }}>
                              Portal &amp; Figure-Date Reconciliation
                            </h4>
                            <span
                              style={{
                                padding: "2px 8px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: 700,
                                backgroundColor: selectedCustomer.portalReconciliation
                                  .creditEquationBalanced
                                  ? "rgba(34, 197, 94, 0.16)"
                                  : "rgba(239, 68, 68, 0.18)",
                                color: selectedCustomer.portalReconciliation.creditEquationBalanced
                                  ? "#4ade80"
                                  : "#f87171",
                                border: `1px solid ${
                                  selectedCustomer.portalReconciliation.creditEquationBalanced
                                    ? "rgba(74, 222, 128, 0.4)"
                                    : "rgba(248, 113, 113, 0.45)"
                                }`,
                              }}
                            >
                              {selectedCustomer.portalReconciliation.creditEquationBalanced
                                ? "✓ BALANCED (0¢ DELTA)"
                                : "⚠ LEDGER DELTA"}
                            </span>
                          </div>

                          <div style={{ ...styles.detailGrid, marginBottom: "10px" }}>
                            <div className="sd-drilldown-kv-list">
                              <div className="sd-drilldown-kv-section">Credit-Line Identity</div>
                              <div className="sd-drilldown-kv-row">
                                <span>Credit Limit</span>
                                <b>
                                  $
                                  {selectedCustomer.portalReconciliation.creditLimitUsd.toLocaleString()}
                                </b>
                              </div>
                              <div className="sd-drilldown-kv-row">
                                <span>Current Balance</span>
                                <b
                                  style={{
                                    color:
                                      selectedCustomer.portalReconciliation.currentBalanceUsd < 0
                                        ? "#f87171"
                                        : "#4ade80",
                                  }}
                                >
                                  {selectedCustomer.portalReconciliation.currentBalanceUsd < 0
                                    ? `-$${Math.abs(selectedCustomer.portalReconciliation.currentBalanceUsd).toLocaleString()}`
                                    : `+$${selectedCustomer.portalReconciliation.currentBalanceUsd.toLocaleString()}`}
                                </b>
                              </div>
                              <div className="sd-drilldown-kv-row">
                                <span>Pending Exposure</span>
                                <b style={{ color: "#fbbf24" }}>
                                  $
                                  {selectedCustomer.portalReconciliation.pendingWagerBalanceUsd.toLocaleString()}{" "}
                                  ({selectedCustomer.portalReconciliation.pendingWagerCount})
                                </b>
                              </div>
                              <div className="sd-drilldown-kv-row">
                                <span>Available Balance</span>
                                <b style={{ color: "#38bdf8" }}>
                                  $
                                  {selectedCustomer.portalReconciliation.availableBalanceUsd.toLocaleString()}
                                </b>
                              </div>
                            </div>

                            <div className="sd-drilldown-kv-list">
                              <div className="sd-drilldown-kv-section">
                                Performance &amp; Carryover Split
                              </div>
                              <div className="sd-drilldown-kv-row">
                                <span>Carryover Prefix</span>
                                <b style={{ color: "#f87171" }}>
                                  +$
                                  {selectedCustomer.portalReconciliation.carryOverUsd.toLocaleString()}
                                </b>
                              </div>
                              <div className="sd-drilldown-kv-row">
                                <span>Carryover Parity</span>
                                <b
                                  style={{
                                    color: selectedCustomer.portalReconciliation
                                      .carryOverParityMatched
                                      ? "#4ade80"
                                      : "#f87171",
                                  }}
                                >
                                  {selectedCustomer.portalReconciliation.carryOverParityMatched
                                    ? "Matched ✓"
                                    : "Mismatch"}
                                </b>
                              </div>
                              <div className="sd-drilldown-kv-row">
                                <span>Post-Carryover Net</span>
                                <b
                                  style={{
                                    color:
                                      selectedCustomer.portalReconciliation.postCarryOverNetUsd < 0
                                        ? "#4ade80"
                                        : "#f87171",
                                  }}
                                >
                                  {selectedCustomer.portalReconciliation.postCarryOverNetUsd < 0
                                    ? `-$${Math.abs(selectedCustomer.portalReconciliation.postCarryOverNetUsd).toLocaleString()}`
                                    : `+$${selectedCustomer.portalReconciliation.postCarryOverNetUsd.toLocaleString()}`}
                                </b>
                              </div>
                              <div className="sd-drilldown-kv-row">
                                <span>
                                  31d Net ({selectedCustomer.portalReconciliation.winDays31d}W-
                                  {selectedCustomer.portalReconciliation.lossDays31d}L)
                                </span>
                                <b style={{ color: "#f87171" }}>
                                  +$
                                  {selectedCustomer.portalReconciliation.net31dUsd.toLocaleString()}
                                </b>
                              </div>
                            </div>
                          </div>

                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "8px",
                              fontSize: "11px",
                              color: "#cbd5e1",
                              paddingTop: "8px",
                              borderTop: "1px solid #1e293b",
                              marginBottom: "8px",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            <span>
                              Wager Limit:{" "}
                              <b>
                                $
                                {selectedCustomer.portalReconciliation.wagerLimitUsd.toLocaleString()}
                              </b>
                            </span>
                            <span>·</span>
                            <span>
                              Settle:{" "}
                              <b>
                                $
                                {selectedCustomer.portalReconciliation.settleFigureUsd.toLocaleString()}
                              </b>
                            </span>
                            <span>·</span>
                            <span>
                              WiseWeight:{" "}
                              <b>{selectedCustomer.portalReconciliation.wiseLineMovementWeight}</b>
                            </span>
                            <span>·</span>
                            <span>
                              Delay:{" "}
                              <b>{selectedCustomer.portalReconciliation.confirmationDelaySec}s</b>
                            </span>
                            <span>·</span>
                            <span>
                              Inet: <code>{selectedCustomer.portalReconciliation.inetTarget}</code>
                            </span>
                            <span>·</span>
                            <span>
                              Parlay:{" "}
                              <b>{selectedCustomer.portalReconciliation.assignedParlayName}</b>
                            </span>
                          </div>

                          <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
                            {selectedCustomer.portalReconciliation.postureFlags.map((flag) => (
                              <span
                                key={flag}
                                style={{
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  fontSize: "10px",
                                  fontWeight: 700,
                                  fontFamily: "monospace",
                                  backgroundColor:
                                    flag === "LINE_MOVER_WEIGHT_ACTIVE"
                                      ? "rgba(239, 68, 68, 0.16)"
                                      : flag === "BETTING_ALERTS_DISABLED"
                                        ? "rgba(245, 158, 11, 0.16)"
                                        : "rgba(56, 189, 248, 0.12)",
                                  color:
                                    flag === "LINE_MOVER_WEIGHT_ACTIVE"
                                      ? "#fca5a5"
                                      : flag === "BETTING_ALERTS_DISABLED"
                                        ? "#fbbf24"
                                        : "#7dd3fc",
                                  border: "1px solid rgba(148, 163, 184, 0.25)",
                                }}
                              >
                                {flag}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : !selectedOnChainXref &&
                        !selectedCustomer.forensicDossier?.beardBridge &&
                        !selectedCustomer.forensicDossier?.telemetryOverview ? (
                        <div
                          style={{
                            ...styles.detailCard,
                            fontSize: "12px",
                            color: "#94a3b8",
                          }}
                        >
                          No cross-endpoint portal reconciliation snapshot attached to this account.
                        </div>
                      ) : null}

                      {/* Reverse DNS & Agent Conduit Forensics */}
                      <div style={{ ...styles.forensicCard, marginBottom: 0 }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            flexWrap: "wrap",
                            gap: "8px",
                            marginBottom: "8px",
                          }}
                        >
                          <h4
                            style={{
                              ...styles.cardHeader,
                              margin: 0,
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <Globe size={13} color="#38bdf8" aria-hidden="true" />
                            Reverse DNS &amp; Network Forensics
                          </h4>
                          {onSelectAgent && (
                            <button
                              type="button"
                              onClick={() => onSelectAgent(selectedCustomer.agentId)}
                              className="sd-drilldown-inline-link"
                              style={{ fontSize: "11px" }}
                            >
                              Inspect Agent Conduit {selectedCustomer.agentId}{" "}
                              <ArrowUpRight size={11} aria-hidden="true" />
                            </button>
                          )}
                        </div>
                        <div style={styles.forensicRow}>
                          <span>Observed Login IP:</span>
                          <code>{selectedCustomer.ipAddress}</code>
                          <button
                            type="button"
                            style={styles.actionBtnSmall}
                            onClick={() => onRunReverseLookup(selectedCustomer.ipAddress)}
                          >
                            🔍 Run Reverse DNS
                          </button>
                        </div>
                        {customerReverseForensics ? (
                          <ReverseDnsForensicsCard view={customerReverseForensics} />
                        ) : null}
                      </div>
                    </div>
                  )}

                  {/* TAB 4: Profile Type Classification & Operator Tags */}
                  {drilldownTab === "tags" && selectedClassification && (
                    <div
                      style={{
                        ...styles.detailCard,
                        border: `1px solid ${selectedClassification.type.border}`,
                        backgroundColor: "rgba(11, 15, 25, 0.85)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "6px",
                          marginBottom: "6px",
                        }}
                      >
                        <h4
                          style={{
                            ...styles.cardHeader,
                            margin: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <Tag size={13} color="#38bdf8" />
                          Profile Type &amp; Tags ({selectedClassification.tags.length})
                        </h4>
                        <span
                          style={{
                            fontSize: "10.5px",
                            color: selectedClassification.type.fg,
                            fontWeight: 600,
                          }}
                        >
                          {selectedClassification.type.icon} {selectedClassification.type.label}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: "11.5px",
                          color: "#94a3b8",
                          marginBottom: "10px",
                          lineHeight: 1.45,
                        }}
                      >
                        {selectedClassification.type.description}
                      </div>

                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: "5px",
                          marginBottom: "12px",
                        }}
                      >
                        {selectedClassification.tags.map((tag) => {
                          const tone = PROFILE_TAG_TONE_STYLES[tag.tone]
                          const catMeta = PROFILE_TAG_CATEGORY_META[tag.category]
                          const isFiltered = activeProfileTagIds.includes(tag.id)
                          return (
                            <span
                              key={tag.id}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "3px 8px",
                                borderRadius: "4px",
                                fontSize: "10.5px",
                                fontWeight: 600,
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                backgroundColor: tone.bg,
                                color: tone.fg,
                                borderWidth: "1px",
                                borderStyle: "solid",
                                borderColor: isFiltered ? "#38bdf8" : tone.border,
                              }}
                              title={`${catMeta.label}: ${tag.description}`}
                            >
                              <button
                                type="button"
                                onClick={() => onToggleProfileTag?.(tag.id)}
                                style={{
                                  background: "none",
                                  border: "none",
                                  padding: 0,
                                  color: "inherit",
                                  font: "inherit",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px",
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: "8.5px",
                                    opacity: 0.72,
                                    textTransform: "uppercase",
                                  }}
                                >
                                  {catMeta.label.slice(0, 3)}
                                </span>
                                <span>{tag.label}</span>
                              </button>
                              {tag.isCustom && onRemoveCustomProfileTag && (
                                <button
                                  type="button"
                                  aria-label={`Remove tag ${tag.label}`}
                                  onClick={() =>
                                    onRemoveCustomProfileTag(selectedCustomer.id, tag.label)
                                  }
                                  style={{
                                    background: "none",
                                    border: "none",
                                    padding: "0 0 0 2px",
                                    color: "#e2e8f0",
                                    cursor: "pointer",
                                    display: "inline-flex",
                                    alignItems: "center",
                                  }}
                                >
                                  <X size={10} />
                                </button>
                              )}
                            </span>
                          )
                        })}
                      </div>

                      {onAddCustomProfileTag && (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "8px",
                            paddingTop: "10px",
                            borderTopWidth: "1px",
                            borderTopStyle: "solid",
                            borderTopColor: "#1e293b",
                          }}
                        >
                          <form
                            onSubmit={(e) => {
                              e.preventDefault()
                              if (!customTagInput.trim()) return
                              onAddCustomProfileTag(selectedCustomer.id, customTagInput)
                              setCustomTagInput("")
                            }}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <input
                              type="text"
                              value={customTagInput}
                              onChange={(e) => setCustomTagInput(e.target.value)}
                              placeholder="Add operator tag (e.g. LIMIT-REVIEW)..."
                              style={{
                                flex: 1,
                                padding: "5px 9px",
                                borderRadius: "5px",
                                backgroundColor: "#0f172a",
                                borderWidth: "1px",
                                borderStyle: "solid",
                                borderColor: "#334155",
                                color: "#f1f5f9",
                                fontSize: "11.5px",
                              }}
                            />
                            <button
                              type="submit"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "4px",
                                padding: "5px 10px",
                                borderRadius: "5px",
                                backgroundColor: "rgba(167, 139, 250, 0.16)",
                                borderWidth: "1px",
                                borderStyle: "solid",
                                borderColor: "rgba(167, 139, 250, 0.42)",
                                color: "#c4b5fd",
                                fontSize: "11px",
                                fontWeight: 600,
                                cursor: "pointer",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <Plus size={11} />
                              <span>Add Tag</span>
                            </button>
                          </form>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "center",
                              gap: "5px",
                            }}
                          >
                            <span style={{ fontSize: "10.5px", color: "#64748b" }}>
                              Quick tags:
                            </span>
                            {SUGGESTED_OPERATOR_TAGS.map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => onAddCustomProfileTag(selectedCustomer.id, preset)}
                                style={{
                                  padding: "2px 7px",
                                  borderRadius: "4px",
                                  fontSize: "10px",
                                  fontWeight: 600,
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                  backgroundColor: "rgba(30, 41, 59, 0.7)",
                                  borderWidth: "1px",
                                  borderStyle: "solid",
                                  borderColor: "#334155",
                                  color: "#94a3b8",
                                  cursor: "pointer",
                                }}
                              >
                                + {preset}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div style={styles.loading}>
                  Select a customer to inspect deep multidimensional profile.
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Sharpest Profiles × On-Chain Wager Tracking Cross-Reference Audit Matrix */}
      {sharpestOnChainXref && sharpestOnChainXref.rows.length > 0 && (
        <SharpestOnChainXrefPanel
          report={sharpestOnChainXref}
          selectedCustomerId={selectedCustomer?.id ?? null}
          onSelectCustomerById={onSelectCustomerById}
          onSelectAgent={onSelectAgent}
        />
      )}

      {/* Live Bun.inspect.custom Output Renderer for Profiles */}
      {sortedCustomers.length > 0 && (
        <ProfilesInspectSection
          profiles={sortedCustomers}
          selectedCustomer={selectedCustomer}
          profileClassifications={profileClassifications}
          sortField={customerSort.key}
          sortDir={customerSort.dir}
          activeFilters={activeInspectFilters}
          onRunTerminalCommand={onRunTerminalCommand}
          onOpenTerminalProfile={onOpenTerminalProfile}
          onAddCustomProfileTag={onAddCustomProfileTag}
          onRemoveCustomProfileTag={onRemoveCustomProfileTag}
        />
      )}
    </div>
  )
}

function RetainedHistorySummary({
  history,
}: {
  readonly history: import("@sportsdesk-ops/contracts").CustomerRetainedHistory
}): React.ReactElement {
  const money = (v: number | null) =>
    v === null
      ? "Unavailable"
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v)
  return (
    <section aria-label="Retained wager history">
      <h3>Observed retained wager history</h3>
      <p>
        {history.eligibleWagers.toLocaleString()} eligible non-free-play W/L wagers ·{" "}
        {history.excludedWagers.toLocaleString()} excluded ·{" "}
        {history.conflictingWagers.toLocaleString()} conflicting identities withheld
      </p>
      <p>
        {history.firstSourceTime ?? "Unknown start"} → {history.lastSourceTime ?? "Unknown end"} ·
        provider wall time; timezone unverified · partial history, not lifetime
      </p>
      <dl>
        <dt>Retained eligible stake</dt>
        <dd>{money(history.stakeUsd)}</dd>
        <dt>Mean / median stake</dt>
        <dd>
          {money(history.meanStakeUsd)} / {money(history.medianStakeUsd)}
        </dd>
        <dt>Observed 95th percentile / maximum stake</dt>
        <dd>
          {money(history.p95StakeUsd)} / {money(history.maxStakeUsd)} (not forecast VaR)
        </dd>
        <dt>Stake Gini</dt>
        <dd>{history.stakeGini === null ? "Unavailable" : history.stakeGini.toFixed(3)}</dd>
        <dt>Source-reported net (provisional)</dt>
        <dd>{money(history.reportedNetUsd)}</dd>
        <dt>Provisional ROI on eligible retained stakes</dt>
        <dd>
          {history.provisionalRoiPct === null
            ? "Unavailable"
            : `${history.provisionalRoiPct.toFixed(2)}%`}
        </dd>
        <dt>Source-reported wins / losses</dt>
        <dd>
          {history.wins.toLocaleString()} / {history.losses.toLocaleString()}
        </dd>
      </dl>
      <p>
        Reported results are not independently verified settlements. Refunds, free plays, unknown
        statuses, missing financial values, nonpositive stakes and conflicting observations are
        excluded. Fees, corrections and lifetime completeness are unverified; no betting edge or
        policy action is inferred.
      </p>
    </section>
  )
}
