import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { loadBunRuntimeSurfaceAudit } from "../../packages/api/src/bun_runtime_surface_loader.ts"
import { createConfigStatusStore } from "../../packages/api/src/config_status.ts"
import {
  BUN_ANSI_THEME_PRESETS,
  BUN_CAPABILITY_PILLARS,
  BUN_CORE_API_DOMAINS,
  BUN_GLOBAL_TIERS,
  BUN_MARKDOWN_CALLBACK_SPECS,
  BUN_UTILITIES_CATALOG,
  BUN_UTILITY_CATEGORIES,
  bunDeepEquals,
  classifyBunSymbolKind,
  decodeUuidV7TimestampIso,
  DEEP_SURFACE_AUDIT_SNIPPET,
  DEFAULT_BUN_MARKDOWN_STUDIO_SAMPLE,
  evaluateBunColorConversions,
  evaluateBunStringUtilities,
  formatInspectTable,
  generateBunUuidV7,
  LIVE_SURFACE_AUDIT_SNIPPET,
  probeBunCapabilityMatrix,
  renderBunMarkdownStudio,
  runBunSurfaceAudit,
} from "../../packages/contracts/src/bun_runtime_surface.ts"
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
    expect(DEEP_SURFACE_AUDIT_SNIPPET).toContain("bun:sqlite")
    expect(DEEP_SURFACE_AUDIT_SNIPPET).toContain("Bun.markdown")
    expect(BUN_ANSI_THEME_PRESETS.length).toBeGreaterThanOrEqual(4)
    expect(BUN_MARKDOWN_CALLBACK_SPECS.length).toBeGreaterThanOrEqual(10)

    expect(BUN_CAPABILITY_PILLARS).toHaveLength(6)
    expect(BUN_CAPABILITY_PILLARS.map((p) => p.title)).toEqual([
      "HTTP & WEBSOCKETS",
      "DATA",
      "FILES & PROCESSES",
      "SECURITY",
      "FORMATS",
      "LOW LEVEL",
    ])
    const flatCapabilityApis = BUN_CAPABILITY_PILLARS.flatMap((p) => p.items.map((i) => i.api))
    expect(flatCapabilityApis).toEqual([
      "Bun.serve()",
      "request.cookies",
      "fetch",
      "Bun.sql",
      "Bun.redis",
      "Bun.s3",
      "Bun.file()",
      "Bun.$",
      "Bun.spawn()",
      "Bun.password",
      "Bun.CSRF",
      "Bun.secrets",
      "Bun.YAML",
      "Bun.markdown",
      "Bun.escapeHTML()",
      "bun:ffi",
      "Worker",
      "Bun.Glob",
    ])
  })

  test("runs live surface audit with symbol kinds, deep bun:* modules, namespaces, and classes without exposing secrets", () => {
    const audit = runBunSurfaceAudit()

    expect(audit.source).toBe("bun-in-process")
    expect(audit.bunDetected).toBe(true)
    expect(audit.bunVersion).toBe(Bun.version)
    expect(audit.bunRevisionShort).toBe(Bun.revision.slice(0, 8))
    expect(audit.processEnvEqualsBunEnv).toBe(true)
    expect(audit.exportCount).toBeGreaterThan(30)

    // Symbol kind classification breakdown
    expect(audit.kindCounts.class).toBeGreaterThan(5)
    expect(audit.kindCounts.namespace).toBeGreaterThan(5)
    expect(audit.kindCounts.function).toBeGreaterThan(20)
    expect(audit.kindCounts.constant).toBeGreaterThan(2)
    expect(
      audit.kindCounts.class +
        audit.kindCounts.namespace +
        audit.kindCounts.function +
        audit.kindCounts.constant +
        audit.kindCounts.object,
    ).toBe(audit.exportCount)

    // Redaction of sensitive Bun namespaces
    const envExport = audit.exports.find((e) => e.key === "env")
    expect(envExport?.redacted).toBe(true)
    expect(envExport?.safePreview).toContain("REDACTED")

    // Safe constant previews & class/namespace metadata
    const versionExport = audit.exports.find((e) => e.key === "version")
    expect(versionExport?.kind).toBe("constant")
    expect(versionExport?.safePreview).toBe(Bun.version)

    const markdownExport = audit.exports.find((e) => e.key === "markdown")
    expect(markdownExport?.kind).toBe("namespace")
    expect(markdownExport?.memberCount ?? 0).toBeGreaterThanOrEqual(4)

    const s3ClassExport = audit.exports.find((e) => e.key === "S3Client")
    expect(s3ClassExport?.kind).toBe("class")
    expect(s3ClassExport?.prototypeMethodCount ?? 0).toBeGreaterThan(3)

    // Exports are sorted alphabetically by key
    const keys = audit.exports.map((e) => e.key)
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b))
    expect(keys).toEqual(sortedKeys)
    expect(keys).toContain("serve")
    expect(keys).toContain("inspect")
    expect(keys).toContain("nanoseconds")
    expect(keys).toContain("deepEquals")
    expect(keys).toContain("markdown")

    expect(audit.inspectTableText).toContain(`Bun ${Bun.version} (${Bun.revision.slice(0, 8)})`)
    expect(audit.inspectTableText).toContain("serve")

    // Loader returns matching live audit WITH deep bun:* built-in module inspections
    const loaded = loadBunRuntimeSurfaceAudit()
    expect(loaded.bunDetected).toBe(true)
    expect(loaded.exportCount).toBe(audit.exportCount)
    expect(loaded.deepInspections.length).toBeGreaterThan(20)

    const mdDeep = loaded.deepInspections.find((d) => d.id === "Bun.markdown")
    expect(mdDeep?.available).toBe(true)
    expect(mdDeep?.members.map((m) => m.name)).toEqual(
      expect.arrayContaining(["html", "ansi", "render", "react"]),
    )

    const sqliteDeep = loaded.deepInspections.find((d) => d.id === "bun:sqlite")
    expect(sqliteDeep?.available).toBe(true)
    expect(sqliteDeep?.members.some((m) => m.name === "Database" && m.kind === "class")).toBe(true)
    expect(sqliteDeep?.members.some((m) => m.name.startsWith("constants.SQLITE_"))).toBe(true)

    const ffiDeep = loaded.deepInspections.find((d) => d.id === "bun:ffi")
    expect(ffiDeep?.available).toBe(true)
    expect(ffiDeep?.members.some((m) => m.name.startsWith("FFIType."))).toBe(true)

    const jscDeep = loaded.deepInspections.find((d) => d.id === "bun:jsc")
    expect(jscDeep?.available).toBe(true)
    expect(jscDeep?.functionCount).toBeGreaterThan(10)

    const s3Deep = loaded.deepInspections.find((d) => d.id === "Bun.S3Client")
    expect(s3Deep?.available).toBe(true)
    expect(s3Deep?.members.some((m) => m.scope === "prototype")).toBe(true)

    const secretsDeep = loaded.deepInspections.find((d) => d.id === "Bun.secrets")
    expect(secretsDeep?.available).toBe(true)
    expect(secretsDeep?.members.map((m) => m.name)).toEqual(
      expect.arrayContaining(["delete", "get", "set"]),
    )
    expect(secretsDeep?.members.every((m) => m.safePreview === undefined)).toBe(true)

    const matrix = probeBunCapabilityMatrix(loaded)
    expect(matrix).toHaveLength(6)
    const totalMatrixItems = matrix.reduce((acc, p) => acc + p.totalCount, 0)
    const availableMatrixItems = matrix.reduce((acc, p) => acc + p.availableCount, 0)
    expect(totalMatrixItems).toBe(18)
    expect(availableMatrixItems).toBeGreaterThanOrEqual(16)
    expect(matrix.find((p) => p.id === "security")?.availableCount).toBe(3)
    expect(matrix.find((p) => p.id === "formats")?.availableCount).toBe(3)
  })

  test("classifies symbol kinds accurately across classes, namespaces, functions, constants, and objects", () => {
    class SampleClass {
      run(): number {
        return 1
      }
    }
    expect(classifyBunSymbolKind(SampleClass, "SampleClass")).toBe("class")
    expect(classifyBunSymbolKind(() => 42, "helper")).toBe("function")
    expect(classifyBunSymbolKind({ parse: () => null }, "YAML")).toBe("namespace")
    expect(classifyBunSymbolKind("1.4.4", "version")).toBe("constant")
    expect(classifyBunSymbolKind(true, "isMainThread")).toBe("constant")
    expect(classifyBunSymbolKind({ plain: 1 }, "meta")).toBe("object")
  })

  test("evaluates Bun.markdown.render callbacks, Bun.markdown.ansi AnsiTheme, and HTML modes safely", () => {
    const callbacksRes = renderBunMarkdownStudio(DEFAULT_BUN_MARKDOWN_STUDIO_SAMPLE, {
      mode: "render-callbacks",
      presetId: "obsidian-desk",
      theme: { colors: true, hyperlinks: true, light: false, columns: 76 },
    })
    expect(callbacksRes.engine).toBe("bun-native")
    expect(callbacksRes.ansi).toContain("\u001b[38;2;56;189;248m") // heading #38bdf8
    expect(callbacksRes.ansi).toContain("\u001b[38;2;239;68;68m[REDACTED:TOKEN]") // redacted #ef4444
    expect(callbacksRes.ansi).toContain("\u001b]8;;https://fantasy402.com/") // safe OSC-8 link
    expect(callbacksRes.ansi).not.toContain("javascript:alert") // unsafe link stripped
    expect(callbacksRes.callbacksInvoked).toEqual(
      expect.arrayContaining(["heading", "strong", "codespan", "link", "blockquote"]),
    )

    const ansiThemeRes = renderBunMarkdownStudio(DEFAULT_BUN_MARKDOWN_STUDIO_SAMPLE, {
      mode: "ansi-theme",
      presetId: "light-paper",
      theme: { colors: true, light: true, hyperlinks: true, columns: 72 },
    })
    expect(ansiThemeRes.engine).toBe("bun-native")
    expect(ansiThemeRes.ansiTheme.light).toBe(true)
    expect(ansiThemeRes.ansi).not.toContain("javascript:alert")
    expect(ansiThemeRes.plain).toContain("SportsDesk Ops")

    const signedS3Test = renderBunMarkdownStudio(
      "[Signed](https://r2.example.com/obj?X-Amz-Signature=secret123&X-Amz-Credential=abc)",
      { mode: "render-callbacks", theme: { colors: true, hyperlinks: true } },
    )
    expect(signedS3Test.ansi).not.toContain("X-Amz-Signature")

    const htmlRes = renderBunMarkdownStudio("**bold** `code`", { mode: "html" })
    expect(htmlRes.engine).toBe("bun-native")
    expect(htmlRes.html).toContain("<strong>bold</strong>")
    expect(htmlRes.html).toContain("<code>code</code>")
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
    expect(audit.kindCounts).toEqual({
      class: 0,
      namespace: 0,
      function: 0,
      constant: 0,
      object: 0,
    })
    expect(audit.globalProbes.find((g) => g.name === "fetch")?.present).toBe(true)
    expect(audit.globalProbes.find((g) => g.name === "Bun")?.present).toBe(false)

    const fallbackMatrix = probeBunCapabilityMatrix(audit)
    const fetchItem = fallbackMatrix
      .find((p) => p.id === "http-websockets")
      ?.items.find((i) => i.id === "fetch-http2")
    expect(fetchItem?.available).toBe(true)
    expect(fetchItem?.matchedSymbols).toEqual(["fetch"])
    const sqlItem = fallbackMatrix
      .find((p) => p.id === "data")
      ?.items.find((i) => i.id === "bun-sql")
    expect(sqlItem?.available).toBe(false)
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
  test("attaches runtimeSurface to ConfigStatusStore without leaking secrets and renders all 6 sub-views", () => {
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
    expect(snapshot.runtimeSurface?.deepInspections.length).toBeGreaterThan(20)
    expect(snapshot.items.some((i) => i.key === "BUN_RUNTIME.surfaceAudit")).toBe(true)

    // Verify all 6 sub-tabs render cleanly via SSR
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
    expect(coreApisHtml).toContain('data-bun-capability-matrix="true"')
    expect(coreApisHtml).toContain('data-capability-pillar="http-websockets"')
    expect(coreApisHtml).toContain('data-capability-pillar="low-level"')
    expect(coreApisHtml).toContain("HTTP &amp; WEBSOCKETS")
    expect(coreApisHtml).toContain("FILES &amp; PROCESSES")
    expect(coreApisHtml).toContain("Bun.serve()")
    expect(coreApisHtml).toContain("request.cookies")
    expect(coreApisHtml).toContain("Bun.secrets")
    expect(coreApisHtml).toContain("Bun.escapeHTML()")
    expect(coreApisHtml).toContain("Bun.Glob")
    expect(coreApisHtml).toContain("HTTP &amp; Networking")
    expect(coreApisHtml).toContain("bun:sqlite")

    const modulesClassesHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit: snapshot.runtimeSurface,
        initialSubTab: "modules-classes",
      }),
    )
    expect(modulesClassesHtml).toContain('data-runtime-view="modules-classes"')
    expect(modulesClassesHtml).toContain('data-deep-target-id="Bun.markdown"')
    expect(modulesClassesHtml).toContain('data-deep-target-id="bun:sqlite"')
    expect(modulesClassesHtml).toContain('data-deep-target-id="bun:ffi"')
    expect(modulesClassesHtml).toContain('data-deep-target-id="Bun.S3Client"')

    const liveAuditHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit: snapshot.runtimeSurface,
        initialSubTab: "live-audit",
      }),
    )
    expect(liveAuditHtml).toContain('data-runtime-view="live-audit"')
    expect(liveAuditHtml).toContain("Object.getOwnPropertyNames(Bun)")
    expect(liveAuditHtml).toContain("Bun.serve")
    expect(liveAuditHtml).toContain('data-bun-export-kind="class"')
    expect(liveAuditHtml).toContain('data-bun-export-kind="namespace"')

    const sandboxHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit: snapshot.runtimeSurface,
        initialSubTab: "sandbox",
      }),
    )
    expect(sandboxHtml).toContain('data-runtime-view="sandbox"')
    expect(sandboxHtml).toContain('data-bun-markdown-studio="true"')
    expect(sandboxHtml).toContain('data-markdown-ansi-preview="true"')
    expect(sandboxHtml).toContain("Bun.markdown.render()")
    expect(sandboxHtml).toContain("AnsiTheme")
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
