import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Search, X } from "lucide-react"
import type { BetTickerTicketRow, LiveWager, ShowcaseCustomer } from "../types.ts"

export type GlobalSearchScope = "all" | "wagers" | "customers" | "tickers"

export interface GlobalHeaderSearchProps {
  readonly query: string
  readonly onQueryChange: (value: string) => void
  readonly wagers: readonly LiveWager[]
  readonly customers: readonly ShowcaseCustomer[]
  readonly tickers: readonly BetTickerTicketRow[]
  readonly onSelectWager: (wager: LiveWager, query: string) => void
  readonly onSelectCustomer: (customer: ShowcaseCustomer) => void
  readonly onSelectTicker: (ticket: BetTickerTicketRow) => void
  readonly onViewAllInTab: (tab: "wagers" | "customers" | "bet-ticker", query: string) => void
}

type SearchResultItem =
  | { readonly kind: "wager"; readonly id: string; readonly item: LiveWager }
  | {
      readonly kind: "customer"
      readonly id: string
      readonly item: ShowcaseCustomer
    }
  | {
      readonly kind: "ticker"
      readonly id: string
      readonly item: BetTickerTicketRow
    }

const MAX_RESULTS_PER_GROUP = 6
const MAX_RESULTS_SCOPED = 12

function formatUsdWhole(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function tierTone(tier: string): { fg: string; bg: string; border: string } {
  const upper = tier.toUpperCase()
  if (upper.includes("CRITICAL") || upper.includes("TIER_1")) {
    return {
      fg: "#fca5a5",
      bg: "rgba(239, 68, 68, 0.16)",
      border: "rgba(239, 68, 68, 0.45)",
    }
  }
  if (upper.includes("STEAM") || upper.includes("TIER_2") || upper.includes("SYNDICATE")) {
    return {
      fg: "#fcd34d",
      bg: "rgba(245, 158, 11, 0.16)",
      border: "rgba(245, 158, 11, 0.45)",
    }
  }
  if (upper.includes("SHARP") || upper.includes("TIER_3")) {
    return {
      fg: "#7dd3fc",
      bg: "rgba(56, 189, 248, 0.16)",
      border: "rgba(56, 189, 248, 0.4)",
    }
  }
  return {
    fg: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.12)",
    border: "rgba(148, 163, 184, 0.3)",
  }
}

export function GlobalHeaderSearch({
  query,
  onQueryChange,
  wagers,
  customers,
  tickers,
  onSelectWager,
  onSelectCustomer,
  onSelectTicker,
  onViewAllInTab,
}: GlobalHeaderSearchProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [scope, setScope] = useState<GlobalSearchScope>("all")
  const [activeIndex, setActiveIndex] = useState(0)

  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const normalizedQuery = query.trim().toLowerCase()

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
        setFocused(false)
      }
    }
    const handleShortcut = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) {
        return
      }
      e.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
      setOpen(true)
    }
    document.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("keydown", handleShortcut)
    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("keydown", handleShortcut)
    }
  }, [])

  const matchedWagers = useMemo(() => {
    if (!normalizedQuery) return []
    return wagers.filter((w) => {
      const hay =
        `${w.ticketId} ${w.customerId} ${w.agentId} ${w.masterAgent} ${w.sport} ${w.subSport ?? ""} ${w.event} ${w.selection} ${w.betType} ${w.alertTier} ${w.ticketWriter ?? ""}`.toLowerCase()
      return hay.includes(normalizedQuery)
    })
  }, [wagers, normalizedQuery])

  const matchedCustomers = useMemo(() => {
    if (!normalizedQuery) return []
    return customers.filter((c) => {
      const hay =
        `${c.id} ${c.name} ${c.agentId} ${c.masterAgent} ${c.specialization} ${c.tier} ${c.tierLabel ?? ""} ${c.timingArchetype}`.toLowerCase()
      return hay.includes(normalizedQuery)
    })
  }, [customers, normalizedQuery])

  const matchedTickers = useMemo(() => {
    if (!normalizedQuery) return []
    return tickers.filter((t) => {
      if (t.isSentinelNoise && !t.ticketId.toLowerCase().includes(normalizedQuery)) {
        return false
      }
      const hay =
        `${t.ticketId} ${t.wagerNumber} ${t.customerId} ${t.agentId} ${t.masterAgent} ${t.sport} ${t.selection} ${t.shortDesc} ${t.ticketWriter} ${t.wagerTypeLabel}`.toLowerCase()
      return hay.includes(normalizedQuery)
    })
  }, [tickers, normalizedQuery])

  const perGroupCap = scope === "all" ? MAX_RESULTS_PER_GROUP : MAX_RESULTS_SCOPED

  const visibleCustomers =
    scope === "all" || scope === "customers" ? matchedCustomers.slice(0, perGroupCap) : []
  const visibleWagers =
    scope === "all" || scope === "wagers" ? matchedWagers.slice(0, perGroupCap) : []
  const visibleTickers =
    scope === "all" || scope === "tickers" ? matchedTickers.slice(0, perGroupCap) : []

  const flatResults = useMemo<SearchResultItem[]>(() => {
    const items: SearchResultItem[] = []
    for (const c of visibleCustomers) {
      items.push({ kind: "customer", id: `c:${c.id}`, item: c })
    }
    for (const w of visibleWagers) {
      items.push({ kind: "wager", id: `w:${w.ticketId}`, item: w })
    }
    for (const t of visibleTickers) {
      items.push({
        kind: "ticker",
        id: `t:${t.ticketId}:${t.wagerNumber}`,
        item: t,
      })
    }
    return items
  }, [visibleCustomers, visibleWagers, visibleTickers])

  useEffect(() => {
    setActiveIndex(0)
  }, [normalizedQuery, scope])

  const totalMatches = matchedCustomers.length + matchedWagers.length + matchedTickers.length

  const activateItem = (entry: SearchResultItem) => {
    setOpen(false)
    if (entry.kind === "customer") {
      onSelectCustomer(entry.item)
    } else if (entry.kind === "wager") {
      onSelectWager(entry.item, query.trim())
    } else {
      onSelectTicker(entry.item)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      if (open) {
        setOpen(false)
      } else if (query) {
        onQueryChange("")
      } else {
        inputRef.current?.blur()
      }
      return
    }
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true)
      return
    }
    if (e.key === "ArrowDown" && flatResults.length > 0) {
      e.preventDefault()
      setActiveIndex((prev) => (prev + 1) % flatResults.length)
      return
    }
    if (e.key === "ArrowUp" && flatResults.length > 0) {
      e.preventDefault()
      setActiveIndex((prev) => (prev - 1 + flatResults.length) % flatResults.length)
      return
    }
    if (e.key === "Enter") {
      if (flatResults.length > 0 && flatResults[activeIndex]) {
        e.preventDefault()
        activateItem(flatResults[activeIndex]!)
      } else if (normalizedQuery) {
        e.preventDefault()
        setOpen(false)
        const targetTab =
          scope === "customers" ? "customers" : scope === "tickers" ? "bet-ticker" : "wagers"
        onViewAllInTab(targetTab, query.trim())
      }
    }
  }

  let runningIdx = 0

  return (
    <div
      ref={rootRef}
      data-global-header-search="true"
      style={{
        position: "relative",
        flex: "1 1 280px",
        minWidth: 0,
        maxWidth: "420px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 10px",
          borderRadius: "6px",
          backgroundColor: "#070b14",
          border: focused
            ? "1px solid #38bdf8"
            : normalizedQuery
              ? "1px solid rgba(56, 189, 248, 0.5)"
              : "1px solid #1e293b",
          boxShadow: focused ? "0 0 0 2px rgba(56, 189, 248, 0.16)" : "none",
          transition: "border-color 0.15s ease, box-shadow 0.15s ease",
        }}
      >
        <Search
          size={14}
          style={{
            color: focused || normalizedQuery ? "#38bdf8" : "#64748b",
            flexShrink: 0,
          }}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label="Global lookup across wagers, customers, and bet tickers"
          aria-expanded={open}
          aria-autocomplete="list"
          data-global-search-input="true"
          value={query}
          onChange={(e) => {
            onQueryChange(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setFocused(true)
            setOpen(true)
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={handleKeyDown}
          placeholder="Search wagers, customers, tickers..."
          style={{
            flex: 1,
            minWidth: 0,
            backgroundColor: "transparent",
            border: "none",
            outline: "none",
            color: "#f1f5f9",
            fontSize: "12px",
            fontFamily: "inherit",
            padding: 0,
          }}
        />
        {normalizedQuery ? (
          <>
            <span
              style={{
                fontSize: "10px",
                fontWeight: 700,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                color: totalMatches > 0 ? "#38bdf8" : "#94a3b8",
                backgroundColor: "rgba(30, 41, 59, 0.9)",
                padding: "1px 6px",
                borderRadius: "4px",
                whiteSpace: "nowrap",
              }}
              title={`${totalMatches} matches across customers, wagers, and bet tickers`}
            >
              {totalMatches}
            </span>
            <button
              type="button"
              onClick={() => {
                onQueryChange("")
                inputRef.current?.focus()
              }}
              aria-label="Clear global search"
              title="Clear search"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: "none",
                border: "none",
                padding: "2px",
                color: "#94a3b8",
                cursor: "pointer",
              }}
            >
              <X size={13} />
            </button>
          </>
        ) : (
          <kbd
            style={{
              padding: "1px 5px",
              borderRadius: "4px",
              fontSize: "10px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              fontWeight: 600,
              color: "#94a3b8",
              backgroundColor: "#1e293b",
              border: "1px solid #334155",
              lineHeight: 1.4,
            }}
            title="Press / to focus global search"
          >
            /
          </kbd>
        )}
      </div>

      {open && (
        <div
          role="listbox"
          aria-label="Global lookup results"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            left: 0,
            minWidth: 0,
            maxHeight: "460px",
            overflowY: "auto",
            backgroundColor: "#0b1120",
            border: "1px solid #334155",
            borderRadius: "8px",
            boxShadow: "0 16px 40px rgba(2, 6, 23, 0.78)",
            zIndex: 1000,
          }}
        >
          {/* Scope filter header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: "6px",
              padding: "8px 10px",
              borderBottom: "1px solid #1e293b",
              backgroundColor: "#0d1527",
              position: "sticky",
              top: 0,
              zIndex: 1,
            }}
          >
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {(
                [
                  { id: "all", label: "All", count: totalMatches },
                  {
                    id: "customers",
                    label: "Customers",
                    count: matchedCustomers.length,
                  },
                  {
                    id: "wagers",
                    label: "Wagers",
                    count: matchedWagers.length,
                  },
                  {
                    id: "tickers",
                    label: "Tickers",
                    count: matchedTickers.length,
                  },
                ] as const
              ).map((tab) => {
                const active = scope === tab.id
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setScope(tab.id)}
                    style={{
                      padding: "3px 7px",
                      borderRadius: "5px",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                      border: active ? "1px solid #38bdf8" : "1px solid #1e293b",
                      backgroundColor: active ? "rgba(56, 189, 248, 0.16)" : "#070b14",
                      color: active ? "#7dd3fc" : "#94a3b8",
                    }}
                  >
                    {tab.label}
                    {normalizedQuery ? ` (${tab.count})` : ""}
                  </button>
                )
              })}
            </div>
            <span style={{ fontSize: "10px", color: "#64748b" }}>
              ↑↓ navigate · ↵ open · Esc close
            </span>
          </div>

          {!normalizedQuery ? (
            <div
              style={{
                padding: "14px 12px",
                fontSize: "12px",
                color: "#94a3b8",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
              }}
            >
              <div>
                Type a ticket ID, customer ID, agent, sport, or selection to search across{" "}
                <strong style={{ color: "#e2e8f0" }}>{customers.length} customers</strong>,{" "}
                <strong style={{ color: "#e2e8f0" }}>{wagers.length} live wagers</strong>, and{" "}
                <strong style={{ color: "#e2e8f0" }}>{tickers.length} bet ticker rows</strong>.
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                {wagers[0] && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onQueryChange(wagers[0]!.customerId)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "5px",
                      fontSize: "11px",
                      backgroundColor: "#1e293b",
                      color: "#cbd5e1",
                      border: "1px solid #334155",
                      cursor: "pointer",
                    }}
                  >
                    Try: {wagers[0]!.customerId}
                  </button>
                )}
                {wagers[0]?.sport && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onQueryChange(wagers[0]!.sport)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "5px",
                      fontSize: "11px",
                      backgroundColor: "#1e293b",
                      color: "#cbd5e1",
                      border: "1px solid #334155",
                      cursor: "pointer",
                    }}
                  >
                    Try: {wagers[0]!.sport}
                  </button>
                )}
                {customers[0] && (
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onQueryChange(customers[0]!.id)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "5px",
                      fontSize: "11px",
                      backgroundColor: "#1e293b",
                      color: "#cbd5e1",
                      border: "1px solid #334155",
                      cursor: "pointer",
                    }}
                  >
                    Try: {customers[0]!.id}
                  </button>
                )}
              </div>
            </div>
          ) : flatResults.length === 0 ? (
            <div
              style={{
                padding: "16px 12px",
                fontSize: "12px",
                color: "#94a3b8",
                textAlign: "center",
              }}
            >
              No matches for <code style={{ color: "#f8fafc" }}>{query.trim()}</code>
              {scope !== "all" ? ` in ${scope}` : ""}.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {/* Customers Group */}
              {visibleCustomers.length > 0 && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 10px",
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      color: "#94a3b8",
                      backgroundColor: "rgba(15, 23, 42, 0.85)",
                      borderBottom: "1px solid #1e293b",
                    }}
                  >
                    <span>👥 Customers ({matchedCustomers.length})</span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setOpen(false)
                        onViewAllInTab("customers", query.trim())
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        fontSize: "10px",
                        fontWeight: 600,
                        color: "#38bdf8",
                        cursor: "pointer",
                      }}
                    >
                      Filter in Profiles ↗
                    </button>
                  </div>
                  {visibleCustomers.map((customer) => {
                    const idx = runningIdx++
                    const isActive = idx === activeIndex
                    const tone = tierTone(customer.tier)
                    return (
                      <button
                        key={`c:${customer.id}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() =>
                          activateItem({
                            kind: "customer",
                            id: `c:${customer.id}`,
                            item: customer,
                          })
                        }
                        style={{
                          width: "100%",
                          textAlign: "left",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "10px",
                          padding: "8px 10px",
                          backgroundColor: isActive ? "rgba(56, 189, 248, 0.14)" : "transparent",
                          borderTop: "none",
                          borderRight: "none",
                          borderLeft: isActive ? "2px solid #38bdf8" : "2px solid transparent",
                          borderBottom: "1px solid rgba(30, 41, 59, 0.7)",
                          color: "#f1f5f9",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              fontSize: "12px",
                            }}
                          >
                            <span
                              style={{
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                fontWeight: 700,
                                color: "#38bdf8",
                              }}
                            >
                              {customer.id}
                            </span>
                            {customer.name &&
                              customer.name.toUpperCase() !== customer.id.toUpperCase() && (
                                <span
                                  style={{
                                    color: "#cbd5e1",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  {customer.name}
                                </span>
                              )}
                          </div>
                          <div
                            style={{
                              fontSize: "11px",
                              color: "#94a3b8",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            Agent {customer.agentId} · {customer.specialization}
                          </div>
                        </div>
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: 700,
                            padding: "2px 6px",
                            borderRadius: "4px",
                            color: tone.fg,
                            backgroundColor: tone.bg,
                            border: `1px solid ${tone.border}`,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {customer.tierLabel ?? customer.tier.replace(/^TIER_\d+_/, "")}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              {/* Live Wagers Group */}
              {visibleWagers.length > 0 && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 10px",
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      color: "#94a3b8",
                      backgroundColor: "rgba(15, 23, 42, 0.85)",
                      borderBottom: "1px solid #1e293b",
                    }}
                  >
                    <span>⚡ Live Wagers ({matchedWagers.length})</span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setOpen(false)
                        onViewAllInTab("wagers", query.trim())
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        fontSize: "10px",
                        fontWeight: 600,
                        color: "#38bdf8",
                        cursor: "pointer",
                      }}
                    >
                      Filter in Live Wagers ↗
                    </button>
                  </div>
                  {visibleWagers.map((wager) => {
                    const idx = runningIdx++
                    const isActive = idx === activeIndex
                    const tone = tierTone(wager.alertTier)
                    return (
                      <button
                        key={`w:${wager.ticketId}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() =>
                          activateItem({
                            kind: "wager",
                            id: `w:${wager.ticketId}`,
                            item: wager,
                          })
                        }
                        style={{
                          width: "100%",
                          textAlign: "left",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "10px",
                          padding: "8px 10px",
                          backgroundColor: isActive ? "rgba(56, 189, 248, 0.14)" : "transparent",
                          borderTop: "none",
                          borderRight: "none",
                          borderLeft: isActive ? "2px solid #38bdf8" : "2px solid transparent",
                          borderBottom: "1px solid rgba(30, 41, 59, 0.7)",
                          color: "#f1f5f9",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              fontSize: "12px",
                            }}
                          >
                            <span
                              style={{
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                fontWeight: 700,
                                color: "#e2e8f0",
                              }}
                            >
                              {wager.ticketId}
                            </span>
                            <span
                              style={{
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                color: "#38bdf8",
                                fontSize: "11px",
                              }}
                            >
                              {wager.customerId}
                            </span>
                            <span
                              style={{
                                fontSize: "10px",
                                color: "#94a3b8",
                              }}
                            >
                              {wager.sport}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: "11px",
                              color: "#94a3b8",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {wager.selection || wager.event}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-end",
                            gap: "2px",
                            flexShrink: 0,
                          }}
                        >
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              color: "#4ade80",
                            }}
                          >
                            {formatUsdWhole(wager.riskUsd)}
                          </span>
                          <span
                            style={{
                              fontSize: "9px",
                              fontWeight: 700,
                              padding: "1px 5px",
                              borderRadius: "4px",
                              color: tone.fg,
                              backgroundColor: tone.bg,
                              border: `1px solid ${tone.border}`,
                            }}
                          >
                            {wager.alertTier}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}

              {/* Bet Tickers Group */}
              {visibleTickers.length > 0 && (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 10px",
                      fontSize: "10px",
                      fontWeight: 700,
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                      color: "#94a3b8",
                      backgroundColor: "rgba(15, 23, 42, 0.85)",
                      borderBottom: "1px solid #1e293b",
                    }}
                  >
                    <span>📡 Bet Ticker ({matchedTickers.length})</span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setOpen(false)
                        onViewAllInTab("bet-ticker", query.trim())
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        fontSize: "10px",
                        fontWeight: 600,
                        color: "#38bdf8",
                        cursor: "pointer",
                      }}
                    >
                      Filter in Bet Ticker ↗
                    </button>
                  </div>
                  {visibleTickers.map((ticket) => {
                    const idx = runningIdx++
                    const isActive = idx === activeIndex
                    return (
                      <button
                        key={`t:${ticket.ticketId}:${ticket.wagerNumber}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() =>
                          activateItem({
                            kind: "ticker",
                            id: `t:${ticket.ticketId}:${ticket.wagerNumber}`,
                            item: ticket,
                          })
                        }
                        style={{
                          width: "100%",
                          textAlign: "left",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "10px",
                          padding: "8px 10px",
                          backgroundColor: isActive ? "rgba(56, 189, 248, 0.14)" : "transparent",
                          borderTop: "none",
                          borderRight: "none",
                          borderLeft: isActive ? "2px solid #38bdf8" : "2px solid transparent",
                          borderBottom: "1px solid rgba(30, 41, 59, 0.7)",
                          color: "#f1f5f9",
                          cursor: "pointer",
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "6px",
                              fontSize: "12px",
                            }}
                          >
                            <span
                              style={{
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                fontWeight: 700,
                                color: "#e2e8f0",
                              }}
                            >
                              {ticket.ticketId}
                            </span>
                            <span
                              style={{
                                fontFamily:
                                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                                color: "#38bdf8",
                                fontSize: "11px",
                              }}
                            >
                              {ticket.customerId}
                            </span>
                            <span
                              style={{
                                fontSize: "10px",
                                color: "#94a3b8",
                              }}
                            >
                              {ticket.sport || ticket.wagerTypeLabel}
                            </span>
                          </div>
                          <div
                            style={{
                              fontSize: "11px",
                              color: "#94a3b8",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {ticket.selection || ticket.shortDesc}
                          </div>
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "flex-end",
                            gap: "2px",
                            flexShrink: 0,
                          }}
                        >
                          <span
                            style={{
                              fontSize: "11px",
                              fontWeight: 700,
                              fontFamily:
                                "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                              color: "#fbbf24",
                            }}
                          >
                            {formatUsdWhole(ticket.amountWageredCents / 100)}
                          </span>
                          <span
                            style={{
                              fontSize: "10px",
                              color: "#64748b",
                            }}
                          >
                            {ticket.ticketWriter}
                          </span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
