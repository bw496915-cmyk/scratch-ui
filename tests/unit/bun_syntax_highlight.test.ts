import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  bunColorAnsi16m,
  bunColorCss,
  bunEscapeHtml,
  bunStringWidth,
  bunStripAnsi,
  computeHighlightedBlockMetrics,
  convertEnvTemplateToBunYaml,
  detectBunUtilitiesCapabilities,
  formatSyntaxAsBunTerminalAnsi,
  SYNTAX_TOKEN_PALETTE,
  tokenizeEnv,
  tokenizeJson,
  tokenizeMarkdownBrief,
  tokenizeToml,
  tokenizeYaml,
} from "../../packages/contracts/src/bun_syntax_highlight.ts"
import { NpmrcSupportSection } from "../../packages/ui/src/panels/NpmrcSupportSection.tsx"
import { SurveillanceTabPanel } from "../../packages/ui/src/panels/SurveillanceTabPanel.tsx"
import { SyntaxHighlightedPre } from "../../packages/ui/src/panels/SyntaxHighlightedPre.tsx"
import { YamlRuntimeSection } from "../../packages/ui/src/panels/YamlRuntimeSection.tsx"

describe("Bun Utilities API, Bun.YAML & Bun.Terminal Syntax Highlighting", () => {
  test("detects native Bun Utilities APIs and produces exact CSS, ANSI-16m, width & HTML escapes", () => {
    const caps = detectBunUtilitiesCapabilities()
    expect(caps.runtime).toBe("bun")
    expect(caps.hasBunColor).toBe(true)
    expect(caps.hasBunStringWidth).toBe(true)
    expect(caps.hasBunStripAnsi).toBe(true)
    expect(caps.hasBunEscapeHtml).toBe(true)
    expect(caps.hasBunYaml).toBe(true)

    expect(bunColorCss(SYNTAX_TOKEN_PALETTE.key.hex).toLowerCase()).toBe("#7dd3fc")
    const ansiSeq = bunColorAnsi16m("#7dd3fc")
    expect(ansiSeq).toContain("\x1b[38;2;")
    expect(bunStripAnsi(`${ansiSeq}hello\x1b[0m`)).toBe("hello")
    expect(bunStringWidth(`${ansiSeq}hello\x1b[0m`)).toBe(5)
    expect(bunEscapeHtml('<script>"ok"</script>')).toBe(
      "&lt;script&gt;&quot;ok&quot;&lt;/script&gt;",
    )
  })

  test("tokenizes JSON, YAML, TOML, .env, and Markdown briefs into keys, strings, numbers, and booleans", () => {
    const jsonTokens = tokenizeJson(
      '{"autoExecute": false, "port": 3000, "host": "sportsdesk", "note": null}',
    )
    expect(jsonTokens.some((t) => t.type === "key" && t.value === '"autoExecute"')).toBe(true)
    expect(jsonTokens.some((t) => t.type === "boolean" && t.value === "false")).toBe(true)
    expect(jsonTokens.some((t) => t.type === "number" && t.value === "3000")).toBe(true)
    expect(jsonTokens.some((t) => t.type === "string" && t.value === '"sportsdesk"')).toBe(true)
    expect(jsonTokens.some((t) => t.type === "null" && t.value === "null")).toBe(true)

    const yamlTokens = tokenizeYaml(
      "---\nschemaVersion: 1\nenabled: true\ntitle: Live Odds\n# comment\n",
    )
    expect(yamlTokens.some((t) => t.type === "section" && t.value === "---")).toBe(true)
    expect(yamlTokens.some((t) => t.type === "key" && t.value === "schemaVersion")).toBe(true)
    expect(yamlTokens.some((t) => t.type === "number" && t.value === "1")).toBe(true)
    expect(yamlTokens.some((t) => t.type === "boolean" && t.value === "true")).toBe(true)
    expect(yamlTokens.some((t) => t.type === "string" && t.value === "Live Odds")).toBe(true)
    expect(yamlTokens.some((t) => t.type === "comment" && t.value === "# comment")).toBe(true)

    const tomlTokens = tokenizeToml(
      '[install]\nignoreScripts = true\nminimumReleaseAge = 604800\nlinker = "isolated"\n',
    )
    expect(tomlTokens.some((t) => t.type === "section" && t.value === "[install]")).toBe(true)
    expect(tomlTokens.some((t) => t.type === "key" && t.value === "ignoreScripts")).toBe(true)
    expect(tomlTokens.some((t) => t.type === "boolean" && t.value === "true")).toBe(true)
    expect(tomlTokens.some((t) => t.type === "number" && t.value === "604800")).toBe(true)
    expect(tomlTokens.some((t) => t.type === "string" && t.value === '"isolated"')).toBe(true)

    const envTokens = tokenizeEnv("# Server\nPORT=3000\nAUTO_EXECUTE=false\nHOST=localhost\n")
    expect(envTokens.some((t) => t.type === "comment" && t.value === "# Server")).toBe(true)
    expect(envTokens.some((t) => t.type === "key" && t.value === "PORT")).toBe(true)
    expect(envTokens.some((t) => t.type === "number" && t.value === "3000")).toBe(true)
    expect(envTokens.some((t) => t.type === "boolean" && t.value === "false")).toBe(true)
    expect(envTokens.some((t) => t.type === "string" && t.value === "localhost")).toBe(true)

    const mdTokens = tokenizeMarkdownBrief(
      '# Status Brief\n- **autoExecute**: false\n- Latency: 12.4ms "healthy"\n```yaml\nenabled: true\nlimit: 500\n```',
    )
    expect(mdTokens.some((t) => t.type === "section" && t.value.includes("Status Brief"))).toBe(
      true,
    )
    expect(mdTokens.some((t) => t.type === "key" && t.value === "autoExecute")).toBe(true)
    expect(mdTokens.some((t) => t.type === "boolean" && t.value === "false")).toBe(true)
    expect(mdTokens.some((t) => t.type === "number" && t.value === "12.4ms")).toBe(true)
    expect(mdTokens.some((t) => t.type === "string" && t.value === '"healthy"')).toBe(true)
    expect(mdTokens.some((t) => t.type === "boolean" && t.value === "true")).toBe(true)
    expect(mdTokens.some((t) => t.type === "number" && t.value === "500")).toBe(true)
  })

  test("formatSyntaxAsBunTerminalAnsi preserves exact plain text after Bun.stripANSI and reports metrics", () => {
    const sample = '{"enabled": true, "port": 3000, "env": "prod"}'
    const ansi = formatSyntaxAsBunTerminalAnsi(sample, "json")
    expect(ansi).toContain("\x1b[38;2;")
    expect(bunStripAnsi(ansi)).toBe(sample)

    const metrics = computeHighlightedBlockMetrics(sample, "json")
    expect(metrics.lineCount).toBe(1)
    expect(metrics.maxColumnWidth).toBe(sample.length)
    expect(metrics.tokenCounts.key).toBe(3)
    expect(metrics.tokenCounts.boolean).toBe(1)
    expect(metrics.tokenCounts.number).toBe(1)
    expect(metrics.tokenCounts.string).toBe(1)
  })

  test("convertEnvTemplateToBunYaml converts .env template to typed YAML via Bun.YAML", () => {
    const res = convertEnvTemplateToBunYaml(
      "# Config\nPORT=3000\nAUTO_EXECUTE=false\nAPI_URL=https://example.test\nSECRET_KEY=\n",
    )
    expect(res.entryCount).toBe(4)
    expect(res.yaml).toContain("PORT: 3000")
    expect(res.yaml).toContain("AUTO_EXECUTE: false")
    expect(res.yaml).toContain("API_URL:")
    expect(res.yaml).toContain("SECRET_KEY: null")
  })

  test("renders highlighted pre blocks in SyntaxHighlightedPre, SurveillanceTabPanel, NpmrcSupportSection, and YamlRuntimeSection", () => {
    const preTokensHtml = renderToStaticMarkup(
      React.createElement(SyntaxHighlightedPre, {
        text: '{"active": true, "count": 42, "label": "ok"}',
        format: "json",
      }),
    )
    expect(preTokensHtml).toContain('data-syntax-pre="true"')
    expect(preTokensHtml).toContain('data-syntax-token="key"')
    expect(preTokensHtml).toContain('data-syntax-token="boolean"')
    expect(preTokensHtml).toContain('data-syntax-token="number"')
    expect(preTokensHtml).toContain('data-syntax-token="string"')

    const preAnsiHtml = renderToStaticMarkup(
      React.createElement(SyntaxHighlightedPre, {
        text: 'enabled: true\nport: 3000\nmode: "live"',
        format: "yaml",
        renderMode: "ansi",
      }),
    )
    expect(preAnsiHtml).toContain('data-syntax-render-mode="ansi"')
    expect(preAnsiHtml).toContain("rgb(")

    const survHtml = renderToStaticMarkup(
      React.createElement(SurveillanceTabPanel, {
        dnsData: null,
        benchLoading: false,
        benchResult: null,
        onRunBenchmark: () => {},
        reverseIp: "1.1.1.1",
        onReverseIpChange: () => {},
        onRunReverseLookup: () => {},
        viewMode: "raw",
        onViewModeChange: () => {},
        data: {
          html: "<h1>Brief</h1>",
          markdown: '# Brief\n- **autoExecute**: false\n- Latency: 9.2ms "ok"\n',
          updatedAt: "2026-11-20T18:00:00Z",
        },
      }),
    )
    expect(survHtml).toContain('data-surveillance-raw-pre="true"')
    expect(survHtml).toContain('data-syntax-pre="true"')
    expect(survHtml).toContain('data-syntax-legend="true"')
    expect(survHtml).toContain('data-surveillance-ansi-toggle="true"')
    expect(survHtml).toContain('data-copy-bun-terminal-ansi="true"')
    expect(survHtml).toContain('data-syntax-token="key"')
    expect(survHtml).toContain('data-syntax-token="boolean"')
    expect(survHtml).toContain('data-syntax-token="number"')
    expect(survHtml).toContain('data-syntax-token="string"')

    const npmrcHtml = renderToStaticMarkup(
      React.createElement(NpmrcSupportSection, { summary: null }),
    )
    expect(npmrcHtml).toContain('data-bunfig-preview="true"')
    expect(npmrcHtml).toContain('data-syntax-format="toml"')
    expect(npmrcHtml).toContain('data-syntax-token="key"')
    expect(npmrcHtml).toContain('data-syntax-token="boolean"')

    const yamlHtml = renderToStaticMarkup(
      React.createElement(YamlRuntimeSection, { summary: null }),
    )
    expect(yamlHtml).toContain('data-bun-yaml-json-preview="true"')
    expect(yamlHtml).toContain('data-syntax-format="json"')
    expect(yamlHtml).toContain('data-bun-yaml-stringify-preview="true"')
    expect(yamlHtml).toContain('data-syntax-format="yaml"')
    expect(yamlHtml).toContain('data-copy-bun-terminal-ansi="true"')
  })
})
