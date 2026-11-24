/**
 * Enhanced Session API usage & Base URL telemetry meter rendered in the Surveillance/Telemetry tab.
 * Shows active Base URL properties (`origin`, `protocol`, `host`, `hostname`, `port`, `pathname`,
 * `href`, `source`, `sameOrigin`), filterable/sortable normalized endpoints (method + path + base
 * URL + headers + latency + status), expandable per-endpoint URL/header inspection, and JSON Blob
 * export.
 *
 * @file Packages/ui/src/panels/ApiUsageCard.tsx
 */

import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Globe,
  RotateCcw,
  Search,
} from "lucide-react"
import type React from "react"
import { Fragment, useMemo, useState } from "react"

import {
  type ApiBaseUrlSource,
  type ApiUsageRow,
  type ApiUsageSnapshot,
  resetApiUsage,
  useApiUsage,
} from "../api_usage.ts"
import { copyText } from "../clipboard.ts"
import { styles } from "../dashboard_styles.ts"

const VISIBLE_ROWS = 14

const TABULAR_NUMS: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
}

export type ApiUsageFilterMode = "ALL" | "ALIGNED" | "ERRORS"

export type ApiUsageSortField =
  "calls" | "endpoint" | "origin" | "avgMs" | "lastMs" | "failed" | "status"

export function formatBaseUrlSourceLabel(source: ApiBaseUrlSource): string {
  switch (source) {
    case "window-origin":
      return "Window Origin"
    case "query-override":
      return "?apiBase Override"
    case "config":
      return "dashboard.toml"
    case "explicit":
      return "Explicit URL"
    case "fallback":
      return "Fallback"
  }
}

export function buildApiUsageExportBlob(usage: ApiUsageSnapshot): Blob {
  const payload = {
    schema: "sportsdesk-api-usage/v1",
    exportedAt: new Date().toISOString(),
    privacy: "normalized routes only; no query values or customer ids",
    baseUrl: usage.baseUrl,
    origins: usage.origins,
    summary: {
      calls: usage.calls,
      networkCalls: usage.calls - usage.coalesced,
      coalesced: usage.coalesced,
      ok: usage.ok,
      failed: usage.failed,
      pending: usage.pending,
      avgMs: usage.avgMs,
      alignedResponses: usage.alignedResponses,
    },
    endpoints: usage.rows.map((row) => ({
      endpoint: row.key,
      method: row.method,
      normalizedPath: row.normalizedPath,
      baseUrl: row.baseUrl,
      calls: row.calls,
      coalesced: row.coalesced,
      ok: row.ok,
      failed: row.failed,
      pending: row.pending,
      avgMs: row.avgMs,
      minMs: row.minMs,
      maxMs: row.maxMs,
      lastMs: row.lastMs,
      lastStatus: row.lastStatus,
      lastAtMs: row.lastAtMs,
      headers: row.lastHeaders,
    })),
  }
  return new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  })
}

export function filterAndSortApiUsageRows(
  rows: readonly ApiUsageRow[],
  options: {
    readonly search: string
    readonly filterMode: ApiUsageFilterMode
    readonly originFilter: string
    readonly sortField: ApiUsageSortField
    readonly sortDir: "asc" | "desc"
  },
): readonly ApiUsageRow[] {
  const q = options.search.trim().toLowerCase()
  const filtered = rows.filter((row) => {
    if (options.filterMode === "ALIGNED" && !row.lastHeaders?.aligned) {
      return false
    }
    if (options.filterMode === "ERRORS" && row.failed === 0) {
      return false
    }
    if (options.originFilter !== "ALL" && row.baseUrl.origin !== options.originFilter) {
      return false
    }
    if (!q) return true
    return (
      row.key.toLowerCase().includes(q) ||
      row.baseUrl.origin.toLowerCase().includes(q) ||
      row.baseUrl.host.toLowerCase().includes(q) ||
      row.baseUrl.protocol.toLowerCase().includes(q) ||
      (row.lastHeaders?.runtimeEngine?.toLowerCase().includes(q) ?? false)
    )
  })

  const dirMul = options.sortDir === "asc" ? 1 : -1
  return [...filtered].sort((a, b) => {
    let delta = 0
    switch (options.sortField) {
      case "calls":
        delta = a.calls - b.calls
        break
      case "endpoint":
        delta = a.key.localeCompare(b.key)
        break
      case "origin":
        delta = a.baseUrl.origin.localeCompare(b.baseUrl.origin)
        break
      case "avgMs":
        delta = (a.avgMs ?? -1) - (b.avgMs ?? -1)
        break
      case "lastMs":
        delta = (a.lastMs ?? -1) - (b.lastMs ?? -1)
        break
      case "failed":
        delta = a.failed - b.failed
        break
      case "status":
        delta = (a.lastStatus ?? 0) - (b.lastStatus ?? 0)
        break
    }
    if (delta !== 0) return delta * dirMul
    return b.calls - a.calls || a.key.localeCompare(b.key)
  })
}

function formatMs(value: number | null): string {
  return value === null ? "—" : `${value} ms`
}

function formatAge(lastAtMs: number | null): string {
  if (lastAtMs === null) return "—"
  const seconds = Math.max(0, Math.round((Date.now() - lastAtMs) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

function statusColor(status: number | null): string {
  if (status === null) return "#fca5a5"
  if (status >= 500) return "#fca5a5"
  if (status >= 400) return "#fbbf24"
  return "#4ade80"
}

function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "#38bdf8"
    case "POST":
      return "#a78bfa"
    case "PUT":
    case "PATCH":
      return "#fbbf24"
    case "DELETE":
      return "#f87171"
    default:
      return "#94a3b8"
  }
}

export interface ApiUsageCardProps {
  readonly defaultExpandedKey?: string | null | undefined
}

export function ApiUsageCard({
  defaultExpandedKey = null,
}: ApiUsageCardProps = {}): React.ReactElement {
  const usage = useApiUsage()
  const [showAll, setShowAll] = useState(false)
  const [search, setSearch] = useState("")
  const [filterMode, setFilterMode] = useState<ApiUsageFilterMode>("ALL")
  const [originFilter, setOriginFilter] = useState<string>("ALL")
  const [sortField, setSortField] = useState<ApiUsageSortField>("calls")
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc")
  const [expandedKey, setExpandedKey] = useState<string | null>(defaultExpandedKey)
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null)

  const networkCalls = Math.max(0, usage.calls - usage.coalesced)
  const errorRowCount = useMemo(() => usage.rows.filter((r) => r.failed > 0).length, [usage.rows])
  const alignedRowCount = useMemo(
    () => usage.rows.filter((r) => r.lastHeaders?.aligned).length,
    [usage.rows],
  )

  const filteredRows = useMemo(
    () =>
      filterAndSortApiUsageRows(usage.rows, {
        search,
        filterMode,
        originFilter,
        sortField,
        sortDir,
      }),
    [usage.rows, search, filterMode, originFilter, sortField, sortDir],
  )

  const rows = showAll ? filteredRows : filteredRows.slice(0, VISIBLE_ROWS)
  const truncated = filteredRows.length > rows.length

  const toggleSort = (field: ApiUsageSortField) => {
    if (sortField === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortDir(field === "endpoint" || field === "origin" ? "asc" : "desc")
    }
  }

  const sortArrow = (field: ApiUsageSortField): string => {
    if (sortField !== field) return ""
    return sortDir === "asc" ? " ↑" : " ↓"
  }

  const handleCopy = (targetId: string, value: string) => {
    void copyText(value).then((res) => {
      if (!res.ok) return
      setCopiedTarget(targetId)
      setTimeout(() => {
        setCopiedTarget((prev) => (prev === targetId ? null : prev))
      }, 1_600)
    })
  }

  const handleExportJson = () => {
    if (typeof window === "undefined" || typeof Blob === "undefined") return
    const blob = buildApiUsageExportBlob(usage)
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = objectUrl
    anchor.download = `sportsdesk-api-usage-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  }

  const base = usage.baseUrl
  const portDisplay =
    base.port !== ""
      ? `:${base.port}`
      : base.effectivePort !== ""
        ? `:${base.effectivePort} (default)`
        : "—"

  const thBtnStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
    padding: 0,
    whiteSpace: "nowrap",
  }

  return (
    <div style={styles.tableCard} data-api-usage-card="true">
      {/* Header Row */}
      <div
        style={{
          ...styles.tableHeader,
          flexWrap: "wrap",
          gap: "10px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "4px",
            minWidth: "240px",
          }}
        >
          <h3 style={styles.tableTitle}>
            📡 API Usage (session)
            <span
              data-api-usage-summary="true"
              style={{
                marginLeft: "8px",
                fontSize: "11px",
                fontWeight: 400,
                color: "#94a3b8",
                ...TABULAR_NUMS,
              }}
            >
              {usage.calls} calls
              {usage.coalesced > 0
                ? ` · ${networkCalls} network · ${usage.coalesced} coalesced`
                : ""}
              {" · "}
              {usage.ok} ok · {usage.failed} failed{" · "}
              avg {formatMs(usage.avgMs)}
              {usage.alignedResponses > 0 ? ` · ${usage.alignedResponses} aligned` : ""}
              {usage.pending > 0 ? ` · ${usage.pending} pending` : ""}
            </span>
          </h3>
          <span style={{ ...styles.kpiSub, fontSize: "11px" }}>
            normalized routes only · no query values or customer ids
          </span>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            data-api-usage-copy-base="true"
            onClick={() => handleCopy("base-origin", base.origin)}
            style={{
              ...styles.actionBtn,
              padding: "4px 9px",
              fontSize: "11px",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              whiteSpace: "nowrap",
            }}
            title={`Copy active Base URL (${base.origin})`}
          >
            {copiedTarget === "base-origin" ? (
              <Check size={11} aria-hidden="true" />
            ) : (
              <Copy size={11} aria-hidden="true" />
            )}
            <span>{copiedTarget === "base-origin" ? "Copied Base" : "Copy Base URL"}</span>
          </button>

          <button
            type="button"
            data-api-usage-export="true"
            onClick={handleExportJson}
            style={{
              ...styles.actionBtn,
              padding: "4px 9px",
              fontSize: "11px",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              whiteSpace: "nowrap",
            }}
            title="Export session Base URL properties and normalized endpoint metrics as JSON"
          >
            <Download size={11} aria-hidden="true" />
            <span>Export JSON</span>
          </button>

          <button
            type="button"
            data-api-usage-reset="true"
            onClick={() => {
              resetApiUsage()
              setShowAll(false)
              setExpandedKey(null)
            }}
            disabled={usage.calls === 0}
            style={{
              ...styles.actionBtn,
              padding: "4px 9px",
              fontSize: "11px",
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              whiteSpace: "nowrap",
              color: usage.calls === 0 ? "#475569" : "#e2e8f0",
              cursor: usage.calls === 0 ? "default" : "pointer",
              opacity: usage.calls === 0 ? 0.55 : 1,
            }}
          >
            <RotateCcw size={11} aria-hidden="true" />
            <span>Reset meter</span>
          </button>
        </div>
      </div>

      {/* Resolved Base URL Properties Strip */}
      <div
        data-api-usage-base-url="true"
        style={{
          padding: "10px 16px",
          borderBottom: "1px solid #1e293b",
          backgroundColor: "rgba(15, 23, 42, 0.55)",
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
            flexWrap: "wrap",
            gap: "8px",
            fontSize: "11px",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              color: "#cbd5e1",
              fontWeight: 600,
            }}
          >
            <Globe size={13} style={{ color: "#38bdf8" }} aria-hidden="true" />
            <span>Base URL Properties</span>
            <span style={{ color: "#64748b", fontWeight: 400 }}>·</span>
            <code
              data-api-base-href="true"
              style={{
                color: "#7dd3fc",
                fontSize: "11px",
                fontFamily: "monospace",
              }}
            >
              {base.href}
            </code>
          </div>
          <div
            style={{
              fontSize: "11px",
              color: "#94a3b8",
              ...TABULAR_NUMS,
            }}
          >
            {base.sameOrigin ? "Same-Origin" : "Cross-Origin"} ·{" "}
            {base.secure ? "TLS (HTTPS)" : "Plaintext (HTTP)"} ·{" "}
            {formatBaseUrlSourceLabel(base.source)} · {usage.origins.length} origin
            {usage.origins.length === 1 ? "" : "s"} observed
          </div>
        </div>

        <dl
          style={{
            margin: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
            gap: "8px 16px",
            fontSize: "11px",
            ...TABULAR_NUMS,
          }}
        >
          <div>
            <dt style={{ color: "#64748b", marginBottom: "2px" }}>origin</dt>
            <dd
              data-api-base-prop="origin"
              style={{
                margin: 0,
                fontFamily: "monospace",
                color: "#e2e8f0",
                wordBreak: "break-all",
              }}
            >
              {base.origin}
            </dd>
          </div>
          <div>
            <dt style={{ color: "#64748b", marginBottom: "2px" }}>protocol</dt>
            <dd
              data-api-base-prop="protocol"
              style={{
                margin: 0,
                fontFamily: "monospace",
                color: base.secure ? "#4ade80" : "#fbbf24",
              }}
            >
              {base.protocol}
            </dd>
          </div>
          <div>
            <dt style={{ color: "#64748b", marginBottom: "2px" }}>hostname</dt>
            <dd
              data-api-base-prop="hostname"
              style={{
                margin: 0,
                fontFamily: "monospace",
                color: "#e2e8f0",
                wordBreak: "break-all",
              }}
            >
              {base.hostname}
            </dd>
          </div>
          <div>
            <dt style={{ color: "#64748b", marginBottom: "2px" }}>host</dt>
            <dd
              data-api-base-prop="host"
              style={{
                margin: 0,
                fontFamily: "monospace",
                color: "#e2e8f0",
                wordBreak: "break-all",
              }}
            >
              {base.host}
            </dd>
          </div>
          <div>
            <dt style={{ color: "#64748b", marginBottom: "2px" }}>port</dt>
            <dd
              data-api-base-prop="port"
              style={{
                margin: 0,
                fontFamily: "monospace",
                color: "#cbd5e1",
              }}
            >
              {portDisplay}
            </dd>
          </div>
          <div>
            <dt style={{ color: "#64748b", marginBottom: "2px" }}>pathname</dt>
            <dd
              data-api-base-prop="pathname"
              style={{
                margin: 0,
                fontFamily: "monospace",
                color: "#cbd5e1",
              }}
            >
              {base.pathname}
            </dd>
          </div>
        </dl>
      </div>

      {/* Filter Toolbar */}
      {usage.rows.length > 0 && (
        <div
          data-api-usage-toolbar="true"
          style={{
            padding: "8px 16px",
            borderBottom: "1px solid #1e293b",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flexWrap: "wrap",
              flex: "1 1 240px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 8px",
                borderRadius: "6px",
                backgroundColor: "#0b1220",
                border: "1px solid #334155",
                flex: "1 1 180px",
                maxWidth: "300px",
              }}
            >
              <Search size={12} style={{ color: "#64748b", flexShrink: 0 }} aria-hidden="true" />
              <input
                type="text"
                data-api-usage-search="true"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter endpoint, host, or engine..."
                aria-label="Filter API usage endpoints"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: "transparent",
                  border: "none",
                  outline: "none",
                  color: "#e2e8f0",
                  fontSize: "11px",
                }}
              />
            </div>

            <div
              role="group"
              aria-label="Filter API endpoints by status"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                padding: "2px",
                borderRadius: "6px",
                backgroundColor: "rgba(15, 23, 42, 0.7)",
                border: "1px solid #334155",
              }}
            >
              {(
                [
                  { id: "ALL", label: `All (${usage.rows.length})` },
                  { id: "ALIGNED", label: `Aligned (${alignedRowCount})` },
                  { id: "ERRORS", label: `Errors (${errorRowCount})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  data-api-usage-filter={tab.id}
                  onClick={() => setFilterMode(tab.id)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: "4px",
                    border: "none",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    backgroundColor:
                      filterMode === tab.id ? "rgba(56, 189, 248, 0.18)" : "transparent",
                    color: filterMode === tab.id ? "#38bdf8" : "#94a3b8",
                    ...TABULAR_NUMS,
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {usage.origins.length > 1 && (
            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "11px",
                color: "#94a3b8",
              }}
            >
              <span>Origin:</span>
              <select
                data-api-usage-origin-filter="true"
                value={originFilter}
                onChange={(e) => setOriginFilter(e.target.value)}
                style={{
                  backgroundColor: "#0b1220",
                  border: "1px solid #334155",
                  borderRadius: "5px",
                  color: "#e2e8f0",
                  fontSize: "11px",
                  padding: "3px 6px",
                }}
              >
                <option value="ALL">All Origins ({usage.origins.length})</option>
                {usage.origins.map((orig) => (
                  <option key={orig} value={orig}>
                    {orig}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {usage.rows.length === 0 ? (
        <div
          data-api-usage-empty="true"
          style={{
            padding: "18px 16px",
            color: "#94a3b8",
            fontSize: "12px",
          }}
        >
          No API calls recorded this session. Dashboard reads against{" "}
          <code style={{ color: "#7dd3fc" }}>{base.origin}</code> are tracked automatically as they
          happen.
        </div>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th scope="col" style={styles.th}>
                    <button type="button" onClick={() => toggleSort("endpoint")} style={thBtnStyle}>
                      Endpoint{sortArrow("endpoint")}
                    </button>
                  </th>
                  <th scope="col" style={styles.th}>
                    <button type="button" onClick={() => toggleSort("origin")} style={thBtnStyle}>
                      Base URL{sortArrow("origin")}
                    </button>
                  </th>
                  <th scope="col" style={styles.th}>
                    Headers
                  </th>
                  <th scope="col" style={{ ...styles.th, textAlign: "right" }}>
                    <button type="button" onClick={() => toggleSort("calls")} style={thBtnStyle}>
                      Calls{sortArrow("calls")}
                    </button>
                  </th>
                  <th scope="col" style={{ ...styles.th, textAlign: "right" }}>
                    OK
                  </th>
                  <th scope="col" style={{ ...styles.th, textAlign: "right" }}>
                    <button type="button" onClick={() => toggleSort("failed")} style={thBtnStyle}>
                      Err{sortArrow("failed")}
                    </button>
                  </th>
                  <th scope="col" style={{ ...styles.th, textAlign: "right" }}>
                    <button type="button" onClick={() => toggleSort("avgMs")} style={thBtnStyle}>
                      Avg{sortArrow("avgMs")}
                    </button>
                  </th>
                  <th scope="col" style={{ ...styles.th, textAlign: "right" }}>
                    <button type="button" onClick={() => toggleSort("lastMs")} style={thBtnStyle}>
                      Last{sortArrow("lastMs")}
                    </button>
                  </th>
                  <th scope="col" style={{ ...styles.th, textAlign: "right" }}>
                    <button type="button" onClick={() => toggleSort("status")} style={thBtnStyle}>
                      Status{sortArrow("status")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      style={{
                        ...styles.td,
                        textAlign: "center",
                        color: "#94a3b8",
                      }}
                    >
                      No endpoints match the active filter.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const isExpanded = expandedKey === row.key
                    const resolvedNormalizedUrl = `${row.baseUrl.origin}${row.normalizedPath}`
                    const rowPortLabel =
                      row.baseUrl.port !== ""
                        ? `:${row.baseUrl.port}`
                        : row.baseUrl.effectivePort !== ""
                          ? `:${row.baseUrl.effectivePort}`
                          : ""
                    return (
                      <Fragment key={row.key}>
                        <tr data-api-usage-row={row.key}>
                          <td style={styles.td}>
                            <button
                              type="button"
                              data-api-usage-expand={row.key}
                              aria-expanded={isExpanded}
                              onClick={() =>
                                setExpandedKey((prev) => (prev === row.key ? null : row.key))
                              }
                              style={{
                                background: "none",
                                border: "none",
                                padding: 0,
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "6px",
                                textAlign: "left",
                                color: "#cbd5e1",
                              }}
                              title="Toggle Base URL & header details for this endpoint"
                            >
                              {isExpanded ? (
                                <ChevronDown
                                  size={12}
                                  style={{ color: "#38bdf8", flexShrink: 0 }}
                                  aria-hidden="true"
                                />
                              ) : (
                                <ChevronRight
                                  size={12}
                                  style={{ color: "#64748b", flexShrink: 0 }}
                                  aria-hidden="true"
                                />
                              )}
                              <code style={{ fontSize: "11px" }}>
                                <span
                                  style={{
                                    color: methodColor(row.method),
                                    fontWeight: 700,
                                    marginRight: "6px",
                                  }}
                                >
                                  {row.method}
                                </span>
                                <span style={{ color: "#cbd5e1" }}>{row.normalizedPath}</span>
                              </code>
                            </button>
                          </td>
                          <td
                            style={{ ...styles.td, ...TABULAR_NUMS }}
                            data-api-usage-row-base={row.baseUrl.origin}
                            title={`origin: ${row.baseUrl.origin}\nprotocol: ${row.baseUrl.protocol}\nhost: ${row.baseUrl.host}\nhostname: ${row.baseUrl.hostname}\nport: ${row.baseUrl.port || `${row.baseUrl.effectivePort} (default)`}\nsource: ${row.baseUrl.source}\nsameOrigin: ${String(row.baseUrl.sameOrigin)}`}
                          >
                            <code
                              style={{
                                fontSize: "11px",
                                color: "#94a3b8",
                              }}
                            >
                              {row.baseUrl.host}
                            </code>
                            <div style={styles.custSub}>
                              {row.baseUrl.protocol}
                              {rowPortLabel ? ` · ${rowPortLabel}` : ""} ·{" "}
                              {row.baseUrl.sameOrigin ? "same-origin" : "cross-origin"}
                            </div>
                          </td>
                          <td style={styles.td}>
                            {row.lastHeaders ? (
                              <div
                                style={{
                                  fontSize: "11px",
                                  color: row.lastHeaders.aligned ? "#34d399" : "#94a3b8",
                                  ...TABULAR_NUMS,
                                }}
                                title={[
                                  row.lastHeaders.endpointHeader
                                    ? `X-SportsDesk-Endpoint: ${row.lastHeaders.endpointHeader}`
                                    : null,
                                  row.lastHeaders.cacheControl
                                    ? `Cache-Control: ${row.lastHeaders.cacheControl}`
                                    : null,
                                  row.lastHeaders.runtimeEngine
                                    ? `X-Runtime-Engine: ${row.lastHeaders.runtimeEngine}`
                                    : null,
                                  row.lastHeaders.requestId
                                    ? `X-Request-Id: ${row.lastHeaders.requestId}`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join("\n")}
                              >
                                {row.lastHeaders.aligned ? "Aligned" : "Standard"}
                                {row.lastHeaders.runtimeEngine
                                  ? ` · ${row.lastHeaders.runtimeEngine}`
                                  : ""}
                              </div>
                            ) : (
                              <span style={{ color: "#64748b", fontSize: "11px" }}>—</span>
                            )}
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              textAlign: "right",
                              ...TABULAR_NUMS,
                            }}
                          >
                            {row.calls}
                            {row.coalesced > 0 ? (
                              <div style={styles.custSub}>{row.coalesced} coalesced</div>
                            ) : null}
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              textAlign: "right",
                              color: "#86efac",
                              ...TABULAR_NUMS,
                            }}
                          >
                            {row.ok}
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              textAlign: "right",
                              color: row.failed > 0 ? "#fca5a5" : "#64748b",
                              ...TABULAR_NUMS,
                            }}
                          >
                            {row.failed}
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              textAlign: "right",
                              ...TABULAR_NUMS,
                            }}
                          >
                            <div>{formatMs(row.avgMs)}</div>
                            {row.minMs !== null && row.maxMs !== null && row.calls > 1 ? (
                              <div style={styles.custSub}>
                                {row.minMs}–{row.maxMs} ms
                              </div>
                            ) : null}
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              textAlign: "right",
                              ...TABULAR_NUMS,
                            }}
                          >
                            {formatMs(row.lastMs)}
                            <div style={styles.custSub}>{formatAge(row.lastAtMs)}</div>
                          </td>
                          <td
                            style={{
                              ...styles.td,
                              textAlign: "right",
                              fontFamily: "monospace",
                              fontWeight: 700,
                              color:
                                row.lastStatus !== null
                                  ? statusColor(row.lastStatus)
                                  : row.pending > 0
                                    ? "#94a3b8"
                                    : "#fca5a5",
                              ...TABULAR_NUMS,
                            }}
                          >
                            {row.lastStatus ?? (row.pending > 0 ? "…" : "ERR")}
                            {row.pending > 0 && row.lastStatus !== null ? " · …" : ""}
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr data-api-usage-detail={row.key}>
                            <td
                              colSpan={9}
                              style={{
                                ...styles.td,
                                backgroundColor: "rgba(15, 23, 42, 0.72)",
                                padding: "12px 16px",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: "10px",
                                  fontSize: "11px",
                                  ...TABULAR_NUMS,
                                }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    flexWrap: "wrap",
                                    gap: "8px",
                                  }}
                                >
                                  <code
                                    style={{
                                      color: "#7dd3fc",
                                      fontSize: "11px",
                                    }}
                                  >
                                    {row.method} {resolvedNormalizedUrl}
                                  </code>
                                  <button
                                    type="button"
                                    onClick={() => handleCopy(row.key, resolvedNormalizedUrl)}
                                    style={{
                                      ...styles.actionBtn,
                                      padding: "3px 8px",
                                      fontSize: "11px",
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: "5px",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {copiedTarget === row.key ? (
                                      <Check size={11} aria-hidden="true" />
                                    ) : (
                                      <Copy size={11} aria-hidden="true" />
                                    )}
                                    <span>
                                      {copiedTarget === row.key
                                        ? "Copied URL"
                                        : "Copy Normalized URL"}
                                    </span>
                                  </button>
                                </div>

                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
                                    gap: "6px 14px",
                                    color: "#cbd5e1",
                                  }}
                                >
                                  <div>
                                    <span style={{ color: "#64748b" }}>origin: </span>
                                    <code>{row.baseUrl.origin}</code>
                                  </div>
                                  <div>
                                    <span style={{ color: "#64748b" }}>protocol: </span>
                                    <code>{row.baseUrl.protocol}</code>
                                  </div>
                                  <div>
                                    <span style={{ color: "#64748b" }}>hostname: </span>
                                    <code>{row.baseUrl.hostname}</code>
                                  </div>
                                  <div>
                                    <span style={{ color: "#64748b" }}>port: </span>
                                    <code>
                                      {row.baseUrl.port || `${row.baseUrl.effectivePort} (default)`}
                                    </code>
                                  </div>
                                  <div>
                                    <span style={{ color: "#64748b" }}>source: </span>
                                    <span>{formatBaseUrlSourceLabel(row.baseUrl.source)}</span>
                                  </div>
                                  <div>
                                    <span style={{ color: "#64748b" }}>scope: </span>
                                    <span>
                                      {row.baseUrl.sameOrigin ? "Same-Origin" : "Cross-Origin"}
                                    </span>
                                  </div>
                                  <div>
                                    <span style={{ color: "#64748b" }}>latency: </span>
                                    <span>
                                      min {formatMs(row.minMs)} · avg {formatMs(row.avgMs)} · max{" "}
                                      {formatMs(row.maxMs)}
                                    </span>
                                  </div>
                                  {row.lastHeaders?.cacheControl && (
                                    <div>
                                      <span style={{ color: "#64748b" }}>Cache-Control: </span>
                                      <code>{row.lastHeaders.cacheControl}</code>
                                    </div>
                                  )}
                                  {row.lastHeaders?.endpointHeader && (
                                    <div>
                                      <span style={{ color: "#64748b" }}>
                                        X-SportsDesk-Endpoint:{" "}
                                      </span>
                                      <code>{row.lastHeaders.endpointHeader}</code>
                                    </div>
                                  )}
                                  {row.lastHeaders?.requestId && (
                                    <div>
                                      <span style={{ color: "#64748b" }}>X-Request-Id: </span>
                                      <code>{row.lastHeaders.requestId}</code>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
          {truncated || showAll ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 16px",
                borderTop: "1px solid #1e293b",
                fontSize: "11px",
                color: "#94a3b8",
                ...TABULAR_NUMS,
              }}
            >
              <span>
                Showing {rows.length} of {filteredRows.length} endpoints
                {filteredRows.length !== usage.rows.length ? ` (${usage.rows.length} total)` : ""}
              </span>
              <button
                type="button"
                data-api-usage-show-all={showAll ? "collapse" : "expand"}
                onClick={() => setShowAll((prev) => !prev)}
                style={{
                  ...styles.actionBtn,
                  padding: "3px 9px",
                  fontSize: "11px",
                }}
              >
                {showAll ? `Show top ${VISIBLE_ROWS}` : `Show all ${filteredRows.length}`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
