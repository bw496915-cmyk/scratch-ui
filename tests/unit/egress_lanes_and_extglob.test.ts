import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  ApiBaseError,
  createCsrfGuard,
  createDashboardBunServer,
  createShiftSessionLogStore,
  type DashboardApiDeps,
  deriveWebSocketUrl,
  EgressPolicyError,
  fetchDaemonHealth,
  fetchFantasy402,
  fetchPolygonscanAddress,
  fetchPolymarketPositions,
  fetchR2PublicObject,
  fetchServeLocalTokens,
  issueCsrf,
  loadEgressTransportFromEnv,
  loadValidatedEgressOrigins,
  outboundFetch,
  parseValidatedApiBaseUrl,
  proxyResponseHeaders,
  requireCsrfSecret,
  resolveUnder,
  validatedOrigin,
  verifyCsrfToken,
  withCsrf,
} from "../../packages/api/src/index.ts"
import {
  dashboardUrl,
  DEFAULT_DASHBOARD_URL_STATE,
  NON_FETCHING_PARSE_BASE,
} from "../../packages/ui/src/url_state.ts"

const ROOT = resolve(import.meta.dir, "../..")

function createMinimalDeps(): DashboardApiDeps {
  return {
    enforceAuth: async () => null,
    shiftLogs: createShiftSessionLogStore(20),
    auth: {
      login: async () => Response.json({ ok: true }),
      logout: async () => Response.json({ ok: true }),
      me: async () => Response.json({ authenticated: true }),
    },
    getHealthPayload: () => ({ status: "ok" }),
    loadDashboardMarkdown: async () => ({ stamp: "1", markdown: "# Desk", html: "<h1>Desk</h1>" }),
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
    execTerminal: async () => ({ ok: true }),
    rankings: {
      getAll: async () => ({ generatedAtIso: "2026-11-23T00:00:00Z", payload: { rows: [] } }),
      getConduits: async () => [],
    },
    getLiveWagersPayload: async () => ({ wagers: [{ ticketId: "T-1" }] }),
    getTiersConfig: async () => ({ tiers: {} }),
    alerts: {
      sweepOnce: async () => ({ sent: 0, failed: 0, dead: 0 }),
      list: () => [],
      ack: async () => true,
      retry: async () => "replayed-1",
      getShiftSummary: () => ({}),
    },
    getTaxonomyCatalog: () => [],
    runShadowPricing: async () => ({}),
    getBuildMatrix: async () => ({ targets: [], generatedAt: "" }),
  }
}

describe("Lanes A & B — Explicit route table with zero /api/* catch-all", () => {
  const handle = createDashboardBunServer(createMinimalDeps(), {
    port: 0,
    rootResponse: new Response("SportsDesk Shell", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  })

  afterAll(() => {
    handle.stop(true)
  })

  test("api.routes contains no /api/* wildcard catch-all", () => {
    expect("/api/*" in handle.api.routes).toBe(false)
  })

  test("Lane A serves / and /app, and redirects /live-bets -> /wagers with 308", async () => {
    const rootRes = await fetch(handle.url)
    expect(rootRes.status).toBe(200)
    expect(await rootRes.text()).toBe("SportsDesk Shell")

    const appRes = await fetch(new URL("/app", handle.url))
    expect(appRes.status).toBe(200)
    expect(await appRes.text()).toBe("SportsDesk Shell")

    const redirectRes = await fetch(new URL("/live-bets", handle.url), { redirect: "manual" })
    expect(redirectRes.status).toBe(308)
    expect(redirectRes.headers.get("location")).toBe("/wagers")
  })

  test("Lane B aliases collapse to identical payloads and unlisted /api/* returns 404", async () => {
    const [wagers, liveWagers, liveBets, rankings, rankingsAll] = await Promise.all([
      fetch(new URL("/api/wagers", handle.url)),
      fetch(new URL("/api/live-wagers", handle.url)),
      fetch(new URL("/api/live-bets", handle.url)),
      fetch(new URL("/api/rankings", handle.url)),
      fetch(new URL("/api/rankings/all", handle.url)),
    ])
    expect(wagers.status).toBe(200)
    expect(liveWagers.status).toBe(200)
    expect(liveBets.status).toBe(200)
    expect(await wagers.json()).toEqual(await liveBets.json())
    expect(rankings.status).toBe(200)
    expect(rankingsAll.status).toBe(200)

    const unlisted = await fetch(new URL("/api/does-not-exist-anywhere", handle.url))
    expect(unlisted.status).toBe(404)
  })
})

describe("Lane C — Bun.CSRF bound to sessionId with withCsrf", () => {
  const SECRET = "test-csrf-secret-32-bytes-minimum-key!"

  test("requireCsrfSecret throws at boot when CSRF_SECRET is missing", () => {
    expect(() => requireCsrfSecret({})).toThrow("CSRF_SECRET required")
    expect(requireCsrfSecret({ CSRF_SECRET: SECRET })).toBe(SECRET)
  })

  test("token validates only for matching sessionId and fails across sessions", () => {
    const tokenA = issueCsrf("session-alpha", { secret: SECRET })
    expect(verifyCsrfToken(tokenA, "session-alpha", { secret: SECRET })).toBe(true)
    expect(verifyCsrfToken(tokenA, "session-bravo", { secret: SECRET })).toBe(false)
    expect(verifyCsrfToken(tokenA, "session-alpha", { secret: "wrong-secret" })).toBe(false)
  })

  test("withCsrf rejects missing cookie, missing header, or cross-session token with 403", async () => {
    const guard = createCsrfGuard({ secret: SECRET })
    const guarded = guard.withCsrf(async () => Response.json({ reset: true }))

    const noCookie = await guarded(
      new Request("https://desk.bookdeskops.com/api/weblogs/reset", { method: "POST" }),
    )
    expect(noCookie.status).toBe(403)

    const tok = guard.issueCsrf("sess-123")
    const wrongSession = await guarded(
      new Request("https://desk.bookdeskops.com/api/weblogs/reset", {
        method: "POST",
        headers: {
          cookie: "sd_session=sess-999",
          "x-csrf-token": tok,
        },
      }),
    )
    expect(wrongSession.status).toBe(403)

    const valid = await guarded(
      new Request("https://desk.bookdeskops.com/api/weblogs/reset", {
        method: "POST",
        headers: {
          cookie: "sd_session=sess-123",
          "x-csrf-token": tok,
        },
      }),
    )
    expect(valid.status).toBe(200)
    expect(await valid.json()).toEqual({ reset: true })

    // Also verify direct withCsrf helper with BunRequest-style cookies map
    const reqWithCookies = Object.assign(
      new Request("https://desk.bookdeskops.com/api/terminal/exec", {
        method: "POST",
        headers: { "x-csrf-token": tok },
      }),
      {
        cookies: {
          get: (name: string) => (name === "session" ? "sess-123" : null),
        },
      },
    )
    const directGuarded = withCsrf(async () => Response.json({ ok: true }), { secret: SECRET })
    expect((await directGuarded(reqWithCookies)).status).toBe(200)
  })
})

describe("Lane D — Derive ws:// and wss:// from origin protocol", () => {
  test("derives wss:// under https:// and ws:// under http://", () => {
    expect(deriveWebSocketUrl("https://desk.bookdeskops.com/wagers")).toBe(
      "wss://desk.bookdeskops.com/ws",
    )
    expect(deriveWebSocketUrl("http://127.0.0.1:3000/app", "/ws", { dev_session: "abc" })).toBe(
      "ws://127.0.0.1:3000/ws?dev_session=abc",
    )
  })
})

describe("Lanes E, F, G — Boot-validated origins, outboundFetch, proxy/target TLS separation", () => {
  test("validatedOrigin fails fast at boot on invalid URLs, schemes, or credentials", () => {
    expect(() => validatedOrigin("SPORTSDESK_API_ORIGIN", "not-a-url", {})).toThrow()
    expect(() =>
      validatedOrigin("SPORTSDESK_API_ORIGIN", "http://127.0.0.1:4020", {
        SPORTSDESK_API_ORIGIN: "ftp://127.0.0.1:4020",
      }),
    ).toThrow("bad protocol")
    expect(() =>
      validatedOrigin("SPORTSDESK_API_ORIGIN", "http://127.0.0.1:4020", {
        SPORTSDESK_API_ORIGIN: "https://user:pass@127.0.0.1:4020",
      }),
    ).toThrow("credentials")

    const origins = loadValidatedEgressOrigins({})
    expect(origins.API_ORIGIN.origin).toBe("http://127.0.0.1:4020")
    expect(origins.SERVE_LOCAL.origin).toBe("http://127.0.0.1:8787")
    expect(origins.R2_PUBLIC_ORIGIN.hostname).toBe("pub-d061f943df0e4477ba7ff200721eddb1.r2.dev")
    expect(origins.R2_S3_ORIGIN).toBeNull()
    expect(origins.FANTASY402.origin).toBe("https://fantasy402.com")
  })

  test("outboundFetch enforces exact host allowlist and refuses 3xx redirects", async () => {
    const mockOk = async () => new Response(JSON.stringify({ ok: true }), { status: 200 })

    await expect(
      outboundFetch(new URL("https://evil.example/health"), {}, {
        allow: ["fantasy402.com"],
        fetchImpl: mockOk,
      }),
    ).rejects.toBeInstanceOf(EgressPolicyError)

    let cancelled = false
    const mockRedirect = async () => {
      const body = new ReadableStream({
        cancel() {
          cancelled = true
        },
      })
      return new Response(body, {
        status: 302,
        headers: { location: "http://127.0.0.1:4020/admin" },
      })
    }

    await expect(
      outboundFetch(new URL("https://fantasy402.com/api"), {}, {
        allow: ["fantasy402.com"],
        fetchImpl: mockRedirect,
      }),
    ).rejects.toThrow("redirect refused")
    expect(cancelled).toBe(true)
  })

  test("Lane E/F/G helpers encode path params, isolate Lane G credentials, and separate proxy TLS", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = []
    const captureFetch = async (input: URL | string, init?: RequestInit) => {
      seen.push({ url: String(input), init })
      return new Response("{}", { status: 200 })
    }

    await fetchDaemonHealth(new URL("http://127.0.0.1:4020"), { fetchImpl: captureFetch })
    await fetchServeLocalTokens(new URL("http://127.0.0.1:8787"), { fetchImpl: captureFetch })
    await fetchFantasy402("status", { fetchImpl: captureFetch })
    await fetchPolymarketPositions("0xabc/../../evil", { fetchImpl: captureFetch })
    await fetchPolygonscanAddress("0xabc?x=1", { fetchImpl: captureFetch })
    await fetchR2PublicObject("bet-ticker/latest.json", undefined, { fetchImpl: captureFetch })

    expect(seen.map((s) => s.url)).toEqual([
      "http://127.0.0.1:4020/health",
      "http://127.0.0.1:8787/_dev/serve-local/tokens",
      "https://fantasy402.com/status",
      "https://data-api.polymarket.com/v2/positions?user=0xabc%2F..%2F..%2Fevil",
      "https://polygonscan.com/address/0xabc%3Fx%3D1",
      "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/bet-ticker/latest.json",
    ])

    // Lane G strips Authorization/Cookie headers automatically
    let r2Headers: Headers | null = null
    await outboundFetch(
      new URL("https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev/a.json"),
      { headers: { Authorization: "Bearer secret", Cookie: "sd_session=1", Accept: "*/*" } },
      {
        allow: ["pub-d061f943df0e4477ba7ff200721eddb1.r2.dev"],
        allowCredentials: false,
        proxy: null,
        fetchImpl: async (_u, init) => {
          r2Headers = new Headers(init?.headers)
          return new Response("ok")
        },
      },
    )
    expect(r2Headers!.has("authorization")).toBe(false)
    expect(r2Headers!.has("cookie")).toBe(false)
    expect(r2Headers!.get("accept")).toBe("*/*")

    // Separate proxy CA vs origin CA
    const transport = loadEgressTransportFromEnv(
      {
        HTTPS_PROXY: "http://proxy.corp.internal:3128",
        PROXY_AUTH: "Basic dXNlcjpwYXNz",
        PROXY_CA: "/etc/ssl/proxy-ca.pem",
        ORIGIN_CA: "/etc/ssl/origin-ca.pem",
      },
      (path) => `CERT:${path}`,
    )
    expect(transport.usesHttpsProxyScheme).toBe(false)
    expect(transport.proxy?.tls?.ca).toBe("CERT:/etc/ssl/proxy-ca.pem")
    expect(transport.targetTls?.ca).toBe("CERT:/etc/ssl/origin-ca.pem")

    // Fast Headers copy strips transfer-encoding
    const copied = proxyResponseHeaders(
      new Headers({ "content-type": "application/json", "transfer-encoding": "chunked" }),
    )
    expect(copied).toEqual({ "content-type": "application/json" })
  })
})

describe("Lane H — No mDNS-resolvable .local synthetic parser bases", () => {
  test("UI URL helpers use non-fetching RFC 2606 .invalid base and zero .local literals remain", () => {
    expect(NON_FETCHING_PARSE_BASE).toBe("https://non-fetching.invalid")
    expect(dashboardUrl({ ...DEFAULT_DASHBOARD_URL_STATE, tab: "wagers" }, "/")).toBe("/?tab=wagers")

    for (const rel of [
      "packages/ui/src/url_state.ts",
      "packages/ui/src/fast_signin.ts",
      "packages/ui/src/ticket_inspector.ts",
      "packages/ui/src/desk_quick_jump.ts",
    ]) {
      const src = readFileSync(resolve(ROOT, rel), "utf8")
      expect(src).not.toContain("http://dashboard.local")
      expect(src).not.toContain('"http://local"')
    }
  })
})

describe("Lane I — validateApiBase + resolveUnder post-join containment", () => {
  test("blocks subdomain smuggling, punycode, credentials, and path/origin escapes", () => {
    const valid = parseValidatedApiBaseUrl("https://desk.bookdeskops.com/v1", {
      allowLoopback: false,
    })
    expect(valid.href).toBe("https://desk.bookdeskops.com/v1")

    const resolved = resolveUnder(valid, "api/wagers")
    expect(resolved.href).toBe("https://desk.bookdeskops.com/v1/api/wagers")

    expect(() => resolveUnder(valid, "../secret")).toThrow(ApiBaseError)
    expect(() => resolveUnder(valid, "..%2f..%2fsecret")).toThrow(ApiBaseError)
    expect(() => resolveUnder(valid, "//evil.example/api")).toThrow(ApiBaseError)
    expect(() => resolveUnder(valid, "https://evil.example/v1/api")).toThrow(ApiBaseError)
    expect(() => parseValidatedApiBaseUrl("https://a.b.bookdeskops.com", { allowLoopback: false })).toThrow(
      ApiBaseError,
    )
    expect(() => parseValidatedApiBaseUrl("https://xn--desk.bookdeskops.com", { allowLoopback: false })).toThrow(
      ApiBaseError,
    )
  })
})

describe("Bun 1.4.4 extglob & brace-range verification harness (both directions)", () => {
  test("silent-miss check: asset and source extglobs still match all intended files", () => {
    const brandingImages = new Bun.Glob("public/assets/branding/!(*.json)")
    const matchedImages = [...brandingImages.scanSync(ROOT)].sort()
    expect(matchedImages).toEqual([
      "public/assets/branding/sportsdesk-emblem-180.png",
      "public/assets/branding/sportsdesk-emblem-512.png",
      "public/assets/branding/sportsdesk-emblem-64.png",
      "public/assets/branding/sportsdesk-emblem.webp",
      "public/assets/branding/sportsdesk-og-card.jpg",
      "public/assets/branding/sportsdesk-og-card.webp",
    ])
    expect(brandingImages.match("public/assets/branding/branding-metadata.json")).toBe(false)

    const srcGlob = new Bun.Glob("**/!(*.test).ts")
    expect(srcGlob.match("packages/api/src/router.ts")).toBe(true)
    expect(srcGlob.match("packages/api/src/outbound_fetch.ts")).toBe(true)
    expect(srcGlob.match("tests/unit/bun_serve_routes.test.ts")).toBe(false)
  })

  test("silent-widen check: workspace & operator globs match exact enumerated sets + portable char-class escape", () => {
    const nonUiPackages = new Bun.Glob("packages/!(ui)")
    const matchedDirs = [...nonUiPackages.scanSync({ cwd: ROOT, onlyFiles: false })].sort()
    expect(matchedDirs).toEqual(["packages/api", "packages/backend", "packages/contracts"])

    const operatorAvatars = new Bun.Glob("public/assets/operators/*.webp")
    const matchedAvatars = [...operatorAvatars.scanSync(ROOT)].sort()
    expect(matchedAvatars).toEqual([
      "public/assets/operators/operator-audit.webp",
      "public/assets/operators/operator-lead.webp",
      "public/assets/operators/operator-night.webp",
      "public/assets/operators/operator-quant.webp",
    ])

    // Portable character-class escape matches literal `(1)` without backslash hazard
    const escapedLiteral = new Bun.Glob("*[(]1).txt")
    expect(escapedLiteral.match("copy(1).txt")).toBe(true)
    expect(escapedLiteral.match("11.txt")).toBe(false)
  })

  test("brace-range cardinality guard stays exact and character-class brace stays literal", () => {
    const shardGlob = new Bun.Glob("shard-{1..3}.json")
    const candidates = [
      "shard-0.json",
      "shard-1.json",
      "shard-2.json",
      "shard-3.json",
      "shard-4.json",
      "shard-1..3.json",
    ]
    const matched = candidates.filter((c) => shardGlob.match(c))
    expect(matched).toEqual(["shard-1.json", "shard-2.json", "shard-3.json"])
    expect(matched.length).toBe(3)

    const literalRange = new Bun.Glob("shard-[{]1..3}.json")
    expect(literalRange.match("shard-{1..3}.json")).toBe(true)
    expect(literalRange.match("shard-2.json")).toBe(false)
  })
})
