/**
 * Pure WebSocket heartbeat sync-status evaluation and exact elapsed-time formatter.
 *
 * Evaluates stream stability against the 5-second WebSocket ping/pong heartbeat cadence
 * so operators get immediate, deterministic feedback without layout jitter.
 */

export type WsSyncStabilityState = "stable" | "delayed" | "stale" | "connecting" | "offline"

export interface WsSyncStatusInput {
  readonly wsConnected: boolean
  readonly lastHeartbeatAt: string | number | null | undefined
  readonly nowMs?: number | undefined
  readonly latencyMs?: number | null | undefined
  readonly heartbeatIntervalMs?: number | undefined
}

export interface WsSyncStatusView {
  readonly state: WsSyncStabilityState
  readonly statusLabel: string
  readonly elapsedMs: number | null
  readonly elapsedLabel: string
  readonly lastHeartbeatClock: string | null
  readonly ariaLabel: string
  readonly tooltip: string
}

export const DEFAULT_WS_HEARTBEAT_INTERVAL_MS = 5_000

/** Parse an ISO timestamp or epoch milliseconds into a finite epoch millisecond value. */
export function parseHeartbeatTimestampMs(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null
  }
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * Format exact elapsed duration since the last WebSocket heartbeat.
 * Examples: `0s`, `4s`, `59s`, `1m 04s`, `1h 02m 09s`.
 */
export function formatHeartbeatElapsed(elapsedMs: number | null): string {
  if (elapsedMs === null || !Number.isFinite(elapsedMs)) return "—"
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000))
  if (totalSec < 60) {
    return `${totalSec}s`
  }
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

/**
 * Compute deterministic stream stability state and human-readable telemetry labels
 * from the WebSocket connection flag and last received pong heartbeat timestamp.
 */
export function evaluateWsSyncStatus(input: WsSyncStatusInput): WsSyncStatusView {
  const nowMs = input.nowMs ?? Date.now()
  const intervalMs = Math.max(1_000, input.heartbeatIntervalMs ?? DEFAULT_WS_HEARTBEAT_INTERVAL_MS)
  const heartbeatMs = parseHeartbeatTimestampMs(input.lastHeartbeatAt)
  const elapsedMs = heartbeatMs !== null ? Math.max(0, nowMs - heartbeatMs) : null
  const elapsedLabel = formatHeartbeatElapsed(elapsedMs)
  const lastHeartbeatClock =
    heartbeatMs !== null
      ? new Date(heartbeatMs).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      : null

  const stableLimitMs = Math.round(intervalMs * 1.6) // 8s on a 5s heartbeat cadence
  const delayedLimitMs = intervalMs * 3 // 15s (3 missed beats -> stale)

  let state: WsSyncStabilityState
  let statusLabel: string

  if (!input.wsConnected) {
    state = "offline"
    statusLabel = "Offline"
  } else if (elapsedMs === null) {
    state = "connecting"
    statusLabel = "Awaiting"
  } else if (elapsedMs <= stableLimitMs) {
    state = "stable"
    statusLabel = "Stable"
  } else if (elapsedMs <= delayedLimitMs) {
    state = "delayed"
    statusLabel = "Delayed"
  } else {
    state = "stale"
    statusLabel = "Stale"
  }

  const rttSuffix =
    input.wsConnected &&
    typeof input.latencyMs === "number" &&
    Number.isFinite(input.latencyMs) &&
    input.latencyMs >= 0
      ? ` · RTT ${Math.round(input.latencyMs)}ms`
      : ""

  const cadenceSec = Math.round(intervalMs / 1000)

  const tooltip =
    elapsedMs !== null && lastHeartbeatClock
      ? `Sync Status: ${statusLabel} · ${elapsedLabel} since last WebSocket heartbeat (${lastHeartbeatClock})${rttSuffix} · ${cadenceSec}s heartbeat cadence`
      : input.wsConnected
        ? `Sync Status: Awaiting initial WebSocket pong heartbeat (${cadenceSec}s cadence)`
        : `Sync Status: WebSocket disconnected · Awaiting stream reconnection`

  const ariaLabel =
    elapsedMs !== null
      ? `Sync Status: ${statusLabel}, ${elapsedLabel} since last WebSocket heartbeat`
      : `Sync Status: ${statusLabel}, no WebSocket heartbeat received yet`

  return {
    state,
    statusLabel,
    elapsedMs,
    elapsedLabel,
    lastHeartbeatClock,
    ariaLabel,
    tooltip,
  }
}
