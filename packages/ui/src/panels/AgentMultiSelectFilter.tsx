import { Check, ChevronDown, Filter, Search, X } from "lucide-react"
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"

export interface AgentFilterOption {
  readonly agentId: string
  readonly masterAgent: string
  readonly role: "sub-agent" | "master-forest"
  readonly handleUsd: number
  readonly customerCount: number
  readonly concPct: number | null
  readonly isProxyConduit: boolean
  readonly handleDelta24hPct?: number | null | undefined
}

export type AgentDropdownScope = "ALL" | "CONDUITS" | "SUB_AGENTS" | "MASTERS"

export interface AgentMultiSelectFilterProps {
  readonly options: readonly AgentFilterOption[]
  readonly selectedAgentIds: readonly string[]
  readonly onChange: (nextAgentIds: readonly string[]) => void
  readonly defaultOpen?: boolean | undefined
}

export interface F402TransactionHistoryQueryInput {
  readonly agentId: string
  readonly agentOwner?: string | undefined
  readonly customerId?: string | undefined
  readonly startDate?: string | undefined
  readonly endDate?: string | undefined
}

const TABULAR_NUMS: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
}

function formatCompactUsd(usd: number): string {
  const abs = Math.abs(usd)
  const sign = usd < 0 ? "-" : ""
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toLocaleString()}`
}

export function normalizeAgentIdList(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    const clean = raw.trim().toUpperCase()
    if (clean === "" || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/**
 * Parse Agent IDs from free-text input, comma/whitespace lists, or a pasted
 * Fantasy402 `getTransactionHistory` query string (`agentID=BILLY666&...&agentOwner=BILLY666`).
 */
export function parseAgentIdsFromInput(raw: string): readonly string[] {
  const trimmed = raw.trim()
  if (trimmed === "") return []

  const looksLikeQuery =
    trimmed.includes("=") && /(?:^|[?&])(agentID|agentOwner|agent|agents)=/i.test(trimmed)

  if (looksLikeQuery) {
    const queryPart = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : trimmed
    const params = new URLSearchParams(queryPart)
    const extracted: string[] = []
    for (const key of ["agentID", "agentId", "agents", "agent", "agentOwner"]) {
      const val = params.get(key)
      if (val && val.trim() !== "") {
        for (const piece of val.split(/[,\s]+/)) {
          if (piece.trim() !== "") extracted.push(piece)
        }
      }
    }
    return normalizeAgentIdList(extracted)
  }

  return normalizeAgentIdList(trimmed.split(/[,\s]+/))
}

/**
 * Build the Fantasy402 Manager `getTransactionHistory` query string for an
 * office conduit using a dedicated `URLSearchParams` instance.
 */
export function buildF402TransactionHistoryParams(
  input: F402TransactionHistoryQueryInput,
): URLSearchParams {
  const todayIso = new Date().toISOString().slice(0, 10)
  const agentId = input.agentId.trim().toUpperCase()
  const agentOwner = (input.agentOwner?.trim() || agentId).toUpperCase()
  const customerId = input.customerId?.trim().toUpperCase() ?? ""
  const startDate = input.startDate?.trim() || todayIso
  const endDate = input.endDate?.trim() || todayIso

  const params = new URLSearchParams()
  params.set("agentID", agentId)
  params.set("customerID", customerId)
  params.set("startDate", startDate)
  params.set("endDate", endDate)
  params.set("deposits", "checked")
  params.set("withdrawals", "checked")
  params.set("adjustments", "checked")
  params.set("transfers", "checked")
  params.set("fess", "checked")
  params.set("promotional", "checked")
  params.set("balances", "checked")
  params.set("distribution", "unchecked")
  params.set("freeFlag", "player")
  params.set("operation", "getTransactionHistory")
  params.set("RRO", "1")
  params.set("agentOwner", agentOwner)
  return params
}

/**
 * Filter available agent options by scope (`ALL`, `CONDUITS`, `SUB_AGENTS`, `MASTERS`)
 * and either plain text search or a pasted Fantasy402 `agentID=...` query string.
 */
export function filterAgentOptions(
  options: readonly AgentFilterOption[],
  query: string,
  scope: AgentDropdownScope = "ALL",
): readonly AgentFilterOption[] {
  const scoped = options.filter((opt) => {
    if (scope === "CONDUITS") return opt.isProxyConduit
    if (scope === "SUB_AGENTS") return opt.role === "sub-agent"
    if (scope === "MASTERS") return opt.role === "master-forest"
    return true
  })

  const trimmed = query.trim()
  if (trimmed === "") return scoped

  const isQueryString =
    trimmed.includes("=") && /(?:^|[?&])(agentID|agentOwner|agent|agents)=/i.test(trimmed)

  if (isQueryString) {
    const parsed = new Set(parseAgentIdsFromInput(trimmed))
    if (parsed.size === 0) return scoped
    return scoped.filter(
      (opt) => parsed.has(opt.agentId.toUpperCase()) || parsed.has(opt.masterAgent.toUpperCase()),
    )
  }

  const lower = trimmed.toLowerCase()
  return scoped.filter(
    (opt) =>
      opt.agentId.toLowerCase().includes(lower) ||
      opt.masterAgent.toLowerCase().includes(lower) ||
      (opt.isProxyConduit && "conduit".includes(lower)),
  )
}

export function AgentMultiSelectFilter({
  options,
  selectedAgentIds,
  onChange,
  defaultOpen = false,
}: AgentMultiSelectFilterProps): React.ReactElement {
  const [open, setOpen] = useState<boolean>(defaultOpen)
  const [searchText, setSearchText] = useState<string>("")
  const [scope, setScope] = useState<AgentDropdownScope>("ALL")
  const [activeIndex, setActiveIndex] = useState<number>(-1)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const normalizedSelected = useMemo(
    () => normalizeAgentIdList(selectedAgentIds),
    [selectedAgentIds],
  )
  const selectedSet = useMemo(() => new Set(normalizedSelected), [normalizedSelected])

  const filteredOptions = useMemo(
    () => filterAgentOptions(options, searchText, scope),
    [options, searchText, scope],
  )

  const scopeCounts = useMemo(() => {
    let conduits = 0
    let subAgents = 0
    let masters = 0
    for (const opt of options) {
      if (opt.isProxyConduit) conduits += 1
      if (opt.role === "sub-agent") subAgents += 1
      if (opt.role === "master-forest") masters += 1
    }
    return { total: options.length, conduits, subAgents, masters }
  }, [options])

  const parsedQueryAgents = useMemo(() => {
    const trimmed = searchText.trim()
    if (!trimmed.includes("=") || !/(?:^|[?&])(agentID|agentOwner|agent|agents)=/i.test(trimmed)) {
      return [] as readonly string[]
    }
    return parseAgentIdsFromInput(trimmed)
  }, [searchText])

  const conduitIds = useMemo(
    () => normalizeAgentIdList(options.filter((o) => o.isProxyConduit).map((o) => o.agentId)),
    [options],
  )

  useEffect(() => {
    setActiveIndex((prev) =>
      filteredOptions.length === 0 ? -1 : Math.min(prev, filteredOptions.length - 1),
    )
  }, [filteredOptions.length])

  useEffect(() => {
    if (!open) return
    searchInputRef.current?.focus()
    const handlePointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        containerRef.current.contains(event.target)
      ) {
        return
      }
      setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
      }
    }
    window.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [open])

  const toggleAgent = (agentId: string) => {
    const upper = agentId.trim().toUpperCase()
    if (selectedSet.has(upper)) {
      onChange(normalizedSelected.filter((id) => id !== upper))
    } else {
      onChange([...normalizedSelected, upper])
    }
  }

  const isolateSingleAgent = (agentId: string) => {
    const upper = agentId.trim().toUpperCase()
    onChange([upper])
    setSearchText("")
    setOpen(false)
  }

  const applyParsedOrDirect = (ids: readonly string[]) => {
    const merged = normalizeAgentIdList([...normalizedSelected, ...ids])
    onChange(merged)
    setSearchText("")
  }

  const activeOptionId =
    activeIndex >= 0 && activeIndex < filteredOptions.length
      ? `agent-opt-${filteredOptions[activeIndex]!.agentId}`
      : undefined

  const triggerLabel =
    normalizedSelected.length === 0
      ? `Agent ID: All (${options.length})`
      : normalizedSelected.length === 1
        ? `Agent ID: ${normalizedSelected[0]}`
        : `Agent IDs: ${normalizedSelected.length} selected`

  return (
    <div
      ref={containerRef}
      data-agent-multiselect="true"
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        type="button"
        data-agent-filter-trigger="true"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "7px",
          padding: "7px 12px",
          borderRadius: "7px",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
          backgroundColor: normalizedSelected.length > 0 ? "rgba(56, 189, 248, 0.14)" : "#0f172a",
          border: normalizedSelected.length > 0 ? "1px solid #38bdf8" : "1px solid #334155",
          color: normalizedSelected.length > 0 ? "#7dd3fc" : "#e2e8f0",
          ...TABULAR_NUMS,
        }}
      >
        <Filter size={13} aria-hidden="true" />
        <span>{triggerLabel}</span>
        <ChevronDown
          size={13}
          aria-hidden="true"
          style={{
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 150ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Filter Downlines by Agent ID"
          data-agent-filter-popover="true"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 60,
            width: "min(410px, 92vw)",
            backgroundColor: "#0f172a",
            border: "1px solid #334155",
            borderRadius: "8px",
            boxShadow: "0 14px 32px rgba(2, 6, 23, 0.45)",
            padding: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          {/* Search Input with Arrow-Key Navigation */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 8px",
              borderRadius: "6px",
              backgroundColor: "#0b1220",
              border: "1px solid #334155",
            }}
          >
            <Search size={13} style={{ color: "#64748b", flexShrink: 0 }} aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              data-agent-filter-search="true"
              value={searchText}
              aria-activedescendant={activeOptionId}
              onChange={(e) => {
                setSearchText(e.target.value)
                setActiveIndex(0)
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  if (filteredOptions.length > 0) {
                    setActiveIndex((prev) => (prev < filteredOptions.length - 1 ? prev + 1 : 0))
                  }
                  return
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault()
                  if (filteredOptions.length > 0) {
                    setActiveIndex((prev) => (prev > 0 ? prev - 1 : filteredOptions.length - 1))
                  }
                  return
                }
                if (e.key === "Enter") {
                  e.preventDefault()
                  if (parsedQueryAgents.length > 0) {
                    applyParsedOrDirect(parsedQueryAgents)
                  } else if (activeIndex >= 0 && activeIndex < filteredOptions.length) {
                    toggleAgent(filteredOptions[activeIndex]!.agentId)
                  } else if (filteredOptions.length === 1) {
                    toggleAgent(filteredOptions[0]!.agentId)
                  } else if (searchText.trim() !== "") {
                    const direct = parseAgentIdsFromInput(searchText)
                    if (direct.length > 0) applyParsedOrDirect(direct)
                  }
                }
              }}
              placeholder="Search Agent ID, office conduit, or paste agentID=..."
              aria-label="Search Agent IDs"
              style={{
                flex: 1,
                minWidth: 0,
                background: "transparent",
                border: "none",
                outline: "none",
                color: "#f1f5f9",
                fontSize: "12px",
              }}
            />
            {searchText !== "" && (
              <button
                type="button"
                onClick={() => {
                  setSearchText("")
                  setActiveIndex(-1)
                }}
                aria-label="Clear agent search"
                style={{
                  background: "none",
                  border: "none",
                  color: "#64748b",
                  cursor: "pointer",
                  padding: "2px",
                  display: "inline-flex",
                }}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Scope Tabs for Fast Office Conduit Navigation */}
          <div
            role="group"
            aria-label="Filter dropdown options by agent role"
            data-agent-role-filter="true"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "3px",
              padding: "2px",
              borderRadius: "6px",
              backgroundColor: "#0b1220",
              border: "1px solid #1e293b",
            }}
          >
            {(
              [
                { id: "ALL", label: `All (${scopeCounts.total})` },
                { id: "CONDUITS", label: `Conduits (${scopeCounts.conduits})` },
                {
                  id: "SUB_AGENTS",
                  label: `Sub-Agents (${scopeCounts.subAgents})`,
                },
                { id: "MASTERS", label: `Masters (${scopeCounts.masters})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                data-agent-scope-tab={tab.id}
                onClick={() => {
                  setScope(tab.id)
                  setActiveIndex(-1)
                }}
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  borderRadius: "4px",
                  border: "none",
                  fontSize: "10px",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  backgroundColor: scope === tab.id ? "rgba(56, 189, 248, 0.18)" : "transparent",
                  color: scope === tab.id ? "#7dd3fc" : "#94a3b8",
                  ...TABULAR_NUMS,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Smart Fantasy402 Query Paste Banner */}
          {parsedQueryAgents.length > 0 && (
            <div
              data-agent-query-paste-hint="true"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                padding: "6px 8px",
                borderRadius: "6px",
                backgroundColor: "rgba(56, 189, 248, 0.12)",
                border: "1px solid rgba(56, 189, 248, 0.35)",
                fontSize: "11px",
                color: "#7dd3fc",
              }}
            >
              <span>
                Detected from query: <strong>{parsedQueryAgents.join(", ")}</strong>
              </span>
              <button
                type="button"
                onClick={() => applyParsedOrDirect(parsedQueryAgents)}
                style={{
                  padding: "3px 8px",
                  borderRadius: "5px",
                  border: "1px solid #38bdf8",
                  backgroundColor: "rgba(56, 189, 248, 0.2)",
                  color: "#e0f2fe",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                Apply
              </button>
            </div>
          )}

          {/* Quick Selection Controls */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "6px",
              paddingBottom: "6px",
              borderBottom: "1px solid #1e293b",
              fontSize: "11px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                data-agent-select-shown="true"
                onClick={() =>
                  onChange(
                    normalizeAgentIdList([
                      ...normalizedSelected,
                      ...filteredOptions.map((o) => o.agentId),
                    ]),
                  )
                }
                disabled={filteredOptions.length === 0}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "#38bdf8",
                  fontWeight: 600,
                  fontSize: "11px",
                  cursor: filteredOptions.length === 0 ? "not-allowed" : "pointer",
                  opacity: filteredOptions.length === 0 ? 0.45 : 1,
                }}
              >
                Select Shown ({filteredOptions.length})
              </button>
              {conduitIds.length > 0 && (
                <button
                  type="button"
                  data-agent-select-conduits="true"
                  onClick={() => onChange(conduitIds)}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "#f87171",
                    fontWeight: 600,
                    fontSize: "11px",
                    cursor: "pointer",
                  }}
                >
                  Conduits Only ({conduitIds.length})
                </button>
              )}
            </div>
            <button
              type="button"
              data-agent-clear-all="true"
              onClick={() => onChange([])}
              disabled={normalizedSelected.length === 0}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "#94a3b8",
                fontWeight: 600,
                fontSize: "11px",
                cursor: normalizedSelected.length === 0 ? "not-allowed" : "pointer",
                opacity: normalizedSelected.length === 0 ? 0.45 : 1,
              }}
            >
              Clear
            </button>
          </div>

          {/* Scrollable Checkbox List */}
          <div
            role="listbox"
            aria-multiselectable="true"
            style={{
              maxHeight: "260px",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
            }}
          >
            {filteredOptions.length === 0 ? (
              <div
                style={{
                  padding: "12px 8px",
                  fontSize: "12px",
                  color: "#94a3b8",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <span>No matching Agent IDs in the current 30d window.</span>
                {searchText.trim() !== "" && (
                  <button
                    type="button"
                    onClick={() => applyParsedOrDirect(parseAgentIdsFromInput(searchText))}
                    style={{
                      alignSelf: "flex-start",
                      padding: "4px 8px",
                      borderRadius: "5px",
                      border: "1px solid #38bdf8",
                      backgroundColor: "rgba(56, 189, 248, 0.14)",
                      color: "#7dd3fc",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Filter by &ldquo;
                    {parseAgentIdsFromInput(searchText).join(", ")}&rdquo;
                  </button>
                )}
              </div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const checked = selectedSet.has(opt.agentId.toUpperCase())
                const highlighted = idx === activeIndex
                return (
                  <div
                    key={`${opt.role}-${opt.agentId}`}
                    id={`agent-opt-${opt.agentId}`}
                    role="option"
                    aria-selected={checked}
                    data-agent-option={opt.agentId}
                    onMouseEnter={() => setActiveIndex(idx)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "6px",
                      padding: "6px 8px",
                      borderRadius: "6px",
                      border: checked
                        ? "1px solid rgba(56, 189, 248, 0.45)"
                        : highlighted
                          ? "1px solid #334155"
                          : "1px solid transparent",
                      backgroundColor: checked
                        ? "rgba(56, 189, 248, 0.12)"
                        : highlighted
                          ? "rgba(30, 41, 59, 0.65)"
                          : "transparent",
                      ...TABULAR_NUMS,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleAgent(opt.agentId)}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "8px",
                        background: "none",
                        border: "none",
                        padding: 0,
                        textAlign: "left",
                        color: "#e2e8f0",
                        cursor: "pointer",
                        fontSize: "12px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "8px",
                          minWidth: 0,
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: "15px",
                            height: "15px",
                            borderRadius: "4px",
                            border: checked ? "1px solid #38bdf8" : "1px solid #475569",
                            backgroundColor: checked ? "#38bdf8" : "transparent",
                            color: "#0f172a",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}
                        >
                          {checked && <Check size={11} strokeWidth={3} />}
                        </span>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            minWidth: 0,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 700,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {opt.agentId}
                            {opt.isProxyConduit && (
                              <span
                                style={{
                                  marginLeft: "6px",
                                  fontSize: "10px",
                                  color: "#f87171",
                                  fontWeight: 700,
                                }}
                              >
                                · CONDUIT
                              </span>
                            )}
                          </span>
                          <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                            {opt.role === "master-forest"
                              ? "Master Forest"
                              : `Master: ${opt.masterAgent}`}{" "}
                            · {opt.customerCount} acct
                            {opt.customerCount === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>

                      <div
                        style={{
                          textAlign: "right",
                          flexShrink: 0,
                          fontSize: "11px",
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{formatCompactUsd(opt.handleUsd)}</div>
                        <div
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "flex-end",
                            gap: "5px",
                            color: opt.isProxyConduit ? "#f87171" : "#94a3b8",
                          }}
                        >
                          {opt.concPct !== null && <span>{opt.concPct.toFixed(0)}% conc</span>}
                          {typeof opt.handleDelta24hPct === "number" && (
                            <span
                              data-agent-option-trend={
                                opt.handleDelta24hPct > 0.05
                                  ? "up"
                                  : opt.handleDelta24hPct < -0.05
                                    ? "down"
                                    : "flat"
                              }
                              title={`24h performance shift: ${opt.handleDelta24hPct > 0 ? "+" : ""}${opt.handleDelta24hPct.toFixed(1)}%`}
                              style={{
                                fontWeight: 600,
                                color:
                                  opt.handleDelta24hPct > 0.05
                                    ? "#4ade80"
                                    : opt.handleDelta24hPct < -0.05
                                      ? "#f87171"
                                      : "#94a3b8",
                              }}
                            >
                              {opt.handleDelta24hPct > 0.05
                                ? "↑"
                                : opt.handleDelta24hPct < -0.05
                                  ? "↓"
                                  : "→"}
                              {opt.handleDelta24hPct > 0 ? "+" : ""}
                              {opt.handleDelta24hPct.toFixed(1)}%
                            </span>
                          )}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      data-agent-only={opt.agentId}
                      onClick={(e) => {
                        e.stopPropagation()
                        isolateSingleAgent(opt.agentId)
                      }}
                      title={`Jump directly to ${opt.agentId} only`}
                      style={{
                        padding: "3px 6px",
                        borderRadius: "4px",
                        border: "1px solid #334155",
                        backgroundColor: "#0b1220",
                        color: "#94a3b8",
                        fontSize: "10px",
                        fontWeight: 600,
                        cursor: "pointer",
                        flexShrink: 0,
                        whiteSpace: "nowrap",
                      }}
                    >
                      Only
                    </button>
                  </div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
