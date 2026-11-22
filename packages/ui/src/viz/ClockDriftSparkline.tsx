import { area, curveMonotoneX, line, max, min, scaleLinear, scaleTime } from "d3"
import type React from "react"
import { useId, useMemo } from "react"

export const CLOCK_DRIFT_WINDOW_MS = 15 * 60 * 1000

export interface ClockDriftPoint {
  readonly tsMs: number
  readonly offsetMs: number
  readonly rttMs: number
}

export interface ClockDriftSparklineProps {
  readonly samples: readonly ClockDriftPoint[]
  readonly accentColor: string
  readonly width?: number
  readonly height?: number
}

interface DriftTrendSummary {
  readonly direction: "increasing" | "decreasing" | "stable" | "collecting"
  readonly label: string
  readonly color: string
  readonly slopeMsPerMin: number
}

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

function formatCompactMs(offsetMs: number): string {
  const rounded = Math.round(offsetMs)
  if (rounded === 0) return "±0ms"
  const sign = rounded > 0 ? "+" : "-"
  const abs = Math.abs(rounded)
  if (abs < 1000) return `${sign}${abs}ms`
  return `${sign}${(abs / 1000).toFixed(abs < 10_000 ? 2 : 1)}s`
}

function formatSpanLabel(spanMs: number): string {
  if (spanMs < 60_000) return `${Math.max(1, Math.round(spanMs / 1000))}s`
  return `${(spanMs / 60_000).toFixed(spanMs < 600_000 ? 1 : 0)}m`
}

function computeDriftTrend(samples: readonly ClockDriftPoint[]): DriftTrendSummary {
  if (samples.length < 2) {
    return {
      direction: "collecting",
      label: "Collecting…",
      color: "#94a3b8",
      slopeMsPerMin: 0,
    }
  }

  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const spanMs = last.tsMs - first.tsMs
  const absDelta = Math.abs(last.offsetMs) - Math.abs(first.offsetMs)

  // Least-squares linear regression of |offsetMs| against elapsed minutes
  const t0 = first.tsMs
  let sumX = 0
  let sumY = 0
  let sumXX = 0
  let sumXY = 0
  for (const pt of samples) {
    const x = (pt.tsMs - t0) / 60_000
    const y = Math.abs(pt.offsetMs)
    sumX += x
    sumY += y
    sumXX += x * x
    sumXY += x * y
  }
  const n = samples.length
  const denom = n * sumXX - sumX * sumX
  const slopeMsPerMin = spanMs >= 5_000 && denom > 1e-9 ? (n * sumXY - sumX * sumY) / denom : 0

  if (slopeMsPerMin > 2 || (absDelta > 20 && slopeMsPerMin > 0.5)) {
    const severityColor = Math.abs(last.offsetMs) > 250 ? "#f87171" : "#fbbf24"
    const rateLabel = Math.abs(slopeMsPerMin) >= 1 ? ` +${slopeMsPerMin.toFixed(1)}ms/m` : ""
    return {
      direction: "increasing",
      label: `↗ Increasing${rateLabel}`,
      color: severityColor,
      slopeMsPerMin,
    }
  }

  if (slopeMsPerMin < -2 || (absDelta < -20 && slopeMsPerMin < -0.5)) {
    return {
      direction: "decreasing",
      label: "↘ Recovering",
      color: "#4ade80",
      slopeMsPerMin,
    }
  }

  return {
    direction: "stable",
    label: "→ Stable",
    color: "#7dd3fc",
    slopeMsPerMin,
  }
}

export function ClockDriftSparkline({
  samples,
  accentColor,
  width = 236,
  height = 54,
}: ClockDriftSparklineProps): React.ReactElement {
  const gradId = useId()

  const chart = useMemo(() => {
    const padLeft = 4
    const padRight = 6
    const padTop = 7
    const padBottom = 7

    const latestTs = samples.length > 0 ? samples[samples.length - 1]!.tsMs : Date.now()
    const cutoff = latestTs - CLOCK_DRIFT_WINDOW_MS
    const windowed = samples.filter((pt) => pt.tsMs >= cutoff)

    const trend = computeDriftTrend(windowed)

    if (windowed.length === 0) {
      return {
        windowed,
        trend,
        linePath: null as string | null,
        areaPath: null as string | null,
        zeroY: height / 2,
        points: [] as readonly {
          readonly x: number
          readonly y: number
          readonly offsetMs: number
        }[],
        minOffset: 0,
        maxOffset: 0,
        spanMs: 0,
      }
    }

    const minOffset = min(windowed, (d) => d.offsetMs) ?? 0
    const maxOffset = max(windowed, (d) => d.offsetMs) ?? 0
    const maxAbs = Math.max(25, Math.abs(minOffset), Math.abs(maxOffset))
    const yPad = Math.max(8, maxAbs * 0.18)
    const yMin = Math.min(0, minOffset) - yPad
    const yMax = Math.max(0, maxOffset) + yPad

    const firstTs = windowed[0]!.tsMs
    const spanMs = Math.max(0, latestTs - firstTs)
    // Use actual probe span when >= 2 points so early samples fill the sparkline clearly,
    // capped at the 15-minute rolling window.
    const xStart = windowed.length >= 2 && spanMs > 0 ? firstTs : latestTs - CLOCK_DRIFT_WINDOW_MS

    const xScale = scaleTime()
      .domain([new Date(xStart), new Date(latestTs)])
      .range([padLeft, width - padRight])

    const yScale = scaleLinear()
      .domain([yMin, yMax])
      .range([height - padBottom, padTop])

    const zeroY = yScale(0)

    const lineGen = line<ClockDriftPoint>()
      .x((d) => xScale(new Date(d.tsMs)))
      .y((d) => yScale(d.offsetMs))
      .curve(curveMonotoneX)

    const areaGen = area<ClockDriftPoint>()
      .x((d) => xScale(new Date(d.tsMs)))
      .y0(zeroY)
      .y1((d) => yScale(d.offsetMs))
      .curve(curveMonotoneX)

    const points = windowed.map((pt) => ({
      x: windowed.length === 1 ? width - padRight - 2 : xScale(new Date(pt.tsMs)),
      y: yScale(pt.offsetMs),
      offsetMs: pt.offsetMs,
    }))

    return {
      windowed,
      trend,
      linePath: windowed.length >= 2 ? lineGen(windowed) : null,
      areaPath: windowed.length >= 2 ? areaGen(windowed) : null,
      zeroY,
      points,
      minOffset,
      maxOffset,
      spanMs,
    }
  }, [samples, width, height])

  const strokeColor = chart.trend.direction === "increasing" ? chart.trend.color : accentColor
  const lastPoint = chart.points.length > 0 ? chart.points[chart.points.length - 1] : null

  return (
    <span
      data-clock-drift-sparkline="true"
      data-drift-trend={chart.trend.direction}
      style={{
        display: "block",
        marginTop: "6px",
        padding: "6px 7px 5px",
        borderRadius: "5px",
        backgroundColor: "rgba(5, 9, 18, 0.92)",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "rgba(30, 41, 59, 0.95)",
      }}
    >
      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          marginBottom: "4px",
          fontSize: "9.5px",
          fontFamily: MONO_FONT,
        }}
      >
        <span style={{ color: "#94a3b8", fontWeight: 600 }}>15m Drift Trend</span>
        <span style={{ color: chart.trend.color, fontWeight: 700 }}>{chart.trend.label}</span>
      </span>

      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Clock drift trend over the last 15 minutes (${chart.windowed.length} samples, ${chart.trend.label})`}
        style={{ display: "block", width: "100%", height: `${height}px`, overflow: "visible" }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity={0.32} />
            <stop offset="100%" stopColor={strokeColor} stopOpacity={0.03} />
          </linearGradient>
        </defs>

        {/* 0ms zero-drift reference baseline */}
        <line
          x1={2}
          x2={width - 2}
          y1={chart.zeroY}
          y2={chart.zeroY}
          stroke="rgba(148, 163, 184, 0.32)"
          strokeWidth={1}
          strokeDasharray="2,2"
        />
        <text
          x={4}
          y={Math.max(9, chart.zeroY - 3)}
          fill="#64748b"
          fontSize={8}
          fontFamily={MONO_FONT}
        >
          0ms
        </text>

        {chart.areaPath && <path d={chart.areaPath} fill={`url(#${gradId})`} stroke="none" />}

        {chart.linePath && (
          <path
            d={chart.linePath}
            fill="none"
            stroke={strokeColor}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {chart.points.length <= 16 &&
          chart.points
            .slice(0, -1)
            .map((pt, idx) => (
              <circle key={idx} cx={pt.x} cy={pt.y} r={1.6} fill={strokeColor} fillOpacity={0.65} />
            ))}

        {lastPoint && (
          <>
            <circle
              cx={lastPoint.x}
              cy={lastPoint.y}
              r={4.2}
              fill={strokeColor}
              fillOpacity={0.22}
            />
            <circle cx={lastPoint.x} cy={lastPoint.y} r={2.2} fill={strokeColor} />
          </>
        )}
      </svg>

      <span
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          marginTop: "3px",
          fontSize: "9px",
          color: "#64748b",
          fontFamily: MONO_FONT,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>
          {chart.windowed.length > 0
            ? `${formatCompactMs(chart.minOffset)} … ${formatCompactMs(chart.maxOffset)}`
            : "No samples yet"}
        </span>
        <span>
          {chart.windowed.length} {chart.windowed.length === 1 ? "probe" : "probes"}
          {chart.spanMs > 0 ? ` · ${formatSpanLabel(chart.spanMs)}` : " · 15s poll"}
        </span>
      </span>
    </span>
  )
}
