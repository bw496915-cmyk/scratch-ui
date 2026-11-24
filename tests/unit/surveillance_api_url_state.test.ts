import { describe, expect, test } from "bun:test"

import { createHttpAuthController } from "../../lib/http_auth.ts"
import { createDashboardApi } from "../../packages/api/src/index.ts"
import { apiUsageKey, extractResponseHeaderTelemetry } from "../../packages/ui/src/api_usage.ts"
import {
  buildDashboardApiUrlObject,
  dashboardApiUrl,
  isBunRuntime,
  readBunGlobals,
  resolveDashboardBaseUrl,
} from "../../packages/ui/src/config/dashboard.ts"
import {
  buildSurveillanceEndpointUrls,
  buildSurveillanceHeaderSyncRecord,
  buildSurveillanceMarkdownBlob,
  buildSurveillanceSnapshotBlob,
  buildSurveillanceWindowUrl,
  downloadSurveillanceBlob,
  inspectSurveillanceRuntimeGlobals,
  SURVEILLANCE_ENDPOINTS,
} from "../../packages/ui/src/surveillance_api.ts"
import {
  buildDashboardSearch,
  readDashboardUrlState,
  SURVEILLANCE_URL_DEFAULTS,
  writeDashboardUrl,
} from "../../packages/ui/src/url_state.ts"

describe("Surveillance Base URL, Separate URL Objects & Window State Management", () => {
  test("resolveDashboardBaseUrl and buildDashboardApiUrlObject resolve Window origin, loopback ?apiBase, and reject non-loopback overrides", () => {
    const winWithLoopback = {
      location: {
        origin: "https://desk.example.com",
        href: "https://desk.example.com/?tab=surveillance&apiBase=http://127.0.0.1:4021",
        search: "?tab=surveillance&apiBase=http://127.0.0.1:4021",
      },
    }
    const loopbackResolved = resolveDashboardBaseUrl(null, winWithLoopback)
    expect(loopbackResolved.source).toBe("query-override")
    expect(loopbackResolved.baseUrl.origin).toBe("http://127.0.0.1:4021")

    const winWithExternalOverride = {
      location: {
        origin: "https://desk.example.com",
        href: "https://desk.example.com/?tab=surveillance&apiBase=https://evil.example.net",
        search: "?tab=surveillance&apiBase=https://evil.example.net",
      },
    }
    const safeResolved = resolveDashboardBaseUrl(null, winWithExternalOverride)
    expect(safeResolved.source).toBe("window-origin")
    expect(safeResolved.baseUrl.origin).toBe("https://desk.example.com")

    const separateUrl = buildDashboardApiUrlObject(
      SURVEILLANCE_ENDPOINTS.benchmark,
      { host: "api.telegram.org" },
      null,
      winWithExternalOverride,
    )
    expect(separateUrl).toBeInstanceOf(URL)
    expect(separateUrl.origin).toBe("https://desk.example.com")
    expect(separateUrl.pathname).toBe("/api/surveillance/dns/benchmark")
    expect(separateUrl.searchParams.get("host")).toBe("api.telegram.org")
    // Does not mutate Window location
    expect(winWithExternalOverride.location.href).toBe(
      "https://desk.example.com/?tab=surveillance&apiBase=https://evil.example.net",
    )
    expect(dashboardApiUrl(SURVEILLANCE_ENDPOINTS.reverse, null, { ip: "8.8.8.8" }, winWithExternalOverride)).toBe(
      "/api/surveillance/dns/reverse?ip=8.8.8.8",
    )
  })

  test("buildSurveillanceEndpointUrls builds distinct URL objects for every surveillance endpoint", () => {
    const mockWin = {
      location: {
        origin: "https://ops.example.com",
        href: "https://ops.example.com/?tab=surveillance",
        search: "?tab=surveillance",
      },
    }
    const urls = buildSurveillanceEndpointUrls({
      host: "clob.polymarket.com",
      ip: "9.9.9.9",
      win: mockWin,
    })

    expect(urls.brief).not.toBe(urls.dns)
    expect(urls.benchmark).not.toBe(urls.reverse)
    expect(urls.brief.href).toBe("https://ops.example.com/api/surveillance/brief")
    expect(urls.dns.href).toBe("https://ops.example.com/api/surveillance/dns")
    expect(urls.benchmark.href).toBe("https://ops.example.com/api/surveillance/dns/benchmark?host=clob.polymarket.com")
    expect(urls.reverse.href).toBe("https://ops.example.com/api/surveillance/dns/reverse?ip=9.9.9.9")
  })

  test("readDashboardUrlState, buildDashboardSearch, and writeDashboardUrl manage surveillance URL state cleanly via Window", () => {
    const parsed = readDashboardUrlState(
      "?tab=surveillance&survView=raw&survIp=8.8.8.8&survHost=api.telegram.org",
      "/",
      "",
    )
    expect(parsed.tab).toBe("surveillance")
    expect(parsed.survView).toBe("raw")
    expect(parsed.survIp).toBe("8.8.8.8")
    expect(parsed.survHost).toBe("api.telegram.org")

    // Defaults keep /?tab=surveillance clean
    const defaultSearch = buildDashboardSearch(
      {
        ...parsed,
        survView: SURVEILLANCE_URL_DEFAULTS.view,
        survIp: SURVEILLANCE_URL_DEFAULTS.ip,
        survHost: SURVEILLANCE_URL_DEFAULTS.host,
      },
      "?tab=surveillance&survView=raw&survIp=8.8.8.8&apiBase=http://127.0.0.1:4021",
      "/",
    )
    expect(defaultSearch).toBe("tab=surveillance&apiBase=http%3A%2F%2F127.0.0.1%3A4021")

    // Leaving surveillance strips surveillance params while preserving apiBase
    const awaySearch = buildDashboardSearch(
      {
        ...parsed,
        tab: "wagers",
      },
      "?tab=surveillance&survView=raw&survIp=8.8.8.8&survHost=api.telegram.org&apiBase=http://127.0.0.1:4021",
      "/",
    )
    expect(awaySearch).toContain("tab=wagers")
    expect(awaySearch).toContain("apiBase=")
    expect(awaySearch).not.toContain("survView")
    expect(awaySearch).not.toContain("survIp")
    expect(awaySearch).not.toContain("survHost")

    let pushedUrl: string | null = null
    const mockWin = {
      location: {
        origin: "https://ops.example.com",
        href: "https://ops.example.com/?tab=customers",
        pathname: "/",
        search: "?tab=customers",
        hash: "",
      },
      history: {
        replaceState: () => {},
        pushState: (_d: unknown, _u: string, next: string) => {
          pushedUrl = next
        },
      },
    }
    const wrote = writeDashboardUrl(parsed, mockWin, { push: true })
    expect(wrote).toBe(true)
    expect(pushedUrl).toBe("/?tab=surveillance&survView=raw&survIp=8.8.8.8&survHost=api.telegram.org")

    const winUrlObj = buildSurveillanceWindowUrl(
      { viewMode: "raw", reverseIp: "1.0.0.1", benchHost: "fantasy402.com" },
      mockWin,
    )
    expect(winUrlObj.searchParams.get("tab")).toBe("surveillance")
    expect(winUrlObj.searchParams.get("survView")).toBe("raw")
    expect(winUrlObj.searchParams.get("survIp")).toBe("1.0.0.1")
    expect(winUrlObj.searchParams.has("survHost")).toBe(false)
  })
})

describe("Bun Globals, Blob Snapshot Export & Aligned Headers", () => {
  test("readBunGlobals, isBunRuntime, and inspectSurveillanceRuntimeGlobals detect Bun via process.versions.bun and Bun global", () => {
    expect(isBunRuntime()).toBe(true)

    const bunGlobals = readBunGlobals()
    expect(bunGlobals.available).toBe(true)
    expect(typeof bunGlobals.version).toBe("string")
    expect(bunGlobals.processVersionsBun).toBe(process.versions.bun ?? null)
    expect(bunGlobals.hasBunGlobal).toBe(true)
    expect(bunGlobals.detectedVia).toBe("process.versions.bun")
    expect(bunGlobals.hasNanoseconds).toBe(true)

    // Works with only process.versions.bun (no Bun global)
    expect(isBunRuntime({ process: { versions: { bun: "1.4.4" } } })).toBe(true)
    const viaProcessOnly = readBunGlobals({ process: { versions: { bun: "1.4.4" } } })
    expect(viaProcessOnly).toEqual({
      available: true,
      version: "1.4.4",
      revision: null,
      hasDns: false,
      hasNanoseconds: false,
      processVersionsBun: "1.4.4",
      hasBunGlobal: false,
      detectedVia: "process.versions.bun",
    })

    // Falls back to globalThis.Bun when process is absent
    expect(isBunRuntime({ Bun: { version: "1.4.4" } })).toBe(true)
    const viaGlobalOnly = readBunGlobals({ Bun: { version: "1.4.4", revision: "abc123" } })
    expect(viaGlobalOnly).toEqual({
      available: true,
      version: "1.4.4",
      revision: "abc123",
      hasDns: false,
      hasNanoseconds: false,
      processVersionsBun: null,
      hasBunGlobal: true,
      detectedVia: "globalThis.Bun",
    })

    // Browser / Node without Bun
    expect(isBunRuntime({})).toBe(false)
    expect(isBunRuntime({ process: { versions: {} } })).toBe(false)
    expect(readBunGlobals({})).toEqual({
      available: false,
      version: null,
      revision: null,
      hasDns: false,
      hasNanoseconds: false,
      processVersionsBun: null,
      hasBunGlobal: false,
      detectedVia: "none",
    })

    const runtime = inspectSurveillanceRuntimeGlobals({
      location: {
        origin: "http://127.0.0.1:3000",
        href: "http://127.0.0.1:3000/?tab=surveillance",
      },
      navigator: { userAgent: "BunTest/1.0" },
    })
    expect(runtime.hasWindow).toBe(true)
    expect(runtime.hasBlob).toBe(true)
    expect(runtime.bun.available).toBe(true)
    expect(runtime.bun.detectedVia).toBe("process.versions.bun")
    expect(runtime.windowOrigin).toBe("http://127.0.0.1:3000")
  })

  test("buildSurveillanceSnapshotBlob, buildSurveillanceMarkdownBlob, and downloadSurveillanceBlob build valid Blobs and clean up ObjectURLs", async () => {
    const snapshotBlob = buildSurveillanceSnapshotBlob({
      viewMode: "raw",
      benchHost: "fantasy402.com",
      benchResult: "⚡ Fastest: c-ares (1.4x speedup)",
      reverseIp: "1.1.1.1",
      reverseForensics: null,
      dnsData: {
        success: true,
        telemetry: {
          size: 4,
          hitRatePercent: 85,
          cacheHitsCompleted: 17,
          cacheHitsInflight: 0,
          cacheMisses: 3,
          defaultTtlSeconds: 30,
        },
      },
      briefData: {
        markdown: "# Surveillance Brief\n\nAll nominal.",
        html: "<h1>Surveillance Brief</h1>",
        updatedAt: "2026-11-20T15:00:00.000Z",
      },
      headerSync: null,
      win: {
        location: {
          origin: "http://127.0.0.1:3000",
          href: "http://127.0.0.1:3000/?tab=surveillance&survView=raw",
          search: "?tab=surveillance&survView=raw",
        },
      },
    })

    expect(snapshotBlob).toBeInstanceOf(Blob)
    expect(snapshotBlob.type).toContain("application/json")
    expect(snapshotBlob.size).toBeGreaterThan(100)
    const parsedJson = JSON.parse(await snapshotBlob.text()) as {
      schema: string
      urlState: { windowUrl: string; baseUrl: string }
      endpoints: { brief: string; dns: string; benchmark: string; reverse: string }
      runtimeGlobals: { bun: { available: boolean }; hasBlob: boolean }
    }
    expect(parsedJson.schema).toBe("sportsdesk-surveillance-snapshot/v1")
    expect(parsedJson.urlState.baseUrl).toBe("http://127.0.0.1:3000/")
    expect(parsedJson.endpoints.benchmark).toBe(
      "http://127.0.0.1:3000/api/surveillance/dns/benchmark?host=fantasy402.com",
    )
    expect(parsedJson.runtimeGlobals.bun.available).toBe(true)
    expect(parsedJson.runtimeGlobals.hasBlob).toBe(true)

    const mdBlob = buildSurveillanceMarkdownBlob("# Brief")
    expect(mdBlob).toBeInstanceOf(Blob)
    expect(mdBlob.type).toContain("text/markdown")
    expect(await mdBlob.text()).toBe("# Brief")

    let clickedDownload = ""
    let clickedHref = ""
    const fakeAnchor = {
      href: "",
      download: "",
      style: { display: "" },
      click: () => {
        clickedDownload = fakeAnchor.download
        clickedHref = fakeAnchor.href
      },
      remove: () => {},
    }
    const downloaded = downloadSurveillanceBlob(snapshotBlob, "surveillance.json", {
      document: {
        createElement: () => fakeAnchor,
        body: { appendChild: () => {} },
      },
    })
    expect(downloaded).toBe(true)
    expect(clickedDownload).toBe("surveillance.json")
    expect(clickedHref.startsWith("blob:")).toBe(true)
  })

  test("canonical /api/surveillance/* endpoints emit aligned headers including X-Runtime-Engine, X-Request-Id, and Cache-Control: no-store", async () => {
    const env = {
      NODE_ENV: "production",
      SPORTSDESK_DASHBOARD_TOKEN: "surv-test-token-1234",
    }
    const auth = createHttpAuthController({ env })
    const api = createDashboardApi({
      enforceAuth: (req) => auth.enforceAuth(req),
      env,
      auth: auth.auth,
      getHealthPayload: () => ({ status: "ok" }),
      loadDashboardMarkdown: async () => ({
        stamp: "test-1",
        markdown: "# Brief",
        html: "<h1>Brief</h1>",
      }),
      dns: {
        getTelemetryPayload: () => ({
          success: true,
          telemetry: {
            size: 4,
            hitRatePercent: 80,
            cacheHitsCompleted: 8,
            cacheHitsInflight: 0,
            cacheMisses: 2,
            defaultTtlSeconds: 30,
          },
        }),
        benchmark: async (host) => ({
          host,
          fastestBackend: "c-ares",
          speedupFactor: 1.5,
          metrics: [],
        }),
        classifyIp: async (ip) => ({
          ipAddress: ip,
          hostnames: ["one.one.one.one"],
          primaryHostname: "one.one.one.one",
          isDatacenterOrCloud: true,
          isVpnOrProxySuspicious: false,
          organization: "Cloudflare",
        }),
      },
      customers: {
        getCohortReport: async () => ({ versionStamp: "1", payload: {} }),
        getProfile: async () => null,
        getRating: async () => null,
      },
      execTerminal: async () => ({}),
      rankings: {
        getAll: async () => ({ generatedAtIso: "", payload: {} }),
        getConduits: async () => [],
      },
      getLiveWagersPayload: async () => ({}),
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

    const probes = [
      {
        url: "http://127.0.0.1:3000/api/surveillance/brief",
        endpoint: "/api/surveillance/brief",
      },
      {
        url: "http://127.0.0.1:3000/api/surveillance/dns",
        endpoint: "/api/surveillance/dns",
      },
      {
        url: "http://127.0.0.1:3000/api/surveillance/dns/benchmark?host=fantasy402.com",
        endpoint: "/api/surveillance/dns/benchmark",
      },
      {
        url: "http://127.0.0.1:3000/api/surveillance/dns/reverse?ip=1.1.1.1",
        endpoint: "/api/surveillance/dns/reverse",
      },
    ]

    for (const probe of probes) {
      const reqId = `req-${probe.endpoint}`
      const res = await api.fetch(
        new Request(probe.url, {
          headers: {
            Authorization: "Bearer surv-test-token-1234",
            "X-Request-Id": reqId,
          },
        }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      expect(res.headers.get("x-request-id")).toBe(reqId)
      expect(res.headers.get("x-sportsdesk-endpoint")).toBe(probe.endpoint)
      expect(res.headers.get("x-sportsdesk-tab")).toBe("surveillance")
      expect(res.headers.get("x-runtime-engine")).toMatch(/^bun\//)
      expect(res.headers.get("server-timing")).toContain("api;dur=")

      const telemetry = extractResponseHeaderTelemetry(res.headers)
      expect(telemetry?.aligned).toBe(true)
      const sync = buildSurveillanceHeaderSyncRecord(res, probe.url)
      expect(sync.aligned).toBe(true)
      expect(sync.endpointHeader).toBe(probe.endpoint)
      expect(apiUsageKey(new URL(probe.url))).toBe(`GET ${probe.endpoint}`)
    }
  })
})
