/**
 * Aggregates System Logs entries (`WebLogEntry` and `UnifiedSystemLogRow`) into 24 hourly buckets
 * over the last 24 hours broken down by severity tier (`CRITICAL`, `HIGH`, `WATCH`, `NORMAL`) for
 * the System Logs Recharts bar chart.
 *
 * @file Packages/ui/src/system_log_severity_series.ts
 */

import type { UnifiedSystemLogRow } from "./system_logs_json_export.ts"

export const SYSTEM_LOG_WINDOW_HOURS = 24
export const SYSTEM_LOG_HOUR_MS = 3_600_000

export const LOG_SEVERITY_LEVELS = ["CRITICAL", "HIGH", "WATCH", "NORMAL"] as const
export type SystemLogSeverityLevel = (typeof LOG_SEVERITY_LEVELS)[number]

export interface SystemLogSeverityCounts24h {
  readonly CRITICAL: number
  readonly HIGH: number
  readonly WATCH: number
  readonly NORMAL: number
  readonly total: number
}

export interface SystemLogSeverityBucket {
  /** Zero-based hourly slot (`0..windowHours-1`). */
  readonly bucketIndex: number
  /** Hour bucket start timestamp in epoch ms (aligned to hour boundary). */
  readonly bucketStartMs: number
  /** Hour bucket exclusive end timestamp in epoch ms. */
  readonly bucketEndMs: number
  /** Compact local clock hour label (`HH:00`). */
  readonly hourLabel: string
  /** Hour range label (`HH:00–HH:00`). */
  readonly rangeLabel: string
  /** Month/day + hour label for tooltips (`Nov 22, 14:00`). */
  readonly dateTimeLabel: string
  /** Relative offset from window end (`-23h` .. `This hr`). */
  readonly relativeLabel: string
  readonly CRITICAL: number
  readonly HIGH: number
  readonly WATCH: number
  readonly NORMAL: number
  readonly total: number
  /** True when this bucket's total log volume is an elevated activity spike vs the 24h baseline. */
  readonly isSpike: boolean
}

export interface SystemLogSeveritySeriesResult {
  readonly buckets: readonly SystemLogSeverityBucket[]
  readonly windowStartMs: number
  readonly windowEndMs: number
  readonly windowMode: "live" | "capture"
  readonly totals: SystemLogSeverityCounts24h
  readonly peakHourLabel: string | null
  readonly peakHourCount: number
  /** Average total log events per hour across all buckets in the 24-hour window. */
  readonly meanHourlyVolume: number
  /** Minimum hourly event count considered a spike above the 24h mean + 1.5 sigma. */
  readonly spikeThreshold: number
  /** Number of hourly buckets flagged as activity spikes within the 24-hour window. */
  readonly spikeHourCount: number
  readonly includedLogs: number
  readonly outsideWindowLogs: number
  readonly unparsedTimestampLogs: number
}

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** Maps weblog or unified system stream severity labels into canonical 4-tier severities. */
export function normalizeLogSeverityLevel(rawLevel: string): SystemLogSeverityLevel {
  const key = rawLevel.trim().toUpperCase()
  if (key === "CRITICAL" || key === "CRIT" || key === "ERROR" || key === "ERR" || key === "FATAL") {
    return "CRITICAL"
  }
  if (key === "HIGH" || key === "WARN" || key === "WARNING") {
    return "HIGH"
  }
  if (key === "WATCH" || key === "MED" || key === "MEDIUM") {
    return "WATCH"
  }
  return "NORMAL"
}

/**
 * Parses epoch milliseconds from a WebLog entry (`sourceSortMs`, `sourceTime`, or `dateLabel` +
 * `timeEst`) or a UnifiedSystemLogRow (`timestamp`).
 */
export function parseSystemLogEntryTimestampMs(entry: {
  readonly sourceSortMs?: number | undefined
  readonly sourceTime?: string | null | undefined
  readonly dateLabel?: string | undefined
  readonly timeEst?: string | undefined
  readonly timestamp?: string | number | undefined
}): number | null {
  if (
    typeof entry.sourceSortMs === "number" &&
    Number.isFinite(entry.sourceSortMs) &&
    entry.sourceSortMs > 0
  ) {
    return entry.sourceSortMs
  }
  if (
    typeof entry.timestamp === "number" &&
    Number.isFinite(entry.timestamp) &&
    entry.timestamp > 0
  ) {
    return entry.timestamp
  }

  const parseValidDate = (raw: string): number | null => {
    const parsed = Date.parse(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  if (typeof entry.timestamp === "string" && entry.timestamp.trim() !== "") {
    const trimmed = entry.timestamp.trim()
    if (/^\d{10,13}$/.test(trimmed)) {
      const num = Number.parseInt(trimmed, 10)
      return trimmed.length === 10 ? num * 1000 : num
    }
    const parsed = parseValidDate(trimmed)
    if (parsed !== null) {
      return parsed
    }
  }

  if (typeof entry.sourceTime === "string" && entry.sourceTime.trim() !== "") {
    const isoCandidate = entry.sourceTime.trim().replace(" ", "T")
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(isoCandidate)
    const parsed = parseValidDate(hasZone ? isoCandidate : `${isoCandidate}-05:00`)
    if (parsed !== null) {
      return parsed
    }
  }

  if (typeof entry.dateLabel === "string" && entry.dateLabel.trim() !== "") {
    const timePart = typeof entry.timeEst === "string" ? entry.timeEst.trim() : ""
    const combined = timePart ? `${entry.dateLabel.trim()} ${timePart}` : entry.dateLabel.trim()
    return parseValidDate(combined)
  }

  return null
}

function formatHourClock(epochMs: number): string {
  return `${String(new Date(epochMs).getHours()).padStart(2, "0")}:00`
}

export interface Build24HourSeveritySeriesOptions {
  readonly anchorMs?: number | undefined
  readonly windowHours?: number | undefined
}

/**
 * Buckets arbitrary log records into 24 consecutive 1-hour bins spanning the last 24 hours,
 * counting `CRITICAL`, `HIGH`, `WATCH`, and `NORMAL` severities.
 */
export function build24HourSeveritySeries<T>(
  rows: readonly T[],
  extractors: {
    readonly getTimestampMs: (row: T) => number | null
    readonly getSeverity: (row: T) => SystemLogSeverityLevel
  },
  options: Build24HourSeveritySeriesOptions = {},
): SystemLogSeveritySeriesResult {
  const windowHours = Math.max(1, Math.round(options.windowHours ?? SYSTEM_LOG_WINDOW_HOURS))
  const anchorMs =
    typeof options.anchorMs === "number" && Number.isFinite(options.anchorMs)
      ? options.anchorMs
      : Date.now()

  const parsedEntries: Array<{ readonly ts: number; readonly severity: SystemLogSeverityLevel }> =
    []
  let unparsedTimestampLogs = 0
  let maxParsedTs = -Infinity

  for (const row of rows) {
    const ts = extractors.getTimestampMs(row)
    if (ts === null || !Number.isFinite(ts) || ts <= 0) {
      unparsedTimestampLogs += 1
      continue
    }
    if (ts > maxParsedTs) {
      maxParsedTs = ts
    }
    parsedEntries.push({
      ts,
      severity: extractors.getSeverity(row),
    })
  }

  let windowMode: "live" | "capture" = "live"
  let windowEndMs =
    Math.floor(anchorMs / SYSTEM_LOG_HOUR_MS) * SYSTEM_LOG_HOUR_MS + SYSTEM_LOG_HOUR_MS
  let windowStartMs = windowEndMs - windowHours * SYSTEM_LOG_HOUR_MS

  const hasLiveEntry = parsedEntries.some((e) => e.ts >= windowStartMs && e.ts < windowEndMs)
  if (!hasLiveEntry && parsedEntries.length > 0 && Number.isFinite(maxParsedTs)) {
    windowMode = "capture"
    windowEndMs =
      Math.floor(maxParsedTs / SYSTEM_LOG_HOUR_MS) * SYSTEM_LOG_HOUR_MS + SYSTEM_LOG_HOUR_MS
    windowStartMs = windowEndMs - windowHours * SYSTEM_LOG_HOUR_MS
  }

  const counts = Array.from({ length: windowHours }, () => ({
    CRITICAL: 0,
    HIGH: 0,
    WATCH: 0,
    NORMAL: 0,
  }))

  let includedLogs = 0
  let outsideWindowLogs = 0

  for (const entry of parsedEntries) {
    if (entry.ts < windowStartMs || entry.ts >= windowEndMs) {
      outsideWindowLogs += 1
      continue
    }
    const rawIdx = Math.floor((entry.ts - windowStartMs) / SYSTEM_LOG_HOUR_MS)
    const idx = Math.max(0, Math.min(windowHours - 1, rawIdx))
    counts[idx]![entry.severity] += 1
    includedLogs += 1
  }

  let totalCritical = 0
  let totalHigh = 0
  let totalWatch = 0
  let totalNormal = 0
  const binTotals = counts.map((bin) => {
    totalCritical += bin.CRITICAL
    totalHigh += bin.HIGH
    totalWatch += bin.WATCH
    totalNormal += bin.NORMAL
    return bin.CRITICAL + bin.HIGH + bin.WATCH + bin.NORMAL
  })

  const meanRaw = includedLogs / windowHours
  let squaredDiffSum = 0
  for (const total of binTotals) {
    const diff = total - meanRaw
    squaredDiffSum += diff * diff
  }
  const stdDev = Math.sqrt(squaredDiffSum / windowHours)
  const meanHourlyVolume = Math.round(meanRaw * 100) / 100
  const spikeThreshold = includedLogs > 0 ? Math.max(3, Math.ceil(meanRaw + 1.5 * stdDev)) : 0

  let peakHourLabel: string | null = null
  let peakHourCount = 0
  let spikeHourCount = 0

  const buckets: SystemLogSeverityBucket[] = counts.map((bin, idx) => {
    const bucketStartMs = windowStartMs + idx * SYSTEM_LOG_HOUR_MS
    const bucketEndMs = bucketStartMs + SYSTEM_LOG_HOUR_MS
    const startDate = new Date(bucketStartMs)
    const hourLabel = formatHourClock(bucketStartMs)
    const total = binTotals[idx]!
    const isSpike = spikeThreshold > 0 && total >= spikeThreshold && total > meanRaw * 1.5
    const hoursAgo = windowHours - 1 - idx

    if (isSpike) {
      spikeHourCount += 1
    }
    if (total > peakHourCount) {
      peakHourCount = total
      peakHourLabel = hourLabel
    }

    return {
      bucketIndex: idx,
      bucketStartMs,
      bucketEndMs,
      hourLabel,
      rangeLabel: `${hourLabel}–${formatHourClock(bucketEndMs)}`,
      dateTimeLabel: `${MONTH_SHORT[startDate.getMonth()] ?? "—"} ${startDate.getDate()}, ${hourLabel}`,
      relativeLabel: hoursAgo === 0 ? "This hr" : `-${hoursAgo}h`,
      CRITICAL: bin.CRITICAL,
      HIGH: bin.HIGH,
      WATCH: bin.WATCH,
      NORMAL: bin.NORMAL,
      total,
      isSpike,
    }
  })

  return {
    buckets,
    windowStartMs,
    windowEndMs,
    windowMode,
    totals: {
      CRITICAL: totalCritical,
      HIGH: totalHigh,
      WATCH: totalWatch,
      NORMAL: totalNormal,
      total: includedLogs,
    },
    peakHourLabel,
    peakHourCount,
    meanHourlyVolume,
    spikeThreshold,
    spikeHourCount,
    includedLogs,
    outsideWindowLogs,
    unparsedTimestampLogs,
  }
}

export interface WebLogSeveritySourceEntry {
  readonly severity: string
  readonly sourceSortMs?: number | undefined
  readonly sourceTime?: string | null | undefined
  readonly dateLabel?: string | undefined
  readonly timeEst?: string | undefined
}

export function buildWebLog24HourSeveritySeries(
  entries: readonly WebLogSeveritySourceEntry[],
  options?: Build24HourSeveritySeriesOptions,
): SystemLogSeveritySeriesResult {
  return build24HourSeveritySeries(
    entries,
    {
      getTimestampMs: (row) => parseSystemLogEntryTimestampMs(row),
      getSeverity: (row) => normalizeLogSeverityLevel(row.severity),
    },
    options,
  )
}

export function buildUnifiedLog24HourSeveritySeries(
  entries: readonly Pick<UnifiedSystemLogRow, "timestamp" | "level">[],
  options?: Build24HourSeveritySeriesOptions,
): SystemLogSeveritySeriesResult {
  return build24HourSeveritySeries(
    entries,
    {
      getTimestampMs: (row) => parseSystemLogEntryTimestampMs({ timestamp: row.timestamp }),
      getSeverity: (row) => normalizeLogSeverityLevel(row.level),
    },
    options,
  )
}
