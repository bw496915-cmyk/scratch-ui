import { describe, expect, test } from "bun:test"
import { createServer, request } from "node:http"
import { createAgentDetailService } from "../packages/backend/src/agents.ts"
import {
  API_TELEMETRY_INSPECT_PATH,
  API_TELEMETRY_PATH,
} from "../packages/contracts/src/api_telemetry.ts"
import { ApiTelemetry, observeApiExchange } from "../server/api_telemetry.ts"
import { createPrivateDashboardRoutes } from "../server/private_dashboard_routes.ts"

describe("API telemetry", () => {
  test("uses declared paths and separates responses, aborts and active work", () => {
    let now = 1_000_000
    const telemetry = new ApiTelemetry(() => now)
    telemetry.declareRoute("/api/agents/:id")
    telemetry.declareRoute("/api/agents/current")
    const route = telemetry.resolveRoute("/api/agents/sensitive-customer")
    expect(route).toBe("/api/agents/:id")
    expect(telemetry.resolveRoute("/api/agents/current")).toBe("/api/agents/current")
    expect(telemetry.resolveRoute("/api/unregistered/sensitive-customer")).toBe("/api/:unmatched")

    const first = telemetry.start("GET", route)
    now += 8
    first(200)
    first(null)
    const second = telemetry.start("GET", route)
    now += 103
    second(503)
    const third = telemetry.start("GET", route)
    now += 1000
    third(null)
    const fourth = telemetry.start("GET", route)
    const snapshot = telemetry.snapshot("bun-native")
    expect(snapshot).toMatchObject({
      completed: 3,
      success: 1,
      clientErrors: 0,
      serverErrors: 1,
      aborted: 1,
      inFlight: 1,
      avgMs: 55.5,
      p95UpperMs: 150,
      rows: [{ route, lastStatus: null, lastMs: 1000 }],
    })

    now += 900_000
    expect(telemetry.snapshot("bun-native")).toMatchObject({
      completed: 0,
      inFlight: 1,
      avgMs: null,
      p95UpperMs: null,
      rows: [{ route, lastAtMs: null }],
    })
    fourth(403)
    expect(telemetry.snapshot("bun-native")).toMatchObject({ inFlight: 0, clientErrors: 1 })
  })

  test("merges exact statuses and latency bounds across buckets for a selected method and route", () => {
    let now = 1_000_000
    const telemetry = new ApiTelemetry(() => now)
    const route = telemetry.declareRoute("/api/agents/:id")
    for (const { duration, status } of [
      { duration: 0.5, status: 401 },
      { duration: 0.51, status: 401 },
      { duration: 5, status: 403 },
      { duration: 61_000, status: 200 },
      { duration: 10_000, status: null },
    ]) {
      const finish = telemetry.start("GET", route)
      now += duration
      finish(status)
      now += 15_000
    }
    telemetry.start("HEAD", route)(200)
    const selected = telemetry.snapshot("bun-native", { method: "GET", route })
    expect(selected).toMatchObject({
      completed: 5,
      aborted: 1,
      clientErrors: 3,
      p95UpperMs: 61_000,
    })
    expect(selected.rows).toHaveLength(1)
    expect(selected.rows[0].statusCounts).toEqual([
      { status: 200, count: 1 },
      { status: 401, count: 2 },
      { status: 403, count: 1 },
    ])
    expect(selected.rows[0].latencyBands).toEqual([
      { lowerExclusiveMs: null, upperInclusiveMs: 0.5, count: 1 },
      { lowerExclusiveMs: 0.5, upperInclusiveMs: 1, count: 1 },
      { lowerExclusiveMs: 2, upperInclusiveMs: 5, count: 1 },
      { lowerExclusiveMs: 60_000, upperInclusiveMs: null, count: 1 },
    ])
    expect(selected.rows[0].maxMs).toBe(61_000)
    now += 900_000
    expect(telemetry.snapshot("bun-native", { method: "GET", route }).rows).toEqual([])
  })

  test("records the latest response metadata and only the recognized parameter names", () => {
    const telemetry = new ApiTelemetry()
    telemetry.declareRoute("/api/customer/profile")
    telemetry.declareRoute("/api/agents/:id")
    const profileRoute = telemetry.resolveRoute("/api/customer/profile")
    const profile = telemetry.start(
      "GET",
      profileRoute,
      "id=privateAccount&id=another&privateKey=data",
    )
    profile(200, {
      etag: 'W/"profile-revision"',
      contentType: 'Application/Problem+JSON; Charset="UTF-8"; boundary=privateBoundary',
      setCookie: [
        "sd_session=privateSession; Secure; HttpOnly; SameSite=Lax; Max-Age=28800",
        "sd_csrf=privateCsrf; SameSite=Strict; Max-Age=0",
        "privateCookie=privateValue; HttpOnly",
      ],
    })
    const agentRoute = telemetry.resolveRoute("/api/agents/privateAgent")
    telemetry.start("GET", agentRoute, "id=anotherValue")(304, { etag: '"agent-revision"' })
    const snapshot = telemetry.snapshot("bun-native")
    expect(snapshot.rows.find((row) => row.route === profileRoute)).toMatchObject({
      lastParams: { path: [], query: ["id"] },
      lastResponse: {
        etag: 'W/"profile-revision"',
        contentType: "application/problem+json; charset=utf-8",
        type: "JSON",
        cookies: [
          {
            name: "sd_session",
            expired: false,
            secure: true,
            httpOnly: true,
            sameSite: "Lax",
            maxAgeSeconds: 28_800,
          },
          {
            name: "sd_csrf",
            expired: true,
            secure: false,
            httpOnly: false,
            sameSite: "Strict",
            maxAgeSeconds: 0,
          },
        ],
      },
    })
    expect(snapshot.rows.find((row) => row.route === agentRoute)).toMatchObject({
      lastParams: { path: ["id"], query: [] },
      lastResponse: { etag: '"agent-revision"', contentType: null, type: "No body" },
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/private|another/)

    telemetry.start("GET", profileRoute)(503, {
      contentType: "text/html",
      etag: "malformed",
    })
    const latest = telemetry.snapshot("bun-native").rows.find((row) => row.route === profileRoute)
    expect(latest).toMatchObject({
      lastStatus: 503,
      lastParams: { path: [], query: [] },
      lastResponse: { etag: null, contentType: "text/html", type: "HTML" },
    })
    telemetry.start("GET", profileRoute)(null, { contentType: "application/json" })
    expect(
      telemetry.snapshot("bun-native").rows.find((row) => row.route === profileRoute)?.lastResponse,
    ).toBeNull()
  })

  test("observes chunked input and streamed output over HTTP without consuming the request", async () => {
    const telemetry = new ApiTelemetry()
    const route = telemetry.declareRoute("/api/agents/:id")
    const server = createServer(async (req, res) => {
      observeApiExchange(telemetry, route, req, res)
      let received = ""
      for await (const chunk of req) received += chunk.toString()
      if (received !== "private request") {
        res.statusCode = 400
        res.end()
        return
      }
      res.setHeader("Content-Type", "text/event-stream")
      res.write("data: café\n\n", "utf8")
      res.end("data: done\n\n")
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Expected HTTP listener")
      const body = await new Promise<string>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            method: "POST",
            path: "/api/agents/private-agent",
            headers: {
              "Content-Type": "text/plain",
              cookie:
                "sd_csrf=csrf-private; private_name=private_value; sd_session=private-session",
            },
            agent: false,
            signal: AbortSignal.timeout(2000),
          },
          (res) => {
            const read = async () => {
              expect(res.statusCode).toBe(200)
              let value = ""
              res.setEncoding("utf8")
              for await (const chunk of res) value += chunk
              return value
            }
            void read().then(resolve, reject)
          },
        )
        req.on("error", reject)
        req.write("private ")
        req.end("request")
      })
      expect(body).toBe("data: café\n\ndata: done\n\n")
      const snapshot = telemetry.snapshot("bun-native")
      expect(snapshot.rows).toMatchObject([
        {
          lastParams: { path: ["id"], query: [] },
          lastRequest: {
            scheme: "http",
            httpVersion: "1.1",
            tlsVersion: null,
            contentType: "text/plain",
            cookieNames: ["sd_session", "sd_csrf"],
            body: { framing: "Chunked", declaredBytes: null },
          },
          lastResponse: {
            type: "Event stream",
            body: { delivery: "Streamed", bytes: Buffer.byteLength(body), chunks: 2 },
          },
        },
      ])
      expect(JSON.stringify(snapshot)).not.toMatch(/private|café/)
    } finally {
      server.close()
    }
  })

  test("dispatches through Bun routes and renders native custom inspection with query options", async () => {
    const telemetry = new ApiTelemetry()
    telemetry.start("GET", telemetry.declareRoute("/api/agent/:id"))(200, {
      etag: '"agent-revision"',
      contentType: "application/json",
    })
    telemetry.start(
      "GET",
      telemetry.declareRoute("/api/customer/profile"),
      "id=privateAccount&privateKey=privateValue",
    )(200)
    telemetry.start("GET", telemetry.declareRoute("/api/profile"))(200)
    const native = createPrivateDashboardRoutes(telemetry)
    try {
      const snapshot = await native.dispatch(API_TELEMETRY_PATH, "")
      expect(snapshot.status).toBe(200)
      expect(await snapshot.json()).toMatchObject({ router: "bun-native", completed: 3 })
      const inspected = await native.dispatch(
        API_TELEMETRY_INSPECT_PATH,
        "?colors=true&maxArrayLength=2&sorted=true&showOptions=true",
      )
      const { output, plain } = await inspected.json()
      expect(plain).toContain("ApiTelemetryView [Bun.inspect.custom]")
      expect(plain).toMatch(/│ Method\s*│ Route\s*│/)
      expect(plain).toMatch(/│ GET\s*│ \/api\/agent\/:id\s*│ :id\s*│ —\s*│/)
      expect(plain).toMatch(/│ GET\s*│ \/api\/customer\/profile\s*│ —\s*│ \?id\s*│/)
      expect(plain).toContain('"agent-revision"')
      expect(plain).toContain("application/json")
      expect(plain).toContain("Response Type")
      expect(plain).not.toMatch(/\/api\/profile|privateAccount|privateKey|privateValue/)
      expect(plain).toContain("+1 more row")
      expect(plain).toContain("Bun.inspect.options")
      expect(output).toContain("\x1b[")
      const summary = await native.dispatch(API_TELEMETRY_INSPECT_PATH, "?depth=0&colors=false")
      const summaryText = await summary.json()
      expect(summaryText.plain).not.toContain("/api/agent/:id")
      expect(summaryText.output).toBe(summaryText.plain)
      const focused = await native.dispatch(
        API_TELEMETRY_INSPECT_PATH,
        "?depth=3&method=get&route=%2Fapi%2Fagent%2F%3Aid",
      )
      const focusedText = await focused.json()
      expect(focusedText.plain).toContain("1 finished")
      expect(focusedText.plain).toContain("HTTP status counts")
      expect(focusedText.plain).toContain("Response latency distribution")
      expect(focusedText.plain).toMatch(/\/api\/agent\/:id\s*│\s*200\s*│\s*1\s*│/)
      expect(focusedText.plain).not.toMatch(/\/api\/customer\/profile|\/api\/profile/)
      const incomplete = await native.dispatch(API_TELEMETRY_INSPECT_PATH, "?method=GET")
      expect(incomplete.status).toBe(400)
      const unmatched = await native.dispatch(
        API_TELEMETRY_INSPECT_PATH,
        "?depth=3&method=GET&route=%2Fapi%2Fagent%2FprivateAccount",
      )
      const unmatchedText = await unmatched.json()
      expect(unmatchedText.plain).toContain("0 finished")
      expect(unmatchedText.plain).not.toContain("privateAccount")
    } finally {
      await native.stop()
    }
  })

  test("dispatches both native agent aliases using Bun's decoded request parameters", async () => {
    const service = createAgentDetailService()
    const native = createPrivateDashboardRoutes(new ApiTelemetry(), {
      loadAgentDetail: service.getAgentDetail,
    })
    try {
      for (const alias of ["agent", "agents"]) {
        const route = `http://dashboard.test/api/${alias}`
        const response = await native.dispatchAgent(
          new Request(`${route}/desk%252Fprobe?private=ignored`),
        )
        expect(response?.status).toBe(200)
        expect(await response?.json()).toMatchObject({ agentId: "DESK%2FPROBE" })
        const malformed = await native.dispatchAgent(new Request(`${route}/%ZZ`))
        expect(malformed?.status).toBe(400)
        expect(native.dispatchAgent(new Request(`${route}/desk`, { method: "HEAD" }))).toBeNull()
        expect(native.dispatchAgent(new Request(`${route}/desk/extra`))).toBeNull()
      }
    } finally {
      await native.stop()
    }
  })

  test("keeps private telemetry and profile requests off an HTTP proxy", async () => {
    let proxied = 0
    const proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        proxied++
        return new Response(null, { status: 502 })
      },
    })
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--eval",
          `
          import assert from "node:assert/strict"
          import { ApiTelemetry } from ${JSON.stringify(new URL("../server/api_telemetry.ts", import.meta.url).href)}
          import { createPrivateDashboardRoutes } from ${JSON.stringify(new URL("../server/private_dashboard_routes.ts", import.meta.url).href)}
          const session = "sd_session=opaque-test-session"
          const profileRequest = new Request("http://dashboard.test/api/profile", { headers: { cookie: session } })
          const native = createPrivateDashboardRoutes(new ApiTelemetry(), {
            profile: {
              resolveSessionId: () => "opaque-test-session",
              read(req) {
                assert.equal(req.headers.get("cookie"), session)
                return Response.json({ ok: true })
              },
            },
          })
          try {
            const control = await fetch("http://127.0.0.1:1", { signal: AbortSignal.timeout(1500) })
            assert.equal(control.status, 502)
            const response = await native.dispatch("/api/telemetry", "")
            assert.equal(response.status, 200)
            assert.equal((await response.json()).router, "bun-native")
            const profileResponse = await native.dispatchProfile(profileRequest)
            assert.equal(profileResponse?.status, 200)
            assert.deepEqual(await profileResponse.json(), { ok: true })
          } finally {
            await native.stop()
          }
        `,
        ],
        {
          env: {
            ...process.env,
            HTTP_PROXY: proxy.url.href,
            http_proxy: proxy.url.href,
            NO_PROXY: "",
            no_proxy: "",
          },
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
      expect(proxied).toBe(1)
    } finally {
      await proxy.stop(true)
    }
  })
})
