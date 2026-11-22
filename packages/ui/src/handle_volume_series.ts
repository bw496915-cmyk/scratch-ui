/**
 * @file packages/ui/src/handle_volume_series.ts
 * @description Rolling 60-minute aggregate handle volume series builder for the
 * Live Wagers Recharts line chart, synchronized to WebSocket feed ticks.
 */

import { wagerChannelOf } from "@sportsdesk-ops/contracts"

import { parseDeskClock } from "./gslive_game_log.ts"
import type { LiveWager } from "./types.ts"

export const HANDLE_WINDOW_MINUTES = 60
export const HANDLE_ANOMALY_SIGMA = 2
const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

export interface HandleVolumePoint {
  /** Bucket end timestamp in epoch ms (aligned to minute boundary). */
  readonly bucketMs: number
  /** Short local wall-clock axis label (`HH:MM`). */
  readonly label: string
  /** Minute offset from window end (`-59m` .. `Now`). */
  readonly relativeLabel: string
  /** Handle volume booked inside this 1-minute bucket (USD). */
  readonly minuteHandleUsd: number
  /** Running cumulative aggregate handle across the 60-minute window (USD). */
  readonly cumulativeHandleUsd: number
  /** Count of non-sentinel wagers landed inside this 1-minute bucket. */
  readonly ticketCount: number
  /** Running cumulative count of non-sentinel wagers across the window. */
  readonly cumulativeTickets: number
  /** Standard deviations above/below the 60-minute mean minute volume. */
  readonly zScore: number
  /** True when `minuteHandleUsd` strictly exceeds mean + 2σ across the 60m window. */
  readonly isAnomaly: boolean
}

export interface HandleVolumeSeriesResult {
  readonly points: readonly HandleVolumePoint[]
  readonly windowStartMs: number
  readonly windowEndMs: number
  readonly windowMode: "live" | "capture"
  readonly totalHandleUsd: number
  readonly meanMinuteHandleUsd: number
  readonly stdDevMinuteHandleUsd: number
  readonly twoSigmaThresholdUsd: number
  readonly anomalyCount: number
  readonly peakMinuteHandleUsd: number
  readonly peakMinuteLabel: string | null
  readonly includedTickets: number
  readonly excludedSentinelTickets: number
  readonly unparsedTimestampTickets: number
}

/**
 * Returns true for non-wager sentinel channels (`ALERT` / `BLOCKED`) that mirror
 * or block stakes and must never inflate aggregate handle volume.
 */
export function isSentinelWager(w: LiveWager): boolean {
  const channel = w.writer ?? wagerChannelOf(w.ticketWriter)
  return channel === "alert" || channel === "blocked"
}

/**
 * Resolves a wager's handle contribution in USD. Prefers positive `volumeUsd`
 * when present, falling back to `riskUsd`, and returns `0` for sentinel rows.
 */
export function handleUsdOf(w: LiveWager): number {
  if (isSentinelWager(w)) return 0
  if (typeof w.volumeUsd === "number" && Number.isFinite(w.volumeUsd) && w.volumeUsd > 0) {
    return w.volumeUsd
  }
  if (typeof w.riskUsd === "number" && Number.isFinite(w.riskUsd) && w.riskUsd > 0) {
    return w.riskUsd
  }
  return 0
}

/**
 * Parses ISO 8601 (`2026-11-19T08:22:10Z`), SQL (`2026-11-01 17:15:02.770`),
 * and desk wall-clock (`7:45:03 PM ET`, `14:32:01 ET`) timestamps into epoch ms.
 * Wall-clock-only timestamps are resolved against `anchorMs` with midnight wraparound.
 */
export function parseWagerTimestampMs(
  raw: string | undefined | null,
  anchorMs: number,
): number | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  // 1. Full date + time strings (ISO 8601 or SQL "YYYY-MM-DD HH:MM:SS(.mmm)")
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T")
    const parsed = Date.parse(normalized)
    if (!Number.isNaN(parsed)) return parsed
  }

  // 2. Desk wall-clock string ("7:45:03 PM ET" / "14:32:01")
  const secOfDay = parseDeskClock(trimmed)
  if (secOfDay !== null) {
    const anchorDate = new Date(anchorMs)
    const midnightLocal = new Date(
      anchorDate.getFullYear(),
      anchorDate.getMonth(),
      anchorDate.getDate(),
      0,
      0,
      0,
      0,
    ).getTime()
    let candidate = midnightLocal + secOfDay * 1000
    // Handle midnight wraparound (e.g. 23:55 wager viewed at 00:05)
    if (candidate - anchorMs > 12 * 3_600_000) {
      candidate -= DAY_MS
    } else if (anchorMs - candidate > 12 * 3_600_000) {
      candidate += DAY_MS
    }
    return candidate
  }

  // 3. Generic Date.parse fallback (RFC 2822, etc.)
  const generic = Date.parse(trimmed)
  return Number.isNaN(generic) ? null : generic
}

function formatMinuteClock(epochMs: number): string {
  const d = new Date(epochMs)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

export function formatHandleCompactUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd === 0) return "$0"
  const abs = Math.abs(usd)
  const sign = usd < 0 ? "-" : ""
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`
  return `${sign}$${Math.round(abs).toLocaleString()}`
}

/**
 * Aggregates live wager handle volume into 60 one-minute buckets over the last
 * 60 minutes. Anchors to `anchorMs` for live streaming feeds; if all parsed
 * wagers are from an older static capture (>60m behind `anchorMs`), anchors to
 * the capture's latest wager timestamp so historical snapshots remain readable.
 */
export function buildRolling60MinHandleSeries(
  wagers: readonly LiveWager[],
  options: {
    readonly anchorMs?: number
    readonly windowMinutes?: number
  } = {},
): HandleVolumeSeriesResult {
  const windowMinutes = Math.max(
    1,
    Math.min(180, Math.round(options.windowMinutes ?? HANDLE_WINDOW_MINUTES)),
  )
  const nowMs = options.anchorMs ?? Date.now()
  const windowDurationMs = windowMinutes * MINUTE_MS

  let excludedSentinelTickets = 0
  let unparsedTimestampTickets = 0
  const parsedRows: Array<{ readonly tsMs: number; readonly handleUsd: number }> = []

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
    const handleUsd = handleUsdOf(w)
    parsedRows.push({ tsMs, handleUsd })
    if (tsMs > maxParsedTs) {
      maxParsedTs = tsMs
    }
  }

  // Decide whether to anchor to real-time `nowMs` or a historical capture's latest tick
  const hasRecentLiveWager =
    parsedRows.length > 0 &&
    maxParsedTs >= nowMs - windowDurationMs &&
    maxParsedTs <= nowMs + 5 * MINUTE_MS

  const windowMode: "live" | "capture" =
    parsedRows.length === 0 || hasRecentLiveWager ? "live" : "capture"

  const effectiveAnchorMs = windowMode === "live" ? nowMs : maxParsedTs
  const windowEndMs = Math.floor(effectiveAnchorMs / MINUTE_MS) * MINUTE_MS
  const windowStartMs = windowEndMs - (windowMinutes - 1) * MINUTE_MS

  const minuteHandle = new Float64Array(windowMinutes)
  const minuteTickets = new Uint32Array(windowMinutes)
  let includedTickets = 0

  for (const row of parsedRows) {
    const rowMinuteMs = Math.floor(row.tsMs / MINUTE_MS) * MINUTE_MS
    const idx = Math.floor((rowMinuteMs - windowStartMs) / MINUTE_MS)
    if (idx < 0 || idx >= windowMinutes) continue
    minuteHandle[idx] = (minuteHandle[idx] ?? 0) + row.handleUsd
    minuteTickets[idx] = (minuteTickets[idx] ?? 0) + 1
    includedTickets += 1
  }

  // Compute 60-minute mean and population standard deviation across minute buckets
  let sumMinuteHandle = 0
  for (let i = 0; i < windowMinutes; i += 1) {
    sumMinuteHandle += Math.round((minuteHandle[i] ?? 0) * 100) / 100
  }
  const meanRaw = windowMinutes > 0 ? sumMinuteHandle / windowMinutes : 0
  let varianceSum = 0
  for (let i = 0; i < windowMinutes; i += 1) {
    const val = Math.round((minuteHandle[i] ?? 0) * 100) / 100
    const diff = val - meanRaw
    varianceSum += diff * diff
  }
  const stdDevRaw = windowMinutes > 0 ? Math.sqrt(varianceSum / windowMinutes) : 0
  const twoSigmaRaw = meanRaw + HANDLE_ANOMALY_SIGMA * stdDevRaw

  const meanMinuteHandleUsd = Math.round(meanRaw * 100) / 100
  const stdDevMinuteHandleUsd = Math.round(stdDevRaw * 100) / 100
  const twoSigmaThresholdUsd = Math.round(twoSigmaRaw * 100) / 100

  const points: HandleVolumePoint[] = []
  let runningHandle = 0
  let runningTickets = 0
  let peakMinuteHandleUsd = 0
  let peakMinuteLabel: string | null = null
  let anomalyCount = 0

  for (let i = 0; i < windowMinutes; i += 1) {
    const bucketMs = windowStartMs + i * MINUTE_MS
    const mHandle = Math.round((minuteHandle[i] ?? 0) * 100) / 100
    const mTickets = minuteTickets[i] ?? 0
    runningHandle = Math.round((runningHandle + mHandle) * 100) / 100
    runningTickets += mTickets

    const label = formatMinuteClock(bucketMs)
    const minsAgo = windowMinutes - 1 - i
    const relativeLabel = minsAgo === 0 ? "Now" : `-${minsAgo}m`

    const zScore = stdDevRaw > 0 ? Math.round(((mHandle - meanRaw) / stdDevRaw) * 100) / 100 : 0
    const isAnomaly = stdDevRaw > 0 && mHandle > twoSigmaRaw
    if (isAnomaly) {
      anomalyCount += 1
    }

    if (mHandle > peakMinuteHandleUsd) {
      peakMinuteHandleUsd = mHandle
      peakMinuteLabel = label
    }

    points.push({
      bucketMs,
      label,
      relativeLabel,
      minuteHandleUsd: mHandle,
      cumulativeHandleUsd: runningHandle,
      ticketCount: mTickets,
      cumulativeTickets: runningTickets,
      zScore,
      isAnomaly,
    })
  }

  return {
    points,
    windowStartMs,
    windowEndMs,
    windowMode,
    totalHandleUsd: runningHandle,
    meanMinuteHandleUsd,
    stdDevMinuteHandleUsd,
    twoSigmaThresholdUsd,
    anomalyCount,
    peakMinuteHandleUsd,
    peakMinuteLabel,
    includedTickets,
    excludedSentinelTickets,
    unparsedTimestampTickets,
  }
}
