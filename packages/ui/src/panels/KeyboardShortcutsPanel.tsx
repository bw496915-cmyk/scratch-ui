import { ArrowUpRight, ChevronDown, ChevronRight, Keyboard } from "lucide-react"
import type React from "react"
import { useMemo, useState } from "react"

import type { DashboardTabId } from "../types.ts"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

export type KeyboardShortcutScope = "navigation" | "global" | "terminal"

export interface KeyboardShortcutEntry {
  readonly id: string
  readonly keys: readonly string[]
  readonly altKeys?: readonly string[] | undefined
  readonly label: string
  readonly description: string
  readonly scope: KeyboardShortcutScope
  readonly tabId?: DashboardTabId | undefined
}

/**
 * Canonical list of live keyboard shortcuts wired in `App.tsx`, `GlobalHeaderSearch.tsx`,
 * `TerminalTabPanel.tsx`, and modal/drawer listeners.
 */
export const GLOBAL_KEYBOARD_SHORTCUTS: readonly KeyboardShortcutEntry[] = [
  {
    id: "tab-customers",
    keys: ["Ctrl", "1"],
    label: "Profiles",
    description: "Sharp originator profiling & risk sizing",
    scope: "navigation",
    tabId: "customers",
  },
  {
    id: "tab-surveillance",
    keys: ["Ctrl", "2"],
    label: "Telemetry",
    description: "Bun.dns telemetry, API usage & risk brief",
    scope: "navigation",
    tabId: "surveillance",
  },
  {
    id: "tab-terminal",
    keys: ["Ctrl", "3"],
    label: "Terminal (PTY)",
    description: "Open interactive PTY & focus prompt",
    scope: "navigation",
    tabId: "terminal",
  },
  {
    id: "tab-rankings",
    keys: ["Ctrl", "4"],
    label: "Downlines",
    description: "Sub-agent handle rankings & conduits",
    scope: "navigation",
    tabId: "rankings",
  },
  {
    id: "tab-wagers",
    keys: ["Ctrl", "5"],
    label: "Live Wagers",
    description: "Real-time incoming wager tape & CLV",
    scope: "navigation",
    tabId: "wagers",
  },
  {
    id: "tab-alerts",
    keys: ["Ctrl", "6"],
    label: "DLQ & Alerts",
    description: "Alert delivery queue & dead-letter replay",
    scope: "navigation",
    tabId: "alerts",
  },
  {
    id: "tab-shadow",
    keys: ["Ctrl", "7"],
    label: "Shadow Pricing",
    description: "Counterfactual pricing & hold-floor cube",
    scope: "navigation",
    tabId: "shadow",
  },
  {
    id: "tab-bet-ticker",
    keys: ["Ctrl", "8"],
    label: "Bet Ticker",
    description: "Portal bet-ticker wire stream & snapshots",
    scope: "navigation",
    tabId: "bet-ticker",
  },
  {
    id: "tab-r2",
    keys: ["Ctrl", "9"],
    label: "R2 Pipeline",
    description: "Cloudflare R2 sink freshness & provenance",
    scope: "navigation",
    tabId: "r2",
  },
  {
    id: "tab-assets",
    keys: ["Ctrl", "0"],
    label: "Bun Assets",
    description: "Served dashboard image dimensions & metadata",
    scope: "navigation",
    tabId: "assets",
  },
  {
    id: "global-pty-toggle",
    keys: ["Ctrl", "`"],
    altKeys: ["Ctrl/⌘", "K"],
    label: "Quick Terminal Focus",
    description: "Jump directly to Terminal PTY and focus command input",
    scope: "global",
    tabId: "terminal",
  },
  {
    id: "global-search",
    keys: ["/"],
    label: "Focus Global Search",
    description: "Focus header search across customers, agents & tickets",
    scope: "global",
  },
  {
    id: "global-escape",
    keys: ["Esc"],
    label: "Dismiss Overlay",
    description: "Close active modal, inspector drawer, or dropdown menu",
    scope: "global",
  },
  {
    id: "terminal-clear",
    keys: ["Ctrl", "L"],
    label: "Clear Terminal",
    description: "Clear PTY scrollback buffer when Terminal is focused",
    scope: "terminal",
    tabId: "terminal",
  },
  {
    id: "terminal-autocomplete",
    keys: ["Tab"],
    altKeys: ["Ctrl", "Enter"],
    label: "Autocomplete / Run",
    description: "Accept command suggestion or execute in PTY",
    scope: "terminal",
    tabId: "terminal",
  },
]

export interface KeyboardShortcutsPanelProps {
  readonly onNavigateTab?: ((tab: DashboardTabId) => void) | undefined
  readonly defaultCollapsed?: boolean | undefined
  readonly initialScope?: "all" | KeyboardShortcutScope | undefined
}

function KeyCapCombo({ keys }: { readonly keys: readonly string[] }): React.ReactElement {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "3px",
        flexShrink: 0,
      }}
    >
      {keys.map((key, idx) => (
        <span
          key={`${key}-${idx}`}
          style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}
        >
          {idx > 0 ? (
            <span
              aria-hidden="true"
              style={{
                fontSize: "10px",
                color: "#64748b",
                fontFamily: MONO_FONT,
              }}
            >
              +
            </span>
          ) : null}
          <kbd
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "20px",
              height: "20px",
              padding: "0 5px",
              borderRadius: "4px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-strong, #334155)",
              backgroundColor: "var(--surface-overlay, #0a101d)",
              color: "var(--text-primary, #f1f5f9)",
              fontFamily: MONO_FONT,
              fontVariantNumeric: "tabular-nums",
              fontSize: "11px",
              fontWeight: 600,
              lineHeight: 1,
              whiteSpace: "nowrap",
            }}
          >
            {key}
          </kbd>
        </span>
      ))}
    </span>
  )
}

export function KeyboardShortcutsPanel({
  onNavigateTab,
  defaultCollapsed = false,
  initialScope = "all",
}: KeyboardShortcutsPanelProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed)
  const [scopeFilter, setScopeFilter] = useState<"all" | KeyboardShortcutScope>(initialScope)

  const visibleShortcuts = useMemo(() => {
    if (scopeFilter === "all") return GLOBAL_KEYBOARD_SHORTCUTS
    return GLOBAL_KEYBOARD_SHORTCUTS.filter((item) => item.scope === scopeFilter)
  }, [scopeFilter])

  const navCount = useMemo(
    () => GLOBAL_KEYBOARD_SHORTCUTS.filter((s) => s.scope === "navigation").length,
    [],
  )
  const globalCount = useMemo(
    () => GLOBAL_KEYBOARD_SHORTCUTS.filter((s) => s.scope !== "navigation").length,
    [],
  )

  return (
    <div
      data-keyboard-shortcuts-panel="true"
      role="region"
      aria-label="Keyboard Shortcuts"
      style={{
        borderRadius: "8px",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "var(--border-default, #1e293b)",
        backgroundColor: "var(--surface-panel, #0f172a)",
        overflow: "hidden",
      }}
    >
      {/* Compact Header Bar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "9px 14px",
          borderBottomWidth: collapsed ? "0px" : "1px",
          borderBottomStyle: "solid",
          borderBottomColor: "var(--border-default, #1e293b)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            minWidth: 0,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            aria-expanded={!collapsed}
            data-shortcuts-toggle="true"
            onClick={() => setCollapsed((prev) => !prev)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: 0,
              border: "none",
              background: "none",
              color: "var(--text-primary, #f8fafc)",
              fontSize: "12.5px",
              fontWeight: 700,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {collapsed ? (
              <ChevronRight size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
            <Keyboard size={14} aria-hidden="true" style={{ color: "#38bdf8" }} />
            <span>Keyboard Shortcuts</span>
          </button>

          <span
            style={{
              fontSize: "11.5px",
              color: "var(--text-muted, #94a3b8)",
              fontFamily: MONO_FONT,
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
            }}
          >
            {navCount} tab hotkeys · {globalCount} global &amp; PTY
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          {!collapsed ? (
            <div
              role="group"
              aria-label="Filter keyboard shortcuts by scope"
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
                  ["navigation", "Tabs (Ctrl+1–0)"],
                  ["global", "Global"],
                  ["terminal", "PTY"],
                ] as const
              ).map(([scope, label], idx) => {
                const active = scopeFilter === scope
                return (
                  <button
                    key={scope}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setScopeFilter(scope)}
                    style={{
                      padding: "4px 8px",
                      fontSize: "11px",
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
                    {label}
                  </button>
                )
              })}
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => setCollapsed((prev) => !prev)}
            style={{
              padding: "4px 8px",
              borderRadius: "5px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-strong, #334155)",
              backgroundColor: "transparent",
              color: "var(--text-muted, #94a3b8)",
              fontSize: "11px",
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {collapsed ? "Show" : "Hide"}
          </button>
        </div>
      </div>

      {/* Compact Multi-Column Keymap Grid */}
      {!collapsed ? (
        <div
          data-keyboard-shortcuts-grid="true"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(235px, 1fr))",
            gap: "1px",
            backgroundColor: "var(--border-default, #1e293b)",
          }}
        >
          {visibleShortcuts.map((shortcut) => {
            const canJump = Boolean(shortcut.tabId && onNavigateTab)
            const content = (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "5px",
                    flexShrink: 0,
                  }}
                >
                  <KeyCapCombo keys={shortcut.keys} />
                  {shortcut.altKeys ? (
                    <>
                      <span
                        aria-hidden="true"
                        style={{
                          fontSize: "10px",
                          color: "#64748b",
                        }}
                      >
                        /
                      </span>
                      <KeyCapCombo keys={shortcut.altKeys} />
                    </>
                  ) : null}
                </div>

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "4px",
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "var(--text-primary, #e2e8f0)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {shortcut.label}
                    </span>
                    {canJump ? (
                      <ArrowUpRight
                        size={11}
                        aria-hidden="true"
                        style={{ color: "#64748b", flexShrink: 0 }}
                      />
                    ) : null}
                  </div>
                  <div
                    style={{
                      fontSize: "10.5px",
                      color: "var(--text-muted, #94a3b8)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={shortcut.description}
                  >
                    {shortcut.description}
                  </div>
                </div>
              </>
            )

            if (canJump && shortcut.tabId && onNavigateTab) {
              return (
                <button
                  key={shortcut.id}
                  type="button"
                  data-shortcut-id={shortcut.id}
                  title={`${shortcut.label} — ${shortcut.description} (Click to open)`}
                  onClick={() => onNavigateTab(shortcut.tabId!)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px 12px",
                    border: "none",
                    backgroundColor: "var(--surface-panel, #0f172a)",
                    textAlign: "left",
                    cursor: "pointer",
                    minWidth: 0,
                  }}
                >
                  {content}
                </button>
              )
            }

            return (
              <div
                key={shortcut.id}
                data-shortcut-id={shortcut.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  padding: "8px 12px",
                  backgroundColor: "var(--surface-panel, #0f172a)",
                  minWidth: 0,
                }}
              >
                {content}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
