import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { createConfigStatusStore } from "../../packages/api/src/config_status.ts"
import { loadWorkspaceYamlConfigSummary } from "../../packages/api/src/yaml_loader.ts"
import {
  ERR_YAML_TOO_LARGE,
  isNativeBunYamlAvailable,
  parseBunYaml,
  parseBunYamlWithMeta,
  redactYamlSensitiveValues,
  safeJsonPreview,
  stringifyBunYaml,
} from "../../packages/contracts/src/bun_yaml.ts"
import { StatusDashboardPanel } from "../../packages/ui/src/panels/StatusDashboardPanel.tsx"
import { YamlRuntimeSection } from "../../packages/ui/src/panels/YamlRuntimeSection.tsx"

describe("Bun.YAML.parse & YAML 1.2 cross-runtime engine", () => {
  test("parses YAML 1.2 scalars, nested objects, and arrays identically on native Bun.YAML.parse and TS fallback", () => {
    const sample = `
# SportsDesk sample config
name: John Doe
age: 30
active: true
disabled: false
emptyVal: ~
hexCode: 0x2a
octalPerm: 0o755
ratio: 3.5
hobbies:
  - reading
  - coding
  - hiking
nested:
  host: "localhost:3000"
  note: 'it''s ready'
`

    expect(isNativeBunYamlAvailable()).toBe(true)

    const nativeRes = parseBunYamlWithMeta<Record<string, unknown>>(sample)
    const fallbackRes = parseBunYamlWithMeta<Record<string, unknown>>(sample, {
      forceFallback: true,
    })

    expect(nativeRes.engine).toBe("bun-native")
    expect(fallbackRes.engine).toBe("ts-fallback")
    expect(nativeRes.isMultiDocument).toBe(false)
    expect(fallbackRes.isMultiDocument).toBe(false)
    expect(fallbackRes.value).toEqual(nativeRes.value)
    expect(nativeRes.value).toEqual({
      name: "John Doe",
      age: 30,
      active: true,
      disabled: false,
      emptyVal: null,
      hexCode: 42,
      octalPerm: 493,
      ratio: 3.5,
      hobbies: ["reading", "coding", "hiking"],
      nested: {
        host: "localhost:3000",
        note: "it's ready",
      },
    })
  })

  test("returns an array of documents for multi-document YAML streams (---)", () => {
    const multiDoc = `
---
name: Document 1
port: 3000
---
name: Document 2
port: 3001
`

    const nativeRes = parseBunYamlWithMeta<unknown[]>(multiDoc)
    const fallbackRes = parseBunYamlWithMeta<unknown[]>(multiDoc, {
      forceFallback: true,
    })

    expect(nativeRes.isMultiDocument).toBe(true)
    expect(nativeRes.documentCount).toBe(2)
    expect(fallbackRes.isMultiDocument).toBe(true)
    expect(fallbackRes.documentCount).toBe(2)

    const expected = [
      { name: "Document 1", port: 3000 },
      { name: "Document 2", port: 3001 },
    ]
    expect(nativeRes.value).toEqual(expected)
    expect(fallbackRes.value).toEqual(expected)
  })

  test("preserves anchor/alias reference identity, supports merge keys (<<), and handles cyclic references safely", () => {
    const withAnchors = `
defaults: &def
  timeoutMs: 5000
  retries: 3
primary:
  <<: *def
  host: east.internal
shared: *def
`

    const nativeParsed = parseBunYaml<Record<string, unknown>>(withAnchors)
    const fallbackParsed = parseBunYaml<Record<string, unknown>>(withAnchors, {
      forceFallback: true,
    })

    expect(nativeParsed.shared).toBe(nativeParsed.defaults)
    expect(fallbackParsed.shared).toBe(fallbackParsed.defaults)
    expect(fallbackParsed.primary).toEqual({
      timeoutMs: 5000,
      retries: 3,
      host: "east.internal",
    })

    // Cyclic anchor reference
    const cyclicYaml = `
node: &self
  label: root
  parent: *self
`
    const nativeCyclic = parseBunYamlWithMeta<Record<string, Record<string, unknown>>>(cyclicYaml)
    const fallbackCyclic = parseBunYamlWithMeta<Record<string, Record<string, unknown>>>(cyclicYaml, {
      forceFallback: true,
    })

    expect(nativeCyclic.hasCircularRefs).toBe(true)
    expect(fallbackCyclic.hasCircularRefs).toBe(true)
    expect(nativeCyclic.value.node!.parent).toBe(nativeCyclic.value.node)
    expect(fallbackCyclic.value.node!.parent).toBe(fallbackCyclic.value.node)

    const jsonText = safeJsonPreview(nativeCyclic.value, 2)
    expect(jsonText).toContain("[Circular]")
  })

  test("supports literal/folded block scalars and explicit YAML 1.2 tags", () => {
    const sample = `
literalClip: |
  alpha
  beta
literalStrip: |-
  gamma
  delta
foldedStrip: >-
  first line
  second line
zipCode: !!str 02138
forcedInt: !!int "42"
forcedBool: !!bool "true"
forcedNull: !!null "anything"
`

    const nativeVal = parseBunYaml<Record<string, unknown>>(sample)
    const fallbackVal = parseBunYaml<Record<string, unknown>>(sample, {
      forceFallback: true,
    })

    expect(fallbackVal).toEqual({
      literalClip: "alpha\nbeta\n",
      literalStrip: "gamma\ndelta",
      foldedStrip: "first line second line",
      zipCode: "02138",
      forcedInt: 42,
      forcedBool: true,
      forcedNull: null,
    })
    expect(nativeVal.literalClip).toBe("alpha\nbeta\n")
    expect(nativeVal.literalStrip).toBe("gamma\ndelta")
    expect(nativeVal.zipCode).toBe("02138")
  })

  test("supports stringifyBunYaml in compact flow mode and indented block mode", () => {
    const obj = { server: "localhost", port: 8080, flags: ["a", "b"] }

    const nativeBlock = stringifyBunYaml(obj, { space: 2 })
    expect(nativeBlock).toContain("server: localhost")
    expect(nativeBlock).toContain("port: 8080")

    const fallbackFlow = stringifyBunYaml(obj, { forceFallback: true })
    expect(fallbackFlow).toBe("{server: localhost, port: 8080, flags: [a, b]}")

    const fallbackBlock = stringifyBunYaml(obj, { space: 2, forceFallback: true })
    expect(fallbackBlock).toContain("server: localhost\nport: 8080")
    expect(parseBunYaml(fallbackBlock)).toEqual(obj)
  })

  test("enforces prototype-pollution stripping, payload byte limits, and secret key redaction", () => {
    const malicious = `
safeKey: ok
__proto__:
  polluted: true
constructor:
  evil: 1
prototype:
  bad: 2
`
    const nativeClean = parseBunYaml<Record<string, unknown>>(malicious)
    const fallbackClean = parseBunYaml<Record<string, unknown>>(malicious, {
      forceFallback: true,
    })

    expect(Object.prototype.hasOwnProperty.call(nativeClean, "__proto__")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(nativeClean, "constructor")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(nativeClean, "prototype")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(fallbackClean, "__proto__")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(fallbackClean, "constructor")).toBe(false)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()

    expect(() => parseBunYaml("a: 1\n", { maxBytes: 2 })).toThrow(ERR_YAML_TOO_LARGE)

    const redacted = redactYamlSensitiveValues({
      host: "desk.internal",
      apiToken: "super-secret-123",
      nested: { password: "p@ss", timeout: 5000 },
    }) as Record<string, unknown>
    expect(redacted.host).toBe("desk.internal")
    expect(redacted.apiToken).toBe("[REDACTED]")
    expect((redacted.nested as Record<string, unknown>).password).toBe("[REDACTED]")
    expect((redacted.nested as Record<string, unknown>).timeout).toBe(5000)
  })
})

describe("Workspace config/bet-flags.yml loader, Status API & UI", () => {
  test("parses workspace config/bet-flags.yml identically via native Bun.YAML.parse and TS fallback", () => {
    const nativeSummary = loadWorkspaceYamlConfigSummary()
    const fallbackSummary = loadWorkspaceYamlConfigSummary({
      forceFallback: true,
    })

    expect(nativeSummary.detected).toBe(true)
    expect(nativeSummary.parseError).toBeUndefined()
    expect(nativeSummary.engine).toBe("bun-native")
    expect(nativeSummary.schemaVersion).toBe(1)
    expect(nativeSummary.totalRules).toBe(14)
    expect(nativeSummary.enabledRules).toBe(2)
    expect(nativeSummary.disabledRules).toBe(12)
    expect(nativeSummary.aggregateRules).toBe(3)

    // Ensure TS fallback matches native Bun.YAML.parse rule-for-rule (including multi-line flow maps)
    expect(fallbackSummary.engine).toBe("ts-fallback")
    expect(fallbackSummary.schemaVersion).toBe(nativeSummary.schemaVersion)
    expect(fallbackSummary.totalRules).toBe(nativeSummary.totalRules)
    expect(fallbackSummary.enabledRules).toBe(nativeSummary.enabledRules)
    expect(fallbackSummary.aggregateRules).toBe(nativeSummary.aggregateRules)
    expect(fallbackSummary.rules).toEqual(nativeSummary.rules)

    // Path traversal outside workspace root is rejected fail-closed
    const traversal = loadWorkspaceYamlConfigSummary({
      relativePath: "../../../etc/passwd",
    })
    expect(traversal.detected).toBe(false)
    expect(traversal.parseError).toContain("outside workspace root")
  })

  test("attaches yamlConfig to ConfigStatusStore and renders YamlRuntimeSection & StatusDashboardPanel", () => {
    const store = createConfigStatusStore()
    const snapshot = store.getSnapshot()

    expect(snapshot.yamlConfig?.detected).toBe(true)
    expect(snapshot.yamlConfig?.totalRules).toBe(14)
    expect(snapshot.items.some((i) => i.key === "BUN_YAML.betFlagsSchemaVersion")).toBe(true)
    expect(snapshot.items.some((i) => i.key === "BUN_YAML.engine")).toBe(true)

    const sectionHtml = renderToStaticMarkup(
      React.createElement(YamlRuntimeSection, {
        summary: snapshot.yamlConfig,
      }),
    )
    expect(sectionHtml).toContain('data-bun-yaml-workspace="true"')
    expect(sectionHtml).toContain('data-bun-yaml-playground="true"')
    expect(sectionHtml).toContain("stake_over_10k")
    expect(sectionHtml).toContain("live_american_odds_400_plus")
    expect(sectionHtml).toContain("Bun.YAML.parse")

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
    expect(dashboardHtml).toContain("YAML (Bun.YAML)")
  })
})
