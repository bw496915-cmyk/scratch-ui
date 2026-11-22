import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  BUN_CORE_API_DOMAINS,
  BUN_GLOBAL_TIERS,
  BUN_UTILITIES_CATALOG,
  BUN_UTILITY_CATEGORIES,
  LIVE_SURFACE_AUDIT_SNIPPET,
  bunDeepEquals,
  decodeUuidV7TimestampIso,
  evaluateBunColorConversions,
  evaluateBunStringUtilities,
  formatInspectTable,
  generateBunUuidV7,
  runBunSurfaceAudit,
} from "../../packages/contracts/src/bun_runtime_surface.ts"
import { loadBunRuntimeSurfaceAudit } from "../../packages/api/src/bun_runtime_surface_loader.ts"
import { createConfigStatusStore } from "../../packages/api/src/config_status.ts"
import { BunRuntimeSurfaceSection } from "../../packages/ui/src/panels/BunRuntimeSurfaceSection.tsx"
import { StatusDashboardPanel } from "../../packages/ui/src/panels/StatusDashboardPanel.tsx"

describe("Bun Runtime Surface catalog & live audit engine", () => {
  test("catalogs all 3 global tiers, 28 Bun.* utilities across 4 categories, and 7 core API domains", () => {
    expect(BUN_GLOBAL_TIERS.map((t) => t.id)).toEqual([
      "bun-specific",
      "node-compat",
      "web-standards",
    ])
    expect(BUN_GLOBAL_TIERS[0]?.globals).toEqual([
      "Bun",
      "HTMLRewriter",
      "ShadowRealm",
      "WebSocket",
    ])
    expect(BUN_GLOBAL_TIERS[1]?.globals).toContain("process")
    expect(BUN_GLOBAL_TIERS[1]?.globals).toContain("Buffer")
    expect(BUN_GLOBAL_TIERS[2]?.globals).toContain("CompressionStream")
    expect(BUN_GLOBAL_TIERS[2]?.globals).toContain("URLPattern")

    expect(BUN_UTILITY_CATEGORIES).toHaveLength(4)
    expect(BUN_UTILITIES_CATALOG).toHaveLength(28)
    expect(BUN_UTILITIES_CATALOG.some((u) => u.signature === "Bun.nanoseconds()")).toBe(true)
    expect(BUN_UTILITIES_CATALOG.some((u) => u.signature.includes("Bun.zstdCompress"))).toBe(true)
    expect(BUN_UTILITIES_CATALOG.some((u) => u.signature.includes("Bun.randomUUIDv7"))).toBe(true)

    expect(BUN_CORE_API_DOMAINS).toHaveLength(7)
    expect(BUN_CORE_API_DOMAINS.map((d) => d.domain)).toEqual([
      "HTTP & Networking",
      "File & Object I/O",
      "Databases & Caches",
      "Parsers & Formats",
      "Subprocesses & Shell",
      "Crypto & Hashing",
      "Build, FFI & UI",
    ])
    expect(LIVE_SURFACE_AUDIT_SNIPPET).toContain("Object.getOwnPropertyNames(Bun)")
    expect(LIVE_SURFACE_AUDIT_SNIPPET).toContain('Bun.inspect.table(bunKeys, ["key", "type"])')
  })

  test("runs live surface audit against the active Bun runtime without exposing secrets", () => {
    const audit = runBunSurfaceAudit()

    expect(audit.source).toBe("bun-in-process")
    expect(audit.bunDetected).toBe(true)
    expect(audit.bunVersion).toBe(Bun.version)
    expect(audit.bunRevisionShort).toBe(Bun.revision.slice(0, 8))
    expect(audit.processEnvEqualsBunEnv).toBe(true)
    expect(audit.exportCount).toBeGreaterThan(30)

    // Exports are sorted alphabetically by key
    const keys = audit.exports.map((e) => e.key)
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b))
    expect(keys).toEqual(sortedKeys)
    expect(keys).toContain("serve")
    expect(keys).toContain("inspect")
    expect(keys).toContain("nanoseconds")
    expect(keys).toContain("deepEquals")

    expect(audit.inspectTableText).toContain(`Bun ${Bun.version} (${Bun.revision.slice(0, 8)})`)
    expect(audit.inspectTableText).toContain("serve")

    // Loader returns matching live audit under Bun
    const loaded = loadBunRuntimeSurfaceAudit()
    expect(loaded.bunDetected).toBe(true)
    expect(loaded.exportCount).toBe(audit.exportCount)
  })

  test("handles Node/browser fallback scope cleanly when Bun global is absent", () => {
    const mockScope: Record<string, unknown> = {
      fetch: () => {},
      URL,
      process: { versions: { node: "22.14.0" }, env: {} },
    }
    const audit = runBunSurfaceAudit(mockScope)
    expect(audit.source).toBe("node-fallback")
    expect(audit.bunDetected).toBe(false)
    expect(audit.exportCount).toBe(0)
    expect(audit.globalProbes.find((g) => g.name === "fetch")?.present).toBe(true)
    expect(audit.globalProbes.find((g) => g.name === "Bun")?.present).toBe(false)
  })

  test("evaluates cross-runtime utility helpers (UUIDv7, deepEquals, strings, color, table)", () => {
    const fixedTs = Date.UTC(2026, 10, 21, 12, 0, 0)
    const uuid = generateBunUuidV7(fixedTs)
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(decodeUuidV7TimestampIso(uuid)).toBe("2026-11-21T12:00:00.000Z")

    expect(bunDeepEquals({ a: 1, b: [2, 3] }, { b: [2, 3], a: 1 })).toBe(true)
    expect(bunDeepEquals({ a: 1, b: undefined }, { a: 1 }, false)).toBe(true)
    expect(bunDeepEquals({ a: 1, b: undefined }, { a: 1 }, true)).toBe(false)

    const strRes = evaluateBunStringUtilities("\u001b[32mOK\u001b[0m <b>hi</b>")
    expect(strRes.stripped).toBe("OK <b>hi</b>")
    expect(strRes.displayWidth).toBe(12)
    expect(strRes.escapedHtml).toContain("&lt;b&gt;hi&lt;/b&gt;")

    const colorRes = evaluateBunColorConversions("#38bdf8")
    expect(colorRes.valid).toBe(true)
    expect(colorRes.hex).toBe("#38bdf8")
    expect(colorRes.rgb).toBe("rgb(56, 189, 248)")
    expect(colorRes.number).toBe(0x38bdf8)
    expect(colorRes.ansi16m).toContain("38;2;56;189;248")

    const table = formatInspectTable(
      [
        { key: "inspect", type: "function" },
        { key: "version", type: "string" },
      ],
      ["key", "type"],
    )
    expect(table).toContain("inspect")
    expect(table).toContain("version")
  })
})

describe("StatusDashboardPanel & BunRuntimeSurfaceSection integration", () => {
  test("attaches runtimeSurface to ConfigStatusStore without leaking secrets and renders all sub-views", () => {
    const store = createConfigStatusStore({
      env: {
        PORT: "3000",
        SPORTSDESK_ADMIN_TOKEN: "top-secret-runtime-audit-token-never-leak",
      },
    })
    const snapshot = store.getSnapshot()
    const serialized = JSON.stringify(snapshot)

    expect(serialized).not.toContain("top-secret-runtime-audit-token-never-leak")
    expect(snapshot.runtimeSurface?.bunDetected).toBe(true)
    expect(snapshot.runtimeSurface?.exportCount).toBeGreaterThan(30)
    expect(snapshot.items.some((i) => i.key === "BUN_RUNTIME.surfaceAudit")).toBe(true)

    // Verify all 5 sub-tabs render cleanly via SSR
    const globalsHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit: snapshot.runtimeSurface,
        initialSubTab: "globals",
      }),
    )
    expect(globalsHtml).toContain('data-runtime-view="globals"')
    expect(globalsHtml).toContain("HTMLRewriter")
    expect(globalsHtml).toContain("CompressionStream")

    const utilitiesHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit: snapshot.runtimeSurface,
        initialSubTab: "utilities",
      }),
    )
    expect(utilitiesHtml).toContain('data-runtime-view="utilities"')
    expect(utilitiesHtml).toContain("Bun.nanoseconds()")
    expect(utilitiesHtml).toContain("Bun.zstdCompress")

    const coreApisHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit: snapshot.runtimeSurface,
        initialSubTab: "core-apis",
      }),
    )
    expect(coreApisHtml).toContain('data-runtime-view="core-apis"')
    expect(coreApisHtml).toContain("HTTP &amp; Networking")
    expect(coreApisHtml).toContain("bun:sqlite")

    const liveAuditHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit: snapshot.runtimeSurface,
        initialSubTab: "live-audit",
      }),
    )
    expect(liveAuditHtml).toContain('data-runtime-view="live-audit"')
    expect(liveAuditHtml).toContain("Object.getOwnPropertyNames(Bun)")
    expect(liveAuditHtml).toContain("Bun.serve")

    const sandboxHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit: snapshot.runtimeSurface,
        initialSubTab: "sandbox",
      }),
    )
    expect(sandboxHtml).toContain('data-runtime-view="sandbox"')
    expect(sandboxHtml).toContain("Bun.deepEquals")
    expect(sandboxHtml).toContain("Generate UUIDv7")

    const dashboardHtml = renderToStaticMarkup(
      React.createElement(StatusDashboardPanel, {
        snapshot,
        loading: false,
        error: null,
        saving: false,
        onRefresh: () => {},
        onSaveOverrides: () => true,
        onResetOverrides: () => {},
      }),
    )
    expect(dashboardHtml).toContain("Bun Runtime Surface")
  })
})
