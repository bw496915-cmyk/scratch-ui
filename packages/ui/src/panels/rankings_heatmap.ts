/**
 * @file rankings_heatmap.ts
 * @description Pure scaling, outlier clamping, and bucket-evaluation logic for
 * the Rankings tab handle-volume heat-map overlay.
 *
 * Positive handles are normalized with log10(handle + 1) and clamped to the
 * visible dataset's P5–P95 bounds so a single whale/syndicate outlier does not
 * compress all other agents into bucket 1. Null, undefined, and <= 0 handles
 * deterministically map to bucket 0 (no heat shading).
 */

export type HeatBucket = 0 | 1 | 2 | 3 | 4 | 5

export const HEAT_BUCKETS: readonly HeatBucket[] = [0, 1, 2, 3, 4, 5]

export const RANKINGS_HEATMAP_STORAGE_KEY = "sportsdesk.rankings.heatmap"

export interface HandleHeatScale {
  readonly totalCount: number
  readonly positiveCount: number
  readonly totalVisibleHandle: number
  readonly min: number
  readonly p5: number
  readonly median: number
  readonly p95: number
  readonly max: number
  readonly logLow: number
  readonly logHigh: number
  readonly sortedPositive: readonly number[]
}

export interface HandleHeatCellMetrics {
  readonly bucket: HeatBucket
  readonly handleUsd: number | null
  readonly isInactive: boolean
  readonly shareOfVisiblePct: number
  readonly percentileRank: number
  readonly exactHandleLabel: string
  readonly shareLabel: string
  readonly percentileLabel: string
  readonly summaryTitle: string
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const lo = sorted[base]!
  const hi = sorted[Math.min(sorted.length - 1, base + 1)]!
  return lo + rest * (hi - lo)
}

function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid]! <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function formatOrdinal(n: number): string {
  const mod100 = n % 100
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`
  const mod10 = n % 10
  if (mod10 === 1) return `${n}st`
  if (mod10 === 2) return `${n}nd`
  if (mod10 === 3) return `${n}rd`
  return `${n}th`
}

export function formatHeatCurrencyCompact(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0"
  if (usd >= 1_000_000_000) return `$${(usd / 1_000_000_000).toFixed(2)}B`
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`
  if (usd >= 10_000) return `$${(usd / 1_000).toFixed(1)}K`
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(2)}K`
  return `$${Math.round(usd).toLocaleString("en-US")}`
}

export function formatHeatExactCurrency(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "—"
  if (usd === 0) return "$0"
  const sign = usd < 0 ? "-" : ""
  const abs = Math.abs(usd)
  const hasCents = Math.abs(abs - Math.round(abs)) >= 0.005
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  })}`
}

/**
 * Compute log10 + P5–P95 clamped intensity thresholds for the currently visible
 * dataset. Call inside `useMemo` keyed only on the filtered (unsorted) dataset
 * so sorting, scrolling, and hovering never recalculate thresholds.
 */
export function createHandleHeatScale(
  handles: readonly (number | null | undefined)[],
): HandleHeatScale {
  const positive: number[] = []
  let totalVisibleHandle = 0

  for (let i = 0; i < handles.length; i += 1) {
    const val = handles[i]
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      positive.push(val)
      totalVisibleHandle += val
    }
  }

  positive.sort((a, b) => a - b)

  if (positive.length === 0) {
    return {
      totalCount: handles.length,
      positiveCount: 0,
      totalVisibleHandle: 0,
      min: 0,
      p5: 0,
      median: 0,
      p95: 0,
      max: 0,
      logLow: 0,
      logHigh: 0,
      sortedPositive: positive,
    }
  }

  const min = positive[0]!
  const max = positive[positive.length - 1]!
  const median = quantile(positive, 0.5)
  const logSorted = positive.map((v) => Math.log10(v + 1))
  const logLow = quantile(logSorted, 0.05)
  const logHigh = quantile(logSorted, 0.95)
  const p5 = Math.max(min, Math.pow(10, logLow) - 1)
  const p95 = Math.min(max, Math.pow(10, logHigh) - 1)

  return {
    totalCount: handles.length,
    positiveCount: positive.length,
    totalVisibleHandle,
    min,
    p5,
    median,
    p95,
    max,
    logLow,
    logHigh,
    sortedPositive: positive,
  }
}

/**
 * Map a single handle value to its discrete intensity bucket (0–5) and tooltip
 * metrics against a precomputed `HandleHeatScale`.
 *
 * Null, undefined, NaN, and <= 0 values strictly map to bucket 0 (unshaded).
 * Positive active values map across buckets 1–5 using log10(h + 1) clamped
 * to [P5, P95].
 */
export function evaluateHandleHeatCell(
  scale: HandleHeatScale,
  rawHandle: number | null | undefined,
): HandleHeatCellMetrics {
  if (
    rawHandle === null ||
    rawHandle === undefined ||
    typeof rawHandle !== "number" ||
    !Number.isFinite(rawHandle) ||
    rawHandle <= 0
  ) {
    const exactHandleLabel = rawHandle === 0 ? "$0" : formatHeatExactCurrency(rawHandle)
    return {
      bucket: 0,
      handleUsd: typeof rawHandle === "number" && Number.isFinite(rawHandle) ? rawHandle : null,
      isInactive: true,
      shareOfVisiblePct: 0,
      percentileRank: 0,
      exactHandleLabel,
      shareLabel: "0.0%",
      percentileLabel: "Inactive",
      summaryTitle: `Handle: ${exactHandleLabel} · 0.0% of visible handle · Inactive (No heat shading)`,
    }
  }

  let normalized = 0.5
  if (scale.logHigh > scale.logLow) {
    const logVal = Math.log10(rawHandle + 1)
    normalized = Math.max(0, Math.min(1, (logVal - scale.logLow) / (scale.logHigh - scale.logLow)))
  }

  const bucket = Math.min(5, Math.max(1, 1 + Math.floor(normalized * 5))) as HeatBucket

  const shareOfVisiblePct =
    scale.totalVisibleHandle > 0 ? (rawHandle / scale.totalVisibleHandle) * 100 : 0

  let percentileRank = 100
  if (scale.positiveCount > 1) {
    const below = lowerBound(scale.sortedPositive, rawHandle)
    const belowOrEqual = upperBound(scale.sortedPositive, rawHandle)
    const equal = Math.max(1, belowOrEqual - below)
    percentileRank = Math.min(
      100,
      Math.max(1, Math.round(((below + 0.5 * equal) / scale.positiveCount) * 100)),
    )
  }

  const exactHandleLabel = formatHeatExactCurrency(rawHandle)
  const shareLabel = `${shareOfVisiblePct.toFixed(1)}%`
  const percentileLabel = `P${percentileRank} (${formatOrdinal(percentileRank)})`

  return {
    bucket,
    handleUsd: rawHandle,
    isInactive: false,
    shareOfVisiblePct,
    percentileRank,
    exactHandleLabel,
    shareLabel,
    percentileLabel,
    summaryTitle: `Handle: ${exactHandleLabel} · ${shareLabel} of visible handle · ${percentileLabel} · Intensity ${bucket}/5`,
  }
}

/**
 * Precompute a read-only Map of entity key -> HandleHeatCellMetrics whenever
 * the visible dataset changes, preventing per-hover or per-scroll allocations.
 */
export function buildHandleHeatLookup<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  getHandle: (item: T) => number | null | undefined,
): {
  readonly scale: HandleHeatScale
  readonly byKey: ReadonlyMap<string, HandleHeatCellMetrics>
} {
  const handles = items.map(getHandle)
  const scale = createHandleHeatScale(handles)
  const byKey = new Map<string, HandleHeatCellMetrics>()
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    byKey.set(getKey(item), evaluateHandleHeatCell(scale, handles[i]))
  }
  return { scale, byKey }
}

function defaultStorage(): Storage | null {
  try {
    const candidate = (globalThis as unknown as { localStorage?: Storage }).localStorage
    return candidate ?? null
  } catch {
    return null
  }
}

export function parseStoredRankingsHeatMapValue(raw: string | null | undefined): boolean | null {
  if (raw === "0" || raw === "false" || raw === "off") return false
  if (raw === "1" || raw === "true" || raw === "on") return true
  return null
}

export function readStoredRankingsHeatMap(
  storage: Pick<Storage, "getItem"> | null = defaultStorage(),
): boolean | null {
  if (!storage) return null
  try {
    return parseStoredRankingsHeatMapValue(storage.getItem(RANKINGS_HEATMAP_STORAGE_KEY))
  } catch {
    return null
  }
}

export function writeStoredRankingsHeatMap(
  enabled: boolean,
  storage: Pick<Storage, "setItem"> | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(RANKINGS_HEATMAP_STORAGE_KEY, enabled ? "1" : "0")
  } catch {
    // Ignore quota or private-browsing storage errors cleanly.
  }
}
