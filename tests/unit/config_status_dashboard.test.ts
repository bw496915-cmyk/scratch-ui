import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  buildConfigStatusUrl,
  createConfigStatusStore,
  createDashboardApi,
  parseEnvExample,
  type ConfigStatusSnapshot,
} from "../../packages/api/src/index.ts"
import { StatusDashboardPanel } from "../../packages/ui/src/panels/StatusDashboardPanel.tsx"
import {
  GLOBAL_KEYBOARD_SHORTCUTS,
  KeyboardShortcutsPanel,
} from "../../packages/ui/src/panels/KeyboardShortcutsPanel.tsx"

function buildTestApi(
  options: {
    readonly authenticated?: boolean
    readonly env?: Record<string, string | undefined>
  } = {},
) {
  const authenticated = options.authenticated ?? true
  const configStatus = createConfigStatusStore({
    env: options.env ?? {
      NODE_ENV: "development",
      PORT: "3000",
      SPORTSDESK_API_ORIGIN: "http://127.0.0.1:4020",
      SPORTSDESK_DASHBOARD_TOKEN: "super-secret-dashboard-token-must-never-leak",
      SPORTSDESK_ADMIN_TOKEN: "super-secret-admin-token-9999",
      R2_SECRET_ACCESS_KEY: "super-secret-r2-key-8888",
    },
  })

  return createDashboardApi({
    enforceAuth: authenticated
      ? async () => null
      : async () =>
          Response.json(
            { error: "Authentication required", code: "UNAUTHENTICATED" },
            { status: 401, headers: { "Cache-Control": "no-store" } },
          ),
    configStatus,
    auth: {
      login: async () => Response.json({ ok: true }),
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
      sweepOnce: async () => ({ sent: 0, failed: 0, dead: 0 }),
      list: () => [],
      ack: async () => true,
      retry: async () => null,
      getShiftSummary: (operatorId) => ({ operatorId }),
    },
    getTaxonomyCatalog: () => [],
    runShadowPricing: async () => ({}),
    getBuildMatrix: async () => ({ targets: [], generatedAt: "" }),
  })
}

describe("Configuration & Status Dashboard API (/api/config/status)", () => {
  test("parses .env.example keys and fails closed with 401 when unauthenticated", async () => {
    const parsed = parseEnvExample(
      '# Server\nPORT=3000\nR2_BUCKET_NAME="sportsdesk-ops-reports"\nSPORTSDESK_API_ORIGIN=\n',
    )
    expect(parsed.map((p) => p.key)).toEqual(["PORT", "R2_BUCKET_NAME", "SPORTSDESK_API_ORIGIN"])
    expect(parsed[0]?.defaultValue).toBe("3000")

    const api = buildTestApi({ authenticated: false })
    const getRes = await api.fetch(new Request(buildConfigStatusUrl("http://localhost:3000/")))
    expect(getRes.status).toBe(401)
    expect(getRes.headers.get("cache-control")).toBe("no-store")

    const postRes = await api.fetch(
      new Request("http://localhost:3000/api/config/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides: { R2_BUCKET_NAME: "ops-override-bucket" } }),
      }),
    )
    expect(postRes.status).toBe(401)
  })

  test("inventories .env.example, constants, runtime vars, and component traceability while strictly redacting secrets", async () => {
    const api = buildTestApi({ authenticated: true })
    const res = await api.fetch(new Request("http://localhost:3000/api/config/status"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-sportsdesk-endpoint")).toBe("/api/config/status")
    expect(res.headers.get("cache-control")).toBe("no-store")

    const snapshot = (await res.json()) as ConfigStatusSnapshot
    const serialized = JSON.stringify(snapshot)

    // Zero secret leakage in JSON or .env.example preview
    expect(serialized).not.toContain("super-secret-dashboard-token-must-never-leak")
    expect(serialized).not.toContain("super-secret-admin-token-9999")
    expect(serialized).not.toContain("super-secret-r2-key-8888")
    expect(snapshot.envExampleText).toContain("SPORTSDESK_DASHBOARD_TOKEN=")
    expect(snapshot.envExampleText).toContain("SPORTSDESK_ADMIN_TOKEN=")

    // Secret items report configured=true but value=null and editable=false
    const adminTokenItem = snapshot.items.find((i) => i.key === "SPORTSDESK_ADMIN_TOKEN")
    expect(adminTokenItem).toBeDefined()
    expect(adminTokenItem?.sensitive).toBe(true)
    expect(adminTokenItem?.editable).toBe(false)
    expect(adminTokenItem?.configured).toBe(true)
    expect(adminTokenItem?.value).toBeNull()

    // Constants, runtime variables, and component reverse-trace index exist
    expect(snapshot.summary.envCount).toBeGreaterThanOrEqual(30)
    expect(snapshot.summary.constantCount).toBeGreaterThanOrEqual(10)
    expect(snapshot.summary.variableCount).toBeGreaterThanOrEqual(2)
    expect(snapshot.summary.componentCount).toBeGreaterThanOrEqual(10)

    const rankingsComponent = snapshot.components.find((c) => c.component === "RankingsTabPanel")
    expect(rankingsComponent).toBeDefined()
    expect(rankingsComponent?.items.some((i) => i.key === "F402_OFFLINE_ONLY")).toBe(true)
    expect(rankingsComponent?.items.some((i) => i.key === "RANKINGS_HEATMAP_BUCKETS")).toBe(true)
  })

  test("saves and resets non-secret overrides while rejecting secret or invalid writes", async () => {
    const api = buildTestApi({ authenticated: true })

    // Reject writing sensitive secret key
    const secretPostRes = await api.fetch(
      new Request("http://localhost:3000/api/config/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          overrides: { SPORTSDESK_ADMIN_TOKEN: "attempted-overwrite" },
        }),
      }),
    )
    expect(secretPostRes.status).toBe(400)
    const secretErr = (await secretPostRes.json()) as { code: string }
    expect(secretErr.code).toBe("SENSITIVE_KEY_READONLY")

    // Reject unsafe URL scheme
    const badUrlRes = await api.fetch(
      new Request("http://localhost:3000/api/config/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          overrides: { SPORTSDESK_API_ORIGIN: "javascript:alert(1)" },
        }),
      }),
    )
    expect(badUrlRes.status).toBe(400)
    expect(((await badUrlRes.json()) as { code: string }).code).toBe("INVALID_CONFIG_VALUE")

    // Save valid non-secret .env.example var and build-time constant override
    const saveRes = await api.fetch(
      new Request("http://localhost:3000/api/config/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          overrides: {
            R2_BUCKET_NAME: "sportsdesk-staging-reports",
            "DASHBOARD_THRESHOLDS.sharp": "75",
          },
        }),
      }),
    )
    expect(saveRes.status).toBe(200)
    const saved = (await saveRes.json()) as {
      ok: boolean
      savedKeys: string[]
      snapshot: ConfigStatusSnapshot
    }
    expect(saved.ok).toBe(true)
    expect(saved.savedKeys).toEqual(["R2_BUCKET_NAME", "DASHBOARD_THRESHOLDS.sharp"])
    expect(saved.snapshot.summary.overriddenCount).toBe(2)
    expect(saved.snapshot.envExampleText).toContain("R2_BUCKET_NAME=sportsdesk-staging-reports")

    // Reset single key via DELETE
    const delRes = await api.fetch(
      new Request("http://localhost:3000/api/config/status?key=R2_BUCKET_NAME", {
        method: "DELETE",
      }),
    )
    expect(delRes.status).toBe(200)
    const afterDel = (await delRes.json()) as {
      ok: boolean
      snapshot: ConfigStatusSnapshot
    }
    expect(afterDel.snapshot.summary.overriddenCount).toBe(1)
    expect(afterDel.snapshot.overrides["DASHBOARD_THRESHOLDS.sharp"]).toBe("75")
  })
})

describe("StatusDashboardPanel UI rendering", () => {
  const store = createConfigStatusStore({
    env: {
      PORT: "3000",
      R2_BUCKET_NAME: "sportsdesk-ops-reports",
      SPORTSDESK_ADMIN_TOKEN: "top-secret-value-do-not-render",
    },
  })
  const snapshot = store.getSnapshot()

  test("renders populated registry, secret read-only guards, and component traces without leaking secrets", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatusDashboardPanel, {
        snapshot,
        loading: false,
        error: null,
        saving: false,
        onRefresh: () => {},
        onSaveOverrides: () => true,
        onResetOverrides: () => {},
        onNavigateTab: () => {},
      }),
    )

    expect(html).toContain('data-status-dashboard="true"')
    expect(html).toContain("Configuration &amp; Status Dashboard")
    expect(html).toContain("R2_BUCKET_NAME")
    expect(html).toContain("DASHBOARD_THRESHOLDS.sharp")
    expect(html).toContain("RankingsTabPanel")
    expect(html).toContain('data-secret-readonly="SPORTSDESK_ADMIN_TOKEN"')
    expect(html).toContain("Configured on server (value hidden)")
    expect(html).not.toContain("top-secret-value-do-not-render")
  })

  test("renders loading skeleton and error recovery states", () => {
    const loadingHtml = renderToStaticMarkup(
      React.createElement(StatusDashboardPanel, {
        snapshot: null,
        loading: true,
        error: null,
        saving: false,
        onRefresh: () => {},
        onSaveOverrides: () => true,
        onResetOverrides: () => {},
      }),
    )
    expect(loadingHtml).toContain('data-status-dashboard-skeleton="true"')

    const errorHtml = renderToStaticMarkup(
      React.createElement(StatusDashboardPanel, {
        snapshot: null,
        loading: false,
        error: "Unable to load configuration status (HTTP 503)",
        saving: false,
        onRefresh: () => {},
        onSaveOverrides: () => true,
        onResetOverrides: () => {},
      }),
    )
    expect(errorHtml).toContain('data-status-dashboard-error="true"')
    expect(errorHtml).toContain("Retry")
  })

  test("renders compact Keyboard Shortcuts panel inside Status & Config tab with global hotkeys", () => {
    const html = renderToStaticMarkup(
      React.createElement(StatusDashboardPanel, {
        snapshot,
        loading: false,
        error: null,
        saving: false,
        onRefresh: () => {},
        onSaveOverrides: () => true,
        onResetOverrides: () => {},
        onNavigateTab: () => {},
      }),
    )

    expect(html).toContain('data-keyboard-shortcuts-panel="true"')
    expect(html).toContain("Keyboard Shortcuts")
    expect(html).toContain("Quick Terminal Focus")
    expect(html).toContain("Focus Global Search")
    expect(html).toContain("Dismiss Overlay")
    expect(html).toContain("<kbd")
    expect(html).toContain("`")
    // Verify Ctrl+1..9 and Ctrl+0 tab shortcuts are all represented
    for (const digit of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
      expect(
        GLOBAL_KEYBOARD_SHORTCUTS.some((s) => s.keys[0] === "Ctrl" && s.keys[1] === digit),
      ).toBe(true)
    }

    // Verify scope filtering and collapsed mode
    const globalOnlyHtml = renderToStaticMarkup(
      React.createElement(KeyboardShortcutsPanel, {
        initialScope: "global",
      }),
    )
    expect(globalOnlyHtml).toContain('data-shortcut-id="global-pty-toggle"')
    expect(globalOnlyHtml).not.toContain('data-shortcut-id="tab-customers"')

    const collapsedHtml = renderToStaticMarkup(
      React.createElement(KeyboardShortcutsPanel, {
        defaultCollapsed: true,
      }),
    )
    expect(collapsedHtml).toContain("Show")
    expect(collapsedHtml).not.toContain('data-keyboard-shortcuts-grid="true"')
  })
})
