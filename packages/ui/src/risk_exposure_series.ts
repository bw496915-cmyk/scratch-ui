/**
 * @file packages/ui/src/risk_exposure_series.ts
 * @description Rolling 60-minute aggregate risk exposure series builder for the
 * Risk Overview Recharts line chart, tracking 1-minute risk fluctuations,
 * 5-minute rolling exposure pulses, critical/steam share, and 60m cumulative
 * risk/liability synchronized to real-time WebSocket feed ticks.
 */

import {
  formatHandleCompactUsd,
  isSentinelWager,
  parseWagerTimestampMs,
} from "./handle_volume_series.ts"
import type { LiveWager } from "./types.ts"

export const RISK_WINDOW_MINUTES = 60
export const RISK_ROLLING_PULSE_MINUTES = 5
export const RISK_ANOMALY_SIGMA = 2
const MINUTE_MS = 60_000

export type RiskActivityHeatLevel = 0 | 1 | 2 | 3 | 4

export type RiskActivityHeatLabel = "Quiet" | "Light" | "Moderate" | "Elevated" | "Concentrated"

export interface RiskActivityHeatBand {
  /** Inclusive starting minute index within the rolling window (`0..windowMinutes-1`). */
  readonly startIdx: number
  /** Inclusive ending minute index within the rolling window (`0..windowMinutes-1`). */
  readonly endIdx: number
  /** Wall-clock label (`HH:MM`) of the band start minute. */
  readonly startLabel: string
  /** Wall-clock label (`HH:MM`) of the band end minute. */
  readonly endLabel: string
  /** Quantized activity concentration level (`1..4`). */
  readonly heatLevel: 1 | 2 | 3 | 4
  /** Peak normalized concentration intensity (`0..1`) inside this band. */
  readonly peakIntensity: number
  /** Total non-sentinel tickets landed across this contiguous band. */
  readonly totalTickets: number
  /** Total aggregate risk (USD) booked across this contiguous band. */
  readonly totalRiskUsd: number
}

export interface RiskExposurePoint {
  /** Zero-based minute slot index (`0..windowMinutes-1`) for exact-width Recharts overlays. */
  readonly bucketIndex: number
  /** Bucket end timestamp in epoch ms (aligned to minute boundary). */
  readonly bucketMs: number
  /** Short local wall-clock axis label (`HH:MM`). */
  readonly label: string
  /** Minute offset from window end (`-59m` .. `Now`). */
  readonly relativeLabel: string
  /** Aggregate risk booked inside this 1-minute bucket (USD). */
  readonly minuteRiskUsd: number
  /** Critical / Steam alert-tier risk booked inside this 1-minute bucket (USD). */
  readonly minuteCriticalRiskUsd: number
  /** Sportsbook payout liability (`toWinUsd`) booked inside this 1-minute bucket (USD). */
  readonly minuteLiabilityUsd: number
  /** Rolling 5-minute trailing aggregate risk exposure (shows real-time rise & decay). */
  readonly rollingRiskUsd: number
  /** Rolling 5-minute trailing critical/steam risk exposure (USD). */
  readonly rollingCriticalRiskUsd: number
  /** Running cumulative aggregate risk across the 60-minute window (USD). */
  readonly cumulativeRiskUsd: number
  /** Running cumulative sportsbook payout liability across the 60-minute window (USD). */
  readonly cumulativeLiabilityUsd: number
  /** Count of non-sentinel wagers landed inside this 1-minute bucket. */
  readonly ticketCount: number
  /** Count of critical/steam wagers inside this 1-minute bucket. */
  readonly criticalTicketCount: number
  /** Running cumulative ticket count across the window. */
  readonly cumulativeTickets: number
  /** Standard deviations above/below the 60-minute mean 1-minute risk exposure. */
  readonly zScore: number
  /** True when 1-minute risk strictly exceeds mean + 2σ across the 60-minute window. */
  readonly isSpike: boolean
  /** Normalized betting activity concentration (`0..1`) blending ticket frequency & risk velocity. */
  readonly activityIntensity: number
  /** Discrete thermal heat level (`0` = Quiet .. `4` = Concentrated). */
  readonly heatLevel: RiskActivityHeatLevel
  /** Human-readable concentration label paired with color for accessibility. */
  readonly heatLabel: RiskActivityHeatLabel
}

export interface RiskExposureSeriesResult {
  readonly points: readonly RiskExposurePoint[]
  readonly heatBands: readonly RiskActivityHeatBand[]
  readonly windowStartMs: number
  readonly windowEndMs: number
  readonly windowMode: "live" | "capture"
  readonly totalRiskUsd: number
  readonly totalLiabilityUsd: number
  readonly totalCriticalRiskUsd: number
  readonly criticalSharePct: number
  readonly currentRollingRiskUsd: number
  readonly meanRollingRiskUsd: number
  readonly rollingDeltaPct: number | null
  readonly meanMinuteRiskUsd: number
  readonly stdDevMinuteRiskUsd: number
  readonly twoSigmaThresholdUsd: number
  readonly spikeCount: number
  readonly peakMinuteRiskUsd: number
  readonly peakMinuteLabel: string | null
  readonly peakRollingRiskUsd: number
  readonly peakRollingLabel: string | null
  readonly maxMinuteTickets: number
  readonly peakActivityLabel: string | null
  readonly concentratedMinuteCount: number
  readonly includedTickets: number
  readonly excludedSentinelTickets: number
  readonly unparsedTimestampTickets: number
}

const HEAT_LABELS: Record<RiskActivityHeatLevel, RiskActivityHeatLabel> = {
  0: "Quiet",
  1: "Light",
  2: "Moderate",
  3: "Elevated",
  4: "Concentrated",
}

function quantizeActivityHeatLevel(intensity: number): RiskActivityHeatLevel {
  if (intensity <= 0) return 0
  if (intensity < 0.25) return 1
  if (intensity < 0.5) return 2
  if (intensity < 0.75) return 3
  return 4
}

function isCriticalOrSteamWager(w: LiveWager): boolean {
  return w.alertTier === "CRITICAL" || w.alertTier === "STEAM"
}

function safePositiveUsd(value: number | undefined | null): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value
  }
  return 0
}

function formatMinuteClock(epochMs: number): string {
  const d = new Date(epochMs)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export function formatRiskCompactUsd(usd: number): string {
  return formatHandleCompactUsd(usd)
}

/**
 * Aggregates live wager risk exposure into 60 one-minute buckets over the last
 * 60 minutes. Anchors to `anchorMs` for live streaming feeds; if all parsed
 * wagers belong to a static capture older than 60 minutes, anchors to the
 * capture's latest timestamp so historical snapshots remain readable.
 */
export function buildRolling60MinRiskSeries(
  wagers: readonly LiveWager[],
  options: {
    readonly anchorMs?: number
    readonly windowMinutes?: number
    readonly rollingPulseMinutes?: number
  } = {},
): RiskExposureSeriesResult {
  const windowMinutes = Math.max(
    1,
    Math.min(180, Math.round(options.windowMinutes ?? RISK_WINDOW_MINUTES)),
  )
  const rollingPulseMinutes = Math.max(
    1,
    Math.min(windowMinutes, Math.round(options.rollingPulseMinutes ?? RISK_ROLLING_PULSE_MINUTES)),
  )
  const nowMs = options.anchorMs ?? Date.now()
  const windowDurationMs = windowMinutes * MINUTE_MS

  let excludedSentinelTickets = 0
  let unparsedTimestampTickets = 0
  const parsedRows: Array<{
    readonly tsMs: number
    readonly riskUsd: number
    readonly liabilityUsd: number
    readonly isCritical: boolean
  }> = []

  let maxParsedTs = -Infinity

  for (const w of wagers) {
    if (isSentinelWager(w)) {
      excludedSentinelTickets += 1
      continue
    }
    const tsMs = parseWagerTimestampMs(w.timestamp, nowMs)
    if (tsMs === null) {
      unparsedTimestampTickets += 1
      continue
    }
    const riskUsd = safePositiveUsd(w.riskUsd)
    const liabilityUsd = safePositiveUsd(w.toWinUsd)
    parsedRows.push({
      tsMs,
      riskUsd,
      liabilityUsd,
      isCritical: isCriticalOrSteamWager(w),
    })
    if (tsMs > maxParsedTs) {
      maxParsedTs = tsMs
    }
  }

  const hasRecentLiveWager =
    parsedRows.length > 0 &&
    maxParsedTs >= nowMs - windowDurationMs &&
    maxParsedTs <= nowMs + 5 * MINUTE_MS

  const windowMode: "live" | "capture" =
    parsedRows.length === 0 || hasRecentLiveWager ? "live" : "capture"

  const effectiveAnchorMs = windowMode === "live" ? nowMs : maxParsedTs
  const windowEndMs = Math.floor(effectiveAnchorMs / MINUTE_MS) * MINUTE_MS
  const windowStartMs = windowEndMs - (windowMinutes - 1) * MINUTE_MS

  const minuteRisk = new Float64Array(windowMinutes)
  const minuteCriticalRisk = new Float64Array(windowMinutes)
  const minuteLiability = new Float64Array(windowMinutes)
  const minuteTickets = new Uint32Array(windowMinutes)
  const minuteCriticalTickets = new Uint32Array(windowMinutes)
  let includedTickets = 0

  for (const row of parsedRows) {
    const rowMinuteMs = Math.floor(row.tsMs / MINUTE_MS) * MINUTE_MS
    const idx = Math.floor((rowMinuteMs - windowStartMs) / MINUTE_MS)
    if (idx < 0 || idx >= windowMinutes) continue
    minuteRisk[idx] = (minuteRisk[idx] ?? 0) + row.riskUsd
    minuteLiability[idx] = (minuteLiability[idx] ?? 0) + row.liabilityUsd
    minuteTickets[idx] = (minuteTickets[idx] ?? 0) + 1
    if (row.isCritical) {
      minuteCriticalRisk[idx] = (minuteCriticalRisk[idx] ?? 0) + row.riskUsd
      minuteCriticalTickets[idx] = (minuteCriticalTickets[idx] ?? 0) + 1
    }
    includedTickets += 1
  }

  // Compute 60-minute mean, population std-dev, and maxima for activity heat normalization
  let sumMinuteRisk = 0
  let maxMinuteRiskRaw = 0
  let maxMinuteTickets = 0
  let peakActivityLabel: string | null = null
  for (let i = 0; i < windowMinutes; i += 1) {
    const mRisk = Math.round((minuteRisk[i] ?? 0) * 100) / 100
    const mTickets = minuteTickets[i] ?? 0
    sumMinuteRisk += mRisk
    if (mRisk > maxMinuteRiskRaw) {
      maxMinuteRiskRaw = mRisk
    }
    if (mTickets > maxMinuteTickets) {
      maxMinuteTickets = mTickets
      peakActivityLabel = formatMinuteClock(windowStartMs + i * MINUTE_MS)
    }
  }
  const meanRaw = windowMinutes > 0 ? sumMinuteRisk / windowMinutes : 0
  let varianceSum = 0
  for (let i = 0; i < windowMinutes; i += 1) {
    const val = Math.round((minuteRisk[i] ?? 0) * 100) / 100
    const diff = val - meanRaw
    varianceSum += diff * diff
  }
  const stdDevRaw = windowMinutes > 0 ? Math.sqrt(varianceSum / windowMinutes) : 0
  const twoSigmaRaw = meanRaw + RISK_ANOMALY_SIGMA * stdDevRaw

  const meanMinuteRiskUsd = Math.round(meanRaw * 100) / 100
  const stdDevMinuteRiskUsd = Math.round(stdDevRaw * 100) / 100
  const twoSigmaThresholdUsd = Math.round(twoSigmaRaw * 100) / 100

  const points: RiskExposurePoint[] = []
  let cumulativeRisk = 0
  let cumulativeLiability = 0
  let totalCriticalRisk = 0
  let cumulativeTickets = 0
  let rollingWindowRisk = 0
  let rollingWindowCritical = 0
  let sumRollingRisk = 0
  let peakMinuteRiskUsd = 0
  let peakMinuteLabel: string | null = null
  let peakRollingRiskUsd = 0
  let peakRollingLabel: string | null = null
  let spikeCount = 0
  let concentratedMinuteCount = 0

  for (let i = 0; i < windowMinutes; i += 1) {
    const bucketMs = windowStartMs + i * MINUTE_MS
    const mRisk = Math.round((minuteRisk[i] ?? 0) * 100) / 100
    const mCritRisk = Math.round((minuteCriticalRisk[i] ?? 0) * 100) / 100
    const mLiability = Math.round((minuteLiability[i] ?? 0) * 100) / 100
    const mTickets = minuteTickets[i] ?? 0
    const mCritTickets = minuteCriticalTickets[i] ?? 0

    cumulativeRisk = Math.round((cumulativeRisk + mRisk) * 100) / 100
    cumulativeLiability = Math.round((cumulativeLiability + mLiability) * 100) / 100
    totalCriticalRisk = Math.round((totalCriticalRisk + mCritRisk) * 100) / 100
    cumulativeTickets += mTickets

    // Update trailing rolling pulse window (add current minute, drop expired minute)
    rollingWindowRisk += mRisk
    rollingWindowCritical += mCritRisk
    if (i >= rollingPulseMinutes) {
      rollingWindowRisk -= Math.round((minuteRisk[i - rollingPulseMinutes] ?? 0) * 100) / 100
      rollingWindowCritical -=
        Math.round((minuteCriticalRisk[i - rollingPulseMinutes] ?? 0) * 100) / 100
    }
    const rRisk = Math.max(0, Math.round(rollingWindowRisk * 100) / 100)
    const rCrit = Math.max(0, Math.round(rollingWindowCritical * 100) / 100)
    sumRollingRisk += rRisk

    const label = formatMinuteClock(bucketMs)
    const minsAgo = windowMinutes - 1 - i
    const relativeLabel = minsAgo === 0 ? "Now" : `-${minsAgo}m`

    const zScore = stdDevRaw > 0 ? Math.round(((mRisk - meanRaw) / stdDevRaw) * 100) / 100 : 0
    const isSpike = stdDevRaw > 0 && mRisk > twoSigmaRaw
    if (isSpike) {
      spikeCount += 1
    }

    // Activity concentration blends 60% ticket-count density + 40% risk velocity
    const ticketRatio = maxMinuteTickets > 0 ? mTickets / maxMinuteTickets : 0
    const riskRatio = maxMinuteRiskRaw > 0 ? mRisk / maxMinuteRiskRaw : 0
    const activityIntensity =
      mTickets === 0 && mRisk === 0
        ? 0
        : Math.min(1, Math.round((0.6 * ticketRatio + 0.4 * riskRatio) * 1000) / 1000)
    const heatLevel = quantizeActivityHeatLevel(activityIntensity)
    const heatLabel = HEAT_LABELS[heatLevel]
    if (heatLevel >= 3) {
      concentratedMinuteCount += 1
    }

    if (mRisk > peakMinuteRiskUsd) {
      peakMinuteRiskUsd = mRisk
      peakMinuteLabel = label
    }
    if (rRisk > peakRollingRiskUsd) {
      peakRollingRiskUsd = rRisk
      peakRollingLabel = label
    }

    points.push({
      bucketIndex: i,
      bucketMs,
      label,
      relativeLabel,
      minuteRiskUsd: mRisk,
      minuteCriticalRiskUsd: mCritRisk,
      minuteLiabilityUsd: mLiability,
      rollingRiskUsd: rRisk,
      rollingCriticalRiskUsd: rCrit,
      cumulativeRiskUsd: cumulativeRisk,
      cumulativeLiabilityUsd: cumulativeLiability,
      ticketCount: mTickets,
      criticalTicketCount: mCritTickets,
      cumulativeTickets,
      zScore,
      isSpike,
      activityIntensity,
      heatLevel,
      heatLabel,
    })
  }

  // Merge contiguous minutes with the same non-zero heat level into ReferenceArea bands
  const heatBands: RiskActivityHeatBand[] = []
  let activeBand: {
    startIdx: number
    endIdx: number
    startLabel: string
    endLabel: string
    heatLevel: 1 | 2 | 3 | 4
    peakIntensity: number
    totalTickets: number
    totalRiskUsd: number
  } | null = null

  for (const pt of points) {
    if (pt.heatLevel === 0) {
      if (activeBand) {
        heatBands.push(activeBand)
        activeBand = null
      }
      continue
    }
    if (activeBand && activeBand.heatLevel === pt.heatLevel) {
      activeBand.endIdx = pt.bucketIndex
      activeBand.endLabel = pt.label
      activeBand.peakIntensity = Math.max(activeBand.peakIntensity, pt.activityIntensity)
      activeBand.totalTickets += pt.ticketCount
      activeBand.totalRiskUsd = Math.round((activeBand.totalRiskUsd + pt.minuteRiskUsd) * 100) / 100
    } else {
      if (activeBand) {
        heatBands.push(activeBand)
      }
      activeBand = {
        startIdx: pt.bucketIndex,
        endIdx: pt.bucketIndex,
        startLabel: pt.label,
        endLabel: pt.label,
        heatLevel: pt.heatLevel,
        peakIntensity: pt.activityIntensity,
        totalTickets: pt.ticketCount,
        totalRiskUsd: pt.minuteRiskUsd,
      }
    }
  }
  if (activeBand) {
    heatBands.push(activeBand)
  }

  const currentRollingRiskUsd =
    points.length > 0 ? (points[points.length - 1]?.rollingRiskUsd ?? 0) : 0
  const meanRollingRiskUsd =
    windowMinutes > 0 ? Math.round((sumRollingRisk / windowMinutes) * 100) / 100 : 0
  const rollingDeltaPct =
    meanRollingRiskUsd > 0
      ? Math.round(((currentRollingRiskUsd - meanRollingRiskUsd) / meanRollingRiskUsd) * 1000) / 10
      : null
  const criticalSharePct =
    cumulativeRisk > 0 ? Math.round((totalCriticalRisk / cumulativeRisk) * 1000) / 10 : 0

  return {
    points,
    heatBands,
    windowStartMs,
    windowEndMs,
    windowMode,
    totalRiskUsd: cumulativeRisk,
    totalLiabilityUsd: cumulativeLiability,
    totalCriticalRiskUsd: totalCriticalRisk,
    criticalSharePct,
    currentRollingRiskUsd,
    meanRollingRiskUsd,
    rollingDeltaPct,
    meanMinuteRiskUsd,
    stdDevMinuteRiskUsd,
    twoSigmaThresholdUsd,
    spikeCount,
    peakMinuteRiskUsd,
    peakMinuteLabel,
    peakRollingRiskUsd,
    peakRollingLabel,
    maxMinuteTickets,
    peakActivityLabel,
    concentratedMinuteCount,
    includedTickets,
    excludedSentinelTickets,
    unparsedTimestampTickets,
  }
}
