import { afterEach, describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  beginApiCall,
  endApiCall,
  extractBaseUrlProperties,
  getApiUsageSnapshot,
  resetApiUsage,
} from "../../packages/ui/src/api_usage.ts"
import {
  ApiUsageCard,
  buildApiUsageExportBlob,
  filterAndSortApiUsageRows,
  formatBaseUrlSourceLabel,
} from "../../packages/ui/src/panels/ApiUsageCard.tsx"

describe("Enhanced API Usage Meter & Base URL Properties", () => {
  afterEach(() => {
    resetApiUsage()
  })

  test("extractBaseUrlProperties resolves origin, protocol, host, hostname, port, effectivePort, source, and privacy bounds", () => {
    const mockWin = {
      location: {
        origin: "https://desk.sportsops.example",
        href: "https://desk.sportsops.example/?tab=surveillance",
        search: "?tab=surveillance",
      },
    }

    const sessionBase = extractBaseUrlProperties(null, mockWin)
    expect(sessionBase.origin).toBe("https://desk.sportsops.example")
    expect(sessionBase.protocol).toBe("https:")
    expect(sessionBase.hostname).toBe("desk.sportsops.example")
    expect(sessionBase.host).toBe("desk.sportsops.example")
    expect(sessionBase.port).toBe("")
    expect(sessionBase.effectivePort).toBe("443")
    expect(sessionBase.pathname).toBe("/")
    expect(sessionBase.source).toBe("window-origin")
    expect(sessionBase.sameOrigin).toBe(true)
    expect(sessionBase.secure).toBe(true)

    // Query values and customer IDs are never leaked into base URL properties
    const reqBase = extractBaseUrlProperties(
      "https://api.partner.example:8443/api/customer/BGD101?secret=token123",
      mockWin,
    )
    expect(reqBase.origin).toBe("https://api.partner.example:8443")
    expect(reqBase.host).toBe("api.partner.example:8443")
    expect(reqBase.hostname).toBe("api.partner.example")
    expect(reqBase.port).toBe("8443")
    expect(reqBase.effectivePort).toBe("8443")
    expect(reqBase.pathname).toBe("/")
    expect(reqBase.href).toBe("https://api.partner.example:8443/")
    expect(reqBase.href).not.toContain("BGD101")
    expect(reqBase.href).not.toContain("token123")
    expect(reqBase.sameOrigin).toBe(false)
    expect(reqBase.source).toBe("explicit")

    // Loopback ?apiBase= override is detected with query-override source
    const overrideWin = {
      location: {
        origin: "http://localhost:3000",
        href: "http://localhost:3000/?apiBase=http://127.0.0.1:4021",
        search: "?apiBase=http://127.0.0.1:4021",
      },
    }
    const overrideBase = extractBaseUrlProperties("/api/rankings", overrideWin)
    expect(overrideBase.origin).toBe("http://127.0.0.1:4021")
    expect(overrideBase.port).toBe("4021")
    expect(overrideBase.source).toBe("query-override")
    expect(formatBaseUrlSourceLabel(overrideBase.source)).toBe("?apiBase Override")
  })

  test("snapshot tracks per-endpoint Base URL properties, origins list, latency bounds, and JSON Blob export", async () => {
    const primaryBase = extractBaseUrlProperties("http://localhost:3000/api/rankings")
    const secondaryBase = extractBaseUrlProperties("http://127.0.0.1:4020/api/health")

    const t1 = beginApiCall("GET /api/rankings", false, primaryBase)
    endApiCall(
      t1,
      200,
      new Headers({
        "cache-control": "no-store",
        "x-sportsdesk-endpoint": "/api/rankings",
        "x-runtime-engine": "bun",
        "x-request-id": "req-1",
      }),
    )

    const t2 = beginApiCall("GET /api/health", false, secondaryBase)
    endApiCall(t2, 503)

    const snap = getApiUsageSnapshot()
    expect(snap.calls).toBe(2)
    expect(snap.ok).toBe(1)
    expect(snap.failed).toBe(1)
    expect(snap.alignedResponses).toBe(1)
    expect(snap.origins).toContain("http://localhost:3000")
    expect(snap.origins).toContain("http://127.0.0.1:4020")

    const rankingsRow = snap.rows.find((r) => r.key === "GET /api/rankings")
    expect(rankingsRow?.method).toBe("GET")
    expect(rankingsRow?.normalizedPath).toBe("/api/rankings")
    expect(rankingsRow?.baseUrl.origin).toBe("http://localhost:3000")
    expect(rankingsRow?.minMs).not.toBeNull()
    expect(rankingsRow?.maxMs).not.toBeNull()

    // Filtering and sorting helpers
    const alignedOnly = filterAndSortApiUsageRows(snap.rows, {
      search: "",
      filterMode: "ALIGNED",
      originFilter: "ALL",
      sortField: "calls",
      sortDir: "desc",
    })
    expect(alignedOnly.map((r) => r.key)).toEqual(["GET /api/rankings"])

    const errorsOnly = filterAndSortApiUsageRows(snap.rows, {
      search: "4020",
      filterMode: "ERRORS",
      originFilter: "http://127.0.0.1:4020",
      sortField: "origin",
      sortDir: "asc",
    })
    expect(errorsOnly.map((r) => r.key)).toEqual(["GET /api/health"])

    // JSON Blob export includes Base URL properties
    const blob = buildApiUsageExportBlob(snap)
    expect(blob.type).toContain("application/json")
    const parsed = JSON.parse(await blob.text())
    expect(parsed.schema).toBe("sportsdesk-api-usage/v1")
    expect(parsed.baseUrl.origin).toBe(snap.baseUrl.origin)
    expect(parsed.endpoints.length).toBe(2)
    expect(parsed.endpoints[0].baseUrl.hostname).toBeTruthy()
  })

  test("ApiUsageCard renders Base URL properties strip, Base URL column, toolbar, and expandable URL detail row", () => {
    const base = extractBaseUrlProperties("https://desk.example:8443/api/wagers")
    const t = beginApiCall("GET /api/wagers", false, base)
    endApiCall(
      t,
      200,
      new Headers({
        "cache-control": "no-store",
        "x-sportsdesk-endpoint": "/api/wagers",
        "x-runtime-engine": "bun",
        "x-request-id": "req-wagers-42",
      }),
    )

    const html = renderToStaticMarkup(
      React.createElement(ApiUsageCard, {
        defaultExpandedKey: "GET /api/wagers",
      }),
    )

    expect(html).toContain('data-api-usage-card="true"')
    expect(html).toContain('data-api-usage-base-url="true"')
    expect(html).toContain('data-api-base-prop="origin"')
    expect(html).toContain('data-api-base-prop="protocol"')
    expect(html).toContain('data-api-base-prop="hostname"')
    expect(html).toContain('data-api-base-prop="host"')
    expect(html).toContain('data-api-base-prop="port"')
    expect(html).toContain('data-api-base-prop="pathname"')
    expect(html).toContain("Copy Base URL")
    expect(html).toContain("Export JSON")
    expect(html).toContain("Reset meter")
    expect(html).toContain('data-api-usage-row-base="https://desk.example:8443"')
    expect(html).toContain('data-api-usage-detail="GET /api/wagers"')
    expect(html).toContain("https://desk.example:8443/api/wagers")
    expect(html).toContain("req-wagers-42")
  })
})
