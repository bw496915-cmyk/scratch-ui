import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  buildApiUrl,
  createConfigStatusStore,
  createDashboardApi,
  DASHBOARD_ROUTES,
  extractSingleApiBaseParam,
  hasCompiledApiBasePatterns,
  MAX_API_BASE_INPUT,
  validateApiBase,
  validateApiBaseWithPattern,
  validateConfigHttpUrl,
} from "../../packages/api/src/index.ts"
import {
  BUN_UTILITIES_CATALOG,
  compressDeflateText,
  compressGzipText,
  decodeBase64Utf8,
  deepEqualsSafe,
  encodeBase64Utf8,
  escapeHtmlSafe,
  fileUrlToPathSafe,
  findAllowlistedExecutable,
  generateUuidV7,
  hashPasswordPreview,
  inspectModuleMetaSnapshot,
  pathToFileUrlSafe,
  resolveSpaDecoupleStatus,
  sleepMs,
} from "../../packages/ui/src/bun_utilities.ts"
import { BunUtilitiesDecouplePanel } from "../../packages/ui/src/panels/BunUtilitiesDecouplePanel.tsx"

describe("packages/api Hardened API Base & URL Validation", () => {
  test("verifies startup URLPattern hasRegExpGroups compilation and fails closed when unavailable", () => {
    expect(hasCompiledApiBasePatterns()).toBe(true)

    class BrokenPattern {
      readonly hasRegExpGroups = false
      exec() {
        return null
      }
    }
    expect(hasCompiledApiBasePatterns(BrokenPattern as unknown as typeof URLPattern)).toBe(false)
    expect(
      validateApiBaseWithPattern("https://api.bookdeskops.com", false, BrokenPattern as unknown as typeof URLPattern),
    ).toEqual({
      ok: false,
      code: "ERR_API_BASE_PATTERN_UNAVAILABLE",
    })
  })

  test("enforces MAX_API_BASE_INPUT length cap, repetitive-slash normalization, backslash & duplicate param rejection", () => {
    expect(validateApiBase("https://desk-01.bookdeskops.com//v2///ops/", false)).toEqual({
      ok: true,
      normalized: "https://desk-01.bookdeskops.com/v2/ops",
      sub: "desk-01",
    })

    const oversized = `https://api.bookdeskops.com/${"x".repeat(MAX_API_BASE_INPUT)}`
    expect(validateApiBase(oversized, false)).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_URL",
    })

    expect(validateApiBase("https://api.bookdeskops.com\\v2", false)).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_URL",
    })
    expect(validateApiBase("http://127.0.0.1:0", true)).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_PORT",
    })
    expect(validateApiBase("https://api.bookdeskops.com?token=1", false)).toEqual({
      ok: false,
      code: "ERR_API_BASE_QUERY_OR_HASH_FORBIDDEN",
    })

    expect(extractSingleApiBaseParam("?apiBase=https://api.bookdeskops.com&apiBase=https://evil.example")).toEqual({
      present: true,
      ok: false,
      code: "ERR_API_BASE_DUPLICATE_PARAM",
    })
  })

  test("hardens buildApiUrl, config_status URL overrides, and router ?apiBase= guards", async () => {
    // buildApiUrl collapses repetitive slashes in base and route paths and rejects backslashes/oversized inputs
    expect(
      buildApiUrl("https://api.bookdeskops.com//v1///", DASHBOARD_ROUTES.agentsById, {
        id: "AG-7",
      }),
    ).toBe("https://api.bookdeskops.com/v1/api/agents/AG-7")
    expect(() => buildApiUrl("https://api.bookdeskops.com\\v1", DASHBOARD_ROUTES.health)).toThrow()
    expect(() =>
      buildApiUrl(`https://api.bookdeskops.com/${"a".repeat(MAX_API_BASE_INPUT)}`, DASHBOARD_ROUTES.health),
    ).toThrow()

    // validateConfigHttpUrl & createConfigStatusStore normalize repetitive slashes and reject unsafe URLs
    expect(validateConfigHttpUrl("http://127.0.0.1:4020//api///")).toEqual({
      ok: true,
      normalized: "http://127.0.0.1:4020/api",
    })
    expect(validateConfigHttpUrl("https://user:pass@example.com")).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    })

    const store = createConfigStatusStore({
      env: { NODE_ENV: "development" },
    })
    const okSave = store.saveOverrides({
      SPORTSDESK_API_ORIGIN: "http://127.0.0.1:4020///",
      SPORTSDESK_ALLOWED_ORIGINS: "https://api.bookdeskops.com///, http://localhost:4022/",
    })
    expect(okSave.ok).toBe(true)
    if (okSave.ok) {
      const originItem = okSave.snapshot.items.find((i) => i.key === "SPORTSDESK_API_ORIGIN")
      expect(originItem?.value).toBe("http://127.0.0.1:4020")
      const allowedItem = okSave.snapshot.items.find((i) => i.key === "SPORTSDESK_ALLOWED_ORIGINS")
      expect(allowedItem?.value).toBe("https://api.bookdeskops.com,http://localhost:4022")
    }

    const badSave = store.saveOverrides({
      SPORTSDESK_API_ORIGIN: "http://127.0.0.1:4020\\bad",
    })
    expect(badSave.ok).toBe(false)

    // Router rejects duplicate or untrusted ?apiBase= with HTTP 400
    const api = createDashboardApi({
      enforceAuth: async () => null,
      env: { NODE_ENV: "production" },
      auth: {
        login: async () => Response.json({ ok: true }),
        logout: async () => Response.json({ ok: true }),
        me: async () => Response.json({ authenticated: true }),
      },
      getHealthPayload: () => ({ status: "ok" }),
      loadDashboardMarkdown: async () => ({ stamp: "1", markdown: "", html: "" }),
      dns: {
        getTelemetryPayload: () => ({}),
        benchmark: async () => ({}),
        classifyIp: async () => ({}),
      },
      customers: {
        getCohortReport: async () => ({ versionStamp: "1", payload: {} }),
        getProfile: async () => null,
        getRating: async () => null,
      },
      execTerminal: async () => ({}),
      rankings: { getAll: async () => ({ generatedAtIso: "", payload: {} }), getConduits: async () => [] },
      getLiveWagersPayload: async () => ({}),
      getTiersConfig: async () => ({}),
      alerts: {
        sweepOnce: async () => ({}),
        list: () => [],
        ack: async () => true,
        retry: async () => null,
        getShiftSummary: () => ({}),
      },
      getTaxonomyCatalog: () => [],
      runShadowPricing: async () => ({}),
      getBuildMatrix: async () => ({ targets: [], generatedAt: "" }),
    })

    const dupRes = await api.fetch(
      new Request("https://ops.example.com/health?apiBase=https://api.bookdeskops.com&apiBase=https://evil.example"),
    )
    expect(dupRes.status).toBe(400)
    expect(((await dupRes.json()) as { code: string }).code).toBe("ERR_API_BASE_DUPLICATE_PARAM")

    const prodLoopbackRes = await api.fetch(new Request("https://ops.example.com/health?apiBase=http://127.0.0.1:4022"))
    expect(prodLoopbackRes.status).toBe(400)
    expect(((await prodLoopbackRes.json()) as { code: string }).code).toBe("ERR_API_BASE_ORIGIN_UNTRUSTED")

    const validRes = await api.fetch(
      new Request("https://ops.example.com/health?apiBase=https://api.bookdeskops.com//v2/"),
    )
    expect(validRes.status).toBe(200)
  })
})

describe("Local :4022 SPA Decoupling & All 19 Bun Runtime Utilities", () => {
  test("catalogs all 19 requested Bun Utilities and resolves SPA decoupling modes accurately", () => {
    expect(BUN_UTILITIES_CATALOG.length).toBe(19)
    const titles = BUN_UTILITIES_CATALOG.map((u) => u.title)
    expect(titles).toEqual([
      "Upgrade Bun",
      "Detect Bun",
      "Get Bun version",
      "Hash password",
      "Generate UUID",
      "Base64 encoding",
      "Gzip compression",
      "DEFLATE compression",
      "Escape HTML",
      "Deep equality",
      "Sleep",
      "File URL to path",
      "Path to file URL",
      "Find executable path",
      "import.meta.dir",
      "import.meta.file",
      "import.meta.path",
      "Check entrypoint",
      "Get entrypoint path",
    ])

    const local4022 = resolveSpaDecoupleStatus({
      location: {
        origin: "http://localhost:4022",
        href: "http://localhost:4022/",
        search: "",
      },
    })
    expect(local4022.mode).toBe("local-4022-spa")
    expect(local4022.isDecoupled).toBe(false)
    expect(local4022.patternsCompiled).toBe(true)

    const decoupled3000 = resolveSpaDecoupleStatus({
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/",
        search: "",
      },
    })
    expect(decoupled3000.mode).toBe("decoupled-origin")
    expect(decoupled3000.isDecoupled).toBe(true)
    expect(decoupled3000.badgeSuffix).toBe(":3000 decoupled")

    const overrideValid = resolveSpaDecoupleStatus({
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/?apiBase=https://api.bookdeskops.com//v2/",
        search: "?apiBase=https://api.bookdeskops.com//v2/",
      },
    })
    expect(overrideValid.mode).toBe("query-override")
    expect(overrideValid.apiBaseUrl).toBe("https://api.bookdeskops.com/v2")

    const overrideRejected = resolveSpaDecoupleStatus({
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/?apiBase=https://staging.bookdeskops.com",
        search: "?apiBase=https://staging.bookdeskops.com",
      },
    })
    expect(overrideRejected.mode).toBe("override-rejected")
    expect(overrideRejected.badgeSuffix).toContain("ERR_API_BASE_ORIGIN_UNTRUSTED")
  })

  test("executes interactive Bun utility primitives cleanly across Bun and browser fallbacks", async () => {
    const uuid = generateUuidV7()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    const encoded = encodeBase64Utf8("SportsDesk ⚡ 4022")
    expect(decodeBase64Utf8(encoded)).toBe("SportsDesk ⚡ 4022")

    const gz = await compressGzipText("sportsdesk-ops ".repeat(20))
    expect(gz.outputBytes).toBeGreaterThan(0)
    expect(gz.outputBytes).toBeLessThan(gz.inputBytes)

    const df = await compressDeflateText("sportsdesk-ops ".repeat(20))
    expect(df.outputBytes).toBeGreaterThan(0)
    expect(df.outputBytes).toBeLessThan(df.inputBytes)

    expect(escapeHtmlSafe("<script>\"x\" & 'y'</script>")).toBe(
      "&lt;script&gt;&quot;x&quot; &amp; &#x27;y&#x27;&lt;/script&gt;",
    )
    expect(deepEqualsSafe({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 }, true)).toBe(true)
    expect(deepEqualsSafe({ a: 1 }, { a: 1, b: undefined }, true)).toBe(false)

    const elapsed = await sleepMs(5)
    expect(elapsed).toBeGreaterThanOrEqual(0)

    const fileUrl = pathToFileUrlSafe("/app/packages/api/src/bun_server.ts")
    expect(fileUrl).toBe("file:///app/packages/api/src/bun_server.ts")
    expect(fileUrlToPathSafe(fileUrl)).toBe("/app/packages/api/src/bun_server.ts")

    const whichBun = findAllowlistedExecutable("bun")
    expect(whichBun.allowed).toBe(true)
    expect(typeof whichBun.resolvedPath).toBe("string")
    expect(findAllowlistedExecutable("rm -rf /").allowed).toBe(false)

    const meta = inspectModuleMetaSnapshot()
    expect(meta.importMetaFile).toContain("bun_utilities.ts")
    expect(meta.importMetaDir.length).toBeGreaterThan(0)
    expect(meta.importMetaPath).toContain("bun_utilities.ts")
    expect(typeof meta.importMetaMain).toBe("boolean")

    const pw = await hashPasswordPreview("test-passphrase-123")
    expect(pw.hash.length).toBeGreaterThan(20)
  })

  test("renders BunUtilitiesDecouplePanel with all 19 utilities and live validator output", () => {
    const html = renderToStaticMarkup(
      React.createElement(BunUtilitiesDecouplePanel, {
        open: true,
        onClose: () => {},
        serverRuntimeEngine: "bun/1.4.4",
      }),
    )
    expect(html).toContain("SportsDesk &amp; Fantasy402 Operations")
    expect(html).toContain("SPA Decoupling &amp; Bun Runtime Utilities")
    expect(html).toContain("sportsbook-risk-surveillance")
    expect(html).toContain("Bun.XML")
    expect(html).toContain("hasRegExpGroups = true")
    expect(html).toContain("VALID -&gt; https://api.bookdeskops.com/v2")
    for (const util of BUN_UTILITIES_CATALOG) {
      expect(html).toContain(`data-bun-utility-id="${util.id}"`)
    }
  })
})
