/**
 * Automated security regression suite verifying audit findings F1–F6:
 *
 * - F1: Fail-closed auth hook (missing/unconfigured hook denies)
 * - F2: Inverted auth default (on unless explicit dev/test opt-out; never off in prod)
 * - F3: All protected /api/* routes reject anonymous callers; weblogs/profiles redact raw IPs to /24#hash
 * - F4: POST /api/terminal/exec requires separate admin credential + strict allowlist; CSRF enforced on cookie writes
 * - F5: Security headers (CSP with Telegram frame-ancestors, nosniff, Referrer-Policy, Permissions-Policy, HSTS) & no
 *   X-Powered-By
 * - F6: Minimal public /health & /api/health ({ status, timestamp }) vs authenticated /api/health/detail
 *
 * @file Tests/security_audit.test.ts
 */

import { describe, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { inspect } from "node:util"

import {
  buildSecurityHeaders,
  createEnforceAuthMiddleware,
  createHttpAuthController,
  digestSessionId,
  enforceAuth as defaultEnforceAuth,
  generateCspNonce,
  HASHED_ASSET_CACHE_CONTROL,
  injectCspNonceIntoHtml,
  isPublicApiRoute,
  NONCED_HTML_CACHE_CONTROL,
  redactIpToSubnetHash,
  redactRawIpsInText,
  sendNoncedHtmlShell,
  type SessionRecord,
  validateTerminalCommand,
} from "../lib/http_auth.ts"
import { adminGuard, createDashboardApi, requireSession } from "../packages/api/src/router.ts"
import { DashboardHealthTracker } from "../packages/backend/src/health.ts"
import { isDashboardAuthRequired } from "../packages/backend/src/parsers.ts"
import { stripAnsi } from "../server/desk_inspect.ts"
import { formatProfileInspectPayload, normalizeRawCustomerToProfileRecord } from "../server/profile_inspect.ts"
import { createWebLogStore, parseFantasy402Action, WebLogView } from "../server/weblog_inspect.ts"

const RAW_IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b(?!\/24)/

function makeTestApi(env: Record<string, string | undefined>) {
  const httpAuth = createHttpAuthController({ env })
  const healthTracker = new DashboardHealthTracker({
    isDbConfigured: () => false,
    probeDb: async () => {},
    cleanupSessions: () => httpAuth.cleanupSessions(),
    getAlertMetrics: () => ({ status: "warning", queued: 1, delivered: 1, dead: 1 }),
    getPort: () => 3000,
  })

  const api = createDashboardApi({
    enforceAuth: (req) => httpAuth.enforceAuth(req),
    enforceAdminAuth: (req) => httpAuth.enforceAdminAuth(req),
    validateTerminalCommand,
    auth: httpAuth.auth,
    getHealthPayload: () => healthTracker.sample(),
    getPublicHealthPayload: () => healthTracker.samplePublic(),
    loadDashboardMarkdown: async () => ({
      stamp: "test-stamp",
      markdown: "# Internal Ops",
      html: "<h1>Internal Ops</h1>",
    }),
    dns: {
      getTelemetryPayload: () => ({ success: true }),
      benchmark: async (host) => ({ host }),
      classifyIp: async (ip) => ({ ip }),
    },
    customers: {
      getCohortReport: async () => ({
        versionStamp: "v1",
        payload: { customers: [{ id: "JAKE231" }] },
      }),
      getProfile: async (id) => ({ customerId: id }),
      getRating: async (id) => ({ customerId: id }),
    },
    execTerminal: async (command) => ({
      command,
      stdout: `executed:${command}`,
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      timestamp: Date.now(),
    }),
    rankings: {
      getAll: async () => ({ generatedAtIso: "2026-01-01T00:00:00Z", payload: { topPlayers: [] } }),
      getConduits: async () => [],
    },
    getLiveWagersPayload: async () => ({
      wagers: [{ customerId: "JAKE231", agentId: "MJ2026", masterAgent: "BILLY666" }],
    }),
    getTiersConfig: async () => ({ tiers: {} }),
    alerts: {
      sweepOnce: async () => ({ swept: 0 }),
      list: () => [],
      ack: async () => true,
      retry: async () => "alrt-new",
      getShiftSummary: (operatorId) => ({ operatorId }),
    },
    getTaxonomyCatalog: () => [],
    runShadowPricing: async () => ({ ok: true }),
    getBuildMatrix: async () => ({ targets: [], generatedAt: "2026-01-01T00:00:00Z" }),
  })

  return { api, httpAuth }
}

describe("F1: Fail-Closed Auth Contract & requireSession Middleware", () => {
  test("requireSession fails closed (401) when enforceAuth is missing or throws", async () => {
    let handlerCalled = false
    const inner = async () => {
      handlerCalled = true
      return Response.json({ ok: true })
    }

    const missingGuard = requireSession(undefined, inner)
    const missingRes = await missingGuard(new Request("http://127.0.0.1:3000/api/wagers"))
    expect(missingRes.status).toBe(401)
    expect(missingRes.headers.get("www-authenticate")).toContain("Bearer")
    expect(handlerCalled).toBe(false)

    const throwingGuard = requireSession(async () => {
      throw new Error("auth backend down")
    }, inner)
    const throwRes = await throwingGuard(new Request("http://127.0.0.1:3000/api/wagers"))
    expect(throwRes.status).toBe(401)
    expect(handlerCalled).toBe(false)
  })

  test("router fails closed (401) across ALL route families if deps.enforceAuth is omitted at runtime", async () => {
    // Bypass TS types deliberately to verify runtime fail-closed guard on every route family
    const brokenApi = createDashboardApi({
      enforceAuth: undefined as unknown as (req: Request) => Promise<Response | null>,
      auth: {
        login: () => Response.json({ ok: false }, { status: 401 }),
        logout: () => Response.json({ ok: true }),
        me: () => Response.json({ authenticated: false }),
      },
      getHealthPayload: () => ({ status: "ok", version: "v1.01.23-next" }),
      loadDashboardMarkdown: async () => null,
      dns: {
        getTelemetryPayload: () => ({}),
        benchmark: async () => ({}),
        classifyIp: async () => ({}),
      },
      customers: {
        getCohortReport: async () => ({ versionStamp: "v", payload: {} }),
        getProfile: async () => null,
        getRating: async () => null,
      },
      execTerminal: async () => ({}),
      rankings: {
        getAll: async () => ({ generatedAtIso: "", payload: {} }),
        getConduits: async () => [],
      },
      getLiveWagersPayload: async () => ({ wagers: [] }),
      getTiersConfig: async () => ({}),
      alerts: {
        sweepOnce: async () => ({}),
        list: () => [],
        ack: async () => false,
        retry: async () => null,
        getShiftSummary: () => ({}),
      },
      getTaxonomyCatalog: () => [],
      runShadowPricing: async () => ({}),
      getBuildMatrix: async () => ({ targets: [], generatedAt: "" }),
    })

    const routeFamilyProbes: Array<{ method: string; path: string }> = [
      { method: "GET", path: "/api/health/detail" },
      { method: "GET", path: "/mcp" },
      { method: "GET", path: "/api/dashboard" },
      { method: "GET", path: "/api/surveillance/brief" },
      { method: "GET", path: "/api/dns" },
      { method: "GET", path: "/api/dns/telemetry" },
      { method: "GET", path: "/api/surveillance/dns" },
      { method: "GET", path: "/api/dns/benchmark" },
      { method: "GET", path: "/api/surveillance/dns/benchmark" },
      { method: "GET", path: "/api/dns/reverse" },
      { method: "GET", path: "/api/surveillance/dns/reverse" },
      { method: "GET", path: "/api/customers" },
      { method: "GET", path: "/api/customer/profile?id=JAKE231" },
      { method: "GET", path: "/api/customer/rating?id=JAKE231" },
      { method: "POST", path: "/api/terminal/exec" },
      { method: "GET", path: "/api/rankings/all" },
      { method: "GET", path: "/api/agency/conduits" },
      { method: "GET", path: "/api/wagers" },
      { method: "GET", path: "/api/live-wagers" },
      { method: "GET", path: "/api/config/tiers" },
      { method: "POST", path: "/api/alerts/sweep" },
      { method: "GET", path: "/api/alerts" },
      { method: "POST", path: "/api/alerts/alrt-1/ack" },
      { method: "POST", path: "/api/alerts/alrt-1/retry" },
      { method: "GET", path: "/api/shift/summary" },
      { method: "GET", path: "/api/taxonomy-catalog" },
      { method: "GET", path: "/api/shadow-pricing" },
      { method: "POST", path: "/api/shadow-pricing" },
      { method: "GET", path: "/api/build-matrix" },
      { method: "GET", path: "/api/ws/status" },
      { method: "GET", path: "/api/bet-ticker" },
      { method: "GET", path: "/api/r2/pipeline" },
      { method: "GET", path: "/api/r2/pipeline/history" },
      { method: "GET", path: "/api/r2/image-provenance?key=test.png" },
      { method: "GET", path: "/api/daemon/status" },
      { method: "GET", path: "/api/automations" },
      { method: "POST", path: "/api/gslive/verify-tickets" },
      { method: "GET", path: "/api/agent/MJ2026" },
      { method: "GET", path: "/api/agents/MJ2026" },
      { method: "GET", path: "/api/nonexistent-probe" },
      { method: "POST", path: "/api/wagers" },
    ]

    for (const probe of routeFamilyProbes) {
      const res = await brokenApi.fetch(
        new Request(`http://127.0.0.1:3000${probe.path}`, {
          method: probe.method,
        }),
      )
      expect(res.status).toBe(401)
    }

    // Minimal public health probe still responds 200
    const healthRes = await brokenApi.fetch(new Request("http://127.0.0.1:3000/api/health"))
    expect(healthRes.status).toBe(200)
  })

  test("unconfigured server credentials default to closed state (401)", async () => {
    const { api } = makeTestApi({ NODE_ENV: "production" })
    const res = await api.fetch(new Request("http://127.0.0.1:3000/api/wagers"))
    expect(res.status).toBe(401)

    const unsetEnvRes = await makeTestApi({}).api.fetch(new Request("http://127.0.0.1:3000/api/wagers"))
    expect(unsetEnvRes.status).toBe(401)

    // Top-level exported enforceAuth also defaults to 401 when process.env has no tokens
    expect(typeof defaultEnforceAuth).toBe("function")
    expect(typeof createEnforceAuthMiddleware).toBe("function")
    const defaultDenied = await defaultEnforceAuth(new Request("http://127.0.0.1:3000/api/wagers"))
    expect(defaultDenied?.status).toBe(401)
  })
})

describe("F2: Inverted Auth Default", () => {
  test("auth is ON by default when NODE_ENV is unset", () => {
    expect(isDashboardAuthRequired({})).toBe(true)
    expect(isDashboardAuthRequired({ SPORTSDESK_AUTH_DISABLED: "1" })).toBe(true)
  })

  test("auth CANNOT be disabled in production even with SPORTSDESK_AUTH_DISABLED=1", () => {
    expect(isDashboardAuthRequired({ NODE_ENV: "production" })).toBe(true)
    expect(
      isDashboardAuthRequired({
        NODE_ENV: "production",
        SPORTSDESK_AUTH_DISABLED: "1",
      }),
    ).toBe(true)
  })

  test("auth is ON by default in development unless explicitly opted out", () => {
    expect(isDashboardAuthRequired({ NODE_ENV: "development" })).toBe(true)
    expect(
      isDashboardAuthRequired({
        NODE_ENV: "development",
        SPORTSDESK_AUTH_DISABLED: "1",
      }),
    ).toBe(false)
    expect(
      isDashboardAuthRequired({
        NODE_ENV: "test",
        SPORTSDESK_AUTH_DISABLED: "1",
      }),
    ).toBe(false)
  })
})

describe("F3: Protected API Surface, Dual Auth & IP Redaction", () => {
  const ENV = {
    NODE_ENV: "production",
    SPORTSDESK_DASHBOARD_TOKEN: "test-operator-token-xyz",
    SPORTSDESK_ADMIN_TOKEN: "test-admin-token-999",
  }

  test("all protected router endpoints deny anonymous requests with 401 and allow Bearer", async () => {
    const { api } = makeTestApi(ENV)
    const protectedGets = [
      "/api/wagers",
      "/api/live-wagers",
      "/api/dashboard",
      "/api/surveillance/brief",
      "/api/customers",
      "/api/rankings/all",
      "/api/agency/conduits",
      "/api/alerts",
      "/api/shift/summary",
      "/api/config/tiers",
      "/api/dns",
      "/api/surveillance/dns",
      "/api/surveillance/dns/benchmark",
      "/api/surveillance/dns/reverse",
      "/api/bet-ticker",
      "/api/r2/pipeline",
      "/api/automations",
      "/api/shadow-pricing",
      "/api/build-matrix",
      "/api/ws/status",
      "/api/health/detail",
      "/mcp",
    ]

    for (const path of protectedGets) {
      const anonRes = await api.fetch(new Request(`http://127.0.0.1:3000${path}`))
      expect(anonRes.status).toBe(401)

      const authRes = await api.fetch(
        new Request(`http://127.0.0.1:3000${path}`, {
          headers: { Authorization: `Bearer ${ENV.SPORTSDESK_DASHBOARD_TOKEN}` },
        }),
      )
      expect(authRes.status).not.toBe(401)
      expect(authRes.status).not.toBe(403)
    }
  })

  test("session cookie + CSRF flow works end-to-end and rejects missing CSRF on POST", async () => {
    const { api } = makeTestApi(ENV)

    const loginRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatorId: "alice",
          token: ENV.SPORTSDESK_DASHBOARD_TOKEN,
        }),
      }),
    )
    expect(loginRes.status).toBe(200)
    const setCookies = loginRes.headers.getSetCookie()
    const sessionCookie = setCookies.find((c) => c.startsWith("sd_session="))
    const csrfCookie = setCookies.find((c) => c.startsWith("sd_csrf="))
    expect(sessionCookie).toContain("HttpOnly")
    expect(sessionCookie).toContain("SameSite=Lax")
    expect(csrfCookie).toBeDefined()

    const sidPair = sessionCookie!.split(";")[0]!
    const csrfToken = decodeURIComponent(csrfCookie!.split(";")[0]!.split("=")[1]!)

    // GET succeeds with session cookie
    const getRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/wagers", {
        headers: { Cookie: sidPair },
      }),
    )
    expect(getRes.status).toBe(200)

    // POST without CSRF fails with 403
    const noCsrfRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/alerts/sweep", {
        method: "POST",
        headers: { Cookie: sidPair },
      }),
    )
    expect(noCsrfRes.status).toBe(403)

    // POST with matching CSRF succeeds
    const withCsrfRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/alerts/sweep", {
        method: "POST",
        headers: {
          Cookie: sidPair,
          "x-csrf-token": csrfToken,
        },
      }),
    )
    expect(withCsrfRes.status).toBe(200)
  })

  test("sessions expire with the cookie even after recent authenticated activity", async () => {
    let now = 0
    const { auth, authenticateHeaders } = createHttpAuthController({
      env: ENV,
      now: () => now,
      sessionTtlMs: 10_000,
    })
    const response = await auth.login(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ token: ENV.SPORTSDESK_DASHBOARD_TOKEN }),
      }),
    )
    const session = response.headers.getSetCookie().find((cookie) => cookie.startsWith("sd_session="))
    expect(session).toContain("Max-Age=10")
    const headers = new Headers({ cookie: session?.split(";")[0] ?? "" })
    now = 9_000
    expect(authenticateHeaders(headers, "GET").authenticated).toBe(true)
    now = 10_000
    expect(authenticateHeaders(headers, "GET").authenticated).toBe(false)
  })

  test("Bun CSRF tokens bind to one session for protected writes and sign-out", async () => {
    const credential = ENV.SPORTSDESK_DASHBOARD_TOKEN
    assert.ok(credential)
    const secret = "independent-csrf-key-for-runtime-test"
    const { auth, authenticateHeaders } = createHttpAuthController({
      env: { ...ENV, CSRF_SECRET: secret },
    })
    const origin = "https://desk.bookdeskops.test"
    async function signIn() {
      const response = await auth.login(
        new Request(`${origin}/api/auth/login`, {
          method: "POST",
          body: JSON.stringify({ token: credential }),
        }),
      )
      expect(response.status).toBe(200)
      const [session, csrf] = response.headers.getSetCookie().map((cookie) => new Bun.Cookie(cookie))
      assert.ok(session?.name === "sd_session" && csrf?.name === "sd_csrf")
      return { id: session.value, csrf: csrf.value }
    }
    const first = await signIn()
    const second = await signIn()
    expect(first.csrf.startsWith("bun2.")).toBe(true)
    const token = first.csrf.slice("bun2.".length)
    expect(Bun.CSRF.verify(token, { secret, sessionId: first.id })).toBe(true)
    expect(Bun.CSRF.verify(token, { secret, sessionId: second.id })).toBe(false)
    const headers = { cookie: `sd_session=${first.id}`, "x-csrf-token": second.csrf }
    expect(authenticateHeaders(new Headers(headers), "POST")).toMatchObject({
      authenticated: false,
      code: "CSRF_INVALID",
    })
    const logout = await auth.logout(
      new Request(`${origin}/api/auth/logout`, {
        method: "POST",
        headers,
      }),
    )
    expect(logout.status).toBe(403)
    expect(authenticateHeaders(new Headers({ ...headers, "x-csrf-token": first.csrf }), "POST").authenticated).toBe(
      true,
    )
    const anotherValidToken = "bun2." + Bun.CSRF.generate(secret, { sessionId: first.id })
    expect(anotherValidToken).not.toBe(first.csrf)
    expect(
      authenticateHeaders(new Headers({ ...headers, "x-csrf-token": anotherValidToken }), "POST").authenticated,
    ).toBe(true)
  })

  test("accepts legacy stored CSRF tokens for an unexpired authenticated session", () => {
    const sessionId = "pre-upgrade-session"
    const id = digestSessionId(sessionId)
    const credential = ENV.SPORTSDESK_DASHBOARD_TOKEN
    assert.ok(credential)
    const record = {
      csrfToken: "bun1.pre-upgrade-csrf",
      operatorId: "legacy-operator",
      role: "OPERATOR",
      expiresAtMs: Date.now() + 60_000,
    } satisfies Omit<SessionRecord, "credentialProof">
    const credentialProof = createHmac("sha256", credential)
      .update(JSON.stringify([id, record.operatorId, record.role, record.csrfToken, record.expiresAtMs]))
      .digest("hex")
    const rows = new Map<string, SessionRecord>([[id, { ...record, credentialProof }]])
    const { authenticateHeaders } = createHttpAuthController({
      env: ENV,
      sessionStore: {
        get: (key) => rows.get(key),
        insert: (key, next) => {
          rows.set(key, next)
        },
        delete: (key) => {
          rows.delete(key)
        },
        purgeExpired: () => 0,
      },
    })
    const headers = new Headers({
      cookie: `sd_session=${sessionId}`,
      "x-csrf-token": record.csrfToken,
    })
    expect(authenticateHeaders(headers, "POST").authenticated).toBe(true)
  })

  test.each([
    { bind: "127.0.0.1", origin: "http://127.0.0.1", secure: false },
    { bind: "::1", origin: "http://[::1]", secure: false },
    { bind: "localhost", origin: "http://localhost", secure: false },
    { bind: "127.0.0.1", origin: "https://localhost", secure: true },
    { bind: "0.0.0.0", origin: "http://127.0.0.1", secure: true },
    { bind: "127.0.0.1", origin: "http://desk.example", secure: true },
    { bind: "127.0.0.1", origin: "https://localhost", proto: "https", secure: true },
    { bind: "127.0.0.1", origin: "http://localhost", proto: "http", secure: true },
  ])("login and logout cookie transport on $bind for $origin (forwarded=$proto)", async (c) => {
    const { auth } = createHttpAuthController({ env: ENV, bindHost: c.bind })
    const headers = new Headers({ Origin: c.origin, "Content-Type": "application/json" })
    if (c.proto) headers.set("X-Forwarded-Proto", c.proto)
    const login = await auth.login(
      new Request(c.origin + "/api/auth/login", {
        method: "POST",
        headers,
        body: JSON.stringify({ token: ENV.SPORTSDESK_DASHBOARD_TOKEN }),
      }),
    )
    const logout = await auth.logout(new Request(c.origin + "/api/auth/logout", { method: "POST", headers }))
    for (const response of [login, logout]) {
      expect(response.status).toBe(200)
      const cookies = response.headers.getSetCookie()
      expect(cookies.length).toBe(2)
      for (const cookie of cookies) {
        const attributes = cookie.split("; ").slice(1)
        expect(attributes).toContain("Path=/")
        expect(attributes.includes("Secure")).toBe(c.secure)
        expect(attributes).toContain("SameSite=Lax")
        expect(attributes.includes("HttpOnly")).toBe(cookie.startsWith("sd_session="))
        if (response === logout) {
          expect(cookie.split(";")[0]).toMatch(/^sd_(session|csrf)=$/)
          expect(attributes).toContain("Max-Age=0")
        }
      }
    }
  })

  test("weblog store and profile inspect redact all raw IPv4 addresses to /24#hash", () => {
    const store = createWebLogStore()
    expect(store.query().summary.totalEntries).toBe(0)
    store.setCapture(
      [
        {
          account: "ACCOUNT1",
          time: "2026-11-19 08:21:55",
          address: "102.128.164.122",
          operation: "Login successful Token sensitive-operation-detail",
        },
      ],
      true,
    )
    const payload = store.query({ depth: 3, showHidden: true, colors: false })
    expect(payload.source).toBe("retained-mode-a")
    expect(payload.entries[0]?.accountId).toBe("ACCOUNT1")
    expect(store.reset().summary.totalEntries).toBe(1)
    expect(payload.entries[0]?.rawAction).toBe("Successful token login")
    const serialized = JSON.stringify(payload)

    expect(payload.entries.length).toBeGreaterThan(0)
    expect(RAW_IPV4_RE.test(serialized)).toBe(false)
    for (const ip of payload.availableIps) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.0\/24#[0-9a-f]{8}$/)
    }

    const prof = normalizeRawCustomerToProfileRecord({
      id: "JAKE231",
      ipAddress: "45.142.182.91",
    })
    expect(prof.ipAddress).toMatch(/^45\.142\.182\.0\/24#[0-9a-f]{8}$/)
    const inspectPayload = formatProfileInspectPayload({
      profiles: [prof],
      options: { showHidden: true, colors: false },
    })
    expect(RAW_IPV4_RE.test(JSON.stringify(inspectPayload))).toBe(false)

    // Helper sanity checks
    const r = redactIpToSubnetHash("102.128.164.122", "unit-test-salt")
    expect(r.subnet24).toBe("102.128.164.0/24")
    expect(r.redacted).toMatch(/^102\.128\.164\.0\/24#[0-9a-f]{8}$/)
    expect(redactRawIpsInText("login from 102.128.164.122 ok", "unit-test-salt")).not.toContain("102.128.164.122")
  })

  test("retained weblog pages preserve IP family, operation markers and the parsed selection", () => {
    const store = createWebLogStore()
    const ipv6 = "2001:db8:1234:5678::9"
    const rows = [
      {
        account: "ACCOUNT1",
        time: "2026-11-19 08:21:55",
        address: ipv6,
        operation:
          "API LOG | BLOCK BET | BOT BLOCK LINE ST | #[{&quot;key&quot;:&quot;bot_619137349_0_L_U_0&quot;,&quot;val&quot;:&quot;OTHER_LOGIN&quot;}]",
      },
      {
        account: "ACCOUNT1",
        time: "2026-11-19 08:21:54",
        address: "2001:0DB8:1234:5678:0000:0000:0000:0009",
        operation: "(M) Login successful [ v43.0.27 | www.fantasy402.com ]",
      },
      {
        account: "ACCOUNT2",
        time: "2026-11-19 08:21:53",
        address: "192.0.2.10",
        operation: "Chosen team private-operation-detail",
      },
    ]
    store.setCapture(rows, true)
    const first = store.query({ ipFamily: "IPv6", limit: 1 })
    const next = store.query({ ipFamily: "IPv6", limit: 1, offset: first.page.nextOffset ?? 0 })
    expect(first.summary.filteredEntries).toBe(2)
    expect(first.page.nextOffset).toBe(1)
    expect(next.page.nextOffset).toBeNull()
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]).toMatchObject({
      accountId: "ACCOUNT1",
      ipMeta: { family: "IPv6", subnet24: "2001:db8:1234::/48" },
      event: "API",
      eventKind: "BOT_BLOCK_LINE_ST",
      botKey: { gameId: "619137349", periodLabel: "FG", marketLabel: "Total", sideLabel: "Under" },
    })
    expect(next.entries[0]).toMatchObject({
      event: "Login",
      eventKind: "LOGIN_SUCCESS",
      botKey: null,
      clientVersion: "v43.0.27",
    })
    expect(first.entries[0]?.ip).toBe(next.entries[0]?.ip)
    expect(JSON.stringify(first)).not.toContain(ipv6)
    expect(store.query({ kind: "LOGIN_TOKEN" }).entries).toHaveLength(0)
    expect(store.query({ ipFamily: "IPv4" }).entries[0]).toMatchObject({
      event: "Wager",
      eventKind: "TEAM_CHOSEN",
      botKey: null,
    })
    expect(JSON.stringify(store.query())).not.toContain("private-operation-detail")
  })

  test("weblog team selections and ticket references preserve distinct provider fields", () => {
    const store = createWebLogStore()
    const providerRows = [
      ["Chosen Team  : Example St | Game Num : 619137349 | Wager Number : 203 | Item Number : 1", "08:22:01"],
      ["API LOG | PARLAY | Ticket: 1076964221", "08:22:02"],
      [
        "API LOG | Bet : Basketball #543 Example/Example O 210&amp;#189; -110 - buying -&amp;#189; For Game",
        "08:22:03",
      ],
      ["Login successful Ticket: 1076964221", "08:22:04"],
    ]
    store.setCapture(
      providerRows.flatMap(([operation, time]) =>
        operation && time
          ? [
              {
                account: "ACCOUNT1",
                time: `2026-11-19 ${time}`,
                address: "192.0.2.10",
                operation,
              },
            ]
          : [],
      ),
      true,
    )
    expect(store.query({ q: "619137349" }).entries[0]).toMatchObject({
      selection: {
        source: "chosen-team",
        gameId: "619137349",
        pick: "Example St",
        market: null,
        period: null,
      },
      botKey: null,
      ticketNumber: null,
    })
    expect(store.query({ q: "1076964221" }).entries).toHaveLength(1)
    expect(store.query({ q: "1076964221" }).entries[0]).toMatchObject({
      selection: null,
      ticketNumber: "1076964221",
    })
    expect(store.query({ market: "L" }).entries[0]).toMatchObject({
      selection: {
        source: "bet-description",
        listedNumber: "543",
        gameId: null,
        period: "Game",
        market: "Total",
        pick: "Over",
      },
    })
  })

  test("weblog inspect respects terminal width and row caps in Bun and Node", () => {
    const store = createWebLogStore()
    store.setCapture(
      [
        {
          account: "ACCOUNT1",
          time: "2026-11-19 08:22:01",
          address: "2001:db8:1234:5678::9",
          operation:
            "Chosen Team : A Long Selected Team Name | Game Num : 619137349 | Wager Number : 203 | Item Number : 1",
        },
        {
          account: "ACCOUNT1",
          time: "2026-11-19 08:22:00",
          address: "2001:db8:1234:5678::9",
          operation: "Login successful",
        },
      ],
      true,
    )
    const options = {
      colors: false,
      compact: true,
      depth: 3,
      showHidden: true,
      breakLength: 56,
      maxArrayLength: 1,
      maxStringLength: 18,
    }
    const report = store.query({ ...options, showOptions: true })
    const view = new WebLogView(report.entries, {
      sort: "time",
      dir: "desc",
      totalCount: 2,
      showOptions: true,
      inspectOptions: options,
    })
    const native = Bun.inspect(view, options)
    expect(native).toBe(inspect(view, options))
    expect(native).toBe(report.inspectAnsi)
    expect(native).toContain("Game 619137349")
    expect(native).toContain("maxArrayLength=1")
    expect(native).not.toContain("Successful login")
    expect(native).not.toContain("2001:db8:1234:5678::9")
    for (const output of [native, report.tableInspectAnsi, report.vectorInspectAnsi]) {
      expect(
        stripAnsi(output)
          .split("\n")
          .every((line) => line.length <= 56),
      ).toBe(true)
    }
    expect(store.query({ ...options, depth: 0 }).inspectAnsi).not.toContain("Game 619137349")
  })

  test("weblog operation variants keep exact subsecond source time and private details", () => {
    expect(parseFantasy402Action("Round Robin / Selections : 2s 3 Parlay(s)").eventKind).toBe("ROUND_ROBIN_SELECTION")
    const store = createWebLogStore()
    const scope = { account: "ACCOUNT1", address: "192.0.2.10" }
    store.setCapture(
      [
        {
          ...scope,
          time: "2026-11-19 08:22:03.975",
          operation: "Straight Lines Displayed (M) [v43.0.27 | www.fantasy402.com]",
        },
        {
          ...scope,
          time: "2026-11-19 08:22:03.120",
          operation: "View Pending (M) injected-private-value",
        },
        { ...scope, time: "2026-11-19 08:22:03.620", operation: "CHANGE LINE TOTAL / PRICE (M)" },
        {
          ...scope,
          time: "2026-11-19 08:22:04.000",
          operation: "API LOG | PARLAY | UPDATE | Ticket: 1076964221",
        },
      ],
      true,
    )
    const result = store.query({ colors: false })
    expect(result.entries.map((row) => row.rawAction)).toEqual([
      "API parlay update",
      "Straight lines displayed",
      "Total price change",
      "View pending wagers",
    ])
    expect(result.entries[1]).toMatchObject({
      sourceTime: "2026-11-19 08:22:03.975",
      timeEst: "08:22:03.975 AM",
      interArrivalSec: 0.355,
      eventKind: "LINES_DISPLAYED",
    })
    expect(result.entries[2]?.interArrivalSec).toBe(0.5)
    expect(result.entries[0]?.ticketNumber).toBe("1076964221")
    expect(result.kinds).toContainEqual({ kind: "LINE_CHANGE", count: 1 })
    expect(result.inspectAnsi).toContain("0.355s")
    expect(JSON.stringify(result)).not.toContain("injected-private-value")
  })

  test("weblog site profiles preserve bracketed metadata and keep action origin unverified", () => {
    const store = createWebLogStore()
    const scope = { account: "ACCOUNT1", address: "192.0.2.10" }
    store.setCapture(
      [
        {
          ...scope,
          time: "2026-11-19 23:27:35.120",
          operation: "(M) View Pending (M) [ v1.0.288 | betolive.ag ]",
        },
        {
          ...scope,
          time: "2026-11-19 23:27:33.120",
          operation: "(M) Login successful (M) [ v1.0.288 | BETOLIVE.AG ]",
        },
        { ...scope, time: "2026-11-19 23:27:32.122", operation: "Login successful Token" },
        { ...scope, time: "2026-11-19 23:25:00.121", operation: "API LOG | Ticket: 1076964221" },
        {
          ...scope,
          time: "2026-11-19 23:22:00.121",
          operation: "(M) View Pending (D) [ v1.0.290 | https://raw-marker.invalid/path ]",
        },
      ],
      true,
    )
    const all = store.query()
    expect(all.entries[0]).toMatchObject({
      portalHost: "betolive.ag",
      clientVersion: "v1.0.288",
      deviceMarker: "M",
      apiMarked: false,
    })
    expect(all.entries[2]).toMatchObject({
      eventKind: "LOGIN_TOKEN",
      portalHost: null,
      clientVersion: null,
    })
    expect(all.entries[3]).toMatchObject({
      eventKind: "API_TICKET",
      apiMarked: true,
      portalHost: null,
    })
    expect(all.entries[4]).toMatchObject({ deviceMarker: null, portalHost: null })
    expect(JSON.stringify(all)).not.toContain("raw-marker.invalid")
    expect(all.clients).toEqual({
      rowsWithSiteVersion: 2,
      siteCount: 1,
      versionCount: 1,
      profileCount: 1,
      profiles: [
        {
          site: "betolive.ag",
          version: "v1.0.288",
          count: 2,
          operations: [
            { kind: "LOGIN_SUCCESS", count: 1 },
            { kind: "VIEW", count: 1 },
          ],
        },
      ],
    })
    expect(store.query({ site: "BETOLIVE.AG", version: "v1.0.288", limit: 1 }).summary.filteredEntries).toBe(2)
    expect(store.query({ site: "betolive.ag", version: "v1.0.290" }).entries).toHaveLength(0)
    expect(store.query({ q: "betolive.ag" }).entries).toHaveLength(2)
  })
})

describe("F4: adminGuard (x-admin-token) & Strict Command Allowlist on /api/terminal/exec", () => {
  const ENV = {
    NODE_ENV: "production",
    SPORTSDESK_DASHBOARD_TOKEN: "op-token-123",
    SPORTSDESK_ADMIN_TOKEN: "admin-token-456",
  }

  test("adminGuard fails closed when the authorization hook is missing or throws", async () => {
    const request = new Request("http://127.0.0.1:3000/api/terminal/exec", { method: "POST" })
    const inner = () => {
      throw new Error("privileged handler must not run")
    }
    const broken = () => {
      throw new Error("verification unavailable")
    }
    expect((await adminGuard(undefined, inner)(request)).status).toBe(403)
    expect((await adminGuard(broken, inner)(request)).status).toBe(403)
  })

  test("rejects anonymous (401), missing x-admin-token (403), and wrong x-admin-token (403) on /api/terminal/exec", async () => {
    const { api } = makeTestApi(ENV)

    const anonRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "help" }),
      }),
    )
    expect(anonRes.status).toBe(401)

    // Operator Bearer without x-admin-token is blocked (403)
    const opRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SPORTSDESK_DASHBOARD_TOKEN}`,
        },
        body: JSON.stringify({ command: "help" }),
      }),
    )
    expect(opRes.status).toBe(403)

    // Even Admin Bearer WITHOUT x-admin-token header is blocked in production (403)
    const adminBearerWithoutHeader = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SPORTSDESK_ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ command: "help" }),
      }),
    )
    expect(adminBearerWithoutHeader.status).toBe(403)
    const missingBody = (await adminBearerWithoutHeader.json()) as { code: string }
    expect(missingBody.code).toBe("ADMIN_TOKEN_REQUIRED")

    // Wrong x-admin-token is blocked (403)
    const wrongAdminHeader = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SPORTSDESK_DASHBOARD_TOKEN}`,
          "x-admin-token": "wrong-admin-secret",
        },
        body: JSON.stringify({ command: "help" }),
      }),
    )
    expect(wrongAdminHeader.status).toBe(403)
  })

  test("enforces command allowlist and rejects shell metacharacters even with valid x-admin-token", async () => {
    const { api } = makeTestApi(ENV)

    const disallowed = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SPORTSDESK_DASHBOARD_TOKEN}`,
          "x-admin-token": ENV.SPORTSDESK_ADMIN_TOKEN,
        },
        body: JSON.stringify({ command: "cat /etc/passwd" }),
      }),
    )
    expect(disallowed.status).toBe(400)

    const injection = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SPORTSDESK_DASHBOARD_TOKEN}`,
          "x-admin-token": ENV.SPORTSDESK_ADMIN_TOKEN,
        },
        body: JSON.stringify({ command: "help; id" }),
      }),
    )
    expect(injection.status).toBe(400)

    const allowed = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ENV.SPORTSDESK_DASHBOARD_TOKEN}`,
          "x-admin-token": ENV.SPORTSDESK_ADMIN_TOKEN,
        },
        body: JSON.stringify({ command: "help" }),
      }),
    )
    expect(allowed.status).toBe(200)
    const json = (await allowed.json()) as { stdout: string }
    expect(json.stdout).toBe("executed:help")
  })

  test("fails closed (503) when SPORTSDESK_ADMIN_TOKEN is unset", async () => {
    const { api } = makeTestApi({
      NODE_ENV: "production",
      SPORTSDESK_DASHBOARD_TOKEN: "op-only-token",
    })
    const res = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer op-only-token",
          "x-admin-token": "anything",
        },
        body: JSON.stringify({ command: "help" }),
      }),
    )
    expect(res.status).toBe(503)
  })
})

describe("F5: Security Headers & Telegram Mini-App Frame Ancestors", () => {
  test("production security headers include CSP with Telegram frame-ancestors, nosniff, Referrer-Policy, Permissions-Policy, and HSTS", () => {
    const headers = buildSecurityHeaders({ isProd: true, isHttps: true })
    expect(headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(headers["Referrer-Policy"]).toBe("no-referrer")
    expect(headers["Permissions-Policy"]).toContain("camera=()")
    expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000")
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors")
    expect(headers["Content-Security-Policy"]).toContain("https://web.telegram.org")
    expect(headers["Content-Security-Policy"]).toContain("https://*.telegram.org")
    expect(headers["Content-Security-Policy"]).toContain("telegram:")
    expect(headers["Content-Security-Policy"]).toContain("object-src 'none'")
    expect(headers["X-Frame-Options"]).toBeUndefined()
  })

  test("nonced production CSP splits style-src-elem and style-src-attr and applies strict-dynamic", () => {
    const nonceA = generateCspNonce()
    const nonceB = generateCspNonce()
    expect(nonceA).not.toBe(nonceB)
    expect(Buffer.from(nonceA, "base64").byteLength).toBe(16)

    const strictHeaders = buildSecurityHeaders({
      isProd: true,
      isHttps: true,
      nonce: nonceA,
      styleAttrPolicy: "none",
    })
    const strictCsp = strictHeaders["Content-Security-Policy"]!
    expect(strictCsp).toContain(`script-src 'self' 'nonce-${nonceA}' 'strict-dynamic'`)
    expect(strictCsp).toContain(`style-src 'self' 'nonce-${nonceA}'`)
    expect(strictCsp).toContain(`style-src-elem 'self' 'nonce-${nonceA}'`)
    expect(strictCsp).toContain("style-src-attr 'none'")
    expect(strictCsp).not.toContain("style-src-elem 'self' 'unsafe-inline'")

    const inlineAttrHeaders = buildSecurityHeaders({
      isProd: true,
      isHttps: true,
      nonce: nonceB,
      styleAttrPolicy: "unsafe-inline",
    })
    const inlineAttrCsp = inlineAttrHeaders["Content-Security-Policy"]!
    expect(inlineAttrCsp).toContain(`style-src-elem 'self' 'nonce-${nonceB}'`)
    expect(inlineAttrCsp).toContain("style-src-attr 'unsafe-inline'")
  })

  test("injectCspNonceIntoHtml places meta[property=csp-nonce] with nonce attr (never content) right after charset and nonces script/style/stylesheet tags", () => {
    const nonce = generateCspNonce()
    const rawHtml = [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="UTF-8" />',
      '    <link rel="stylesheet" href="/assets/index-abc123.css" />',
      '    <link rel="icon" href="/favicon.ico" />',
      "    <style>body { color: #fff; }</style>",
      '    <script type="application/ld+json">{"@type":"WebApplication"}</script>',
      "  </head>",
      '  <body><script type="module" src="/assets/index-abc123.js"></script></body>',
      "</html>",
    ].join("\n")

    const injected = injectCspNonceIntoHtml(rawHtml, nonce)
    const charsetIdx = injected.indexOf('<meta charset="UTF-8" />')
    const metaNonceTag = `<meta property="csp-nonce" nonce="${nonce}" />`
    const metaNonceIdx = injected.indexOf(metaNonceTag)
    const firstLinkIdx = injected.indexOf("<link")

    expect(metaNonceIdx).toBeGreaterThan(charsetIdx)
    expect(metaNonceIdx).toBeLessThan(firstLinkIdx)
    expect(injected).not.toMatch(/<meta\b[^>]*csp-nonce[^>]*\bcontent=/i)

    expect(injected).toContain(`<link nonce="${nonce}" rel="stylesheet" href="/assets/index-abc123.css" />`)
    expect(injected).toContain('<link rel="icon" href="/favicon.ico" />')
    expect(injected).toContain(`<style nonce="${nonce}">body { color: #fff; }</style>`)
    expect(injected).toContain(`<script nonce="${nonce}" type="application/ld+json">`)
    expect(injected).toContain(`<script nonce="${nonce}" type="module" src="/assets/index-abc123.js"></script>`)

    expect(() => injectCspNonceIntoHtml(rawHtml, 'bad"nonce')).toThrow(RangeError)
  })

  test("sendNoncedHtmlShell enforces Cache-Control: private, no-store, omits ETag/Last-Modified, and matches CSP header nonce to HTML body", () => {
    const headers = new Map<string, string>([
      ["etag", 'W/"stale-etag"'],
      ["last-modified", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ])
    let statusCode = 0
    let bodyBuf: Buffer | null = null
    const mockRes = {
      status(code: number) {
        statusCode = code
        return this
      },
      setHeader(name: string, value: string | number | readonly string[]) {
        headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value))
        return this
      },
      removeHeader(name: string) {
        headers.delete(name.toLowerCase())
      },
      end(chunk?: unknown) {
        bodyBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk ?? ""), "utf8")
        return this
      },
    }

    const nonce = sendNoncedHtmlShell(mockRes as never, {
      html: '<!doctype html><html><head><meta charset="UTF-8" /><link rel="stylesheet" href="/assets/app.css" /></head><body><script type="module" src="/assets/app.js"></script></body></html>',
      isProd: true,
      isHttps: true,
    })

    expect(statusCode).toBe(200)
    expect(headers.get("cache-control")).toBe(NONCED_HTML_CACHE_CONTROL)
    expect(headers.get("cache-control")).toBe("private, no-store")
    expect(headers.has("etag")).toBe(false)
    expect(headers.has("last-modified")).toBe(false)
    expect(HASHED_ASSET_CACHE_CONTROL).toBe("public, max-age=31536000, immutable")

    const csp = headers.get("content-security-policy") ?? ""
    expect(csp).toContain(`'nonce-${nonce}'`)
    expect(csp).toContain(`style-src-elem 'self' 'nonce-${nonce}'`)

    const bodyText = bodyBuf!.toString("utf8")
    expect(bodyText).toContain(`<meta property="csp-nonce" nonce="${nonce}" />`)
    expect(bodyText).toContain(`<script nonce="${nonce}" type="module" src="/assets/app.js"></script>`)
  })

  test("public allowlist strictly limits unauthenticated routes", () => {
    expect(isPublicApiRoute("/health", "GET")).toBe(true)
    expect(isPublicApiRoute("/api/health", "GET")).toBe(true)
    expect(isPublicApiRoute("/api/auth/me", "GET")).toBe(true)
    expect(isPublicApiRoute("/api/auth/login", "POST")).toBe(true)
    expect(isPublicApiRoute("/api/auth/logout", "POST")).toBe(true)
    expect(isPublicApiRoute("/api/health/detail", "GET")).toBe(false)
    expect(isPublicApiRoute("/api/wagers", "GET")).toBe(false)
    expect(isPublicApiRoute("/api/weblogs", "GET")).toBe(false)
    expect(isPublicApiRoute("/api/terminal/exec", "POST")).toBe(false)
  })
})

describe("F6: Minimal Public Health vs Authenticated Detail", () => {
  const ENV = {
    NODE_ENV: "production",
    SPORTSDESK_DASHBOARD_TOKEN: "op-token-123",
  }

  test("GET /health and GET /api/health return ONLY status and version", async () => {
    const { api } = makeTestApi(ENV)
    for (const path of ["/health", "/api/health"]) {
      const res = await api.fetch(new Request(`http://127.0.0.1:3000${path}`))
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual(["status", "version"])
      expect(typeof body.version).toBe("string")
      expect((body.version as string).length).toBeGreaterThan(0)
      expect(body.runtime).toBeUndefined()
      expect(body.port).toBeUndefined()
      expect(body.bunVersion).toBeUndefined()
      expect(body.db).toBeUndefined()
      expect(body.alerts).toBeUndefined()
      expect(body.purgedSessions).toBeUndefined()
      expect(body.uptimeSeconds).toBeUndefined()
      expect(body.timestamp).toBeUndefined()
    }
  })

  test("GET /api/health/detail requires auth and returns internal diagnostics (runtime, db, alerts) once authenticated", async () => {
    const { api } = makeTestApi(ENV)
    const denied = await api.fetch(new Request("http://127.0.0.1:3000/api/health/detail"))
    expect(denied.status).toBe(401)

    // Verify with authenticated session cookie (POST /api/auth/login -> sd_session)
    const loginRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatorId: "health-auditor",
          token: ENV.SPORTSDESK_DASHBOARD_TOKEN,
        }),
      }),
    )
    expect(loginRes.status).toBe(200)
    const sessionCookie = loginRes.headers
      .getSetCookie()
      .find((c) => c.startsWith("sd_session="))
      ?.split(";")[0]
    expect(sessionCookie).toBeDefined()

    const sessionRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/health/detail", {
        headers: { Cookie: sessionCookie! },
      }),
    )
    expect(sessionRes.status).toBe(200)
    const sessionBody = (await sessionRes.json()) as Record<string, unknown>
    expect(sessionBody.service).toBe("sportsdesk-dev-dashboard")
    expect(typeof sessionBody.version).toBe("string")
    expect(typeof sessionBody.runtime).toBe("string")
    expect(sessionBody.db).toBe("unconfigured")
    expect(sessionBody.alerts).toBeDefined()
    expect(typeof sessionBody.timestamp).toBe("string")

    // Verify with Bearer token as well
    const ok = await api.fetch(
      new Request("http://127.0.0.1:3000/api/health/detail", {
        headers: { Authorization: `Bearer ${ENV.SPORTSDESK_DASHBOARD_TOKEN}` },
      }),
    )
    expect(ok.status).toBe(200)
    const body = (await ok.json()) as Record<string, unknown>
    expect(body.service).toBe("sportsdesk-dev-dashboard")
    expect(typeof body.version).toBe("string")
    expect(typeof body.runtime).toBe("string")
    expect(body.db).toBe("unconfigured")
    expect(body.alerts).toBeDefined()
    expect(typeof body.timestamp).toBe("string")
  })
})
