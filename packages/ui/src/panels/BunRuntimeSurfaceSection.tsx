import {
  Box,
  Check,
  Code2,
  Copy,
  Cpu,
  Download,
  FileText,
  FlaskConical,
  Globe,
  Layers,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
} from "lucide-react"
import type React from "react"
import { useMemo, useState } from "react"

import {
  BUN_ANSI_THEME_PRESETS,
  BUN_CORE_API_DOMAINS,
  BUN_GLOBAL_TIERS,
  BUN_MARKDOWN_CALLBACK_SPECS,
  BUN_UTILITIES_CATALOG,
  BUN_UTILITY_CATEGORIES,
  bunDeepEquals,
  type BunDeepInspectionCategory,
  type BunExportKind,
  type BunMarkdownRenderMode,
  type BunMarkdownRenderPresetId,
  type BunRuntimeSurfaceAuditSnapshot,
  type BunUtilityCategoryId,
  decodeUuidV7TimestampIso,
  DEEP_SURFACE_AUDIT_SNIPPET,
  DEFAULT_BUN_MARKDOWN_STUDIO_SAMPLE,
  evaluateBunColorConversions,
  evaluateBunStringUtilities,
  generateBunUuidV7,
  type GlobalTierId,
  LIVE_SURFACE_AUDIT_SNIPPET,
  type LiveCapabilityItemProbe,
  probeBunCapabilityMatrix,
  renderBunMarkdownStudio,
  runBunSurfaceAudit,
} from "@sportsdesk-ops/contracts"

import { renderAnsiReact } from "../ansi.tsx"
import { CopyBunTerminalAnsiButton } from "./SyntaxHighlightedPre.tsx"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

export type RuntimeSurfaceSubTab =
  "globals" | "utilities" | "core-apis" | "modules-classes" | "live-audit" | "sandbox"

export interface BunRuntimeSurfaceSectionProps {
  readonly audit?: BunRuntimeSurfaceAuditSnapshot | null | undefined
  readonly initialSubTab?: RuntimeSurfaceSubTab | undefined
  readonly onRefresh?: (() => void) | undefined
}

function sourceLabel(source: BunRuntimeSurfaceAuditSnapshot["source"]): string {
  switch (source) {
    case "bun-in-process":
      return "In-process Bun runtime"
    case "bun-binary-probe":
      return "Installed Bun binary probe"
    case "node-fallback":
      return "Node.js host fallback"
    case "browser-fallback":
      return "Browser runtime probe"
  }
}

function kindColor(kind: BunExportKind): string {
  switch (kind) {
    case "class":
      return "#f59e0b"
    case "namespace":
      return "#c084fc"
    case "function":
      return "#38bdf8"
    case "constant":
      return "#4ade80"
    case "object":
      return "#94a3b8"
  }
}

function categoryLabel(category: BunDeepInspectionCategory): string {
  switch (category) {
    case "builtin-module":
      return "bun:* Module"
    case "bun-namespace":
      return "Bun.* Namespace"
    case "bun-class":
      return "Bun.* Class"
  }
}

function escapeAnsiForDisplay(raw: string): string {
  return raw.replace(/\u001b/g, "\\x1b")
}

export function BunRuntimeSurfaceSection({
  audit = null,
  initialSubTab = "globals",
  onRefresh,
}: BunRuntimeSurfaceSectionProps): React.ReactElement {
  const effectiveAudit = useMemo<BunRuntimeSurfaceAuditSnapshot>(
    () => audit ?? runBunSurfaceAudit(),
    [audit],
  )

  const [subTab, setSubTab] = useState<RuntimeSurfaceSubTab>(initialSubTab)

  // Globals filter state
  const [globalTierFilter, setGlobalTierFilter] = useState<"all" | GlobalTierId>("all")
  const [globalSearch, setGlobalSearch] = useState<string>("")

  // Utilities filter state
  const [utilityCategoryFilter, setUtilityCategoryFilter] = useState<"all" | BunUtilityCategoryId>(
    "all",
  )
  const [utilitySearch, setUtilitySearch] = useState<string>("")

  // Core APIs filter state
  const [coreApiSearch, setCoreApiSearch] = useState<string>("")

  // Deep Modules, Namespaces & Classes filter state
  const [deepCategoryFilter, setDeepCategoryFilter] = useState<"all" | BunDeepInspectionCategory>(
    "all",
  )
  const [deepKindFilter, setDeepKindFilter] = useState<"all" | BunExportKind>("all")
  const [deepSearch, setDeepSearch] = useState<string>("")
  const [expandedDeepIds, setExpandedDeepIds] = useState<Readonly<Record<string, boolean>>>({})

  // Live Surface Audit state
  const [auditSearch, setAuditSearch] = useState<string>("")
  const [auditKindFilter, setAuditKindFilter] = useState<"all" | BunExportKind>("all")
  const [auditTypeFilter, setAuditTypeFilter] = useState<string>("all")
  const [auditDisplayMode, setAuditDisplayMode] = useState<"table" | "inspect">("table")
  const [auditSnippetMode, setAuditSnippetMode] = useState<"basic" | "deep">("basic")
  const [copiedSnippet, setCopiedSnippet] = useState<boolean>(false)
  const [copiedTable, setCopiedTable] = useState<boolean>(false)

  // Bun.markdown.render & AnsiTheme Studio state
  const [mdSource, setMdSource] = useState<string>(DEFAULT_BUN_MARKDOWN_STUDIO_SAMPLE)
  const [mdMode, setMdMode] = useState<BunMarkdownRenderMode>("render-callbacks")
  const [mdPresetId, setMdPresetId] = useState<BunMarkdownRenderPresetId>("obsidian-desk")
  const [mdColors, setMdColors] = useState<boolean>(true)
  const [mdLight, setMdLight] = useState<boolean>(false)
  const [mdHyperlinks, setMdHyperlinks] = useState<boolean>(true)
  const [mdColumns, setMdColumns] = useState<number>(76)
  const [mdOutputView, setMdOutputView] = useState<"terminal" | "raw-ansi" | "html">("terminal")

  // Utility Sandbox state
  const [sandboxStringInput, setSandboxStringInput] = useState<string>(
    '\u001b[36mSportsDesk\u001b[0m · <script>alert("x")</script> · 東京 🚀',
  )
  const [sandboxColorInput, setSandboxColorInput] = useState<string>("#38bdf8")
  const [uuidHistory, setUuidHistory] = useState<readonly string[]>(() => [generateBunUuidV7()])
  const [deepEqLeft, setDeepEqLeft] = useState<string>(
    '{\n  "desk": "main",\n  "tiers": [1, 2, 3],\n  "optionalFlag": null\n}',
  )
  const [deepEqRight, setDeepEqRight] = useState<string>(
    '{\n  "tiers": [1, 2, 3],\n  "desk": "main",\n  "optionalFlag": null\n}',
  )
  const [deepEqStrict, setDeepEqStrict] = useState<boolean>(false)

  // Lookup maps from live probes
  const globalProbeMap = useMemo(() => {
    const map = new Map<string, { readonly present: boolean; readonly valueType: string }>()
    for (const probe of effectiveAudit.globalProbes) {
      map.set(`${probe.tier}:${probe.name}`, {
        present: probe.present,
        valueType: probe.valueType,
      })
    }
    return map
  }, [effectiveAudit.globalProbes])

  const utilityProbeMap = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const probe of effectiveAudit.utilityProbes) {
      map.set(probe.id, probe.available)
    }
    return map
  }, [effectiveAudit.utilityProbes])

  const coreDomainProbeMap = useMemo(() => {
    const map = new Map<
      string,
      {
        readonly availableCount: number
        readonly totalProbed: number
        readonly availableKeys: readonly string[]
      }
    >()
    for (const probe of effectiveAudit.coreDomainProbes) {
      map.set(probe.id, {
        availableCount: probe.availableCount,
        totalProbed: probe.totalProbed,
        availableKeys: probe.availableKeys,
      })
    }
    return map
  }, [effectiveAudit.coreDomainProbes])

  // Summary counts
  const presentGlobalsCount = useMemo(
    () => effectiveAudit.globalProbes.filter((g) => g.present).length,
    [effectiveAudit.globalProbes],
  )
  const availableUtilitiesCount = useMemo(
    () => effectiveAudit.utilityProbes.filter((u) => u.available).length,
    [effectiveAudit.utilityProbes],
  )
  const availableCoreApisCount = useMemo(
    () => effectiveAudit.coreDomainProbes.reduce((acc, d) => acc + d.availableCount, 0),
    [effectiveAudit.coreDomainProbes],
  )
  const totalCoreApisProbed = useMemo(
    () => effectiveAudit.coreDomainProbes.reduce((acc, d) => acc + d.totalProbed, 0),
    [effectiveAudit.coreDomainProbes],
  )

  // Filtered Views
  const filteredGlobalTiers = useMemo(() => {
    const q = globalSearch.trim().toLowerCase()
    return BUN_GLOBAL_TIERS.filter((tier) => {
      if (globalTierFilter !== "all" && tier.id !== globalTierFilter) return false
      if (!q) return true
      return (
        tier.label.toLowerCase().includes(q) ||
        tier.notes.toLowerCase().includes(q) ||
        tier.globals.some((g) => g.toLowerCase().includes(q))
      )
    }).map((tier) => {
      if (!q) return tier
      const matchingGlobals = tier.globals.filter((g) => g.toLowerCase().includes(q))
      return {
        ...tier,
        globals: matchingGlobals.length > 0 ? matchingGlobals : tier.globals,
      }
    })
  }, [globalTierFilter, globalSearch])

  const filteredUtilities = useMemo(() => {
    const q = utilitySearch.trim().toLowerCase()
    return BUN_UTILITIES_CATALOG.filter((item) => {
      if (utilityCategoryFilter !== "all" && item.category !== utilityCategoryFilter) {
        return false
      }
      if (!q) return true
      const hay =
        `${item.signature} ${item.purpose} ${item.runtimeNotes ?? ""} ${item.categoryLabel}`.toLowerCase()
      return hay.includes(q)
    })
  }, [utilityCategoryFilter, utilitySearch])

  const capabilityMatrix = useMemo(() => probeBunCapabilityMatrix(effectiveAudit), [effectiveAudit])

  const capabilityMatrixTotals = useMemo(() => {
    let available = 0
    let total = 0
    for (const pillar of capabilityMatrix) {
      available += pillar.availableCount
      total += pillar.totalCount
    }
    return { available, total }
  }, [capabilityMatrix])

  const filteredCapabilityPillars = useMemo(() => {
    const q = coreApiSearch.trim().toLowerCase()
    if (!q) {
      return capabilityMatrix
    }
    return capabilityMatrix
      .map((pillar) => {
        const pillarMatches = pillar.title.toLowerCase().includes(q)
        const matchingItems = pillarMatches
          ? pillar.items
          : pillar.items.filter((item) => {
              const hay =
                `${item.api} ${item.summary} ${item.matchedSymbols.join(" ")}`.toLowerCase()
              return hay.includes(q)
            })
        if (matchingItems.length === 0) {
          return null
        }
        return {
          ...pillar,
          items: matchingItems,
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
  }, [capabilityMatrix, coreApiSearch])

  const filteredCoreDomains = useMemo(() => {
    const q = coreApiSearch.trim().toLowerCase()
    if (!q) {
      return BUN_CORE_API_DOMAINS
    }
    return BUN_CORE_API_DOMAINS.filter((d) => {
      const hay = `${d.domain} ${d.apis.join(" ")} ${d.capabilities}`.toLowerCase()
      return hay.includes(q)
    })
  }, [coreApiSearch])

  const exportTypes = useMemo(
    () => Object.keys(effectiveAudit.exportTypeCounts).sort(),
    [effectiveAudit.exportTypeCounts],
  )

  const filteredExports = useMemo(() => {
    const q = auditSearch.trim().toLowerCase()
    return effectiveAudit.exports.filter((entry) => {
      if (auditKindFilter !== "all" && entry.kind !== auditKindFilter) return false
      if (auditTypeFilter !== "all" && entry.type !== auditTypeFilter) return false
      if (q) {
        const hay =
          `${entry.key} ${entry.kind} ${entry.type} ${entry.safePreview ?? ""}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [effectiveAudit.exports, auditSearch, auditKindFilter, auditTypeFilter])

  const deepSummary = useMemo(() => {
    const all = effectiveAudit.deepInspections ?? []
    let available = 0
    let totalMembers = 0
    let modules = 0
    let namespaces = 0
    let classes = 0
    for (const item of all) {
      if (item.available) available += 1
      totalMembers += item.memberCount
      if (item.category === "builtin-module") modules += 1
      else if (item.category === "bun-namespace") namespaces += 1
      else if (item.category === "bun-class") classes += 1
    }
    return {
      total: all.length,
      available,
      totalMembers,
      modules,
      namespaces,
      classes,
    }
  }, [effectiveAudit.deepInspections])

  const filteredDeepInspections = useMemo(() => {
    const q = deepSearch.trim().toLowerCase()
    const list = effectiveAudit.deepInspections ?? []
    return list
      .filter((entry) => {
        if (deepCategoryFilter !== "all" && entry.category !== deepCategoryFilter) return false
        const matchingMembers = entry.members.filter((m) => {
          if (deepKindFilter !== "all" && m.kind !== deepKindFilter) return false
          if (!q) return true
          return (
            m.name.toLowerCase().includes(q) ||
            m.kind.toLowerCase().includes(q) ||
            m.scope.toLowerCase().includes(q) ||
            (m.safePreview?.toLowerCase().includes(q) ?? false)
          )
        })
        if (!q && deepKindFilter === "all") return true
        const headerMatch =
          q.length > 0 &&
          (entry.label.toLowerCase().includes(q) ||
            entry.domain.toLowerCase().includes(q) ||
            entry.notes.toLowerCase().includes(q))
        if (deepKindFilter !== "all") {
          return matchingMembers.length > 0
        }
        return headerMatch || matchingMembers.length > 0
      })
      .map((entry) => {
        const qMatchesHeader =
          q.length > 0 &&
          (entry.label.toLowerCase().includes(q) ||
            entry.domain.toLowerCase().includes(q) ||
            entry.notes.toLowerCase().includes(q))
        const filteredMembers = entry.members.filter((m) => {
          if (deepKindFilter !== "all" && m.kind !== deepKindFilter) return false
          if (!q || qMatchesHeader) return true
          return (
            m.name.toLowerCase().includes(q) ||
            m.kind.toLowerCase().includes(q) ||
            m.scope.toLowerCase().includes(q) ||
            (m.safePreview?.toLowerCase().includes(q) ?? false)
          )
        })
        return {
          ...entry,
          filteredMembers,
        }
      })
  }, [effectiveAudit.deepInspections, deepCategoryFilter, deepKindFilter, deepSearch])

  // Bun.markdown.render & AnsiTheme Studio live evaluation
  const mdStudioResult = useMemo(
    () =>
      renderBunMarkdownStudio(mdSource, {
        mode: mdMode,
        presetId: mdPresetId,
        theme: {
          colors: mdColors,
          light: mdLight,
          hyperlinks: mdHyperlinks,
          columns: mdColumns,
        },
      }),
    [mdSource, mdMode, mdPresetId, mdColors, mdLight, mdHyperlinks, mdColumns],
  )

  const handleSelectMdPreset = (presetId: BunMarkdownRenderPresetId) => {
    setMdPresetId(presetId)
    const preset = BUN_ANSI_THEME_PRESETS.find((p) => p.id === presetId)
    if (preset) {
      setMdLight(preset.defaultTheme.light)
      setMdColumns(preset.defaultTheme.columns)
      setMdColors(preset.defaultTheme.colors)
      setMdHyperlinks(preset.defaultTheme.hyperlinks)
    }
  }

  // Sandbox evaluations
  const stringProbe = useMemo(
    () => evaluateBunStringUtilities(sandboxStringInput),
    [sandboxStringInput],
  )
  const colorProbe = useMemo(
    () => evaluateBunColorConversions(sandboxColorInput),
    [sandboxColorInput],
  )
  const deepEqResult = useMemo(() => {
    try {
      const parsedA = JSON.parse(deepEqLeft) as unknown
      const parsedB = JSON.parse(deepEqRight) as unknown
      return {
        ok: true as const,
        equal: bunDeepEquals(parsedA, parsedB, deepEqStrict),
      }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid JSON input",
      }
    }
  }, [deepEqLeft, deepEqRight, deepEqStrict])

  const activeAuditSnippet =
    auditSnippetMode === "deep" ? DEEP_SURFACE_AUDIT_SNIPPET : LIVE_SURFACE_AUDIT_SNIPPET

  const handleCopySnippet = async () => {
    try {
      await navigator.clipboard.writeText(activeAuditSnippet)
      setCopiedSnippet(true)
      setTimeout(() => setCopiedSnippet(false), 1800)
    } catch {
      setCopiedSnippet(false)
    }
  }

  const handleCopyTable = async () => {
    try {
      await navigator.clipboard.writeText(effectiveAudit.inspectTableText)
      setCopiedTable(true)
      setTimeout(() => setCopiedTable(false), 1800)
    } catch {
      setCopiedTable(false)
    }
  }

  const handleDownloadAuditJson = () => {
    if (typeof document === "undefined") return
    const blob = new Blob([`${JSON.stringify(effectiveAudit, null, 2)}\n`], {
      type: "application/json;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `bun-runtime-surface-${effectiveAudit.bunVersion ?? "host"}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const handleMintUuidV7 = () => {
    const next = generateBunUuidV7()
    setUuidHistory((prev) => [next, ...prev.slice(0, 5)])
  }

  const handleInspectCapability = (item: LiveCapabilityItemProbe) => {
    if (!item.inspectSubTab) {
      return
    }
    const query = item.inspectQuery ?? ""
    if (item.inspectSubTab === "globals") {
      setGlobalTierFilter("all")
      setGlobalSearch(query)
    } else if (item.inspectSubTab === "modules-classes") {
      setDeepCategoryFilter("all")
      setDeepKindFilter("all")
      setDeepSearch(query)
    } else if (item.inspectSubTab === "live-audit") {
      setAuditKindFilter("all")
      setAuditTypeFilter("all")
      setAuditSearch(query)
    }
    setSubTab(item.inspectSubTab)
  }

  return (
    <div
      data-status-view="runtime-surface"
      data-bun-runtime-surface="true"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* 1. Live Runtime Surface Telemetry Header */}
      <div
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
            gap: "10px",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: "var(--text-primary, #f8fafc)",
              }}
            >
              Bun Runtime Surface &amp; Live Namespace Audit
            </div>
            <div
              style={{
                marginTop: "2px",
                fontSize: "11px",
                color: "var(--text-muted, #94a3b8)",
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {sourceLabel(effectiveAudit.source)} · host {effectiveAudit.hostRuntime} ·{" "}
              {effectiveAudit.auditDurationMs.toFixed(2)}ms · read-only introspection (secrets
              excluded)
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                fontWeight: 600,
                color: effectiveAudit.bunDetected ? "#4ade80" : "#fbbf24",
                whiteSpace: "nowrap",
              }}
            >
              <ShieldCheck size={13} aria-hidden="true" />
              <span>
                {effectiveAudit.bunDetected
                  ? `Bun ${effectiveAudit.bunVersion} verified`
                  : "Catalog + host probe"}
              </span>
            </span>

            {onRefresh ? (
              <button
                type="button"
                onClick={onRefresh}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "5px 10px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "transparent",
                  color: "var(--text-primary, #e2e8f0)",
                  fontSize: "11.5px",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <RefreshCw size={12} aria-hidden="true" />
                <span>Re-audit</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={handleDownloadAuditJson}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#38bdf8",
                backgroundColor: "rgba(56, 189, 248, 0.12)",
                color: "#38bdf8",
                fontSize: "11.5px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <Download size={12} aria-hidden="true" />
              <span>Export Audit JSON</span>
            </button>
          </div>
        </div>

        {/* 4-column KPI summary strip */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
            gap: "1px",
            backgroundColor: "var(--border-default, #1e293b)",
          }}
        >
          {[
            {
              label: "Bun Binary & Revision",
              value: effectiveAudit.bunVersion
                ? `v${effectiveAudit.bunVersion}`
                : effectiveAudit.hostRuntime,
              sub: effectiveAudit.bunRevisionShort
                ? `rev ${effectiveAudit.bunRevisionShort} · mainThread=${String(effectiveAudit.isMainThread)} · ansi=${String(effectiveAudit.enableAnsiColors ?? false)}`
                : "No Bun binary detected on PATH",
            },
            {
              label: "Bun.* Symbol Kinds",
              value: `${effectiveAudit.exportCount} exports`,
              sub:
                effectiveAudit.exportCount > 0
                  ? `${effectiveAudit.kindCounts.class} cls · ${effectiveAudit.kindCounts.namespace} ns · ${effectiveAudit.kindCounts.function} fn · ${effectiveAudit.kindCounts.constant} const`
                  : "Run under Bun to enumerate Bun.*",
            },
            {
              label: "Modules, Namespaces & Classes",
              value: `${deepSummary.available}/${deepSummary.total} inspected`,
              sub: `${deepSummary.totalMembers} symbols · ${deepSummary.modules} bun:* · ${deepSummary.namespaces} ns · ${deepSummary.classes} cls`,
            },
            {
              label: "Globals, Utils & Core APIs",
              value: `${presentGlobalsCount}/${effectiveAudit.globalProbes.length} globals · ${availableUtilitiesCount}/${BUN_UTILITIES_CATALOG.length} utils`,
              sub: `${availableCoreApisCount}/${totalCoreApisProbed} core APIs · ${effectiveAudit.processEnvEqualsBunEnv === true ? "process.env === Bun.env" : `${BUN_CORE_API_DOMAINS.length} domains`}`,
            },
          ].map((kpi) => (
            <div
              key={kpi.label}
              style={{
                padding: "10px 14px",
                backgroundColor: "var(--surface-panel, #0f172a)",
              }}
            >
              <div style={{ fontSize: "11px", color: "var(--text-muted, #94a3b8)" }}>
                {kpi.label}
              </div>
              <div
                style={{
                  marginTop: "3px",
                  fontFamily: MONO_FONT,
                  fontSize: "13px",
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
      </div>

      {/* 2. Section Sub-Navigation */}
      <div
        role="tablist"
        aria-label="Bun Runtime Surface Sections"
        style={{
          display: "inline-flex",
          flexWrap: "wrap",
          alignSelf: "flex-start",
          gap: "3px",
          padding: "3px",
          borderRadius: "7px",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--border-default, #1e293b)",
          backgroundColor: "var(--surface-panel, #0f172a)",
        }}
      >
        {(
          [
            { id: "globals", label: "01. Globals (3 Tiers)", icon: Globe },
            {
              id: "utilities",
              label: `02. Bun.* Utilities (${BUN_UTILITIES_CATALOG.length})`,
              icon: Wrench,
            },
            {
              id: "core-apis",
              label: `03. Core APIs (${BUN_CORE_API_DOMAINS.length})`,
              icon: Layers,
            },
            {
              id: "modules-classes",
              label: `04. Modules & Classes (${deepSummary.total})`,
              icon: Box,
            },
            {
              id: "live-audit",
              label: `05. Live Surface Audit (${effectiveAudit.exportCount})`,
              icon: Cpu,
            },
            { id: "sandbox", label: "06. Markdown & Sandbox", icon: FlaskConical },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon
          const active = subTab === tab.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-runtime-subtab={tab.id}
              aria-selected={active}
              onClick={() => setSubTab(tab.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 11px",
                borderRadius: "5px",
                border: "none",
                backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                fontSize: "11.5px",
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <Icon size={13} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>

      {/* VIEW 1: GLOBALS (3 TIERS) */}
      {subTab === "globals" ? (
        <div
          data-runtime-view="globals"
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
              gap: "8px",
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
            }}
          >
            <div
              role="group"
              aria-label="Filter globals by tier"
              style={{
                display: "inline-flex",
                flexWrap: "wrap",
                gap: "2px",
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
                  { id: "all", label: "All Tiers" },
                  { id: "bun-specific", label: "Bun-Specific" },
                  { id: "node-compat", label: "Node.js Compat" },
                  { id: "web-standards", label: "Web Standards" },
                ] as const
              ).map((opt) => {
                const active = globalTierFilter === opt.id
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setGlobalTierFilter(opt.id)}
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
                aria-label="Search runtime globals"
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
                placeholder="Filter globals (e.g. HTMLRewriter, fetch)…"
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

          {filteredGlobalTiers.length === 0 ? (
            <div style={{ padding: "18px 14px", fontSize: "12px", color: "#94a3b8" }}>
              No global tiers match &ldquo;{globalSearch}&rdquo;.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "12px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      fontSize: "11px",
                      color: "var(--text-muted, #94a3b8)",
                      borderBottomWidth: "1px",
                      borderBottomStyle: "solid",
                      borderBottomColor: "var(--border-default, #1e293b)",
                    }}
                  >
                    <th style={{ padding: "8px 14px", width: "160px", fontWeight: 600 }}>Tier</th>
                    <th style={{ padding: "8px 14px", fontWeight: 600 }}>
                      Key Globals (Live Runtime Probe)
                    </th>
                    <th style={{ padding: "8px 14px", width: "310px", fontWeight: 600 }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGlobalTiers.map((tier) => {
                    const liveCount = tier.globals.filter(
                      (g) => globalProbeMap.get(`${tier.id}:${g}`)?.present,
                    ).length
                    return (
                      <tr
                        key={tier.id}
                        data-global-tier={tier.id}
                        style={{
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.7)",
                        }}
                      >
                        <td style={{ padding: "11px 14px", verticalAlign: "top" }}>
                          <div
                            style={{
                              fontWeight: 700,
                              color: "var(--text-primary, #f8fafc)",
                              fontSize: "12px",
                            }}
                          >
                            {tier.label}
                          </div>
                          <div
                            style={{
                              marginTop: "3px",
                              fontFamily: MONO_FONT,
                              fontSize: "10.5px",
                              color: "#64748b",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {liveCount}/{tier.globals.length} live
                          </div>
                        </td>
                        <td style={{ padding: "11px 14px", verticalAlign: "top" }}>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "4px 12px",
                              fontFamily: MONO_FONT,
                              fontSize: "11.5px",
                              lineHeight: 1.65,
                            }}
                          >
                            {tier.globals.map((gName) => {
                              const probe = globalProbeMap.get(`${tier.id}:${gName}`)
                              const present = probe?.present ?? false
                              return (
                                <span
                                  key={gName}
                                  title={
                                    probe ? `${gName}: typeof === "${probe.valueType}"` : gName
                                  }
                                  style={{
                                    color: present ? "var(--text-primary, #e2e8f0)" : "#64748b",
                                  }}
                                >
                                  <span style={{ fontWeight: present ? 600 : 400 }}>{gName}</span>
                                  {probe && probe.present ? (
                                    <span style={{ color: "#4ade80", fontSize: "10px" }}>
                                      {" "}
                                      ({probe.valueType})
                                    </span>
                                  ) : (
                                    <span style={{ color: "#64748b", fontSize: "10px" }}>
                                      {" "}
                                      (absent)
                                    </span>
                                  )}
                                </span>
                              )
                            })}
                          </div>
                        </td>
                        <td
                          style={{
                            padding: "11px 14px",
                            verticalAlign: "top",
                            fontSize: "11.5px",
                            color: "var(--text-muted, #94a3b8)",
                            lineHeight: 1.5,
                          }}
                        >
                          {tier.notes}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* VIEW 2: BUN.* UTILITIES */}
      {subTab === "utilities" ? (
        <div
          data-runtime-view="utilities"
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
              gap: "8px",
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
            }}
          >
            <div
              role="group"
              aria-label="Filter Bun utilities by category"
              style={{
                display: "inline-flex",
                flexWrap: "wrap",
                gap: "2px",
                padding: "2px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
              }}
            >
              <button
                type="button"
                onClick={() => setUtilityCategoryFilter("all")}
                style={{
                  padding: "4px 9px",
                  borderRadius: "4px",
                  border: "none",
                  backgroundColor:
                    utilityCategoryFilter === "all" ? "rgba(56, 189, 248, 0.14)" : "transparent",
                  color: utilityCategoryFilter === "all" ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                  fontSize: "11px",
                  fontWeight: utilityCategoryFilter === "all" ? 600 : 500,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                All ({BUN_UTILITIES_CATALOG.length})
              </button>
              {BUN_UTILITY_CATEGORIES.map((cat) => {
                const active = utilityCategoryFilter === cat.id
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setUtilityCategoryFilter(cat.id)}
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
                    {cat.label}
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
                aria-label="Search Bun utilities"
                value={utilitySearch}
                onChange={(e) => setUtilitySearch(e.target.value)}
                placeholder="Filter Bun.* utilities (e.g. zstd, peek, uuid)…"
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

          {filteredUtilities.length === 0 ? (
            <div style={{ padding: "18px 14px", fontSize: "12px", color: "#94a3b8" }}>
              No utilities match the current filter.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "12px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      fontSize: "11px",
                      color: "var(--text-muted, #94a3b8)",
                      borderBottomWidth: "1px",
                      borderBottomStyle: "solid",
                      borderBottomColor: "var(--border-default, #1e293b)",
                    }}
                  >
                    <th style={{ padding: "8px 14px", width: "290px", fontWeight: 600 }}>
                      Utility Signature
                    </th>
                    <th style={{ padding: "8px 14px", fontWeight: 600 }}>
                      Purpose &amp; Hot-Path Notes
                    </th>
                    <th style={{ padding: "8px 14px", width: "175px", fontWeight: 600 }}>
                      Category
                    </th>
                    <th
                      style={{
                        padding: "8px 14px",
                        width: "96px",
                        textAlign: "right",
                        fontWeight: 600,
                      }}
                    >
                      Surface
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUtilities.map((util) => {
                    const available = utilityProbeMap.get(util.id) ?? false
                    return (
                      <tr
                        key={util.id}
                        data-bun-utility-id={util.id}
                        style={{
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.65)",
                        }}
                      >
                        <td
                          style={{
                            padding: "9px 14px",
                            fontFamily: MONO_FONT,
                            fontSize: "11.5px",
                            fontWeight: 600,
                            color: "#7dd3fc",
                            verticalAlign: "top",
                          }}
                        >
                          {util.signature}
                        </td>
                        <td style={{ padding: "9px 14px", verticalAlign: "top" }}>
                          <div style={{ color: "var(--text-primary, #e2e8f0)" }}>
                            {util.purpose}
                          </div>
                          {util.runtimeNotes ? (
                            <div
                              style={{
                                marginTop: "2px",
                                fontSize: "11px",
                                color: "#64748b",
                              }}
                            >
                              {util.runtimeNotes}
                            </div>
                          ) : null}
                        </td>
                        <td
                          style={{
                            padding: "9px 14px",
                            fontSize: "11px",
                            color: "var(--text-muted, #94a3b8)",
                            verticalAlign: "top",
                          }}
                        >
                          {util.categoryLabel}
                        </td>
                        <td
                          style={{
                            padding: "9px 14px",
                            textAlign: "right",
                            fontFamily: MONO_FONT,
                            fontSize: "11px",
                            fontWeight: 600,
                            color: available ? "#4ade80" : "#64748b",
                            verticalAlign: "top",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {available ? "Verified" : "Bun-only"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* VIEW 3: CORE BUN APIS */}
      {subTab === "core-apis" ? (
        <div
          data-runtime-view="core-apis"
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
              gap: "8px",
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
            }}
          >
            <div
              style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary, #f8fafc)" }}
            >
              Core Bun APIs (Bun.* &amp; bun:*) across {BUN_CORE_API_DOMAINS.length} Domains
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
                aria-label="Search core Bun APIs"
                value={coreApiSearch}
                onChange={(e) => setCoreApiSearch(e.target.value)}
                placeholder="Filter pillars, APIs or domains (e.g. cookies, s3, secrets)…"
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

          {/* 6-Pillar Bun Capability Matrix */}
          {filteredCapabilityPillars.length > 0 ? (
            <div
              data-bun-capability-matrix="true"
              style={{
                padding: "12px 14px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border-default, #1e293b)",
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
                }}
              >
                <div
                  style={{
                    fontSize: "11.5px",
                    fontWeight: 700,
                    color: "var(--text-primary, #f8fafc)",
                  }}
                >
                  Bun Capability Matrix — 6 Pillars · {capabilityMatrixTotals.total} Core Primitives
                </div>
                <div
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: "11px",
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                    color:
                      capabilityMatrixTotals.available === capabilityMatrixTotals.total
                        ? "#4ade80"
                        : capabilityMatrixTotals.available > 0
                          ? "#fbbf24"
                          : "#64748b",
                  }}
                >
                  {capabilityMatrixTotals.available}/{capabilityMatrixTotals.total} live primitives
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(255px, 1fr))",
                  gap: "10px",
                }}
              >
                {filteredCapabilityPillars.map((pillar) => {
                  const pillarAllLive = pillar.availableCount === pillar.totalCount
                  return (
                    <div
                      key={pillar.id}
                      data-capability-pillar={pillar.id}
                      style={{
                        borderRadius: "6px",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor: "var(--border-default, #1e293b)",
                        backgroundColor: "var(--surface-overlay, #0a101d)",
                        padding: "10px 11px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "8px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          paddingBottom: "6px",
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.85)",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "10.5px",
                            fontWeight: 700,
                            letterSpacing: "0.06em",
                            color: "#94a3b8",
                          }}
                        >
                          {pillar.title}
                        </span>
                        <span
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: "10.5px",
                            fontWeight: 600,
                            fontVariantNumeric: "tabular-nums",
                            color: pillarAllLive
                              ? "#4ade80"
                              : pillar.availableCount > 0
                                ? "#fbbf24"
                                : "#64748b",
                          }}
                        >
                          {pillar.availableCount}/{pillar.totalCount} live
                        </span>
                      </div>

                      <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
                        {pillar.items.map((item) => {
                          const canInspect = Boolean(item.inspectSubTab)
                          const symbolTooltip =
                            item.matchedSymbols.length > 0
                              ? `Live symbols: ${item.matchedSymbols.join(", ")}`
                              : "Bun-native primitive (available when running under Bun)"
                          return (
                            <button
                              key={item.id}
                              type="button"
                              data-capability-item={item.id}
                              data-capability-available={item.available ? "true" : "false"}
                              onClick={() => handleInspectCapability(item)}
                              disabled={!canInspect}
                              title={
                                canInspect ? `${symbolTooltip} — click to inspect` : symbolTooltip
                              }
                              style={{
                                width: "100%",
                                textAlign: "left",
                                padding: "6px 8px",
                                borderRadius: "5px",
                                borderWidth: "1px",
                                borderStyle: "solid",
                                borderColor: "rgba(30, 41, 59, 0.75)",
                                backgroundColor: "rgba(15, 23, 42, 0.72)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "8px",
                                cursor: canInspect ? "pointer" : "default",
                              }}
                            >
                              <div style={{ minWidth: 0 }}>
                                <div
                                  style={{
                                    fontFamily: MONO_FONT,
                                    fontSize: "11.5px",
                                    fontWeight: 700,
                                    color: item.available ? "#7dd3fc" : "#94a3b8",
                                  }}
                                >
                                  {item.api}
                                </div>
                                <div
                                  style={{
                                    marginTop: "1px",
                                    fontSize: "11px",
                                    color: "var(--text-muted, #94a3b8)",
                                    lineHeight: 1.35,
                                  }}
                                >
                                  {item.summary}
                                </div>
                              </div>
                              <span
                                style={{
                                  flexShrink: 0,
                                  fontFamily: MONO_FONT,
                                  fontSize: "10px",
                                  fontWeight: 600,
                                  fontVariantNumeric: "tabular-nums",
                                  color: item.available ? "#4ade80" : "#64748b",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {item.available ? (canInspect ? "live →" : "live") : "Bun-only"}
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}

          {filteredCapabilityPillars.length === 0 && filteredCoreDomains.length === 0 ? (
            <div style={{ padding: "18px 14px", fontSize: "12px", color: "#94a3b8" }}>
              No capability pillars or core API domains match &ldquo;{coreApiSearch}&rdquo;.
            </div>
          ) : filteredCoreDomains.length > 0 ? (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "12px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      fontSize: "11px",
                      color: "var(--text-muted, #94a3b8)",
                      borderBottomWidth: "1px",
                      borderBottomStyle: "solid",
                      borderBottomColor: "var(--border-default, #1e293b)",
                    }}
                  >
                    <th style={{ padding: "8px 14px", width: "175px", fontWeight: 600 }}>Domain</th>
                    <th style={{ padding: "8px 14px", width: "280px", fontWeight: 600 }}>APIs</th>
                    <th style={{ padding: "8px 14px", fontWeight: 600 }}>Key Capabilities</th>
                    <th
                      style={{
                        padding: "8px 14px",
                        width: "96px",
                        textAlign: "right",
                        fontWeight: 600,
                      }}
                    >
                      Live Probe
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCoreDomains.map((domain) => {
                    const probe = coreDomainProbeMap.get(domain.id)
                    const allLive =
                      probe !== undefined &&
                      probe.totalProbed > 0 &&
                      probe.availableCount === probe.totalProbed
                    return (
                      <tr
                        key={domain.id}
                        data-core-api-domain={domain.id}
                        style={{
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.65)",
                        }}
                      >
                        <td
                          style={{
                            padding: "10px 14px",
                            fontWeight: 700,
                            color: "var(--text-primary, #f8fafc)",
                            verticalAlign: "top",
                          }}
                        >
                          {domain.domain}
                          {domain.builtinModules.length > 0 ? (
                            <div
                              style={{
                                marginTop: "3px",
                                fontFamily: MONO_FONT,
                                fontSize: "10.5px",
                                fontWeight: 500,
                                color: "#c084fc",
                              }}
                            >
                              {domain.builtinModules.join(" · ")}
                            </div>
                          ) : null}
                        </td>
                        <td
                          style={{
                            padding: "10px 14px",
                            fontFamily: MONO_FONT,
                            fontSize: "11.5px",
                            color: "#7dd3fc",
                            lineHeight: 1.6,
                            verticalAlign: "top",
                          }}
                        >
                          {domain.apis.join(" · ")}
                        </td>
                        <td
                          style={{
                            padding: "10px 14px",
                            color: "var(--text-muted, #cbd5e1)",
                            lineHeight: 1.5,
                            verticalAlign: "top",
                          }}
                        >
                          {domain.capabilities}
                        </td>
                        <td
                          style={{
                            padding: "10px 14px",
                            textAlign: "right",
                            fontFamily: MONO_FONT,
                            fontVariantNumeric: "tabular-nums",
                            fontSize: "11.5px",
                            fontWeight: 600,
                            color: allLive
                              ? "#4ade80"
                              : (probe?.availableCount ?? 0) > 0
                                ? "#fbbf24"
                                : "#64748b",
                            verticalAlign: "top",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {probe ? `${probe.availableCount}/${probe.totalProbed}` : "—"}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* VIEW 4: MODULES, NAMESPACES & CLASSES DEEP INTROSPECTION */}
      {subTab === "modules-classes" ? (
        <div
          data-runtime-view="modules-classes"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <div
            style={{
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              padding: "10px 14px",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <div
                role="group"
                aria-label="Filter deep targets by category"
                style={{
                  display: "inline-flex",
                  flexWrap: "wrap",
                  gap: "2px",
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
                    { id: "all", label: `All (${deepSummary.total})` },
                    { id: "builtin-module", label: `bun:* Modules (${deepSummary.modules})` },
                    { id: "bun-namespace", label: `Bun.* Namespaces (${deepSummary.namespaces})` },
                    { id: "bun-class", label: `Bun.* Classes (${deepSummary.classes})` },
                  ] as const
                ).map((cat) => {
                  const active = deepCategoryFilter === cat.id
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setDeepCategoryFilter(cat.id)}
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
                      {cat.label}
                    </button>
                  )
                })}
              </div>

              <div
                role="group"
                aria-label="Filter deep members by symbol kind"
                style={{
                  display: "inline-flex",
                  flexWrap: "wrap",
                  gap: "4px",
                }}
              >
                {(["all", "class", "namespace", "function", "constant"] as const).map((k) => {
                  const active = deepKindFilter === k
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setDeepKindFilter(k)}
                      style={{
                        padding: "4px 8px",
                        borderRadius: "4px",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor: active
                          ? k === "all"
                            ? "#38bdf8"
                            : kindColor(k)
                          : "var(--border-strong, #334155)",
                        backgroundColor: active ? "rgba(56, 189, 248, 0.1)" : "transparent",
                        color: active ? (k === "all" ? "#38bdf8" : kindColor(k)) : "#94a3b8",
                        fontSize: "11px",
                        fontFamily: MONO_FONT,
                        cursor: "pointer",
                      }}
                    >
                      {k}
                    </button>
                  )
                })}
              </div>
            </div>

            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                width: "240px",
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
                aria-label="Filter modules, classes, constants, and methods"
                value={deepSearch}
                onChange={(e) => setDeepSearch(e.target.value)}
                placeholder="Search SQLITE_*, FFIType, render…"
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
                  fontFamily: MONO_FONT,
                }}
              />
            </div>
          </div>

          {filteredDeepInspections.length === 0 ? (
            <div
              style={{
                borderRadius: "8px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-panel, #0f172a)",
                padding: "20px 14px",
                fontSize: "12px",
                color: "#94a3b8",
              }}
            >
              No inspected Bun modules, namespaces, or classes match the active filter.
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
                gap: "12px",
              }}
            >
              {filteredDeepInspections.map((entry) => {
                const isExpanded = Boolean(expandedDeepIds[entry.id])
                const visibleMembers = isExpanded
                  ? entry.filteredMembers
                  : entry.filteredMembers.slice(0, 14)
                const hiddenCount = Math.max(
                  0,
                  entry.filteredMembers.length - visibleMembers.length,
                )

                return (
                  <div
                    key={entry.id}
                    data-deep-target-id={entry.id}
                    style={{
                      borderRadius: "8px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-default, #1e293b)",
                      backgroundColor: "var(--surface-panel, #0f172a)",
                      overflow: "hidden",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <div
                      style={{
                        padding: "10px 14px",
                        borderBottomWidth: "1px",
                        borderBottomStyle: "solid",
                        borderBottomColor: "var(--border-default, #1e293b)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                        }}
                      >
                        <div
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: "12.5px",
                            fontWeight: 700,
                            color: "var(--text-primary, #f8fafc)",
                          }}
                        >
                          {entry.label}
                        </div>
                        <div
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: "10.5px",
                            color: entry.available ? "#4ade80" : "#fbbf24",
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {entry.available ? `${entry.memberCount} members` : "Unavailable on host"}
                        </div>
                      </div>
                      <div
                        style={{
                          fontFamily: MONO_FONT,
                          fontSize: "10.5px",
                          color: "#94a3b8",
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {categoryLabel(entry.category)} · {entry.domain} · {entry.classCount} cls ·{" "}
                        {entry.functionCount} fn · {entry.constantCount} const
                      </div>
                      <div style={{ fontSize: "11px", color: "#64748b", lineHeight: 1.45 }}>
                        {entry.notes}
                      </div>
                      {entry.id === "Bun.markdown" ? (
                        <div style={{ marginTop: "4px" }}>
                          <button
                            type="button"
                            onClick={() => setSubTab("sandbox")}
                            style={{
                              padding: "3px 8px",
                              borderRadius: "5px",
                              borderWidth: "1px",
                              borderStyle: "solid",
                              borderColor: "#38bdf8",
                              backgroundColor: "rgba(56, 189, 248, 0.1)",
                              color: "#38bdf8",
                              fontSize: "11px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            Launch Bun.markdown.render &amp; AnsiTheme Studio →
                          </button>
                        </div>
                      ) : null}
                    </div>

                    {entry.filteredMembers.length > 0 ? (
                      <div style={{ flex: 1 }}>
                        <table
                          style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontFamily: MONO_FONT,
                            fontSize: "11px",
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          <thead>
                            <tr
                              style={{
                                textAlign: "left",
                                fontSize: "10px",
                                color: "#64748b",
                                borderBottomWidth: "1px",
                                borderBottomStyle: "solid",
                                borderBottomColor: "var(--border-default, #1e293b)",
                              }}
                            >
                              <th style={{ padding: "5px 12px" }}>Symbol</th>
                              <th style={{ padding: "5px 8px", width: "74px" }}>Scope</th>
                              <th style={{ padding: "5px 8px", width: "78px" }}>Kind</th>
                              <th style={{ padding: "5px 12px", textAlign: "right" }}>
                                Type / Value
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleMembers.map((member) => (
                              <tr
                                key={`${member.scope}:${member.name}`}
                                style={{
                                  borderBottomWidth: "1px",
                                  borderBottomStyle: "solid",
                                  borderBottomColor: "rgba(30, 41, 59, 0.45)",
                                }}
                              >
                                <td
                                  style={{
                                    padding: "4px 12px",
                                    color: "var(--text-primary, #e2e8f0)",
                                    fontWeight: 500,
                                    wordBreak: "break-word",
                                  }}
                                >
                                  {member.name}
                                </td>
                                <td style={{ padding: "4px 8px", color: "#64748b" }}>
                                  {member.scope}
                                </td>
                                <td
                                  style={{
                                    padding: "4px 8px",
                                    color: kindColor(member.kind),
                                    fontWeight: 600,
                                  }}
                                >
                                  {member.kind}
                                </td>
                                <td
                                  style={{
                                    padding: "4px 12px",
                                    textAlign: "right",
                                    color: member.safePreview !== undefined ? "#86efac" : "#94a3b8",
                                  }}
                                >
                                  {member.safePreview !== undefined
                                    ? `${member.type} = ${member.safePreview}`
                                    : member.type}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        {entry.filteredMembers.length > 14 ? (
                          <div
                            style={{
                              padding: "6px 12px",
                              borderTopWidth: "1px",
                              borderTopStyle: "solid",
                              borderTopColor: "var(--border-default, #1e293b)",
                              display: "flex",
                              justifyContent: "flex-end",
                            }}
                          >
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedDeepIds((prev) => ({
                                  ...prev,
                                  [entry.id]: !prev[entry.id],
                                }))
                              }
                              style={{
                                background: "none",
                                border: "none",
                                color: "#38bdf8",
                                fontFamily: MONO_FONT,
                                fontSize: "11px",
                                cursor: "pointer",
                                padding: 0,
                              }}
                            >
                              {isExpanded
                                ? "Show fewer symbols"
                                : `Show ${hiddenCount} more symbols (${entry.filteredMembers.length} total)`}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div style={{ padding: "12px 14px", fontSize: "11px", color: "#64748b" }}>
                        {entry.available
                          ? "No members match the active symbol filter."
                          : "Target not exposed in this host environment."}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : null}

      {/* VIEW 5: LIVE SURFACE AUDIT */}
      {subTab === "live-audit" ? (
        <div
          data-runtime-view="live-audit"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {/* Section 5 Snippet Card */}
          <div
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
                gap: "8px",
                padding: "9px 14px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border-default, #1e293b)",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "8px",
                  flexWrap: "wrap",
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "var(--text-primary, #f8fafc)",
                }}
              >
                <Code2 size={14} aria-hidden="true" />
                <span>Live Surface Audit Snippet (Object.getOwnPropertyNames(Bun))</span>
                <div
                  role="group"
                  aria-label="Select audit snippet variant"
                  style={{
                    display: "inline-flex",
                    padding: "2px",
                    borderRadius: "5px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-default, #1e293b)",
                    backgroundColor: "var(--surface-overlay, #0a101d)",
                  }}
                >
                  {(
                    [
                      { id: "basic", label: "Quick Audit" },
                      { id: "deep", label: "Deep Kinds + bun:*" },
                    ] as const
                  ).map((variant) => {
                    const active = auditSnippetMode === variant.id
                    return (
                      <button
                        key={variant.id}
                        type="button"
                        onClick={() => setAuditSnippetMode(variant.id)}
                        style={{
                          padding: "2px 7px",
                          borderRadius: "3px",
                          border: "none",
                          backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                          color: active ? "#38bdf8" : "#94a3b8",
                          fontSize: "10.5px",
                          fontWeight: active ? 600 : 500,
                          cursor: "pointer",
                        }}
                      >
                        {variant.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void handleCopySnippet()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "5px 10px",
                  borderRadius: "5px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: copiedSnippet ? "#4ade80" : "var(--border-strong, #334155)",
                  backgroundColor: "transparent",
                  color: copiedSnippet ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {copiedSnippet ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
                <span>{copiedSnippet ? "Snippet Copied" : "Copy Snippet"}</span>
              </button>
            </div>
            <pre
              data-live-audit-snippet="true"
              style={{
                margin: 0,
                padding: "12px 14px",
                backgroundColor: "var(--surface-overlay, #0a101d)",
                color: "#e2e8f0",
                fontFamily: MONO_FONT,
                fontSize: "11.5px",
                lineHeight: 1.55,
                overflowX: "auto",
              }}
            >
              {activeAuditSnippet}
            </pre>
          </div>

          {/* Live Enumerated Bun Namespace Table / Inspect Output */}
          <div
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
                gap: "8px",
                padding: "10px 14px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border-default, #1e293b)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <div
                  role="group"
                  aria-label="Live audit output display mode"
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
                  {(
                    [
                      { id: "table", label: `Structured Grid (${filteredExports.length})` },
                      { id: "inspect", label: "Bun.inspect.table() Raw" },
                    ] as const
                  ).map((mode) => {
                    const active = auditDisplayMode === mode.id
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setAuditDisplayMode(mode.id)}
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
                        {mode.label}
                      </button>
                    )
                  })}
                </div>

                {auditDisplayMode === "table" ? (
                  <div
                    role="group"
                    aria-label="Filter exports by symbol kind"
                    style={{
                      display: "inline-flex",
                      flexWrap: "wrap",
                      gap: "4px",
                    }}
                  >
                    {(
                      [
                        { id: "all", label: `all kinds (${effectiveAudit.exportCount})` },
                        { id: "class", label: `class (${effectiveAudit.kindCounts.class})` },
                        {
                          id: "namespace",
                          label: `namespace (${effectiveAudit.kindCounts.namespace})`,
                        },
                        {
                          id: "function",
                          label: `function (${effectiveAudit.kindCounts.function})`,
                        },
                        {
                          id: "constant",
                          label: `constant (${effectiveAudit.kindCounts.constant})`,
                        },
                        { id: "object", label: `object (${effectiveAudit.kindCounts.object})` },
                      ] as const
                    ).map((item) => {
                      const active = auditKindFilter === item.id
                      const accent = item.id === "all" ? "#38bdf8" : kindColor(item.id)
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setAuditKindFilter(item.id)}
                          style={{
                            padding: "4px 8px",
                            borderRadius: "4px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: active ? accent : "var(--border-strong, #334155)",
                            backgroundColor: active ? "rgba(56, 189, 248, 0.1)" : "transparent",
                            color: active ? accent : "#94a3b8",
                            fontSize: "11px",
                            fontFamily: MONO_FONT,
                            cursor: "pointer",
                          }}
                        >
                          {item.label}
                        </button>
                      )
                    })}
                  </div>
                ) : null}

                {auditDisplayMode === "table" && exportTypes.length > 0 ? (
                  <select
                    aria-label="Filter exports by typeof"
                    value={auditTypeFilter}
                    onChange={(e) => setAuditTypeFilter(e.target.value)}
                    style={{
                      padding: "4px 8px",
                      borderRadius: "4px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                      color: "var(--text-primary, #e2e8f0)",
                      fontSize: "11px",
                      fontFamily: MONO_FONT,
                    }}
                  >
                    <option value="all">typeof: all ({effectiveAudit.exportCount})</option>
                    {exportTypes.map((t) => (
                      <option key={t} value={t}>
                        typeof: {t} ({effectiveAudit.exportTypeCounts[t] ?? 0})
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {auditDisplayMode === "table" ? (
                  <div
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      width: "220px",
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
                      aria-label="Filter Bun namespace exports"
                      value={auditSearch}
                      onChange={(e) => setAuditSearch(e.target.value)}
                      placeholder="Filter Bun.* export key…"
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
                        fontFamily: MONO_FONT,
                      }}
                    />
                  </div>
                ) : (
                  <>
                    <CopyBunTerminalAnsiButton
                      text={effectiveAudit.inspectTableText}
                      format="markdown"
                      compact
                    />
                    <button
                      type="button"
                      onClick={() => void handleCopyTable()}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        padding: "5px 10px",
                        borderRadius: "5px",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor: copiedTable ? "#4ade80" : "var(--border-strong, #334155)",
                        backgroundColor: "transparent",
                        color: copiedTable ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {copiedTable ? (
                        <Check size={12} aria-hidden="true" />
                      ) : (
                        <Copy size={12} aria-hidden="true" />
                      )}
                      <span>{copiedTable ? "Table Copied" : "Copy Table"}</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {auditDisplayMode === "inspect" ? (
              <pre
                data-bun-inspect-table-output="true"
                style={{
                  margin: 0,
                  padding: "14px",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "#e2e8f0",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                  lineHeight: 1.45,
                  overflowX: "auto",
                  maxHeight: "420px",
                }}
              >
                {effectiveAudit.inspectTableText}
              </pre>
            ) : filteredExports.length === 0 ? (
              <div style={{ padding: "20px 14px", fontSize: "12px", color: "#94a3b8" }}>
                {effectiveAudit.exportCount === 0
                  ? "No live Bun namespace exports were captured on this host. Run under Bun or ensure `bun` is on PATH."
                  : "No Bun namespace exports match the current filter."}
              </div>
            ) : (
              <div style={{ maxHeight: "440px", overflowY: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontFamily: MONO_FONT,
                    fontSize: "11.5px",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        textAlign: "left",
                        fontSize: "10.5px",
                        color: "var(--text-muted, #94a3b8)",
                        borderBottomWidth: "1px",
                        borderBottomStyle: "solid",
                        borderBottomColor: "var(--border-default, #1e293b)",
                      }}
                    >
                      <th style={{ padding: "7px 14px", width: "48px", textAlign: "right" }}>#</th>
                      <th style={{ padding: "7px 14px" }}>Export Key (Bun.*)</th>
                      <th style={{ padding: "7px 14px", width: "105px" }}>Kind</th>
                      <th style={{ padding: "7px 14px", width: "95px" }}>typeof</th>
                      <th style={{ padding: "7px 14px" }}>Members / Safe Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExports.map((entry, idx) => {
                      const detail = entry.redacted
                        ? (entry.safePreview ?? "[REDACTED]")
                        : entry.kind === "class" &&
                            (entry.staticMemberCount !== undefined ||
                              entry.prototypeMethodCount !== undefined)
                          ? `${entry.staticMemberCount ?? 0} static · ${entry.prototypeMethodCount ?? 0} prototype`
                          : entry.kind === "namespace" && entry.memberCount !== undefined
                            ? `${entry.memberCount} exports`
                            : entry.safePreview !== undefined
                              ? entry.safePreview
                              : "—"
                      return (
                        <tr
                          key={entry.key}
                          data-bun-export-key={entry.key}
                          data-bun-export-kind={entry.kind}
                          style={{
                            borderBottomWidth: "1px",
                            borderBottomStyle: "solid",
                            borderBottomColor: "rgba(30, 41, 59, 0.55)",
                          }}
                        >
                          <td
                            style={{
                              padding: "6px 14px",
                              textAlign: "right",
                              color: "#64748b",
                            }}
                          >
                            {idx}
                          </td>
                          <td
                            style={{
                              padding: "6px 14px",
                              color: "var(--text-primary, #f1f5f9)",
                              fontWeight: 600,
                            }}
                          >
                            Bun.{entry.key}
                          </td>
                          <td
                            style={{
                              padding: "6px 14px",
                              color: kindColor(entry.kind),
                              fontWeight: 600,
                            }}
                          >
                            {entry.kind}
                          </td>
                          <td
                            style={{
                              padding: "6px 14px",
                              color: "#94a3b8",
                            }}
                          >
                            {entry.type}
                          </td>
                          <td
                            style={{
                              padding: "6px 14px",
                              color: entry.redacted
                                ? "#f87171"
                                : entry.safePreview !== undefined
                                  ? "#86efac"
                                  : "#94a3b8",
                            }}
                          >
                            {detail}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* VIEW 6: MARKDOWN STUDIO & INTERACTIVE UTILITY SANDBOX */}
      {subTab === "sandbox" ? (
        <div
          data-runtime-view="sandbox"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
            gap: "12px",
          }}
        >
          {/* Full-width Studio Card: Bun.markdown.render & AnsiTheme */}
          <div
            data-bun-markdown-studio="true"
            style={{
              gridColumn: "1 / -1",
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {/* Studio Header */}
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
                gap: "10px",
              }}
            >
              <div>
                <div
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "7px",
                    fontSize: "13px",
                    fontWeight: 700,
                    color: "var(--text-primary, #f8fafc)",
                  }}
                >
                  <FileText size={14} aria-hidden="true" />
                  <span>Bun.markdown.render() &amp; AnsiTheme Terminal Studio</span>
                </div>
                <div
                  style={{
                    marginTop: "2px",
                    fontFamily: MONO_FONT,
                    fontSize: "10.5px",
                    color: "#94a3b8",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  engine {mdStudioResult.engine} · mode {mdStudioResult.mode} ·{" "}
                  {mdStudioResult.lineCount} lines · max {mdStudioResult.maxColumns} cols ·{" "}
                  {mdStudioResult.ansiByteLength} B
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <CopyBunTerminalAnsiButton text={mdStudioResult.ansi} format="markdown" compact />
                <button
                  type="button"
                  onClick={() => setMdSource(DEFAULT_BUN_MARKDOWN_STUDIO_SAMPLE)}
                  style={{
                    padding: "5px 9px",
                    borderRadius: "5px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-strong, #334155)",
                    backgroundColor: "transparent",
                    color: "#94a3b8",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  Reset Sample
                </button>
              </div>
            </div>

            {/* Studio Controls Toolbar */}
            <div
              style={{
                padding: "9px 14px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
              }}
            >
              {/* Mode selector */}
              <div
                role="group"
                aria-label="Bun.markdown render mode"
                style={{
                  display: "inline-flex",
                  flexWrap: "wrap",
                  gap: "2px",
                  padding: "2px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-default, #1e293b)",
                  backgroundColor: "var(--surface-panel, #0f172a)",
                }}
              >
                {(
                  [
                    { id: "render-callbacks", label: "Bun.markdown.render(callbacks)" },
                    { id: "ansi-theme", label: "Bun.markdown.ansi(AnsiTheme)" },
                    { id: "html", label: "Bun.markdown.html()" },
                  ] as const
                ).map((m) => {
                  const active = mdMode === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      data-md-mode={m.id}
                      onClick={() => {
                        setMdMode(m.id)
                        if (m.id === "html") setMdOutputView("html")
                        else if (mdOutputView === "html") setMdOutputView("terminal")
                      }}
                      style={{
                        padding: "4px 9px",
                        borderRadius: "4px",
                        border: "none",
                        backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                        color: active ? "#38bdf8" : "#94a3b8",
                        fontFamily: MONO_FONT,
                        fontSize: "11px",
                        fontWeight: active ? 600 : 500,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {m.label}
                    </button>
                  )
                })}
              </div>

              {/* Preset & AnsiTheme controls */}
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <div
                  role="group"
                  aria-label="AnsiTheme presets"
                  style={{ display: "inline-flex", gap: "4px", flexWrap: "wrap" }}
                >
                  {BUN_ANSI_THEME_PRESETS.map((preset) => {
                    const active = mdPresetId === preset.id
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        data-md-preset={preset.id}
                        onClick={() => handleSelectMdPreset(preset.id)}
                        style={{
                          padding: "3px 8px",
                          borderRadius: "4px",
                          borderWidth: "1px",
                          borderStyle: "solid",
                          borderColor: active
                            ? preset.paletteHex.heading
                            : "var(--border-strong, #334155)",
                          backgroundColor: active ? "rgba(56, 189, 248, 0.08)" : "transparent",
                          color: active ? preset.paletteHex.heading : "#94a3b8",
                          fontSize: "11px",
                          fontWeight: active ? 600 : 500,
                          cursor: "pointer",
                        }}
                      >
                        {preset.label}
                      </button>
                    )
                  })}
                </div>

                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    fontSize: "11px",
                    fontFamily: MONO_FONT,
                    color: "#cbd5e1",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={mdColors}
                    onChange={(e) => setMdColors(e.target.checked)}
                  />
                  colors
                </label>

                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    fontSize: "11px",
                    fontFamily: MONO_FONT,
                    color: "#cbd5e1",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={mdLight}
                    onChange={(e) => setMdLight(e.target.checked)}
                  />
                  light
                </label>

                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    fontSize: "11px",
                    fontFamily: MONO_FONT,
                    color: "#cbd5e1",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={mdHyperlinks}
                    onChange={(e) => setMdHyperlinks(e.target.checked)}
                  />
                  OSC-8
                </label>

                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    fontSize: "11px",
                    fontFamily: MONO_FONT,
                    color: "#94a3b8",
                  }}
                >
                  <span>cols</span>
                  <select
                    aria-label="AnsiTheme columns width"
                    value={mdColumns}
                    onChange={(e) => setMdColumns(Number(e.target.value))}
                    style={{
                      padding: "2px 6px",
                      borderRadius: "4px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      backgroundColor: "var(--surface-panel, #0f172a)",
                      color: "var(--text-primary, #f1f5f9)",
                      fontFamily: MONO_FONT,
                      fontSize: "11px",
                    }}
                  >
                    {[56, 72, 76, 80, 100].map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            {/* Semantic TrueColor Palette Strip */}
            <div
              style={{
                padding: "7px 14px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border-default, #1e293b)",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "12px",
                fontFamily: MONO_FONT,
                fontSize: "10.5px",
                color: "#94a3b8",
              }}
            >
              <span style={{ color: "#64748b", fontWeight: 600 }}>AnsiTheme TrueColor tokens:</span>
              {(
                Object.entries(mdStudioResult.paletteHex) as [
                  keyof typeof mdStudioResult.paletteHex,
                  string,
                ][]
              ).map(([token, hex]) => (
                <span
                  key={token}
                  style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: "9px",
                      height: "9px",
                      borderRadius: "2px",
                      backgroundColor: hex,
                      display: "inline-block",
                    }}
                  />
                  <span style={{ color: "#cbd5e1" }}>{token}</span>
                  <span style={{ color: "#64748b" }}>{hex}</span>
                </span>
              ))}
            </div>

            {/* Split Editor + Live Rendered ANSI Terminal Preview */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: "1px",
                backgroundColor: "var(--border-default, #1e293b)",
              }}
            >
              {/* Left: Markdown Source */}
              <div
                style={{
                  backgroundColor: "var(--surface-panel, #0f172a)",
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    fontFamily: MONO_FONT,
                    fontSize: "11px",
                    color: "#94a3b8",
                  }}
                >
                  <span>Markdown Source Input</span>
                  <span>{mdSource.length} chars</span>
                </div>
                <textarea
                  aria-label="Bun.markdown studio markdown input"
                  value={mdSource}
                  onChange={(e) => setMdSource(e.target.value)}
                  rows={11}
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
                    lineHeight: 1.5,
                    resize: "vertical",
                  }}
                />
              </div>

              {/* Right: Live ANSI / Escapes / HTML Output */}
              <div
                style={{
                  backgroundColor: "var(--surface-panel, #0f172a)",
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <div
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                      fontFamily: MONO_FONT,
                      fontSize: "11px",
                      color: "#94a3b8",
                    }}
                  >
                    <Terminal size={12} aria-hidden="true" />
                    <span>Rendered Output</span>
                  </div>
                  <div
                    role="group"
                    aria-label="Markdown output preview format"
                    style={{
                      display: "inline-flex",
                      gap: "2px",
                      padding: "2px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-default, #1e293b)",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                    }}
                  >
                    {(
                      [
                        { id: "terminal", label: "ANSI Terminal" },
                        { id: "raw-ansi", label: "Raw SGR / OSC-8" },
                        { id: "html", label: "HTML Output" },
                      ] as const
                    ).map((view) => {
                      const active = mdOutputView === view.id
                      return (
                        <button
                          key={view.id}
                          type="button"
                          onClick={() => setMdOutputView(view.id)}
                          style={{
                            padding: "2px 8px",
                            borderRadius: "3px",
                            border: "none",
                            backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                            color: active ? "#38bdf8" : "#94a3b8",
                            fontSize: "10.5px",
                            fontWeight: active ? 600 : 500,
                            cursor: "pointer",
                          }}
                        >
                          {view.label}
                        </button>
                      )
                    })}
                  </div>
                </div>

                {mdOutputView === "terminal" ? (
                  <pre
                    data-markdown-ansi-preview="true"
                    style={{
                      margin: 0,
                      padding: "11px 12px",
                      minHeight: "208px",
                      maxHeight: "290px",
                      overflow: "auto",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: mdLight ? "#cbd5e1" : "var(--border-strong, #334155)",
                      backgroundColor: mdLight ? "#f8fafc" : "#070c17",
                      color: mdLight ? "#0f172a" : "#e2e8f0",
                      fontFamily: MONO_FONT,
                      fontSize: "11.5px",
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {renderAnsiReact(mdStudioResult.ansi)}
                  </pre>
                ) : mdOutputView === "raw-ansi" ? (
                  <pre
                    data-markdown-raw-ansi="true"
                    style={{
                      margin: 0,
                      padding: "11px 12px",
                      minHeight: "208px",
                      maxHeight: "290px",
                      overflow: "auto",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                      color: "#cbd5e1",
                      fontFamily: MONO_FONT,
                      fontSize: "11px",
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    {escapeAnsiForDisplay(mdStudioResult.ansi)}
                  </pre>
                ) : (
                  <pre
                    data-markdown-html-output="true"
                    style={{
                      margin: 0,
                      padding: "11px 12px",
                      minHeight: "208px",
                      maxHeight: "290px",
                      overflow: "auto",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                      color: "#93c5fd",
                      fontFamily: MONO_FONT,
                      fontSize: "11px",
                      lineHeight: 1.5,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {mdStudioResult.html}
                  </pre>
                )}
              </div>
            </div>

            {/* Active Callback Trace & Render Hook Contract Reference */}
            <div
              style={{
                padding: "9px 14px",
                borderTopWidth: "1px",
                borderTopStyle: "solid",
                borderTopColor: "var(--border-default, #1e293b)",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  fontFamily: MONO_FONT,
                  fontSize: "11px",
                  color: "#94a3b8",
                }}
              >
                <span style={{ color: "#cbd5e1", fontWeight: 600 }}>Callbacks invoked: </span>
                {mdStudioResult.callbacksInvoked.length > 0
                  ? mdStudioResult.callbacksInvoked.join(" · ")
                  : "none"}
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))",
                  gap: "6px 14px",
                  paddingTop: "6px",
                  borderTopWidth: "1px",
                  borderTopStyle: "solid",
                  borderTopColor: "rgba(30, 41, 59, 0.55)",
                  fontSize: "10.5px",
                }}
              >
                {BUN_MARKDOWN_CALLBACK_SPECS.map((spec) => {
                  const hit = mdStudioResult.callbacksInvoked.includes(spec.hook)
                  return (
                    <div
                      key={spec.hook}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: "1px",
                      }}
                    >
                      <div
                        style={{
                          fontFamily: MONO_FONT,
                          color: hit ? "#38bdf8" : "#cbd5e1",
                          fontWeight: 600,
                        }}
                      >
                        {spec.hook}{" "}
                        <span style={{ color: "#64748b", fontWeight: 400 }}>{spec.signature}</span>
                      </div>
                      <div style={{ color: "#64748b" }}>{spec.role}</div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
          {/* Card A: Strings & Terminal Utilities */}
          <div
            style={{
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              padding: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
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
                Strings &amp; Terminal Probe
              </div>
              <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
                Evaluates <code style={{ fontFamily: MONO_FONT }}>Bun.stringWidth</code>,{" "}
                <code style={{ fontFamily: MONO_FONT }}>Bun.stripANSI</code>, and{" "}
                <code style={{ fontFamily: MONO_FONT }}>Bun.escapeHTML</code> live.
              </div>
            </div>

            <input
              type="text"
              aria-label="String utility probe input"
              value={sandboxStringInput}
              onChange={(e) => setSandboxStringInput(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "7px 10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-strong, #334155)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
                color: "var(--text-primary, #f1f5f9)",
                fontFamily: MONO_FONT,
                fontSize: "11.5px",
              }}
            />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px",
                fontFamily: MONO_FONT,
                fontSize: "11.5px",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <div>
                <div style={{ color: "#64748b", fontSize: "10.5px" }}>Bun.stringWidth()</div>
                <div style={{ color: "#38bdf8", fontWeight: 700, marginTop: "2px" }}>
                  {stringProbe.displayWidth} cols
                </div>
              </div>
              <div>
                <div style={{ color: "#64748b", fontSize: "10.5px" }}>UTF-16 Length</div>
                <div style={{ color: "#e2e8f0", fontWeight: 700, marginTop: "2px" }}>
                  {stringProbe.rawLength} chars
                </div>
              </div>
            </div>

            <div style={{ fontFamily: MONO_FONT, fontSize: "11px" }}>
              <div style={{ color: "#64748b", marginBottom: "3px" }}>Bun.stripANSI()</div>
              <div
                style={{
                  padding: "7px 9px",
                  borderRadius: "5px",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "#86efac",
                  wordBreak: "break-word",
                }}
              >
                {stringProbe.stripped}
              </div>
            </div>

            <div style={{ fontFamily: MONO_FONT, fontSize: "11px" }}>
              <div style={{ color: "#64748b", marginBottom: "3px" }}>Bun.escapeHTML()</div>
              <div
                style={{
                  padding: "7px 9px",
                  borderRadius: "5px",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "#cbd5e1",
                  wordBreak: "break-word",
                }}
              >
                {stringProbe.escapedHtml}
              </div>
            </div>
          </div>

          {/* Card B: Bun.color & Bun.randomUUIDv7 */}
          <div
            style={{
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              padding: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
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
                Bun.color() &amp; Bun.randomUUIDv7()
              </div>
              <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
                Convert CSS colors to hex/rgb/number/ansi-16m and mint monotonic UUIDv7 IDs.
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                aria-hidden="true"
                style={{
                  width: "26px",
                  height: "26px",
                  borderRadius: "5px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: colorProbe.valid && colorProbe.hex ? colorProbe.hex : "#1e293b",
                  flexShrink: 0,
                }}
              />
              <input
                type="text"
                aria-label="Bun.color CSS input"
                value={sandboxColorInput}
                onChange={(e) => setSandboxColorInput(e.target.value)}
                placeholder="#38bdf8 or rgb(56, 189, 248)"
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                }}
              />
            </div>

            {colorProbe.valid ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "6px 10px",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  fontFamily: MONO_FONT,
                  fontSize: "11px",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <div>
                  <span style={{ color: "#64748b" }}>hex: </span>
                  <span style={{ color: "#e2e8f0" }}>{colorProbe.hex}</span>
                </div>
                <div>
                  <span style={{ color: "#64748b" }}>number: </span>
                  <span style={{ color: "#fbbf24" }}>{colorProbe.number}</span>
                </div>
                <div>
                  <span style={{ color: "#64748b" }}>rgb: </span>
                  <span style={{ color: "#86efac" }}>{colorProbe.rgb}</span>
                </div>
                <div>
                  <span style={{ color: "#64748b" }}>ansi-16m: </span>
                  <span style={{ color: "#c084fc" }}>
                    {colorProbe.ansi16m?.replace(/\u001b/g, "\\x1b")}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: "11.5px", color: "#fbbf24" }}>
                Enter a valid hex (#38bdf8) or rgb(r, g, b) color.
              </div>
            )}

            <div
              style={{
                borderTopWidth: "1px",
                borderTopStyle: "solid",
                borderTopColor: "var(--border-default, #1e293b)",
                paddingTop: "10px",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "8px",
                }}
              >
                <span style={{ fontSize: "11.5px", fontWeight: 600, color: "#e2e8f0" }}>
                  Time-Ordered UUIDv7 Generator
                </span>
                <button
                  type="button"
                  data-generate-uuidv7="true"
                  onClick={handleMintUuidV7}
                  style={{
                    padding: "5px 10px",
                    borderRadius: "5px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "#38bdf8",
                    backgroundColor: "rgba(56, 189, 248, 0.12)",
                    color: "#38bdf8",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Generate UUIDv7
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  fontFamily: MONO_FONT,
                  fontSize: "11px",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {uuidHistory.map((id) => (
                  <div
                    key={id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "8px",
                      padding: "5px 8px",
                      borderRadius: "4px",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                    }}
                  >
                    <span style={{ color: "#7dd3fc" }}>{id}</span>
                    <span style={{ color: "#64748b", fontSize: "10px" }}>
                      {decodeUuidV7TimestampIso(id)?.slice(11, 23)}Z
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Card C: Bun.deepEquals Comparator */}
          <div
            style={{
              gridColumn: "1 / -1",
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              padding: "14px",
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
                  Bun.deepEquals(a, b, strict) Structural Comparator
                </div>
                <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
                  Compare two JSON values using Bun&apos;s deep structural equality semantics.
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "11.5px",
                    fontFamily: MONO_FONT,
                    color: "var(--text-muted, #cbd5e1)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={deepEqStrict}
                    onChange={(e) => setDeepEqStrict(e.target.checked)}
                  />
                  <span>strict: {String(deepEqStrict)}</span>
                </label>

                <span
                  data-deep-equals-verdict={deepEqResult.ok ? String(deepEqResult.equal) : "error"}
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: "12px",
                    fontWeight: 700,
                    color: !deepEqResult.ok
                      ? "#f87171"
                      : deepEqResult.equal
                        ? "#4ade80"
                        : "#fbbf24",
                  }}
                >
                  {!deepEqResult.ok
                    ? `JSON Error: ${deepEqResult.error}`
                    : deepEqResult.equal
                      ? "Result: true (structurally equal)"
                      : "Result: false (differs)"}
                </span>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "10px",
              }}
            >
              <textarea
                aria-label="Bun.deepEquals left JSON"
                value={deepEqLeft}
                onChange={(e) => setDeepEqLeft(e.target.value)}
                rows={5}
                spellCheck={false}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                  lineHeight: 1.5,
                }}
              />
              <textarea
                aria-label="Bun.deepEquals right JSON"
                value={deepEqRight}
                onChange={(e) => setDeepEqRight(e.target.value)}
                rows={5}
                spellCheck={false}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                  lineHeight: 1.5,
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
