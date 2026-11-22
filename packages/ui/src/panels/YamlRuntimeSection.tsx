import { AlertCircle, Check, Copy, Download, Search, ShieldCheck } from "lucide-react"
import type React from "react"
import { useMemo, useState } from "react"

import {
  parseBunYamlWithMeta,
  redactYamlSensitiveValues,
  safeJsonPreview,
  stringifyBunYaml,
  type WorkspaceYamlConfigSummary,
} from "@sportsdesk-ops/contracts"

import {
  CopyBunTerminalAnsiButton,
  SyntaxHighlightedPre,
  SyntaxTokenLegend,
} from "./SyntaxHighlightedPre.tsx"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

export interface YamlPresetItem {
  readonly id: string
  readonly label: string
  readonly yaml: string
}

export const YAML_PLAYGROUND_PRESETS: readonly YamlPresetItem[] = [
  {
    id: "bet-flag",
    label: "Bet Flag Rule",
    yaml: `# YAML 1.2 rule pack sample (evaluated locally via Bun.YAML.parse)
schemaVersion: 1
rules:
  - id: live_american_odds_400_plus
    title: Live bet at +400 or longer
    severity: medium
    enabled: true
    tags: [odds, live]
    when:
      all:
        - { field: isLive, op: eq, value: true }
        - { field: americanOdds, op: gte, value: 400 }
    aggregate:
      {
        groupBy: customerId,
        windowSeconds: 60,
        countAtLeast: 3,
      }
`,
  },
  {
    id: "multi-doc",
    label: "Multi-Document (---)",
    yaml: `---
name: Primary Desk Config
environment: production
port: 3000
features:
  - live-ticker
  - bet-flags
---
name: Failover Desk Config
environment: standby
port: 3001
features:
  - read-only-audit
`,
  },
  {
    id: "anchors",
    label: "Anchors & Aliases",
    yaml: `defaults: &desk_defaults
  timeoutMs: 5000
  retries: 3
  tls: true

services:
  primary:
    <<: *desk_defaults
    host: desk-east.internal
  secondary:
    <<: *desk_defaults
    host: desk-west.internal
    retries: 5
  sharedRef: *desk_defaults
`,
  },
  {
    id: "scalars-tags",
    label: "Block Scalars & Tags",
    yaml: `notes: |
  Line 1 preserved verbatim
  Line 2 preserved verbatim
summary: >-
  Folded paragraph joins adjacent
  lines into a single clean sentence.
explicitTypes:
  zipCode: !!str 02138
  hexLimit: 0x100
  octalMode: 0o755
  infinityCap: .inf
  emptyField: ~
`,
  },
]

export interface YamlRuntimeSectionProps {
  readonly summary?: WorkspaceYamlConfigSummary | null | undefined
}

function severityColor(severity: string): string {
  switch (severity.toLowerCase()) {
    case "critical":
      return "#f87171"
    case "high":
      return "#fb923c"
    case "medium":
      return "#fbbf24"
    case "low":
      return "#38bdf8"
    default:
      return "#94a3b8"
  }
}

export function YamlRuntimeSection({
  summary = null,
}: YamlRuntimeSectionProps): React.ReactElement {
  const [ruleStatusFilter, setRuleStatusFilter] = useState<"all" | "enabled" | "disabled">("all")
  const [ruleSearch, setRuleSearch] = useState<string>("")

  const [activePresetId, setActivePresetId] = useState<string>(YAML_PLAYGROUND_PRESETS[0]!.id)
  const [yamlText, setYamlText] = useState<string>(YAML_PLAYGROUND_PRESETS[0]!.yaml)
  const [stringifyMode, setStringifyMode] = useState<"block" | "flow">("block")
  const [copiedOutput, setCopiedOutput] = useState<boolean>(false)

  const filteredRules = useMemo(() => {
    if (!summary) return []
    const q = ruleSearch.trim().toLowerCase()
    return summary.rules.filter((rule) => {
      if (ruleStatusFilter === "enabled" && !rule.enabled) return false
      if (ruleStatusFilter === "disabled" && rule.enabled) return false
      if (q) {
        const hay = [rule.id, rule.title, rule.severity, rule.aggregateGroupBy ?? "", ...rule.tags]
          .join(" ")
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [summary, ruleStatusFilter, ruleSearch])

  const playgroundEvaluation = useMemo(() => {
    try {
      const parsed = parseBunYamlWithMeta(yamlText)
      const redacted = redactYamlSensitiveValues(parsed.value)
      const jsonPreview = safeJsonPreview(redacted, 2)
      const roundTripYaml = stringifyBunYaml(redacted, {
        space: stringifyMode === "block" ? 2 : undefined,
      })
      return {
        ok: true as const,
        parsed,
        jsonPreview,
        roundTripYaml,
      }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [yamlText, stringifyMode])

  const handleSelectPreset = (preset: YamlPresetItem) => {
    setActivePresetId(preset.id)
    setYamlText(preset.yaml)
  }

  const handleCopyYaml = async () => {
    if (!playgroundEvaluation.ok) return
    try {
      await navigator.clipboard.writeText(playgroundEvaluation.roundTripYaml)
      setCopiedOutput(true)
      setTimeout(() => setCopiedOutput(false), 1800)
    } catch {
      setCopiedOutput(false)
    }
  }

  const handleDownloadYaml = () => {
    if (!playgroundEvaluation.ok || typeof document === "undefined") return
    const blob = new Blob([`${playgroundEvaluation.roundTripYaml}\n`], {
      type: "text/yaml;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "parsed-config.yaml"
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div
      data-status-view="yaml"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* 1. Workspace config/bet-flags.yml Inventory */}
      {summary ? (
        <div
          data-bun-yaml-workspace="true"
          style={{
            borderRadius: "8px",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "var(--border-default, #1e293b)",
            backgroundColor: "var(--surface-panel, #0f172a)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "12.5px",
                  fontWeight: 700,
                  color: "var(--text-primary, #f8fafc)",
                }}
              >
                Workspace YAML Config ({summary.filePath})
              </div>
              <div
                style={{
                  marginTop: "2px",
                  fontSize: "11px",
                  color: "var(--text-muted, #94a3b8)",
                }}
              >
                Parsed on server via <code style={{ fontFamily: MONO_FONT }}>Bun.YAML.parse</code> (
                {summary.engine === "bun-native" ? "native Rust engine" : "YAML 1.2 TS fallback"}) ·{" "}
                <span style={{ fontFamily: MONO_FONT, fontVariantNumeric: "tabular-nums" }}>
                  {summary.byteLength.toLocaleString()} bytes
                </span>
              </div>
            </div>

            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                fontWeight: 600,
                color: summary.parseError ? "#f87171" : "#4ade80",
                whiteSpace: "nowrap",
              }}
            >
              <ShieldCheck size={13} aria-hidden="true" />
              <span>
                {summary.parseError
                  ? "Parse Error"
                  : summary.detected
                    ? "Verified & Redacted"
                    : "File Absent"}
              </span>
            </span>
          </div>

          {summary.parseError ? (
            <div
              role="alert"
              style={{
                padding: "12px 14px",
                color: "#fca5a5",
                fontSize: "12px",
                fontFamily: MONO_FONT,
              }}
            >
              {summary.parseError}
            </div>
          ) : (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: "1px",
                  backgroundColor: "var(--border-default, #1e293b)",
                }}
              >
                {[
                  {
                    label: "Schema Version",
                    value: summary.schemaVersion !== null ? `v${summary.schemaVersion}` : "—",
                    sub: summary.filePath,
                  },
                  {
                    label: "Total Rules",
                    value: String(summary.totalRules),
                    sub: `${summary.enabledRules} enabled · ${summary.disabledRules} template`,
                  },
                  {
                    label: "Windowed Aggregates",
                    value: String(summary.aggregateRules),
                    sub: `${summary.totalRules - summary.aggregateRules} leaf/composite predicates`,
                  },
                  {
                    label: "Severity Breakdown",
                    value: `${summary.severityCounts.critical ?? 0} crit · ${summary.severityCounts.high ?? 0} high`,
                    sub: `${summary.severityCounts.medium ?? 0} med · ${summary.severityCounts.low ?? 0} low`,
                  },
                  {
                    label: "Parser Engine",
                    value: summary.engine === "bun-native" ? "Bun.YAML.parse" : "ts-fallback",
                    sub: "YAML 1.2 Core Schema",
                  },
                ].map((kpi) => (
                  <div
                    key={kpi.label}
                    style={{
                      padding: "10px 12px",
                      backgroundColor: "var(--surface-panel, #0f172a)",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "11px",
                        color: "var(--text-muted, #94a3b8)",
                      }}
                    >
                      {kpi.label}
                    </div>
                    <div
                      style={{
                        marginTop: "3px",
                        fontFamily: MONO_FONT,
                        fontSize: "12.5px",
                        fontWeight: 700,
                        color: "var(--text-primary, #f8fafc)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {kpi.value}
                    </div>
                    <div
                      style={{
                        marginTop: "2px",
                        fontFamily: MONO_FONT,
                        fontSize: "10.5px",
                        color: "#64748b",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {kpi.sub}
                    </div>
                  </div>
                ))}
              </div>

              {/* Filter toolbar */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                  padding: "9px 14px",
                  borderTopWidth: "1px",
                  borderTopStyle: "solid",
                  borderTopColor: "var(--border-default, #1e293b)",
                }}
              >
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "3px",
                    padding: "2px",
                    borderRadius: "6px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-default, #1e293b)",
                    backgroundColor: "var(--surface-overlay, #0a101d)",
                  }}
                >
                  {(
                    [
                      { id: "all", label: `All (${summary.totalRules})` },
                      { id: "enabled", label: `Enabled (${summary.enabledRules})` },
                      {
                        id: "disabled",
                        label: `Templates (${summary.disabledRules})`,
                      },
                    ] as const
                  ).map((opt) => {
                    const active = ruleStatusFilter === opt.id
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setRuleStatusFilter(opt.id)}
                        style={{
                          padding: "4px 9px",
                          borderRadius: "4px",
                          border: "none",
                          backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                          color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                          fontSize: "11px",
                          fontWeight: active ? 600 : 500,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>

                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    flex: "1 1 200px",
                    maxWidth: "300px",
                  }}
                >
                  <Search
                    size={13}
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: "9px",
                      color: "#64748b",
                      pointerEvents: "none",
                    }}
                  />
                  <input
                    type="search"
                    aria-label="Filter YAML bet-flag rules"
                    value={ruleSearch}
                    onChange={(e) => setRuleSearch(e.target.value)}
                    placeholder="Filter rules by id, severity, tag..."
                    style={{
                      width: "100%",
                      padding: "5px 10px 5px 28px",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                      color: "var(--text-primary, #f1f5f9)",
                      fontSize: "11.5px",
                    }}
                  />
                </div>
              </div>

              {/* Rules table */}
              <div
                style={{
                  borderTopWidth: "1px",
                  borderTopStyle: "solid",
                  borderTopColor: "var(--border-default, #1e293b)",
                  overflowX: "auto",
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns:
                      "minmax(175px, 1.3fr) minmax(200px, 1.7fr) 86px 86px minmax(120px, 1fr)",
                    gap: "10px",
                    padding: "7px 14px",
                    fontSize: "10.5px",
                    fontWeight: 600,
                    color: "var(--text-muted, #94a3b8)",
                    backgroundColor: "rgba(15, 23, 42, 0.55)",
                  }}
                >
                  <span>Rule ID</span>
                  <span>Title &amp; Scope</span>
                  <span>Severity</span>
                  <span>Status</span>
                  <span>Tags</span>
                </div>

                {filteredRules.length === 0 ? (
                  <div
                    style={{
                      padding: "16px 14px",
                      fontSize: "12px",
                      color: "var(--text-muted, #94a3b8)",
                    }}
                  >
                    No YAML rules match the current filter.
                  </div>
                ) : (
                  filteredRules.map((rule) => (
                    <div
                      key={rule.id}
                      data-yaml-rule-id={rule.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "minmax(175px, 1.3fr) minmax(200px, 1.7fr) 86px 86px minmax(120px, 1fr)",
                        gap: "10px",
                        padding: "8px 14px",
                        borderTopWidth: "1px",
                        borderTopStyle: "solid",
                        borderTopColor: "rgba(30, 41, 59, 0.65)",
                        fontSize: "11.5px",
                        alignItems: "center",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontWeight: 600,
                          color: "var(--text-primary, #f1f5f9)",
                          wordBreak: "break-word",
                        }}
                      >
                        {rule.id}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: "var(--text-primary, #e2e8f0)" }}>{rule.title}</div>
                        {rule.hasAggregate ? (
                          <div
                            style={{
                              marginTop: "2px",
                              fontFamily: MONO_FONT,
                              fontSize: "10.5px",
                              color: "#64748b",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            aggregate · groupBy={rule.aggregateGroupBy ?? "—"} ·{" "}
                            {rule.aggregateWindowSeconds ?? 0}s
                          </div>
                        ) : null}
                      </div>
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontWeight: 600,
                          color: severityColor(rule.severity),
                          textTransform: "capitalize",
                        }}
                      >
                        {rule.severity}
                      </span>
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontWeight: 600,
                          color: rule.enabled ? "#4ade80" : "#64748b",
                        }}
                      >
                        {rule.enabled ? "Enabled" : "Template"}
                      </span>
                      <span
                        style={{
                          fontFamily: MONO_FONT,
                          fontSize: "11px",
                          color: "#94a3b8",
                        }}
                      >
                        {rule.tags.length > 0 ? rule.tags.join(" · ") : "—"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      {/* 2. Interactive Bun.YAML.parse & Bun.YAML.stringify Playground */}
      <div
        data-bun-yaml-playground="true"
        style={{
          borderRadius: "8px",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--border-default, #1e293b)",
          backgroundColor: "var(--surface-panel, #0f172a)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "var(--border-default, #1e293b)",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "12.5px",
                fontWeight: 700,
                color: "var(--text-primary, #f8fafc)",
              }}
            >
              Interactive Bun.YAML.parse &amp; Bun.YAML.stringify Inspector
            </div>
            <div
              style={{
                marginTop: "2px",
                fontSize: "11px",
                color: "var(--text-muted, #94a3b8)",
              }}
            >
              Supports YAML 1.2 scalars, multi-document streams (
              <code style={{ fontFamily: MONO_FONT }}>---</code>), anchors/aliases (
              <code style={{ fontFamily: MONO_FONT }}>&amp;/*</code>), merge keys (
              <code style={{ fontFamily: MONO_FONT }}>&lt;&lt;</code>), and block scalars.
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                padding: "2px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
              }}
            >
              {(["block", "flow"] as const).map((mode) => {
                const active = stringifyMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setStringifyMode(mode)}
                    style={{
                      padding: "4px 9px",
                      borderRadius: "4px",
                      border: "none",
                      backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                      color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                      fontSize: "11px",
                      fontWeight: active ? 600 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {mode === "block" ? "Block (space: 2)" : "Flow (compact)"}
                  </button>
                )
              })}
            </div>

            <button
              type="button"
              disabled={!playgroundEvaluation.ok}
              onClick={() => void handleCopyYaml()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "6px 11px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: copiedOutput ? "#4ade80" : "var(--border-strong, #334155)",
                backgroundColor: "transparent",
                color: copiedOutput ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                fontSize: "11.5px",
                fontWeight: 600,
                cursor: playgroundEvaluation.ok ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              {copiedOutput ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <Copy size={12} aria-hidden="true" />
              )}
              <span>{copiedOutput ? "Copied" : "Copy YAML"}</span>
            </button>

            <button
              type="button"
              disabled={!playgroundEvaluation.ok}
              onClick={handleDownloadYaml}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "6px 11px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#38bdf8",
                backgroundColor: "rgba(56, 189, 248, 0.12)",
                color: "#38bdf8",
                fontSize: "11.5px",
                fontWeight: 600,
                cursor: playgroundEvaluation.ok ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              <Download size={12} aria-hidden="true" />
              <span>Download .yaml</span>
            </button>
          </div>
        </div>

        {/* Preset Switcher Row */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "6px",
            padding: "8px 14px",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "var(--border-default, #1e293b)",
          }}
        >
          <span
            style={{
              fontSize: "11px",
              color: "var(--text-muted, #94a3b8)",
              marginRight: "4px",
            }}
          >
            Samples:
          </span>
          {YAML_PLAYGROUND_PRESETS.map((preset) => {
            const active = activePresetId === preset.id
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => handleSelectPreset(preset)}
                style={{
                  padding: "4px 10px",
                  borderRadius: "5px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: active ? "#38bdf8" : "var(--border-strong, #334155)",
                  backgroundColor: active ? "rgba(56, 189, 248, 0.12)" : "transparent",
                  color: active ? "#38bdf8" : "var(--text-primary, #e2e8f0)",
                  fontSize: "11px",
                  fontWeight: active ? 600 : 500,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {preset.label}
              </button>
            )
          })}
        </div>

        {/* 2-column Input / Output Split */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "1px",
            backgroundColor: "var(--border-default, #1e293b)",
          }}
        >
          {/* Left: YAML Input */}
          <div
            style={{
              padding: "12px 14px",
              backgroundColor: "var(--surface-panel, #0f172a)",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <label
              htmlFor="sd-bun-yaml-input"
              style={{
                fontSize: "11.5px",
                fontWeight: 600,
                fontFamily: MONO_FONT,
                color: "var(--text-muted, #94a3b8)",
              }}
            >
              YAML 1.2 Input
            </label>
            <textarea
              id="sd-bun-yaml-input"
              data-bun-yaml-editor="true"
              value={yamlText}
              onChange={(e) => setYamlText(e.target.value)}
              rows={15}
              spellCheck={false}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-strong, #334155)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
                color: "var(--text-primary, #f1f5f9)",
                fontFamily: MONO_FONT,
                fontSize: "11.5px",
                lineHeight: 1.55,
                resize: "vertical",
              }}
            />
          </div>

          {/* Right: Parsed JSON + Round-Trip YAML.stringify */}
          <div
            style={{
              padding: "12px 14px",
              backgroundColor: "var(--surface-panel, #0f172a)",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                fontSize: "11.5px",
                fontWeight: 600,
                fontFamily: MONO_FONT,
                color: "var(--text-muted, #94a3b8)",
              }}
            >
              <span>Bun.YAML.parse() Result (JSON)</span>
              {playgroundEvaluation.ok ? (
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <SyntaxTokenLegend compact />
                  <span
                    style={{
                      fontSize: "10.5px",
                      color: "#4ade80",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {playgroundEvaluation.parsed.documentCount} doc
                    {playgroundEvaluation.parsed.documentCount === 1 ? "" : "s"}
                    {playgroundEvaluation.parsed.isMultiDocument ? " (array)" : ""}
                    {playgroundEvaluation.parsed.hasCircularRefs ? " · circular safe" : ""}
                  </span>
                </div>
              ) : null}
            </div>

            {playgroundEvaluation.ok ? (
              <>
                <SyntaxHighlightedPre
                  data-bun-yaml-json-preview="true"
                  text={playgroundEvaluation.jsonPreview}
                  format="json"
                  style={{
                    margin: 0,
                    padding: "10px",
                    borderRadius: "6px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-strong, #334155)",
                    backgroundColor: "var(--surface-overlay, #0a101d)",
                    color: "var(--text-primary, #e2e8f0)",
                    fontFamily: MONO_FONT,
                    fontSize: "11.5px",
                    lineHeight: 1.5,
                    overflowX: "auto",
                    maxHeight: "200px",
                  }}
                />

                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    fontSize: "11px",
                    fontWeight: 600,
                    fontFamily: MONO_FONT,
                    color: "var(--text-muted, #94a3b8)",
                  }}
                >
                  <span>Bun.YAML.stringify() ({stringifyMode})</span>
                  <CopyBunTerminalAnsiButton
                    text={playgroundEvaluation.roundTripYaml}
                    format="yaml"
                    compact
                  />
                </div>

                <SyntaxHighlightedPre
                  data-bun-yaml-stringify-preview="true"
                  text={playgroundEvaluation.roundTripYaml}
                  format="yaml"
                  style={{
                    margin: 0,
                    padding: "10px",
                    borderRadius: "6px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-strong, #334155)",
                    backgroundColor: "var(--surface-overlay, #0a101d)",
                    color: "#cbd5e1",
                    fontFamily: MONO_FONT,
                    fontSize: "11.5px",
                    lineHeight: 1.5,
                    overflowX: "auto",
                    maxHeight: "150px",
                  }}
                />
              </>
            ) : (
              <div
                role="alert"
                data-bun-yaml-parse-error="true"
                style={{
                  padding: "10px 12px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "rgba(239, 68, 68, 0.45)",
                  backgroundColor: "rgba(239, 68, 68, 0.08)",
                  color: "#fca5a5",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                }}
              >
                <AlertCircle size={14} aria-hidden="true" />
                <span>{playgroundEvaluation.error}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
