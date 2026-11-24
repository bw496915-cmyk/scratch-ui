/**
 * Recharts 24-hour stacked/grouped bar chart visualizing System Logs severity distribution
 * (`CRITICAL`, `HIGH`, `WATCH`, `NORMAL`) across hourly buckets, synchronized with the client-side
 * bitwise search/filter store.
 *
 * @file Packages/ui/src/panels/SystemLogSeverityBarChart.tsx
 */

import type React from "react"
import { memo, useMemo, useState, useSyncExternalStore } from "react"
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  type DotItemDotProps,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import {
  type BitwiseLogFilterStore,
  type BitwiseLogIndex,
  LOG_SEVERITY_MASK_ALL,
} from "../system_log_bitwise_filter.ts"
import {
  buildUnifiedLog24HourSeveritySeries,
  buildWebLog24HourSeveritySeries,
  LOG_SEVERITY_LEVELS,
  type SystemLogSeverityBucket,
  type SystemLogSeverityLevel,
  type WebLogSeveritySourceEntry,
} from "../system_log_severity_series.ts"
import { selectBitwiseFilteredRows, type UnifiedSystemLogRow } from "../system_logs_json_export.ts"
import { SkeletonBlock } from "./PanelSkeleton.tsx"

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

export const LOG_SEVERITY_SERIES_META: Readonly<
  Record<
    SystemLogSeverityLevel,
    {
      readonly label: string
      readonly color: string
      readonly textColor: string
      readonly border: string
      readonly activeBg: string
    }
  >
> = {
  CRITICAL: {
    label: "CRITICAL",
    color: "#ef4444",
    textColor: "#fca5a5",
    border: "rgba(239, 68, 68, 0.55)",
    activeBg: "rgba(239, 68, 68, 0.16)",
  },
  HIGH: {
    label: "HIGH",
    color: "#f59e0b",
    textColor: "#fcd34d",
    border: "rgba(245, 158, 11, 0.55)",
    activeBg: "rgba(245, 158, 11, 0.16)",
  },
  WATCH: {
    label: "WATCH",
    color: "#38bdf8",
    textColor: "#7dd3fc",
    border: "rgba(56, 189, 248, 0.55)",
    activeBg: "rgba(56, 189, 248, 0.16)",
  },
  NORMAL: {
    label: "NORMAL",
    color: "#22c55e",
    textColor: "#86efac",
    border: "rgba(34, 197, 94, 0.55)",
    activeBg: "rgba(34, 197, 94, 0.16)",
  },
}

type BarLayoutMode = "stacked" | "grouped"
type ChartScopeMode = "all" | "filtered"

export interface SystemLogSeverityBarChartProps {
  readonly mode: "weblogs" | "unified"
  readonly weblogEntries?: readonly WebLogSeveritySourceEntry[] | undefined
  readonly unifiedLogs?: readonly UnifiedSystemLogRow[] | undefined
  readonly weblogBitwiseIndex?: BitwiseLogIndex | undefined
  readonly unifiedBitwiseIndex?: BitwiseLogIndex | undefined
  readonly bitwiseStore?: BitwiseLogFilterStore | undefined
  readonly loading?: boolean | undefined
  readonly anchorMs?: number | undefined
  readonly onRefreshWeblogs?: (() => void) | undefined
  readonly onSwitchToUnified?: (() => void) | undefined
}

interface SeverityTooltipProps {
  readonly active?: boolean
  readonly payload?: ReadonlyArray<{
    readonly payload: SystemLogSeverityBucket
  }>
}

function SystemLogSeverityTooltip({
  active,
  payload,
}: SeverityTooltipProps): React.ReactElement | null {
  const bucket = active ? payload?.[0]?.payload : undefined
  if (!bucket) {
    return null
  }

  return (
    <div
      style={{
        backgroundColor: "#0b1120",
        border: "1px solid #334155",
        borderRadius: "6px",
        padding: "10px 12px",
        fontSize: "12px",
        color: "#f1f5f9",
        boxShadow: "0 8px 24px rgba(2, 6, 23, 0.72)",
        fontVariantNumeric: "tabular-nums",
        minWidth: "210px",
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
        <span style={{ fontWeight: 600, color: "#e2e8f0" }}>{bucket.dateTimeLabel}</span>
        <span style={{ fontSize: "11px", color: "#94a3b8", fontFamily: MONO_FONT }}>
          {bucket.rangeLabel} ({bucket.relativeLabel})
        </span>
      </div>

      {LOG_SEVERITY_LEVELS.map((sev) => {
        const meta = LOG_SEVERITY_SERIES_META[sev]
        const count = bucket[sev]
        const pct = bucket.total > 0 ? Math.round((count / bucket.total) * 100) : 0
        return (
          <div
            key={sev}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "16px",
              marginBottom: "3px",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                color: count > 0 ? meta.textColor : "#64748b",
                fontWeight: count > 0 ? 600 : 400,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "2px",
                  backgroundColor: meta.color,
                  display: "inline-block",
                }}
              />
              {meta.label}
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontWeight: count > 0 ? 700 : 400,
                color: count > 0 ? "#f8fafc" : "#64748b",
              }}
            >
              {count}
              {bucket.total > 0 ? ` (${pct}%)` : ""}
            </span>
          </div>
        )
      })}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "16px",
          marginTop: "6px",
          paddingTop: "5px",
          borderTop: "1px solid rgba(51, 65, 85, 0.55)",
          fontSize: "11px",
          color: "#cbd5e1",
          fontWeight: 600,
        }}
      >
        <span>
          Total Volume
          {bucket.isSpike ? (
            <span style={{ color: "#fca5a5", marginLeft: "6px", fontWeight: 700 }}>· Spike</span>
          ) : null}
        </span>
        <span style={{ fontFamily: MONO_FONT }}>{bucket.total}</span>
      </div>
    </div>
  )
}

function renderVolumeSpikeDot(dotProps: DotItemDotProps): React.ReactNode {
  const { cx, cy, payload, index } = dotProps
  const bucket = payload as SystemLogSeverityBucket | undefined
  if (!bucket?.isSpike || typeof cx !== "number" || typeof cy !== "number") {
    return null
  }
  return (
    <circle
      key={`volume-spike-dot-${index}`}
      cx={cx}
      cy={cy}
      r={3.5}
      fill="#f8fafc"
      stroke="#f59e0b"
      strokeWidth={1.75}
    />
  )
}

const FALLBACK_FILTER_SNAPSHOT = {
  rawQuery: "",
  toggledMask: LOG_SEVERITY_MASK_ALL,
  parsed: {
    rawQuery: "",
    baseMask: LOG_SEVERITY_MASK_ALL,
    includeMask: LOG_SEVERITY_MASK_ALL,
    excludeMask: 0,
    effectiveMask: LOG_SEVERITY_MASK_ALL,
    textTerms: [],
    excludeTextTerms: [],
    hasExplicitBitFilter: false,
  },
} as const

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const GET_FALLBACK_FILTER_SNAPSHOT = () => FALLBACK_FILTER_SNAPSHOT
const EMPTY_ACTION_BTN_STYLE: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: "6px",
  border: "1px solid #334155",
  backgroundColor: "#1e293b",
  color: "#f1f5f9",
  fontSize: "12px",
  fontWeight: 500,
  cursor: "pointer",
  whiteSpace: "nowrap",
}

export const SystemLogSeverityBarChart = memo(function SystemLogSeverityBarChart({
  mode,
  weblogEntries = [],
  unifiedLogs = [],
  weblogBitwiseIndex,
  unifiedBitwiseIndex,
  bitwiseStore,
  loading = false,
  anchorMs,
  onRefreshWeblogs,
  onSwitchToUnified,
}: SystemLogSeverityBarChartProps): React.ReactElement {
  const [layoutMode, setLayoutMode] = useState<BarLayoutMode>("stacked")
  const [scopeMode, setScopeMode] = useState<ChartScopeMode>("filtered")
  const [isolatedSeverity, setIsolatedSeverity] = useState<SystemLogSeverityLevel | null>(null)
  const [showVolumeTrendline, setShowVolumeTrendline] = useState<boolean>(true)

  const snap = useSyncExternalStore(
    bitwiseStore ? bitwiseStore.subscribeFilter : NOOP_SUBSCRIBE,
    bitwiseStore ? bitwiseStore.getSnapshot : GET_FALLBACK_FILTER_SNAPSHOT,
    bitwiseStore ? bitwiseStore.getSnapshot : GET_FALLBACK_FILTER_SNAPSHOT,
  )

  const isFiltered =
    snap.rawQuery.trim() !== "" || snap.parsed.effectiveMask !== LOG_SEVERITY_MASK_ALL
  const effectiveScope: ChartScopeMode = isFiltered ? scopeMode : "all"

  const series = useMemo(() => {
    const selectRows = <T,>(
      rows: readonly T[],
      index: BitwiseLogIndex | undefined,
    ): readonly T[] =>
      effectiveScope === "filtered" && index && index.length === rows.length
        ? selectBitwiseFilteredRows(rows, index, snap.parsed)
        : rows

    return mode === "weblogs"
      ? buildWebLog24HourSeveritySeries(selectRows(weblogEntries, weblogBitwiseIndex), { anchorMs })
      : buildUnifiedLog24HourSeveritySeries(selectRows(unifiedLogs, unifiedBitwiseIndex), {
          anchorMs,
        })
  }, [
    mode,
    effectiveScope,
    weblogEntries,
    unifiedLogs,
    weblogBitwiseIndex,
    unifiedBitwiseIndex,
    snap.parsed,
    anchorMs,
  ])

  const activeLevels: readonly SystemLogSeverityLevel[] = isolatedSeverity
    ? [isolatedSeverity]
    : LOG_SEVERITY_LEVELS

  const hasSourceEntries = mode === "weblogs" ? weblogEntries.length > 0 : unifiedLogs.length > 0
  const showLoadingSkeleton = mode === "weblogs" && loading && weblogEntries.length === 0
  const hasPlotData = series.includedLogs > 0

  const segmentedBtnStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 9px",
    fontSize: "11px",
    fontWeight: active ? 600 : 500,
    borderRadius: "5px",
    border: "none",
    cursor: "pointer",
    whiteSpace: "nowrap",
    flexShrink: 0,
    backgroundColor: active ? "#1e293b" : "transparent",
    color: active ? "#f8fafc" : "#94a3b8",
    transition: "background-color 140ms ease, color 140ms ease",
  })

  return (
    <section
      aria-label="24-Hour Log Severity Distribution"
      data-system-logs-severity-chart="true"
      style={{
        backgroundColor: "#0d1527",
        border: "1px solid #1e293b",
        borderRadius: "8px",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      {/* Header row: Title + tabular summary metadata + view mode toggles */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 }}>
          <h3
            style={{
              margin: 0,
              fontSize: "15px",
              fontWeight: 600,
              color: "#f8fafc",
              letterSpacing: "-0.01em",
            }}
          >
            Log Severity Distribution (Last 24 Hours)
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
            <span style={{ color: "#e2e8f0", fontWeight: 600, fontFamily: MONO_FONT }}>
              {series.totals.total} events (24h)
            </span>
            <span aria-hidden="true">·</span>
            <span>{mode === "weblogs" ? "Weblogs feed" : "Unified stream"}</span>
            <span aria-hidden="true">·</span>
            <span>
              {series.windowMode === "live" ? "Live 24h window" : "Latest 24h capture window"}
            </span>
            {series.peakHourLabel && series.peakHourCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span style={{ fontFamily: MONO_FONT }}>
                  Peak {series.peakHourLabel} ({series.peakHourCount})
                </span>
              </>
            ) : null}
            {series.includedLogs > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span style={{ fontFamily: MONO_FONT }}>Avg {series.meanHourlyVolume}/hr</span>
              </>
            ) : null}
            {series.spikeHourCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span style={{ fontFamily: MONO_FONT, color: "#fcd34d" }}>
                  {series.spikeHourCount} spike {series.spikeHourCount === 1 ? "hr" : "hrs"}
                </span>
              </>
            ) : null}
            {series.outsideWindowLogs > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{series.outsideWindowLogs} older (&gt;24h)</span>
              </>
            ) : null}
          </div>
        </div>

        {/* Interactive layout and filter-scope controls */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {isFiltered ? (
            <div
              role="group"
              aria-label="Severity chart log scope"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                padding: "3px",
                borderRadius: "7px",
                backgroundColor: "#070b14",
                border: "1px solid #1e293b",
              }}
            >
              <button
                type="button"
                aria-pressed={effectiveScope === "filtered"}
                style={segmentedBtnStyle(effectiveScope === "filtered")}
                onClick={() => setScopeMode("filtered")}
              >
                Filtered
              </button>
              <button
                type="button"
                aria-pressed={effectiveScope === "all"}
                style={segmentedBtnStyle(effectiveScope === "all")}
                onClick={() => setScopeMode("all")}
              >
                All Loaded
              </button>
            </div>
          ) : null}

          <div
            role="group"
            aria-label="Severity bar layout mode"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
              padding: "3px",
              borderRadius: "7px",
              backgroundColor: "#070b14",
              border: "1px solid #1e293b",
            }}
          >
            <button
              type="button"
              data-severity-chart-layout="stacked"
              aria-pressed={layoutMode === "stacked"}
              style={segmentedBtnStyle(layoutMode === "stacked")}
              onClick={() => setLayoutMode("stacked")}
            >
              Stacked
            </button>
            <button
              type="button"
              data-severity-chart-layout="grouped"
              aria-pressed={layoutMode === "grouped"}
              style={segmentedBtnStyle(layoutMode === "grouped")}
              onClick={() => setLayoutMode("grouped")}
            >
              Grouped
            </button>
          </div>
        </div>
      </div>

      {/* Interactive severity legend buttons (isolate/compare any of the 4 tiers) */}
      <div
        role="group"
        aria-label="Severity tiers in 24-hour chart"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
          fontSize: "11px",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {LOG_SEVERITY_LEVELS.map((sev) => {
          const meta = LOG_SEVERITY_SERIES_META[sev]
          const isActive = isolatedSeverity === null || isolatedSeverity === sev
          const isIsolated = isolatedSeverity === sev
          const count = series.totals[sev]
          return (
            <button
              key={sev}
              type="button"
              data-severity-series-toggle={sev}
              aria-pressed={isIsolated}
              title={
                isIsolated
                  ? `Show all severity tiers in chart`
                  : `Isolate ${meta.label} bars in 24h chart`
              }
              onClick={() => setIsolatedSeverity((curr) => (curr === sev ? null : sev))}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 9px",
                borderRadius: "5px",
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
                fontFamily: MONO_FONT,
                fontSize: "11px",
                fontWeight: 600,
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: isIsolated ? meta.border : "#1e293b",
                backgroundColor: isIsolated ? meta.activeBg : "#070b14",
                color: isActive ? meta.textColor : "#64748b",
                opacity: isActive ? 1 : 0.55,
                transition: "background-color 140ms ease, color 140ms ease, opacity 140ms ease",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "2px",
                  backgroundColor: meta.color,
                  display: "inline-block",
                }}
              />
              <span>{meta.label}</span>
              <span style={{ color: isActive ? "#e2e8f0" : "#64748b" }}>({count})</span>
            </button>
          )
        })}

        <button
          type="button"
          data-severity-trend-toggle="total-volume"
          aria-pressed={showVolumeTrendline}
          title={
            showVolumeTrendline
              ? "Hide total log volume trendline"
              : "Show total log volume trendline behind severity bars"
          }
          onClick={() => setShowVolumeTrendline((prev) => !prev)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "4px 9px",
            borderRadius: "5px",
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
            fontFamily: MONO_FONT,
            fontSize: "11px",
            fontWeight: 600,
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: showVolumeTrendline ? "rgba(203, 213, 225, 0.45)" : "#1e293b",
            backgroundColor: showVolumeTrendline ? "rgba(148, 163, 184, 0.14)" : "#070b14",
            color: showVolumeTrendline ? "#e2e8f0" : "#64748b",
            opacity: showVolumeTrendline ? 1 : 0.7,
            transition: "background-color 140ms ease, color 140ms ease, opacity 140ms ease",
          }}
        >
          <svg width="14" height="8" viewBox="0 0 14 8" aria-hidden="true">
            <path
              d="M1 6.5 L4.5 3.5 L8 5 L13 1.5"
              fill="none"
              stroke="#cbd5e1"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>Total Trendline</span>
        </button>

        {isolatedSeverity !== null ? (
          <button
            type="button"
            onClick={() => setIsolatedSeverity(null)}
            style={{
              padding: "4px 8px",
              borderRadius: "5px",
              fontSize: "11px",
              fontWeight: 600,
              backgroundColor: "transparent",
              color: "#94a3b8",
              border: "1px solid #334155",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Show All Severities
          </button>
        ) : null}
      </div>

      {/* Chart Viewport, Loading Skeleton, or Empty State */}
      {showLoadingSkeleton ? (
        <div
          data-severity-chart-loading="true"
          style={{
            height: "210px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            gap: "10px",
            padding: "16px",
            borderRadius: "8px",
            backgroundColor: "rgba(7, 11, 20, 0.65)",
            border: "1px solid #1e293b",
          }}
        >
          <SkeletonBlock width="42%" height={12} tone="subtle" />
          <SkeletonBlock width="100%" height={148} tone="accent" />
        </div>
      ) : hasPlotData ? (
        <div
          style={{
            width: "100%",
            height: "210px",
            minWidth: 0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <ResponsiveContainer
            width="100%"
            height="100%"
            initialDimension={{ width: 640, height: 210 }}
          >
            <ComposedChart
              data={series.buckets as SystemLogSeverityBucket[]}
              margin={{ top: 12, right: 12, left: 0, bottom: 4 }}
              barCategoryGap={layoutMode === "stacked" ? "26%" : "20%"}
            >
              <defs>
                <linearGradient id="systemLogVolumeFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.22} />
                  <stop offset="100%" stopColor="#94a3b8" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid
                stroke="rgba(148, 163, 184, 0.12)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="hourLabel"
                interval={2}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={{ stroke: "#1e293b" }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={40}
              />
              <Tooltip
                content={<SystemLogSeverityTooltip />}
                cursor={{ fill: "rgba(56, 189, 248, 0.08)" }}
              />
              {showVolumeTrendline && series.meanHourlyVolume > 0 ? (
                <ReferenceLine
                  y={series.meanHourlyVolume}
                  stroke="rgba(148, 163, 184, 0.32)"
                  strokeDasharray="4 4"
                  ifOverflow="extendDomain"
                />
              ) : null}
              {showVolumeTrendline ? (
                <Area
                  type="monotone"
                  dataKey="total"
                  name="Total Volume"
                  stroke="#cbd5e1"
                  strokeWidth={2}
                  fill="url(#systemLogVolumeFill)"
                  fillOpacity={1}
                  dot={renderVolumeSpikeDot}
                  activeDot={{ r: 4, fill: "#f8fafc", stroke: "#cbd5e1", strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ) : null}
              {activeLevels.map((sev, idx) => {
                const meta = LOG_SEVERITY_SERIES_META[sev]
                const isTopStacked = layoutMode === "stacked" && idx === activeLevels.length - 1
                const barRadius: [number, number, number, number] =
                  layoutMode === "grouped" || isTopStacked ? [3, 3, 0, 0] : [0, 0, 0, 0]
                return (
                  <Bar
                    key={sev}
                    dataKey={sev}
                    name={meta.label}
                    fill={meta.color}
                    stackId={layoutMode === "stacked" ? "severity" : undefined}
                    radius={barRadius}
                    maxBarSize={layoutMode === "stacked" ? 24 : 10}
                    isAnimationActive={false}
                  />
                )
              })}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          data-severity-chart-empty="true"
          style={{
            height: "180px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            borderRadius: "8px",
            backgroundColor: "rgba(7, 11, 20, 0.65)",
            border: "1px dashed rgba(148, 163, 184, 0.22)",
            color: "#94a3b8",
            fontSize: "13px",
            textAlign: "center",
            padding: "16px",
          }}
        >
          <span>
            {hasSourceEntries && isFiltered && bitwiseStore
              ? "No log entries in the 24-hour window match the active search or severity filter."
              : mode === "weblogs"
                ? "No timestamped weblog entries are loaded yet. Refresh or paste Fantasy402 access logs to plot the 24-hour severity distribution."
                : "No timestamped system log events recorded in the last 24 hours yet."}
          </span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
            {hasSourceEntries && isFiltered && bitwiseStore ? (
              <button
                type="button"
                onClick={() => bitwiseStore.reset()}
                style={EMPTY_ACTION_BTN_STYLE}
              >
                Clear Active Filter
              </button>
            ) : null}
            {mode === "weblogs" && onRefreshWeblogs ? (
              <button type="button" onClick={onRefreshWeblogs} style={EMPTY_ACTION_BTN_STYLE}>
                Refresh Weblogs
              </button>
            ) : null}
            {mode === "weblogs" &&
            !hasSourceEntries &&
            onSwitchToUnified &&
            unifiedLogs.length > 0 ? (
              <button
                type="button"
                onClick={onSwitchToUnified}
                style={{
                  ...EMPTY_ACTION_BTN_STYLE,
                  border: "1px solid rgba(56, 189, 248, 0.45)",
                  backgroundColor: "rgba(56, 189, 248, 0.14)",
                  color: "#7dd3fc",
                  fontWeight: 600,
                }}
              >
                View Unified Stream ({unifiedLogs.length})
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  )
})
