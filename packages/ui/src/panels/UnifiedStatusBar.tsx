/**
 * @file packages/ui/src/panels/UnifiedStatusBar.tsx
 * @description Unified Bloomberg-terminal persistent operational status bar using
 * strict `sd-` BEM classes, `data-status`/`data-severity`/`data-type` attributes,
 * tabular numerals (`.sd-tabular`), actionable re-auth/navigation CTAs, and pulse
 * animation strictly on critical/offline telemetry items.
 */
import { AlertTriangle, ExternalLink, Radio, RefreshCw, ShieldCheck } from "lucide-react"
import type React from "react"

import { buildFantasy402PortalEntryUrl, FANTASY402_PORTAL_WINDOW_TARGET } from "../portal_link.ts"
import { formatRiskCompactUsd } from "../risk_exposure_series.ts"
import type { RiskThresholdEvaluation } from "../risk_threshold_alert.ts"
import type { HealthData, R2PipelineApiResponse, TelemetryRefreshSnapshot } from "../types.ts"

export type StatusBarState = "healthy" | "warning" | "critical" | "stale" | "offline" | "dead"

export interface StatusTimeInfo {
  readonly clock: string
  readonly relative: string
  readonly summary: string
}

export interface UnifiedStatusBarProps {
  readonly daemonState: "online" | "degraded" | "offline" | "probing" | "unconfigured"
  readonly daemonLatencyMs: number | null
  readonly daemonReason?: string | null | undefined
  readonly daemonUpdateInfo: StatusTimeInfo
  readonly daemonProbeInfo: StatusTimeInfo
  readonly daemonHasSuccess: boolean
  readonly daemonHasProbe: boolean
  readonly r2PipelineData: R2PipelineApiResponse | null
  readonly r2UpdateInfo: StatusTimeInfo
  readonly wsConnected: boolean
  readonly wsLatencyMs: number | null
  readonly wsJitterMs: number | null
  readonly wsLastPongAt: string | number | null
  readonly healthData: HealthData | null
  readonly healthLastUpdatedAt: string | number | null
  readonly healthUpdateInfo: StatusTimeInfo
  readonly systemHealthStatusText: string
  readonly systemHealthLabel: string
  readonly degradedReasonSummary?: string | null | undefined
  readonly riskThresholdEvaluation: RiskThresholdEvaluation
  readonly portalBannerActive: boolean
  readonly telemetryRefreshing: boolean
  readonly telemetryRefreshSnapshot: TelemetryRefreshSnapshot
  readonly refreshLabel?: string | undefined
  readonly liveWagerCount: number
  readonly sharpWagerCount: number
  readonly tickerOverlayOpen: boolean
  readonly onToggleTickerOverlay: () => void
  readonly onOpenR2: () => void
  readonly onOpenStatus: () => void
  readonly onOpenRiskOverview: () => void
  readonly onOpenShiftHandoff: () => void
  readonly onRefreshAll: () => void
}

function resolveDaemonStatus(daemonState: UnifiedStatusBarProps["daemonState"]): StatusBarState {
  if (daemonState === "online") return "healthy"
  if (daemonState === "degraded") return "warning"
  if (daemonState === "offline") return "offline"
  return "stale"
}

function resolveR2Status(data: R2PipelineApiResponse | null): StatusBarState {
  if (!data) return "stale"
  if (data.overallStatus === "fresh") return "healthy"
  if (data.overallStatus === "stale") return "stale"
  return "critical"
}

function resolveWsStatus(
  connected: boolean,
  latencyMs: number | null,
  jitterMs: number | null,
): StatusBarState {
  if (!connected) return "offline"
  if (latencyMs !== null && (latencyMs > 200 || (jitterMs ?? 0) > 60)) return "critical"
  if (latencyMs !== null && (latencyMs > 80 || (jitterMs ?? 0) > 25)) return "warning"
  return "healthy"
}

function resolveHealthStatus(healthData: HealthData | null, statusText: string): StatusBarState {
  const upper = statusText.toUpperCase()
  if ((healthData?.alerts?.dead ?? 0) > 0 || upper.includes("FAIL") || upper.includes("CRIT")) {
    return "dead"
  }
  if (
    upper.includes("DEGRADED") ||
    upper.includes("WARN") ||
    (healthData?.alerts?.backlog ?? 0) > 5
  ) {
    return "warning"
  }
  return "healthy"
}

function resolveRiskStatus(evalState: RiskThresholdEvaluation["status"]): StatusBarState {
  if (evalState === "breach") return "critical"
  if (evalState === "warn") return "warning"
  return "healthy"
}

function isCriticalPulse(status: StatusBarState): boolean {
  return status === "critical" || status === "offline" || status === "dead"
}

function formatProbeClock(ts: string | number | null | undefined): string {
  if (!ts) return "—"
  const parsed = typeof ts === "number" ? ts : Date.parse(ts)
  if (Number.isNaN(parsed)) return "—"
  try {
    return new Date(parsed).toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    return "—"
  }
}

export function UnifiedStatusBar({
  daemonState,
  daemonLatencyMs,
  daemonReason,
  daemonUpdateInfo,
  daemonProbeInfo,
  daemonHasSuccess,
  daemonHasProbe,
  r2PipelineData,
  r2UpdateInfo,
  wsConnected,
  wsLatencyMs,
  wsJitterMs,
  wsLastPongAt,
  healthData,
  healthLastUpdatedAt,
  healthUpdateInfo,
  systemHealthStatusText,
  systemHealthLabel,
  degradedReasonSummary,
  riskThresholdEvaluation,
  portalBannerActive,
  telemetryRefreshing,
  telemetryRefreshSnapshot,
  refreshLabel = "Refresh All",
  liveWagerCount,
  sharpWagerCount,
  tickerOverlayOpen,
  onToggleTickerOverlay,
  onOpenR2,
  onOpenStatus,
  onOpenRiskOverview,
  onOpenShiftHandoff,
  onRefreshAll,
}: UnifiedStatusBarProps): React.ReactElement {
  const apiStatus = resolveDaemonStatus(daemonState)
  const r2Status = resolveR2Status(r2PipelineData)
  const wsStatus = resolveWsStatus(wsConnected, wsLatencyMs, wsJitterMs)
  const healthStatus = resolveHealthStatus(healthData, systemHealthStatusText)
  const riskStatus = resolveRiskStatus(riskThresholdEvaluation.status)
  const portalStatus: StatusBarState = portalBannerActive ? "warning" : "healthy"

  const lastProbeClock = formatProbeClock(telemetryRefreshSnapshot.lastProbedAt)

  return (
    <div className="sd-status-bar" role="region" aria-label="Unified operational status bar">
      <div className="sd-status-bar__group">
        {/* 1. API / Daemon :4020 */}
        <span className="sd-status-tip-wrap">
          <button
            type="button"
            onClick={onOpenStatus}
            className={`sd-status-bar__item sd-status-bar__item--api sd-status-bar__item--${apiStatus}${
              isCriticalPulse(apiStatus) ? " sd-status-bar__item--pulse" : ""
            }`}
            data-status={apiStatus}
            data-severity={isCriticalPulse(apiStatus) ? "critical" : apiStatus}
            data-type="api"
            title={`API Daemon :4020 (${daemonState}) — click to inspect status`}
          >
            <span className="sd-status-bar__dot" aria-hidden="true" />
            <span className="sd-status-bar__label">
              {daemonState === "online"
                ? "API Online"
                : daemonState === "degraded"
                  ? "API Degraded"
                  : daemonState === "offline"
                    ? "API Offline"
                    : "API Probing"}
            </span>
            {daemonLatencyMs !== null &&
              (daemonState === "online" || daemonState === "degraded") && (
                <span className="sd-status-bar__metric sd-tabular">{daemonLatencyMs}ms</span>
              )}
          </button>
          <span role="tooltip" className="sd-status-tip-popover">
            <span className="sd-status-tip-title">
              <span>Daemon :4020 API</span>
              <span>{daemonState.toUpperCase()}</span>
            </span>
            <span className="sd-status-tip-row">
              <span className="sd-status-tip-label">Last success</span>
              <span className="sd-status-tip-value sd-tabular">{daemonUpdateInfo.clock}</span>
            </span>
            <span className="sd-status-tip-meta">
              {daemonHasSuccess
                ? `Updated ${daemonUpdateInfo.relative}${
                    daemonLatencyMs !== null ? ` · RTT ${daemonLatencyMs}ms` : ""
                  }`
                : daemonHasProbe
                  ? `No response yet · Probed ${daemonProbeInfo.clock} (${daemonProbeInfo.relative})`
                  : "Awaiting initial :4020 probe"}
            </span>
            {daemonState === "offline" && daemonReason ? (
              <span className="sd-status-tip-meta sd-status-tip-meta--warn">{daemonReason}</span>
            ) : null}
          </span>
        </span>

        {/* 2. R2 Pipeline Freshness & Age */}
        <span className="sd-status-tip-wrap">
          <button
            type="button"
            onClick={onOpenR2}
            className={`sd-status-bar__item sd-status-bar__item--r2 sd-status-bar__item--${r2Status}${
              isCriticalPulse(r2Status) ? " sd-status-bar__item--pulse" : ""
            }`}
            data-status={r2Status}
            data-severity={r2Status === "critical" ? "critical" : r2Status}
            data-type="r2"
            title={`Open R2 Pipeline Monitor · Last update: ${r2UpdateInfo.summary}`}
          >
            <span className="sd-status-bar__dot" aria-hidden="true" />
            <span className="sd-status-bar__label">
              {r2PipelineData
                ? `R2 ${r2PipelineData.freshCount}/${r2PipelineData.totalCount} ${
                    r2PipelineData.overallStatus === "fresh" ? "Fresh" : "Stale"
                  }`
                : "R2 Probing"}
            </span>
            <span className="sd-status-bar__metric sd-tabular">{r2UpdateInfo.relative}</span>
          </button>
          <span role="tooltip" className="sd-status-tip-popover">
            <span className="sd-status-tip-title">
              <span>R2 Pipeline</span>
              <span>{(r2PipelineData?.overallStatus ?? "probing").toUpperCase()}</span>
            </span>
            <span className="sd-status-tip-row">
              <span className="sd-status-tip-label">Last success</span>
              <span className="sd-status-tip-value sd-tabular">{r2UpdateInfo.clock}</span>
            </span>
            <span className="sd-status-tip-meta">
              {r2PipelineData
                ? `${r2PipelineData.freshCount}/${r2PipelineData.totalCount} sinks fresh · Click to inspect`
                : "Awaiting first R2 pipeline snapshot"}
            </span>
          </span>
        </span>

        {/* 3. Hot-Reload / WebSocket Stream & Latency */}
        <span className="sd-status-tip-wrap">
          <span
            tabIndex={0}
            data-ws-status-pill="true"
            className={`sd-status-bar__item sd-status-bar__item--ws sd-status-bar__item--${wsStatus}${
              isCriticalPulse(wsStatus) ? " sd-status-bar__item--pulse" : ""
            }`}
            data-status={wsStatus}
            data-severity={isCriticalPulse(wsStatus) ? "critical" : wsStatus}
            data-type="ws"
            title={
              wsConnected
                ? wsLatencyMs !== null
                  ? `WebSocket stream live · RTT ${wsLatencyMs}ms · Jitter ±${wsJitterMs ?? 0}ms`
                  : "WebSocket stream connected · Measuring latency…"
                : "WebSocket stream disconnected"
            }
          >
            <span className="sd-status-bar__dot" aria-hidden="true" />
            <span className="sd-status-bar__label">{wsConnected ? "WS Live" : "WS Offline"}</span>
            {wsConnected ? (
              <span data-ws-latency-indicator="true" className="sd-status-bar__metric sd-tabular">
                {wsLatencyMs !== null ? `${wsLatencyMs}ms ±${wsJitterMs ?? 0}` : "probing"}
              </span>
            ) : null}
          </span>
          <span role="tooltip" className="sd-status-tip-popover">
            <span className="sd-status-tip-title">
              <span>Hot-Reload WebSocket</span>
              <span>{wsConnected ? "LIVE" : "OFFLINE"}</span>
            </span>
            <span className="sd-status-tip-row">
              <span className="sd-status-tip-label">RTT Latency</span>
              <span className="sd-status-tip-value sd-tabular">
                {wsConnected && wsLatencyMs !== null ? `${wsLatencyMs} ms` : "—"}
              </span>
            </span>
            <span className="sd-status-tip-row">
              <span className="sd-status-tip-label">Stream Jitter</span>
              <span className="sd-status-tip-value sd-tabular">
                {wsConnected && wsJitterMs !== null ? `±${wsJitterMs} ms` : "—"}
              </span>
            </span>
            <span className="sd-status-tip-meta">
              {wsConnected && wsLastPongAt
                ? `Last pong ${formatProbeClock(wsLastPongAt)} · 5s heartbeat`
                : "Reconnecting to /ws stream"}
            </span>
          </span>
        </span>

        {/* 4. Alert Queue / DLQ Health */}
        <span className="sd-status-tip-wrap">
          <button
            type="button"
            onClick={onOpenShiftHandoff}
            className={`sd-status-bar__item sd-status-bar__item--health sd-status-bar__item--${healthStatus}${
              isCriticalPulse(healthStatus) ? " sd-status-bar__item--pulse" : ""
            }`}
            data-status={healthStatus}
            data-severity={healthStatus === "dead" ? "critical" : healthStatus}
            data-type="health"
            title={
              degradedReasonSummary
                ? `Health probe: ${degradedReasonSummary} · Click for Shift Handoff`
                : `Alert Health · Last update: ${healthUpdateInfo.summary} · Click for Shift Handoff`
            }
          >
            <span className="sd-status-bar__dot" aria-hidden="true" />
            <span className="sd-status-bar__label">{systemHealthLabel}</span>
            {healthData?.alerts ? (
              <span className="sd-status-bar__metric sd-tabular">
                DLQ:{healthData.alerts.dead} · Q:{healthData.alerts.backlog}
              </span>
            ) : null}
          </button>
          <span role="tooltip" className="sd-status-tip-popover sd-status-tip-popover--right">
            <span className="sd-status-tip-title">
              <span>Health Probe</span>
              <span>{systemHealthStatusText}</span>
            </span>
            <span className="sd-status-tip-row">
              <span className="sd-status-tip-label">Last success</span>
              <span className="sd-status-tip-value sd-tabular">{healthUpdateInfo.clock}</span>
            </span>
            <span className="sd-status-tip-meta">
              {healthLastUpdatedAt
                ? `Updated ${healthUpdateInfo.relative}${
                    typeof healthData?.uptimeSeconds === "number"
                      ? ` · Uptime ${Math.floor(healthData.uptimeSeconds)}s`
                      : ""
                  }`
                : "Awaiting first /health response"}
            </span>
            {degradedReasonSummary ? (
              <span className="sd-status-tip-meta sd-status-tip-meta--warn">
                {degradedReasonSummary}
              </span>
            ) : null}
          </span>
        </span>

        {/* 5. 60m Aggregate Risk Exposure Threshold */}
        <span className="sd-status-tip-wrap">
          <button
            type="button"
            data-risk-threshold-indicator="true"
            data-risk-threshold-status={riskThresholdEvaluation.status}
            aria-live="polite"
            onClick={onOpenRiskOverview}
            className={`sd-status-bar__item sd-status-bar__item--risk sd-status-bar__item--${riskStatus}${
              riskThresholdEvaluation.isBreached ? " sd-status-bar__item--pulse" : ""
            }`}
            data-status={riskStatus}
            data-severity={riskStatus}
            data-type="risk"
            title={`60m aggregate risk: ${formatRiskCompactUsd(riskThresholdEvaluation.totalRiskUsd)} / ${formatRiskCompactUsd(riskThresholdEvaluation.limitUsd)}`}
          >
            {riskThresholdEvaluation.isBreached || riskThresholdEvaluation.isWarning ? (
              <AlertTriangle size={12} aria-hidden="true" />
            ) : (
              <ShieldCheck size={12} aria-hidden="true" />
            )}
            <span className="sd-status-bar__label">
              {riskThresholdEvaluation.status === "breach"
                ? "60m Risk Breach"
                : riskThresholdEvaluation.status === "warn"
                  ? "60m Risk High"
                  : "60m Risk"}
            </span>
            <span className="sd-status-bar__metric sd-tabular">
              {riskThresholdEvaluation.status === "idle"
                ? formatRiskCompactUsd(riskThresholdEvaluation.limitUsd)
                : `${formatRiskCompactUsd(riskThresholdEvaluation.totalRiskUsd)}/${formatRiskCompactUsd(riskThresholdEvaluation.limitUsd)}`}
            </span>
          </button>
          <span role="tooltip" className="sd-status-tip-popover sd-status-tip-popover--right">
            <span className="sd-status-tip-title">
              <span>60m Risk Exposure</span>
              <span>{riskThresholdEvaluation.status.toUpperCase()}</span>
            </span>
            <span className="sd-status-tip-row">
              <span className="sd-status-tip-label">Exposure</span>
              <span className="sd-status-tip-value sd-tabular">
                ${Math.round(riskThresholdEvaluation.totalRiskUsd).toLocaleString()}
              </span>
            </span>
            <span className="sd-status-tip-row">
              <span className="sd-status-tip-label">Breach Cap</span>
              <span className="sd-status-tip-value sd-tabular">
                ${riskThresholdEvaluation.limitUsd.toLocaleString()}
              </span>
            </span>
            <span className="sd-status-tip-meta">Click to inspect 60m chart &amp; limits</span>
          </span>
        </span>

        {/* 6. Portal Session Re-Auth CTA */}
        <a
          href={buildFantasy402PortalEntryUrl()}
          target={FANTASY402_PORTAL_WINDOW_TARGET}
          rel="noopener noreferrer"
          className={`sd-status-bar__item sd-status-bar__item--portal sd-status-bar__item--${portalStatus}`}
          data-status={portalStatus}
          data-severity={portalStatus}
          data-type="portal"
          title="Re-authenticate or resume Fantasy402 Manager session tab"
        >
          <span className="sd-status-bar__dot" aria-hidden="true" />
          <span className="sd-status-bar__label">
            {portalBannerActive ? "Portal Re-Auth" : "Portal Ready"}
          </span>
          <ExternalLink size={11} aria-hidden="true" />
        </a>
      </div>

      {/* Right Control Cluster: Dockable Ticker Toggle, Last Probe, Refresh All */}
      <div className="sd-status-bar__controls">
        <button
          type="button"
          onClick={onToggleTickerOverlay}
          aria-pressed={tickerOverlayOpen}
          className={`sd-status-bar__item sd-status-bar__item--ticker${
            tickerOverlayOpen ? " sd-status-bar__item--selected" : ""
          }${sharpWagerCount > 0 ? " sd-status-bar__item--warning" : ""}`}
          data-status={sharpWagerCount > 0 ? "warning" : "healthy"}
          data-type="ticker"
          title="Toggle dockable Live Wager Ticker overlay while staying in your current tab"
        >
          <Radio size={12} aria-hidden="true" />
          <span className="sd-status-bar__label">Live Ticker</span>
          <span className="sd-status-bar__metric sd-tabular">
            {liveWagerCount}
            {sharpWagerCount > 0 ? ` · ${sharpWagerCount}⚡` : ""}
          </span>
        </button>

        <span
          className="sd-status-bar__probe sd-tabular"
          title="Last full telemetry probe timestamp and duration"
        >
          Probe {lastProbeClock}
          {telemetryRefreshSnapshot.lastProbeMs !== null
            ? ` (${telemetryRefreshSnapshot.lastProbeMs}ms)`
            : ""}
        </span>

        <button
          type="button"
          className="sd-action-btn sd-action-btn--primary sd-refresh-telemetry-btn"
          onClick={onRefreshAll}
          disabled={telemetryRefreshing}
          aria-label={refreshLabel}
          title="Force immediate probe of :4020 API, R2 pipeline, health & profiles"
        >
          <RefreshCw
            size={11}
            aria-hidden="true"
            className={telemetryRefreshing ? "sd-spin" : undefined}
          />
          <span>{telemetryRefreshing ? "Probing…" : "Refresh All"}</span>
        </button>
      </div>
    </div>
  )
}
