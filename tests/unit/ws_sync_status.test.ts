import { describe, expect, test } from "bun:test"

import {
  evaluateWsSyncStatus,
  formatHeartbeatElapsed,
  parseHeartbeatTimestampMs,
} from "../../packages/ui/src/ws_sync_status.ts"

describe("WebSocket heartbeat Sync Status evaluator", () => {
  test("formats exact elapsed seconds, minutes, and hours deterministically", () => {
    expect(formatHeartbeatElapsed(null)).toBe("—")
    expect(formatHeartbeatElapsed(0)).toBe("0s")
    expect(formatHeartbeatElapsed(999)).toBe("0s")
    expect(formatHeartbeatElapsed(4_200)).toBe("4s")
    expect(formatHeartbeatElapsed(59_999)).toBe("59s")
    expect(formatHeartbeatElapsed(64_000)).toBe("1m 04s")
    expect(formatHeartbeatElapsed(3_729_000)).toBe("1h 02m 09s")
    expect(formatHeartbeatElapsed(-500)).toBe("0s")
  })

  test("parses ISO timestamps and epoch milliseconds safely", () => {
    const iso = "2026-11-21T23:45:00.000Z"
    const expectedMs = Date.parse(iso)
    expect(parseHeartbeatTimestampMs(iso)).toBe(expectedMs)
    expect(parseHeartbeatTimestampMs(expectedMs)).toBe(expectedMs)
    expect(parseHeartbeatTimestampMs("")).toBeNull()
    expect(parseHeartbeatTimestampMs("not-a-date")).toBeNull()
    expect(parseHeartbeatTimestampMs(null)).toBeNull()
  })

  test("classifies stable, delayed, stale, connecting, and offline states against 5s heartbeat cadence", () => {
    const baseMs = Date.parse("2026-11-21T23:45:00.000Z")

    const stable = evaluateWsSyncStatus({
      wsConnected: true,
      lastHeartbeatAt: new Date(baseMs).toISOString(),
      nowMs: baseMs + 3_400,
      latencyMs: 18,
    })
    expect(stable.state).toBe("stable")
    expect(stable.statusLabel).toBe("Stable")
    expect(stable.elapsedLabel).toBe("3s")
    expect(stable.tooltip).toContain("RTT 18ms")
    expect(stable.ariaLabel).toBe("Sync Status: Stable, 3s since last WebSocket heartbeat")

    const delayed = evaluateWsSyncStatus({
      wsConnected: true,
      lastHeartbeatAt: baseMs,
      nowMs: baseMs + 11_000,
    })
    expect(delayed.state).toBe("delayed")
    expect(delayed.statusLabel).toBe("Delayed")
    expect(delayed.elapsedLabel).toBe("11s")

    const stale = evaluateWsSyncStatus({
      wsConnected: true,
      lastHeartbeatAt: baseMs,
      nowMs: baseMs + 22_000,
    })
    expect(stale.state).toBe("stale")
    expect(stale.statusLabel).toBe("Stale")
    expect(stale.elapsedLabel).toBe("22s")

    const connecting = evaluateWsSyncStatus({
      wsConnected: true,
      lastHeartbeatAt: null,
      nowMs: baseMs,
    })
    expect(connecting.state).toBe("connecting")
    expect(connecting.statusLabel).toBe("Awaiting")
    expect(connecting.elapsedMs).toBeNull()
    expect(connecting.elapsedLabel).toBe("—")

    const offline = evaluateWsSyncStatus({
      wsConnected: false,
      lastHeartbeatAt: baseMs,
      nowMs: baseMs + 65_000,
    })
    expect(offline.state).toBe("offline")
    expect(offline.statusLabel).toBe("Offline")
    expect(offline.elapsedLabel).toBe("1m 05s")
  })
})
