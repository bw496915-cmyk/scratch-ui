import {
  AlertCircle,
  ArrowUpRight,
  Braces,
  Check,
  Copy,
  Cpu,
  Download,
  FileCode2,
  GitBranch,
  Lock,
  Package,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
} from "lucide-react"
import type React from "react"
import { useEffect, useMemo, useState } from "react"

import { convertEnvTemplateToBunYaml } from "@sportsdesk-ops/contracts"

import type {
  ConfigItemKind,
  ConfigStatusItem,
  ConfigStatusSnapshot,
  DashboardTabId,
} from "../types.ts"
import { isDashboardTabId } from "../types.ts"
import { BunRuntimeSurfaceSection } from "./BunRuntimeSurfaceSection.tsx"
import { KeyboardShortcutsPanel } from "./KeyboardShortcutsPanel.tsx"
import { NpmrcSupportSection } from "./NpmrcSupportSection.tsx"
import {
  CopyBunTerminalAnsiButton,
  SyntaxHighlightedPre,
  SyntaxTokenLegend,
} from "./SyntaxHighlightedPre.tsx"
import { YamlRuntimeSection } from "./YamlRuntimeSection.tsx"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

export type StatusDashboardViewMode =
  "registry" | "components" | "env-example" | "npmrc" | "yaml" | "runtime-surface"

export interface StatusDashboardPanelProps {
  readonly snapshot: ConfigStatusSnapshot | null
  readonly loading: boolean
  readonly error: string | null
  readonly saving: boolean
  readonly saveNotice?: {
    readonly type: "success" | "error"
    readonly message: string
  } | null
  readonly onRefresh: () => void
  readonly onSaveOverrides: (
    overrides: Readonly<Record<string, string>>,
  ) => Promise<boolean> | boolean
  readonly onResetOverrides: (keys?: readonly string[]) => Promise<void> | void
  readonly onNavigateTab?: ((tab: DashboardTabId) => void) | undefined
}

function statusDisplayMeta(item: ConfigStatusItem): {
  readonly label: string
  readonly color: string
} {
  if (item.sensitive) {
    return item.configured
      ? { label: "Secret configured", color: "#4ade80" }
      : { label: "Secret unset", color: "#fbbf24" }
  }
  switch (item.status) {
    case "overridden":
      return { label: "Saved override", color: "#38bdf8" }
    case "configured":
      return { label: "Active env", color: "#4ade80" }
    case "default":
      return { label: "Default", color: "#94a3b8" }
    case "unset":
      return { label: "Unset", color: "#fbbf24" }
  }
}

function kindLabel(kind: ConfigItemKind): string {
  switch (kind) {
    case "env":
      return ".env.example"
    case "constant":
      return "Constant"
    case "variable":
      return "Runtime Var"
  }
}

export function StatusDashboardPanel({
  snapshot,
  loading,
  error,
  saving,
  saveNotice = null,
  onRefresh,
  onSaveOverrides,
  onResetOverrides,
  onNavigateTab,
}: StatusDashboardPanelProps): React.ReactElement {
  const [viewMode, setViewMode] = useState<StatusDashboardViewMode>("registry")
  const [searchQuery, setSearchQuery] = useState("")
  const [kindFilter, setKindFilter] = useState<"all" | ConfigItemKind>("all")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  const [statusFilter, setStatusFilter] = useState<string>("all")
  const [componentFilter, setComponentFilter] = useState<string>("all")
  const [selectedComponentName, setSelectedComponentName] = useState<string>("")
  const [componentSearch, setComponentSearch] = useState<string>("")
  const [draftValues, setDraftValues] = useState<Record<string, string>>({})
  const [copiedEnv, setCopiedEnv] = useState<boolean>(false)
  const [envPreviewFormat, setEnvPreviewFormat] = useState<"env" | "yaml">("env")

  // Clear stale draft entries that match freshly saved server values
  useEffect(() => {
    if (!snapshot) return
    setDraftValues((prev) => {
      const next: Record<string, string> = {}
      for (const [key, draftVal] of Object.entries(prev)) {
        const item = snapshot.items.find((i) => i.key === key)
        if (item && item.editable && (item.value ?? "") !== draftVal) {
          next[key] = draftVal
        }
      }
      return next
    })
  }, [snapshot])

  // Select first component automatically in traceability view
  useEffect(() => {
    if (!snapshot || snapshot.components.length === 0) return
    if (
      !selectedComponentName ||
      !snapshot.components.some((c) => c.component === selectedComponentName)
    ) {
      setSelectedComponentName(snapshot.components[0]!.component)
    }
  }, [snapshot, selectedComponentName])

  const categories = useMemo(() => {
    if (!snapshot) return [] as string[]
    return Array.from(new Set(snapshot.items.map((item) => item.category))).sort()
  }, [snapshot])

  const dirtyEntries = useMemo(() => {
    if (!snapshot) return {} as Record<string, string>
    const dirty: Record<string, string> = {}
    for (const [key, val] of Object.entries(draftValues)) {
      const item = snapshot.items.find((i) => i.key === key)
      if (!item || !item.editable || item.sensitive) continue
      if ((item.value ?? "") !== val) {
        dirty[key] = val
      }
    }
    return dirty
  }, [draftValues, snapshot])

  const dirtyCount = Object.keys(dirtyEntries).length

  const filteredItems = useMemo(() => {
    if (!snapshot) return [] as readonly ConfigStatusItem[]
    const q = searchQuery.trim().toLowerCase()
    return snapshot.items.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false
      if (categoryFilter !== "all" && item.category !== categoryFilter) {
        return false
      }
      if (statusFilter === "secrets" && !item.sensitive) return false
      if (statusFilter !== "all" && statusFilter !== "secrets" && item.status !== statusFilter) {
        return false
      }
      if (
        componentFilter !== "all" &&
        !item.consumers.some((c) => c.component === componentFilter)
      ) {
        return false
      }
      if (q) {
        const hay = [
          item.key,
          item.label,
          item.description,
          item.category,
          item.sourceFile,
          ...item.consumers.map((c) => `${c.component} ${c.usage}`),
        ]
          .join(" ")
          .toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [snapshot, searchQuery, kindFilter, categoryFilter, statusFilter, componentFilter])

  const filteredComponents = useMemo(() => {
    if (!snapshot) return []
    const q = componentSearch.trim().toLowerCase()
    if (!q) return snapshot.components
    return snapshot.components.filter(
      (comp) =>
        comp.component.toLowerCase().includes(q) ||
        comp.layer.toLowerCase().includes(q) ||
        comp.items.some(
          (i) => i.key.toLowerCase().includes(q) || i.usage.toLowerCase().includes(q),
        ),
    )
  }, [snapshot, componentSearch])

  const activeComponent = useMemo(() => {
    if (!snapshot) return null
    return (
      snapshot.components.find((c) => c.component === selectedComponentName) ??
      filteredComponents[0] ??
      null
    )
  }, [snapshot, selectedComponentName, filteredComponents])

  const envAsBunYaml = useMemo(() => {
    if (!snapshot) return null
    return convertEnvTemplateToBunYaml(snapshot.envExampleText)
  }, [snapshot])

  const handleSave = async () => {
    if (dirtyCount === 0 || saving) return
    const ok = await onSaveOverrides(dirtyEntries)
    if (ok) {
      setDraftValues({})
    }
  }

  const handleCopyEnvExample = async () => {
    if (!snapshot) return
    try {
      await navigator.clipboard.writeText(snapshot.envExampleText)
      setCopiedEnv(true)
      setTimeout(() => setCopiedEnv(false), 1800)
    } catch {
      setCopiedEnv(false)
    }
  }

  const handleDownloadEnvExample = () => {
    if (!snapshot || typeof document === "undefined") return
    const blob = new Blob([snapshot.envExampleText], {
      type: "text/plain;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = ".env.example"
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  }

  const handleJumpToComponentTrace = (componentName: string) => {
    setSelectedComponentName(componentName)
    setViewMode("components")
  }

  const handleJumpToKeyInRegistry = (key: string) => {
    setSearchQuery(key)
    setKindFilter("all")
    setCategoryFilter("all")
    setStatusFilter("all")
    setComponentFilter("all")
    setViewMode("registry")
  }

  return (
    <section
      aria-label="Configuration and Status Dashboard"
      data-status-dashboard="true"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "16px",
        padding: "16px 0",
      }}
    >
      {/* Top Header + Primary Actions */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
          paddingBottom: "12px",
          borderBottomWidth: "1px",
          borderBottomStyle: "solid",
          borderBottomColor: "var(--border-default, #1e293b)",
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: "18px",
              fontWeight: 700,
              color: "var(--text-primary, #f8fafc)",
              letterSpacing: "-0.01em",
            }}
          >
            Configuration & Status Dashboard
          </h2>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: "12.5px",
              color: "var(--text-muted, #94a3b8)",
            }}
          >
            Inspect and edit non-secret <code style={{ fontFamily: MONO_FONT }}>.env.example</code>{" "}
            variables, build-time constants, and runtime values, and trace every key to the
            components that consume it.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          {dirtyCount > 0 ? (
            <button
              type="button"
              onClick={() => setDraftValues({})}
              disabled={saving}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "7px 12px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-strong, #334155)",
                backgroundColor: "var(--surface-panel, #0f172a)",
                color: "var(--text-secondary, #cbd5e1)",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <span>Discard ({dirtyCount})</span>
            </button>
          ) : null}

          <button
            type="button"
            data-status-save-btn="true"
            onClick={() => void handleSave()}
            disabled={dirtyCount === 0 || saving}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "7px 14px",
              borderRadius: "6px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: dirtyCount > 0 ? "#0284c7" : "var(--border-default, #1e293b)",
              backgroundColor: dirtyCount > 0 ? "#0284c7" : "var(--surface-panel, #0f172a)",
              color: dirtyCount > 0 ? "#f8fafc" : "#64748b",
              fontSize: "12px",
              fontWeight: 600,
              cursor: dirtyCount > 0 && !saving ? "pointer" : "not-allowed",
              whiteSpace: "nowrap",
            }}
          >
            <Save size={13} aria-hidden="true" />
            <span>
              {saving
                ? "Saving…"
                : dirtyCount > 0
                  ? `Save Changes (${dirtyCount})`
                  : "Save Changes"}
            </span>
          </button>

          {snapshot && snapshot.summary.overriddenCount > 0 ? (
            <button
              type="button"
              onClick={() => void onResetOverrides()}
              disabled={saving}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "7px 12px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-strong, #334155)",
                backgroundColor: "var(--surface-panel, #0f172a)",
                color: "var(--text-secondary, #cbd5e1)",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <RotateCcw size={13} aria-hidden="true" />
              <span>Reset Saved ({snapshot.summary.overriddenCount})</span>
            </button>
          ) : null}

          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "7px 12px",
              borderRadius: "6px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-strong, #334155)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              color: "var(--text-primary, #e2e8f0)",
              fontSize: "12px",
              fontWeight: 600,
              cursor: loading ? "wait" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            <RefreshCw size={13} aria-hidden="true" />
            <span>{loading ? "Syncing…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* Save / Validation Notice */}
      {saveNotice ? (
        <div
          role={saveNotice.type === "error" ? "alert" : "status"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "9px 12px",
            borderRadius: "6px",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor:
              saveNotice.type === "error" ? "rgba(239, 68, 68, 0.45)" : "rgba(34, 197, 94, 0.45)",
            backgroundColor:
              saveNotice.type === "error" ? "rgba(239, 68, 68, 0.08)" : "rgba(34, 197, 94, 0.08)",
            color: saveNotice.type === "error" ? "#fca5a5" : "#86efac",
            fontSize: "12px",
          }}
        >
          {saveNotice.type === "error" ? (
            <AlertCircle size={14} aria-hidden="true" />
          ) : (
            <Check size={14} aria-hidden="true" />
          )}
          <span>{saveNotice.message}</span>
        </div>
      ) : null}

      {/* Fetch Error Banner */}
      {error ? (
        <div
          role="alert"
          data-status-dashboard-error="true"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
            padding: "12px 14px",
            borderRadius: "8px",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "rgba(239, 68, 68, 0.45)",
            backgroundColor: "rgba(239, 68, 68, 0.08)",
            color: "#fca5a5",
            fontSize: "12.5px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <AlertCircle size={15} aria-hidden="true" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            style={{
              padding: "5px 11px",
              borderRadius: "5px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "rgba(248, 113, 113, 0.5)",
              backgroundColor: "rgba(239, 68, 68, 0.14)",
              color: "#fecaca",
              fontSize: "12px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Loading Skeleton */}
      {loading && !snapshot ? (
        <div
          data-status-dashboard-skeleton="true"
          aria-label="Loading configuration status dashboard"
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
              gap: "10px",
            }}
          >
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                style={{
                  height: "74px",
                  borderRadius: "8px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-default, #1e293b)",
                  backgroundColor: "var(--surface-panel, #0f172a)",
                }}
              />
            ))}
          </div>
          <div
            style={{
              height: "280px",
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
            }}
          />
        </div>
      ) : null}

      {/* Main Content when Hydrated */}
      {snapshot ? (
        <>
          {/* KPI Summary Strip */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
              gap: "10px",
            }}
          >
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "8px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-panel, #0f172a)",
              }}
            >
              <div style={{ fontSize: "11.5px", color: "var(--text-muted, #94a3b8)" }}>
                Tracked Entries
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "22px",
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--text-primary, #f8fafc)",
                }}
              >
                {snapshot.summary.totalItems}
              </div>
              <div
                style={{
                  marginTop: "2px",
                  fontSize: "11px",
                  color: "#64748b",
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {snapshot.summary.envCount} env · {snapshot.summary.constantCount} const ·{" "}
                {snapshot.summary.variableCount} var
              </div>
            </div>

            <div
              style={{
                padding: "12px 14px",
                borderRadius: "8px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-panel, #0f172a)",
              }}
            >
              <div style={{ fontSize: "11.5px", color: "var(--text-muted, #94a3b8)" }}>
                Active & Configured
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "22px",
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                  color: "#4ade80",
                }}
              >
                {snapshot.summary.configuredCount}
              </div>
              <div
                style={{
                  marginTop: "2px",
                  fontSize: "11px",
                  color: "#64748b",
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {snapshot.summary.unsetCount} optional unset
              </div>
            </div>

            <div
              style={{
                padding: "12px 14px",
                borderRadius: "8px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-panel, #0f172a)",
              }}
            >
              <div style={{ fontSize: "11.5px", color: "var(--text-muted, #94a3b8)" }}>
                Saved Overrides
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "22px",
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                  color:
                    snapshot.summary.overriddenCount > 0
                      ? "#38bdf8"
                      : "var(--text-primary, #f8fafc)",
                }}
              >
                {snapshot.summary.overriddenCount}
              </div>
              <div style={{ marginTop: "2px", fontSize: "11px", color: "#64748b" }}>
                {dirtyCount > 0
                  ? `${dirtyCount} unsaved edit${dirtyCount === 1 ? "" : "s"}`
                  : "Synced with server"}
              </div>
            </div>

            <div
              style={{
                padding: "12px 14px",
                borderRadius: "8px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-panel, #0f172a)",
              }}
            >
              <div style={{ fontSize: "11.5px", color: "var(--text-muted, #94a3b8)" }}>
                Traced Components
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "22px",
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                  color: "#c084fc",
                }}
              >
                {snapshot.summary.componentCount}
              </div>
              <div style={{ marginTop: "2px", fontSize: "11px", color: "#64748b" }}>
                UI panels, API & server modules
              </div>
            </div>

            <div
              style={{
                padding: "12px 14px",
                borderRadius: "8px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-panel, #0f172a)",
              }}
            >
              <div style={{ fontSize: "11.5px", color: "var(--text-muted, #94a3b8)" }}>
                Protected Secrets
              </div>
              <div
                style={{
                  marginTop: "4px",
                  fontSize: "22px",
                  fontWeight: 700,
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                  color: "#fbbf24",
                }}
              >
                {snapshot.summary.secretConfiguredCount}/{snapshot.summary.secretCount}
              </div>
              <div style={{ marginTop: "2px", fontSize: "11px", color: "#64748b" }}>
                Read-only server presence check
              </div>
            </div>
          </div>

          {/* Compact Keyboard Shortcuts Reference */}
          <KeyboardShortcutsPanel onNavigateTab={onNavigateTab} />

          {/* Segmented View Mode Switcher */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
            }}
          >
            <div
              role="tablist"
              aria-label="Status Dashboard Views"
              style={{
                display: "inline-flex",
                borderRadius: "7px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-panel, #0f172a)",
                padding: "3px",
                gap: "3px",
              }}
            >
              {(
                [
                  {
                    id: "registry",
                    label: "Registry & Editor",
                    icon: SlidersHorizontal,
                  },
                  {
                    id: "components",
                    label: "Component Traceability",
                    icon: GitBranch,
                  },
                  {
                    id: "env-example",
                    label: ".env.example Template",
                    icon: FileCode2,
                  },
                  {
                    id: "npmrc",
                    label: ".npmrc & bunfig",
                    icon: Package,
                  },
                  {
                    id: "yaml",
                    label: "YAML (Bun.YAML)",
                    icon: Braces,
                  },
                  {
                    id: "runtime-surface",
                    label: "Bun Runtime Surface",
                    icon: Cpu,
                  },
                ] as const
              ).map((tab) => {
                const Icon = tab.icon
                const active = viewMode === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setViewMode(tab.id)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "6px 12px",
                      borderRadius: "5px",
                      border: "none",
                      backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                      color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                      fontSize: "12px",
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

            <div
              style={{
                fontSize: "11.5px",
                color: "#64748b",
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              Updated {snapshot.updatedAt.slice(11, 19)}Z · Secrets stay server-side
            </div>
          </div>

          {/* VIEW 1: REGISTRY & EDITOR */}
          {viewMode === "registry" ? (
            <div
              data-status-view="registry"
              style={{
                borderRadius: "8px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-panel, #0f172a)",
                overflow: "hidden",
              }}
            >
              {/* Filter Toolbar */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                  padding: "10px 12px",
                  borderBottomWidth: "1px",
                  borderBottomStyle: "solid",
                  borderBottomColor: "var(--border-default, #1e293b)",
                }}
              >
                <div
                  style={{
                    position: "relative",
                    flex: "1 1 220px",
                    minWidth: "200px",
                  }}
                >
                  <Search
                    size={13}
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: "9px",
                      top: "50%",
                      transform: "translateY(-50%)",
                      color: "#64748b",
                    }}
                  />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter by key, component, file, or description…"
                    aria-label="Filter configuration items"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "6px 10px 6px 28px",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                      color: "var(--text-primary, #f1f5f9)",
                      fontSize: "12px",
                    }}
                  />
                </div>

                {/* Kind segmented buttons */}
                <div
                  role="group"
                  aria-label="Filter by configuration kind"
                  style={{
                    display: "inline-flex",
                    borderRadius: "6px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-strong, #334155)",
                    overflow: "hidden",
                  }}
                >
                  {(
                    [
                      ["all", "All"],
                      ["env", ".env.example"],
                      ["constant", "Constants"],
                      ["variable", "Runtime Vars"],
                    ] as const
                  ).map(([val, lbl], idx) => {
                    const active = kindFilter === val
                    return (
                      <button
                        key={val}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setKindFilter(val)}
                        style={{
                          padding: "5px 9px",
                          fontSize: "11.5px",
                          fontWeight: active ? 600 : 500,
                          border: "none",
                          borderLeftWidth: idx === 0 ? "0px" : "1px",
                          borderLeftStyle: "solid",
                          borderLeftColor: "var(--border-strong, #334155)",
                          backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                          color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {lbl}
                      </button>
                    )
                  })}
                </div>

                <select
                  aria-label="Filter by category"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  style={{
                    padding: "5px 9px",
                    borderRadius: "6px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-strong, #334155)",
                    backgroundColor: "var(--surface-overlay, #0a101d)",
                    color: "var(--text-primary, #e2e8f0)",
                    fontSize: "11.5px",
                  }}
                >
                  <option value="all">All categories</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Filter by component"
                  value={componentFilter}
                  onChange={(e) => setComponentFilter(e.target.value)}
                  style={{
                    padding: "5px 9px",
                    borderRadius: "6px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-strong, #334155)",
                    backgroundColor: "var(--surface-overlay, #0a101d)",
                    color: "var(--text-primary, #e2e8f0)",
                    fontSize: "11.5px",
                  }}
                >
                  <option value="all">All components</option>
                  {snapshot.components.map((comp) => (
                    <option key={comp.component} value={comp.component}>
                      {comp.component} ({comp.itemCount})
                    </option>
                  ))}
                </select>

                <select
                  aria-label="Filter by status"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  style={{
                    padding: "5px 9px",
                    borderRadius: "6px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "var(--border-strong, #334155)",
                    backgroundColor: "var(--surface-overlay, #0a101d)",
                    color: "var(--text-primary, #e2e8f0)",
                    fontSize: "11.5px",
                  }}
                >
                  <option value="all">All statuses</option>
                  <option value="overridden">Saved overrides</option>
                  <option value="configured">Active env</option>
                  <option value="default">Default</option>
                  <option value="unset">Unset</option>
                  <option value="secrets">Protected secrets</option>
                </select>
              </div>

              {filteredItems.length === 0 ? (
                <div
                  data-status-empty="true"
                  style={{
                    padding: "28px 16px",
                    textAlign: "center",
                    color: "var(--text-muted, #94a3b8)",
                    fontSize: "12.5px",
                  }}
                >
                  <div>No configuration entries match the current filters.</div>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("")
                      setKindFilter("all")
                      setCategoryFilter("all")
                      setStatusFilter("all")
                      setComponentFilter("all")
                    }}
                    style={{
                      marginTop: "10px",
                      padding: "6px 12px",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      backgroundColor: "transparent",
                      color: "#38bdf8",
                      fontSize: "12px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Reset Filters
                  </button>
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
                          color: "var(--text-muted, #94a3b8)",
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "var(--border-default, #1e293b)",
                          fontSize: "11px",
                        }}
                      >
                        <th style={{ padding: "9px 12px", fontWeight: 600 }}>Key & Metadata</th>
                        <th style={{ padding: "9px 12px", fontWeight: 600, width: "125px" }}>
                          Status
                        </th>
                        <th style={{ padding: "9px 12px", fontWeight: 600, width: "260px" }}>
                          Value (Editable / Read-Only)
                        </th>
                        <th style={{ padding: "9px 12px", fontWeight: 600, width: "260px" }}>
                          Component Traceability
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((item) => {
                        const statusMeta = statusDisplayMeta(item)
                        const hasDraft = Object.prototype.hasOwnProperty.call(draftValues, item.key)
                        const currentInputVal = hasDraft
                          ? draftValues[item.key]!
                          : (item.value ?? "")
                        const isDirty = hasDraft && currentInputVal !== (item.value ?? "")

                        return (
                          <tr
                            key={item.key}
                            data-config-key={item.key}
                            style={{
                              borderBottomWidth: "1px",
                              borderBottomStyle: "solid",
                              borderBottomColor: "rgba(30, 41, 59, 0.7)",
                              backgroundColor: isDirty ? "rgba(56, 189, 248, 0.05)" : "transparent",
                            }}
                          >
                            {/* Key & Metadata */}
                            <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                              <div
                                style={{
                                  fontFamily: MONO_FONT,
                                  fontWeight: 600,
                                  color: "var(--text-primary, #f8fafc)",
                                  fontSize: "12px",
                                }}
                              >
                                {item.key}
                              </div>
                              <div
                                style={{
                                  marginTop: "2px",
                                  fontSize: "11px",
                                  color: "#64748b",
                                }}
                              >
                                <span>{kindLabel(item.kind)}</span>
                                <span aria-hidden="true"> · </span>
                                <span>{item.category}</span>
                                <span aria-hidden="true"> · </span>
                                <span style={{ fontFamily: MONO_FONT }}>{item.sourceFile}</span>
                              </div>
                              <div
                                style={{
                                  marginTop: "3px",
                                  fontSize: "11.5px",
                                  color: "var(--text-muted, #94a3b8)",
                                  lineHeight: 1.4,
                                }}
                              >
                                {item.description}
                              </div>
                            </td>

                            {/* Status */}
                            <td
                              style={{
                                padding: "10px 12px",
                                verticalAlign: "top",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <div
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "5px",
                                  fontSize: "11.5px",
                                  fontWeight: 600,
                                  color: statusMeta.color,
                                }}
                              >
                                {item.sensitive ? <Lock size={12} aria-hidden="true" /> : null}
                                <span>{statusMeta.label}</span>
                              </div>
                              {isDirty ? (
                                <div
                                  style={{
                                    marginTop: "3px",
                                    fontSize: "10.5px",
                                    color: "#38bdf8",
                                    fontWeight: 600,
                                  }}
                                >
                                  Unsaved edit
                                </div>
                              ) : null}
                            </td>

                            {/* Value / Input */}
                            <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                              {item.sensitive ? (
                                <div
                                  data-secret-readonly={item.key}
                                  style={{
                                    fontSize: "11.5px",
                                    color: "var(--text-muted, #94a3b8)",
                                    lineHeight: 1.4,
                                  }}
                                >
                                  <div
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: "5px",
                                      fontFamily: MONO_FONT,
                                      color: item.configured ? "#4ade80" : "#fbbf24",
                                    }}
                                  >
                                    <Lock size={11} aria-hidden="true" />
                                    <span>
                                      {item.configured
                                        ? "Configured on server (value hidden)"
                                        : "Not set on server"}
                                    </span>
                                  </div>
                                  <div
                                    style={{
                                      marginTop: "2px",
                                      fontSize: "10.5px",
                                      color: "#64748b",
                                    }}
                                  >
                                    Manage secrets in Settings → Secrets or server env.
                                  </div>
                                </div>
                              ) : item.editable ? (
                                <div
                                  style={{ display: "flex", flexDirection: "column", gap: "4px" }}
                                >
                                  <div
                                    style={{ display: "flex", alignItems: "center", gap: "6px" }}
                                  >
                                    <input
                                      type="text"
                                      aria-label={`Value for ${item.key}`}
                                      value={currentInputVal}
                                      placeholder={
                                        item.defaultValue
                                          ? `Default: ${item.defaultValue}`
                                          : "Enter value…"
                                      }
                                      onChange={(e) => {
                                        const val = e.target.value
                                        setDraftValues((prev) => ({
                                          ...prev,
                                          [item.key]: val,
                                        }))
                                      }}
                                      style={{
                                        flex: 1,
                                        minWidth: "150px",
                                        padding: "5px 8px",
                                        borderRadius: "5px",
                                        borderWidth: "1px",
                                        borderStyle: "solid",
                                        borderColor: isDirty
                                          ? "#38bdf8"
                                          : "var(--border-strong, #334155)",
                                        backgroundColor: "var(--surface-overlay, #0a101d)",
                                        color: "var(--text-primary, #f1f5f9)",
                                        fontFamily: MONO_FONT,
                                        fontVariantNumeric: "tabular-nums",
                                        fontSize: "11.5px",
                                      }}
                                    />
                                    {item.overridden ? (
                                      <button
                                        type="button"
                                        title={`Reset ${item.key} to default`}
                                        onClick={() => void onResetOverrides([item.key])}
                                        style={{
                                          padding: "5px 7px",
                                          borderRadius: "5px",
                                          borderWidth: "1px",
                                          borderStyle: "solid",
                                          borderColor: "var(--border-strong, #334155)",
                                          backgroundColor: "transparent",
                                          color: "var(--text-muted, #94a3b8)",
                                          cursor: "pointer",
                                        }}
                                      >
                                        <RotateCcw size={12} aria-hidden="true" />
                                      </button>
                                    ) : null}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: "10.5px",
                                      color: "#64748b",
                                      fontFamily: MONO_FONT,
                                    }}
                                  >
                                    default: {item.defaultValue || "(empty)"} · type:{" "}
                                    {item.valueType}
                                  </div>
                                </div>
                              ) : (
                                <div style={{ fontFamily: MONO_FONT, fontSize: "11.5px" }}>
                                  <div style={{ color: "var(--text-primary, #e2e8f0)" }}>
                                    {item.value ?? item.defaultValue}
                                  </div>
                                  <div
                                    style={{
                                      marginTop: "2px",
                                      fontSize: "10.5px",
                                      color: "#64748b",
                                    }}
                                  >
                                    Read-only invariant
                                  </div>
                                </div>
                              )}
                            </td>

                            {/* Component Traceability */}
                            <td style={{ padding: "10px 12px", verticalAlign: "top" }}>
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "5px",
                                }}
                              >
                                {item.consumers.map((consumer) => (
                                  <div
                                    key={`${item.key}-${consumer.component}`}
                                    style={{
                                      display: "flex",
                                      alignItems: "baseline",
                                      justifyContent: "space-between",
                                      gap: "6px",
                                      fontSize: "11px",
                                    }}
                                  >
                                    <div style={{ minWidth: 0 }}>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleJumpToComponentTrace(consumer.component)
                                        }
                                        title={consumer.usage}
                                        style={{
                                          background: "none",
                                          border: "none",
                                          padding: 0,
                                          color: "#38bdf8",
                                          fontFamily: MONO_FONT,
                                          fontSize: "11px",
                                          fontWeight: 600,
                                          cursor: "pointer",
                                          textAlign: "left",
                                        }}
                                      >
                                        {consumer.component}
                                      </button>
                                      <span style={{ color: "#64748b" }}> · {consumer.layer}</span>
                                      <div
                                        style={{
                                          color: "var(--text-muted, #94a3b8)",
                                          fontSize: "10.5px",
                                          lineHeight: 1.3,
                                        }}
                                      >
                                        {consumer.usage}
                                      </div>
                                    </div>
                                    {consumer.tabId &&
                                    onNavigateTab &&
                                    isDashboardTabId(consumer.tabId) ? (
                                      <button
                                        type="button"
                                        title={`Open ${consumer.tabId} tab`}
                                        onClick={() =>
                                          onNavigateTab(consumer.tabId as DashboardTabId)
                                        }
                                        style={{
                                          background: "none",
                                          border: "none",
                                          padding: "2px",
                                          color: "#94a3b8",
                                          cursor: "pointer",
                                          flexShrink: 0,
                                        }}
                                      >
                                        <ArrowUpRight size={12} aria-hidden="true" />
                                      </button>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
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

          {/* VIEW 2: COMPONENT TRACEABILITY MATRIX */}
          {viewMode === "components" ? (
            <div
              data-status-view="components"
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(240px, 320px) minmax(0, 1fr)",
                gap: "12px",
                alignItems: "start",
              }}
            >
              {/* Component Index */}
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
                    padding: "9px 10px",
                    borderBottomWidth: "1px",
                    borderBottomStyle: "solid",
                    borderBottomColor: "var(--border-default, #1e293b)",
                  }}
                >
                  <input
                    type="search"
                    value={componentSearch}
                    onChange={(e) => setComponentSearch(e.target.value)}
                    placeholder="Filter components…"
                    aria-label="Filter traced components"
                    style={{
                      width: "100%",
                      boxSizing: "border-box",
                      padding: "6px 9px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                      color: "var(--text-primary, #f1f5f9)",
                      fontSize: "11.5px",
                    }}
                  />
                </div>
                <div style={{ maxHeight: "480px", overflowY: "auto" }}>
                  {filteredComponents.map((comp, idx) => {
                    const active = activeComponent?.component === comp.component
                    return (
                      <button
                        key={comp.component}
                        type="button"
                        onClick={() => setSelectedComponentName(comp.component)}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "9px 12px",
                          border: "none",
                          borderTopWidth: idx === 0 ? "0px" : "1px",
                          borderTopStyle: "solid",
                          borderTopColor: "rgba(30, 41, 59, 0.7)",
                          backgroundColor: active ? "rgba(56, 189, 248, 0.12)" : "transparent",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontFamily: MONO_FONT,
                              fontSize: "12px",
                              fontWeight: active ? 700 : 600,
                              color: active ? "#38bdf8" : "var(--text-primary, #e2e8f0)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {comp.component}
                          </div>
                          <div
                            style={{
                              marginTop: "2px",
                              fontSize: "10.5px",
                              color: "#64748b",
                              fontFamily: MONO_FONT,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {comp.layer} · {comp.envCount} env · {comp.constantCount} const
                            {comp.secretCount > 0 ? ` · ${comp.secretCount} secret` : ""}
                          </div>
                        </div>
                        <span
                          style={{
                            fontFamily: MONO_FONT,
                            fontVariantNumeric: "tabular-nums",
                            fontSize: "12px",
                            fontWeight: 700,
                            color: active ? "#38bdf8" : "#94a3b8",
                          }}
                        >
                          {comp.itemCount}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Selected Component Trace Detail */}
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
                {activeComponent ? (
                  <>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "10px",
                        padding: "12px 14px",
                        borderBottomWidth: "1px",
                        borderBottomStyle: "solid",
                        borderBottomColor: "var(--border-default, #1e293b)",
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontFamily: MONO_FONT,
                            fontSize: "14px",
                            fontWeight: 700,
                            color: "var(--text-primary, #f8fafc)",
                          }}
                        >
                          {activeComponent.component}
                        </div>
                        <div style={{ marginTop: "2px", fontSize: "11.5px", color: "#94a3b8" }}>
                          Layer: {activeComponent.layer} · {activeComponent.itemCount} traced{" "}
                          {activeComponent.itemCount === 1 ? "dependency" : "dependencies"}
                        </div>
                      </div>
                      {activeComponent.tabId &&
                      onNavigateTab &&
                      isDashboardTabId(activeComponent.tabId) ? (
                        <button
                          type="button"
                          onClick={() => onNavigateTab(activeComponent.tabId as DashboardTabId)}
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
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span>Open Live Tab</span>
                          <ArrowUpRight size={13} aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>

                    <div>
                      {activeComponent.items.map((dep, idx) => {
                        const fullItem = snapshot.items.find((i) => i.key === dep.key)
                        const meta = fullItem ? statusDisplayMeta(fullItem) : null
                        return (
                          <div
                            key={`${activeComponent.component}-${dep.key}`}
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "10px",
                              padding: "10px 14px",
                              borderTopWidth: idx === 0 ? "0px" : "1px",
                              borderTopStyle: "solid",
                              borderTopColor: "rgba(30, 41, 59, 0.7)",
                            }}
                          >
                            <div style={{ minWidth: 0, flex: "1 1 280px" }}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "8px",
                                  flexWrap: "wrap",
                                }}
                              >
                                <span
                                  style={{
                                    fontFamily: MONO_FONT,
                                    fontWeight: 600,
                                    fontSize: "12px",
                                    color: "var(--text-primary, #f8fafc)",
                                  }}
                                >
                                  {dep.key}
                                </span>
                                <span style={{ fontSize: "11px", color: "#64748b" }}>
                                  {kindLabel(dep.kind)}
                                </span>
                                {meta ? (
                                  <span
                                    style={{
                                      fontSize: "11px",
                                      fontWeight: 600,
                                      color: meta.color,
                                    }}
                                  >
                                    · {meta.label}
                                  </span>
                                ) : null}
                              </div>
                              <div
                                style={{
                                  marginTop: "3px",
                                  fontSize: "11.5px",
                                  color: "var(--text-muted, #94a3b8)",
                                }}
                              >
                                {dep.usage}
                              </div>
                            </div>

                            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                              <span
                                style={{
                                  fontFamily: MONO_FONT,
                                  fontSize: "11.5px",
                                  color: dep.sensitive ? "#fbbf24" : "#cbd5e1",
                                }}
                              >
                                {dep.sensitive
                                  ? fullItem?.configured
                                    ? "Secret set (hidden)"
                                    : "Secret unset"
                                  : fullItem?.value || fullItem?.defaultValue || "(empty)"}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleJumpToKeyInRegistry(dep.key)}
                                style={{
                                  padding: "4px 9px",
                                  borderRadius: "5px",
                                  borderWidth: "1px",
                                  borderStyle: "solid",
                                  borderColor: "var(--border-strong, #334155)",
                                  backgroundColor: "transparent",
                                  color: "#38bdf8",
                                  fontSize: "11px",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                Inspect
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                ) : (
                  <div style={{ padding: "24px", color: "#64748b", fontSize: "12px" }}>
                    Select a component to inspect its traced constants and environment variables.
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {/* VIEW 3: SANITIZED .env.example TEMPLATE */}
          {viewMode === "env-example" ? (
            <div
              data-status-view="env-example"
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
                      fontFamily: MONO_FONT,
                      fontSize: "12.5px",
                      fontWeight: 700,
                      color: "var(--text-primary, #f8fafc)",
                    }}
                  >
                    .env.example (Sanitized Live Sync)
                  </div>
                  <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
                    Includes saved non-secret overrides. All secret keys remain blank placeholders.
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "8px",
                  }}
                >
                  <SyntaxTokenLegend compact />
                  <div
                    role="group"
                    aria-label="Template output format"
                    style={{
                      display: "inline-flex",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "var(--border-strong, #334155)",
                      overflow: "hidden",
                    }}
                  >
                    {(
                      [
                        { id: "env", label: ".env" },
                        { id: "yaml", label: "Bun.YAML" },
                      ] as const
                    ).map((fmt, idx) => {
                      const active = envPreviewFormat === fmt.id
                      return (
                        <button
                          key={fmt.id}
                          type="button"
                          data-env-preview-format={fmt.id}
                          aria-pressed={active}
                          onClick={() => setEnvPreviewFormat(fmt.id)}
                          style={{
                            padding: "4px 9px",
                            fontSize: "11px",
                            fontWeight: active ? 700 : 500,
                            border: "none",
                            borderLeftWidth: idx === 0 ? "0px" : "1px",
                            borderLeftStyle: "solid",
                            borderLeftColor: "var(--border-strong, #334155)",
                            backgroundColor: active ? "rgba(56, 189, 248, 0.16)" : "transparent",
                            color: active ? "#7dd3fc" : "#94a3b8",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {fmt.label}
                        </button>
                      )
                    })}
                  </div>
                  <CopyBunTerminalAnsiButton
                    text={
                      envPreviewFormat === "yaml" && envAsBunYaml
                        ? envAsBunYaml.yaml
                        : snapshot.envExampleText
                    }
                    format={envPreviewFormat === "yaml" ? "yaml" : "env"}
                    compact
                  />
                  <button
                    type="button"
                    onClick={() => void handleCopyEnvExample()}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                      padding: "6px 11px",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: copiedEnv ? "#4ade80" : "var(--border-strong, #334155)",
                      backgroundColor: "transparent",
                      color: copiedEnv ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {copiedEnv ? (
                      <Check size={12} aria-hidden="true" />
                    ) : (
                      <Copy size={12} aria-hidden="true" />
                    )}
                    <span>{copiedEnv ? "Copied" : "Copy .env.example"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadEnvExample}
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
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Download size={12} aria-hidden="true" />
                    <span>Download .env.example</span>
                  </button>
                </div>
              </div>
              <SyntaxHighlightedPre
                data-env-example-preview="true"
                text={
                  envPreviewFormat === "yaml" && envAsBunYaml
                    ? envAsBunYaml.yaml
                    : snapshot.envExampleText
                }
                format={envPreviewFormat === "yaml" ? "yaml" : "env"}
                style={{
                  margin: 0,
                  padding: "14px",
                  overflowX: "auto",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                  lineHeight: 1.6,
                  color: "var(--text-primary, #e2e8f0)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                }}
              />
            </div>
          ) : null}

          {/* VIEW 4: BUN .npmrc & bunfig.toml SUPPORT */}
          {viewMode === "npmrc" ? <NpmrcSupportSection summary={snapshot.npmrc} /> : null}

          {/* VIEW 5: BUN.YAML.PARSE & WORKSPACE YAML CONFIG */}
          {viewMode === "yaml" ? <YamlRuntimeSection summary={snapshot.yamlConfig} /> : null}

          {/* VIEW 6: BUN RUNTIME SURFACE (GLOBALS, BUN.* UTILITIES, CORE APIS & LIVE AUDIT) */}
          {viewMode === "runtime-surface" ? (
            <BunRuntimeSurfaceSection audit={snapshot.runtimeSurface} onRefresh={onRefresh} />
          ) : null}
        </>
      ) : null}
    </section>
  )
}
