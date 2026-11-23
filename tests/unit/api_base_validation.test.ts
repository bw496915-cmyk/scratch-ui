import { describe, expect, test } from "bun:test"

import {
  validateApiBase,
  validateApiBaseFallback,
  validateApiBaseWithPattern,
} from "../../packages/ui/src/api_base_validation.ts"
import {
  buildDashboardApiUrlObject,
  devApiBaseOverride,
  inspectApiBaseOverride,
  resolveDashboardBaseUrl,
} from "../../packages/ui/src/config/dashboard.ts"
import { buildCanonicalDashboardHref } from "../../packages/ui/src/discovery_hash.ts"
import { buildDashboardSearch, DEFAULT_DASHBOARD_URL_STATE } from "../../packages/ui/src/url_state.ts"

describe("URLPattern apiBase Validation (Production & Local Dev)", () => {
  test("accepts valid single-label https://<sub >.bookdeskops.com origins and normalizes trailing slashes", () => {
    expect(validateApiBaseWithPattern("https://api.bookdeskops.com", false)).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com",
      sub: "api",
    })
    expect(validateApiBaseWithPattern("https://desk-01.bookdeskops.com/v2///", false)).toEqual({
      ok: true,
      normalized: "https://desk-01.bookdeskops.com/v2",
      sub: "desk-01",
    })
    expect(validateApiBaseWithPattern("https://A.BOOKDESKOPS.COM/", false)).toEqual({
      ok: true,
      normalized: "https://a.bookdeskops.com",
      sub: "a",
    })
    // Default HTTPS port 443 canonicalizes to empty port
    expect(validateApiBaseWithPattern("https://api.bookdeskops.com:443/ops/", false)).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com/ops",
      sub: "api",
    })
  })

  test("rejects denied, punycode, multi-label, non-https, credentialed, or parameterized origins", () => {
    const untrustedCases = [
      "https://staging.bookdeskops.com",
      "https://STAGING.bookdeskops.com",
      "https://xn--80ak6aa92e.bookdeskops.com",
      "https://XN--80ak6aa92e.bookdeskops.com",
      "https://-leading.bookdeskops.com",
      "https://trailing-.bookdeskops.com",
      `https://${"a".repeat(64)}.bookdeskops.com`,
      "https://a_b.bookdeskops.com",
      "https://a.b.bookdeskops.com",
      "https://bookdeskops.com",
      "http://api.bookdeskops.com",
      "https://api.bookdeskops.com:8443",
      "https://user:pass@api.bookdeskops.com",
      "https://api.bookdeskops.com?token=1",
      "https://api.bookdeskops.com#frag",
      "https://evil.example.net",
      "javascript:alert(1)",
    ]

    for (const candidate of untrustedCases) {
      const patternRes = validateApiBaseWithPattern(candidate, false)
      expect(patternRes).toEqual({ ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" })
      const fallbackRes = validateApiBaseFallback(candidate, false)
      expect(fallbackRes).toEqual({ ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" })
    }
  })

  test("handles local dev loopback targets only when isLocalDev is true and rejects invalid ports", () => {
    expect(validateApiBaseWithPattern("http://localhost:3000", true)).toEqual({
      ok: true,
      normalized: "http://localhost:3000",
    })
    expect(validateApiBaseWithPattern("http://127.0.0.1:4021/api/", true)).toEqual({
      ok: true,
      normalized: "http://127.0.0.1:4021/api",
    })
    expect(validateApiBaseWithPattern("http://[::1]:4021", true)).toEqual({
      ok: true,
      normalized: "http://[::1]:4021",
    })
    expect(validateApiBaseWithPattern("http://localhost", true)).toEqual({
      ok: true,
      normalized: "http://localhost",
    })

    // Loopback blocked when isLocalDev is false
    expect(validateApiBaseWithPattern("http://localhost:3000", false)).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    })
    expect(validateApiBaseWithPattern("http://127.0.0.1:4021", false)).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    })
    expect(validateApiBaseWithPattern("http://[::1]:4021", false)).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    })

    // Escaped dots prevent 127x0x0x1 bypass; invalid ports fail closed
    expect(validateApiBaseWithPattern("http://127x0x0x1:4021", true)).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    })
    expect(validateApiBaseWithPattern("http://127.0.0.1:99999", true)).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_URL",
    })
    expect(validateApiBaseWithPattern("http://127.0.0.1:0", true)).toEqual({
      ok: false,
      code: "ERR_API_BASE_INVALID_URL",
    })
  })

  test("fails closed on empty, relative, protocol-relative, and missing URLPattern runtimes", () => {
    const invalidInputs: Array<string | null | undefined> = [
      "",
      "   ",
      null,
      undefined,
      "/relative/api",
      "//api.bookdeskops.com",
      "not a url",
    ]
    for (const input of invalidInputs) {
      expect(validateApiBaseWithPattern(input, true)).toEqual({
        ok: false,
        code: "ERR_API_BASE_INVALID_URL",
      })
    }

    // Missing URLPattern returns ERR_API_BASE_PATTERN_UNAVAILABLE
    expect(validateApiBaseWithPattern("https://api.bookdeskops.com", false, null)).toEqual({
      ok: false,
      code: "ERR_API_BASE_PATTERN_UNAVAILABLE",
    })

    // Pure URL fallback matches URLPattern behavior identically
    expect(validateApiBaseFallback("https://api.bookdeskops.com/v1/", false)).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com/v1",
      sub: "api",
    })
    expect(validateApiBase("https://api.bookdeskops.com/v1/", false)).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com/v1",
      sub: "api",
    })
  })

  test("integrates with dashboard base URL resolution, URL state scrubbing, and canonical hashed links", () => {
    const trustedProdWin = {
      location: {
        origin: "https://ops.example.com",
        href: "https://ops.example.com/?apiBase=https://api.bookdeskops.com/v1/",
        search: "?apiBase=https://api.bookdeskops.com/v1/",
      },
    }
    expect(inspectApiBaseOverride(trustedProdWin, false)).toEqual({
      ok: true,
      normalized: "https://api.bookdeskops.com/v1",
      sub: "api",
    })
    expect(devApiBaseOverride(trustedProdWin, false)).toBe("https://api.bookdeskops.com/v1")

    const resolved = resolveDashboardBaseUrl(null, trustedProdWin)
    expect(resolved.source).toBe("query-override")
    expect(resolved.baseUrl.href).toBe("https://api.bookdeskops.com/v1")

    const apiUrl = buildDashboardApiUrlObject("/api/wagers", { limit: 25 }, null, trustedProdWin)
    expect(apiUrl.href).toBe("https://api.bookdeskops.com/v1/api/wagers?limit=25")

    const stagingWin = {
      location: {
        origin: "https://ops.example.com",
        href: "https://ops.example.com/?apiBase=https://staging.bookdeskops.com",
        search: "?apiBase=https://staging.bookdeskops.com",
      },
    }
    expect(inspectApiBaseOverride(stagingWin, false)).toEqual({
      ok: false,
      code: "ERR_API_BASE_ORIGIN_UNTRUSTED",
    })
    expect(devApiBaseOverride(stagingWin, false)).toBeNull()

    // Untrusted apiBase is scrubbed from shareable search & canonical discovery links
    const scrubbedSearch = buildDashboardSearch(
      DEFAULT_DASHBOARD_URL_STATE,
      "?tab=customers&apiBase=https://staging.bookdeskops.com",
      "/",
    )
    expect(scrubbedSearch).not.toContain("apiBase")

    const safeHref = buildCanonicalDashboardHref(
      { activeTab: "customers", discoveryDimension: "directional-asymmetry" },
      "?apiBase=https://staging.bookdeskops.com",
    )
    expect(safeHref).not.toContain("apiBase")

    const trustedHref = buildCanonicalDashboardHref(
      { activeTab: "customers", discoveryDimension: "directional-asymmetry" },
      "?apiBase=https://api.bookdeskops.com/v1/",
    )
    expect(trustedHref).toContain("apiBase=https%3A%2F%2Fapi.bookdeskops.com%2Fv1")
  })
})
