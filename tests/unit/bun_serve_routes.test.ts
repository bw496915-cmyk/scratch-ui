import { afterAll, describe, expect, test } from "bun:test"
import {
  buildAgentDetailUrl,
  buildAlertAckUrl,
  buildAlertRetryUrl,
  buildApiUrl,
  buildShiftLogsUrl,
  createDashboardBunServer,
  createShiftSessionLogStore,
  DASHBOARD_ROUTES,
  safeDecodeRouteParam,
  type DashboardApiDeps,
  type ShiftSessionLogsResponse,
} from "../../packages/api/src/index.ts"

function createTestDeps(
  options: {
    readonly authenticated?: boolean
    readonly onAck?: (deliveryId: string) => void
    readonly onAgent?: (agentId: string) => void
  } = {},
): DashboardApiDeps {
  const authenticated = options.authenticated ?? true
  return {
    enforceAuth: authenticated
      ? async () => null
      : async () =>
          Response.json(
            { error: "Authentication required", code: "UNAUTHENTICATED" },
            { status: 401, headers: { "Cache-Control": "no-store" } },
          ),
    shiftLogs: createShiftSessionLogStore(50),
    auth: {
      login: async () => Response.json({ ok: true, operatorId: "desk_op" }),
      logout: async () => Response.json({ ok: true }),
      me: async () => Response.json({ authenticated }),
    },
    getHealthPayload: () => ({ status: "ok", version: "test" }),
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
      sweepOnce: async () => ({ sent: 1, failed: 0, dead: 0 }),
      list: () => [],
      ack: async ({ deliveryId }) => {
        options.onAck?.(deliveryId)
        return true
      },
      retry: async ({ deliveryId }) => `replayed-${deliveryId}`,
      getShiftSummary: (operatorId) => ({ operatorId }),
    },
    getAgentDetailPayload: async (agentId) => {
      options.onAgent?.(agentId)
      return {
        schemaVersion: 1,
        agentId,
        found: true,
        masterAgent: "M_ROOT",
        level: 2,
        agentType: "SUB",
        childAgents: [],
        conduit30d: null,
        customers: [],
        recentWagers: [],
        observedAt: "2026-11-20T17:00:00Z",
        autoExecute: false,
      }
    },
    getTaxonomyCatalog: () => [],
    runShadowPricing: async () => ({}),
    getBuildMatrix: async () => ({ targets: [], generatedAt: "" }),
  }
}

describe("Bun.serve static + radix-tree routes (ephemeral port: 0)", () => {
  const seenAgentIds: string[] = []
  const seenAckIds: string[] = []

  const handle = createDashboardBunServer(
    createTestDeps({
      authenticated: true,
      onAgent: (id) => seenAgentIds.push(id),
      onAck: (id) => seenAckIds.push(id),
    }),
    {
      port: 0,
      rootResponse: new Response("SportsDesk Ops Bun Router", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      }),
    },
  )

  const unauthHandle = createDashboardBunServer(createTestDeps({ authenticated: false }), {
    port: 0,
  })

  afterAll(() => {
    handle.stop(true)
    unauthHandle.stop(true)
  })

  test("binds an ephemeral port and exposes a valid server.url", () => {
    expect(handle.server.port).toBeGreaterThan(0)
    expect(handle.url).toBeInstanceOf(URL)
    expect(handle.url.protocol).toBe("http:")
  })

  test("GET / serves pre-serialized static Response directly from Bun router", async () => {
    const res = await fetch(handle.url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("SportsDesk Ops Bun Router")
  })

  test("POST /api/agent/:id, POST /api/agents/:id, and GET /api/alerts/:id/ack return 405 Method Not Allowed", async () => {
    const singularPostRes = await fetch(buildAgentDetailUrl(handle.url, 42), {
      method: "POST",
    })
    expect(singularPostRes.status).toBe(405)

    const pluralPostRes = await fetch(buildAgentDetailUrl(handle.url, 42, true), {
      method: "POST",
    })
    expect(pluralPostRes.status).toBe(405)

    const ackGetRes = await fetch(buildAlertAckUrl(handle.url, "alert-42"), {
      method: "GET",
    })
    expect(ackGetRes.status).toBe(405)
  })

  test("single-pass decode preserves literal %2F without double-decoding", async () => {
    // Encoded "%2F" -> "%252F" on the wire; single-pass decode must yield "%2F", not "/"
    const url = buildAgentDetailUrl(handle.url, "%2F")
    expect(url).toEndWith("/api/agent/%252F")

    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(500)
    const body = (await res.json()) as { agentId: string }
    expect(body.agentId).toBe("%2F")
    expect(body.agentId).not.toBe("/")

    // Parity on in-memory fetch() and plural /api/agents/:id
    const memRes = await handle.api.fetch(new Request(url))
    expect(memRes.status).toBe(200)
    expect(((await memRes.json()) as { agentId: string }).agentId).toBe("%2F")

    const pluralUrl = buildAgentDetailUrl(handle.url, "%2F", true)
    expect(pluralUrl).toEndWith("/api/agents/%252F")
    const pluralRes = await fetch(pluralUrl)
    expect(pluralRes.status).toBe(200)
    expect(((await pluralRes.json()) as { agentId: string }).agentId).toBe("%2F")
  })

  test("single-decodes URL-encoded req.params.id identically in Bun.serve and in-memory fetch()", async () => {
    // Literal percent sign and space in ID verify no double-decoding occurs
    const trickyAgentId = "BILLY 666%25"
    const agentUrl = buildAgentDetailUrl(handle.url, trickyAgentId)
    expect(agentUrl).toContain("/api/agent/BILLY%20666%2525")

    const httpRes = await fetch(agentUrl)
    expect(httpRes.status).toBe(200)
    const httpBody = (await httpRes.json()) as { agentId: string }
    expect(httpBody.agentId).toBe(trickyAgentId)

    const memRes = await handle.api.fetch(new Request(agentUrl))
    expect(memRes.status).toBe(200)
    const memBody = (await memRes.json()) as { agentId: string }
    expect(memBody.agentId).toBe(trickyAgentId)

    // Parameterized alert ack & retry also single-decode cleanly
    const trickyAlertId = "dlq alert#42"
    const ackRes = await fetch(buildAlertAckUrl(handle.url, trickyAlertId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operatorId: "desk_op", notes: "verified" }),
    })
    expect(ackRes.status).toBe(200)
    const ackBody = (await ackRes.json()) as { ok: boolean; deliveryId: string }
    expect(ackBody.ok).toBe(true)
    expect(ackBody.deliveryId).toBe(trickyAlertId)
    expect(seenAckIds).toContain(trickyAlertId)

    const retryRes = await fetch(buildAlertRetryUrl(handle.url, trickyAlertId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operatorId: "desk_op" }),
    })
    expect(retryRes.status).toBe(200)
    const retryBody = (await retryRes.json()) as {
      ok: boolean
      originalDeliveryId: string
      newDeliveryId: string
    }
    expect(retryBody.originalDeliveryId).toBe(trickyAlertId)
    expect(retryBody.newDeliveryId).toBe(`replayed-${trickyAlertId}`)

    // Verify shift logs endpoint captures the ack & retry over real HTTP
    const logsRes = await fetch(buildShiftLogsUrl(handle.url, { operatorId: "desk_op", limit: 10 }))
    expect(logsRes.status).toBe(200)
    const logsBody = (await logsRes.json()) as ShiftSessionLogsResponse
    expect(logsBody.logs.some((e) => e.action === "alert_ack")).toBe(true)
    expect(logsBody.logs.some((e) => e.action === "alert_retry")).toBe(true)
  })

  test("rejects malformed percent-encoding and control characters in route params with 400", async () => {
    const base = String(handle.url).replace(/\/+$/, "")

    const malformedRes = await fetch(`${base}/api/agents/%E0%A4%A`)
    expect(malformedRes.status).toBe(400)
    const malformedBody = (await malformedRes.json()) as { code: string }
    expect(malformedBody.code).toBe("INVALID_ROUTE_PARAM")

    const nullByteRes = await fetch(`${base}/api/agents/AG%001`)
    expect(nullByteRes.status).toBe(400)
    const nullByteBody = (await nullByteRes.json()) as { code: string }
    expect(nullByteBody.code).toBe("INVALID_ROUTE_PARAM")

    expect(safeDecodeRouteParam("   ").ok).toBe(false)
    expect(safeDecodeRouteParam("a".repeat(200), { maxLength: 64 }).ok).toBe(false)
  })

  test("unauthenticated server fails closed with 401 over real HTTP", async () => {
    const res = await fetch(buildAgentDetailUrl(unauthHandle.url, "BILLY666"))
    expect(res.status).toBe(401)
    expect(res.headers.get("cache-control")).toBe("no-store")
  })

  test("buildApiUrl normalizes trailing slashes, encodes params, and formats query strings", () => {
    expect(
      buildApiUrl("https://desk.example.com///", DASHBOARD_ROUTES.agentsById, {
        id: "AG/01?",
      }),
    ).toBe("https://desk.example.com/api/agents/AG%2F01%3F")

    expect(
      buildApiUrl(new URL("http://127.0.0.1:4321/"), DASHBOARD_ROUTES.shiftLogs, undefined, {
        since: 1700000000000,
        action: "alert_ack",
        limit: 25,
        ignored: undefined,
      }),
    ).toBe("http://127.0.0.1:4321/api/shift/logs?since=1700000000000&action=alert_ack&limit=25")
  })
})
