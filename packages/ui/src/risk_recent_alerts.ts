/**
 * @file packages/ui/src/risk_recent_alerts.ts
 * @description Builds the chronological 60-minute 'Recent Alerts' feed for the
 * Risk Overview sidebar: replays rolling 60m aggregate risk threshold crossings
 * (Warning & Breach), single-wager cap breaches, CRITICAL/STEAM tickets, and
 * recent alert dispatch records, linking every event to its underlying LiveWager.
 */

import { WAGER_CHANNEL_LABELS, wagerChannelOf } from "@sportsdesk-ops/contracts"

import { sanitizeCaptureText } from "./capture_text.ts"
import { isSentinelWager, parseWagerTimestampMs } from "./handle_volume_series.ts"
import { formatRiskCompactUsd, RISK_WINDOW_MINUTES } from "./risk_exposure_series.ts"
import {
  clampRiskExposureLimitUsd,
  clampRiskExposureWarningLimitUsd,
  DEFAULT_RISK_EXPOSURE_LIMIT_USD,
  RISK_EXPOSURE_WARN_RATIO,
} from "./risk_threshold_alert.ts"
import {
  capUtilizationPct,
  formatImpliedProbability,
  formatImpliedProbabilityFromPayout,
  payoutMultiple,
  ticketQuotedHoldPct,
} from "./ticket_inspector.ts"
import type { DashboardAlertRecord, LiveWager } from "./types.ts"
import {
  formatWagerSelection,
  normalizeAmericanOdds,
  resolveWagerOddsAmerican,
  selectionIncludesLine,
  selectionIncludesOdds,
} from "./wager_display.ts"

const MINUTE_MS = 60_000

export type RecentRiskAlertSeverity = "BREACH" | "WARN"

export type RecentRiskAlertStatusFilter = "ALL" | "WARN" | "BREACH"

export type RecentRiskAlertKind =
  | "THRESHOLD_BREACH"
  | "THRESHOLD_WARNING"
  | "SINGLE_WAGER_BREACH"
  | "SHARP_STEAM_ALERT"
  | "DELIVERY_ALERT"

export interface RecentRiskAlertItem {
  readonly id: string
  readonly kind: RecentRiskAlertKind
  readonly severity: RecentRiskAlertSeverity
  readonly title: string
  readonly detail: string
  readonly timestampMs: number
  readonly clockLabel: string
  readonly relativeAgeLabel: string
  readonly riskUsd: number
  readonly cumulativeRiskUsd: number | null
  readonly thresholdLimitUsd: number | null
  /** 60m breach cap reference alongside `thresholdLimitUsd` (especially on THRESHOLD_WARNING items). */
  readonly breachLimitUsd?: number | null | undefined
  readonly ticketId: string
  readonly customerId: string
  readonly agentId: string | null
  readonly sport: string
  readonly event: string
  readonly selection: string
  readonly oddsAmerican: string | null
  readonly alertTier: LiveWager["alertTier"] | null
  readonly clvCents?: number | null | undefined
  readonly operatorDirective?: string | null | undefined
  readonly deliveryStatus?: DashboardAlertRecord["status"] | null | undefined
  /** Direct reference to the corresponding LiveWager when present on the open tape. */
  readonly linkedWager: LiveWager | null
}

export interface RecentRiskAlertsResult {
  readonly items: readonly RecentRiskAlertItem[]
  readonly breachCount: number
  readonly warnCount: number
  readonly windowStartMs: number
  readonly windowEndMs: number
  readonly windowMode: "live" | "capture"
  readonly breachLimitUsd: number
  readonly warningLimitUsd: number
  readonly totalWindowRiskUsd: number
  readonly thresholdCrossedMs: number | null
  readonly thresholdCrossedTicketId: string | null
  readonly thresholdCrossedClockLabel: string | null
  readonly warningCrossedMs: number | null
}

export interface BuildRecentRiskAlertsInput {
  readonly wagers: readonly LiveWager[]
  readonly alertRecords?: readonly DashboardAlertRecord[] | undefined
  readonly breachLimitUsd?: number | undefined
  readonly warningLimitUsd?: number | undefined
  readonly anchorMs?: number | undefined
  readonly windowMinutes?: number | undefined
  readonly maxItems?: number | undefined
}

function safePositiveUsd(value: number | undefined | null): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value
  }
  return 0
}

function formatClockLabel(epochMs: number): string {
  const d = new Date(epochMs)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

export function formatRelativeAlertAge(eventMs: number, anchorMs: number): string {
  const diffSec = Math.max(0, Math.round((anchorMs - eventMs) / 1000))
  if (diffSec < 15) return "Just now"
  if (diffSec < 60) return `${diffSec}s ago`
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `${hrs}h ${remMins}m ago` : `${hrs}h ago`
}

function formatUsdWhole(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`
}

function parseIsoMs(raw: string | undefined | null, fallbackAnchorMs: number): number | null {
  if (!raw) return null
  const direct = Date.parse(raw)
  if (Number.isFinite(direct)) return direct
  return parseWagerTimestampMs(raw, fallbackAnchorMs)
}

/**
 * Deterministically builds the last-60-minute historical risk breaches and threshold
 * warnings feed linked directly to their corresponding wager details.
 */
export function buildRecentRiskAlerts(input: BuildRecentRiskAlertsInput): RecentRiskAlertsResult {
  const windowMinutes = Math.max(
    1,
    Math.min(180, Math.round(input.windowMinutes ?? RISK_WINDOW_MINUTES)),
  )
  const maxItems = Math.max(5, Math.min(200, Math.round(input.maxItems ?? 50)))
  const nowMs = input.anchorMs ?? Date.now()
  const windowDurationMs = windowMinutes * MINUTE_MS

  const breachLimitUsd = clampRiskExposureLimitUsd(
    input.breachLimitUsd ?? DEFAULT_RISK_EXPOSURE_LIMIT_USD,
  )
  const warningLimitUsd = clampRiskExposureWarningLimitUsd(
    input.warningLimitUsd ?? Math.round(breachLimitUsd * RISK_EXPOSURE_WARN_RATIO),
    breachLimitUsd,
  )

  const wagerById = new Map<string, LiveWager>()
  const parsedWagers: Array<{
    readonly wager: LiveWager
    readonly tsMs: number
    readonly riskUsd: number
  }> = []
  let maxParsedTs = -Infinity

  for (const wager of input.wagers) {
    if (isSentinelWager(wager)) continue
    wagerById.set(wager.ticketId.toUpperCase(), wager)
    const tsMs = parseWagerTimestampMs(wager.timestamp, nowMs)
    if (tsMs === null) continue
    parsedWagers.push({
      wager,
      tsMs,
      riskUsd: safePositiveUsd(wager.riskUsd),
    })
    if (tsMs > maxParsedTs) {
      maxParsedTs = tsMs
    }
  }

  const parsedAlertRecords: Array<{ readonly rec: DashboardAlertRecord; readonly tsMs: number }> =
    []
  for (const rec of input.alertRecords ?? []) {
    const tsMs = parseIsoMs(rec.createdAt || rec.updatedAt, nowMs)
    if (tsMs === null) continue
    parsedAlertRecords.push({ rec, tsMs })
    if (tsMs > maxParsedTs) {
      maxParsedTs = tsMs
    }
  }

  const hasRecentLiveEvent =
    (parsedWagers.length > 0 || parsedAlertRecords.length > 0) &&
    maxParsedTs >= nowMs - windowDurationMs &&
    maxParsedTs <= nowMs + 5 * MINUTE_MS

  const windowMode: "live" | "capture" =
    (parsedWagers.length === 0 && parsedAlertRecords.length === 0) || hasRecentLiveEvent
      ? "live"
      : "capture"

  const effectiveAnchorMs = windowMode === "live" ? nowMs : maxParsedTs
  const windowEndMs = effectiveAnchorMs
  const windowStartMs = windowEndMs - windowDurationMs

  // Filter wagers to the rolling 60-minute window and sort chronologically (oldest -> newest)
  const windowWagers = parsedWagers
    .filter((entry) => entry.tsMs >= windowStartMs && entry.tsMs <= windowEndMs + 5 * MINUTE_MS)
    .sort((a, b) => a.tsMs - b.tsMs || a.wager.ticketId.localeCompare(b.wager.ticketId))

  const alerts: RecentRiskAlertItem[] = []
  const representedTickets = new Set<string>()

  let cumulativeRiskUsd = 0
  let crossedWarning = false
  let crossedBreach = false
  let nextMilestoneRatio = 1.25
  let thresholdCrossedMs: number | null = null
  let thresholdCrossedTicketId: string | null = null
  let warningCrossedMs: number | null = null

  for (const entry of windowWagers) {
    const { wager, tsMs, riskUsd } = entry
    const prevCumulative = cumulativeRiskUsd
    cumulativeRiskUsd += riskUsd

    const ticketKey = wager.ticketId.toUpperCase()
    const isCriticalOrSteam = wager.alertTier === "CRITICAL" || wager.alertTier === "STEAM"
    const isOverMaxStake =
      typeof wager.maxRecommendedStake === "number" &&
      Number.isFinite(wager.maxRecommendedStake) &&
      wager.maxRecommendedStake > 0 &&
      riskUsd > wager.maxRecommendedStake

    const pushWagerAlert = (
      kind: RecentRiskAlertKind,
      severity: RecentRiskAlertSeverity,
      title: string,
      detail: string,
      limitRefUsd: number | null,
      breachRefUsd: number | null = null,
    ) => {
      representedTickets.add(ticketKey)
      alerts.push({
        id: `${kind}:${wager.ticketId}:${tsMs}`,
        kind,
        severity,
        title,
        detail,
        timestampMs: tsMs,
        clockLabel: formatClockLabel(tsMs),
        relativeAgeLabel: formatRelativeAlertAge(tsMs, effectiveAnchorMs),
        riskUsd,
        cumulativeRiskUsd,
        thresholdLimitUsd: limitRefUsd,
        breachLimitUsd: breachRefUsd,
        ticketId: wager.ticketId,
        customerId: wager.customerId,
        agentId: normalizeOptionalField(wager.agentId),
        sport: wager.sport || "OTHER",
        event: wager.event || wager.selection || "Live Market",
        selection: wager.selection || wager.event || "—",
        oddsAmerican: resolveWagerOddsAmerican(wager),
        alertTier: wager.alertTier,
        clvCents: wager.clvCents,
        operatorDirective: wager.operatorDirective || null,
        deliveryStatus: null,
        linkedWager: wager,
      })
    }

    // 1. First crossing into 60-minute aggregate Breach state
    if (!crossedBreach && cumulativeRiskUsd > breachLimitUsd) {
      crossedBreach = true
      crossedWarning = true
      thresholdCrossedMs = tsMs
      thresholdCrossedTicketId = wager.ticketId
      if (warningCrossedMs === null) {
        warningCrossedMs = tsMs
      }
      const excessUsd = cumulativeRiskUsd - breachLimitUsd
      const pct = Math.round((cumulativeRiskUsd / breachLimitUsd) * 100)
      pushWagerAlert(
        "THRESHOLD_BREACH",
        "BREACH",
        "60m Aggregate Risk Limit Breached",
        `Cumulative ${formatUsdWhole(cumulativeRiskUsd)} exceeded ${formatUsdWhole(breachLimitUsd)} cap by +${formatUsdWhole(excessUsd)} (${pct}%).`,
        breachLimitUsd,
        breachLimitUsd,
      )
      while (cumulativeRiskUsd >= breachLimitUsd * nextMilestoneRatio) {
        nextMilestoneRatio += 0.25
      }
      continue
    }

    // 2. First crossing into 60-minute aggregate Warning zone (>= warningLimitUsd, <= breachLimitUsd)
    if (
      !crossedWarning &&
      cumulativeRiskUsd >= warningLimitUsd &&
      cumulativeRiskUsd <= breachLimitUsd
    ) {
      crossedWarning = true
      warningCrossedMs = tsMs
      const pct = Math.round((cumulativeRiskUsd / breachLimitUsd) * 100)
      const remaining = Math.max(0, breachLimitUsd - cumulativeRiskUsd)
      pushWagerAlert(
        "THRESHOLD_WARNING",
        "WARN",
        "60m Warning Threshold Reached",
        `Cumulative ${formatUsdWhole(cumulativeRiskUsd)} crossed ${formatUsdWhole(warningLimitUsd)} warn (${pct}% of cap · ${formatUsdWhole(remaining)} left).`,
        warningLimitUsd,
        breachLimitUsd,
      )
      continue
    }

    // 3. Compounding breach escalation milestone (+25% increments above breach limit)
    if (
      crossedBreach &&
      prevCumulative < breachLimitUsd * nextMilestoneRatio &&
      cumulativeRiskUsd >= breachLimitUsd * nextMilestoneRatio
    ) {
      const excessUsd = cumulativeRiskUsd - breachLimitUsd
      const pct = Math.round((cumulativeRiskUsd / breachLimitUsd) * 100)
      pushWagerAlert(
        "THRESHOLD_BREACH",
        "BREACH",
        `60m Exposure Escalated (${pct}% of Limit)`,
        `Compounding ticket pushed 60m risk to ${formatUsdWhole(cumulativeRiskUsd)} (+${formatUsdWhole(excessUsd)} over ${formatRiskCompactUsd(breachLimitUsd)}).`,
        breachLimitUsd,
        breachLimitUsd,
      )
      while (cumulativeRiskUsd >= breachLimitUsd * nextMilestoneRatio) {
        nextMilestoneRatio += 0.25
      }
      continue
    }

    // 4. Individual over-cap wager breach (stake strictly above recommended max)
    if (isOverMaxStake) {
      const overage = riskUsd - wager.maxRecommendedStake
      pushWagerAlert(
        "SINGLE_WAGER_BREACH",
        "BREACH",
        `Over-Cap Wager · ${wager.sport}`,
        `${formatUsdWhole(riskUsd)} stake exceeded ${formatUsdWhole(wager.maxRecommendedStake)} cap by +${formatUsdWhole(overage)}.`,
        wager.maxRecommendedStake,
      )
      continue
    }

    // 5. Critical / Steam surveillance alert wager
    if (isCriticalOrSteam) {
      const clvSuffix =
        typeof wager.clvCents === "number" && Number.isFinite(wager.clvCents)
          ? ` · ${wager.clvCents >= 0 ? "+" : ""}${wager.clvCents.toFixed(1)}¢ CLV`
          : ""
      pushWagerAlert(
        "SHARP_STEAM_ALERT",
        wager.alertTier === "CRITICAL" ? "BREACH" : "WARN",
        `${wager.alertTier} Alert · ${wager.sport}`,
        `${formatUsdWhole(riskUsd)} ticket flagged (${wager.operatorDirective || wager.alertBadge || wager.alertTier})${clvSuffix}.`,
        null,
      )
    }
  }

  // 6. Merge any real DashboardAlertRecord dispatches from the last 60 minutes not already covered
  for (const entry of parsedAlertRecords) {
    const { rec, tsMs } = entry
    if (tsMs < windowStartMs || tsMs > windowEndMs + 5 * MINUTE_MS) continue
    const key = (rec.wagerId || "").trim().toUpperCase()
    if (key && representedTickets.has(key)) continue

    const linkedWager = key ? (wagerById.get(key) ?? null) : null
    const riskUsd = safePositiveUsd(rec.payload.amountUsd ?? linkedWager?.riskUsd ?? 0)
    const severity: RecentRiskAlertSeverity =
      rec.tier === "CRITICAL" || rec.status === "dead" ? "BREACH" : "WARN"
    const sport = rec.payload.sport || linkedWager?.sport || "LIVE"
    const selection =
      rec.payload.selection || linkedWager?.selection || rec.payload.event || "Alert Ticket"
    const directive =
      rec.payload.directive || linkedWager?.operatorDirective || rec.status.toUpperCase()

    if (key) representedTickets.add(key)
    alerts.push({
      id: `DELIVERY_ALERT:${rec.deliveryId}`,
      kind: "DELIVERY_ALERT",
      severity,
      title: `${rec.tier} Dispatch · ${sport}`,
      detail: `${riskUsd > 0 ? `${formatUsdWhole(riskUsd)} · ` : ""}${directive} (${rec.status}).`,
      timestampMs: tsMs,
      clockLabel: formatClockLabel(tsMs),
      relativeAgeLabel: formatRelativeAlertAge(tsMs, effectiveAnchorMs),
      riskUsd,
      cumulativeRiskUsd: null,
      thresholdLimitUsd: null,
      breachLimitUsd: null,
      ticketId: rec.wagerId || rec.deliveryId.slice(0, 8),
      customerId: rec.payload.customerId || linkedWager?.customerId || "UNKNOWN",
      agentId: normalizeOptionalField(linkedWager?.agentId),
      sport,
      event: rec.payload.event || linkedWager?.event || selection,
      selection,
      oddsAmerican:
        normalizeAmericanOdds(rec.payload.oddsAmerican) ??
        (linkedWager ? resolveWagerOddsAmerican(linkedWager) : null),
      alertTier: rec.tier,
      clvCents:
        typeof rec.payload.clvCents === "number" && Number.isFinite(rec.payload.clvCents)
          ? rec.payload.clvCents
          : (linkedWager?.clvCents ?? null),
      operatorDirective: rec.payload.directive || linkedWager?.operatorDirective || null,
      deliveryStatus: rec.status,
      linkedWager,
    })
  }

  // Sort newest first; break ties by BREACH above WARN, then higher riskUsd
  alerts.sort((a, b) => {
    if (b.timestampMs !== a.timestampMs) return b.timestampMs - a.timestampMs
    if (a.severity !== b.severity) return a.severity === "BREACH" ? -1 : 1
    return b.riskUsd - a.riskUsd
  })

  const bounded = alerts.slice(0, maxItems)
  let breachCount = 0
  let warnCount = 0
  for (const item of bounded) {
    if (item.severity === "BREACH") breachCount += 1
    else warnCount += 1
  }

  return {
    items: bounded,
    breachCount,
    warnCount,
    windowStartMs,
    windowEndMs,
    windowMode,
    breachLimitUsd,
    warningLimitUsd,
    totalWindowRiskUsd: Math.round(cumulativeRiskUsd * 100) / 100,
    thresholdCrossedMs,
    thresholdCrossedTicketId,
    thresholdCrossedClockLabel: thresholdCrossedMs !== null ? formatHm(thresholdCrossedMs) : null,
    warningCrossedMs,
  }
}

/**
 * Isolates a specific alert severity (`ALL`, `WARN`, `BREACH`) while preserving
 * the rolling 60-minute window bounds and USD threshold crossing telemetry so
 * downstream charts keep the vertical threshold marker anchored accurately.
 */
export function filterRecentRiskAlerts(
  feed: RecentRiskAlertsResult,
  statusFilter: RecentRiskAlertStatusFilter,
): RecentRiskAlertsResult {
  if (statusFilter === "ALL") return feed
  const items = feed.items.filter((item) => item.severity === statusFilter)
  return {
    ...feed,
    items,
    breachCount: statusFilter === "BREACH" ? items.length : 0,
    warnCount: statusFilter === "WARN" ? items.length : 0,
  }
}

export const ALERT_TIMELINE_BUCKET_COUNT = 12

export type AlertFrequencyTrend = "escalating" | "easing" | "steady" | "quiet"

export type AlertThresholdMarkerStatus = "crossed" | "approaching" | "armed"

export interface AlertThresholdMarker {
  readonly breachLimitUsd: number
  readonly warningLimitUsd: number
  readonly totalWindowRiskUsd: number
  readonly utilizationPct: number
  readonly status: AlertThresholdMarkerStatus
  /** Exact epoch ms when 60m cumulative risk exceeded breachLimitUsd, or null if not crossed. */
  readonly crossedAtMs: number | null
  /** Normalized [0, 1] position along the 60m time axis (1 when armed/approaching at current edge). */
  readonly normalizedX: number
  /** Bucket index (0..bucketCount-1) containing the crossing, or null when uncrossed. */
  readonly crossedBucketIndex: number | null
  /** Fractional [0, 1] offset inside the crossed bucket for pixel-exact alignment with scaleBand bars. */
  readonly crossedBucketFraction: number
  readonly crossedClockLabel: string | null
  readonly crossedTicketId: string | null
  readonly postThresholdAlertCount: number
  readonly postThresholdBreachCount: number
}

export interface AlertFrequencyBucket {
  readonly index: number
  readonly startMs: number
  readonly endMs: number
  readonly startLabel: string
  readonly endLabel: string
  readonly rangeLabel: string
  readonly relativeLabel: string
  readonly breachCount: number
  readonly warnCount: number
  readonly totalCount: number
  readonly totalRiskUsd: number
  readonly severityScore: number
  readonly isBurst: boolean
}

export interface AlertFrequencySeries {
  readonly buckets: readonly AlertFrequencyBucket[]
  readonly maxBucketTotal: number
  readonly maxSeverityScore: number
  readonly peakBucketIndex: number | null
  readonly peakBucketLabel: string | null
  readonly peakBucketTotal: number
  readonly burstBucketCount: number
  readonly trend: AlertFrequencyTrend
  readonly thresholdMarker: AlertThresholdMarker
}

function formatHm(epochMs: number): string {
  const d = new Date(epochMs)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/**
 * Aggregates historical 60-minute risk breaches and threshold warnings into
 * equal-width time buckets (default 12 × 5m) for D3 frequency/severity visualization.
 */
export function buildRecentAlertFrequencyBuckets(
  result: RecentRiskAlertsResult,
  bucketCount = ALERT_TIMELINE_BUCKET_COUNT,
): AlertFrequencySeries {
  const count = Math.max(4, Math.min(30, Math.round(bucketCount)))
  const spanMs = Math.max(MINUTE_MS, result.windowEndMs - result.windowStartMs)
  const bucketMs = spanMs / count

  const breaches = new Uint32Array(count)
  const warns = new Uint32Array(count)
  const riskSums = new Float64Array(count)

  for (const item of result.items) {
    const rawIdx = Math.floor((item.timestampMs - result.windowStartMs) / bucketMs)
    const idx = Math.max(0, Math.min(count - 1, rawIdx))
    if (item.severity === "BREACH") {
      breaches[idx] = (breaches[idx] ?? 0) + 1
    } else {
      warns[idx] = (warns[idx] ?? 0) + 1
    }
    riskSums[idx] = (riskSums[idx] ?? 0) + item.riskUsd
  }

  let totalEvents = 0
  let maxBucketTotal = 0
  let maxSeverityScore = 0
  let peakBucketIndex: number | null = null
  let peakBucketTotal = 0

  for (let i = 0; i < count; i += 1) {
    const b = breaches[i] ?? 0
    const w = warns[i] ?? 0
    const tot = b + w
    const score = b * 2 + w
    totalEvents += tot
    if (tot > maxBucketTotal) {
      maxBucketTotal = tot
    }
    if (score > maxSeverityScore) {
      maxSeverityScore = score
    }
    if (
      tot > 0 &&
      (peakBucketIndex === null ||
        tot > peakBucketTotal ||
        (tot === peakBucketTotal && b > (breaches[peakBucketIndex] ?? 0)))
    ) {
      peakBucketIndex = i
      peakBucketTotal = tot
    }
  }

  const avgPerBucket = count > 0 ? totalEvents / count : 0
  const buckets: AlertFrequencyBucket[] = []
  let burstBucketCount = 0

  for (let i = 0; i < count; i += 1) {
    const startMs = Math.round(result.windowStartMs + i * bucketMs)
    const endMs = Math.round(result.windowStartMs + (i + 1) * bucketMs)
    const startLabel = formatHm(startMs)
    const endLabel = formatHm(endMs)
    const minutesBack = Math.round(((count - i) * bucketMs) / MINUTE_MS)
    const relativeLabel = i === count - 1 ? "Now" : `-${minutesBack}m`
    const b = breaches[i] ?? 0
    const w = warns[i] ?? 0
    const tot = b + w
    const score = b * 2 + w
    const isBurst = tot >= 2 && tot > avgPerBucket * 1.25
    if (isBurst) burstBucketCount += 1

    buckets.push({
      index: i,
      startMs,
      endMs,
      startLabel,
      endLabel,
      rangeLabel: `${startLabel}–${endLabel}`,
      relativeLabel,
      breachCount: b,
      warnCount: w,
      totalCount: tot,
      totalRiskUsd: Math.round((riskSums[i] ?? 0) * 100) / 100,
      severityScore: score,
      isBurst,
    })
  }

  // Classify recent momentum: compare severity score rate in final quarter (15m) vs prior 3 quarters (45m)
  let trend: AlertFrequencyTrend = "quiet"
  if (totalEvents > 0) {
    const recentBins = Math.max(1, Math.round(count / 4))
    const splitIdx = count - recentBins
    let recentScore = 0
    let priorScore = 0
    for (let i = 0; i < count; i += 1) {
      const score = buckets[i]!.severityScore
      if (i >= splitIdx) recentScore += score
      else priorScore += score
    }
    const recentRate = recentScore / recentBins
    const priorRate = splitIdx > 0 ? priorScore / splitIdx : 0
    if (recentScore > 0 && recentRate >= priorRate * 1.35 + 0.25) {
      trend = "escalating"
    } else if (priorScore > 0 && recentRate <= priorRate * 0.65) {
      trend = "easing"
    } else {
      trend = "steady"
    }
  }

  // Compute vertical USD threshold marker position and post-threshold alert counts
  const breachLimitUsd = result.breachLimitUsd
  const warningLimitUsd = result.warningLimitUsd
  const totalWindowRiskUsd = result.totalWindowRiskUsd
  const utilizationPct =
    breachLimitUsd > 0 ? Math.round((totalWindowRiskUsd / breachLimitUsd) * 1000) / 10 : 0

  let thresholdMarker: AlertThresholdMarker
  if (result.thresholdCrossedMs !== null) {
    const rawNorm = (result.thresholdCrossedMs - result.windowStartMs) / spanMs
    const normalizedX = Math.max(0, Math.min(1, rawNorm))
    const rawBucketIdx = Math.floor((result.thresholdCrossedMs - result.windowStartMs) / bucketMs)
    const crossedBucketIndex = Math.max(0, Math.min(count - 1, rawBucketIdx))
    const crossedBucket = buckets[crossedBucketIndex]!
    const bucketSpan = Math.max(1, crossedBucket.endMs - crossedBucket.startMs)
    const crossedBucketFraction = Math.max(
      0,
      Math.min(1, (result.thresholdCrossedMs - crossedBucket.startMs) / bucketSpan),
    )

    let postThresholdAlertCount = 0
    let postThresholdBreachCount = 0
    for (const item of result.items) {
      if (item.timestampMs >= result.thresholdCrossedMs) {
        postThresholdAlertCount += 1
        if (item.severity === "BREACH") {
          postThresholdBreachCount += 1
        }
      }
    }

    thresholdMarker = {
      breachLimitUsd,
      warningLimitUsd,
      totalWindowRiskUsd,
      utilizationPct,
      status: "crossed",
      crossedAtMs: result.thresholdCrossedMs,
      normalizedX,
      crossedBucketIndex,
      crossedBucketFraction,
      crossedClockLabel: result.thresholdCrossedClockLabel ?? formatHm(result.thresholdCrossedMs),
      crossedTicketId: result.thresholdCrossedTicketId,
      postThresholdAlertCount,
      postThresholdBreachCount,
    }
  } else {
    const status: AlertThresholdMarkerStatus =
      totalWindowRiskUsd >= warningLimitUsd && totalWindowRiskUsd > 0 ? "approaching" : "armed"
    thresholdMarker = {
      breachLimitUsd,
      warningLimitUsd,
      totalWindowRiskUsd,
      utilizationPct,
      status,
      crossedAtMs: null,
      normalizedX: 1,
      crossedBucketIndex: null,
      crossedBucketFraction: 1,
      crossedClockLabel: null,
      crossedTicketId: null,
      postThresholdAlertCount: 0,
      postThresholdBreachCount: 0,
    }
  }

  return {
    buckets,
    maxBucketTotal,
    maxSeverityScore,
    peakBucketIndex,
    peakBucketLabel: peakBucketIndex !== null ? buckets[peakBucketIndex]!.rangeLabel : null,
    peakBucketTotal,
    burstBucketCount,
    trend,
    thresholdMarker,
  }
}

export interface AlertWagerContext {
  readonly ticketId: string
  readonly customerId: string
  readonly agentId: string | null
  readonly masterAgent: string | null
  readonly vip: boolean
  readonly sport: string
  readonly subSport: string | null
  readonly betType: string
  readonly channelLabel: string
  readonly event: string
  readonly selection: string
  readonly lineDisplay: string | null
  readonly oddsAmerican: string | null
  readonly effectiveLine: string
  readonly formattedPick: string
  readonly riskUsd: number
  readonly toWinUsd: number | null
  readonly totalPayoutUsd: number | null
  readonly payoutEstimatedFromOdds: boolean
  readonly payoutMultiple: number | null
  readonly totalReturnMultiple: number | null
  readonly impliedProbability: string
  readonly quotedHoldPct: number | null
  readonly clvCents: number | null
  readonly maxRecommendedStake: number | null
  readonly capUtilizationPct: number | null
  readonly alertTier: LiveWager["alertTier"] | null
  readonly alertBadge: string | null
  readonly operatorDirective: string | null
  readonly deliveryStatus: DashboardAlertRecord["status"] | null
  readonly cumulativeRiskUsd: number | null
  readonly thresholdLimitUsd: number | null
  readonly breachLimitUsd: number | null
  readonly placedTimestamp: string
  readonly hasLiveWagerRecord: boolean
}

const PLACEHOLDER_FIELD_TOKENS = new Set(["", "—", "–", "-", "n/a", "null", "undefined"])

function collapseWs(raw: string | null | undefined): string {
  if (!raw) return ""
  return sanitizeCaptureText(raw).trim().replace(/\s+/g, " ")
}

function normalizeOptionalField(raw: string | null | undefined): string | null {
  const cleaned = collapseWs(raw)
  if (PLACEHOLDER_FIELD_TOKENS.has(cleaned.toLowerCase())) return null
  return cleaned
}

/**
 * Formats an agent / master-agent chain while stripping placeholder dashes and
 * deduplicating identical IDs (`ZZAGENT1` + `ZZAGENT1` → `"ZZAGENT1"`).
 */
export function formatAgentChain(
  agentId: string | null | undefined,
  masterAgent: string | null | undefined,
): string {
  const a = normalizeOptionalField(agentId)
  const m = normalizeOptionalField(masterAgent)
  if (a && m) {
    return a.toUpperCase() === m.toUpperCase() ? a : `${a} / ${m}`
  }
  return a ?? m ?? ""
}

/**
 * Estimates net win (`toWinUsd`) from stake and American odds when an off-tape
 * alert record does not carry an explicit `toWinUsd` field.
 */
export function estimateToWinFromAmericanOdds(
  riskUsd: number,
  oddsAmerican: string | null | undefined,
): number | null {
  if (!Number.isFinite(riskUsd) || riskUsd <= 0 || !oddsAmerican) return null
  const normalized = oddsAmerican.trim().replace(/,/g, "")
  if (/^(?:EV|EVEN)$/i.test(normalized)) {
    return Math.round(riskUsd * 100) / 100
  }
  if (!/^[+-]?\d+$/.test(normalized)) return null
  const odds = Number.parseInt(normalized, 10)
  if (!Number.isFinite(odds) || odds === 0 || (odds > -100 && odds < 100)) return null
  const toWin = odds > 0 ? riskUsd * (odds / 100) : riskUsd * (100 / Math.abs(odds))
  return Math.round(toWin * 100) / 100
}

function resolveCleanChannelLabel(wager: LiveWager | null): string {
  if (!wager) return "Alert Dispatch"
  const channel = wager.writer ?? wagerChannelOf(wager.ticketWriter)
  const label = WAGER_CHANNEL_LABELS[channel]
  if (label) return label
  const writerText = collapseWs(wager.ticketWriter)
  return writerText || channel
}

function buildEffectiveLine(
  selection: string,
  lineDisplay: string,
  oddsAmerican: string | null,
): string {
  const hasLine = lineDisplay.length > 0
  const hasOdds = oddsAmerican !== null && oddsAmerican.length > 0

  if (hasLine) {
    if (hasOdds && !selectionIncludesOdds(lineDisplay, oddsAmerican)) {
      return `${lineDisplay} (${oddsAmerican})`
    }
    return lineDisplay
  }

  if (selection.length > 0) {
    if (hasOdds && !selectionIncludesOdds(selection, oddsAmerican)) {
      return `${selection} (${oddsAmerican})`
    }
    return selection
  }

  return hasOdds ? oddsAmerican : "—"
}

/**
 * Resolves full wager context (payout, effective line, customer ID, cap metrics,
 * odds math, and surveillance metadata) for the Recent Alerts detail modal.
 */
export function resolveAlertWagerContext(item: RecentRiskAlertItem): AlertWagerContext {
  const wager = item.linkedWager
  const ticketId = wager?.ticketId || item.ticketId
  const customerId = wager?.customerId || item.customerId || "UNKNOWN"
  const agentId = normalizeOptionalField(wager?.agentId ?? item.agentId)
  const masterAgent = normalizeOptionalField(wager?.masterAgent)
  const vip = Boolean(wager?.vip)

  const sport = collapseWs(wager?.sport || item.sport) || "OTHER"
  const subSport = normalizeOptionalField(wager?.subSport)
  const betType = collapseWs(wager?.betType) || (wager ? "STRAIGHT" : "ALERT")
  const channelLabel = resolveCleanChannelLabel(wager)

  const event = collapseWs(wager?.event || item.event) || "Live Market"
  const selection = normalizeOptionalField(wager?.selection || item.selection) ?? ""
  const lineDisplay = normalizeOptionalField(wager?.lineDisplay) ?? ""
  const oddsAmerican =
    resolveWagerOddsAmerican({
      oddsAmerican: wager?.oddsAmerican ?? item.oddsAmerican,
      lineDisplay,
      selection,
      betType,
    }) ?? normalizeAmericanOdds(item.oddsAmerican)

  const effectiveLine = buildEffectiveLine(selection, lineDisplay, oddsAmerican)
  const formattedPick = wager
    ? formatWagerSelection({
        selection: wager.selection,
        lineDisplay: wager.lineDisplay,
        oddsAmerican: oddsAmerican ?? "",
      })
    : selection && lineDisplay && !selectionIncludesLine(selection, lineDisplay)
      ? `${selection} ${lineDisplay}${
          oddsAmerican && !selectionIncludesOdds(`${selection} ${lineDisplay}`, oddsAmerican)
            ? ` (${oddsAmerican})`
            : ""
        }`
      : selection
        ? `${selection}${oddsAmerican && !selectionIncludesOdds(selection, oddsAmerican) ? ` (${oddsAmerican})` : ""}`
        : effectiveLine

  const riskUsd = safePositiveUsd(wager?.riskUsd ?? item.riskUsd)
  const hasDirectToWin =
    wager !== null &&
    typeof wager.toWinUsd === "number" &&
    Number.isFinite(wager.toWinUsd) &&
    wager.toWinUsd > 0

  let toWinUsd: number | null = null
  let payoutEstimatedFromOdds = false
  if (hasDirectToWin && wager) {
    toWinUsd = wager.toWinUsd
  } else {
    const estimated = estimateToWinFromAmericanOdds(riskUsd, oddsAmerican)
    if (estimated !== null) {
      toWinUsd = estimated
      payoutEstimatedFromOdds = true
    }
  }

  const totalPayoutUsd =
    riskUsd > 0 && toWinUsd !== null ? Math.round((riskUsd + toWinUsd) * 100) / 100 : null

  const mult = riskUsd > 0 && toWinUsd !== null ? payoutMultiple(riskUsd, toWinUsd) : null
  const totalReturnMultiple =
    riskUsd > 0 && totalPayoutUsd !== null ? Number((totalPayoutUsd / riskUsd).toFixed(2)) : null

  const impliedFromOdds = oddsAmerican ? formatImpliedProbability(oddsAmerican) : "—"
  const impliedProbability =
    impliedFromOdds !== "—"
      ? impliedFromOdds
      : riskUsd > 0 && toWinUsd !== null && toWinUsd > 0
        ? formatImpliedProbabilityFromPayout(riskUsd, toWinUsd)
        : "—"
  const quotedHoldPct =
    riskUsd > 0 && toWinUsd !== null ? ticketQuotedHoldPct(riskUsd, toWinUsd) : null

  const clvCents =
    typeof wager?.clvCents === "number" && Number.isFinite(wager.clvCents)
      ? wager.clvCents
      : typeof item.clvCents === "number" && Number.isFinite(item.clvCents)
        ? item.clvCents
        : null

  const maxRecommendedStake =
    wager &&
    typeof wager.maxRecommendedStake === "number" &&
    Number.isFinite(wager.maxRecommendedStake) &&
    wager.maxRecommendedStake > 0
      ? wager.maxRecommendedStake
      : null

  const capUtil =
    maxRecommendedStake !== null ? capUtilizationPct(riskUsd, maxRecommendedStake) : null

  const alertTier = wager?.alertTier ?? item.alertTier
  const alertBadge = normalizeOptionalField(wager?.alertBadge)
  const operatorDirective = normalizeOptionalField(wager?.operatorDirective || item.operatorDirective)

  return {
    ticketId,
    customerId,
    agentId,
    masterAgent,
    vip,
    sport,
    subSport,
    betType,
    channelLabel,
    event,
    selection: selection || "—",
    lineDisplay: lineDisplay || null,
    oddsAmerican,
    effectiveLine,
    formattedPick,
    riskUsd,
    toWinUsd,
    totalPayoutUsd,
    payoutEstimatedFromOdds,
    payoutMultiple: mult,
    totalReturnMultiple,
    impliedProbability,
    quotedHoldPct,
    clvCents,
    maxRecommendedStake,
    capUtilizationPct: capUtil,
    alertTier,
    alertBadge,
    operatorDirective,
    deliveryStatus: item.deliveryStatus ?? null,
    cumulativeRiskUsd: item.cumulativeRiskUsd,
    thresholdLimitUsd: item.thresholdLimitUsd,
    breachLimitUsd: item.breachLimitUsd ?? null,
    placedTimestamp: wager?.timestamp || item.clockLabel,
    hasLiveWagerRecord: wager !== null,
  }
}

export function formatAlertWagerBrief(
  item: RecentRiskAlertItem,
  ctx: AlertWagerContext = resolveAlertWagerContext(item),
): string {
  const payoutLine =
    ctx.totalPayoutUsd !== null && ctx.toWinUsd !== null
      ? `$${Math.round(ctx.totalPayoutUsd).toLocaleString("en-US")} total ($${Math.round(ctx.riskUsd).toLocaleString("en-US")} risk / $${Math.round(ctx.toWinUsd).toLocaleString("en-US")} to win${ctx.payoutMultiple !== null ? ` · ${ctx.payoutMultiple}x` : ""})`
      : `$${Math.round(ctx.riskUsd).toLocaleString("en-US")} risk`

  const agentChain = formatAgentChain(ctx.agentId, ctx.masterAgent)
  const sportSuffix =
    ctx.subSport && ctx.subSport.toUpperCase() !== ctx.sport.toUpperCase()
      ? ` / ${ctx.subSport}`
      : ""
  const showSeparatePick =
    ctx.formattedPick !== "—" &&
    ctx.formattedPick.toLowerCase() !== ctx.effectiveLine.toLowerCase()

  const lines = [
    `[${item.severity}] ${item.title} (${item.clockLabel} · ${item.relativeAgeLabel})`,
    `Ticket #${ctx.ticketId} · Customer ${ctx.customerId}${ctx.vip ? " (VIP)" : ""}${agentChain ? ` · Agent ${agentChain}` : ""}`,
    `Event: ${ctx.event} (${ctx.sport}${sportSuffix})`,
    showSeparatePick
      ? `Effective Line: ${ctx.effectiveLine} · Pick: ${ctx.formattedPick}`
      : `Effective Line: ${ctx.effectiveLine}`,
    `Payout: ${payoutLine} · Implied ${ctx.impliedProbability}`,
    `CLV: ${ctx.clvCents !== null ? `${ctx.clvCents >= 0 ? "+" : ""}${ctx.clvCents.toFixed(1)}¢` : "—"} · Tier: ${ctx.alertTier ?? "—"} · Directive: ${ctx.operatorDirective ?? "—"}`,
  ]
  if (item.kind === "SINGLE_WAGER_BREACH" && ctx.thresholdLimitUsd !== null) {
    const windowSuffix =
      ctx.cumulativeRiskUsd !== null
        ? ` (60m window: $${Math.round(ctx.cumulativeRiskUsd).toLocaleString("en-US")})`
        : ""
    lines.push(
      `Single-Wager Cap: $${Math.round(ctx.riskUsd).toLocaleString("en-US")} stake vs $${Math.round(ctx.thresholdLimitUsd).toLocaleString("en-US")} max cap${windowSuffix}`,
    )
  } else if (ctx.cumulativeRiskUsd !== null && ctx.thresholdLimitUsd !== null) {
    if (item.kind === "THRESHOLD_WARNING") {
      const breachSuffix =
        ctx.breachLimitUsd !== null && ctx.breachLimitUsd !== ctx.thresholdLimitUsd
          ? ` ($${Math.round(ctx.breachLimitUsd).toLocaleString("en-US")} breach limit)`
          : ""
      lines.push(
        `60m Window Exposure: $${Math.round(ctx.cumulativeRiskUsd).toLocaleString("en-US")} vs $${Math.round(ctx.thresholdLimitUsd).toLocaleString("en-US")} warn threshold${breachSuffix}`,
      )
    } else {
      lines.push(
        `60m Window Exposure: $${Math.round(ctx.cumulativeRiskUsd).toLocaleString("en-US")} vs $${Math.round(ctx.thresholdLimitUsd).toLocaleString("en-US")} breach limit`,
      )
    }
  }
  return lines.join("\n")
}
