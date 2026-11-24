import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  createDashboardApi,
  createShiftSessionLogStore,
  type ShiftSessionLogsResponse,
} from "../../packages/api/src/index.ts"
import { ShiftHandoffModal } from "../../packages/ui/src/panels/ShiftHandoffModal.tsx"
import type { ShiftSessionLogEntry } from "../../packages/ui/src/types.ts"

function buildTestApi(options: { authenticated?: boolean } = {}) {
  const authenticated = options.authenticated ?? true
  const shiftLogs = createShiftSessionLogStore(50)

  return createDashboardApi({
    enforceAuth: authenticated
      ? () => null
      : () =>
          Response.json(
            { error: "Authentication required", code: "UNAUTHENTICATED" },
            { status: 401, headers: { "Cache-Control": "no-store" } },
          ),
    shiftLogs,
    auth: {
      login: async (req) => {
        const body = (await req.json().catch(() => ({}))) as {
          operatorId?: string
        }
        return Response.json(
          {
            ok: true,
            operatorId: body.operatorId ?? "risk_lead_01",
            role: "OPERATOR",
            token: "secret-session-token-must-not-be-logged",
          },
          { status: 200, headers: { "Cache-Control": "no-store" } },
        )
      },
      logout: async () => Response.json({ ok: true }),
      me: async () => Response.json({ authenticated }),
    },
    getHealthPayload: () => ({ status: "ok" }),
    loadDashboardMarkdown: async () => ({
      stamp: "1",
      markdown: "# Desk",
      html: "<h1>Desk</h1>",
    }),
    dns: {
      getTelemetryPayload: () => ({ success: true }),
      benchmark: async (host) => ({ host }),
      classifyIp: async (ip) => ({ ip }),
    },
    customers: {
      getCohortReport: async () => ({ versionStamp: "1", payload: {} }),
      getProfile: async () => null,
      getRating: async () => null,
    },
    execTerminal: async () => ({}),
    rankings: {
      getAll: async () => ({
        generatedAtIso: "2026-11-20T17:00:00Z",
        payload: {},
      }),
      getConduits: async () => [],
    },
    getLiveWagersPayload: async () => ({ wagers: [] }),
    getTiersConfig: async () => ({ tiers: {} }),
    alerts: {
      sweepOnce: async () => ({ sent: 2, failed: 0, dead: 1 }),
      list: () => [],
      ack: async () => true,
      retry: async () => "dlq-replay-998877",
      getShiftSummary: (operatorId) => ({
        date: "2026-11-20",
        operatorId,
        totalAlerts: 4,
        deliveredAlerts: 3,
        failedAttempts: 0,
        deadLetterAlerts: 0,
        acknowledgedAlerts: 2,
        terminalCommandsCount: 1,
        loginEventsCount: 1,
      }),
    },
    getTaxonomyCatalog: () => [],
    runShadowPricing: async () => ({}),
    getBuildMatrix: async () => ({ targets: [], generatedAt: "" }),
  })
}

describe("Shift Session Logs API (/api/shift/logs)", () => {
  test("fails closed with 401 on GET and POST when unauthenticated", async () => {
    const api = buildTestApi({ authenticated: false })

    const getRes = await api.fetch(new Request("http://localhost/api/shift/logs"))
    expect(getRes.status).toBe(401)
    expect(getRes.headers.get("cache-control")).toBe("no-store")

    const postRes = await api.fetch(
      new Request("http://localhost/api/shift/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "handoff_initiated",
          operatorId: "risk_lead_01",
          summary: "Opened shift handoff",
        }),
      }),
    )
    expect(postRes.status).toBe(401)
  })

  test("validates action allowlist and sanitizes control characters on POST", async () => {
    const api = buildTestApi({ authenticated: true })

    const badActionRes = await api.fetch(
      new Request("http://localhost/api/shift/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "drop_tables",
          summary: "invalid action",
        }),
      }),
    )
    expect(badActionRes.status).toBe(400)

    const badJsonRes = await api.fetch(
      new Request("http://localhost/api/shift/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    )
    expect(badJsonRes.status).toBe(400)

    const okRes = await api.fetch(
      new Request("http://localhost/api/shift/logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "handoff_initiated",
          operatorId: "ops_lead\r\n01",
          summary: "Shift handoff opened\t\n(08:01:12 elapsed)",
          detail: "All DLQ alerts cleared\x07",
        }),
      }),
    )
    expect(okRes.status).toBe(201)
    expect(okRes.headers.get("x-sportsdesk-endpoint")).toBe("/api/shift/logs")
    expect(okRes.headers.get("cache-control")).toBe("no-store")

    const created = (await okRes.json()) as {
      ok: boolean
      entry: ShiftSessionLogEntry
    }
    expect(created.ok).toBe(true)
    expect(created.entry.action).toBe("handoff_initiated")
    expect(created.entry.operatorId).toBe("ops_lead 01")
    expect(created.entry.summary).toBe("Shift handoff opened (08:01:12 elapsed)")
    expect(created.entry.detail).toBe("All DLQ alerts cleared")
  })

  test("captures login, alert ack, alert retry, and sweep automatically without leaking tokens", async () => {
    const api = buildTestApi({ authenticated: true })

    // Record an older event before the current shift window
    api.shiftLogs.record({
      action: "handoff_synced",
      operatorId: "prior_shift_op",
      summary: "Previous shift sync",
      timestamp: Date.parse("2026-11-20T01:00:00.000Z"),
    })

    const shiftStartMs = Date.now() - 1000

    // 1. Login
    const loginRes = await api.fetch(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatorId: "maya_risk",
          passcode: "super-secret-passcode-123",
        }),
      }),
    )
    expect(loginRes.status).toBe(200)

    // 2. Alert acknowledgement
    const ackRes = await api.fetch(
      new Request("http://localhost/api/alerts/alert-55443322/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatorId: "maya_risk",
          notes: "Verified sharp steam limit drop",
        }),
      }),
    )
    expect(ackRes.status).toBe(200)

    // 3. Alert replay
    const retryRes = await api.fetch(
      new Request("http://localhost/api/alerts/dlq-11223344/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operatorId: "maya_risk" }),
      }),
    )
    expect(retryRes.status).toBe(200)

    // 4. Alert sweep
    const sweepRes = await api.fetch(
      new Request("http://localhost/api/alerts/sweep", {
        method: "POST",
        headers: { "X-Operator-Id": "maya_risk" },
      }),
    )
    expect(sweepRes.status).toBe(200)

    // Query scoped to current shift start
    const listRes = await api.fetch(new Request(`http://localhost/api/shift/logs?since=${shiftStartMs}&limit=25`))
    expect(listRes.status).toBe(200)
    expect(listRes.headers.get("x-sportsdesk-endpoint")).toBe("/api/shift/logs")
    const payload = (await listRes.json()) as ShiftSessionLogsResponse

    expect(payload.count).toBe(4)
    expect(payload.totalCaptured).toBe(5)
    const actions = payload.logs.map((entry) => entry.action)
    expect(actions).toEqual(["alert_sweep", "alert_retry", "alert_ack", "login"])

    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain("secret-session-token-must-not-be-logged")
    expect(serialized).not.toContain("super-secret-passcode-123")
    expect(serialized).not.toContain("prior_shift_op")
  })
})

describe("ShiftHandoffModal Session Logs Panel", () => {
  const sampleLogs: readonly ShiftSessionLogEntry[] = [
    {
      id: "shl-3",
      timestamp: "2026-11-20T16:12:04.000Z",
      action: "handoff_initiated",
      label: "Handoff Initiated",
      operatorId: "maya_risk",
      summary: "Shift handoff opened (08:02:14 elapsed)",
      source: "client",
    },
    {
      id: "shl-2",
      timestamp: "2026-11-20T14:40:19.000Z",
      action: "alert_ack",
      label: "Alert Acknowledged",
      operatorId: "maya_risk",
      summary: "Acknowledged alert alert-554433",
      detail: "Verified sharp steam limit drop",
      targetId: "alert-55443322",
      source: "server",
    },
    {
      id: "shl-1",
      timestamp: "2026-11-20T08:10:00.000Z",
      action: "login",
      label: "Operator Login",
      operatorId: "maya_risk",
      summary: "Operator maya_risk signed in",
      detail: "Role: OPERATOR",
      source: "server",
    },
  ]

  const baseProps = {
    shiftOperator: "maya_risk",
    onShiftOperatorChange: () => {},
    shiftLoading: false,
    onRefresh: () => {},
    shiftSummary: null,
    activeShiftSeconds: 28934,
    shiftStartedAtMs: Date.parse("2026-11-20T08:10:00.000Z"),
    onClose: () => {},
  }

  test("renders populated timestamped Session Logs feed with shift offsets", () => {
    const html = renderToStaticMarkup(
      React.createElement(ShiftHandoffModal, {
        ...baseProps,
        shiftLogs: sampleLogs,
        onRefreshShiftLogs: () => {},
      }),
    )

    expect(html).toContain('data-shift-session-logs="true"')
    expect(html).toContain("Session Logs")
    expect(html).toContain("3 events · current shift")
    expect(html).toContain("Handoff Initiated")
    expect(html).toContain("Alert Acknowledged")
    expect(html).toContain("Operator Login")
    expect(html).toContain("16:12:04Z")
    expect(html).toContain("+08h02m")
    expect(html).toContain("Verified sharp steam limit drop")
  })

  test("renders loading skeleton, error state, and empty state cleanly", () => {
    const loadingHtml = renderToStaticMarkup(
      React.createElement(ShiftHandoffModal, {
        ...baseProps,
        shiftLogs: [],
        shiftLogsLoading: true,
      }),
    )
    expect(loadingHtml).toContain('data-shift-logs-skeleton="true"')

    const errorHtml = renderToStaticMarkup(
      React.createElement(ShiftHandoffModal, {
        ...baseProps,
        shiftLogs: [],
        shiftLogsError: "Unable to load session logs (HTTP 503)",
        onRefreshShiftLogs: () => {},
      }),
    )
    expect(errorHtml).toContain('role="alert"')
    expect(errorHtml).toContain("Unable to load session logs (HTTP 503)")
    expect(errorHtml).toContain("Retry")

    const emptyHtml = renderToStaticMarkup(
      React.createElement(ShiftHandoffModal, {
        ...baseProps,
        shiftLogs: [],
        shiftLogsLoading: false,
      }),
    )
    expect(emptyHtml).toContain('data-shift-logs-empty="true"')
    expect(emptyHtml).toContain("No operator actions recorded during this shift window yet.")
  })
})
