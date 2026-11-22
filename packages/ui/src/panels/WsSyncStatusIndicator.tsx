import React, { useEffect, useState } from "react"
import { Activity, AlertTriangle, Clock, WifiOff } from "lucide-react"
import { evaluateWsSyncStatus } from "../ws_sync_status.ts"

export interface WsSyncStatusIndicatorProps {
  readonly wsConnected: boolean
  readonly lastHeartbeatAt: string | number | null | undefined
  readonly nowMs?: number | undefined
  readonly latencyMs?: number | null | undefined
  readonly compact?: boolean | undefined
}

/**
 * Displays live WebSocket stream stability and the exact time elapsed since the
 * last heartbeat directly beside the Refresh Telemetry control.
 */
export function WsSyncStatusIndicator({
  wsConnected,
  lastHeartbeatAt,
  nowMs,
  latencyMs = null,
  compact = false,
}: WsSyncStatusIndicatorProps): React.ReactElement {
  const [tickNowMs, setTickNowMs] = useState<number>(() => Date.now())

  useEffect(() => {
    if (nowMs !== undefined) return
    setTickNowMs(Date.now())
    const id = setInterval(() => {
      setTickNowMs(Date.now())
    }, 1000)
    return () => clearInterval(id)
  }, [nowMs, lastHeartbeatAt, wsConnected])

  const view = evaluateWsSyncStatus({
    wsConnected,
    lastHeartbeatAt,
    nowMs: nowMs ?? tickNowMs,
    latencyMs,
  })

  const icon =
    view.state === "offline" ? (
      <WifiOff size={11} className="sd-sync-status-icon" aria-hidden="true" />
    ) : view.state === "stale" || view.state === "delayed" ? (
      <AlertTriangle size={11} className="sd-sync-status-icon" aria-hidden="true" />
    ) : view.state === "connecting" ? (
      <Clock size={11} className="sd-sync-status-icon" aria-hidden="true" />
    ) : (
      <Activity size={11} className="sd-sync-status-icon" aria-hidden="true" />
    )

  return (
    <span
      role="status"
      aria-label={view.ariaLabel}
      title={view.tooltip}
      data-sync-status={view.state}
      data-sync-elapsed={view.elapsedLabel}
      className={`sd-sync-status sd-sync-status--${view.state}${compact ? " sd-sync-status--compact" : ""}`}
    >
      {icon}
      <span className="sd-sync-status-kicker">Sync Status</span>
      <span className="sd-sync-status-sep" aria-hidden="true">
        ·
      </span>
      <span className="sd-sync-status-state">{view.statusLabel}</span>
      <span className="sd-sync-status-sep" aria-hidden="true">
        ·
      </span>
      <span className="sd-sync-status-elapsed">
        {view.elapsedMs !== null ? `${view.elapsedLabel} ago` : "no beat"}
      </span>
    </span>
  )
}
