import type React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import {
  buildRolling60MinRiskSeries,
  formatRiskCompactUsd,
  RISK_ROLLING_PULSE_MINUTES,
  type RiskActivityHeatLevel,
  type RiskExposurePoint,
} from "../risk_exposure_series.ts"
import type { RiskThresholdStatus } from "../risk_threshold_alert.ts"
import type { LiveWager } from "../types.ts"

const HEAT_BAND_STYLES: Record<
  1 | 2 | 3 | 4,
  {
    readonly fill: string
    readonly fillOpacity: number
    readonly swatch: string
    readonly label: string
  }
> = {
  1: { fill: "#38bdf8", fillOpacity: 0.07, swatch: "rgba(56, 189, 248, 0.28)", label: "Light" },
  2: { fill: "#facc15", fillOpacity: 0.13, swatch: "rgba(250, 204, 21, 0.48)", label: "Moderate" },
  3: { fill: "#f97316", fillOpacity: 0.22, swatch: "rgba(249, 115, 22, 0.72)", label: "Elevated" },
  4: { fill: "#ef4444", fillOpacity: 0.3, swatch: "rgba(239, 68, 68, 0.9)", label: "Concentrated" },
}

const HEAT_TEXT_COLOR: Record<RiskActivityHeatLevel, string> = {
  0: "#94a3b8",
  1: "#7dd3fc",
  2: "#fde047",
  3: "#fb923c",
  4: "#f87171",
}

export interface RiskExposureChartProps {
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
}

type RiskChartMode = "rolling" | "perMinute" | "cumulative"

interface RiskTooltipProps {
  readonly active?: boolean
  readonly payload?: ReadonlyArray<{
    readonly payload: RiskExposurePoint
  }>
  readonly mode: RiskChartMode
  readonly meanMinuteRiskUsd: number
  readonly twoSigmaThresholdUsd: number
  readonly exposureLimitUsd?: number | undefined
}

function RiskExposureTooltip({
  active,
  payload,
  mode,
  meanMinuteRiskUsd,
  twoSigmaThresholdUsd,
  exposureLimitUsd,
}: RiskTooltipProps): React.ReactElement | null {
  if (!active || !payload || payload.length === 0) return null
  const pt = payload[0]?.payload
  if (!pt) return null

  return (
    <div
      style={{
        backgroundColor: "#0b1120",
        border: pt.isSpike ? "1px solid #f97316" : "1px solid #334155",
        borderRadius: "6px",
        padding: "10px 12px",
        fontSize: "12px",
        color: "#f1f5f9",
        boxShadow: "0 8px 24px rgba(2, 6, 23, 0.72)",
        fontVariantNumeric: "tabular-nums",
        minWidth: "224px",
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

      {pt.isSpike ? (
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
          <span>◆ &gt;2σ Risk Surge</span>
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
        <span style={{ color: "#94a3b8" }}>{RISK_ROLLING_PULSE_MINUTES}m Rolling Risk</span>
        <span
          style={{
            fontWeight: mode === "rolling" ? 700 : 500,
            color: mode === "rolling" ? "#38bdf8" : "#e2e8f0",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          ${pt.rollingRiskUsd.toLocaleString()}
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
        <span style={{ color: "#94a3b8" }}>1m Risk Flow</span>
        <span
          style={{
            fontWeight: mode === "perMinute" || pt.isSpike ? 700 : 500,
            color: pt.isSpike ? "#fb923c" : mode === "perMinute" ? "#38bdf8" : "#cbd5e1",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          +${pt.minuteRiskUsd.toLocaleString()}
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
        <span style={{ color: "#94a3b8" }}>60m Cumulative Risk</span>
        <span
          style={{
            fontWeight: mode === "cumulative" ? 700 : 500,
            color:
              exposureLimitUsd && pt.cumulativeRiskUsd > exposureLimitUsd
                ? "#f87171"
                : mode === "cumulative"
                  ? "#38bdf8"
                  : "#cbd5e1",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          ${pt.cumulativeRiskUsd.toLocaleString()}
          {exposureLimitUsd && exposureLimitUsd > 0
            ? ` (${Math.round((pt.cumulativeRiskUsd / exposureLimitUsd) * 100)}%)`
            : ""}
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
        <span style={{ color: "#94a3b8" }}>
          {mode === "cumulative" ? "60m Liability (To Win)" : "Critical / Steam Risk"}
        </span>
        <span
          style={{
            color: mode === "cumulative" ? "#f59e0b" : "#f87171",
            fontWeight: 600,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          $
          {(mode === "cumulative"
            ? pt.cumulativeLiabilityUsd
            : mode === "rolling"
              ? pt.rollingCriticalRiskUsd
              : pt.minuteCriticalRiskUsd
          ).toLocaleString()}
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
          {pt.ticketCount} ({pt.criticalTicketCount} crit · {pt.cumulativeTickets} cum)
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
        <span style={{ color: "#94a3b8" }}>Activity Heat</span>
        <span
          style={{
            color: HEAT_TEXT_COLOR[pt.heatLevel],
            fontWeight: pt.heatLevel >= 3 ? 700 : 600,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          }}
        >
          {pt.heatLabel} ({Math.round(pt.activityIntensity * 100)}%)
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
            {formatRiskCompactUsd(meanMinuteRiskUsd)} / {formatRiskCompactUsd(twoSigmaThresholdUsd)}
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
  readonly payload?: RiskExposurePoint
}

function renderSpikeDiamondMarker(props: CustomDotProps): React.ReactElement {
  const { cx, cy, index, payload } = props
  if (
    !payload?.isSpike ||
    typeof cx !== "number" ||
    typeof cy !== "number" ||
    Number.isNaN(cx) ||
    Number.isNaN(cy)
  ) {
    return <g key={`risk-normal-${index ?? 0}`} />
  }

  const r = 5.5
  const diamondPoints = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`

  return (
    <g
      key={`risk-spike-${payload.bucketMs}-${index ?? 0}`}
      data-risk-spike-marker="true"
      aria-label={`Risk surge at ${payload.label}: +${payload.zScore.toFixed(2)} sigma`}
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

function renderActiveRiskDot(props: CustomDotProps): React.ReactElement {
  const { cx, cy, index, payload } = props
  if (typeof cx !== "number" || typeof cy !== "number" || Number.isNaN(cx) || Number.isNaN(cy)) {
    return <g key={`risk-active-empty-${index ?? 0}`} />
  }

  if (payload?.isSpike) {
    const r = 6.5
    const diamondPoints = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`
    return (
      <g key={`risk-active-spike-${index ?? 0}`}>
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
      key={`risk-active-normal-${index ?? 0}`}
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

export function RiskExposureChart({
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
}: RiskExposureChartProps): React.ReactElement {
  const [mode, setMode] = useState<RiskChartMode>("rolling")
  const [showOverlay, setShowOverlay] = useState<boolean>(true)
  const [showHeatMap, setShowHeatMap] = useState<boolean>(true)
  const [liveClockMs, setLiveClockMs] = useState<number>(() => Date.now())

  // Keep the rolling 60-minute window ticking smoothly in real time
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

  const primaryKey: keyof RiskExposurePoint =
    mode === "rolling"
      ? "rollingRiskUsd"
      : mode === "perMinute"
        ? "minuteRiskUsd"
        : "cumulativeRiskUsd"

  const secondaryKey: keyof RiskExposurePoint =
    mode === "rolling"
      ? "rollingCriticalRiskUsd"
      : mode === "perMinute"
        ? "minuteCriticalRiskUsd"
        : "cumulativeLiabilityUsd"

  const primaryLabel =
    mode === "rolling"
      ? `${RISK_ROLLING_PULSE_MINUTES}m Rolling Exposure`
      : mode === "perMinute"
        ? "1m Risk Flow"
        : "60m Cumulative Risk"

  const secondaryLabel = mode === "cumulative" ? "60m Payout Liability" : "Critical / Steam Risk"

  const secondaryStroke = mode === "cumulative" ? "#f59e0b" : "#f87171"

  const hasData = hasWagerSnapshot && series.includedTickets > 0
  const syncStatusLabel = streamingConnected ? "Live stream" : "Snapshot polling"
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

  const isBreached = thresholdStatus === "breach"
  const isWarn = thresholdStatus === "warn"

  return (
    <section
      aria-label="Real-Time Risk Exposure — Last 60 Minutes"
      style={{
        backgroundColor: "#0d1527",
        border: isBreached
          ? "1px solid rgba(239, 68, 68, 0.55)"
          : isWarn
            ? "1px solid rgba(245, 158, 11, 0.42)"
            : "1px solid #1e293b",
        borderRadius: "8px",
        padding: "16px 20px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* Header row: title + clean tabular metadata + interactive view controls */}
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
            Real-Time Aggregate Risk Exposure (Last 60 Minutes)
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
              {formatRiskCompactUsd(series.totalRiskUsd)} total risk
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {RISK_ROLLING_PULSE_MINUTES}m pulse:{" "}
              <strong style={{ color: "#38bdf8", fontWeight: 600 }}>
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
            <span style={{ color: series.totalCriticalRiskUsd > 0 ? "#fca5a5" : "#94a3b8" }}>
              Critical/Steam: {formatRiskCompactUsd(series.totalCriticalRiskUsd)} (
              {series.criticalSharePct.toFixed(1)}%)
            </span>
            {series.maxMinuteTickets > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span
                  style={{
                    color: series.concentratedMinuteCount > 0 ? "#fb923c" : "#94a3b8",
                    fontWeight: series.concentratedMinuteCount > 0 ? 600 : 400,
                  }}
                >
                  {series.concentratedMinuteCount > 0
                    ? `${series.concentratedMinuteCount} concentrated min (peak ${series.maxMinuteTickets} tix${series.peakActivityLabel ? ` @ ${series.peakActivityLabel}` : ""})`
                    : `Peak activity: ${series.maxMinuteTickets} tix/m`}
                </span>
              </>
            ) : null}
            {series.twoSigmaThresholdUsd > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span
                  style={{
                    color: series.spikeCount > 0 ? "#fb923c" : "#94a3b8",
                    fontWeight: series.spikeCount > 0 ? 600 : 400,
                  }}
                >
                  {series.spikeCount > 0
                    ? `◆ ${series.spikeCount} surge${series.spikeCount === 1 ? "" : "s"} > 2σ (${formatRiskCompactUsd(series.twoSigmaThresholdUsd)}/m)`
                    : `2σ threshold: ${formatRiskCompactUsd(series.twoSigmaThresholdUsd)}/m`}
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

        {/* Interactive segmented controls */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <button
            type="button"
            onClick={() => setShowHeatMap((v) => !v)}
            aria-pressed={showHeatMap}
            style={{
              padding: "6px 10px",
              fontSize: "12px",
              fontWeight: 500,
              borderRadius: "6px",
              border: showHeatMap ? "1px solid rgba(249, 115, 22, 0.48)" : "1px solid #1e293b",
              backgroundColor: showHeatMap ? "rgba(249, 115, 22, 0.14)" : "#070b14",
              color: showHeatMap ? "#fdba74" : "#94a3b8",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
              transition: "background-color 150ms ease, color 150ms ease, border-color 150ms ease",
            }}
          >
            {showHeatMap ? "Hide Heat Map" : "Show Heat Map"}
          </button>

          <button
            type="button"
            onClick={() => setShowOverlay((v) => !v)}
            aria-pressed={showOverlay}
            style={{
              padding: "6px 10px",
              fontSize: "12px",
              fontWeight: 500,
              borderRadius: "6px",
              border: showOverlay
                ? `1px solid ${mode === "cumulative" ? "rgba(245, 158, 11, 0.45)" : "rgba(248, 113, 113, 0.45)"}`
                : "1px solid #1e293b",
              backgroundColor: showOverlay
                ? mode === "cumulative"
                  ? "rgba(245, 158, 11, 0.12)"
                  : "rgba(248, 113, 113, 0.12)"
                : "#070b14",
              color: showOverlay ? (mode === "cumulative" ? "#fbbf24" : "#fca5a5") : "#94a3b8",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
              transition: "background-color 150ms ease, color 150ms ease, border-color 150ms ease",
            }}
          >
            {showOverlay ? `Hide ${secondaryLabel}` : `Show ${secondaryLabel}`}
          </button>

          <div
            role="group"
            aria-label="Risk exposure time series mode"
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
              style={segmentedBtnStyle(mode === "rolling")}
              onClick={() => setMode("rolling")}
            >
              5m Rolling
            </button>
            <button
              type="button"
              style={segmentedBtnStyle(mode === "perMinute")}
              onClick={() => setMode("perMinute")}
            >
              1m Flow
            </button>
            <button
              type="button"
              style={segmentedBtnStyle(mode === "cumulative")}
              onClick={() => setMode("cumulative")}
            >
              60m Cumulative
            </button>
          </div>
        </div>
      </div>

      {/* Inline series legend (clean unboxed text) */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "16px",
          fontSize: "11px",
          color: "#94a3b8",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
          <span
            aria-hidden="true"
            style={{
              width: "14px",
              height: "2px",
              backgroundColor: "#38bdf8",
              display: "inline-block",
            }}
          />
          <span style={{ color: "#cbd5e1" }}>{primaryLabel}</span>
        </span>
        {showOverlay ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span
              aria-hidden="true"
              style={{
                width: "14px",
                height: "2px",
                backgroundColor: secondaryStroke,
                display: "inline-block",
              }}
            />
            <span style={{ color: "#cbd5e1" }}>{secondaryLabel}</span>
          </span>
        ) : null}
        {mode !== "cumulative" && series.twoSigmaThresholdUsd > 0 ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span aria-hidden="true" style={{ color: "#fb923c", fontWeight: 700 }}>
              ◆
            </span>
            <span>&gt;2σ Risk Surge</span>
          </span>
        ) : null}
        {mode === "cumulative" && exposureLimitUsd && exposureLimitUsd > 0 ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
            <span
              aria-hidden="true"
              style={{
                width: "14px",
                height: "0px",
                borderTop: `2px dashed ${isBreached ? "#ef4444" : "#f59e0b"}`,
                display: "inline-block",
              }}
            />
            <span style={{ color: isBreached ? "#fca5a5" : "#fcd34d" }}>
              60m Limit ({formatRiskCompactUsd(exposureLimitUsd)})
            </span>
          </span>
        ) : null}
        {showHeatMap ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              marginLeft: "auto",
            }}
          >
            <span>Activity Heat:</span>
            <span style={{ color: "#94a3b8" }}>Quiet</span>
            <span
              aria-label="Activity heat scale from light to concentrated"
              style={{ display: "inline-flex", alignItems: "center", gap: "2px" }}
            >
              {([1, 2, 3, 4] as const).map((lvl) => (
                <span
                  key={lvl}
                  title={HEAT_BAND_STYLES[lvl].label}
                  style={{
                    width: "12px",
                    height: "9px",
                    borderRadius: "2px",
                    backgroundColor: HEAT_BAND_STYLES[lvl].swatch,
                    display: "inline-block",
                  }}
                />
              ))}
            </span>
            <span style={{ color: "#fca5a5" }}>Concentrated</span>
          </span>
        ) : null}
      </div>

      {/* Chart viewport or empty state */}
      {hasData ? (
        <div
          style={{
            width: "100%",
            height: "240px",
            minWidth: 0,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={series.points as RiskExposurePoint[]}
              margin={{ top: 8, right: 16, left: 4, bottom: 4 }}
            >
              {showHeatMap
                ? series.heatBands.map((band) => {
                    const style = HEAT_BAND_STYLES[band.heatLevel]
                    return (
                      <ReferenceArea
                        key={`heat-${band.startIdx}-${band.endIdx}-${band.heatLevel}`}
                        x1={band.startIdx - 0.5}
                        x2={band.endIdx + 0.5}
                        fill={style.fill}
                        fillOpacity={style.fillOpacity}
                        stroke="none"
                        ifOverflow="extendDomain"
                      />
                    )
                  })
                : null}
              <CartesianGrid
                stroke="rgba(148, 163, 184, 0.12)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="bucketIndex"
                type="number"
                domain={[-0.5, Math.max(0, series.points.length - 1) + 0.5]}
                ticks={series.points.length >= 60 ? [0, 10, 20, 30, 40, 50, 59] : undefined}
                tickFormatter={(idx: number) => series.points[Math.round(idx)]?.label ?? ""}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={{ stroke: "#1e293b" }}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(val: number) => formatRiskCompactUsd(val)}
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={64}
                domain={
                  mode === "cumulative" && exposureLimitUsd && exposureLimitUsd > 0
                    ? [0, (dataMax: number) => Math.max(dataMax, exposureLimitUsd * 1.08)]
                    : ["auto", "auto"]
                }
              />
              <Tooltip
                content={
                  <RiskExposureTooltip
                    mode={mode}
                    meanMinuteRiskUsd={series.meanMinuteRiskUsd}
                    twoSigmaThresholdUsd={series.twoSigmaThresholdUsd}
                    exposureLimitUsd={exposureLimitUsd}
                  />
                }
                cursor={{
                  stroke: "rgba(56, 189, 248, 0.45)",
                  strokeWidth: 1,
                }}
              />
              {mode === "cumulative" &&
              warningLimitUsd &&
              warningLimitUsd > 0 &&
              (!exposureLimitUsd || warningLimitUsd < exposureLimitUsd) ? (
                <ReferenceLine
                  y={warningLimitUsd}
                  stroke="rgba(245, 158, 11, 0.72)"
                  strokeWidth={1.25}
                  strokeDasharray="4 4"
                  label={{
                    value: `Warn (${formatRiskCompactUsd(warningLimitUsd)})`,
                    position: "insideBottomRight",
                    fill: "#fcd34d",
                    fontSize: 10,
                    fontWeight: 500,
                  }}
                />
              ) : null}
              {mode === "cumulative" && exposureLimitUsd && exposureLimitUsd > 0 ? (
                <ReferenceLine
                  y={exposureLimitUsd}
                  stroke={isBreached ? "#ef4444" : "#f59e0b"}
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  label={{
                    value: `${isBreached ? "BREACH LIMIT" : "60m Limit"} (${formatRiskCompactUsd(exposureLimitUsd)})`,
                    position: "insideTopRight",
                    fill: isBreached ? "#fca5a5" : "#fcd34d",
                    fontSize: 10,
                    fontWeight: 600,
                  }}
                />
              ) : null}
              {mode === "rolling" && series.meanRollingRiskUsd > 0 ? (
                <ReferenceLine
                  y={series.meanRollingRiskUsd}
                  stroke="rgba(148, 163, 184, 0.45)"
                  strokeDasharray="4 4"
                  label={{
                    value: `60m Avg (${formatRiskCompactUsd(series.meanRollingRiskUsd)})`,
                    position: "insideTopRight",
                    fill: "#94a3b8",
                    fontSize: 10,
                  }}
                />
              ) : null}
              {mode === "perMinute" && series.meanMinuteRiskUsd > 0 ? (
                <ReferenceLine
                  y={series.meanMinuteRiskUsd}
                  stroke="rgba(148, 163, 184, 0.4)"
                  strokeDasharray="4 4"
                />
              ) : null}
              {mode === "perMinute" &&
              series.stdDevMinuteRiskUsd > 0 &&
              series.twoSigmaThresholdUsd > 0 ? (
                <ReferenceLine
                  y={series.twoSigmaThresholdUsd}
                  stroke="rgba(249, 115, 22, 0.65)"
                  strokeDasharray="4 3"
                  label={{
                    value: `+2σ (${formatRiskCompactUsd(series.twoSigmaThresholdUsd)})`,
                    position: "insideTopRight",
                    fill: "#fb923c",
                    fontSize: 10,
                  }}
                />
              ) : null}
              <Line
                type="monotone"
                dataKey={primaryKey}
                name={primaryLabel}
                stroke="#38bdf8"
                strokeWidth={2}
                dot={mode === "cumulative" ? false : renderSpikeDiamondMarker}
                activeDot={renderActiveRiskDot}
                isAnimationActive={false}
              />
              {showOverlay ? (
                <Line
                  type="monotone"
                  dataKey={secondaryKey}
                  name={secondaryLabel}
                  stroke={secondaryStroke}
                  strokeWidth={1.75}
                  strokeDasharray={mode === "cumulative" ? "5 3" : undefined}
                  dot={false}
                  activeDot={{
                    r: 3.5,
                    fill: secondaryStroke,
                    stroke: "#0f172a",
                    strokeWidth: 1.5,
                  }}
                  isAnimationActive={false}
                />
              ) : null}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div
          style={{
            height: "180px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "10px",
            borderRadius: "8px",
            backgroundColor: "rgba(7, 11, 20, 0.65)",
            border: "1px dashed rgba(148, 163, 184, 0.2)",
            color: "#94a3b8",
            fontSize: "13px",
            textAlign: "center",
            padding: "16px",
          }}
        >
          <span>
            {hasWagerSnapshot
              ? "No non-sentinel wagers with timestamps in the active 60-minute window yet. Aggregate risk fluctuations plot automatically as the feed updates."
              : `Awaiting live wager snapshot (${snapshotStatus}). Real-time risk fluctuations will appear once feed data arrives.`}
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
