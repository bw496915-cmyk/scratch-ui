import type React from "react"
import { useMemo, useState } from "react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import {
  buildRolling60MinHandleSeries,
  formatHandleCompactUsd,
  type HandleVolumePoint,
} from "../handle_volume_series.ts"
import type { LiveWager } from "../types.ts"

export interface LiveWagersHandleChartProps {
  /** Full live wager capture from the feed. */
  readonly wagers: readonly LiveWager[]
  /** Currently filtered wager slice (for optional scoped view). */
  readonly filteredWagers?: readonly LiveWager[] | undefined
  /** Whether filters are actively narrowing the table slice. */
  readonly isFiltered?: boolean | undefined
  /** Epoch ms of the last successful wager payload fetch. */
  readonly wagersLastUpdatedAt?: number | null | undefined
  /** Monotonic WebSocket tick counter synchronizing chart refresh cadence to the WS feed. */
  readonly wsSyncTick?: number | undefined
  /** Epoch ms of the latest WebSocket sync frame. */
  readonly wsLastSyncAt?: number | null | undefined
  /** True when the live WebSocket stream is connected. */
  readonly streamingConnected?: boolean | undefined
  /** Manual refresh fallback handler for empty states. */
  readonly onRefreshWagers?: (() => void) | undefined
}

type ChartSeriesMode = "cumulative" | "perMinute"
type ChartScopeMode = "all" | "filtered"

interface HandleTooltipProps {
  readonly active?: boolean
  readonly payload?: ReadonlyArray<{
    readonly payload: HandleVolumePoint
  }>
  readonly mode: ChartSeriesMode
  readonly meanMinuteHandleUsd: number
  readonly twoSigmaThresholdUsd: number
}

function HandleVolumeTooltip({
  active,
  payload,
  mode,
  meanMinuteHandleUsd,
  twoSigmaThresholdUsd,
}: HandleTooltipProps): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null
  const pt = payload[0]?.payload
  if (!pt) return null

  return (
    <div
      style={{
        backgroundColor: "#0b1120",
        border: pt.isAnomaly ? "1px solid #f97316" : "1px solid #334155",
        borderRadius: "6px",
        padding: "10px 12px",
        fontSize: "12px",
        color: "#f1f5f9",
        boxShadow: "0 8px 24px rgba(2, 6, 23, 0.72)",
        fontVariantNumeric: "tabular-nums",
        minWidth: "204px",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: "12px",
          marginBottom: "6px",
          paddingBottom: "5px",
          borderBottom: "1px solid rgba(51, 65, 85, 0.65)",
        }}
      >
        <span style={{ fontWeight: 600, color: "#e2e8f0" }}>{pt.label}</span>
        <span style={{ fontSize: "11px", color: "#94a3b8" }}>{pt.relativeLabel}</span>
      </div>
      {pt.isAnomaly ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            marginBottom: "6px",
            paddingBottom: "5px",
            borderBottom: "1px solid rgba(249, 115, 22, 0.25)",
            color: "#fb923c",
            fontSize: "11px",
            fontWeight: 600,
          }}
        >
          <span>◆ &gt;2σ Volume Spike</span>
          <span
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}
          >
            +{pt.zScore.toFixed(2)}σ
          </span>
        </div>
      ) : null}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "16px",
          marginBottom: "3px",
        }}
      >
        <span style={{ color: "#94a3b8" }}>60m Aggregate</span>
        <span
          style={{
            fontWeight: mode === "cumulative" ? 700 : 500,
            color: mode === "cumulative" ? "#38bdf8" : "#e2e8f0",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          ${pt.cumulativeHandleUsd.toLocaleString()}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "16px",
          marginBottom: "3px",
        }}
      >
        <span style={{ color: "#94a3b8" }}>1m Handle</span>
        <span
          style={{
            fontWeight: mode === "perMinute" || pt.isAnomaly ? 700 : 500,
            color: pt.isAnomaly ? "#fb923c" : mode === "perMinute" ? "#38bdf8" : "#cbd5e1",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          +${pt.minuteHandleUsd.toLocaleString()}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "16px",
          marginBottom: "3px",
        }}
      >
        <span style={{ color: "#94a3b8" }}>Tickets</span>
        <span
          style={{
            color: "#cbd5e1",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          {pt.ticketCount} ({pt.cumulativeTickets} cum)
        </span>
      </div>
      {twoSigmaThresholdUsd > 0 ? (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: "16px",
            marginTop: "5px",
            paddingTop: "5px",
            borderTop: "1px solid rgba(51, 65, 85, 0.55)",
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          <span>60m Mean / +2σ</span>
          <span
            style={{
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              color: "#cbd5e1",
            }}
          >
            {formatHandleCompactUsd(meanMinuteHandleUsd)} /{" "}
            {formatHandleCompactUsd(twoSigmaThresholdUsd)}
          </span>
        </div>
      ) : null}
    </div>
  )
}

interface CustomDotProps {
  readonly cx?: number
  readonly cy?: number
  readonly index?: number
  readonly payload?: HandleVolumePoint
}

function renderAnomalyDiamondMarker(props: CustomDotProps): React.ReactElement {
  const { cx, cy, index, payload } = props
  if (
    !payload?.isAnomaly ||
    typeof cx !== "number" ||
    typeof cy !== "number" ||
    Number.isNaN(cx) ||
    Number.isNaN(cy)
  ) {
    return <g key={`normal-${index ?? 0}`} />
  }

  const r = 5.5
  const diamondPoints = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`

  return (
    <g
      key={`anomaly-${payload.bucketMs}-${index ?? 0}`}
      data-anomaly-marker="true"
      aria-label={`Volume spike at ${payload.label}: +${payload.zScore.toFixed(2)} sigma`}
    >
      <circle
        cx={cx}
        cy={cy}
        r={9}
        fill="rgba(249, 115, 22, 0.22)"
        stroke="rgba(249, 115, 22, 0.72)"
        strokeWidth={1.25}
      />
      <polygon points={diamondPoints} fill="#f97316" stroke="#0f172a" strokeWidth={1.5} />
    </g>
  )
}

function renderActiveVolumeDot(props: CustomDotProps): React.ReactElement {
  const { cx, cy, index, payload } = props
  if (typeof cx !== "number" || typeof cy !== "number" || Number.isNaN(cx) || Number.isNaN(cy)) {
    return <g key={`active-empty-${index ?? 0}`} />
  }

  if (payload?.isAnomaly) {
    const r = 6.5
    const diamondPoints = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`
    return (
      <g key={`active-anomaly-${index ?? 0}`}>
        <circle
          cx={cx}
          cy={cy}
          r={11}
          fill="rgba(249, 115, 22, 0.28)"
          stroke="#fb923c"
          strokeWidth={1.5}
        />
        <polygon points={diamondPoints} fill="#fb923c" stroke="#f8fafc" strokeWidth={1.5} />
      </g>
    )
  }

  return (
    <circle
      key={`active-normal-${index ?? 0}`}
      cx={cx}
      cy={cy}
      r={4}
      fill="#38bdf8"
      stroke="#0f172a"
      strokeWidth={2}
    />
  )
}

function formatSyncTime(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return "Waiting for sync"
  const d = new Date(epochMs)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`
}

export function LiveWagersHandleChart({
  wagers,
  filteredWagers,
  isFiltered = false,
  wagersLastUpdatedAt = null,
  wsSyncTick = 0,
  wsLastSyncAt = null,
  streamingConnected = false,
  onRefreshWagers,
}: LiveWagersHandleChartProps): React.ReactElement {
  const [seriesMode, setSeriesMode] = useState<ChartSeriesMode>("cumulative")
  const [scopeMode, setScopeMode] = useState<ChartScopeMode>("all")

  const effectiveScope: ChartScopeMode = isFiltered && filteredWagers ? scopeMode : "all"
  const targetWagers = effectiveScope === "filtered" && filteredWagers ? filteredWagers : wagers

  // Synchronize rolling 60-minute anchor strictly to WebSocket sync ticks / feed updates
  const syncAnchorMs = useMemo(() => {
    const latestSync = Math.max(wsLastSyncAt ?? 0, wagersLastUpdatedAt ?? 0)
    return latestSync > 0 ? latestSync : Date.now()
  }, [wsSyncTick, wsLastSyncAt, wagersLastUpdatedAt])

  const series = useMemo(
    () =>
      buildRolling60MinHandleSeries(targetWagers, {
        anchorMs: syncAnchorMs,
        windowMinutes: 60,
      }),
    [targetWagers, syncAnchorMs],
  )

  const dataKey = seriesMode === "cumulative" ? "cumulativeHandleUsd" : "minuteHandleUsd"

  const avgMinuteHandle =
    series.points.length > 0 ? Math.round(series.totalHandleUsd / series.points.length) : 0

  const hasData = series.includedTickets > 0
  const syncStatusLabel = streamingConnected ? "WebSocket synchronized" : "Polling fallback"
  const lastSyncLabel = formatSyncTime(
    streamingConnected ? (wsLastSyncAt ?? wagersLastUpdatedAt) : wagersLastUpdatedAt,
  )

  const segmentedBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "5px 10px",
    fontSize: "12px",
    fontWeight: active ? 600 : 500,
    borderRadius: "5px",
    border: "none",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
    backgroundColor: active ? "#1e293b" : "transparent",
    color: active ? "#f8fafc" : "#94a3b8",
    transition: "background-color 150ms ease, color 150ms ease",
  })

  return (
    <section
      aria-label="Aggregate Handle Volume — Last 60 Minutes"
      style={{
        backgroundColor: "#0f172a",
        border: "1px solid #1e293b",
        borderRadius: "10px",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* Header row: title + unboxed tabular metadata + segmented view controls */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <h3
            style={{
              margin: 0,
              fontSize: "15px",
              fontWeight: 600,
              color: "#f8fafc",
              letterSpacing: "-0.01em",
            }}
          >
            Aggregate Handle Volume (Last 60 Minutes)
          </h3>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
              fontSize: "12px",
              color: "#94a3b8",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span style={{ color: "#e2e8f0", fontWeight: 600 }}>
              {formatHandleCompactUsd(series.totalHandleUsd)} handle
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {series.includedTickets} ticket
              {series.includedTickets === 1 ? "" : "s"}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Peak 1m: {formatHandleCompactUsd(series.peakMinuteHandleUsd)}
              {series.peakMinuteLabel ? ` (${series.peakMinuteLabel})` : ""}
            </span>
            {series.twoSigmaThresholdUsd > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span
                  style={{
                    color: series.anomalyCount > 0 ? "#fb923c" : "#94a3b8",
                    fontWeight: series.anomalyCount > 0 ? 600 : 400,
                  }}
                >
                  {series.anomalyCount > 0
                    ? `◆ ${series.anomalyCount} spike${series.anomalyCount === 1 ? "" : "s"} > 2σ (${formatHandleCompactUsd(series.twoSigmaThresholdUsd)}/m)`
                    : `2σ threshold: ${formatHandleCompactUsd(series.twoSigmaThresholdUsd)}/m`}
                </span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span style={{ color: streamingConnected ? "#4ade80" : "#fbbf24" }}>
              {syncStatusLabel}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Updated {lastSyncLabel}
              {series.windowMode === "capture" ? " (capture window)" : ""}
            </span>
          </div>
        </div>

        {/* Interactive controls: Cumulative vs Per-Minute + optional Filtered scope */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {isFiltered && filteredWagers ? (
            <div
              role="group"
              aria-label="Chart wager scope"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                padding: "3px",
                borderRadius: "7px",
                backgroundColor: "#0b1120",
                border: "1px solid #1e293b",
              }}
            >
              <button
                type="button"
                style={segmentedBtnStyle(effectiveScope === "all")}
                onClick={() => setScopeMode("all")}
              >
                All Feed
              </button>
              <button
                type="button"
                style={segmentedBtnStyle(effectiveScope === "filtered")}
                onClick={() => setScopeMode("filtered")}
              >
                Filtered Slice
              </button>
            </div>
          ) : null}

          <div
            role="group"
            aria-label="Handle aggregation mode"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
              padding: "3px",
              borderRadius: "7px",
              backgroundColor: "#0b1120",
              border: "1px solid #1e293b",
            }}
          >
            <button
              type="button"
              style={segmentedBtnStyle(seriesMode === "cumulative")}
              onClick={() => setSeriesMode("cumulative")}
            >
              Cumulative
            </button>
            <button
              type="button"
              style={segmentedBtnStyle(seriesMode === "perMinute")}
              onClick={() => setSeriesMode("perMinute")}
            >
              Per-Minute
            </button>
          </div>
        </div>
      </div>

      {/* Chart viewport or empty state */}
      {hasData ? (
        <div
          style={{
            width: "100%",
            height: "220px",
            minWidth: 0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={series.points as HandleVolumePoint[]}
              margin={{ top: 8, right: 16, left: 4, bottom: 4 }}
            >
              <CartesianGrid
                stroke="rgba(148, 163, 184, 0.12)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="label"
                interval={9}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={{ stroke: "#1e293b" }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(val: number) => formatHandleCompactUsd(val)}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={62}
              />
              <Tooltip
                content={
                  <HandleVolumeTooltip
                    mode={seriesMode}
                    meanMinuteHandleUsd={series.meanMinuteHandleUsd}
                    twoSigmaThresholdUsd={series.twoSigmaThresholdUsd}
                  />
                }
                cursor={{
                  stroke: "rgba(56, 189, 248, 0.45)",
                  strokeWidth: 1,
                }}
              />
              {seriesMode === "perMinute" && avgMinuteHandle > 0 ? (
                <ReferenceLine
                  y={avgMinuteHandle}
                  stroke="rgba(148, 163, 184, 0.4)"
                  strokeDasharray="4 4"
                />
              ) : null}
              {seriesMode === "perMinute" &&
              series.stdDevMinuteHandleUsd > 0 &&
              series.twoSigmaThresholdUsd > 0 ? (
                <ReferenceLine
                  y={series.twoSigmaThresholdUsd}
                  stroke="rgba(249, 115, 22, 0.65)"
                  strokeDasharray="4 3"
                  label={{
                    value: `+2σ (${formatHandleCompactUsd(series.twoSigmaThresholdUsd)})`,
                    position: "insideTopRight",
                    fill: "#fb923c",
                    fontSize: 10,
                  }}
                />
              ) : null}
              <Line
                type="monotone"
                dataKey={dataKey}
                name={seriesMode === "cumulative" ? "60m Aggregate Handle" : "1m Handle Volume"}
                stroke="#38bdf8"
                strokeWidth={2}
                dot={renderAnomalyDiamondMarker}
                activeDot={renderActiveVolumeDot}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          style={{
            height: "160px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            borderRadius: "8px",
            backgroundColor: "rgba(11, 17, 32, 0.65)",
            border: "1px dashed rgba(148, 163, 184, 0.2)",
            color: "#94a3b8",
            fontSize: "13px",
            textAlign: "center",
            padding: "16px",
          }}
        >
          <span>
            No non-sentinel wagers with timestamps in the active 60-minute window yet. Volume plots
            automatically as the WebSocket feed updates.
          </span>
          {onRefreshWagers ? (
            <button
              type="button"
              onClick={onRefreshWagers}
              style={{
                padding: "6px 14px",
                borderRadius: "6px",
                border: "1px solid #334155",
                backgroundColor: "#1e293b",
                color: "#f1f5f9",
                fontSize: "12px",
                fontWeight: 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Refresh Feed
            </button>
          ) : null}
        </div>
      )}
    </section>
  )
}
