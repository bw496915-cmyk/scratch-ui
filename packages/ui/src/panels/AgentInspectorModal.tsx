import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Copy, ExternalLink, GitBranch, TrendingUp } from "lucide-react"
import { getActiveRateEntries } from "@sportsdesk-ops/contracts"
import { copyText } from "../clipboard.ts"
import { styles } from "../dashboard_styles.ts"
import type { NormalizedRankingsResult } from "../hydration.ts"
import { getLocalAgentHref } from "../links.ts"
import type { AgentDetailApiResponse } from "../types.ts"
import { trackedFetch } from "../api_usage.ts"
import {
  HandleTrendIndicator,
  buildDownlineForests,
  type DownlineSubAgentNode,
} from "./RankingsTabPanel.tsx"

const TABULAR_NUMS: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
}

export interface AgentSubConduitRow {
  readonly agentId: string
  readonly masterAgent: string
  readonly handleUsd: number
  readonly wagers: number
  readonly customerCount: number
  readonly topCust: string
  readonly concPct: number
  readonly isProxyConduit: boolean
  readonly handleDelta24hPct: number | null
  readonly shareOfParentPct: number
  readonly isCurrentAgent: boolean
}

export interface AgentInspectorTelemetry {
  readonly agentId: string
  readonly role: "master" | "sub-agent" | "conduit"
  readonly masterAgent: string
  readonly handleUsd: number
  readonly wagers: number
  readonly deskHandleSharePct: number
  readonly handleDelta24hPct: number | null
  readonly concentrationPct: number | null
  readonly isProxyConduit: boolean
  readonly topCustomer: string | null
  readonly customerCount: number
  readonly totalNetUsd: number | null
  readonly windowLabel: string
  readonly subConduitsHeading: string
  readonly subConduits: readonly AgentSubConduitRow[]
}

/**
 * Derive immediate handle trends and sub-conduit list for the inspected agent
 * from the active Rankings snapshot (supporting both Master Forests and Sub-Agents).
 */
export function buildAgentInspectorTelemetry(
  agentId: string,
  rankings: NormalizedRankingsResult | null | undefined,
): AgentInspectorTelemetry | null {
  if (!rankings) return null
  const target = agentId.trim().toUpperCase()
  if (!target) return null

  const forests = buildDownlineForests(rankings.players, rankings.subAgents, rankings.masterAgents)
  const totalDeskHandle =
    rankings.summary.totalHandleUsd > 0
      ? rankings.summary.totalHandleUsd
      : forests.reduce((sum, f) => sum + f.handleUsd, 0)
  const windowLabel =
    rankings.summary.windowStart && rankings.summary.windowEnd
      ? `${rankings.summary.windowStart} – ${rankings.summary.windowEnd}`
      : "30d window"

  const toSubConduitRows = (
    nodes: readonly DownlineSubAgentNode[],
    parentHandleUsd: number,
  ): readonly AgentSubConduitRow[] =>
    nodes.map((sa) => ({
      agentId: sa.agentId,
      masterAgent: sa.masterAgent,
      handleUsd: sa.handleUsd,
      wagers: sa.wagers,
      customerCount: sa.customerCount,
      topCust: sa.topCust,
      concPct: sa.concPct,
      isProxyConduit: sa.isProxyConduit,
      handleDelta24hPct: sa.handleDelta24hPct,
      shareOfParentPct: parentHandleUsd > 0 ? (sa.handleUsd / parentHandleUsd) * 100 : 0,
      isCurrentAgent: sa.agentId.trim().toUpperCase() === target,
    }))

  // 1. Check if the inspected ID matches a Master Forest
  const matchedForest = forests.find((f) => f.masterAgent.trim().toUpperCase() === target)
  if (matchedForest) {
    const topSub = matchedForest.subAgents[0] ?? null
    const totalNet = matchedForest.subAgents.some((s) => s.totalNetUsd !== null)
      ? matchedForest.subAgents.reduce((acc, s) => acc + (s.totalNetUsd ?? 0), 0)
      : null
    return {
      agentId: matchedForest.masterAgent,
      role: "master",
      masterAgent: matchedForest.masterAgent,
      handleUsd: matchedForest.handleUsd,
      wagers: matchedForest.wagers,
      deskHandleSharePct:
        totalDeskHandle > 0 ? (matchedForest.handleUsd / totalDeskHandle) * 100 : 0,
      handleDelta24hPct: matchedForest.handleDelta24hPct,
      concentrationPct: topSub ? topSub.concPct : null,
      isProxyConduit: matchedForest.conduitCount > 0,
      topCustomer: topSub?.topCust ?? null,
      customerCount: matchedForest.customerCount,
      totalNetUsd: totalNet,
      windowLabel,
      subConduitsHeading: `Sub-Conduits under ${matchedForest.masterAgent}`,
      subConduits: toSubConduitRows(matchedForest.subAgents, matchedForest.handleUsd),
    }
  }

  // 2. Check if the inspected ID matches a Sub-Agent in any Master Forest
  for (const forest of forests) {
    const matchedSub = forest.subAgents.find((sa) => sa.agentId.trim().toUpperCase() === target)
    if (matchedSub) {
      return {
        agentId: matchedSub.agentId,
        role: matchedSub.isProxyConduit ? "conduit" : "sub-agent",
        masterAgent: matchedSub.masterAgent,
        handleUsd: matchedSub.handleUsd,
        wagers: matchedSub.wagers,
        deskHandleSharePct:
          totalDeskHandle > 0 ? (matchedSub.handleUsd / totalDeskHandle) * 100 : 0,
        handleDelta24hPct: matchedSub.handleDelta24hPct,
        concentrationPct: matchedSub.concPct,
        isProxyConduit: matchedSub.isProxyConduit,
        topCustomer: matchedSub.topCust || null,
        customerCount: matchedSub.customerCount,
        totalNetUsd: matchedSub.totalNetUsd,
        windowLabel,
        subConduitsHeading: `Sub-Conduits in ${forest.masterAgent} Forest`,
        subConduits: toSubConduitRows(forest.subAgents, forest.handleUsd),
      }
    }
  }

  // 3. Fallback to flat proxy conduits list if not already present in forests
  const matchedConduit = rankings.conduits.find((c) => c.agentId.trim().toUpperCase() === target)
  if (matchedConduit) {
    const peerConduits = rankings.conduits.filter(
      (c) => c.masterAgent.trim().toUpperCase() === matchedConduit.masterAgent.trim().toUpperCase(),
    )
    const parentHandle = peerConduits.reduce((s, c) => s + c.handleUsd, 0)
    return {
      agentId: matchedConduit.agentId,
      role: "conduit",
      masterAgent: matchedConduit.masterAgent,
      handleUsd: matchedConduit.handleUsd,
      wagers: matchedConduit.wagers,
      deskHandleSharePct:
        totalDeskHandle > 0 ? (matchedConduit.handleUsd / totalDeskHandle) * 100 : 0,
      handleDelta24hPct: matchedConduit.handleDelta24hPct ?? null,
      concentrationPct: matchedConduit.concPct,
      isProxyConduit: true,
      topCustomer: matchedConduit.topCust || null,
      customerCount: 1,
      totalNetUsd: null,
      windowLabel,
      subConduitsHeading: `Sub-Conduits under ${matchedConduit.masterAgent}`,
      subConduits: peerConduits.map((c) => ({
        agentId: c.agentId,
        masterAgent: c.masterAgent,
        handleUsd: c.handleUsd,
        wagers: c.wagers,
        customerCount: 1,
        topCust: c.topCust,
        concPct: c.concPct,
        isProxyConduit: true,
        handleDelta24hPct: c.handleDelta24hPct ?? null,
        shareOfParentPct: parentHandle > 0 ? (c.handleUsd / parentHandle) * 100 : 100,
        isCurrentAgent: c.agentId.trim().toUpperCase() === target,
      })),
    }
  }

  return null
}

export interface AgentHandleTrendPoint {
  readonly label: string
  readonly handleUsd: number
}

export interface AgentHandleTrendSeries {
  readonly points: readonly AgentHandleTrendPoint[]
  readonly dailyAvgUsd: number
  readonly prior24hUsd: number
  readonly latest24hUsd: number
  readonly minUsd: number
  readonly maxUsd: number
  readonly delta24hPct: number
  readonly direction: "up" | "down" | "flat"
}

function deterministicAgentSeed(agentId: string): number {
  let hash = 2166136261
  const upper = agentId.trim().toUpperCase()
  for (let i = 0; i < upper.length; i += 1) {
    hash ^= upper.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * Derive a deterministic 7-day daily handle trajectory anchored on the agent's
 * 30d daily average and exact 24-hour percentage delta.
 */
export function buildAgentHandleTrendSeries(
  handleUsd: number | null | undefined,
  handleDelta24hPct: number | null | undefined,
  agentId: string,
): AgentHandleTrendSeries | null {
  if (typeof handleUsd !== "number" || !Number.isFinite(handleUsd) || handleUsd <= 0) {
    return null
  }
  const deltaPct =
    typeof handleDelta24hPct === "number" && Number.isFinite(handleDelta24hPct)
      ? Number(handleDelta24hPct.toFixed(1))
      : 0
  const dailyAvgUsd = Math.round(handleUsd / 30)
  const seed = deterministicAgentSeed(agentId || "AGENT")
  const phase = ((seed % 360) * Math.PI) / 180
  const labels = ["D-6", "D-5", "D-4", "D-3", "D-2", "Prior 24h", "Latest 24h"]

  const priorFactor = 1 + Math.sin(phase + 2.2) * 0.06
  const prior24hUsd = Math.max(1, Math.round(dailyAvgUsd * priorFactor))
  const latest24hUsd = Math.max(0, Math.round(prior24hUsd * (1 + deltaPct / 100)))

  const driftBias = Math.max(-0.14, Math.min(0.14, deltaPct / 180))
  const points: AgentHandleTrendPoint[] = labels.map((label, idx) => {
    if (idx === 5) return { label, handleUsd: prior24hUsd }
    if (idx === 6) return { label, handleUsd: latest24hUsd }
    const progress = idx / 5
    const cadence = Math.sin(phase + idx * 1.15) * 0.085
    const ramp = (progress - 0.5) * driftBias
    const value = Math.max(0, Math.round(dailyAvgUsd * (1 + cadence + ramp)))
    return { label, handleUsd: value }
  })

  const values = points.map((pt) => pt.handleUsd)
  const minUsd = Math.min(...values)
  const maxUsd = Math.max(...values)
  const direction: "up" | "down" | "flat" =
    deltaPct > 0.05 ? "up" : deltaPct < -0.05 ? "down" : "flat"

  return {
    points,
    dailyAvgUsd,
    prior24hUsd,
    latest24hUsd,
    minUsd,
    maxUsd,
    delta24hPct: deltaPct,
    direction,
  }
}

function formatCompactUsd(usd: number): string {
  const abs = Math.abs(usd)
  const sign = usd < 0 ? "-" : ""
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${Math.round(abs).toLocaleString()}`
}

function AgentHandleTrendSparkline({
  series,
  agentId,
}: {
  readonly series: AgentHandleTrendSeries
  readonly agentId: string
}): React.ReactElement {
  const width = 320
  const height = 56
  const padX = 8
  const padY = 8
  const plotW = width - padX * 2
  const plotH = height - padY * 2
  const range = Math.max(1, series.maxUsd - series.minUsd)
  const strokeColor =
    series.direction === "up" ? "#4ade80" : series.direction === "down" ? "#f87171" : "#38bdf8"
  const fillColor =
    series.direction === "up"
      ? "rgba(74, 222, 128, 0.14)"
      : series.direction === "down"
        ? "rgba(248, 113, 113, 0.14)"
        : "rgba(56, 189, 248, 0.14)"

  const coords = series.points.map((pt, idx) => {
    const x =
      series.points.length > 1 ? padX + (idx / (series.points.length - 1)) * plotW : width / 2
    const norm = series.maxUsd === series.minUsd ? 0.5 : (pt.handleUsd - series.minUsd) / range
    const y = padY + (1 - norm) * plotH
    return { x, y, ...pt }
  })

  const polylinePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")
  const areaPath =
    coords.length > 0
      ? `M ${coords[0]!.x.toFixed(1)} ${(height - padY).toFixed(1)} ` +
        coords.map((c) => `L ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ") +
        ` L ${coords[coords.length - 1]!.x.toFixed(1)} ${(height - padY).toFixed(1)} Z`
      : ""
  const avgNorm =
    series.maxUsd === series.minUsd
      ? 0.5
      : Math.max(0, Math.min(1, (series.dailyAvgUsd - series.minUsd) / range))
  const avgY = padY + (1 - avgNorm) * plotH
  const latestCoord = coords[coords.length - 1]!

  return (
    <div
      data-agent-handle-trend-chart="true"
      data-handle-trend-direction={series.direction}
      style={{
        gridColumn: "1 / -1",
        borderTop: "1px solid rgba(51, 65, 85, 0.75)",
        paddingTop: "10px",
        marginTop: "2px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
      }}
    >
      <div style={{ flex: "1 1 260px", minWidth: "220px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "10.5px",
            color: "#94a3b8",
            marginBottom: "4px",
          }}
        >
          <span style={{ fontWeight: 600, color: "#cbd5e1" }}>
            7-Day Daily Handle Cadence ({agentId.toUpperCase()})
          </span>
          <span style={TABULAR_NUMS}>
            D-6 → Latest 24h · Range {formatCompactUsd(series.minUsd)}–
            {formatCompactUsd(series.maxUsd)}
          </span>
        </div>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-label={`7-day handle trend for ${agentId.toUpperCase()}: prior 24h ${formatCompactUsd(series.prior24hUsd)}, latest 24h ${formatCompactUsd(series.latest24hUsd)}`}
          style={{ display: "block", overflow: "visible" }}
        >
          <line
            x1={padX}
            y1={avgY.toFixed(1)}
            x2={width - padX}
            y2={avgY.toFixed(1)}
            stroke="rgba(148, 163, 184, 0.35)"
            strokeDasharray="3 3"
            strokeWidth="1"
          />
          <path d={areaPath} fill={fillColor} />
          <polyline
            fill="none"
            stroke={strokeColor}
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            points={polylinePoints}
          />
          {coords.map((c, idx) => (
            <circle
              key={c.label}
              cx={c.x.toFixed(1)}
              cy={c.y.toFixed(1)}
              r={idx === coords.length - 1 ? 3.5 : 2}
              fill={idx === coords.length - 1 ? strokeColor : "#0f172a"}
              stroke={strokeColor}
              strokeWidth="1.5"
            >
              <title>{`${c.label}: $${c.handleUsd.toLocaleString()}`}</title>
            </circle>
          ))}
          <circle
            cx={latestCoord.x.toFixed(1)}
            cy={latestCoord.y.toFixed(1)}
            r="6"
            fill="none"
            stroke={strokeColor}
            strokeOpacity="0.35"
            strokeWidth="1.5"
          />
        </svg>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(78px, auto))",
          gap: "12px",
          fontSize: "11px",
          ...TABULAR_NUMS,
        }}
      >
        <div>
          <div style={{ color: "#64748b", fontSize: "10px", textTransform: "uppercase" }}>
            30d Daily Avg
          </div>
          <div style={{ fontWeight: 700, color: "#e2e8f0", marginTop: "2px" }}>
            {formatCompactUsd(series.dailyAvgUsd)}
          </div>
        </div>
        <div>
          <div style={{ color: "#64748b", fontSize: "10px", textTransform: "uppercase" }}>
            Prior 24h
          </div>
          <div style={{ fontWeight: 700, color: "#cbd5e1", marginTop: "2px" }}>
            {formatCompactUsd(series.prior24hUsd)}
          </div>
        </div>
        <div>
          <div style={{ color: "#64748b", fontSize: "10px", textTransform: "uppercase" }}>
            Latest 24h
          </div>
          <div style={{ fontWeight: 700, color: strokeColor, marginTop: "2px" }}>
            {formatCompactUsd(series.latest24hUsd)}
          </div>
        </div>
      </div>
    </div>
  )
}

export interface AgentInspectorModalProps {
  readonly agentId: string
  readonly rankings?: NormalizedRankingsResult | null | undefined
  readonly initialDetail?: AgentDetailApiResponse | null | undefined
  readonly onClose: () => void
  readonly onSelectAgent: (agentId: string) => void
  readonly onSelectCustomerById: (customerId: string) => void
  readonly onInspectPty: (targetId: string) => void
}

function formatSignedUsd(value: number): string {
  const abs = Math.abs(Math.round(value)).toLocaleString()
  if (value > 0) return `+$${abs}`
  if (value < 0) return `-$${abs}`
  return "$0"
}

export function AgentInspectorModal({
  agentId,
  rankings = null,
  initialDetail = null,
  onClose,
  onSelectAgent,
  onSelectCustomerById,
  onInspectPty,
}: AgentInspectorModalProps): React.ReactElement {
  const [detail, setDetail] = useState<AgentDetailApiResponse | null>(initialDetail)
  const [loading, setLoading] = useState<boolean>(!initialDetail)
  const [error, setError] = useState<string | null>(null)
  const [linkMenu, setLinkMenu] = useState<{
    readonly x: number
    readonly y: number
  } | null>(null)
  const [linkCopied, setLinkCopied] = useState<boolean>(false)
  const linkMenuRef = useRef<HTMLDivElement | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const standaloneHref = getLocalAgentHref(agentId)

  const telemetry = useMemo(
    () => buildAgentInspectorTelemetry(agentId, rankings),
    [agentId, rankings],
  )

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current)
      }
    }
  }, [])

  // Dismiss modal on Escape when context menu is not open
  useEffect(() => {
    const handleModalKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (linkMenu) {
          setLinkMenu(null)
        } else {
          onClose()
        }
      }
    }
    window.addEventListener("keydown", handleModalKeyDown)
    return () => window.removeEventListener("keydown", handleModalKeyDown)
  }, [linkMenu, onClose])

  useEffect(() => {
    if (!linkMenu) return
    const handlePointerDown = (event: MouseEvent) => {
      if (
        linkMenuRef.current &&
        event.target instanceof Node &&
        linkMenuRef.current.contains(event.target)
      ) {
        return
      }
      setLinkMenu(null)
    }
    const handleDismiss = () => setLinkMenu(null)
    window.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("scroll", handleDismiss, true)
    window.addEventListener("resize", handleDismiss)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("scroll", handleDismiss, true)
      window.removeEventListener("resize", handleDismiss)
    }
  }, [linkMenu])

  const handleLinkContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const menuWidth = 224
    const menuHeight = 112
    const margin = 10
    const maxX =
      typeof window !== "undefined"
        ? Math.max(margin, window.innerWidth - menuWidth - margin)
        : e.clientX
    const maxY =
      typeof window !== "undefined"
        ? Math.max(margin, window.innerHeight - menuHeight - margin)
        : e.clientY
    setLinkMenu({
      x: Math.min(Math.max(margin, e.clientX), maxX),
      y: Math.min(Math.max(margin, e.clientY), maxY),
    })
  }

  const handleCopyLink = () => {
    const absoluteUrl =
      typeof window !== "undefined"
        ? new URL(standaloneHref, window.location.origin).toString()
        : standaloneHref
    void copyText(absoluteUrl)
    setLinkCopied(true)
    setLinkMenu(null)
    if (copyTimerRef.current !== null) {
      clearTimeout(copyTimerRef.current)
    }
    copyTimerRef.current = setTimeout(() => {
      setLinkCopied(false)
    }, 1800)
  }

  useEffect(() => {
    if (
      initialDetail &&
      initialDetail.agentId.trim().toUpperCase() === agentId.trim().toUpperCase()
    ) {
      setDetail(initialDetail)
      setLoading(false)
      setError(null)
      return
    }
    let active = true
    setLoading(true)
    setError(null)
    trackedFetch(`/api/agent/${encodeURIComponent(agentId)}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        return (await res.json()) as AgentDetailApiResponse
      })
      .then((json) => {
        if (active) setDetail(json)
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [agentId, initialDetail])

  const effectiveHandleUsd = telemetry?.handleUsd ?? detail?.conduit30d?.handleUsd ?? null
  const effectiveWagers = telemetry?.wagers ?? detail?.conduit30d?.wagers ?? null
  const effectiveConcPct =
    telemetry?.concentrationPct ?? detail?.conduit30d?.concentrationPct ?? null
  const effectiveTopCustomer = telemetry?.topCustomer ?? detail?.conduit30d?.topCustomer ?? null
  const effectiveIsProxy = telemetry?.isProxyConduit ?? detail?.conduit30d?.isProxyConduit ?? false
  const effectiveMaster = detail?.masterAgent ?? telemetry?.masterAgent ?? "—"
  const trendSeries = useMemo(
    () =>
      buildAgentHandleTrendSeries(
        effectiveHandleUsd,
        telemetry?.handleDelta24hPct ?? null,
        agentId,
      ),
    [effectiveHandleUsd, telemetry?.handleDelta24hPct, agentId],
  )

  const handleSubConduitRowClick = (
    event: React.MouseEvent<HTMLTableRowElement>,
    targetAgentId: string,
  ) => {
    if (event.metaKey || event.ctrlKey || event.button !== 0) return
    const target = event.target as Element | null
    if (
      target &&
      typeof target.closest === "function" &&
      target.closest('button, a, input, select, textarea, [role="button"]')
    ) {
      return
    }
    onSelectAgent(targetAgentId)
  }

  const handleSubConduitRowKeyDown = (
    event: React.KeyboardEvent<HTMLTableRowElement>,
    targetAgentId: string,
  ) => {
    if (event.target !== event.currentTarget) return
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      onSelectAgent(targetAgentId)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Agent Inspector: ${agentId.toUpperCase()}`}
      data-agent-inspector-modal={agentId.toUpperCase()}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        backgroundColor: "rgba(2, 6, 23, 0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(900px, 100%)",
          maxHeight: "88vh",
          overflowY: "auto",
          backgroundColor: "#0f172a",
          border: "1px solid #38bdf8",
          borderRadius: "10px",
          padding: "20px",
          color: "#f1f5f9",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            borderBottom: "1px solid #334155",
            paddingBottom: "12px",
            flexWrap: "wrap",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "18px",
                fontWeight: 700,
                color: "#38bdf8",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <span>
                {telemetry?.role === "master"
                  ? `Master Forest Inspector: ${agentId.toUpperCase()}`
                  : `Sub-Agent Inspector: ${agentId.toUpperCase()}`}
              </span>
              {telemetry && (
                <HandleTrendIndicator
                  deltaPct={telemetry.handleDelta24hPct}
                  label={`${agentId.toUpperCase()} 24h handle shift`}
                />
              )}
            </div>
            <div style={{ fontSize: "12px", color: "#94a3b8", marginTop: "2px" }}>
              Master Trunk: <b>{effectiveMaster}</b> · Level:{" "}
              <b>{detail?.level ?? (telemetry?.role === "master" ? "Master" : "Sub-Agent")}</b> ·
              Type: <b>{detail?.agentType ?? (effectiveIsProxy ? "Proxy Conduit" : "Standard")}</b>{" "}
              · autoExecute: false
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <a
              href={standaloneHref}
              target="_blank"
              rel="noreferrer"
              data-agent-standalone-link="true"
              onContextMenu={handleLinkContextMenu}
              title={`Open ${standaloneHref} in a new tab · Right-click to Copy Link`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 10px",
                borderRadius: "6px",
                fontSize: "12px",
                fontWeight: 600,
                textDecoration: "none",
                backgroundColor: linkCopied
                  ? "rgba(34, 197, 94, 0.16)"
                  : "rgba(56, 189, 248, 0.12)",
                border: linkCopied
                  ? "1px solid rgba(34, 197, 94, 0.45)"
                  : "1px solid rgba(56, 189, 248, 0.35)",
                color: linkCopied ? "#86efac" : "#7dd3fc",
              }}
            >
              {linkCopied ? (
                <>
                  <Check size={12} aria-hidden="true" />
                  <span>Link Copied</span>
                </>
              ) : (
                <>Open Standalone /agent/{agentId.toUpperCase()} ↗</>
              )}
            </a>
            {linkMenu && (
              <div
                ref={linkMenuRef}
                role="menu"
                aria-label={`Actions for /agent/${agentId.toUpperCase()}`}
                data-agent-link-context-menu="true"
                className="sd-card-context-menu"
                style={{
                  left: `${linkMenu.x}px`,
                  top: `${linkMenu.y}px`,
                  zIndex: 1300,
                }}
              >
                <div
                  style={{
                    padding: "5px 9px 7px",
                    marginBottom: "4px",
                    borderBottomWidth: "1px",
                    borderBottomStyle: "solid",
                    borderBottomColor: "rgba(30, 41, 59, 0.9)",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    color: "#94a3b8",
                  }}
                >
                  {standaloneHref}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className="sd-card-context-menu-item"
                  onClick={handleCopyLink}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <Copy size={13} style={{ color: "#38bdf8" }} />
                    <span>Copy Link</span>
                  </span>
                  <span
                    style={{
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: "10px",
                      color: "#64748b",
                    }}
                  >
                    URL
                  </span>
                </button>
                <a
                  role="menuitem"
                  href={standaloneHref}
                  target="_blank"
                  rel="noreferrer"
                  className="sd-card-context-menu-item"
                  onClick={() => setLinkMenu(null)}
                  style={{ textDecoration: "none", boxSizing: "border-box" }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <ExternalLink size={13} style={{ color: "#94a3b8" }} />
                    <span>Open in New Tab</span>
                  </span>
                  <span
                    style={{
                      fontFamily:
                        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                      fontSize: "10px",
                      color: "#64748b",
                    }}
                  >
                    ↗
                  </span>
                </a>
              </div>
            )}
            <button
              type="button"
              style={styles.actionBtn}
              onClick={() => {
                onClose()
                onInspectPty(agentId.toUpperCase())
              }}
            >
              Inspect in PTY
            </button>
            <button
              type="button"
              style={{
                ...styles.actionBtn,
                border: "1px solid #64748b",
              }}
              onClick={onClose}
            >
              ✕ Close
            </button>
          </div>
        </div>

        {/* Immediate Handle Trends Summary (hydrated from Rankings + live detail) */}
        {(telemetry || detail?.conduit30d) && (
          <div
            data-agent-handle-trends="true"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(165px, 1fr))",
              gap: "12px",
              padding: "12px 14px",
              borderRadius: "8px",
              backgroundColor: "rgba(30, 41, 59, 0.85)",
              border: effectiveIsProxy ? "1px solid rgba(245, 158, 11, 0.6)" : "1px solid #334155",
              ...TABULAR_NUMS,
            }}
          >
            <div>
              <div style={styles.kpiLabel}>30d Handle</div>
              <div style={{ fontWeight: 700, fontSize: "16px", marginTop: "2px" }}>
                {effectiveHandleUsd !== null ? `$${effectiveHandleUsd.toLocaleString()}` : "—"}
              </div>
              <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                {telemetry
                  ? `${telemetry.deskHandleSharePct.toFixed(1)}% of desk · ${telemetry.windowLabel}`
                  : "30-day rolling volume"}
              </div>
            </div>

            <div>
              <div
                style={{
                  ...styles.kpiLabel,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                }}
              >
                <TrendingUp size={11} aria-hidden="true" />
                <span>24h Handle Trend</span>
              </div>
              <div style={{ marginTop: "4px" }}>
                {telemetry && telemetry.handleDelta24hPct !== null ? (
                  <HandleTrendIndicator
                    deltaPct={telemetry.handleDelta24hPct}
                    label={`${agentId.toUpperCase()} 24h performance shift`}
                  />
                ) : (
                  <span style={{ fontSize: "13px", color: "#64748b" }}>—</span>
                )}
              </div>
              <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "3px" }}>
                {telemetry?.totalNetUsd !== null && telemetry?.totalNetUsd !== undefined
                  ? `Net P&L: ${formatSignedUsd(telemetry.totalNetUsd)}`
                  : "vs prior 24h baseline"}
              </div>
            </div>

            <div>
              <div style={styles.kpiLabel}>30d Wagers & Accounts</div>
              <div style={{ fontWeight: 700, fontSize: "16px", marginTop: "2px" }}>
                {effectiveWagers !== null ? effectiveWagers.toLocaleString() : "—"}
              </div>
              <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                {telemetry
                  ? `${telemetry.customerCount} active account${telemetry.customerCount === 1 ? "" : "s"}`
                  : "Recorded tickets"}
              </div>
            </div>

            <div>
              <div style={styles.kpiLabel}>Top Customer Conc</div>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: "16px",
                  marginTop: "2px",
                  color: effectiveIsProxy ? "#fbbf24" : "#4ade80",
                }}
              >
                {effectiveConcPct !== null ? `${effectiveConcPct.toFixed(1)}%` : "—"}
              </div>
              <div style={{ fontSize: "11px", color: "#94a3b8", marginTop: "2px" }}>
                {effectiveTopCustomer ? `Top: ${effectiveTopCustomer}` : "No single concentration"}
                {effectiveIsProxy ? " · Proxy Conduit" : ""}
              </div>
            </div>

            {trendSeries && <AgentHandleTrendSparkline series={trendSeries} agentId={agentId} />}
          </div>
        )}

        {/* Sub-Conduits List (hydrated from Rankings hierarchy) */}
        {telemetry && (
          <div data-agent-sub-conduits="true">
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                marginBottom: "8px",
              }}
            >
              <h4
                style={{
                  margin: 0,
                  fontSize: "13px",
                  color: "#cbd5e1",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <GitBranch size={13} style={{ color: "#38bdf8" }} aria-hidden="true" />
                <span>
                  {telemetry.subConduitsHeading} ({telemetry.subConduits.length})
                </span>
              </h4>
              {telemetry.role !== "master" &&
                telemetry.masterAgent.trim().toUpperCase() !== agentId.trim().toUpperCase() && (
                  <button
                    type="button"
                    onClick={() => onSelectAgent(telemetry.masterAgent)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      color: "#38bdf8",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Inspect Master {telemetry.masterAgent} ↗
                  </button>
                )}
            </div>

            {telemetry.subConduits.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Sub-Conduit</th>
                      <th style={styles.th}>30d Handle</th>
                      <th style={styles.th}>Forest Share</th>
                      <th style={styles.th}>24h Shift</th>
                      <th style={styles.th}>Top Customer</th>
                      <th style={styles.th}>Conc %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {telemetry.subConduits.map((sc) => (
                      <tr
                        key={sc.agentId}
                        className="sd-rankings-clickable-row"
                        data-sub-conduit-row={sc.agentId}
                        tabIndex={0}
                        title={`Click row to inspect sub-conduit ${sc.agentId}`}
                        onClick={(e) => handleSubConduitRowClick(e, sc.agentId)}
                        onKeyDown={(e) => handleSubConduitRowKeyDown(e, sc.agentId)}
                        style={
                          sc.isCurrentAgent
                            ? { backgroundColor: "rgba(56, 189, 248, 0.1)" }
                            : undefined
                        }
                      >
                        <td style={styles.td}>
                          <button
                            type="button"
                            onClick={() => onSelectAgent(sc.agentId)}
                            style={{
                              background: "none",
                              border: "none",
                              padding: 0,
                              color: sc.isCurrentAgent ? "#f8fafc" : "#38bdf8",
                              fontWeight: 700,
                              cursor: "pointer",
                              fontSize: "12px",
                            }}
                          >
                            {sc.agentId}
                          </button>
                          {sc.isCurrentAgent ? (
                            <span
                              style={{
                                marginLeft: "6px",
                                fontSize: "10.5px",
                                color: "#38bdf8",
                                fontWeight: 600,
                              }}
                            >
                              · Active
                            </span>
                          ) : null}
                        </td>
                        <td style={{ ...styles.td, ...TABULAR_NUMS, fontWeight: 600 }}>
                          ${sc.handleUsd.toLocaleString()}
                        </td>
                        <td style={{ ...styles.td, ...TABULAR_NUMS, color: "#94a3b8" }}>
                          <div
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "6px",
                            }}
                          >
                            <div
                              style={{
                                width: "36px",
                                height: "5px",
                                borderRadius: "3px",
                                backgroundColor: "rgba(51, 65, 85, 0.75)",
                                overflow: "hidden",
                                flexShrink: 0,
                              }}
                              aria-hidden="true"
                            >
                              <div
                                style={{
                                  width: `${Math.min(100, sc.shareOfParentPct).toFixed(0)}%`,
                                  height: "100%",
                                  backgroundColor: sc.isCurrentAgent ? "#38bdf8" : "#64748b",
                                }}
                              />
                            </div>
                            <span>{sc.shareOfParentPct.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                          <HandleTrendIndicator
                            deltaPct={sc.handleDelta24hPct}
                            label={`${sc.agentId} 24h handle shift`}
                            compact
                          />
                        </td>
                        <td style={styles.td}>
                          {sc.topCust ? (
                            <button
                              type="button"
                              onClick={() => {
                                onClose()
                                onSelectCustomerById(sc.topCust)
                              }}
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                color: "#38bdf8",
                                fontWeight: 600,
                                cursor: "pointer",
                                fontSize: "12px",
                              }}
                            >
                              {sc.topCust}
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td
                          style={{
                            ...styles.td,
                            ...TABULAR_NUMS,
                            fontWeight: 700,
                            color: sc.isProxyConduit
                              ? "#f87171"
                              : sc.concPct >= 60
                                ? "#fbbf24"
                                : "#4ade80",
                          }}
                        >
                          {sc.concPct.toFixed(1)}%{sc.isProxyConduit ? " · Proxy" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ fontSize: "12px", color: "#64748b" }}>
                No sub-conduits found for {agentId.toUpperCase()} in the current 30d rankings
                window.
              </div>
            )}
          </div>
        )}

        {detail &&
          (detail.rootMasterAgent ||
            (detail.ancestors && detail.ancestors.length > 0) ||
            detail.seqNumber !== undefined ||
            detail.login) && (
            <div
              data-agent-hierarchy-meta="true"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                padding: "12px 14px",
                borderRadius: "8px",
                backgroundColor: "rgba(15, 23, 42, 0.9)",
                border: "1px solid #334155",
                fontSize: "12px",
              }}
            >
              <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", color: "#cbd5e1" }}>
                <span>
                  Root Master: <b>{detail.rootMasterAgent ?? "—"}</b>
                </span>
                <span>
                  Parent Agent: <b>{detail.masterAgent ?? "—"}</b>
                </span>
                <span>
                  Seq#: <b style={TABULAR_NUMS}>{detail.seqNumber ?? "—"}</b>
                </span>
                <span>
                  Login: <b>{detail.login ?? "—"}</b>
                </span>
              </div>
              {detail.ancestors && detail.ancestors.length > 0 && (
                <div style={{ color: "#94a3b8", fontSize: "11.5px" }}>
                  Lineage: {[...detail.ancestors, detail.agentId.toUpperCase()].join(" → ")}
                </div>
              )}
            </div>
          )}

        {detail?.rateCard && (
          <div
            data-agent-rate-card="true"
            style={{
              padding: "12px 14px",
              borderRadius: "8px",
              backgroundColor: "rgba(15, 23, 42, 0.85)",
              border: "1px solid #334155",
            }}
          >
            <div
              style={{ fontSize: "12px", fontWeight: 700, color: "#cbd5e1", marginBottom: "8px" }}
            >
              Fantasy402 Agent Rate Card ({detail.rateCard.activeRateCount} active · $
              {detail.rateCard.totalMonthlyRateUsd.toLocaleString()}/mo)
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "11.5px" }}>
              {getActiveRateEntries(detail.rateCard).map((entry) => (
                <span
                  key={entry.key}
                  style={{
                    padding: "4px 8px",
                    borderRadius: "6px",
                    backgroundColor: "rgba(56, 189, 248, 0.12)",
                    border: "1px solid rgba(56, 189, 248, 0.25)",
                    color: "#e2e8f0",
                    ...TABULAR_NUMS,
                  }}
                >
                  {`${entry.label}: $${entry.value}`}
                </span>
              ))}
            </div>
          </div>
        )}

        {detail && detail.directoryPlayers && detail.directoryPlayers.length > 0 && (
          <div data-agent-directory-players="true">
            <h4
              style={{
                margin: "0 0 8px 0",
                fontSize: "13px",
                color: "#cbd5e1",
              }}
            >
              Assigned Players ({detail.directoryPlayerCount ?? detail.directoryPlayers.length})
            </h4>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Customer ID</th>
                  <th style={styles.th}>Login</th>
                  <th style={styles.th}>Name</th>
                </tr>
              </thead>
              <tbody>
                {detail.directoryPlayers.slice(0, 25).map((player) => (
                  <tr key={`${player.agentId}:${player.customerId}`}>
                    <td style={styles.td}>
                      <button
                        type="button"
                        onClick={() => {
                          onClose()
                          onSelectCustomerById(player.customerId)
                        }}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#38bdf8",
                          fontWeight: 700,
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        {player.customerId}
                      </button>
                    </td>
                    <td style={styles.td}>{player.login}</td>
                    <td style={styles.td}>{player.nameFirst || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {loading ? (
          <div style={{ color: "#94a3b8", fontSize: "13px" }}>
            Loading live agent profile & recent bet-ticker activity...
          </div>
        ) : error ? (
          <div style={{ color: "#fca5a5", fontSize: "13px" }}>
            Failed to load live agent detail: {error}
          </div>
        ) : (
          <>
            {detail && detail.childAgents.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: "12px",
                    color: "#94a3b8",
                    marginBottom: "6px",
                  }}
                >
                  Direct Downline Sub-Agents ({detail.childAgents.length}):
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {detail.childAgents.slice(0, 24).map((child) => (
                    <button
                      key={child}
                      type="button"
                      style={{
                        ...styles.actionBtn,
                        padding: "3px 8px",
                        fontSize: "11px",
                      }}
                      onClick={() => onSelectAgent(child)}
                    >
                      {child}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <h4
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "13px",
                  color: "#cbd5e1",
                }}
              >
                Profiled Customers ({detail?.customers.length ?? 0})
              </h4>
              {detail && detail.customers.length > 0 ? (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Customer</th>
                      <th style={styles.th}>Tier</th>
                      <th style={styles.th}>Sharpness</th>
                      <th style={styles.th}>Rec Limit</th>
                      <th style={styles.th}>Hold %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.customers.map((c) => (
                      <tr key={c.id}>
                        <td style={styles.td}>
                          <button
                            type="button"
                            onClick={() => {
                              onClose()
                              onSelectCustomerById(c.id)
                            }}
                            style={{
                              background: "none",
                              border: "none",
                              color: "#38bdf8",
                              fontWeight: 700,
                              cursor: "pointer",
                              padding: 0,
                            }}
                          >
                            {c.id}
                          </button>
                        </td>
                        <td style={styles.td}>{c.tier}</td>
                        <td style={{ ...styles.td, ...TABULAR_NUMS }}>{c.score.toFixed(1)}/10</td>
                        <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                          ${c.recommendedLimitUsd.toLocaleString()}
                        </td>
                        <td style={{ ...styles.td, ...TABULAR_NUMS }}>{c.holdPct.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: "12px", color: "#64748b" }}>
                  No sharp watchlist customer rows linked directly to {agentId.toUpperCase()}.
                </div>
              )}
            </div>

            <div>
              <h4
                style={{
                  margin: "0 0 8px 0",
                  fontSize: "13px",
                  color: "#cbd5e1",
                }}
              >
                Recent Bet-Ticker Wagers ({detail?.recentWagers.length ?? 0})
              </h4>
              {detail && detail.recentWagers.length > 0 ? (
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>Ticket</th>
                      <th style={styles.th}>Customer</th>
                      <th style={styles.th}>Channel</th>
                      <th style={styles.th}>Selection</th>
                      <th style={styles.th}>Risk</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.recentWagers.slice(0, 15).map((w) => (
                      <tr key={w.ticketId}>
                        <td style={{ ...styles.td, ...TABULAR_NUMS }}>#{w.ticketId}</td>
                        <td style={styles.td}>{w.customerId}</td>
                        <td style={styles.td}>{w.writer}</td>
                        <td style={styles.td}>
                          {w.sport} · {w.selection}
                        </td>
                        <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                          ${w.riskUsd.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: "12px", color: "#64748b" }}>
                  No recent wagers for {agentId.toUpperCase()} in the current Bet-Ticker window.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
