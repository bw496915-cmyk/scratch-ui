/**
 * D3 v7 real-time line chart for the Risk Overview panel visualizing the rolling 60-minute wager
 * exposure series (5m rolling pulse, 1m risk flow, and 60m cumulative exposure), thermal activity
 * concentration bands, >2σ surge markers, warning/breach threshold reference lines, and interactive
 * bisector crosshair scrubbing.
 *
 * @file Packages/ui/src/viz/RiskExposureD3Chart.tsx
 */

import { area, bisector, curveMonotoneX, line, scaleLinear, scaleTime } from "d3"
import type React from "react"
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"

import {
  buildRolling60MinRiskSeries,
  formatRiskCompactUsd,
  RISK_ROLLING_PULSE_MINUTES,
  type RiskActivityHeatBand,
  type RiskActivityHeatLevel,
  type RiskExposurePoint,
  type RiskExposureSeriesResult,
} from "../risk_exposure_series.ts"
import type { RiskThresholdStatus } from "../risk_threshold_alert.ts"
import type { LiveWager } from "../types.ts"

export type RiskExposureD3Mode = "rolling" | "perMinute" | "cumulative"

export interface RiskExposureD3ChartProps {
  /** Live wager snapshot from the surveillance feed. */
  readonly wagers: readonly LiveWager[]
  /** True when a valid wager snapshot is present. */
  readonly hasWagerSnapshot: boolean
  /** Feed provenance / snapshot label shown when no data is loaded. */
  readonly snapshotStatus: string
  /** Epoch ms of the last wager payload fetch. */
  readonly wagersLastUpdatedAt?: number | null | undefined
  /** Monotonic WebSocket sync counter to refresh the rolling window on push updates. */
  readonly wsSyncTick?: number | undefined
  /** Epoch ms of the latest WebSocket sync frame. */
  readonly wsLastSyncAt?: number | null | undefined
  /** True when the live WebSocket stream is connected. */
  readonly streamingConnected?: boolean | undefined
  /** Optional manual refresh handler for empty states. */
  readonly onRefreshWagers?: (() => void) | undefined
  /** Configurable 60-minute aggregate risk exposure breach limit in USD. */
  readonly exposureLimitUsd?: number | undefined
  /** Configurable 60-minute aggregate risk exposure warning limit in USD. */
  readonly warningLimitUsd?: number | undefined
  /** Current real-time evaluation status against the configured 60m limit. */
  readonly thresholdStatus?: RiskThresholdStatus | undefined
  /** Optional callback to open the 60m threshold configuration modal. */
  readonly onOpenThresholdModal?: (() => void) | undefined
}

export interface RiskExposureD3Dimensions {
  readonly width: number
  readonly height: number
  readonly padLeft: number
  readonly padRight: number
  readonly padTop: number
  readonly padBottom: number
}

export interface RiskExposureD3Tick {
  readonly value: number
  readonly pos: number
  readonly label: string
}

export interface RiskExposureD3SpikeNode {
  readonly index: number
  readonly bucketMs: number
  readonly cx: number
  readonly cy: number
  readonly zScore: number
  readonly label: string
}

export interface RiskExposureD3HeatRect {
  readonly key: string
  readonly x: number
  readonly width: number
  readonly heatLevel: 1 | 2 | 3 | 4
  readonly band: RiskActivityHeatBand
}

export interface RiskExposureD3ReferenceLine {
  readonly id: "mean" | "twoSigma" | "warning" | "breach"
  readonly y: number
  readonly value: number
  readonly label: string
  readonly tone: "neutral" | "surge" | "warn" | "breach"
}

export interface RiskExposureD3Layout {
  readonly dims: RiskExposureD3Dimensions
  readonly plotLeft: number
  readonly plotRight: number
  readonly plotTop: number
  readonly plotBottom: number
  readonly plotWidth: number
  readonly plotHeight: number
  readonly primaryPath: string | null
  readonly primaryAreaPath: string | null
  readonly secondaryPath: string | null
  readonly xTicks: readonly RiskExposureD3Tick[]
  readonly yTicks: readonly RiskExposureD3Tick[]
  readonly yDomainMax: number
  readonly heatRects: readonly RiskExposureD3HeatRect[]
  readonly spikeNodes: readonly RiskExposureD3SpikeNode[]
  readonly referenceLines: readonly RiskExposureD3ReferenceLine[]
  readonly breachZoneHeight: number
  readonly latestNode: {
    readonly cx: number
    readonly cy: number
    readonly secondaryCy: number
  } | null
  readonly pointCoords: ReadonlyArray<{
    readonly cx: number
    readonly primaryCy: number
    readonly secondaryCy: number
  }>
  readonly xAtMs: (ms: number) => number
  readonly msAtX: (x: number) => number
}

const DEFAULT_WIDTH = 860
const DEFAULT_HEIGHT = 256
const PAD_LEFT = 58
const PAD_RIGHT = 18
const PAD_TOP = 18
const PAD_BOTTOM = 28

const HEAT_LEGEND_ITEMS: ReadonlyArray<{
  readonly level: 1 | 2 | 3 | 4
  readonly label: string
  readonly className: string
}> = [
  { level: 1, label: "Light", className: "sd-risk-d3-heat-swatch--1" },
  { level: 2, label: "Moderate", className: "sd-risk-d3-heat-swatch--2" },
  { level: 3, label: "Elevated", className: "sd-risk-d3-heat-swatch--3" },
  { level: 4, label: "Concentrated", className: "sd-risk-d3-heat-swatch--4" },
]

const HEAT_TEXT_CLASS: Record<RiskActivityHeatLevel, string> = {
  0: "sd-risk-d3-heat-text--0",
  1: "sd-risk-d3-heat-text--1",
  2: "sd-risk-d3-heat-text--2",
  3: "sd-risk-d3-heat-text--3",
  4: "sd-risk-d3-heat-text--4",
}

const bucketMsBisector = bisector<RiskExposurePoint, number>((d) => d.bucketMs).center

export function primaryValueForMode(pt: RiskExposurePoint, mode: RiskExposureD3Mode): number {
  if (mode === "rolling") return pt.rollingRiskUsd
  if (mode === "perMinute") return pt.minuteRiskUsd
  return pt.cumulativeRiskUsd
}

export function secondaryValueForMode(pt: RiskExposurePoint, mode: RiskExposureD3Mode): number {
  if (mode === "rolling") return pt.rollingCriticalRiskUsd
  if (mode === "perMinute") return pt.minuteCriticalRiskUsd
  return pt.cumulativeLiabilityUsd
}

/**
 * Pure D3 v7 scale, path, heat-band, spike-marker, and reference-line layout calculator for the
 * rolling 60-minute wager exposure series.
 */
export function computeRiskExposureD3Layout(options: {
  readonly series: RiskExposureSeriesResult
  readonly mode: RiskExposureD3Mode
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly showOverlay?: boolean | undefined
  readonly exposureLimitUsd?: number | undefined
  readonly warningLimitUsd?: number | undefined
  readonly isBreached?: boolean | undefined
}): RiskExposureD3Layout {
  const width = Math.max(320, Math.round(options.width ?? DEFAULT_WIDTH))
  const height = Math.max(180, Math.round(options.height ?? DEFAULT_HEIGHT))
  const dims: RiskExposureD3Dimensions = {
    width,
    height,
    padLeft: PAD_LEFT,
    padRight: PAD_RIGHT,
    padTop: PAD_TOP,
    padBottom: PAD_BOTTOM,
  }

  const plotLeft = dims.padLeft
  const plotRight = dims.width - dims.padRight
  const plotTop = dims.padTop
  const plotBottom = dims.height - dims.padBottom
  const plotWidth = Math.max(1, plotRight - plotLeft)
  const plotHeight = Math.max(1, plotBottom - plotTop)

  const { series, mode } = options
  const points = series.points
  const domainStart = points[0]?.bucketMs ?? series.windowStartMs
  const domainEnd =
    points[points.length - 1]?.bucketMs ?? Math.max(domainStart + 60_000, series.windowEndMs)

  const xScale = scaleTime()
    .domain([new Date(domainStart), new Date(domainEnd)])
    .range([plotLeft, plotRight])
    .clamp(true)

  let maxDataVal = 0
  for (const pt of points) {
    const pVal = primaryValueForMode(pt, mode)
    if (pVal > maxDataVal) maxDataVal = pVal
    if (options.showOverlay !== false) {
      const sVal = secondaryValueForMode(pt, mode)
      if (sVal > maxDataVal) maxDataVal = sVal
    }
  }

  const limitRef =
    mode === "cumulative" &&
    typeof options.exposureLimitUsd === "number" &&
    Number.isFinite(options.exposureLimitUsd) &&
    options.exposureLimitUsd > 0
      ? options.exposureLimitUsd
      : 0

  const warnRef =
    mode === "cumulative" &&
    typeof options.warningLimitUsd === "number" &&
    Number.isFinite(options.warningLimitUsd) &&
    options.warningLimitUsd > 0 &&
    (limitRef === 0 || options.warningLimitUsd < limitRef)
      ? options.warningLimitUsd
      : 0

  const sigmaRef =
    mode === "perMinute" && series.stdDevMinuteRiskUsd > 0 && series.twoSigmaThresholdUsd > 0
      ? series.twoSigmaThresholdUsd
      : 0

  const rawMax = Math.max(100, maxDataVal * 1.12, limitRef * 1.08, sigmaRef * 1.1)
  const yScale = scaleLinear().domain([0, rawMax]).range([plotBottom, plotTop]).nice(4)
  const yDomainMax = yScale.domain()[1] ?? rawMax

  const primaryLineGen = line<RiskExposurePoint>()
    .x((d) => xScale(new Date(d.bucketMs)))
    .y((d) => yScale(primaryValueForMode(d, mode)))
    .curve(curveMonotoneX)

  const primaryAreaGen = area<RiskExposurePoint>()
    .x((d) => xScale(new Date(d.bucketMs)))
    .y0(plotBottom)
    .y1((d) => yScale(primaryValueForMode(d, mode)))
    .curve(curveMonotoneX)

  const secondaryLineGen = line<RiskExposurePoint>()
    .x((d) => xScale(new Date(d.bucketMs)))
    .y((d) => yScale(secondaryValueForMode(d, mode)))
    .curve(curveMonotoneX)

  const primaryPath = points.length > 0 ? primaryLineGen(points) : null
  const primaryAreaPath = points.length > 0 ? primaryAreaGen(points) : null
  const secondaryPath = points.length > 0 ? secondaryLineGen(points) : null

  const pointCoords = points.map((pt) => ({
    cx: xScale(new Date(pt.bucketMs)),
    primaryCy: yScale(primaryValueForMode(pt, mode)),
    secondaryCy: yScale(secondaryValueForMode(pt, mode)),
  }))

  // Select clean 10-minute (or adaptive for narrow screens) time ticks
  const tickCount = width < 520 ? 5 : 7
  const xTicks: RiskExposureD3Tick[] = []
  if (points.length > 0) {
    const lastIdx = points.length - 1
    const step = Math.max(1, Math.round(lastIdx / (tickCount - 1)))
    const picked = new Set<number>()
    for (let idx = 0; idx < lastIdx; idx += step) {
      if (lastIdx - idx >= Math.ceil(step * 0.45)) {
        picked.add(idx)
      }
    }
    picked.add(lastIdx)
    for (const idx of Array.from(picked).sort((a, b) => a - b)) {
      const pt = points[idx]
      if (!pt) continue
      xTicks.push({
        value: pt.bucketMs,
        pos: xScale(new Date(pt.bucketMs)),
        label: idx === lastIdx ? `${pt.label} (Now)` : pt.label,
      })
    }
  }

  const yTicks: RiskExposureD3Tick[] = yScale.ticks(4).map((val) => ({
    value: val,
    pos: yScale(val),
    label: formatRiskCompactUsd(val),
  }))

  // Activity heat bands mapped to exact xScale spans
  const slotWidth = points.length > 1 ? plotWidth / (points.length - 1) : plotWidth
  const heatRects: RiskExposureD3HeatRect[] = []
  for (const band of series.heatBands) {
    const startPt = points[band.startIdx]
    const endPt = points[band.endIdx]
    if (!startPt || !endPt) continue
    const x1 = Math.max(plotLeft, xScale(new Date(startPt.bucketMs)) - slotWidth / 2)
    const x2 = Math.min(plotRight, xScale(new Date(endPt.bucketMs)) + slotWidth / 2)
    if (x2 > x1) {
      heatRects.push({
        key: `heat-${band.startIdx}-${band.endIdx}-${band.heatLevel}`,
        x: x1,
        width: x2 - x1,
        heatLevel: band.heatLevel,
        band,
      })
    }
  }

  // >2σ surge diamond markers (in rolling & perMinute modes)
  const spikeNodes: RiskExposureD3SpikeNode[] = []
  if (mode !== "cumulative") {
    for (let i = 0; i < points.length; i += 1) {
      const pt = points[i]!
      if (!pt.isSpike) continue
      const coord = pointCoords[i]
      if (!coord) continue
      spikeNodes.push({
        index: i,
        bucketMs: pt.bucketMs,
        cx: coord.cx,
        cy: coord.primaryCy,
        zScore: pt.zScore,
        label: pt.label,
      })
    }
  }

  // Mode-aware horizontal reference lines
  const referenceLines: RiskExposureD3ReferenceLine[] = []
  if (mode === "cumulative") {
    if (warnRef > 0) {
      referenceLines.push({
        id: "warning",
        y: yScale(warnRef),
        value: warnRef,
        label: `Warn ${formatRiskCompactUsd(warnRef)}`,
        tone: "warn",
      })
    }
    if (limitRef > 0) {
      referenceLines.push({
        id: "breach",
        y: yScale(limitRef),
        value: limitRef,
        label: `${options.isBreached ? "Breach Limit" : "60m Limit"} ${formatRiskCompactUsd(limitRef)}`,
        tone: options.isBreached ? "breach" : "warn",
      })
    }
  } else if (mode === "rolling" && series.meanRollingRiskUsd > 0) {
    referenceLines.push({
      id: "mean",
      y: yScale(series.meanRollingRiskUsd),
      value: series.meanRollingRiskUsd,
      label: `60m Avg ${formatRiskCompactUsd(series.meanRollingRiskUsd)}`,
      tone: "neutral",
    })
  } else if (mode === "perMinute") {
    if (series.meanMinuteRiskUsd > 0) {
      referenceLines.push({
        id: "mean",
        y: yScale(series.meanMinuteRiskUsd),
        value: series.meanMinuteRiskUsd,
        label: `Mean ${formatRiskCompactUsd(series.meanMinuteRiskUsd)}`,
        tone: "neutral",
      })
    }
    if (sigmaRef > 0) {
      referenceLines.push({
        id: "twoSigma",
        y: yScale(sigmaRef),
        value: sigmaRef,
        label: `+2σ ${formatRiskCompactUsd(sigmaRef)}`,
        tone: "surge",
      })
    }
  }

  const breachZoneHeight =
    mode === "cumulative" && limitRef > 0 ? Math.max(0, yScale(limitRef) - plotTop) : 0

  const lastCoord = pointCoords[pointCoords.length - 1] ?? null
  const latestNode = lastCoord
    ? {
        cx: lastCoord.cx,
        cy: lastCoord.primaryCy,
        secondaryCy: lastCoord.secondaryCy,
      }
    : null

  return {
    dims,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    primaryPath,
    primaryAreaPath,
    secondaryPath,
    xTicks,
    yTicks,
    yDomainMax,
    heatRects,
    spikeNodes,
    referenceLines,
    breachZoneHeight,
    latestNode,
    pointCoords,
    xAtMs: (ms: number) => xScale(new Date(ms)),
    msAtX: (x: number) => xScale.invert(x).getTime(),
  }
}

/** Uses D3's center bisector to snap an SVG x-coordinate to the nearest 1-minute exposure bucket. */
export function findNearestExposureBucketIndex(
  points: readonly RiskExposurePoint[],
  targetMs: number,
): number | null {
  if (points.length === 0) return null
  const idx = bucketMsBisector(points, targetMs)
  return Math.max(0, Math.min(points.length - 1, idx))
}

function formatSyncTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return "Waiting for sync"
  const d = new Date(epochMs)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

export function RiskExposureD3Chart({
  wagers,
  hasWagerSnapshot,
  snapshotStatus,
  wagersLastUpdatedAt = null,
  wsSyncTick = 0,
  wsLastSyncAt = null,
  streamingConnected = false,
  onRefreshWagers,
  exposureLimitUsd,
  warningLimitUsd,
  thresholdStatus = "idle",
  onOpenThresholdModal,
}: RiskExposureD3ChartProps): React.ReactElement {
  const [mode, setMode] = useState<RiskExposureD3Mode>("rolling")
  const [showOverlay, setShowOverlay] = useState<boolean>(true)
  const [showHeatMap, setShowHeatMap] = useState<boolean>(true)
  const [liveClockMs, setLiveClockMs] = useState<number>(() => Date.now())
  const [chartWidth, setChartWidth] = useState<number>(DEFAULT_WIDTH)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null)

  const viewportRef = useRef<HTMLDivElement | null>(null)
  const gradientId = useId().replace(/:/g, "")

  // Responsive container measurement so SVG strokes and typography remain crisp at 1:1 scale
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const updateWidth = () => {
      const next = Math.round(el.getBoundingClientRect().width)
      if (next >= 280) {
        setChartWidth((prev) => (Math.abs(prev - next) >= 4 ? next : prev))
      }
    }
    updateWidth()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => updateWidth())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Advance the rolling 60-minute clock in real time
  useEffect(() => {
    const id = setInterval(() => {
      setLiveClockMs(Date.now())
    }, 15_000)
    return () => clearInterval(id)
  }, [])

  const syncAnchorMs = useMemo(() => {
    const latestFeed = Math.max(wsLastSyncAt ?? 0, wagersLastUpdatedAt ?? 0)
    return Math.max(latestFeed, liveClockMs)
  }, [wsSyncTick, wsLastSyncAt, wagersLastUpdatedAt, liveClockMs])

  const series = useMemo(
    () =>
      buildRolling60MinRiskSeries(wagers, {
        anchorMs: syncAnchorMs,
        windowMinutes: 60,
        rollingPulseMinutes: RISK_ROLLING_PULSE_MINUTES,
      }),
    [wagers, syncAnchorMs],
  )

  const isBreached = thresholdStatus === "breach"
  const isWarn = thresholdStatus === "warn"

  const layout = useMemo(
    () =>
      computeRiskExposureD3Layout({
        series,
        mode,
        width: chartWidth,
        height: DEFAULT_HEIGHT,
        showOverlay,
        exposureLimitUsd,
        warningLimitUsd,
        isBreached,
      }),
    [series, mode, chartWidth, showOverlay, exposureLimitUsd, warningLimitUsd, isBreached],
  )

  const primaryLabel =
    mode === "rolling"
      ? `${RISK_ROLLING_PULSE_MINUTES}m Rolling Exposure`
      : mode === "perMinute"
        ? "1m Risk Flow"
        : "60m Cumulative Risk"

  const secondaryLabel = mode === "cumulative" ? "60m Payout Liability" : "Critical / Steam Risk"
  const hasData = hasWagerSnapshot && series.includedTickets > 0
  const syncStatusLabel = streamingConnected ? "Live stream" : "Snapshot polling"
  const lastSyncLabel = formatSyncTime(
    streamingConnected ? (wsLastSyncAt ?? wagersLastUpdatedAt) : wagersLastUpdatedAt,
  )

  const activeIndex = hoveredIndex ?? pinnedIndex
  const activePoint = activeIndex !== null ? (series.points[activeIndex] ?? null) : null
  const activeCoord = activeIndex !== null ? (layout.pointCoords[activeIndex] ?? null) : null

  const resolvePointerBucketIndex = useCallback(
    (clientX: number, svgEl: SVGSVGElement): number | null => {
      const rect = svgEl.getBoundingClientRect()
      if (rect.width <= 0) return null
      const svgX = ((clientX - rect.left) / rect.width) * layout.dims.width
      const clampedX = Math.max(layout.plotLeft, Math.min(layout.plotRight, svgX))
      const targetMs = layout.msAtX(clampedX)
      return findNearestExposureBucketIndex(series.points, targetMs)
    },
    [layout, series.points],
  )

  const handleSvgPointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      const idx = resolvePointerBucketIndex(event.clientX, event.currentTarget)
      setHoveredIndex(idx)
    },
    [resolvePointerBucketIndex],
  )

  const handleSvgClick = useCallback(
    (event: React.MouseEvent<SVGSVGElement>) => {
      const idx = resolvePointerBucketIndex(event.clientX, event.currentTarget)
      if (idx === null) return
      setPinnedIndex((prev) => (prev === idx ? null : idx))
    },
    [resolvePointerBucketIndex],
  )

  const handleSvgKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGSVGElement>) => {
      const count = series.points.length
      if (count === 0) return
      const current = pinnedIndex ?? hoveredIndex ?? count - 1
      if (event.key === "ArrowLeft") {
        event.preventDefault()
        setPinnedIndex(Math.max(0, current - 1))
      } else if (event.key === "ArrowRight") {
        event.preventDefault()
        setPinnedIndex(Math.min(count - 1, current + 1))
      } else if (event.key === "Home") {
        event.preventDefault()
        setPinnedIndex(0)
      } else if (event.key === "End") {
        event.preventDefault()
        setPinnedIndex(count - 1)
      } else if (event.key === "Escape") {
        event.preventDefault()
        setPinnedIndex(null)
        setHoveredIndex(null)
      }
    },
    [series.points.length, pinnedIndex, hoveredIndex],
  )

  // Place tooltip on left half when inspecting the right half of the chart so it never clips
  const tooltipSideClass =
    activeCoord && activeCoord.cx > layout.plotLeft + layout.plotWidth * 0.56
      ? "sd-risk-d3-tooltip--left"
      : "sd-risk-d3-tooltip--right"

  const sectionToneClass = isBreached
    ? "sd-risk-d3-card--breach"
    : isWarn
      ? "sd-risk-d3-card--warn"
      : ""

  return (
    <section
      aria-label="Real-Time Wager Exposure — Last 60 Minutes (D3 Line Chart)"
      className={`sd-risk-d3-card ${sectionToneClass}`.trim()}
      data-risk-exposure-d3-chart="true"
      data-risk-exposure-mode={mode}
    >
      {/* Header Row: Title, Tabular Metadata & Interactive Controls */}
      <div className="sd-risk-d3-header">
        <div className="sd-risk-d3-title-block">
          <h3 className="sd-risk-d3-title">Real-Time Aggregate Risk Exposure (Last 60 Minutes)</h3>
          <div className="sd-risk-d3-meta">
            <span className="sd-risk-d3-meta-strong">
              {formatRiskCompactUsd(series.totalRiskUsd)} total risk
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {RISK_ROLLING_PULSE_MINUTES}m pulse:{" "}
              <strong className="sd-risk-d3-meta-accent">
                {formatRiskCompactUsd(series.currentRollingRiskUsd)}
              </strong>
              {series.rollingDeltaPct !== null
                ? ` (${series.rollingDeltaPct >= 0 ? "+" : ""}${series.rollingDeltaPct.toFixed(1)}% vs 60m avg)`
                : ""}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Peak 1m: {formatRiskCompactUsd(series.peakMinuteRiskUsd)}
              {series.peakMinuteLabel ? ` (${series.peakMinuteLabel})` : ""}
            </span>
            <span aria-hidden="true">·</span>
            <span className={series.totalCriticalRiskUsd > 0 ? "sd-risk-d3-meta-crit" : undefined}>
              Critical/Steam: {formatRiskCompactUsd(series.totalCriticalRiskUsd)} (
              {series.criticalSharePct.toFixed(1)}%)
            </span>
            {series.twoSigmaThresholdUsd > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span className={series.spikeCount > 0 ? "sd-risk-d3-meta-surge" : undefined}>
                  {series.spikeCount > 0
                    ? `◆ ${series.spikeCount} surge${series.spikeCount === 1 ? "" : "s"} > 2σ (${formatRiskCompactUsd(series.twoSigmaThresholdUsd)}/m)`
                    : `2σ threshold: ${formatRiskCompactUsd(series.twoSigmaThresholdUsd)}/m`}
                </span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span
              className={streamingConnected ? "sd-risk-d3-meta-live" : "sd-risk-d3-meta-polling"}
            >
              {syncStatusLabel}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Updated {lastSyncLabel}
              {series.windowMode === "capture" ? " (capture window)" : ""}
            </span>
          </div>
        </div>

        {/* Interactive Controls */}
        <div className="sd-risk-d3-controls">
          <button
            type="button"
            onClick={() => setShowHeatMap((v) => !v)}
            aria-pressed={showHeatMap}
            className={`sd-risk-d3-toggle${showHeatMap ? " sd-risk-d3-toggle--heat-active" : ""}`}
          >
            {showHeatMap ? "Hide Heat Map" : "Show Heat Map"}
          </button>

          <button
            type="button"
            onClick={() => setShowOverlay((v) => !v)}
            aria-pressed={showOverlay}
            className={`sd-risk-d3-toggle${
              showOverlay
                ? mode === "cumulative"
                  ? " sd-risk-d3-toggle--liability-active"
                  : " sd-risk-d3-toggle--crit-active"
                : ""
            }`}
          >
            {showOverlay ? `Hide ${secondaryLabel}` : `Show ${secondaryLabel}`}
          </button>

          <div
            role="group"
            aria-label="Risk exposure time series mode"
            className="sd-risk-d3-segmented"
          >
            <button
              type="button"
              className={`sd-risk-d3-seg-btn${mode === "rolling" ? " sd-risk-d3-seg-btn--active" : ""}`}
              aria-pressed={mode === "rolling"}
              onClick={() => setMode("rolling")}
            >
              5m Rolling
            </button>
            <button
              type="button"
              className={`sd-risk-d3-seg-btn${mode === "perMinute" ? " sd-risk-d3-seg-btn--active" : ""}`}
              aria-pressed={mode === "perMinute"}
              onClick={() => setMode("perMinute")}
            >
              1m Flow
            </button>
            <button
              type="button"
              className={`sd-risk-d3-seg-btn${mode === "cumulative" ? " sd-risk-d3-seg-btn--active" : ""}`}
              aria-pressed={mode === "cumulative"}
              onClick={() => setMode("cumulative")}
            >
              60m Cumulative
            </button>
          </div>
        </div>
      </div>

      {/* Inline Unboxed Legend & Active Pin Status */}
      <div className="sd-risk-d3-legend">
        <span className="sd-risk-d3-legend-item">
          <span
            className="sd-risk-d3-swatch-line sd-risk-d3-swatch-line--primary"
            aria-hidden="true"
          />
          <span className="sd-risk-d3-legend-primary">{primaryLabel}</span>
        </span>
        {showOverlay ? (
          <span className="sd-risk-d3-legend-item">
            <span
              className={`sd-risk-d3-swatch-line ${
                mode === "cumulative"
                  ? "sd-risk-d3-swatch-line--liability"
                  : "sd-risk-d3-swatch-line--crit"
              }`}
              aria-hidden="true"
            />
            <span className="sd-risk-d3-legend-primary">{secondaryLabel}</span>
          </span>
        ) : null}
        {mode !== "cumulative" && series.twoSigmaThresholdUsd > 0 ? (
          <span className="sd-risk-d3-legend-item">
            <span className="sd-risk-d3-surge-glyph" aria-hidden="true">
              ◆
            </span>
            <span>&gt;2σ Risk Surge</span>
          </span>
        ) : null}
        {mode === "cumulative" && exposureLimitUsd && exposureLimitUsd > 0 ? (
          onOpenThresholdModal ? (
            <button
              type="button"
              onClick={onOpenThresholdModal}
              className={`sd-risk-d3-limit-btn${isBreached ? " sd-risk-d3-limit-btn--breach" : ""}`}
              title="Click to adjust 60-minute warning and breach limits"
            >
              <span
                className={`sd-risk-d3-swatch-dashed${isBreached ? " sd-risk-d3-swatch-dashed--breach" : ""}`}
                aria-hidden="true"
              />
              <span>60m Limit ({formatRiskCompactUsd(exposureLimitUsd)})</span>
            </button>
          ) : (
            <span className="sd-risk-d3-legend-item">
              <span
                className={`sd-risk-d3-swatch-dashed${isBreached ? " sd-risk-d3-swatch-dashed--breach" : ""}`}
                aria-hidden="true"
              />
              <span>60m Limit ({formatRiskCompactUsd(exposureLimitUsd)})</span>
            </span>
          )
        ) : null}
        {pinnedIndex !== null && series.points[pinnedIndex] ? (
          <button
            type="button"
            onClick={() => setPinnedIndex(null)}
            className="sd-risk-d3-unpin-btn"
            title="Clear pinned minute inspection"
          >
            Pinned {series.points[pinnedIndex]!.label} · Clear
          </button>
        ) : null}
        {showHeatMap ? (
          <span className="sd-risk-d3-heat-legend">
            <span>Activity Heat:</span>
            <span>Quiet</span>
            <span
              aria-label="Activity heat scale from light to concentrated"
              className="sd-risk-d3-heat-swatches"
            >
              {HEAT_LEGEND_ITEMS.map((item) => (
                <span
                  key={item.level}
                  title={item.label}
                  className={`sd-risk-d3-heat-swatch ${item.className}`}
                />
              ))}
            </span>
            <span className="sd-risk-d3-heat-text--4">Concentrated</span>
          </span>
        ) : null}
      </div>

      {/* D3 Chart Viewport or Empty State */}
      {hasData ? (
        <div ref={viewportRef} className="sd-risk-d3-viewport">
          <svg
            viewBox={`0 0 ${layout.dims.width} ${layout.dims.height}`}
            width={layout.dims.width}
            height={layout.dims.height}
            className="sd-risk-d3-svg"
            role="application"
            tabIndex={0}
            aria-label={`D3 real-time line chart of ${primaryLabel} across the last 60 minutes. Total risk ${formatRiskCompactUsd(series.totalRiskUsd)}, peak minute ${formatRiskCompactUsd(series.peakMinuteRiskUsd)}. Use Left and Right arrow keys to inspect individual minutes.`}
            onPointerMove={handleSvgPointerMove}
            onPointerLeave={() => setHoveredIndex(null)}
            onClick={handleSvgClick}
            onKeyDown={handleSvgKeyDown}
          >
            <defs>
              <linearGradient id={`sd-risk-d3-area-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="sd-risk-d3-area-stop-top" />
                <stop offset="100%" className="sd-risk-d3-area-stop-bottom" />
              </linearGradient>
              <clipPath id={`sd-risk-d3-clip-${gradientId}`}>
                <rect
                  x={layout.plotLeft}
                  y={layout.plotTop}
                  width={layout.plotWidth}
                  height={layout.plotHeight}
                />
              </clipPath>
            </defs>

            {/* Activity Concentration Heat Bands */}
            {showHeatMap ? (
              <g clipPath={`url(#sd-risk-d3-clip-${gradientId})`} pointerEvents="none">
                {layout.heatRects.map((rect) => (
                  <rect
                    key={rect.key}
                    x={rect.x}
                    y={layout.plotTop}
                    width={rect.width}
                    height={layout.plotHeight}
                    className={`sd-risk-d3-heat-band sd-risk-d3-heat-band--${rect.heatLevel}`}
                    data-risk-heat-band={rect.heatLevel}
                  />
                ))}
              </g>
            ) : null}

            {/* Subtle Breach Zone Shading Above 60m Cap in Cumulative Mode */}
            {layout.breachZoneHeight > 1 ? (
              <rect
                x={layout.plotLeft}
                y={layout.plotTop}
                width={layout.plotWidth}
                height={layout.breachZoneHeight}
                className="sd-risk-d3-breach-zone"
                pointerEvents="none"
              />
            ) : null}

            {/* Horizontal Y-Axis Gridlines & Labels */}
            {layout.yTicks.map((tick) => (
              <g key={`y-${tick.value}`}>
                <line
                  x1={layout.plotLeft}
                  x2={layout.plotRight}
                  y1={tick.pos}
                  y2={tick.pos}
                  className={tick.value === 0 ? "sd-risk-d3-axis-line" : "sd-risk-d3-grid-line"}
                />
                <text
                  x={layout.plotLeft - 8}
                  y={tick.pos + 3.5}
                  textAnchor="end"
                  className="sd-risk-d3-tick"
                >
                  {tick.label}
                </text>
              </g>
            ))}

            {/* X-Axis Time Ticks */}
            {layout.xTicks.map((tick, idx) => {
              const isFirst = idx === 0
              const isLast = idx === layout.xTicks.length - 1
              return (
                <g key={`x-${tick.value}`}>
                  <line
                    x1={tick.pos}
                    x2={tick.pos}
                    y1={layout.plotBottom}
                    y2={layout.plotBottom + 4}
                    className="sd-risk-d3-axis-line"
                  />
                  <text
                    x={tick.pos}
                    y={layout.dims.height - 8}
                    textAnchor={isFirst ? "start" : isLast ? "end" : "middle"}
                    className="sd-risk-d3-tick"
                  >
                    {tick.label}
                  </text>
                </g>
              )
            })}

            {/* Threshold & Statistical Reference Lines */}
            {layout.referenceLines.map((refLine) => (
              <g
                key={refLine.id}
                className={`sd-risk-d3-ref sd-risk-d3-ref--${refLine.tone}`}
                data-risk-ref-line={refLine.id}
                pointerEvents="none"
              >
                <line
                  x1={layout.plotLeft}
                  x2={layout.plotRight}
                  y1={refLine.y}
                  y2={refLine.y}
                  className="sd-risk-d3-ref-line"
                />
                <text
                  x={layout.plotRight - 4}
                  y={Math.max(layout.plotTop + 10, refLine.y - 4)}
                  textAnchor="end"
                  className="sd-risk-d3-ref-label"
                >
                  {refLine.label}
                </text>
              </g>
            ))}

            {/* Primary Area Gradient Fill + Curves */}
            <g clipPath={`url(#sd-risk-d3-clip-${gradientId})`}>
              {layout.primaryAreaPath ? (
                <path
                  d={layout.primaryAreaPath}
                  fill={`url(#sd-risk-d3-area-${gradientId})`}
                  pointerEvents="none"
                />
              ) : null}

              {showOverlay && layout.secondaryPath ? (
                <path
                  d={layout.secondaryPath}
                  fill="none"
                  className={`sd-risk-d3-line-secondary ${
                    mode === "cumulative"
                      ? "sd-risk-d3-line-secondary--liability"
                      : "sd-risk-d3-line-secondary--crit"
                  }`}
                  data-risk-d3-secondary-path="true"
                  pointerEvents="none"
                />
              ) : null}

              {layout.primaryPath ? (
                <path
                  d={layout.primaryPath}
                  fill="none"
                  className="sd-risk-d3-line-primary"
                  data-risk-d3-primary-path="true"
                  pointerEvents="none"
                />
              ) : null}
            </g>

            {/* >2σ Risk Surge Diamond Markers */}
            {layout.spikeNodes.map((node) => {
              const r = 5
              const diamond = `${node.cx},${node.cy - r} ${node.cx + r},${node.cy} ${node.cx},${node.cy + r} ${node.cx - r},${node.cy}`
              return (
                <g
                  key={`spike-${node.bucketMs}`}
                  data-risk-spike-marker="true"
                  pointerEvents="none"
                >
                  <circle cx={node.cx} cy={node.cy} r={8.5} className="sd-risk-d3-spike-halo" />
                  <polygon points={diamond} className="sd-risk-d3-spike-diamond" />
                </g>
              )
            })}

            {/* Live Edge Terminal Beacon */}
            {layout.latestNode ? (
              <g pointerEvents="none" data-risk-live-edge="true">
                {streamingConnected ? (
                  <circle
                    cx={layout.latestNode.cx}
                    cy={layout.latestNode.cy}
                    r={6.5}
                    className="sd-risk-d3-live-ring"
                  />
                ) : null}
                <circle
                  cx={layout.latestNode.cx}
                  cy={layout.latestNode.cy}
                  r={3.5}
                  className="sd-risk-d3-live-dot"
                />
              </g>
            ) : null}

            {/* Interactive Bisector Crosshair & Active Point Nodes */}
            {activePoint && activeCoord ? (
              <g pointerEvents="none" data-risk-d3-crosshair="true">
                <line
                  x1={activeCoord.cx}
                  x2={activeCoord.cx}
                  y1={layout.plotTop}
                  y2={layout.plotBottom}
                  className="sd-risk-d3-crosshair"
                />
                {showOverlay ? (
                  <circle
                    cx={activeCoord.cx}
                    cy={activeCoord.secondaryCy}
                    r={3.5}
                    className={
                      mode === "cumulative"
                        ? "sd-risk-d3-active-dot--liability"
                        : "sd-risk-d3-active-dot--crit"
                    }
                  />
                ) : null}
                {activePoint.isSpike && mode !== "cumulative" ? (
                  <g>
                    <circle
                      cx={activeCoord.cx}
                      cy={activeCoord.primaryCy}
                      r={10.5}
                      className="sd-risk-d3-spike-halo"
                    />
                    <polygon
                      points={`${activeCoord.cx},${activeCoord.primaryCy - 6} ${activeCoord.cx + 6},${activeCoord.primaryCy} ${activeCoord.cx},${activeCoord.primaryCy + 6} ${activeCoord.cx - 6},${activeCoord.primaryCy}`}
                      className="sd-risk-d3-spike-diamond"
                    />
                  </g>
                ) : (
                  <circle
                    cx={activeCoord.cx}
                    cy={activeCoord.primaryCy}
                    r={4.5}
                    className="sd-risk-d3-active-dot"
                  />
                )}
              </g>
            ) : null}
          </svg>

          {/* Anchored Floating HUD Tooltip for Hovered / Pinned Minute */}
          {activePoint ? (
            <div
              className={`sd-risk-d3-tooltip ${tooltipSideClass}${
                activePoint.isSpike ? " sd-risk-d3-tooltip--spike" : ""
              }`}
              role="status"
              aria-live="polite"
              data-risk-d3-tooltip="true"
            >
              <div className="sd-risk-d3-tooltip-head">
                <span className="sd-risk-d3-tooltip-clock">
                  {activePoint.label}
                  {pinnedIndex === activeIndex ? " · Pinned" : ""}
                </span>
                <span className="sd-risk-d3-tooltip-rel">{activePoint.relativeLabel}</span>
              </div>

              {activePoint.isSpike ? (
                <div className="sd-risk-d3-tooltip-surge">
                  <span>◆ &gt;2σ Risk Surge</span>
                  <span>+{activePoint.zScore.toFixed(2)}σ</span>
                </div>
              ) : null}

              <div className="sd-risk-d3-tooltip-row">
                <span>{RISK_ROLLING_PULSE_MINUTES}m Rolling Risk</span>
                <span className={mode === "rolling" ? "sd-risk-d3-val-accent" : undefined}>
                  ${activePoint.rollingRiskUsd.toLocaleString()}
                </span>
              </div>

              <div className="sd-risk-d3-tooltip-row">
                <span>1m Risk Flow</span>
                <span
                  className={
                    activePoint.isSpike
                      ? "sd-risk-d3-val-surge"
                      : mode === "perMinute"
                        ? "sd-risk-d3-val-accent"
                        : undefined
                  }
                >
                  +${activePoint.minuteRiskUsd.toLocaleString()}
                </span>
              </div>

              <div className="sd-risk-d3-tooltip-row">
                <span>60m Cumulative Risk</span>
                <span
                  className={
                    exposureLimitUsd && activePoint.cumulativeRiskUsd > exposureLimitUsd
                      ? "sd-risk-d3-val-breach"
                      : mode === "cumulative"
                        ? "sd-risk-d3-val-accent"
                        : undefined
                  }
                >
                  ${activePoint.cumulativeRiskUsd.toLocaleString()}
                  {exposureLimitUsd && exposureLimitUsd > 0
                    ? ` (${Math.round((activePoint.cumulativeRiskUsd / exposureLimitUsd) * 100)}%)`
                    : ""}
                </span>
              </div>

              <div className="sd-risk-d3-tooltip-row">
                <span>
                  {mode === "cumulative" ? "60m Liability (To Win)" : "Critical / Steam Risk"}
                </span>
                <span
                  className={
                    mode === "cumulative" ? "sd-risk-d3-val-liability" : "sd-risk-d3-val-crit"
                  }
                >
                  $
                  {(mode === "cumulative"
                    ? activePoint.cumulativeLiabilityUsd
                    : mode === "rolling"
                      ? activePoint.rollingCriticalRiskUsd
                      : activePoint.minuteCriticalRiskUsd
                  ).toLocaleString()}
                </span>
              </div>

              <div className="sd-risk-d3-tooltip-row">
                <span>Tickets</span>
                <span>
                  {activePoint.ticketCount} ({activePoint.criticalTicketCount} crit ·{" "}
                  {activePoint.cumulativeTickets} cum)
                </span>
              </div>

              <div className="sd-risk-d3-tooltip-row">
                <span>Activity Heat</span>
                <span className={HEAT_TEXT_CLASS[activePoint.heatLevel]}>
                  {activePoint.heatLabel} ({Math.round(activePoint.activityIntensity * 100)}%)
                </span>
              </div>

              {series.twoSigmaThresholdUsd > 0 ? (
                <div className="sd-risk-d3-tooltip-foot">
                  <span>60m Mean / +2σ</span>
                  <span>
                    {formatRiskCompactUsd(series.meanMinuteRiskUsd)} /{" "}
                    {formatRiskCompactUsd(series.twoSigmaThresholdUsd)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="sd-risk-d3-empty">
          <span>
            {hasWagerSnapshot
              ? "No non-sentinel wagers with timestamps in the active 60-minute window yet. Aggregate risk fluctuations plot automatically as the feed updates."
              : `Awaiting live wager snapshot (${snapshotStatus}). Real-time risk fluctuations will appear once feed data arrives.`}
          </span>
          {onRefreshWagers ? (
            <button type="button" onClick={onRefreshWagers} className="sd-risk-d3-refresh-btn">
              Refresh Feed
            </button>
          ) : null}
        </div>
      )}
    </section>
  )
}
