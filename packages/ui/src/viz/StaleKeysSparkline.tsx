import { area, curveMonotoneX, line, max, min, scaleLinear, scaleTime } from "d3"
import type React from "react"
import { useId, useMemo, useState } from "react"

import type { R2PipelineHistoryApiResponse, R2SinkHistorySample } from "../types.ts"

export const STALE_KEYS_TREND_WINDOW_MINUTES = 60
export const DEFAULT_STALE_KEYS_DANGER_THRESHOLD = 2
export const STALE_KEYS_DANGER_THRESHOLD_STORAGE_KEY = "sportsdesk_r2_stale_danger_threshold"

const DEFAULT_SPARK_WIDTH = 144
const DEFAULT_SPARK_HEIGHT = 34
const SPARK_PAD_X = 3
const SPARK_PAD_Y = 4

export interface StaleKeysTrendPoint {
  readonly at: string
  readonly atMs: number
  readonly staleCount: number
  readonly totalSinks: number
}

export interface StaleKeysSparklineCoord {
  readonly x: number
  readonly y: number
  readonly at: string
  readonly staleCount: number
  readonly exceeded: boolean
}

export interface StaleKeysSparklineGeometry {
  readonly effectiveTotal: number
  readonly maxThreshold: number
  readonly effectiveThreshold: number
  readonly latestCount: number
  readonly firstCount: number
  readonly minCount: number
  readonly maxCount: number
  readonly isDangerNow: boolean
  readonly peakExceededDanger: boolean
  readonly baselineY: number
  readonly thresholdY: number
  readonly dangerZoneHeight: number
  readonly linePath: string | null
  readonly areaPath: string | null
  readonly coords: readonly StaleKeysSparklineCoord[]
}

export interface StaleKeysSparklineProps {
  readonly points: readonly StaleKeysTrendPoint[]
  readonly fallbackStaleCount: number | null
  readonly totalSinks: number
  readonly dangerThreshold: number
  readonly onDangerThresholdChange: (nextThreshold: number) => void
  readonly width?: number
  readonly height?: number
}

export function normalizeStaleKeysDangerThreshold(raw: unknown, maxSinks?: number): number {
  const maxAllowed =
    typeof maxSinks === "number" && Number.isFinite(maxSinks) && maxSinks > 0
      ? Math.max(0, Math.floor(maxSinks) - 1)
      : 99
  const fallback = Math.min(DEFAULT_STALE_KEYS_DANGER_THRESHOLD, maxAllowed)

  let parsed = Number.NaN
  if (typeof raw === "number") {
    parsed = raw
  } else if (typeof raw === "string") {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return fallback
    parsed = Number(trimmed)
  } else {
    return fallback
  }

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback
  }
  return Math.min(parsed, maxAllowed)
}

export function readStoredStaleKeysDangerThreshold(
  storage?: Pick<Storage, "getItem"> | null,
): number {
  try {
    const target =
      storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null
    if (!target) return DEFAULT_STALE_KEYS_DANGER_THRESHOLD
    const raw = target.getItem(STALE_KEYS_DANGER_THRESHOLD_STORAGE_KEY)
    if (raw === null) return DEFAULT_STALE_KEYS_DANGER_THRESHOLD
    return normalizeStaleKeysDangerThreshold(raw)
  } catch {
    return DEFAULT_STALE_KEYS_DANGER_THRESHOLD
  }
}

export function writeStoredStaleKeysDangerThreshold(
  threshold: number,
  storage?: Pick<Storage, "setItem"> | null,
): void {
  try {
    const target =
      storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null
    if (!target) return
    target.setItem(
      STALE_KEYS_DANGER_THRESHOLD_STORAGE_KEY,
      String(normalizeStaleKeysDangerThreshold(threshold)),
    )
  } catch {
    // Ignore storage quota or sandbox restrictions.
  }
}

/**
 * Reconstruct the aggregate `staleKeys` count (`state !== "fresh"`) across all
 * sinks over the last `windowMinutes` from process-local `r2PipelineHistory`.
 * Carries forward each sink's last known state prior to the window so partial
 * state-change samples still report an accurate fleet-wide count.
 */
export function buildStaleKeysTrendSeries(
  history: R2PipelineHistoryApiResponse | null | undefined,
  windowMinutes = STALE_KEYS_TREND_WINDOW_MINUTES,
): readonly StaleKeysTrendPoint[] {
  if (!history || history.sinks.length === 0) return []

  const parsedSinks = history.sinks.map((sink) =>
    sink.samples
      .map((sample) => ({
        atMs: Date.parse(sample.at),
        state: sample.state,
      }))
      .filter((entry) => Number.isFinite(entry.atMs))
      .sort((a, b) => a.atMs - b.atMs),
  )

  let maxSampleMs = -Infinity
  for (const samples of parsedSinks) {
    const last = samples[samples.length - 1]
    if (last && last.atMs > maxSampleMs) maxSampleMs = last.atMs
  }
  if (!Number.isFinite(maxSampleMs)) return []

  const observedMs = Date.parse(history.observedAt)
  const endMs = Number.isFinite(observedMs) ? Math.max(observedMs, maxSampleMs) : maxSampleMs
  const windowStartMs = endMs - windowMinutes * 60_000

  const windowTimestamps = new Set<number>()
  for (const samples of parsedSinks) {
    for (const sample of samples) {
      if (sample.atMs >= windowStartMs && sample.atMs <= endMs) {
        windowTimestamps.add(sample.atMs)
      }
    }
  }
  if (windowTimestamps.size === 0) return []

  const sortedTimestamps = [...windowTimestamps].sort((a, b) => a - b)
  const cursors = parsedSinks.map(() => 0)
  const latestStates: Array<R2SinkHistorySample["state"] | null> = parsedSinks.map(() => null)

  // Seed each sink's state from observations prior to the 60-minute window.
  for (let s = 0; s < parsedSinks.length; s++) {
    const samples = parsedSinks[s]!
    while (cursors[s]! < samples.length && samples[cursors[s]!]!.atMs < windowStartMs) {
      latestStates[s] = samples[cursors[s]!]!.state
      cursors[s] = cursors[s]! + 1
    }
  }

  const totalSinks = history.sinks.length
  const points: StaleKeysTrendPoint[] = []

  for (const atMs of sortedTimestamps) {
    for (let s = 0; s < parsedSinks.length; s++) {
      const samples = parsedSinks[s]!
      while (cursors[s]! < samples.length && samples[cursors[s]!]!.atMs <= atMs) {
        latestStates[s] = samples[cursors[s]!]!.state
        cursors[s] = cursors[s]! + 1
      }
    }
    let staleCount = 0
    for (const state of latestStates) {
      if (state !== null && state !== "fresh") staleCount++
    }
    points.push({
      at: new Date(atMs).toISOString(),
      atMs,
      staleCount,
      totalSinks,
    })
  }

  return points
}

/**
 * Pure D3 scale + path geometry builder for the 60-minute `staleKeys` sparkline.
 * Uses `d3.scaleTime`, `d3.scaleLinear`, `d3.line`, and `d3.area` with `curveMonotoneX`.
 */
export function computeStaleKeysSparklineGeometry({
  points,
  fallbackStaleCount,
  totalSinks,
  dangerThreshold,
  width = DEFAULT_SPARK_WIDTH,
  height = DEFAULT_SPARK_HEIGHT,
}: {
  readonly points: readonly StaleKeysTrendPoint[]
  readonly fallbackStaleCount: number | null
  readonly totalSinks: number
  readonly dangerThreshold: number
  readonly width?: number
  readonly height?: number
}): StaleKeysSparklineGeometry {
  const effectiveTotal = Math.max(1, totalSinks)
  const maxThreshold = Math.max(0, effectiveTotal - 1)
  const effectiveThreshold = normalizeStaleKeysDangerThreshold(dangerThreshold, effectiveTotal)

  const latestCount =
    points.length > 0 ? points[points.length - 1]!.staleCount : (fallbackStaleCount ?? 0)
  const firstCount = points.length > 0 ? points[0]!.staleCount : latestCount
  const minCount =
    points.length > 0 ? (min(points, (d) => d.staleCount) ?? latestCount) : latestCount
  const maxCount =
    points.length > 0 ? (max(points, (d) => d.staleCount) ?? latestCount) : latestCount

  const isDangerNow = latestCount > effectiveThreshold
  const peakExceededDanger = maxCount > effectiveThreshold

  const yScale = scaleLinear()
    .domain([0, effectiveTotal])
    .range([height - SPARK_PAD_Y, SPARK_PAD_Y])
    .clamp(true)

  const baselineY = yScale(0)
  const thresholdY = yScale(effectiveThreshold)
  const dangerZoneHeight = Math.max(0, thresholdY - SPARK_PAD_Y)

  if (points.length === 0) {
    return {
      effectiveTotal,
      maxThreshold,
      effectiveThreshold,
      latestCount,
      firstCount,
      minCount,
      maxCount,
      isDangerNow,
      peakExceededDanger,
      baselineY,
      thresholdY,
      dangerZoneHeight,
      linePath: null,
      areaPath: null,
      coords: [],
    }
  }

  const firstMs = points[0]!.atMs
  const lastMs = points[points.length - 1]!.atMs
  const spanMs = Math.max(0, lastMs - firstMs)
  const domainStart =
    points.length >= 2 && spanMs > 0
      ? new Date(firstMs)
      : new Date(lastMs - STALE_KEYS_TREND_WINDOW_MINUTES * 60_000)
  const domainEnd = new Date(lastMs)

  const xScale = scaleTime()
    .domain([domainStart, domainEnd])
    .range([SPARK_PAD_X, width - SPARK_PAD_X])

  const xForPoint = (pt: StaleKeysTrendPoint, idx: number): number => {
    if (points.length === 1) return width / 2
    if (spanMs === 0) {
      return SPARK_PAD_X + (idx / (points.length - 1)) * (width - SPARK_PAD_X * 2)
    }
    return xScale(new Date(pt.atMs))
  }

  const coords: StaleKeysSparklineCoord[] = points.map((pt, idx) => ({
    x: xForPoint(pt, idx),
    y: yScale(pt.staleCount),
    at: pt.at,
    staleCount: pt.staleCount,
    exceeded: pt.staleCount > effectiveThreshold,
  }))

  let linePath: string | null = null
  let areaPath: string | null = null

  if (points.length >= 2) {
    const lineGen = line<StaleKeysTrendPoint>()
      .x((d, idx) => xForPoint(d, idx))
      .y((d) => yScale(d.staleCount))
      .curve(curveMonotoneX)

    const areaGen = area<StaleKeysTrendPoint>()
      .x((d, idx) => xForPoint(d, idx))
      .y0(baselineY)
      .y1((d) => yScale(d.staleCount))
      .curve(curveMonotoneX)

    linePath = lineGen(points)
    areaPath = areaGen(points)
  }

  return {
    effectiveTotal,
    maxThreshold,
    effectiveThreshold,
    latestCount,
    firstCount,
    minCount,
    maxCount,
    isDangerNow,
    peakExceededDanger,
    baselineY,
    thresholdY,
    dangerZoneHeight,
    linePath,
    areaPath,
    coords,
  }
}

export function StaleKeysSparkline({
  points,
  fallbackStaleCount,
  totalSinks,
  dangerThreshold,
  onDangerThresholdChange,
  width = DEFAULT_SPARK_WIDTH,
  height = DEFAULT_SPARK_HEIGHT,
}: StaleKeysSparklineProps): React.ReactElement {
  const gradId = useId()
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const chart = useMemo(
    () =>
      computeStaleKeysSparklineGeometry({
        points,
        fallbackStaleCount,
        totalSinks,
        dangerThreshold,
        width,
        height,
      }),
    [points, fallbackStaleCount, totalSinks, dangerThreshold, width, height],
  )

  const activeCoord =
    hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < chart.coords.length
      ? chart.coords[hoveredIdx]!
      : null
  const displayCount = activeCoord ? activeCoord.staleCount : chart.latestCount
  const displayExceeded = displayCount > chart.effectiveThreshold
  const tone = chart.isDangerNow ? "#f87171" : chart.latestCount === 0 ? "#4ade80" : "#fbbf24"
  const activeTone = displayExceeded ? "#f87171" : displayCount === 0 ? "#4ade80" : "#fbbf24"
  const delta = chart.latestCount - chart.firstCount
  const trendLabel =
    points.length < 2
      ? points.length === 1
        ? "1 sample"
        : "no samples"
      : delta > 0
        ? `↑ +${delta}`
        : delta < 0
          ? `↓ ${delta}`
          : "→ steady"

  const lastCoord = chart.coords.length > 0 ? chart.coords[chart.coords.length - 1]! : null

  const baseAriaLabel =
    points.length >= 2
      ? `staleKeys trend over last 60 minutes: latest ${chart.latestCount} of ${chart.effectiveTotal} stale across ${points.length} samples (min ${chart.minCount}, max ${chart.maxCount})`
      : `staleKeys count over last 60 minutes: ${chart.latestCount} of ${chart.effectiveTotal} stale (${points.length} sample${points.length === 1 ? "" : "s"})`
  const ariaLabel = `${baseAriaLabel}, danger threshold >${chart.effectiveThreshold}${chart.isDangerNow ? " (DANGER: threshold exceeded)" : ""}`

  const canDecrease = chart.effectiveThreshold > 0
  const canIncrease = chart.effectiveThreshold < chart.maxThreshold
  const stepperBtnStyle = (enabled: boolean): React.CSSProperties => ({
    padding: "0 4px",
    minWidth: "16px",
    height: "15px",
    lineHeight: "13px",
    borderRadius: "3px",
    fontSize: "10px",
    fontWeight: 700,
    border: "1px solid rgba(71, 85, 105, 0.85)",
    backgroundColor: enabled ? "rgba(30, 41, 59, 0.85)" : "rgba(15, 23, 42, 0.4)",
    color: enabled ? "#cbd5e1" : "#475569",
    cursor: enabled ? "pointer" : "not-allowed",
  })

  return (
    <div
      data-stale-keys-sparkline="true"
      data-chart-engine="d3"
      data-stale-danger-threshold={String(chart.effectiveThreshold)}
      data-stale-danger-exceeded={chart.isDangerNow ? "true" : "false"}
      onMouseLeave={() => setHoveredIdx(null)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        padding: "6px 10px",
        borderRadius: "6px",
        backgroundColor: chart.isDangerNow ? "rgba(127, 29, 29, 0.28)" : "rgba(15, 23, 42, 0.72)",
        border: chart.isDangerNow
          ? "1px solid rgba(239, 68, 68, 0.85)"
          : "1px solid rgba(51, 65, 85, 0.75)",
        minWidth: "168px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "8px",
          fontSize: "10px",
          lineHeight: 1.2,
        }}
      >
        <span style={{ color: "#94a3b8", fontWeight: 600 }}>
          {activeCoord ? `staleKeys · ${activeCoord.at.slice(11, 16)}Z` : "staleKeys · 60m"}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            fontWeight: 700,
            color: activeTone,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {chart.isDangerNow && (
            <span
              data-stale-danger-badge="true"
              style={{
                padding: "1px 4px",
                borderRadius: "3px",
                fontSize: "9px",
                fontWeight: 800,
                letterSpacing: "0.04em",
                color: "#fecaca",
                backgroundColor: "rgba(239, 68, 68, 0.3)",
                border: "1px solid #ef4444",
              }}
            >
              DANGER
            </span>
          )}
          {displayCount}/{chart.effectiveTotal}
        </span>
      </div>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        style={{ display: "block", overflow: "visible" }}
      >
        <title>{ariaLabel}</title>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity={0.34} />
            <stop offset="100%" stopColor={tone} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        {chart.dangerZoneHeight > 0 && (
          <rect
            data-stale-danger-zone="true"
            x={SPARK_PAD_X}
            y={SPARK_PAD_Y}
            width={width - SPARK_PAD_X * 2}
            height={chart.dangerZoneHeight.toFixed(1)}
            fill="#ef4444"
            fillOpacity={chart.isDangerNow ? 0.16 : 0.08}
          />
        )}
        <line
          x1={SPARK_PAD_X}
          y1={chart.baselineY.toFixed(1)}
          x2={width - SPARK_PAD_X}
          y2={chart.baselineY.toFixed(1)}
          stroke="#475569"
          strokeDasharray="2 3"
          strokeWidth={1}
          strokeOpacity={0.75}
        />
        <line
          data-stale-threshold-line="true"
          data-threshold-value={String(chart.effectiveThreshold)}
          x1={SPARK_PAD_X}
          y1={chart.thresholdY.toFixed(1)}
          x2={width - SPARK_PAD_X}
          y2={chart.thresholdY.toFixed(1)}
          stroke="#ef4444"
          strokeDasharray="3 2"
          strokeWidth={1.25}
          strokeOpacity={chart.isDangerNow || chart.peakExceededDanger ? 0.95 : 0.72}
        />
        {chart.areaPath && (
          <path
            data-d3-sparkline-area="true"
            d={chart.areaPath}
            fill={`url(#${gradId})`}
            stroke="none"
          />
        )}
        {chart.linePath && (
          <path
            data-d3-sparkline-line="true"
            d={chart.linePath}
            fill="none"
            stroke={tone}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {chart.coords.map((coord, idx) => {
          const isLast = idx === chart.coords.length - 1
          const isHovered = hoveredIdx === idx
          return (
            <g key={coord.at}>
              {coord.exceeded && !isLast && (
                <circle
                  data-stale-breach-point="true"
                  cx={coord.x.toFixed(1)}
                  cy={coord.y.toFixed(1)}
                  r={isHovered ? 3.2 : 2.1}
                  fill="#ef4444"
                />
              )}
              {isHovered && !isLast && !coord.exceeded && (
                <circle cx={coord.x.toFixed(1)} cy={coord.y.toFixed(1)} r={2.8} fill={tone} />
              )}
              <circle
                cx={coord.x.toFixed(1)}
                cy={coord.y.toFixed(1)}
                r={5}
                fill="transparent"
                style={{ cursor: "crosshair" }}
                onMouseEnter={() => setHoveredIdx(idx)}
              >
                <title>
                  {`${coord.at.slice(11, 16)}Z: ${coord.staleCount}/${chart.effectiveTotal} stale`}
                </title>
              </circle>
            </g>
          )
        })}
        {lastCoord && (
          <>
            <circle
              cx={lastCoord.x.toFixed(1)}
              cy={lastCoord.y.toFixed(1)}
              r={4.2}
              fill={tone}
              fillOpacity={0.22}
              pointerEvents="none"
            />
            <circle
              cx={lastCoord.x.toFixed(1)}
              cy={lastCoord.y.toFixed(1)}
              r={2.4}
              fill={tone}
              pointerEvents="none"
            />
          </>
        )}
      </svg>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "8px",
          fontSize: "10px",
          color: "#64748b",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>
          peak {chart.maxCount} · {points.length} {points.length === 1 ? "pt" : "pts"}
        </span>
        <span style={{ color: tone, fontWeight: 600 }}>{trendLabel}</span>
      </div>
      <div
        data-stale-threshold-control="true"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "6px",
          paddingTop: "3px",
          borderTop: "1px solid rgba(51, 65, 85, 0.55)",
          fontSize: "10px",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            color: chart.isDangerNow ? "#fca5a5" : "#94a3b8",
            fontWeight: 600,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: "10px",
              height: "0px",
              borderTop: "1.5px dashed #ef4444",
              display: "inline-block",
            }}
          />
          danger &gt;{chart.effectiveThreshold}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
          <button
            type="button"
            aria-label="Decrease staleKeys danger threshold"
            disabled={!canDecrease}
            onClick={() => onDangerThresholdChange(Math.max(0, chart.effectiveThreshold - 1))}
            style={stepperBtnStyle(canDecrease)}
          >
            −
          </button>
          <button
            type="button"
            aria-label="Increase staleKeys danger threshold"
            disabled={!canIncrease}
            onClick={() =>
              onDangerThresholdChange(Math.min(chart.maxThreshold, chart.effectiveThreshold + 1))
            }
            style={stepperBtnStyle(canIncrease)}
          >
            +
          </button>
        </span>
      </div>
    </div>
  )
}
