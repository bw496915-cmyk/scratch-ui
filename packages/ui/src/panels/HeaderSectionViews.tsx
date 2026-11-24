import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ArrowUpRight,
  Check,
  Download,
  Fingerprint,
  KeyRound,
  Layers,
  Radar,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Volume2,
  VolumeX,
} from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { styles } from "../dashboard_styles.ts"
import {
  playRiskBreachTone,
  readStoredRiskBreachSoundPrefs,
  type RiskBreachSoundPrefs,
  shouldTriggerRiskBreachSound,
  writeStoredRiskBreachSoundPrefs,
} from "../risk_breach_audio.ts"
import {
  buildRiskOverviewAccountsCsv,
  buildRiskOverviewCsvFilename,
  downloadRiskCsvBlob,
} from "../risk_csv_export.ts"
import { buildRolling60MinRiskSeries, formatRiskCompactUsd } from "../risk_exposure_series.ts"
import {
  DEFAULT_RISK_EXPOSURE_LIMIT_USD,
  DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD,
  evaluateRiskExposureThreshold,
  RISK_EXPOSURE_WARN_RATIO,
  type RiskExposureThresholds,
  type RiskThresholdEvaluation,
} from "../risk_threshold_alert.ts"
import {
  BitwiseLogFilterStore,
  buildBitwiseLogIndex,
  severityLabelToBit,
} from "../system_log_bitwise_filter.ts"
import {
  buildSystemLogsJsonExportPayload,
  buildSystemLogsJsonFilename,
  downloadSystemLogsJsonBlob,
  formatSystemLogsJson,
  selectBitwiseFilteredRows,
  type UnifiedSystemLogRow,
} from "../system_logs_json_export.ts"
import type {
  DashboardAlertRecord,
  DashboardSourceProvenance,
  HealthData,
  LiveWager,
  R2PipelineApiResponse,
  ShowcaseCustomer,
  TerminalHistoryEntry,
} from "../types.ts"
import { RiskExposureD3Chart } from "../viz/RiskExposureD3Chart.tsx"
import { RiskRecentAlertsSidebar } from "./RiskRecentAlertsSidebar.tsx"
import { RiskThresholdModal } from "./RiskThresholdModal.tsx"
import {
  SystemLogBitwiseSearchBar,
  useBitwiseTableDomFilter,
} from "./SystemLogBitwiseSearchBar.tsx"
import { SystemLogSeverityBarChart } from "./SystemLogSeverityBarChart.tsx"
import {
  type WebLogSeverityCounts,
  type WebLogSeverityFilter,
  WebLogsInspectorSection,
  type WebLogSnapshot,
} from "./WebLogsInspectorSection.tsx"

function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

// ---------------------------------------------------------------------------
// 1. Risk Overview Panel — Live Surveillance Pattern Detection & Exposure Desk
// ---------------------------------------------------------------------------

export type RiskPatternKey =
  | "PATTERN_STEAM_CLUSTER"
  | "PATTERN_CONDUIT_CONCENTRATION"
  | "PATTERN_TICKET_SPLITTING"
  | "PATTERN_CLV_BLEED"
  | "PATTERN_CHANNEL_SURGE"
  | "PATTERN_SYNDICATE_RING"

export type RiskPatternSeverity = "CRITICAL" | "HIGH" | "WATCH"

export interface DetectedRiskPattern {
  readonly id: string
  readonly key: RiskPatternKey
  readonly kindLabel: string
  readonly severity: RiskPatternSeverity
  readonly title: string
  readonly detail: string
  readonly metricLabel: string
  readonly metricValue: string
  readonly entities: readonly {
    readonly type: "agent" | "customer" | "sport" | "search"
    readonly label: string
    readonly value: string
  }[]
  readonly actionLabel: string
  readonly investigate:
    | {
        readonly kind: "wagers"
        readonly sport?: string
        readonly search?: string
        readonly alert?: string
      }
    | { readonly kind: "agent"; readonly agentId: string }
    | { readonly kind: "customer"; readonly customer: ShowcaseCustomer }
    | { readonly kind: "churn" }
}

export interface RiskOverviewPanelProps {
  readonly snapshotStatus: string
  readonly hasWagerSnapshot: boolean
  readonly wagers: readonly LiveWager[]
  readonly customers: readonly ShowcaseCustomer[]
  readonly alertRecords: readonly DashboardAlertRecord[]
  readonly wagersLastUpdatedAt?: number | null | undefined
  readonly wsSyncTick?: number | undefined
  readonly wsLastSyncAt?: number | null | undefined
  readonly streamingConnected?: boolean | undefined
  readonly onRefreshWagers?: (() => void) | undefined
  readonly onSelectWager: (wager: LiveWager) => void
  readonly onSelectCustomer: (customer: ShowcaseCustomer) => void
  readonly onSelectAgent: (agentId: string) => void
  readonly onInvestigateWagers: (filter: {
    sport?: string
    search?: string
    alert?: string
  }) => void
  readonly onNavigateTab: (
    tab: "wagers" | "customers" | "shadow" | "alerts" | "churn-simulation",
  ) => void
  /** Configurable 60-minute aggregate risk exposure breach threshold in USD. */
  readonly exposureLimitUsd?: number | undefined
  /** Configurable 60-minute aggregate risk exposure warning threshold in USD. */
  readonly warningLimitUsd?: number | undefined
  /** Persist & update the 60-minute aggregate risk exposure breach threshold. */
  readonly onChangeExposureLimitUsd?: ((nextLimitUsd: number) => void) | undefined
  /** Persist & update both custom Warning and Breach USD thresholds. */
  readonly onChangeExposureThresholds?: ((next: RiskExposureThresholds) => void) | undefined
  /** Shared real-time evaluation from the app root so header & panel match identically. */
  readonly riskThresholdEvaluation?: RiskThresholdEvaluation | undefined
}

const PATTERN_SEVERITY_TONE: Record<
  RiskPatternSeverity,
  { fg: string; bg: string; border: string; accent: string }
> = {
  CRITICAL: {
    fg: "#fca5a5",
    bg: "rgba(239, 68, 68, 0.16)",
    border: "rgba(239, 68, 68, 0.45)",
    accent: "#ef4444",
  },
  HIGH: {
    fg: "#fcd34d",
    bg: "rgba(245, 158, 11, 0.16)",
    border: "rgba(245, 158, 11, 0.45)",
    accent: "#f59e0b",
  },
  WATCH: {
    fg: "#7dd3fc",
    bg: "rgba(56, 189, 248, 0.14)",
    border: "rgba(56, 189, 248, 0.4)",
    accent: "#38bdf8",
  },
}

export function RiskOverviewPanel({
  wagers,
  snapshotStatus,
  hasWagerSnapshot,
  customers,
  alertRecords,
  wagersLastUpdatedAt,
  wsSyncTick,
  wsLastSyncAt,
  streamingConnected,
  onRefreshWagers,
  onSelectWager,
  onSelectCustomer,
  onSelectAgent,
  onInvestigateWagers,
  onNavigateTab,
  exposureLimitUsd = DEFAULT_RISK_EXPOSURE_LIMIT_USD,
  warningLimitUsd,
  onChangeExposureLimitUsd,
  onChangeExposureThresholds,
  riskThresholdEvaluation,
}: RiskOverviewPanelProps): React.ReactElement {
  const [severityFilter, setSeverityFilter] = useState<"ALL" | RiskPatternSeverity>("ALL")
  const [isThresholdModalOpen, setIsThresholdModalOpen] = useState<boolean>(false)
  const [alertsClockMs, setAlertsClockMs] = useState<number>(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => {
      setAlertsClockMs(Date.now())
    }, 15_000)
    return () => clearInterval(id)
  }, [])

  const alertsAnchorMs = useMemo(
    () => Math.max(wsLastSyncAt ?? 0, wagersLastUpdatedAt ?? 0, alertsClockMs),
    [wsSyncTick, wsLastSyncAt, wagersLastUpdatedAt, alertsClockMs],
  )

  const effectiveWarningLimitUsd =
    warningLimitUsd ??
    riskThresholdEvaluation?.warningLimitUsd ??
    Math.round(exposureLimitUsd * RISK_EXPOSURE_WARN_RATIO)

  const fallbackEvaluation = useMemo<RiskThresholdEvaluation>(() => {
    if (riskThresholdEvaluation) return riskThresholdEvaluation
    const anchorMs = Math.max(wsLastSyncAt ?? 0, wagersLastUpdatedAt ?? 0, Date.now())
    const series = buildRolling60MinRiskSeries(wagers, { anchorMs })
    return evaluateRiskExposureThreshold(series.totalRiskUsd, exposureLimitUsd, {
      warningLimitUsd: effectiveWarningLimitUsd,
      hasData: hasWagerSnapshot && series.includedTickets > 0,
    })
  }, [
    riskThresholdEvaluation,
    wagers,
    wsLastSyncAt,
    wagersLastUpdatedAt,
    exposureLimitUsd,
    effectiveWarningLimitUsd,
    hasWagerSnapshot,
  ])

  const thresholdEval = riskThresholdEvaluation ?? fallbackEvaluation

  const handleSaveThresholds = (next: RiskExposureThresholds) => {
    if (onChangeExposureThresholds) {
      onChangeExposureThresholds(next)
    } else {
      onChangeExposureLimitUsd?.(next.breachLimitUsd)
    }
  }

  const [soundPrefs, setSoundPrefs] = useState<RiskBreachSoundPrefs>(() =>
    readStoredRiskBreachSoundPrefs(),
  )
  const prevThresholdStatusRef = useRef<RiskThresholdEvaluation["status"] | null>(null)
  const prevThresholdExcessRef = useRef<number>(0)
  const lastSoundPlayedMonotonicMsRef = useRef<number | null>(null)

  const handleSaveSoundPrefs = (next: RiskBreachSoundPrefs) => {
    const persisted = writeStoredRiskBreachSoundPrefs(next)
    setSoundPrefs(persisted)
  }

  const handleToggleQuickSound = () => {
    const nextEnabled = !soundPrefs.enabled
    const persisted = writeStoredRiskBreachSoundPrefs({
      ...soundPrefs,
      enabled: nextEnabled,
    })
    setSoundPrefs(persisted)
    if (nextEnabled) {
      playRiskBreachTone(persisted)
    }
  }

  useEffect(() => {
    const nowMonotonicMs =
      typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now()
    const shouldFire = shouldTriggerRiskBreachSound({
      enabled: soundPrefs.enabled,
      prevStatus: prevThresholdStatusRef.current,
      nextStatus: thresholdEval.status,
      prevExcessUsd: prevThresholdExcessRef.current,
      nextExcessUsd: thresholdEval.excessUsd,
      nowMonotonicMs,
      lastPlayedMonotonicMs: lastSoundPlayedMonotonicMsRef.current,
      cooldownSec: soundPrefs.cooldownSec,
    })
    if (shouldFire) {
      const res = playRiskBreachTone(soundPrefs)
      if (res.played) {
        lastSoundPlayedMonotonicMsRef.current = nowMonotonicMs
      }
    }
    prevThresholdStatusRef.current = thresholdEval.status
    prevThresholdExcessRef.current = thresholdEval.excessUsd
  }, [
    thresholdEval.status,
    thresholdEval.excessUsd,
    soundPrefs.enabled,
    soundPrefs.tone,
    soundPrefs.volume,
    soundPrefs.cooldownSec,
  ])

  const warningMarkerPct =
    thresholdEval.limitUsd > 0
      ? Math.min(99, Math.max(1, (thresholdEval.warningLimitUsd / thresholdEval.limitUsd) * 100))
      : 80

  const isCustomThreshold =
    exposureLimitUsd !== DEFAULT_RISK_EXPOSURE_LIMIT_USD ||
    effectiveWarningLimitUsd !== DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD

  const totalRiskUsd = useMemo(() => wagers.reduce((sum, w) => sum + w.riskUsd, 0), [wagers])
  const criticalWagers = useMemo(
    () => wagers.filter((w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM"),
    [wagers],
  )
  const highRiskCustomers = useMemo(
    () =>
      customers
        .filter(
          (c) =>
            c.syndicateRisk === "HIGH" ||
            c.tier === "TIER_1_ELITE_ORIGINATOR" ||
            c.tier === "TIER_2_STEAM_SYNDICATE",
        )
        .sort((a, b) => b.var95Usd - a.var95Usd),
    [customers],
  )
  const [exportedRiskCsvCount, setExportedRiskCsvCount] = useState<number | null>(null)
  const riskCsvTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (riskCsvTimerRef.current !== null) {
        clearTimeout(riskCsvTimerRef.current)
      }
    }
  }, [])

  const handleExportRiskOverviewCsv = () => {
    if (highRiskCustomers.length === 0) return
    const csv = buildRiskOverviewAccountsCsv(highRiskCustomers, wagers)
    const filename = buildRiskOverviewCsvFilename()
    const exported = downloadRiskCsvBlob(csv, filename)
    if (exported) {
      setExportedRiskCsvCount(highRiskCustomers.length)
      if (riskCsvTimerRef.current !== null) {
        clearTimeout(riskCsvTimerRef.current)
      }
      riskCsvTimerRef.current = setTimeout(() => {
        setExportedRiskCsvCount(null)
        riskCsvTimerRef.current = null
      }, 2200)
    }
  }

  // Real-time surveillance pattern detection across live tape + customer cohort
  const detectedPatterns = useMemo<DetectedRiskPattern[]>(() => {
    const patterns: DetectedRiskPattern[] = []

    // 1. Coordinated Steam / Event Clustering (same event hit by multiple tickets or distinct accounts)
    const byEvent = new Map<
      string,
      {
        event: string
        sport: string
        riskUsd: number
        tickets: LiveWager[]
        customers: Set<string>
        sharpCount: number
      }
    >()
    for (const w of wagers) {
      const evKey = (w.event || w.selection || "").trim()
      if (!evKey) continue
      const entry = byEvent.get(evKey) ?? {
        event: evKey,
        sport: w.sport,
        riskUsd: 0,
        tickets: [],
        customers: new Set<string>(),
        sharpCount: 0,
      }
      entry.riskUsd += w.riskUsd
      entry.tickets.push(w)
      entry.customers.add(w.customerId)
      if (w.alertTier === "CRITICAL" || w.alertTier === "STEAM") {
        entry.sharpCount += 1
      }
      byEvent.set(evKey, entry)
    }
    const topEventClusters = [...byEvent.values()]
      .filter((e) => e.tickets.length >= 2 || e.sharpCount >= 1)
      .sort((a, b) => b.riskUsd - a.riskUsd)
      .slice(0, 2)

    for (const cluster of topEventClusters) {
      const multiAccount = cluster.customers.size >= 2
      patterns.push({
        id: `steam:${cluster.event}`,
        key: "PATTERN_STEAM_CLUSTER",
        kindLabel: multiAccount ? "Coordinated Event Steam" : "Single-Event Concentration",
        severity:
          multiAccount && cluster.sharpCount >= 1
            ? "CRITICAL"
            : cluster.sharpCount >= 1 || cluster.tickets.length >= 3
              ? "HIGH"
              : "WATCH",
        title: `${cluster.sport} · ${cluster.event}`,
        detail: `${cluster.tickets.length} live tickets from ${cluster.customers.size} distinct bettor${cluster.customers.size === 1 ? "" : "s"}${cluster.sharpCount > 0 ? ` (${cluster.sharpCount} CRITICAL/STEAM flagged)` : ""}.`,
        metricLabel: "Cluster Risk",
        metricValue: formatUsd(cluster.riskUsd),
        entities: [
          { type: "sport", label: cluster.sport, value: cluster.sport },
          ...[...cluster.customers].slice(0, 3).map((cid) => ({
            type: "search" as const,
            label: cid,
            value: cid,
          })),
        ],
        actionLabel: "Filter Event in Tape ↗",
        investigate: {
          kind: "wagers",
          sport: cluster.sport,
          search: cluster.event.slice(0, 28),
        },
      })
    }

    // 2. Multi-Ticket Splitting / Limit Evasion by Customer
    const byCustomer = new Map<
      string,
      {
        customerId: string
        agentId: string
        riskUsd: number
        maxRec: number
        tickets: LiveWager[]
        sports: Set<string>
      }
    >()
    for (const w of wagers) {
      const entry = byCustomer.get(w.customerId) ?? {
        customerId: w.customerId,
        agentId: w.agentId,
        riskUsd: 0,
        maxRec: w.maxRecommendedStake,
        tickets: [],
        sports: new Set<string>(),
      }
      entry.riskUsd += w.riskUsd
      entry.maxRec = Math.min(
        entry.maxRec || w.maxRecommendedStake,
        w.maxRecommendedStake || entry.maxRec,
      )
      entry.tickets.push(w)
      entry.sports.add(w.sport)
      byCustomer.set(w.customerId, entry)
    }
    const splitters = [...byCustomer.values()]
      .filter((c) => c.tickets.length >= 2 || (c.maxRec > 0 && c.riskUsd > c.maxRec * 1.25))
      .sort((a, b) => b.riskUsd - a.riskUsd)
      .slice(0, 2)

    for (const sp of splitters) {
      const overCap = sp.maxRec > 0 && sp.riskUsd > sp.maxRec
      patterns.push({
        id: `split:${sp.customerId}`,
        key: "PATTERN_TICKET_SPLITTING",
        kindLabel: overCap ? "Limit Evasion / Over-Cap Stack" : "Multi-Ticket Rapid Firing",
        severity:
          overCap && sp.tickets.length >= 2
            ? "CRITICAL"
            : overCap || sp.tickets.length >= 3
              ? "HIGH"
              : "WATCH",
        title: `${sp.customerId} (${sp.tickets.length} live tickets via ${sp.agentId})`,
        detail: `Cumulative open risk ${formatUsd(sp.riskUsd)} across ${[...sp.sports].join(", ")}${sp.maxRec > 0 ? ` vs recommended max stake ${formatUsd(sp.maxRec)}` : ""}.`,
        metricLabel: "Stacked Risk",
        metricValue: formatUsd(sp.riskUsd),
        entities: [
          { type: "search", label: sp.customerId, value: sp.customerId },
          { type: "agent", label: `Agent ${sp.agentId}`, value: sp.agentId },
        ],
        actionLabel: "Inspect Account Tape ↗",
        investigate: { kind: "wagers", search: sp.customerId },
      })
    }

    // 3. Proxy Conduit / Agent Risk Concentration
    const byAgent = new Map<
      string,
      {
        agentId: string
        riskUsd: number
        tickets: number
        customers: Set<string>
        sharpTickets: number
      }
    >()
    for (const w of wagers) {
      if (!w.agentId) continue
      const entry = byAgent.get(w.agentId) ?? {
        agentId: w.agentId,
        riskUsd: 0,
        tickets: 0,
        customers: new Set<string>(),
        sharpTickets: 0,
      }
      entry.riskUsd += w.riskUsd
      entry.tickets += 1
      entry.customers.add(w.customerId)
      if (w.alertTier === "CRITICAL" || w.alertTier === "STEAM") {
        entry.sharpTickets += 1
      }
      byAgent.set(w.agentId, entry)
    }
    const topAgent = [...byAgent.values()].sort((a, b) => b.riskUsd - a.riskUsd)[0]
    if (topAgent && totalRiskUsd > 0) {
      const sharePct = (topAgent.riskUsd / totalRiskUsd) * 100
      if (sharePct >= 15 || topAgent.sharpTickets >= 1) {
        patterns.push({
          id: `agent:${topAgent.agentId}`,
          key: "PATTERN_CONDUIT_CONCENTRATION",
          kindLabel: "Agent Conduit Concentration",
          severity: sharePct >= 35 || topAgent.sharpTickets >= 2 ? "HIGH" : "WATCH",
          title: `Agent ${topAgent.agentId} carries ${sharePct.toFixed(1)}% of open risk`,
          detail: `${topAgent.tickets} tickets from ${topAgent.customers.size} bettor${topAgent.customers.size === 1 ? "" : "s"} (${topAgent.sharpTickets} sharp/steam alerts).`,
          metricLabel: "Desk Share",
          metricValue: `${sharePct.toFixed(1)}%`,
          entities: [
            {
              type: "agent",
              label: `Agent ${topAgent.agentId}`,
              value: topAgent.agentId,
            },
          ],
          actionLabel: "Open Agent Inspector ↗",
          investigate: { kind: "agent", agentId: topAgent.agentId },
        })
      }
    }

    // 4. Positive-CLV Sharp Bleeding
    const positiveClvWagers = wagers.filter((w) => typeof w.clvCents === "number" && w.clvCents > 0)
    if (positiveClvWagers.length > 0) {
      const avgClv =
        positiveClvWagers.reduce((s, w) => s + (w.clvCents ?? 0), 0) / positiveClvWagers.length
      const clvRisk = positiveClvWagers.reduce((s, w) => s + w.riskUsd, 0)
      const topClvSport = positiveClvWagers[0]!.sport
      patterns.push({
        id: "clv:bleed",
        key: "PATTERN_CLV_BLEED",
        kindLabel: "Positive-CLV Line Bleed",
        severity: avgClv >= 5 || positiveClvWagers.length >= 4 ? "CRITICAL" : "HIGH",
        title: `${positiveClvWagers.length} live wagers beating closing line (+${avgClv.toFixed(1)}¢ avg)`,
        detail: `${formatUsd(clvRisk)} exposed to positive-CLV takers led by ${topClvSport}. Consider tightening shade in Churn Simulation.`,
        metricLabel: "Avg CLV Edge",
        metricValue: `+${avgClv.toFixed(1)}¢`,
        entities: [{ type: "sport", label: topClvSport, value: topClvSport }],
        actionLabel: "Simulate Counter-Shade ↗",
        investigate: { kind: "churn" },
      })
    }

    // 5. Intake Channel / Writer Surge
    const byChannel = new Map<
      string,
      { channel: string; riskUsd: number; count: number; sharpCount: number }
    >()
    for (const w of wagers) {
      const ch = (w.writer ?? w.ticketWriter ?? "UNKNOWN").toUpperCase()
      const entry = byChannel.get(ch) ?? {
        channel: ch,
        riskUsd: 0,
        count: 0,
        sharpCount: 0,
      }
      entry.riskUsd += w.riskUsd
      entry.count += 1
      if (w.alertTier === "CRITICAL" || w.alertTier === "STEAM") {
        entry.sharpCount += 1
      }
      byChannel.set(ch, entry)
    }
    const toxicChannel = [...byChannel.values()]
      .filter((c) => c.sharpCount > 0 || c.count >= 2)
      .sort((a, b) => b.sharpCount - a.sharpCount || b.riskUsd - a.riskUsd)[0]
    if (toxicChannel) {
      const sharpPct = (toxicChannel.sharpCount / Math.max(1, toxicChannel.count)) * 100
      patterns.push({
        id: `channel:${toxicChannel.channel}`,
        key: "PATTERN_CHANNEL_SURGE",
        kindLabel: "Intake Channel Flow Anomaly",
        severity: toxicChannel.sharpCount >= 2 && sharpPct >= 30 ? "HIGH" : "WATCH",
        title: `${toxicChannel.channel} channel carrying ${toxicChannel.sharpCount}/${toxicChannel.count} sharp alerts`,
        detail: `${formatUsd(toxicChannel.riskUsd)} open volume arriving via ${toxicChannel.channel} (${sharpPct.toFixed(0)}% sharp/steam alert density).`,
        metricLabel: "Channel Risk",
        metricValue: formatUsd(toxicChannel.riskUsd),
        entities: [
          {
            type: "search",
            label: toxicChannel.channel,
            value: toxicChannel.channel,
          },
        ],
        actionLabel: "Filter Channel Flow ↗",
        investigate: { kind: "wagers", search: toxicChannel.channel },
      })
    }

    // 6. Correlated Syndicate Ring across Profiled Cohort
    const correlatedByAgent = new Map<string, ShowcaseCustomer[]>()
    for (const c of customers) {
      if (
        c.syndicateRisk === "HIGH" ||
        c.correlatedRisk === "HIGH" ||
        c.correlatedRisk === "CRITICAL"
      ) {
        const list = correlatedByAgent.get(c.agentId) ?? []
        list.push(c)
        correlatedByAgent.set(c.agentId, list)
      }
    }
    const topRing = [...correlatedByAgent.entries()].sort(
      (a, b) =>
        b[1].length - a[1].length ||
        b[1].reduce((s, c) => s + c.var95Usd, 0) - a[1].reduce((s, c) => s + c.var95Usd, 0),
    )[0]
    if (topRing) {
      const [ringAgent, members] = topRing
      const ringVar = members.reduce((s, c) => s + c.var95Usd, 0)
      patterns.push({
        id: `ring:${ringAgent}`,
        key: "PATTERN_SYNDICATE_RING",
        kindLabel: "Correlated Syndicate Cluster",
        severity: members.length >= 2 ? "CRITICAL" : "HIGH",
        title: `${members.length} high-correlation syndicate account${members.length === 1 ? "" : "s"} under ${ringAgent}`,
        detail: `Combined VaR95 tail exposure of ${formatUsd(ringVar)} across ${members
          .map((m) => m.id)
          .slice(0, 4)
          .join(", ")}.`,
        metricLabel: "Cluster VaR95",
        metricValue: formatUsd(ringVar),
        entities: [
          { type: "agent", label: `Agent ${ringAgent}`, value: ringAgent },
          ...members.slice(0, 2).map((m) => ({
            type: "customer" as const,
            label: m.id,
            value: m.id,
          })),
        ],
        actionLabel: "Inspect Conduit Tree ↗",
        investigate: { kind: "agent", agentId: ringAgent },
      })
    }

    const severityOrder: Record<RiskPatternSeverity, number> = {
      CRITICAL: 0,
      HIGH: 1,
      WATCH: 2,
    }
    return patterns.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
  }, [wagers, customers, totalRiskUsd])

  const visiblePatterns = useMemo(
    () =>
      severityFilter === "ALL"
        ? detectedPatterns
        : detectedPatterns.filter((p) => p.severity === severityFilter),
    [detectedPatterns, severityFilter],
  )

  const sportExposure = useMemo(() => {
    const map = new Map<
      string,
      {
        sport: string
        riskUsd: number
        count: number
        criticalCount: number
        avgClv: number
        clvSamples: number
      }
    >()
    for (const w of wagers) {
      const key = w.sport || "OTHER"
      const existing = map.get(key) ?? {
        sport: key,
        riskUsd: 0,
        count: 0,
        criticalCount: 0,
        avgClv: 0,
        clvSamples: 0,
      }
      existing.riskUsd += w.riskUsd
      existing.count += 1
      if (w.alertTier === "CRITICAL" || w.alertTier === "STEAM") {
        existing.criticalCount += 1
      }
      if (typeof w.clvCents === "number") {
        existing.avgClv =
          (existing.avgClv * existing.clvSamples + w.clvCents) / (existing.clvSamples + 1)
        existing.clvSamples += 1
      }
      map.set(key, existing)
    }
    return [...map.values()].sort((a, b) => b.riskUsd - a.riskUsd).slice(0, 8)
  }, [wagers])

  const maxSportRisk = Math.max(1, ...sportExposure.map((s) => s.riskUsd))
  const topWagers = useMemo(
    () => [...wagers].sort((a, b) => b.riskUsd - a.riskUsd).slice(0, 6),
    [wagers],
  )

  const openAlerts = alertRecords.filter((a) => a.status === "queued" || a.status === "dead").length

  const criticalPatternCount = detectedPatterns.filter((p) => p.severity === "CRITICAL").length

  const runInvestigate = (pattern: DetectedRiskPattern) => {
    const inv = pattern.investigate
    if (inv.kind === "wagers") {
      onInvestigateWagers({
        sport: inv.sport,
        search: inv.search,
        alert: inv.alert,
      })
    } else if (inv.kind === "agent") {
      onSelectAgent(inv.agentId)
    } else if (inv.kind === "customer") {
      onSelectCustomer(inv.customer)
    } else {
      onNavigateTab("churn-simulation")
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Header Banner */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          padding: "14px 18px",
          backgroundColor: "#0d1527",
          border: "1px solid #1e293b",
          borderRadius: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <ShieldAlert size={18} style={{ color: "#38bdf8" }} />
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: "16px",
                fontWeight: 700,
                color: "#f8fafc",
              }}
            >
              Risk Overview &amp; Pattern Detection
            </h2>
            <div style={{ fontSize: "12px", color: "#94a3b8" }}>
              Automated surveillance radar scanning live open tape, syndicate conduits, CLV bleed,
              and ticket-splitting anomalies.
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            className="sd-threshold-trigger-btn"
            onClick={() => setIsThresholdModalOpen(true)}
            data-open-risk-threshold-modal="header"
            title={`Configure 60m aggregate risk alert thresholds (Warn ${formatUsd(effectiveWarningLimitUsd)} · Breach ${formatUsd(exposureLimitUsd)})`}
          >
            <Sliders size={13} aria-hidden="true" />
            <span>Alert Limits ({formatRiskCompactUsd(exposureLimitUsd)})</span>
          </button>
          <button
            type="button"
            style={styles.actionBtn}
            onClick={() => onNavigateTab("churn-simulation")}
          >
            Simulate Churn Levers ↗
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab("wagers")}
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              backgroundColor: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Open Live Wagers ↗
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab("shadow")}
            style={{
              padding: "8px 12px",
              borderRadius: "6px",
              backgroundColor: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Shadow Pricing ↗
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div
        className="sd-kpi-grid"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "18px",
        }}
      >
        {[
          {
            label: "Detected Risk Patterns",
            value: String(detectedPatterns.length),
            sub: `${criticalPatternCount} critical · live rule scanner`,
            accent: criticalPatternCount > 0 ? "#ef4444" : "#38bdf8",
          },
          {
            label: "Ticker Snapshot Stake",
            value: hasWagerSnapshot ? formatUsd(totalRiskUsd) : "—",
            sub: hasWagerSnapshot ? `${wagers.length} tickets · ${snapshotStatus}` : snapshotStatus,
            accent: "#38bdf8",
          },
          {
            label: "Critical / Steam Wagers",
            value: hasWagerSnapshot ? String(criticalWagers.length) : "—",
            sub:
              wagers.length > 0
                ? `${((criticalWagers.length / wagers.length) * 100).toFixed(1)}% of ticker snapshot`
                : snapshotStatus,
            accent: criticalWagers.length > 0 ? "#ef4444" : "#4ade80",
          },
          {
            label: "Sharp & Syndicate Accounts",
            value: String(highRiskCustomers.length),
            sub: `Out of ${customers.length} profiled · ${openAlerts} open alerts`,
            accent: "#f59e0b",
          },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              backgroundColor: "#0d1527",
              borderTop: "1px solid #1e293b",
              borderRight: "1px solid #1e293b",
              borderBottom: "1px solid #1e293b",
              borderLeft: `3px solid ${card.accent}`,
              borderRadius: "8px",
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "#94a3b8",
              }}
            >
              {card.label}
            </span>
            <span
              style={{
                fontSize: "24px",
                fontWeight: 700,
                color: "#f8fafc",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }}
            >
              {card.value}
            </span>
            <span style={{ fontSize: "11px", color: "#64748b" }}>{card.sub}</span>
          </div>
        ))}
      </div>

      {/* Main Analytical Workspace + Sticky 'Recent Alerts' Sidebar (Last 60 Minutes) */}
      <div className="sd-risk-overview-workspace">
        <div className="sd-risk-overview-main">
          {/* Real-Time 60-Minute Aggregate Risk Threshold Alert & Configurator */}
          <section
            aria-label="60-Minute Aggregate Risk Threshold Monitor"
            data-risk-threshold-panel="true"
            data-risk-threshold-status={thresholdEval.status}
            style={{
              backgroundColor:
                thresholdEval.status === "breach"
                  ? "rgba(127, 29, 29, 0.24)"
                  : thresholdEval.status === "warn"
                    ? "rgba(120, 53, 15, 0.2)"
                    : "#0d1527",
              borderTop:
                thresholdEval.status === "breach"
                  ? "1px solid rgba(239, 68, 68, 0.55)"
                  : thresholdEval.status === "warn"
                    ? "1px solid rgba(245, 158, 11, 0.45)"
                    : "1px solid #1e293b",
              borderRight:
                thresholdEval.status === "breach"
                  ? "1px solid rgba(239, 68, 68, 0.55)"
                  : thresholdEval.status === "warn"
                    ? "1px solid rgba(245, 158, 11, 0.45)"
                    : "1px solid #1e293b",
              borderBottom:
                thresholdEval.status === "breach"
                  ? "1px solid rgba(239, 68, 68, 0.55)"
                  : thresholdEval.status === "warn"
                    ? "1px solid rgba(245, 158, 11, 0.45)"
                    : "1px solid #1e293b",
              borderLeft: `3px solid ${
                thresholdEval.status === "breach"
                  ? "#ef4444"
                  : thresholdEval.status === "warn"
                    ? "#f59e0b"
                    : thresholdEval.status === "ok"
                      ? "#22c55e"
                      : "#38bdf8"
              }`,
              borderRadius: "8px",
              padding: "14px 18px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                {thresholdEval.isBreached || thresholdEval.isWarning ? (
                  <AlertTriangle
                    size={18}
                    aria-hidden="true"
                    style={{
                      color: thresholdEval.isBreached ? "#f87171" : "#fbbf24",
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <ShieldCheck
                    size={18}
                    aria-hidden="true"
                    style={{
                      color: thresholdEval.status === "ok" ? "#4ade80" : "#38bdf8",
                      flexShrink: 0,
                    }}
                  />
                )}
                <div style={{ display: "flex", flexDirection: "column", gap: "2px", minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "13px",
                        fontWeight: 700,
                        letterSpacing: "0.02em",
                        color:
                          thresholdEval.status === "breach"
                            ? "#fecaca"
                            : thresholdEval.status === "warn"
                              ? "#fde68a"
                              : "#f8fafc",
                      }}
                    >
                      {thresholdEval.status === "breach"
                        ? "60m Aggregate Risk Limit Exceeded"
                        : thresholdEval.status === "warn"
                          ? "Approaching 60m Aggregate Risk Limit"
                          : thresholdEval.status === "ok"
                            ? "60m Aggregate Risk Within Configured Limit"
                            : "60m Aggregate Risk Threshold Armed"}
                    </span>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        fontVariantNumeric: "tabular-nums",
                        padding: "2px 7px",
                        borderRadius: "4px",
                        backgroundColor:
                          thresholdEval.status === "breach"
                            ? "rgba(239, 68, 68, 0.24)"
                            : thresholdEval.status === "warn"
                              ? "rgba(245, 158, 11, 0.22)"
                              : "rgba(34, 197, 94, 0.14)",
                        color:
                          thresholdEval.status === "breach"
                            ? "#fca5a5"
                            : thresholdEval.status === "warn"
                              ? "#fcd34d"
                              : thresholdEval.status === "ok"
                                ? "#86efac"
                                : "#7dd3fc",
                      }}
                    >
                      {thresholdEval.status === "idle"
                        ? "IDLE"
                        : `${thresholdEval.utilizationPct.toFixed(1)}% UTILIZED`}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#cbd5e1",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {thresholdEval.status === "breach" ? (
                      <>
                        Rolling 60m exposure{" "}
                        <strong style={{ color: "#fca5a5" }}>
                          {formatUsd(thresholdEval.totalRiskUsd)}
                        </strong>{" "}
                        exceeds the{" "}
                        <strong style={{ color: "#f8fafc" }}>
                          {formatUsd(thresholdEval.limitUsd)}
                        </strong>{" "}
                        threshold by{" "}
                        <strong style={{ color: "#f87171" }}>
                          +{formatUsd(thresholdEval.excessUsd)}
                        </strong>
                        . Persistent header alert is active across all views.
                      </>
                    ) : thresholdEval.status === "warn" ? (
                      <>
                        Rolling 60m exposure{" "}
                        <strong style={{ color: "#fde68a" }}>
                          {formatUsd(thresholdEval.totalRiskUsd)}
                        </strong>{" "}
                        is at {thresholdEval.utilizationPct.toFixed(1)}% of the{" "}
                        <strong style={{ color: "#f8fafc" }}>
                          {formatUsd(thresholdEval.limitUsd)}
                        </strong>{" "}
                        cap ({formatUsd(thresholdEval.remainingUsd)} headroom remaining).
                      </>
                    ) : thresholdEval.status === "ok" ? (
                      <>
                        Rolling 60m exposure{" "}
                        <strong style={{ color: "#f8fafc" }}>
                          {formatUsd(thresholdEval.totalRiskUsd)}
                        </strong>{" "}
                        of{" "}
                        <strong style={{ color: "#f8fafc" }}>
                          {formatUsd(thresholdEval.limitUsd)}
                        </strong>{" "}
                        limit ({formatUsd(thresholdEval.remainingUsd)} headroom available).
                      </>
                    ) : (
                      <>
                        Armed at{" "}
                        <strong style={{ color: "#f8fafc" }}>
                          {formatUsd(thresholdEval.limitUsd)}
                        </strong>{" "}
                        for the rolling 60-minute window. Alerts trigger automatically as live
                        wagers arrive.
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Right side: direct action on breach + threshold modal trigger */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                {thresholdEval.isBreached ? (
                  <button
                    type="button"
                    onClick={() => onInvestigateWagers({ alert: "CRITICAL" })}
                    style={{
                      padding: "6px 11px",
                      borderRadius: "6px",
                      backgroundColor: "rgba(239, 68, 68, 0.22)",
                      color: "#fecaca",
                      border: "1px solid rgba(248, 113, 113, 0.55)",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                  >
                    Inspect Critical Tape ↗
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={handleToggleQuickSound}
                  aria-pressed={soundPrefs.enabled}
                  className={`sd-sound-toggle-btn${soundPrefs.enabled ? " sd-sound-toggle-btn--on" : ""}`}
                  data-risk-breach-sound-toggle="true"
                  title={
                    soundPrefs.enabled
                      ? `Breach sound alert active (${soundPrefs.tone}, ${Math.round(soundPrefs.volume * 100)}% volume) — click to mute`
                      : "Breach sound alert muted — click to enable and preview ping"
                  }
                >
                  {soundPrefs.enabled ? (
                    <>
                      <Volume2 size={13} aria-hidden="true" />
                      <span>Sound On</span>
                    </>
                  ) : (
                    <>
                      <VolumeX size={13} aria-hidden="true" />
                      <span>Sound Off</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setIsThresholdModalOpen(true)}
                  className="sd-threshold-trigger-btn"
                  data-open-risk-threshold-modal="true"
                >
                  <Sliders size={13} aria-hidden="true" />
                  <span>Configure Thresholds</span>
                </button>
              </div>
            </div>

            {/* Utilization Progress Bar + Active Warning & Breach USD Limits */}
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
              }}
            >
              <div
                style={{
                  flex: "1 1 260px",
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  minWidth: "200px",
                }}
              >
                <div
                  role="progressbar"
                  aria-label="60-minute aggregate risk threshold utilization"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.min(100, Math.round(thresholdEval.utilizationPct))}
                  style={{
                    position: "relative",
                    flex: 1,
                    height: "6px",
                    borderRadius: "3px",
                    backgroundColor: "rgba(15, 23, 42, 0.9)",
                    border: "1px solid rgba(51, 65, 85, 0.7)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: `${Math.min(100, Math.max(0, thresholdEval.utilizationPct))}%`,
                      height: "100%",
                      backgroundColor:
                        thresholdEval.status === "breach"
                          ? "#ef4444"
                          : thresholdEval.status === "warn"
                            ? "#f59e0b"
                            : "#22c55e",
                      transition: "width 200ms ease, background-color 200ms ease",
                    }}
                  />
                  <span
                    aria-hidden="true"
                    title={`Warning threshold: ${formatUsd(thresholdEval.warningLimitUsd)}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: `${warningMarkerPct}%`,
                      width: "2px",
                      backgroundColor: "#fbbf24",
                      opacity: 0.85,
                    }}
                  />
                </div>
                <span
                  style={{
                    fontSize: "11px",
                    color: "#94a3b8",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {formatRiskCompactUsd(thresholdEval.totalRiskUsd)} /{" "}
                  {formatRiskCompactUsd(thresholdEval.limitUsd)}
                </span>
              </div>

              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  flexWrap: "wrap",
                  fontSize: "11px",
                  color: "#94a3b8",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>
                  Warn{" "}
                  <strong style={{ color: "#fcd34d" }}>
                    {formatUsd(thresholdEval.warningLimitUsd)}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  Breach{" "}
                  <strong style={{ color: "#f8fafc" }}>{formatUsd(thresholdEval.limitUsd)}</strong>
                </span>
                <span aria-hidden="true">·</span>
                <span style={{ color: "#64748b" }}>
                  {isCustomThreshold ? "Custom (local storage)" : "Default limits"}
                </span>
              </div>
            </div>
          </section>

          <RiskThresholdModal
            open={isThresholdModalOpen}
            onClose={() => setIsThresholdModalOpen(false)}
            currentThresholds={{
              breachLimitUsd: exposureLimitUsd,
              warningLimitUsd: effectiveWarningLimitUsd,
            }}
            currentExposureUsd={thresholdEval.totalRiskUsd}
            hasLiveData={thresholdEval.status !== "idle"}
            onSave={handleSaveThresholds}
            soundPrefs={soundPrefs}
            onSaveSoundPrefs={handleSaveSoundPrefs}
          />

          {/* Real-Time Aggregate Risk Exposure D3 Line Chart (Last 60 Minutes) */}
          <RiskExposureD3Chart
            wagers={wagers}
            hasWagerSnapshot={hasWagerSnapshot}
            snapshotStatus={snapshotStatus}
            wagersLastUpdatedAt={wagersLastUpdatedAt}
            wsSyncTick={wsSyncTick}
            wsLastSyncAt={wsLastSyncAt}
            streamingConnected={streamingConnected}
            onRefreshWagers={onRefreshWagers}
            exposureLimitUsd={exposureLimitUsd}
            warningLimitUsd={effectiveWarningLimitUsd}
            thresholdStatus={thresholdEval.status}
            onOpenThresholdModal={() => setIsThresholdModalOpen(true)}
          />

          {/* Live Surveillance Pattern Radar */}
          <div
            style={{
              backgroundColor: "#0d1527",
              border: "1px solid #1e293b",
              borderRadius: "8px",
              padding: "16px",
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
                gap: "10px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Radar size={16} style={{ color: "#38bdf8" }} />
                <h3
                  style={{
                    margin: 0,
                    fontSize: "14px",
                    fontWeight: 700,
                    color: "#f8fafc",
                  }}
                >
                  Detected Surveillance Patterns ({visiblePatterns.length})
                </h3>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {(["ALL", "CRITICAL", "HIGH", "WATCH"] as const).map((sev) => {
                  const count =
                    sev === "ALL"
                      ? detectedPatterns.length
                      : detectedPatterns.filter((p) => p.severity === sev).length
                  const active = severityFilter === sev
                  return (
                    <button
                      key={sev}
                      type="button"
                      onClick={() => setSeverityFilter(sev)}
                      style={{
                        padding: "4px 9px",
                        borderRadius: "6px",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                        backgroundColor: active ? "rgba(56, 189, 248, 0.16)" : "#070b14",
                        color: active ? "#7dd3fc" : "#94a3b8",
                        border: active ? "1px solid #38bdf8" : "1px solid #1e293b",
                      }}
                    >
                      {sev} ({count})
                    </button>
                  )
                })}
              </div>
            </div>

            {visiblePatterns.length === 0 ? (
              <div
                style={{
                  padding: "18px",
                  borderRadius: "6px",
                  backgroundColor: "#070b14",
                  border: "1px solid #1e293b",
                  color: "#94a3b8",
                  fontSize: "12px",
                  textAlign: "center",
                }}
              >
                No active patterns match this severity filter on the current feed.
              </div>
            ) : (
              <div
                className="sd-card-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
                  gap: "18px",
                }}
              >
                {visiblePatterns.map((pattern) => {
                  const tone = PATTERN_SEVERITY_TONE[pattern.severity]
                  return (
                    <div
                      key={pattern.id}
                      style={{
                        backgroundColor: "#070b14",
                        borderTop: "1px solid #1e293b",
                        borderRight: "1px solid #1e293b",
                        borderBottom: "1px solid #1e293b",
                        borderLeft: `3px solid ${tone.accent}`,
                        borderRadius: "8px",
                        padding: "12px 14px",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                        gap: "10px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "6px",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: "8px",
                            flexWrap: "wrap",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              flexWrap: "wrap",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "10px",
                                fontWeight: 700,
                                padding: "2px 6px",
                                borderRadius: "4px",
                                color: tone.fg,
                                backgroundColor: tone.bg,
                                border: `1px solid ${tone.border}`,
                              }}
                            >
                              {pattern.severity}
                            </span>
                            <span
                              style={{
                                fontSize: "10px",
                                fontWeight: 600,
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                color: "#94a3b8",
                                backgroundColor: "#0f172a",
                                border: "1px solid #1e293b",
                                padding: "2px 6px",
                                borderRadius: "4px",
                              }}
                            >
                              {pattern.key}
                            </span>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <span
                              style={{
                                fontSize: "10px",
                                color: "#64748b",
                                marginRight: "6px",
                              }}
                            >
                              {pattern.metricLabel}
                            </span>
                            <span
                              style={{
                                fontSize: "13px",
                                fontWeight: 700,
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                color: tone.fg,
                              }}
                            >
                              {pattern.metricValue}
                            </span>
                          </div>
                        </div>

                        <div
                          style={{
                            fontSize: "13px",
                            fontWeight: 700,
                            color: "#f8fafc",
                          }}
                        >
                          {pattern.title}
                        </div>
                        <div
                          style={{
                            fontSize: "12px",
                            color: "#94a3b8",
                            lineHeight: 1.45,
                          }}
                        >
                          {pattern.detail}
                        </div>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: "8px",
                          paddingTop: "8px",
                          borderTop: "1px solid rgba(30, 41, 59, 0.7)",
                        }}
                      >
                        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
                          {pattern.entities.map((ent) => (
                            <button
                              key={`${pattern.id}:${ent.type}:${ent.value}`}
                              type="button"
                              onClick={() => {
                                if (ent.type === "agent") {
                                  onSelectAgent(ent.value)
                                } else if (ent.type === "sport") {
                                  onInvestigateWagers({ sport: ent.value })
                                } else if (ent.type === "customer") {
                                  const found = customers.find(
                                    (c) => c.id.toUpperCase() === ent.value.toUpperCase(),
                                  )
                                  if (found) onSelectCustomer(found)
                                } else {
                                  onInvestigateWagers({ search: ent.value })
                                }
                              }}
                              style={{
                                padding: "2px 7px",
                                borderRadius: "4px",
                                fontSize: "10px",
                                fontWeight: 600,
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                backgroundColor: "#0f172a",
                                color: "#7dd3fc",
                                border: "1px solid rgba(56, 189, 248, 0.3)",
                                cursor: "pointer",
                              }}
                            >
                              {ent.label}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => runInvestigate(pattern)}
                          style={{
                            padding: "4px 9px",
                            borderRadius: "5px",
                            fontSize: "11px",
                            fontWeight: 600,
                            backgroundColor: "rgba(56, 189, 248, 0.12)",
                            color: "#38bdf8",
                            border: "1px solid rgba(56, 189, 248, 0.35)",
                            cursor: "pointer",
                          }}
                        >
                          {pattern.actionLabel}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Main Two-Column Risk Breakdown */}
          <div
            className="sd-split-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
              gap: "24px",
            }}
          >
            {/* Sport Exposure Bars */}
            <div
              style={{
                backgroundColor: "#0d1527",
                border: "1px solid #1e293b",
                borderRadius: "8px",
                padding: "16px",
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
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: "13px",
                    fontWeight: 700,
                    color: "#f1f5f9",
                  }}
                >
                  Exposure &amp; CLV Pressure by Sport
                </h3>
                <span style={{ fontSize: "11px", color: "#64748b" }}>
                  Click any sport to filter tape
                </span>
              </div>
              {sportExposure.length === 0 ? (
                <div style={{ fontSize: "12px", color: "#64748b" }}>
                  No live wagers currently loaded.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {sportExposure.map((row) => (
                    <button
                      key={row.sport}
                      type="button"
                      onClick={() => onInvestigateWagers({ sport: row.sport })}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        textAlign: "left",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: "12px",
                        }}
                      >
                        <span style={{ fontWeight: 600, color: "#e2e8f0" }}>
                          {row.sport}{" "}
                          <span style={{ color: "#64748b", fontWeight: 400 }}>
                            ({row.count} tickets
                            {row.criticalCount > 0 ? ` · ${row.criticalCount} sharp/steam` : ""}
                            {row.clvSamples > 0
                              ? ` · ${row.avgClv >= 0 ? "+" : ""}${row.avgClv.toFixed(1)}¢ CLV`
                              : ""}
                            )
                          </span>
                        </span>
                        <span
                          style={{
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontWeight: 700,
                            color: "#38bdf8",
                          }}
                        >
                          {formatUsd(row.riskUsd)}
                        </span>
                      </div>
                      <div
                        style={{
                          height: "6px",
                          borderRadius: "999px",
                          backgroundColor: "#070b14",
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.max(4, (row.riskUsd / maxSportRisk) * 100)}%`,
                            backgroundColor: row.criticalCount > 0 ? "#f59e0b" : "#38bdf8",
                            borderRadius: "999px",
                          }}
                        />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Highest-Risk Live Wagers */}
            <div
              style={{
                backgroundColor: "#0d1527",
                border: "1px solid #1e293b",
                borderRadius: "8px",
                padding: "16px",
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
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: "13px",
                    fontWeight: 700,
                    color: "#f1f5f9",
                  }}
                >
                  Largest Open Wagers
                </h3>
                <button
                  type="button"
                  onClick={() => onNavigateTab("wagers")}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "#38bdf8",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  View full tape ↗
                </button>
              </div>
              {topWagers.length === 0 ? (
                <div style={{ fontSize: "12px", color: "#64748b" }}>No live wagers available.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                  {topWagers.map((wager) => (
                    <button
                      key={wager.ticketId}
                      type="button"
                      onClick={() => onSelectWager(wager)}
                      style={{
                        width: "100%",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: "10px",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        backgroundColor: "#070b14",
                        border: "1px solid #1e293b",
                        color: "#f1f5f9",
                        textAlign: "left",
                        cursor: "pointer",
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "12px",
                          }}
                        >
                          <span
                            style={{
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              fontWeight: 700,
                              color: "#38bdf8",
                            }}
                          >
                            {wager.customerId}
                          </span>
                          <span style={{ color: "#64748b", fontSize: "11px" }}>{wager.sport}</span>
                          {(wager.alertTier === "CRITICAL" || wager.alertTier === "STEAM") && (
                            <span
                              style={{
                                fontSize: "9px",
                                fontWeight: 700,
                                padding: "1px 5px",
                                borderRadius: "4px",
                                color: "#fca5a5",
                                backgroundColor: "rgba(239, 68, 68, 0.16)",
                                border: "1px solid rgba(239, 68, 68, 0.4)",
                              }}
                            >
                              {wager.alertTier}
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            color: "#94a3b8",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {wager.selection || wager.event}
                        </div>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          flexShrink: 0,
                        }}
                      >
                        <span
                          style={{
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontSize: "12px",
                            fontWeight: 700,
                            color: "#4ade80",
                          }}
                        >
                          {formatUsd(wager.riskUsd)}
                        </span>
                        <ArrowUpRight size={13} style={{ color: "#64748b" }} />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Top Sharp & Syndicate Risk Profiles */}
          <div
            style={{
              backgroundColor: "#0d1527",
              border: "1px solid #1e293b",
              borderRadius: "8px",
              padding: "16px",
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
              <h3
                style={{
                  margin: 0,
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "#f1f5f9",
                }}
              >
                Highest VaR95 Sharp / Syndicate Accounts
              </h3>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "10px",
                  flexShrink: 0,
                }}
              >
                <button
                  type="button"
                  className="sd-export-csv-btn"
                  data-risk-overview-export-csv="true"
                  data-export-confirmed={exportedRiskCsvCount !== null ? "true" : undefined}
                  disabled={highRiskCustomers.length === 0}
                  onClick={handleExportRiskOverviewCsv}
                  aria-label={
                    highRiskCustomers.length === 0
                      ? "Export to CSV (no risk accounts in current view)"
                      : `Export ${highRiskCustomers.length} high-risk accounts to CSV`
                  }
                  title={
                    highRiskCustomers.length === 0
                      ? "No sharp or syndicate risk accounts in the current view"
                      : `Download ${highRiskCustomers.length} high-risk account${highRiskCustomers.length === 1 ? "" : "s"} with live risk breach metrics as CSV`
                  }
                >
                  {exportedRiskCsvCount !== null ? (
                    <>
                      <Check size={12} aria-hidden="true" />
                      <span>Exported {exportedRiskCsvCount}</span>
                    </>
                  ) : (
                    <>
                      <Download size={12} aria-hidden="true" />
                      <span>Export to CSV</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onNavigateTab("customers")}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "#38bdf8",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Open Profiles ↗
                </button>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Customer</th>
                    <th style={styles.th}>Agent</th>
                    <th style={styles.th}>Tier</th>
                    <th style={styles.th}>Syndicate / Corr.</th>
                    <th style={styles.th}>VaR 95%</th>
                    <th style={styles.th}>Recommended Limit</th>
                  </tr>
                </thead>
                <tbody>
                  {highRiskCustomers.slice(0, 8).map((c) => (
                    <tr
                      key={c.id}
                      onClick={() => onSelectCustomer(c)}
                      style={{ cursor: "pointer" }}
                    >
                      <td
                        style={{
                          ...styles.td,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontWeight: 700,
                          color: "#38bdf8",
                        }}
                      >
                        {c.id}
                      </td>
                      <td style={styles.td}>{c.agentId}</td>
                      <td style={styles.td}>{c.tierLabel ?? c.tier.replace(/^TIER_\d+_/, "")}</td>
                      <td
                        style={{
                          ...styles.td,
                          color:
                            c.syndicateRisk === "HIGH" || c.correlatedRisk === "CRITICAL"
                              ? "#f87171"
                              : c.syndicateRisk === "ELEVATED"
                                ? "#fbbf24"
                                : "#94a3b8",
                          fontWeight: 600,
                        }}
                      >
                        {c.syndicateRisk} / {c.correlatedRisk}
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        }}
                      >
                        {formatUsd(c.var95Usd)}
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          color: "#4ade80",
                        }}
                      >
                        {formatUsd(c.recommendedLimitUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Sticky 'Recent Alerts' Sidebar — Last 60 Minutes Breaches & Threshold Warnings */}
        <RiskRecentAlertsSidebar
          wagers={wagers}
          alertRecords={alertRecords}
          customers={customers}
          breachLimitUsd={exposureLimitUsd}
          warningLimitUsd={effectiveWarningLimitUsd}
          anchorMs={alertsAnchorMs}
          onSelectWager={onSelectWager}
          onSelectCustomer={onSelectCustomer}
          onInvestigateWagers={onInvestigateWagers}
          onOpenAlertQueue={() => onNavigateTab("alerts")}
          onOpenThresholdModal={() => setIsThresholdModalOpen(true)}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2. Bettor Churn Simulation Panel — Structured Churn Keys & Churn Kinds
// ---------------------------------------------------------------------------

export type ChurnKind =
  | "SHARP_DETERRENCE"
  | "SYNDICATE_MIGRATION"
  | "LIMIT_CAPPED_EXIT"
  | "VIP_FRICTION_BLEED"
  | "RETAINED_CORE"

export type ChurnKey =
  | "KEY_SHADE_SENSITIVITY"
  | "KEY_LIMIT_BELOW_MEAN_STAKE"
  | "KEY_DELAY_STEAM_BLOCK"
  | "KEY_CORRELATED_EXPLOIT"
  | "KEY_SUBACCOUNT_SPILLOVER"
  | "KEY_VIP_HOLD_BLEED"

interface ChurnKindMeta {
  readonly id: ChurnKind
  readonly label: string
  readonly description: string
  readonly fg: string
  readonly bg: string
  readonly border: string
  readonly accent: string
}

const CHURN_KIND_META: Record<ChurnKind, ChurnKindMeta> = {
  SHARP_DETERRENCE: {
    id: "SHARP_DETERRENCE",
    label: "Sharp Deterrence",
    description: "Desired sharp / originator attrition under shade & delay",
    fg: "#4ade80",
    bg: "rgba(34, 197, 94, 0.14)",
    border: "rgba(34, 197, 94, 0.4)",
    accent: "#22c55e",
  },
  SYNDICATE_MIGRATION: {
    id: "SYNDICATE_MIGRATION",
    label: "Syndicate Migration",
    description: "High-correlation accounts likely to rotate into proxy beards",
    fg: "#fcd34d",
    bg: "rgba(245, 158, 11, 0.15)",
    border: "rgba(245, 158, 11, 0.45)",
    accent: "#f59e0b",
  },
  LIMIT_CAPPED_EXIT: {
    id: "LIMIT_CAPPED_EXIT",
    label: "Limit-Capped Exit",
    description: "Simulated stake cap drops below bettor's historical mean stake",
    fg: "#c4b5fd",
    bg: "rgba(139, 92, 246, 0.15)",
    border: "rgba(139, 92, 246, 0.45)",
    accent: "#a78bfa",
  },
  VIP_FRICTION_BLEED: {
    id: "VIP_FRICTION_BLEED",
    label: "VIP / Rec Bleed",
    description: "Unintended churn on recreational or positive-hold LTV accounts",
    fg: "#fca5a5",
    bg: "rgba(239, 68, 68, 0.16)",
    border: "rgba(239, 68, 68, 0.45)",
    accent: "#ef4444",
  },
  RETAINED_CORE: {
    id: "RETAINED_CORE",
    label: "Retained Core",
    description: "Account remains active below churn threshold under current levers",
    fg: "#7dd3fc",
    bg: "rgba(56, 189, 248, 0.12)",
    border: "rgba(56, 189, 248, 0.35)",
    accent: "#38bdf8",
  },
}

const CHURN_KEY_META: Record<ChurnKey, { readonly short: string; readonly hint: string }> = {
  KEY_SHADE_SENSITIVITY: {
    short: "SHADE_SENSITIVITY",
    hint: "Line shade delta erodes bettor's CLV margin",
  },
  KEY_LIMIT_BELOW_MEAN_STAKE: {
    short: "LIMIT_BELOW_MEAN",
    hint: "Simulated stake cap drops under historical mean stake",
  },
  KEY_DELAY_STEAM_BLOCK: {
    short: "DELAY_STEAM_BLOCK",
    hint: "In-play bet delay neutralizes steam-chasing timing edge",
  },
  KEY_CORRELATED_EXPLOIT: {
    short: "CORRELATED_EXPLOIT",
    hint: "High correlated exploit rate signals multi-leg/ring rotation",
  },
  KEY_SUBACCOUNT_SPILLOVER: {
    short: "SUBACCOUNT_SPILLOVER",
    hint: "High syndicate probability or sub-account index warns of beard migration",
  },
  KEY_VIP_HOLD_BLEED: {
    short: "VIP_HOLD_BLEED",
    hint: "Recreational/profitable-to-book LTV at risk from blanket friction",
  },
}

const CHURN_POLICY_PRESETS = [
  {
    id: "surgical",
    label: "Surgical Sharp Deterrence",
    shade: 8,
    limitCut: 50,
    delay: 4,
    tier: "SHARP" as const,
  },
  {
    id: "steam-freeze",
    label: "Steam Chaser Freeze",
    shade: 5,
    limitCut: 25,
    delay: 8,
    tier: "ALL" as const,
  },
  {
    id: "vip-shield",
    label: "VIP Retention Shield",
    shade: 2,
    limitCut: 10,
    delay: 1,
    tier: "ALL" as const,
  },
  {
    id: "book-lock",
    label: "Aggressive Book Lock",
    shade: 18,
    limitCut: 70,
    delay: 7,
    tier: "ALL" as const,
  },
] as const

export interface BettorChurnSimulationPanelProps {
  readonly customers: readonly ShowcaseCustomer[]
  readonly wagers?: readonly LiveWager[]
  readonly onSelectCustomer: (customer: ShowcaseCustomer) => void
  readonly onSelectAgent?: (agentId: string) => void
}

export function BettorChurnSimulationPanel({
  customers,
  wagers = [],
  onSelectCustomer,
  onSelectAgent,
}: BettorChurnSimulationPanelProps): React.ReactElement {
  const [extraShadeCents, setExtraShadeCents] = useState<number>(6)
  const [limitCutPct, setLimitCutPct] = useState<number>(35)
  const [extraDelaySec, setExtraDelaySec] = useState<number>(3)
  const [tierScope, setTierScope] = useState<"ALL" | "SHARP" | "SEMI" | "RECREATIONAL">("ALL")
  const [kindFilter, setKindFilter] = useState<"ALL" | ChurnKind>("ALL")
  const [keyFilter, setKeyFilter] = useState<"ALL" | ChurnKey>("ALL")

  const liveRiskByCustomer = useMemo(() => {
    const map = new Map<string, number>()
    for (const w of wagers) {
      const id = w.customerId.toUpperCase()
      map.set(id, (map.get(id) ?? 0) + w.riskUsd)
    }
    return map
  }, [wagers])

  const scopedCustomers = useMemo(() => {
    return customers.filter((c) => {
      if (tierScope === "ALL") return true
      if (tierScope === "SHARP") {
        return c.tier === "TIER_1_ELITE_ORIGINATOR" || c.tier === "TIER_2_STEAM_SYNDICATE"
      }
      if (tierScope === "SEMI") {
        return c.tier === "TIER_3_SHARP_DISCIPLINED" || c.tier === "TIER_4_SEMI_SHARP"
      }
      return c.tier === "TIER_5_RECREATIONAL"
    })
  }, [customers, tierScope])

  const allSimulationRows = useMemo(() => {
    return scopedCustomers
      .map((c) => {
        const isSharp = c.tier === "TIER_1_ELITE_ORIGINATOR" || c.tier === "TIER_2_STEAM_SYNDICATE"
        const isRecreational = c.tier === "TIER_5_RECREATIONAL"

        const shadeElasticity = isSharp ? 2.4 : isRecreational ? 0.55 : 1.35
        const limitElasticity = isSharp ? 0.65 : isRecreational ? 0.2 : 0.4
        const delayElasticity =
          c.timingArchetype === "STEAM_CHASER" ? 5.2 : isSharp ? 3.1 : isRecreational ? 1.1 : 2.0

        const shadeContribution = extraShadeCents * shadeElasticity
        const limitContribution = limitCutPct * limitElasticity
        const delayContribution = extraDelaySec * delayElasticity

        const churnProbPct = Math.min(
          98,
          Math.max(2, Math.round(shadeContribution + limitContribution + delayContribution)),
        )
        const simulatedLimitUsd = Math.max(
          50,
          Math.round(c.recommendedLimitUsd * (1 - limitCutPct / 100)),
        )
        const limitBelowMeanStake = c.meanStake > 0 && simulatedLimitUsd < c.meanStake

        // Derive diagnostic Churn Keys
        const keys: ChurnKey[] = []
        if (extraShadeCents >= 5 && (isSharp || c.clvScore >= 60 || shadeContribution >= 14)) {
          keys.push("KEY_SHADE_SENSITIVITY")
        }
        if (limitBelowMeanStake || limitContribution >= 22) {
          keys.push("KEY_LIMIT_BELOW_MEAN_STAKE")
        }
        if (extraDelaySec >= 3 && (c.timingArchetype === "STEAM_CHASER" || c.timingScore >= 65)) {
          keys.push("KEY_DELAY_STEAM_BLOCK")
        }
        if (
          c.correlatedRisk === "HIGH" ||
          c.correlatedRisk === "CRITICAL" ||
          c.correlatedExploitRate >= 0.2
        ) {
          keys.push("KEY_CORRELATED_EXPLOIT")
        }
        if (c.syndicateRisk === "HIGH" || c.syndicateProb >= 0.55 || c.subAccountIndex !== null) {
          keys.push("KEY_SUBACCOUNT_SPILLOVER")
        }
        if ((isRecreational || c.holdPct >= 3) && churnProbPct >= 22) {
          keys.push("KEY_VIP_HOLD_BLEED")
        }

        // Classify Churn Kind
        let kind: ChurnKind = "RETAINED_CORE"
        if (churnProbPct >= 25) {
          if (isRecreational || (c.holdPct >= 4 && !isSharp)) {
            kind = "VIP_FRICTION_BLEED"
          } else if (
            keys.includes("KEY_SUBACCOUNT_SPILLOVER") ||
            keys.includes("KEY_CORRELATED_EXPLOIT")
          ) {
            kind = "SYNDICATE_MIGRATION"
          } else if (isSharp) {
            kind = "SHARP_DETERRENCE"
          } else if (limitBelowMeanStake || limitCutPct >= 40) {
            kind = "LIMIT_CAPPED_EXIT"
          } else {
            kind = "SHARP_DETERRENCE"
          }
        }

        const retainedLtvUsd = Math.round(c.ltvUsd * (1 - churnProbPct / 100))
        const ltvAtRiskUsd = Math.max(0, Math.round(c.ltvUsd - retainedLtvUsd))
        const varReductionUsd = Math.round(c.var95Usd * (churnProbPct / 100) * 0.85)
        const liveOpenRiskUsd = liveRiskByCustomer.get(c.id.toUpperCase()) ?? 0

        return {
          customer: c,
          isSharp,
          isRecreational,
          churnProbPct,
          simulatedLimitUsd,
          limitBelowMeanStake,
          retainedLtvUsd,
          ltvAtRiskUsd,
          varReductionUsd,
          liveOpenRiskUsd,
          kind,
          keys,
        }
      })
      .sort((a, b) => b.churnProbPct - a.churnProbPct)
  }, [scopedCustomers, extraShadeCents, limitCutPct, extraDelaySec, liveRiskByCustomer])

  const kindBreakdown = useMemo(() => {
    const order: ChurnKind[] = [
      "SHARP_DETERRENCE",
      "SYNDICATE_MIGRATION",
      "LIMIT_CAPPED_EXIT",
      "VIP_FRICTION_BLEED",
      "RETAINED_CORE",
    ]
    return order.map((kind) => {
      const rows = allSimulationRows.filter((r) => r.kind === kind)
      return {
        meta: CHURN_KIND_META[kind],
        count: rows.length,
        varSavedUsd: rows.reduce((s, r) => s + r.varReductionUsd, 0),
        ltvAtRiskUsd: rows.reduce((s, r) => s + r.ltvAtRiskUsd, 0),
      }
    })
  }, [allSimulationRows])

  const keyCounts = useMemo(() => {
    const counts = new Map<ChurnKey, number>()
    for (const key of Object.keys(CHURN_KEY_META) as ChurnKey[]) {
      counts.set(key, 0)
    }
    for (const row of allSimulationRows) {
      for (const k of row.keys) {
        counts.set(k, (counts.get(k) ?? 0) + 1)
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [allSimulationRows])

  const filteredSimulationRows = useMemo(() => {
    return allSimulationRows.filter((row) => {
      if (kindFilter !== "ALL" && row.kind !== kindFilter) return false
      if (keyFilter !== "ALL" && !row.keys.includes(keyFilter)) return false
      return true
    })
  }, [allSimulationRows, kindFilter, keyFilter])

  const summary = useMemo(() => {
    const sharps = allSimulationRows.filter((r) => r.isSharp)
    const recs = allSimulationRows.filter((r) => r.isRecreational)
    const migrations = allSimulationRows.filter((r) => r.kind === "SYNDICATE_MIGRATION")
    const vipBleeds = allSimulationRows.filter((r) => r.kind === "VIP_FRICTION_BLEED")
    const avgSharpChurn =
      sharps.length > 0 ? sharps.reduce((s, r) => s + r.churnProbPct, 0) / sharps.length : 0
    const avgRecRetention =
      recs.length > 0 ? 100 - recs.reduce((s, r) => s + r.churnProbPct, 0) / recs.length : 100
    const totalVarSaved = allSimulationRows.reduce((s, r) => s + r.varReductionUsd, 0)
    const projectedHoldLiftBps = Math.round(
      extraShadeCents * 18 + limitCutPct * 0.9 + extraDelaySec * 7,
    )
    return {
      avgSharpChurn,
      avgRecRetention,
      totalVarSaved,
      projectedHoldLiftBps,
      migrationCount: migrations.length,
      vipBleedCount: vipBleeds.length,
    }
  }, [allSimulationRows, extraShadeCents, limitCutPct, extraDelaySec])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      {/* Header & Tier Scope + Policy Presets */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          padding: "14px 18px",
          backgroundColor: "#0d1527",
          border: "1px solid #1e293b",
          borderRadius: "8px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Activity size={18} style={{ color: "#38bdf8" }} />
            <div>
              <h2
                style={{
                  margin: 0,
                  fontSize: "16px",
                  fontWeight: 700,
                  color: "#f8fafc",
                }}
              >
                Bettor Churn Simulation — Keys &amp; Kinds
              </h2>
              <div style={{ fontSize: "12px", color: "#94a3b8" }}>
                Counterfactual elasticity across {scopedCustomers.length} profiled bettors —
                separates sharp deterrence, syndicate migration, limit-capped exits, and VIP bleed.
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {(
              [
                { id: "ALL", label: "All Tiers" },
                { id: "SHARP", label: "Tier 1–2 Sharp" },
                { id: "SEMI", label: "Tier 3–4 Semi-Sharp" },
                { id: "RECREATIONAL", label: "Tier 5 Rec" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setTierScope(opt.id)}
                style={{
                  padding: "5px 10px",
                  borderRadius: "6px",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  backgroundColor: tierScope === opt.id ? "rgba(56, 189, 248, 0.16)" : "#070b14",
                  color: tierScope === opt.id ? "#7dd3fc" : "#94a3b8",
                  border: tierScope === opt.id ? "1px solid #38bdf8" : "1px solid #1e293b",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Policy Presets Strip */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "6px",
            paddingTop: "10px",
            borderTop: "1px solid rgba(30, 41, 59, 0.8)",
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              fontSize: "11px",
              fontWeight: 700,
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginRight: "4px",
            }}
          >
            <Sparkles size={12} style={{ color: "#38bdf8" }} />
            Policy Presets:
          </span>
          {CHURN_POLICY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                setExtraShadeCents(preset.shade)
                setLimitCutPct(preset.limitCut)
                setExtraDelaySec(preset.delay)
                setTierScope(preset.tier)
              }}
              style={{
                padding: "4px 9px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 600,
                backgroundColor: "#070b14",
                color: "#cbd5e1",
                border: "1px solid #334155",
                cursor: "pointer",
              }}
            >
              {preset.label}{" "}
              <span style={{ color: "#64748b", fontWeight: 500 }}>
                (+{preset.shade}¢ / -{preset.limitCut}% / +{preset.delay}s)
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Interactive Policy Controls */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "14px",
          padding: "16px",
          backgroundColor: "#0d1527",
          border: "1px solid #1e293b",
          borderRadius: "8px",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "12px",
              color: "#cbd5e1",
              fontWeight: 600,
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <Sliders size={13} style={{ color: "#38bdf8" }} />
              Line Shade Delta
            </span>
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                color: "#38bdf8",
              }}
            >
              +{extraShadeCents}¢
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={25}
            step={1}
            value={extraShadeCents}
            onChange={(e) => setExtraShadeCents(Number(e.target.value))}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "12px",
              color: "#cbd5e1",
              fontWeight: 600,
            }}
          >
            <span>Max Stake Limit Cut</span>
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                color: "#fbbf24",
              }}
            >
              -{limitCutPct}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={80}
            step={5}
            value={limitCutPct}
            onChange={(e) => setLimitCutPct(Number(e.target.value))}
          />
        </label>

        <label style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "12px",
              color: "#cbd5e1",
              fontWeight: 600,
            }}
          >
            <span>In-Play Bet Delay</span>
            <span
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                color: "#4ade80",
              }}
            >
              +{extraDelaySec}s
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={10}
            step={1}
            value={extraDelaySec}
            onChange={(e) => setExtraDelaySec(Number(e.target.value))}
          />
        </label>
      </div>

      {/* Simulation Output KPIs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "12px",
        }}
      >
        {[
          {
            label: "Sharp Attrition (T1–T2)",
            value: `${summary.avgSharpChurn.toFixed(1)}%`,
            sub: `${summary.migrationCount} flagged for syndicate migration`,
            accent: "#f59e0b",
          },
          {
            label: "Recreational Retention (T5)",
            value: `${summary.avgRecRetention.toFixed(1)}%`,
            sub: `${summary.vipBleedCount} VIP / rec bleed alerts`,
            accent: summary.vipBleedCount > 0 ? "#ef4444" : "#4ade80",
          },
          {
            label: "Projected VaR95 Reduction",
            value: formatUsd(summary.totalVarSaved),
            sub: "Estimated tail-risk exposure removed",
            accent: "#38bdf8",
          },
          {
            label: "Projected Hold Lift",
            value: `+${summary.projectedHoldLiftBps} bps`,
            sub: "Estimated net margin gain under active levers",
            accent: "#a78bfa",
          },
        ].map((card) => (
          <div
            key={card.label}
            style={{
              backgroundColor: "#0d1527",
              borderTop: "1px solid #1e293b",
              borderRight: "1px solid #1e293b",
              borderBottom: "1px solid #1e293b",
              borderLeft: `3px solid ${card.accent}`,
              borderRadius: "8px",
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "#94a3b8",
              }}
            >
              {card.label}
            </span>
            <span
              style={{
                fontSize: "24px",
                fontWeight: 700,
                color: "#f8fafc",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }}
            >
              {card.value}
            </span>
            <span style={{ fontSize: "11px", color: "#64748b" }}>{card.sub}</span>
          </div>
        ))}
      </div>

      {/* Churn Kinds & Churn Keys Breakdown Panel */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
          gap: "14px",
        }}
      >
        {/* Churn Kinds Distribution */}
        <div
          style={{
            backgroundColor: "#0d1527",
            border: "1px solid #1e293b",
            borderRadius: "8px",
            padding: "14px 16px",
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
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "13px",
                fontWeight: 700,
                color: "#f8fafc",
              }}
            >
              <Layers size={14} style={{ color: "#38bdf8" }} />
              Churn Kinds (Click to filter)
            </span>
            {kindFilter !== "ALL" && (
              <button
                type="button"
                onClick={() => setKindFilter("ALL")}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#38bdf8",
                  cursor: "pointer",
                }}
              >
                Reset kind
              </button>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {kindBreakdown.map(({ meta, count, varSavedUsd, ltvAtRiskUsd }) => {
              const active = kindFilter === meta.id
              return (
                <button
                  key={meta.id}
                  type="button"
                  onClick={() => setKindFilter(active ? "ALL" : meta.id)}
                  style={{
                    width: "100%",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px 10px",
                    borderRadius: "6px",
                    textAlign: "left",
                    cursor: "pointer",
                    backgroundColor: active ? meta.bg : "#070b14",
                    borderTop: `1px solid ${active ? meta.border : "#1e293b"}`,
                    borderRight: `1px solid ${active ? meta.border : "#1e293b"}`,
                    borderBottom: `1px solid ${active ? meta.border : "#1e293b"}`,
                    borderLeft: `3px solid ${meta.accent}`,
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        fontSize: "12px",
                        fontWeight: 700,
                        color: meta.fg,
                      }}
                    >
                      <span>{meta.label}</span>
                      <span
                        style={{
                          fontSize: "10px",
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          color: "#94a3b8",
                          fontWeight: 600,
                        }}
                      >
                        ({count})
                      </span>
                    </div>
                    <div style={{ fontSize: "11px", color: "#64748b" }}>{meta.description}</div>
                  </div>
                  <div
                    style={{
                      textAlign: "right",
                      flexShrink: 0,
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: "11px",
                    }}
                  >
                    <div style={{ color: "#4ade80", fontWeight: 700 }}>
                      -{formatUsd(varSavedUsd)} VaR
                    </div>
                    <div style={{ color: "#94a3b8", fontSize: "10px" }}>
                      {formatUsd(ltvAtRiskUsd)} LTV
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Churn Keys Matrix */}
        <div
          style={{
            backgroundColor: "#0d1527",
            border: "1px solid #1e293b",
            borderRadius: "8px",
            padding: "14px 16px",
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
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "13px",
                fontWeight: 700,
                color: "#f8fafc",
              }}
            >
              <KeyRound size={14} style={{ color: "#fbbf24" }} />
              Churn Driver Keys (Click to isolate)
            </span>
            {keyFilter !== "ALL" && (
              <button
                type="button"
                onClick={() => setKeyFilter("ALL")}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#38bdf8",
                  cursor: "pointer",
                }}
              >
                Reset key
              </button>
            )}
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "8px",
            }}
          >
            {keyCounts.map(([key, count]) => {
              const info = CHURN_KEY_META[key]
              const active = keyFilter === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setKeyFilter(active ? "ALL" : key)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    padding: "9px 10px",
                    borderRadius: "6px",
                    textAlign: "left",
                    cursor: "pointer",
                    backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "#070b14",
                    border: active ? "1px solid #38bdf8" : "1px solid #1e293b",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        fontSize: "10px",
                        fontWeight: 700,
                        color: active ? "#7dd3fc" : "#e2e8f0",
                      }}
                    >
                      {info.short}
                    </span>
                    <span
                      style={{
                        fontFamily:
                          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                        fontSize: "11px",
                        fontWeight: 700,
                        color: count > 0 ? "#fbbf24" : "#64748b",
                      }}
                    >
                      {count}
                    </span>
                  </div>
                  <span
                    style={{
                      fontSize: "11px",
                      color: "#94a3b8",
                      lineHeight: 1.35,
                    }}
                  >
                    {info.hint}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Per-Account Simulation Table */}
      <div
        style={{
          backgroundColor: "#0d1527",
          border: "1px solid #1e293b",
          borderRadius: "8px",
          padding: "16px",
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
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Fingerprint size={15} style={{ color: "#38bdf8" }} />
            <h3
              style={{
                margin: 0,
                fontSize: "13px",
                fontWeight: 700,
                color: "#f8fafc",
              }}
            >
              Simulated Bettor Cohort ({filteredSimulationRows.length} matching accounts)
            </h3>
          </div>
          {(kindFilter !== "ALL" || keyFilter !== "ALL") && (
            <button
              type="button"
              onClick={() => {
                setKindFilter("ALL")
                setKeyFilter("ALL")
              }}
              style={{
                padding: "4px 9px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 600,
                backgroundColor: "#1e293b",
                color: "#e2e8f0",
                border: "1px solid #334155",
                cursor: "pointer",
              }}
            >
              Clear Kind/Key Filters
            </button>
          )}
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Customer / Agent</th>
                <th style={styles.th}>Churn Kind</th>
                <th style={styles.th}>Trigger Keys</th>
                <th style={styles.th}>Limit (Curr → Sim)</th>
                <th style={styles.th}>Live Risk / Hold</th>
                <th style={styles.th}>Churn Prob.</th>
                <th style={styles.th}>VaR95 Saved</th>
              </tr>
            </thead>
            <tbody>
              {filteredSimulationRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    style={{
                      ...styles.td,
                      textAlign: "center",
                      color: "#64748b",
                      padding: "20px",
                    }}
                  >
                    No bettors match the active Churn Kind and Key filters.
                  </td>
                </tr>
              ) : (
                filteredSimulationRows.slice(0, 25).map((row) => {
                  const kindMeta = CHURN_KIND_META[row.kind]
                  return (
                    <tr
                      key={row.customer.id}
                      onClick={() => onSelectCustomer(row.customer)}
                      style={{ cursor: "pointer" }}
                    >
                      <td style={styles.td}>
                        <div
                          style={{
                            fontFamily:
                              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                            fontWeight: 700,
                            color: "#38bdf8",
                          }}
                        >
                          {row.customer.id}
                        </div>
                        <div style={{ fontSize: "10px", color: "#64748b" }}>
                          {onSelectAgent ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                onSelectAgent(row.customer.agentId)
                              }}
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                color: "#94a3b8",
                                fontSize: "10px",
                                cursor: "pointer",
                                textDecoration: "underline",
                              }}
                            >
                              {row.customer.agentId}
                            </button>
                          ) : (
                            row.customer.agentId
                          )}{" "}
                          · {row.customer.tierLabel ?? row.customer.tier.replace(/^TIER_\d+_/, "")}
                        </div>
                      </td>
                      <td style={styles.td}>
                        <span
                          style={{
                            display: "inline-block",
                            fontSize: "10px",
                            fontWeight: 700,
                            padding: "2px 7px",
                            borderRadius: "4px",
                            whiteSpace: "nowrap",
                            color: kindMeta.fg,
                            backgroundColor: kindMeta.bg,
                            border: `1px solid ${kindMeta.border}`,
                          }}
                        >
                          {kindMeta.label}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "4px",
                            maxWidth: "280px",
                          }}
                        >
                          {row.keys.length === 0 ? (
                            <span style={{ fontSize: "10px", color: "#64748b" }}>NONE</span>
                          ) : (
                            row.keys.map((k) => (
                              <span
                                key={k}
                                title={CHURN_KEY_META[k].hint}
                                style={{
                                  fontFamily:
                                    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                  fontSize: "9px",
                                  fontWeight: 600,
                                  padding: "1px 5px",
                                  borderRadius: "4px",
                                  backgroundColor: "#070b14",
                                  color:
                                    k === "KEY_VIP_HOLD_BLEED"
                                      ? "#fca5a5"
                                      : k === "KEY_SUBACCOUNT_SPILLOVER" ||
                                          k === "KEY_CORRELATED_EXPLOIT"
                                        ? "#fcd34d"
                                        : "#cbd5e1",
                                  border: "1px solid #334155",
                                }}
                              >
                                {CHURN_KEY_META[k].short}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontSize: "11px",
                        }}
                      >
                        <span style={{ color: "#94a3b8" }}>
                          {formatUsd(row.customer.recommendedLimitUsd)}
                        </span>
                        <span style={{ color: "#64748b" }}> → </span>
                        <span
                          style={{
                            color: row.limitBelowMeanStake ? "#f87171" : "#fbbf24",
                            fontWeight: 700,
                          }}
                        >
                          {formatUsd(row.simulatedLimitUsd)}
                        </span>
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          fontSize: "11px",
                        }}
                      >
                        <div
                          style={{
                            color: row.liveOpenRiskUsd > 0 ? "#38bdf8" : "#64748b",
                          }}
                        >
                          {row.liveOpenRiskUsd > 0 ? `${formatUsd(row.liveOpenRiskUsd)} live` : "—"}
                        </div>
                        <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                          Hold {row.customer.holdPct.toFixed(1)}%
                        </div>
                      </td>
                      <td style={styles.td}>
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
                              borderRadius: "999px",
                              backgroundColor: "#070b14",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${row.churnProbPct}%`,
                                height: "100%",
                                backgroundColor:
                                  row.churnProbPct >= 60
                                    ? "#f87171"
                                    : row.churnProbPct >= 30
                                      ? "#fbbf24"
                                      : "#4ade80",
                              }}
                            />
                          </div>
                          <span
                            style={{
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              fontWeight: 700,
                              fontSize: "11px",
                              color:
                                row.churnProbPct >= 60
                                  ? "#f87171"
                                  : row.churnProbPct >= 30
                                    ? "#fbbf24"
                                    : "#4ade80",
                            }}
                          >
                            {row.churnProbPct}%
                          </span>
                        </div>
                      </td>
                      <td
                        style={{
                          ...styles.td,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                          color: "#4ade80",
                          fontWeight: 700,
                        }}
                      >
                        {formatUsd(row.varReductionUsd)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 3. System Logs Panel
// ---------------------------------------------------------------------------

export interface SystemLogsPanelProps {
  readonly alertRecords: readonly DashboardAlertRecord[]
  readonly terminalHistory: readonly TerminalHistoryEntry[]
  readonly r2PipelineData: R2PipelineApiResponse | null
  readonly healthData: HealthData | null
  readonly wagersProvenance: DashboardSourceProvenance
  readonly onNavigateTab: (tab: "alerts" | "terminal" | "r2") => void
  readonly onRunTerminalCommand?: ((cmd: string) => void) | undefined
  readonly weblogSeverityFilter?: WebLogSeverityFilter | undefined
  readonly onWeblogSeverityFilterChange?: ((severity: WebLogSeverityFilter) => void) | undefined
  readonly onWeblogSeverityCountsChange?: ((counts: WebLogSeverityCounts) => void) | undefined
}

type UnifiedLogRow = UnifiedSystemLogRow

type UnifiedLogSortField = "timestamp" | "severity" | "customerId" | "ipCategory" | "source"

function parseUnifiedLogEpoch(raw: string): number {
  const trimmed = raw.trim()
  if (!trimmed) return Number.NaN
  return Date.parse(trimmed)
}

function formatUnifiedLogTimestamp(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return "—"
  const parsed = Date.parse(trimmed)
  if (!Number.isNaN(parsed)) {
    const iso = new Date(parsed).toISOString()
    return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`
  }
  return trimmed.replace(/^(\d{4}-\d{2}-\d{2})T/, "$1 ")
}

export function SystemLogsPanel({
  alertRecords,
  terminalHistory,
  r2PipelineData,
  healthData,
  wagersProvenance,
  onNavigateTab,
  onRunTerminalCommand,
  weblogSeverityFilter,
  onWeblogSeverityFilterChange,
  onWeblogSeverityCountsChange,
}: SystemLogsPanelProps): React.ReactElement {
  const [logMode, setLogMode] = useState<"weblogs" | "unified">("weblogs")

  // External store held in a ref so typing or toggling severity bits never
  // triggers full React re-renders of SystemLogsPanel or table rows.
  const bitwiseStoreRef = useRef<BitwiseLogFilterStore | null>(null)
  if (bitwiseStoreRef.current === null) {
    bitwiseStoreRef.current = new BitwiseLogFilterStore()
  }
  const bitwiseStore = bitwiseStoreRef.current
  const unifiedTbodyRef = useRef<HTMLTableSectionElement | null>(null)
  const weblogExportRef = useRef<(() => number) | null>(null)
  const weblogRefreshRef = useRef<(() => void) | null>(null)
  const [weblogSnapshot, setWeblogSnapshot] = useState<WebLogSnapshot>({
    entries: [],
    loading: true,
    bitwiseIndex: buildBitwiseLogIndex(
      [],
      () => 0,
      () => "",
    ),
  })

  const handleWeblogSnapshot = useCallback((snapshot: WebLogSnapshot) => {
    setWeblogSnapshot(snapshot)
  }, [])

  useEffect(() => {
    if (weblogSeverityFilter && weblogSeverityFilter !== "ALL") {
      setLogMode("weblogs")
    }
  }, [weblogSeverityFilter])

  const [sortField, setSortField] = useState<UnifiedLogSortField>("timestamp")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")

  const handleUnifiedSort = (field: UnifiedLogSortField) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === "desc" ? "asc" : "desc"))
    } else {
      setSortField(field)
      setSortDir(
        field === "customerId" || field === "ipCategory" || field === "source" ? "asc" : "desc",
      )
    }
  }

  const logs = useMemo<UnifiedLogRow[]>(() => {
    const rows: UnifiedLogRow[] = []

    for (const alert of alertRecords) {
      const alertIpCategory =
        alert.tier === "ORIGINATOR_HIGH_RISK"
          ? "PROXY_EXIT"
          : alert.tier === "LATENCY_ARB"
            ? "DATACENTER"
            : alert.tier === "STEAM_MOVE"
              ? "HOSTING_RELAY"
              : "RESIDENTIAL"
      rows.push({
        id: `alert:${alert.deliveryId}`,
        timestamp: alert.updatedAt || alert.createdAt,
        level: alert.status === "dead" ? "ERROR" : alert.status === "queued" ? "WARN" : "INFO",
        customerId: alert.payload.customerId || "—",
        ipCategory: alertIpCategory,
        source: "ALERTS",
        message: `[${alert.status.toUpperCase()}] ${alert.tier} · ${alert.payload.customerId} (${alert.wagerId})${alert.finalError ? ` — ${alert.finalError}` : ""}`,
      })
    }

    for (const sink of r2PipelineData?.sinks ?? []) {
      rows.push({
        id: `r2:${sink.id}`,
        timestamp: sink.lastModified ?? r2PipelineData?.observedAt ?? "",
        level:
          sink.state === "error" || sink.state === "missing"
            ? "ERROR"
            : sink.state === "stale"
              ? "WARN"
              : "INFO",
        customerId: "—",
        ipCategory: "CLOUD_CDN",
        source: "R2",
        message: `Sink ${sink.label} (${sink.state.toUpperCase()})${sink.diagnostic ? ` — ${sink.diagnostic.headline}` : ""}`,
      })
    }

    for (const [idx, entry] of terminalHistory.entries()) {
      const cmdMatch = /^(?:profile|p|weblogs|weblog)\s+([A-Z0-9._-]{3,16})/i.exec(
        entry.command.trim(),
      )
      const isIpArg = cmdMatch !== null && /^\d{1,3}(\.\d{1,3}){3}$/.test(cmdMatch[1]!)
      rows.push({
        id: `pty:${idx}:${entry.timestamp}`,
        timestamp:
          typeof entry.timestamp === "number"
            ? new Date(entry.timestamp).toISOString()
            : String(entry.timestamp),
        level: entry.exitCode !== 0 ? "ERROR" : "INFO",
        customerId: cmdMatch && !isIpArg ? cmdMatch[1]!.toUpperCase() : "—",
        ipCategory: isIpArg ? "INSPECT_IP" : "OPERATOR_PTY",
        source: "PTY",
        message: `$ ${entry.command} (exit ${entry.exitCode}, ${entry.durationMs}ms)`,
      })
    }

    rows.push({
      id: "desk:feed",
      timestamp: r2PipelineData?.observedAt ?? new Date().toISOString(),
      level:
        healthData?.operationalStatus === "down"
          ? "ERROR"
          : healthData?.operationalStatus === "degraded"
            ? "WARN"
            : "INFO",
      customerId: "—",
      ipCategory: "DESK_INTERNAL",
      source: "DESK",
      message: `Feed provenance: ${wagersProvenance.label} · Health: ${healthData?.status ?? "ok"}`,
    })

    return rows
  }, [alertRecords, r2PipelineData, terminalHistory, healthData, wagersProvenance])

  const sortedUnifiedLogs = useMemo(() => {
    const severityRank: Record<UnifiedLogRow["level"], number> = {
      INFO: 0,
      WARN: 1,
      ERROR: 2,
    }
    const factor = sortDir === "asc" ? 1 : -1

    return [...logs].sort((a, b) => {
      const compareTimestamps = () => {
        const ta = parseUnifiedLogEpoch(a.timestamp)
        const tb = parseUnifiedLogEpoch(b.timestamp)
        if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb
        if (!Number.isNaN(ta)) return 1
        if (!Number.isNaN(tb)) return -1
        return a.timestamp.localeCompare(b.timestamp)
      }
      let cmp = 0
      switch (sortField) {
        case "severity":
          cmp = severityRank[a.level] - severityRank[b.level] || compareTimestamps()
          break
        case "customerId":
          cmp = a.customerId.localeCompare(b.customerId) || compareTimestamps()
          break
        case "ipCategory":
          cmp = a.ipCategory.localeCompare(b.ipCategory) || compareTimestamps()
          break
        case "source":
          cmp = a.source.localeCompare(b.source) || compareTimestamps()
          break
        case "timestamp":
        default:
          cmp = compareTimestamps()
          break
      }
      return cmp * factor
    })
  }, [logs, sortField, sortDir])

  const unifiedBitwiseIndex = useMemo(
    () =>
      buildBitwiseLogIndex(
        sortedUnifiedLogs,
        (row) => severityLabelToBit(row.level),
        (row) =>
          `${row.timestamp} ${formatUnifiedLogTimestamp(row.timestamp)} ${row.source} ${row.level} ${row.customerId} ${row.ipCategory} ${row.message}`,
      ),
    [sortedUnifiedLogs],
  )

  useBitwiseTableDomFilter({
    tbodyRef: unifiedTbodyRef,
    index: unifiedBitwiseIndex,
    store: logMode === "unified" ? bitwiseStore : null,
  })

  const handleExportFilteredLogsJson = useCallback((): number => {
    if (logMode === "weblogs") {
      return weblogExportRef.current?.() ?? 0
    }
    const snap = bitwiseStore.getSnapshot()
    const filtered = selectBitwiseFilteredRows(sortedUnifiedLogs, unifiedBitwiseIndex, snap.parsed)
    if (filtered.length === 0) return 0

    const payload = buildSystemLogsJsonExportPayload({
      mode: "unified",
      entries: filtered,
      totalRows: sortedUnifiedLogs.length,
      parsedQuery: snap.parsed,
    })
    const filename = buildSystemLogsJsonFilename({
      mode: "unified",
      effectiveMask: snap.parsed.effectiveMask,
      query: snap.rawQuery,
    })
    const ok = downloadSystemLogsJsonBlob(formatSystemLogsJson(payload), filename)
    return ok ? filtered.length : 0
  }, [logMode, bitwiseStore, sortedUnifiedLogs, unifiedBitwiseIndex])

  const unifiedSortIcon = (field: UnifiedLogSortField) => {
    if (sortField !== field) {
      return (
        <ArrowUpDown size={11} style={{ marginLeft: "4px", opacity: 0.45 }} aria-hidden="true" />
      )
    }
    return sortDir === "asc" ? (
      <ArrowUp size={11} style={{ marginLeft: "4px" }} aria-hidden="true" />
    ) : (
      <ArrowDown size={11} style={{ marginLeft: "4px" }} aria-hidden="true" />
    )
  }

  const levelColor = (level: UnifiedLogRow["level"]) => {
    if (level === "ERROR") {
      return {
        fg: "#fca5a5",
        bg: "rgba(239, 68, 68, 0.16)",
        border: "rgba(239, 68, 68, 0.4)",
      }
    }
    if (level === "WARN") {
      return {
        fg: "#fcd34d",
        bg: "rgba(245, 158, 11, 0.16)",
        border: "rgba(245, 158, 11, 0.4)",
      }
    }
    return {
      fg: "#7dd3fc",
      bg: "rgba(56, 189, 248, 0.14)",
      border: "rgba(56, 189, 248, 0.35)",
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
          padding: "14px 18px",
          backgroundColor: "#0d1527",
          border: "1px solid #1e293b",
          borderRadius: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <ScrollText size={18} style={{ color: "#38bdf8" }} />
          <div>
            <h2
              style={{
                margin: 0,
                fontSize: "16px",
                fontWeight: 700,
                color: "#f8fafc",
              }}
            >
              System Logs &amp; Bun.inspect Weblogs
            </h2>
            <div style={{ fontSize: "12px", color: "#94a3b8" }}>
              Fantasy402 IP weblogs, bot-key detail sorting, 6-axis behavioral vectoring &amp;
              unified operational event stream.
            </div>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              backgroundColor: "#070b14",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#1e293b",
              borderRadius: "6px",
              padding: "2px",
              gap: "2px",
            }}
          >
            <button
              type="button"
              onClick={() => setLogMode("weblogs")}
              style={{
                padding: "5px 10px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: "pointer",
                borderWidth: "0px",
                backgroundColor: logMode === "weblogs" ? "rgba(56, 189, 248, 0.2)" : "transparent",
                color: logMode === "weblogs" ? "#7dd3fc" : "#94a3b8",
              }}
            >
              Weblogs &amp; Vectoring
            </button>
            <button
              type="button"
              onClick={() => setLogMode("unified")}
              style={{
                padding: "5px 10px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 700,
                cursor: "pointer",
                borderWidth: "0px",
                backgroundColor: logMode === "unified" ? "rgba(56, 189, 248, 0.2)" : "transparent",
                color: logMode === "unified" ? "#7dd3fc" : "#94a3b8",
              }}
            >
              Unified System Stream ({logs.length})
            </button>
          </div>
          <button
            type="button"
            onClick={() => onNavigateTab("alerts")}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#1e293b",
              color: "#e2e8f0",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            DLQ &amp; Alerts ↗
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab("r2")}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#1e293b",
              color: "#e2e8f0",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            R2 Pipeline ↗
          </button>
          <button
            type="button"
            onClick={() => onNavigateTab("terminal")}
            style={{
              padding: "6px 10px",
              borderRadius: "6px",
              backgroundColor: "#1e293b",
              color: "#e2e8f0",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Terminal (PTY) ↗
          </button>
        </div>
      </div>

      {/* Client-side Bitwise Severity Flag Search Bar (zero full panel re-renders) */}
      <SystemLogBitwiseSearchBar
        store={bitwiseStore}
        mode={logMode}
        onExportJson={handleExportFilteredLogsJson}
      />

      {/* 24-Hour Log Severity Distribution Bar Chart (CRITICAL, HIGH, WATCH, NORMAL) */}
      <SystemLogSeverityBarChart
        mode={logMode}
        weblogEntries={weblogSnapshot.entries}
        unifiedLogs={sortedUnifiedLogs}
        weblogBitwiseIndex={weblogSnapshot.bitwiseIndex}
        unifiedBitwiseIndex={unifiedBitwiseIndex}
        bitwiseStore={bitwiseStore}
        loading={logMode === "weblogs" ? weblogSnapshot.loading : false}
        onRefreshWeblogs={() => weblogRefreshRef.current?.()}
        onSwitchToUnified={() => setLogMode("unified")}
      />

      {logMode === "weblogs" ? (
        <WebLogsInspectorSection
          onOpenTerminal={() => onNavigateTab("terminal")}
          onRunTerminalCommand={onRunTerminalCommand}
          severityFilter={weblogSeverityFilter}
          onSeverityFilterChange={onWeblogSeverityFilterChange}
          onSeverityCountsChange={onWeblogSeverityCountsChange}
          bitwiseFilterStore={bitwiseStore}
          exportFilteredRef={weblogExportRef}
          onWeblogSnapshot={handleWeblogSnapshot}
          refreshRef={weblogRefreshRef}
        />
      ) : (
        <>
          {/* Sortable Log Stream Table */}
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
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "12px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
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
                  {(
                    [
                      { field: "timestamp", label: "Timestamp" },
                      { field: "severity", label: "Severity" },
                      { field: "customerId", label: "Customer ID" },
                      { field: "ipCategory", label: "IP Category" },
                      { field: "source", label: "Source" },
                    ] as const
                  ).map((col) => (
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
                        padding: "9px 12px",
                        color: sortField === col.field ? "#38bdf8" : "#94a3b8",
                        fontSize: "11px",
                        fontWeight: 700,
                        whiteSpace: "nowrap",
                        ...(col.field === "timestamp"
                          ? {
                              minWidth: "205px",
                              width: "215px",
                              maxWidth: "260px",
                            }
                          : {}),
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => handleUnifiedSort(col.field)}
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
                        {unifiedSortIcon(col.field)}
                      </button>
                    </th>
                  ))}
                  <th
                    style={{
                      textAlign: "left",
                      padding: "9px 12px",
                      color: "#94a3b8",
                      fontSize: "11px",
                      fontWeight: 700,
                    }}
                  >
                    Message
                  </th>
                </tr>
              </thead>
              <tbody ref={unifiedTbodyRef}>
                {sortedUnifiedLogs.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      style={{
                        padding: "20px",
                        textAlign: "center",
                        color: "#64748b",
                        fontSize: "12px",
                      }}
                    >
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <AlertTriangle size={14} />
                        No system log entries available.
                      </span>
                    </td>
                  </tr>
                ) : (
                  sortedUnifiedLogs.map((row, rowIdx) => {
                    const tone = levelColor(row.level)
                    return (
                      <tr
                        key={row.id}
                        data-log-idx={rowIdx}
                        style={{
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.75)",
                        }}
                      >
                        <td
                          title={row.timestamp || undefined}
                          style={{
                            padding: "8px 12px",
                            color: "#94a3b8",
                            fontSize: "11px",
                            whiteSpace: "nowrap",
                            fontVariantNumeric: "tabular-nums",
                            minWidth: "205px",
                            width: "215px",
                            maxWidth: "260px",
                          }}
                        >
                          <span
                            style={{
                              display: "block",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              maxWidth: "240px",
                            }}
                          >
                            {formatUnifiedLogTimestamp(row.timestamp)}
                          </span>
                        </td>
                        <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              fontSize: "10px",
                              fontWeight: 700,
                              padding: "2px 6px",
                              borderRadius: "4px",
                              color: tone.fg,
                              backgroundColor: tone.bg,
                              borderWidth: "1px",
                              borderStyle: "solid",
                              borderColor: tone.border,
                            }}
                          >
                            {row.level}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "8px 12px",
                            color: row.customerId !== "—" ? "#f8fafc" : "#64748b",
                            fontWeight: row.customerId !== "—" ? 700 : 400,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.customerId}
                        </td>
                        <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                          <span
                            style={{
                              fontSize: "10px",
                              fontWeight: 700,
                              padding: "2px 6px",
                              borderRadius: "4px",
                              color:
                                row.ipCategory === "PROXY_EXIT"
                                  ? "#fca5a5"
                                  : row.ipCategory === "DATACENTER" ||
                                      row.ipCategory === "HOSTING_RELAY"
                                    ? "#fcd34d"
                                    : "#94a3b8",
                              backgroundColor: "rgba(30, 41, 59, 0.65)",
                              borderWidth: "1px",
                              borderStyle: "solid",
                              borderColor: "#334155",
                            }}
                          >
                            {row.ipCategory}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "8px 12px",
                            fontSize: "10px",
                            fontWeight: 700,
                            color: "#94a3b8",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {row.source}
                        </td>
                        <td
                          style={{
                            padding: "8px 12px",
                            color: "#e2e8f0",
                            wordBreak: "break-word",
                          }}
                        >
                          {row.message}
                        </td>
                      </tr>
                    )
                  })
                )}
                <tr data-bitwise-empty="true" hidden>
                  <td
                    colSpan={6}
                    style={{
                      padding: "20px",
                      textAlign: "center",
                      color: "#64748b",
                      fontSize: "12px",
                    }}
                  >
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      <AlertTriangle size={14} />
                      No system log entries match the active bitwise severity mask and search terms.
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
