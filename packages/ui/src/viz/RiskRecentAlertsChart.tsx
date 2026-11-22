import type React from "react"
import { useMemo, useState } from "react"
import { curveMonotoneX, line, scaleBand, scaleLinear, stack } from "d3"
import { Minus, TrendingDown, TrendingUp } from "lucide-react"
import { formatRiskCompactUsd } from "../risk_exposure_series.ts"
import type {
  AlertFrequencyBucket,
  AlertFrequencySeries,
  AlertFrequencyTrend,
  RecentRiskAlertStatusFilter,
} from "../risk_recent_alerts.ts"

export interface RiskRecentAlertsChartProps {
  readonly series: AlertFrequencySeries
  readonly statusFilter?: RecentRiskAlertStatusFilter | undefined
  readonly selectedBucketIndex: number | null
  readonly onSelectBucket: (bucketIndex: number | null) => void
  readonly onChangeStatusFilter?: ((next: RecentRiskAlertStatusFilter) => void) | undefined
  readonly onOpenThresholdModal?: (() => void) | undefined
}

const CHART_WIDTH = 324
const CHART_HEIGHT = 116
const PAD_LEFT = 24
const PAD_RIGHT = 8
const PAD_TOP = 20
const PAD_BOTTOM = 20

const TREND_META: Record<
  AlertFrequencyTrend,
  { readonly label: string; readonly className: string }
> = {
  escalating: { label: "Escalating", className: "sd-alerts-d3-trend--escalating" },
  easing: { label: "Easing", className: "sd-alerts-d3-trend--easing" },
  steady: { label: "Steady", className: "sd-alerts-d3-trend--steady" },
  quiet: { label: "Quiet", className: "sd-alerts-d3-trend--quiet" },
}

function TrendIcon({ trend }: { readonly trend: AlertFrequencyTrend }): React.ReactElement {
  if (trend === "escalating") return <TrendingUp size={11} aria-hidden="true" />
  if (trend === "easing") return <TrendingDown size={11} aria-hidden="true" />
  return <Minus size={11} aria-hidden="true" />
}

/**
 * D3 stacked bar & severity-momentum visualization inside the 'Recent Alerts'
 * sidebar showing 60-minute breach/warning frequency across 12 five-minute bins,
 * overlaid with a vertical USD threshold limit marker showing where rolling
 * exposure crossed (or approaches) the configured limit.
 */
export function RiskRecentAlertsChart({
  series,
  statusFilter = "ALL",
  selectedBucketIndex,
  onSelectBucket,
  onChangeStatusFilter,
  onOpenThresholdModal,
}: RiskRecentAlertsChartProps): React.ReactElement {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [hoveredThreshold, setHoveredThreshold] = useState<boolean>(false)

  const layout = useMemo(() => {
    const plotWidth = CHART_WIDTH - PAD_LEFT - PAD_RIGHT
    const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM
    const indices = series.buckets.map((b) => b.index)

    const xScale = scaleBand<number>()
      .domain(indices)
      .range([PAD_LEFT, PAD_LEFT + plotWidth])
      .paddingInner(0.24)
      .paddingOuter(0.08)

    const yMax = Math.max(2, series.maxBucketTotal)
    const yScale = scaleLinear()
      .domain([0, yMax])
      .range([PAD_TOP + plotHeight, PAD_TOP])
      .nice()
    const niceMax = yScale.domain()[1] ?? yMax
    const yTicks = niceMax <= 2 ? [0, 1, 2] : [0, Math.round(niceMax / 2), niceMax]

    // D3 stack layout: Warnings form the base, Breaches stack on top
    const stackGen = stack<AlertFrequencyBucket, "warnCount" | "breachCount">().keys([
      "warnCount",
      "breachCount",
    ])
    const layers = stackGen(series.buckets)

    // D3 monotone severity-momentum overlay normalized to the same plot height
    const sevMax = Math.max(2, series.maxSeverityScore)
    const sevScale = scaleLinear()
      .domain([0, sevMax])
      .range([PAD_TOP + plotHeight, PAD_TOP + 2])

    const bandwidth = xScale.bandwidth()
    const step = xScale.step()
    const trendLinePath =
      series.maxSeverityScore > 0
        ? line<AlertFrequencyBucket>()
            .x((d) => (xScale(d.index) ?? PAD_LEFT) + bandwidth / 2)
            .y((d) => sevScale(d.severityScore))
            .curve(curveMonotoneX)(series.buckets)
        : null

    // D3 continuous X position for the vertical USD threshold limit marker
    const thresholdTimeScale = scaleLinear()
      .domain([0, 1])
      .range([PAD_LEFT + 2, PAD_LEFT + plotWidth - 1])
      .clamp(true)

    const marker = series.thresholdMarker
    let thresholdX = thresholdTimeScale(marker.normalizedX)
    if (marker.status === "crossed" && marker.crossedBucketIndex !== null) {
      const bucketLeft = xScale(marker.crossedBucketIndex)
      if (bucketLeft !== undefined) {
        const slotLeft = bucketLeft - (step - bandwidth) / 2
        thresholdX = Math.max(
          PAD_LEFT + 2,
          Math.min(PAD_LEFT + plotWidth - 2, slotLeft + marker.crossedBucketFraction * step),
        )
      }
    }

    // Smart horizontal label alignment so the threshold callout never clips
    let thresholdLabelAnchor: "start" | "middle" | "end" = "middle"
    let thresholdLabelX = thresholdX
    if (thresholdX < PAD_LEFT + 82) {
      thresholdLabelAnchor = "start"
      thresholdLabelX = Math.max(PAD_LEFT, thresholdX - 4)
    } else if (thresholdX > CHART_WIDTH - PAD_RIGHT - 82) {
      thresholdLabelAnchor = "end"
      thresholdLabelX = Math.min(CHART_WIDTH - PAD_RIGHT, thresholdX + 4)
    }

    return {
      plotWidth,
      plotHeight,
      baselineY: PAD_TOP + plotHeight,
      xScale,
      yScale,
      yTicks,
      bandwidth,
      warnLayer: layers[0] ?? [],
      breachLayer: layers[1] ?? [],
      trendLinePath,
      thresholdX,
      thresholdLabelAnchor,
      thresholdLabelX,
    }
  }, [series])

  const marker = series.thresholdMarker
  const compactLimit = formatRiskCompactUsd(marker.breachLimitUsd)
  const inspectedIdx = hoveredThreshold ? null : (hoveredIdx ?? selectedBucketIndex)
  const inspectedBucket = inspectedIdx !== null ? (series.buckets[inspectedIdx] ?? null) : null
  const trendMeta = TREND_META[series.trend]

  const xLabelIndices = [0, 4, 8, Math.max(0, series.buckets.length - 1)]

  const thresholdMarkerTopLabel =
    marker.status === "crossed" && marker.crossedClockLabel
      ? `${compactLimit} limit · ${marker.crossedClockLabel}`
      : `${compactLimit} limit · ${Math.round(marker.utilizationPct)}%`

  const thresholdAriaLabel =
    marker.status === "crossed" && marker.crossedClockLabel
      ? `USD threshold limit ${compactLimit} crossed at ${marker.crossedClockLabel}. ${marker.postThresholdAlertCount} alert${marker.postThresholdAlertCount === 1 ? "" : "s"} recorded after crossing. Click to adjust threshold limits.`
      : `USD threshold limit ${compactLimit} (${Math.round(marker.utilizationPct)}% utilized across last 60 minutes). Click to adjust threshold limits.`

  return (
    <div
      className="sd-alerts-d3-wrap"
      data-recent-alerts-d3-chart="true"
      data-recent-alerts-trend={series.trend}
      data-threshold-marker-status={marker.status}
    >
      {/* Compact Readout Bar (threshold marker details, hovered/selected bucket, or 60m summary) */}
      <div className="sd-alerts-d3-head">
        {hoveredThreshold ? (
          <div className="sd-alerts-d3-readout">
            <span
              className={`sd-alerts-d3-readout-threshold sd-alerts-d3-readout-threshold--${marker.status}`}
            >
              {compactLimit} limit
            </span>
            <span aria-hidden="true">·</span>
            {marker.status === "crossed" ? (
              <span>
                Crossed {marker.crossedClockLabel} ({marker.postThresholdBreachCount}B /{" "}
                {Math.max(0, marker.postThresholdAlertCount - marker.postThresholdBreachCount)}W
                after)
              </span>
            ) : (
              <span>
                {formatRiskCompactUsd(marker.totalWindowRiskUsd)} / {compactLimit} (
                {Math.round(marker.utilizationPct)}%)
              </span>
            )}
          </div>
        ) : inspectedBucket ? (
          <div className="sd-alerts-d3-readout">
            <span className="sd-alerts-d3-readout-range">{inspectedBucket.rangeLabel}</span>
            <span aria-hidden="true">·</span>
            <span
              className={
                inspectedBucket.breachCount > 0 ? "sd-recent-alerts-count--breach" : undefined
              }
            >
              {inspectedBucket.breachCount}B
            </span>
            <span aria-hidden="true">/</span>
            <span
              className={inspectedBucket.warnCount > 0 ? "sd-recent-alerts-count--warn" : undefined}
            >
              {inspectedBucket.warnCount}W
            </span>
            {inspectedBucket.totalRiskUsd > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatRiskCompactUsd(inspectedBucket.totalRiskUsd)}</span>
              </>
            ) : null}
          </div>
        ) : (
          <div className="sd-alerts-d3-readout">
            <span className="sd-alerts-d3-caption">
              {statusFilter === "BREACH"
                ? "5m Breaches"
                : statusFilter === "WARN"
                  ? "5m Warnings"
                  : "5m Frequency"}
            </span>
            {series.peakBucketLabel ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Peak {series.peakBucketLabel.slice(0, 5)} ({series.peakBucketTotal})
                </span>
              </>
            ) : (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {statusFilter === "BREACH"
                    ? "0 breaches"
                    : statusFilter === "WARN"
                      ? "0 warnings"
                      : "0 events"}
                </span>
              </>
            )}
          </div>
        )}

        <div className="sd-alerts-d3-head-right">
          {selectedBucketIndex !== null ? (
            <button
              type="button"
              onClick={() => onSelectBucket(null)}
              className="sd-alerts-d3-clear-btn"
              title="Show alerts across all 60 minutes"
            >
              Clear slice
            </button>
          ) : (
            <span className={`sd-alerts-d3-trend ${trendMeta.className}`}>
              <TrendIcon trend={series.trend} />
              <span>{trendMeta.label}</span>
            </span>
          )}
        </div>
      </div>

      {/* Responsive D3 SVG Chart */}
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="sd-alerts-d3-svg"
        role="img"
        aria-label={`D3 stacked bar chart of 60-minute risk breaches and threshold warnings across ${series.buckets.length} five-minute intervals, with a vertical marker for the ${compactLimit} USD threshold limit. Pattern: ${trendMeta.label}.`}
        onMouseLeave={() => {
          setHoveredIdx(null)
          setHoveredThreshold(false)
        }}
      >
        {/* Subtle Post-Threshold Breach Zone Shading when 60m limit was crossed */}
        {marker.status === "crossed" && CHART_WIDTH - PAD_RIGHT - layout.thresholdX > 1 ? (
          <rect
            x={layout.thresholdX}
            y={PAD_TOP}
            width={Math.max(0, CHART_WIDTH - PAD_RIGHT - layout.thresholdX)}
            height={layout.plotHeight}
            className="sd-alerts-d3-threshold-zone"
            data-threshold-breach-zone="true"
            pointerEvents="none"
          />
        ) : null}

        {/* Horizontal Gridlines & Integer Y Ticks */}
        {layout.yTicks.map((tick) => {
          const y = layout.yScale(tick)
          return (
            <g key={`y-${tick}`}>
              <line
                x1={PAD_LEFT}
                x2={CHART_WIDTH - PAD_RIGHT}
                y1={y}
                y2={y}
                className={tick === 0 ? "sd-alerts-d3-axis-base" : "sd-alerts-d3-grid"}
              />
              <text x={PAD_LEFT - 5} y={y + 3} textAnchor="end" className="sd-alerts-d3-tick">
                {tick}
              </text>
            </g>
          )
        })}

        {/* Interactive Column Hit Targets & Burst Highlights */}
        {series.buckets.map((bucket) => {
          const x = layout.xScale(bucket.index) ?? PAD_LEFT
          const isSelected = selectedBucketIndex === bucket.index
          const isHovered = !hoveredThreshold && hoveredIdx === bucket.index
          return (
            <g key={`col-${bucket.index}`}>
              {isSelected || isHovered || bucket.isBurst ? (
                <rect
                  x={x - 2}
                  y={PAD_TOP}
                  width={layout.bandwidth + 4}
                  height={layout.plotHeight}
                  rx={3}
                  className={
                    isSelected
                      ? "sd-alerts-d3-col-selected"
                      : isHovered
                        ? "sd-alerts-d3-col-hover"
                        : "sd-alerts-d3-col-burst"
                  }
                />
              ) : null}
            </g>
          )
        })}

        {/* D3 Stacked Bars — Warnings (bottom layer) */}
        {layout.warnLayer.map((seg, i) => {
          const bucket = seg.data
          const y0 = layout.yScale(seg[0])
          const y1 = layout.yScale(seg[1])
          const h = Math.max(0, y0 - y1)
          if (h <= 0.25) return null
          const x = layout.xScale(bucket.index) ?? PAD_LEFT
          const dimmed = selectedBucketIndex !== null && selectedBucketIndex !== bucket.index
          return (
            <rect
              key={`warn-${i}`}
              x={x}
              y={y1}
              width={layout.bandwidth}
              height={h}
              rx={bucket.breachCount > 0 ? 0 : 2}
              className="sd-alerts-d3-bar-warn"
              opacity={dimmed ? 0.32 : 0.92}
            />
          )
        })}

        {/* D3 Stacked Bars — Breaches (top layer) */}
        {layout.breachLayer.map((seg, i) => {
          const bucket = seg.data
          const y0 = layout.yScale(seg[0])
          const y1 = layout.yScale(seg[1])
          const h = Math.max(0, y0 - y1)
          if (h <= 0.25) return null
          const x = layout.xScale(bucket.index) ?? PAD_LEFT
          const dimmed = selectedBucketIndex !== null && selectedBucketIndex !== bucket.index
          return (
            <rect
              key={`breach-${i}`}
              x={x}
              y={y1}
              width={layout.bandwidth}
              height={h}
              rx={2}
              className="sd-alerts-d3-bar-breach"
              opacity={dimmed ? 0.35 : 0.96}
            />
          )
        })}

        {/* D3 Monotone Severity-Intensity Momentum Line */}
        {layout.trendLinePath ? (
          <path
            d={layout.trendLinePath}
            fill="none"
            className="sd-alerts-d3-momentum-line"
            pointerEvents="none"
          />
        ) : null}

        {/* Clickable / Keyboard-Focusable Bar Overlays for Pattern Inspection */}
        {series.buckets.map((bucket) => {
          const x = layout.xScale(bucket.index) ?? PAD_LEFT
          const isSelected = selectedBucketIndex === bucket.index
          return (
            <rect
              key={`hit-${bucket.index}`}
              x={x - 2}
              y={PAD_TOP}
              width={layout.bandwidth + 4}
              height={layout.plotHeight}
              fill="transparent"
              className="sd-alerts-d3-hit"
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`${bucket.rangeLabel}: ${bucket.breachCount} breach${bucket.breachCount === 1 ? "" : "es"}, ${bucket.warnCount} warning${bucket.warnCount === 1 ? "" : "s"}. Click to filter alerts.`}
              onMouseEnter={() => {
                setHoveredThreshold(false)
                setHoveredIdx(bucket.index)
              }}
              onFocus={() => {
                setHoveredThreshold(false)
                setHoveredIdx(bucket.index)
              }}
              onBlur={() => setHoveredIdx(null)}
              onClick={() => onSelectBucket(isSelected ? null : bucket.index)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault()
                  onSelectBucket(isSelected ? null : bucket.index)
                }
              }}
            />
          )
        })}

        {/* Vertical USD Threshold Limit Marker */}
        <g
          className={`sd-alerts-d3-threshold sd-alerts-d3-threshold--${marker.status}`}
          data-threshold-marker="true"
          data-threshold-limit-usd={marker.breachLimitUsd}
        >
          <line
            x1={layout.thresholdX}
            x2={layout.thresholdX}
            y1={PAD_TOP - 2}
            y2={layout.baselineY}
            className="sd-alerts-d3-threshold-line"
            data-threshold-marker-line="true"
          />
          <polygon
            points={`${layout.thresholdX - 3.5},${PAD_TOP - 5} ${layout.thresholdX + 3.5},${PAD_TOP - 5} ${layout.thresholdX},${PAD_TOP}`}
            className="sd-alerts-d3-threshold-caret"
          />
          <text
            x={layout.thresholdLabelX}
            y={10}
            textAnchor={layout.thresholdLabelAnchor}
            className="sd-alerts-d3-threshold-label"
          >
            {thresholdMarkerTopLabel}
          </text>
          {/* Interactive Hover / Click Target for the Vertical Limit Marker */}
          <rect
            x={Math.max(PAD_LEFT, layout.thresholdX - 6)}
            y={0}
            width={12}
            height={layout.baselineY}
            fill="transparent"
            className="sd-alerts-d3-threshold-hit"
            role={onOpenThresholdModal ? "button" : "img"}
            tabIndex={0}
            aria-label={thresholdAriaLabel}
            onMouseEnter={() => {
              setHoveredIdx(null)
              setHoveredThreshold(true)
            }}
            onMouseLeave={() => setHoveredThreshold(false)}
            onFocus={() => {
              setHoveredIdx(null)
              setHoveredThreshold(true)
            }}
            onBlur={() => setHoveredThreshold(false)}
            onClick={() => onOpenThresholdModal?.()}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && onOpenThresholdModal) {
                e.preventDefault()
                onOpenThresholdModal()
              }
            }}
          />
        </g>

        {/* X-Axis Time Labels */}
        {xLabelIndices.map((idx) => {
          const bucket = series.buckets[idx]
          if (!bucket) return null
          const x = (layout.xScale(bucket.index) ?? PAD_LEFT) + layout.bandwidth / 2
          const anchor = idx === 0 ? "start" : idx === series.buckets.length - 1 ? "end" : "middle"
          return (
            <text
              key={`x-${idx}`}
              x={
                idx === 0
                  ? PAD_LEFT
                  : idx === series.buckets.length - 1
                    ? CHART_WIDTH - PAD_RIGHT
                    : x
              }
              y={CHART_HEIGHT - 5}
              textAnchor={anchor}
              className="sd-alerts-d3-tick"
            >
              {idx === series.buckets.length - 1 ? "Now" : bucket.startLabel}
            </text>
          )
        })}
      </svg>

      {/* Compact Legend Row */}
      <div className="sd-alerts-d3-legend">
        {onChangeStatusFilter ? (
          <>
            <button
              type="button"
              onClick={() => onChangeStatusFilter(statusFilter === "WARN" ? "ALL" : "WARN")}
              className={`sd-alerts-d3-legend-toggle${
                statusFilter === "WARN"
                  ? " sd-alerts-d3-legend-toggle--active"
                  : statusFilter === "BREACH"
                    ? " sd-alerts-d3-legend-toggle--dimmed"
                    : ""
              }`}
              aria-pressed={statusFilter === "WARN"}
              title={statusFilter === "WARN" ? "Show all severities" : "Isolate Warning events"}
            >
              <span className="sd-alerts-d3-swatch sd-alerts-d3-swatch--warn" aria-hidden="true" />
              <span>Warning</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeStatusFilter(statusFilter === "BREACH" ? "ALL" : "BREACH")}
              className={`sd-alerts-d3-legend-toggle${
                statusFilter === "BREACH"
                  ? " sd-alerts-d3-legend-toggle--active"
                  : statusFilter === "WARN"
                    ? " sd-alerts-d3-legend-toggle--dimmed"
                    : ""
              }`}
              aria-pressed={statusFilter === "BREACH"}
              title={statusFilter === "BREACH" ? "Show all severities" : "Isolate Breach events"}
            >
              <span
                className="sd-alerts-d3-swatch sd-alerts-d3-swatch--breach"
                aria-hidden="true"
              />
              <span>Breach</span>
            </button>
          </>
        ) : (
          <>
            <span className="sd-alerts-d3-legend-item">
              <span className="sd-alerts-d3-swatch sd-alerts-d3-swatch--warn" aria-hidden="true" />
              <span>Warning</span>
            </span>
            <span className="sd-alerts-d3-legend-item">
              <span
                className="sd-alerts-d3-swatch sd-alerts-d3-swatch--breach"
                aria-hidden="true"
              />
              <span>Breach</span>
            </span>
          </>
        )}
        <span className="sd-alerts-d3-legend-item">
          <span className="sd-alerts-d3-swatch-line" aria-hidden="true" />
          <span>Severity</span>
        </span>
        {onOpenThresholdModal ? (
          <button
            type="button"
            onClick={onOpenThresholdModal}
            className={`sd-alerts-d3-legend-limit-btn sd-alerts-d3-legend-limit-btn--${marker.status}`}
            title={`Current 60m USD threshold limit: ${compactLimit}. Click to edit limits.`}
          >
            <span
              className={`sd-alerts-d3-swatch-vbar sd-alerts-d3-swatch-vbar--${marker.status}`}
              aria-hidden="true"
            />
            <span>Limit {compactLimit}</span>
          </button>
        ) : (
          <span className="sd-alerts-d3-legend-item">
            <span
              className={`sd-alerts-d3-swatch-vbar sd-alerts-d3-swatch-vbar--${marker.status}`}
              aria-hidden="true"
            />
            <span>Limit {compactLimit}</span>
          </span>
        )}
      </div>
    </div>
  )
}
