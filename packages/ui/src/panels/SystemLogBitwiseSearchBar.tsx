import { Check, Download, RotateCcw, Search, X } from "lucide-react"
import type React from "react"
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import {
  type BitwiseLogFilterStore,
  type BitwiseLogIndex,
  evaluateBitwiseLogIndex,
  formatBitmaskBinary,
  formatBitmaskHex,
  LOG_SEVERITY_BIT_ERROR,
  LOG_SEVERITY_BIT_INFO,
  LOG_SEVERITY_BIT_WARN,
  LOG_SEVERITY_BIT_WATCH,
  LOG_SEVERITY_BITS,
  LOG_SEVERITY_MASK_ALL,
} from "../system_log_bitwise_filter.ts"

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

/**
 * Applies the active bitwise severity mask + search terms directly to an
 * already-mounted `<tbody>` DOM tree via `tr.hidden` without calling React
 * `setState`, guaranteeing rapid sub-millisecond lookup with zero parent or
 * table re-renders on keystrokes.
 */
export function useBitwiseTableDomFilter(params: {
  readonly tbodyRef: React.RefObject<HTMLTableSectionElement | null>
  readonly index: BitwiseLogIndex
  readonly store: BitwiseLogFilterStore | null | undefined
  /** Optional revision token (e.g. expandedRowId) that triggers re-applying hidden state after a structural row update. */
  readonly revision?: string | number | null | undefined
}): void {
  const { tbodyRef, index, store, revision } = params
  const bitmapRef = useRef<Uint8Array>(new Uint8Array(0))

  const applyFilterToDom = useCallback(() => {
    if (!store) return
    const snap = store.getSnapshot()
    if (bitmapRef.current.length !== index.length) {
      bitmapRef.current = new Uint8Array(index.length)
    }
    const evalResult = evaluateBitwiseLogIndex(index, snap.parsed, bitmapRef.current)
    const { visible, matchedCount, totalCount, effectiveMask, elapsedMs } = evalResult

    const tbody = tbodyRef.current
    if (tbody) {
      const children = tbody.children
      let activeDateHeader: HTMLTableRowElement | null = null
      let dateGroupVisibleCount = 0

      const flushDateHeader = () => {
        if (activeDateHeader !== null) {
          activeDateHeader.hidden = dateGroupVisibleCount === 0
        }
      }

      for (let i = 0; i < children.length; i += 1) {
        const el = children[i] as HTMLTableRowElement
        if (el.dataset.bitwiseEmpty === "true") {
          el.hidden = totalCount === 0 || matchedCount > 0
          continue
        }
        if (el.dataset.dateGroup !== undefined) {
          flushDateHeader()
          activeDateHeader = el
          dateGroupVisibleCount = 0
          continue
        }
        const idxAttr = el.dataset.logIdx
        if (idxAttr !== undefined) {
          const idx = Number.parseInt(idxAttr, 10)
          const isVisible =
            !Number.isNaN(idx) && idx >= 0 && idx < visible.length ? visible[idx] === 1 : true
          el.hidden = !isVisible
          if (isVisible && el.dataset.logDetail !== "true") {
            dateGroupVisibleCount += 1
          }
        }
      }
      flushDateHeader()
    }

    store.reportStats({
      matchedCount,
      totalCount,
      effectiveMask,
      elapsedMs,
      bitCounts: index.bitCounts,
    })
  }, [tbodyRef, index, store])

  useLayoutEffect(() => {
    applyFilterToDom()
  }, [applyFilterToDom, revision])

  useEffect(() => {
    if (!store) return
    return store.subscribeFilter(applyFilterToDom)
  }, [store, applyFilterToDom])
}

export interface SystemLogBitwiseSearchBarProps {
  readonly store: BitwiseLogFilterStore
  readonly mode: "weblogs" | "unified"
  readonly onExportJson?: (() => number | Promise<number>) | undefined
}

function countForBit(
  bit: number,
  counts: { error: number; warn: number; watch: number; info: number },
): number {
  if (bit === LOG_SEVERITY_BIT_ERROR) return counts.error
  if (bit === LOG_SEVERITY_BIT_WARN) return counts.warn
  if (bit === LOG_SEVERITY_BIT_WATCH) return counts.watch
  if (bit === LOG_SEVERITY_BIT_INFO) return counts.info
  return 0
}

/**
 * Isolated client-side bitwise severity search bar. Subscribes directly to
 * `BitwiseLogFilterStore` via `useSyncExternalStore` so keystrokes and flag
 * toggles update only this compact bar and mutate matching table rows in place.
 */
export const SystemLogBitwiseSearchBar = memo(function SystemLogBitwiseSearchBar({
  store,
  mode,
  onExportJson,
}: SystemLogBitwiseSearchBarProps): React.ReactElement {
  const snap = useSyncExternalStore(store.subscribeFilter, store.getSnapshot, store.getSnapshot)
  const stats = useSyncExternalStore(store.subscribeStats, store.getStats, store.getStats)
  const [exportedCount, setExportedCount] = useState<number | null>(null)
  const exportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (exportTimerRef.current !== null) {
        clearTimeout(exportTimerRef.current)
      }
    }
  }, [])

  const handleExportClick = async () => {
    if (!onExportJson || stats.matchedCount === 0) return
    const count = await onExportJson()
    if (count <= 0) return
    setExportedCount(count)
    if (exportTimerRef.current !== null) {
      clearTimeout(exportTimerRef.current)
    }
    exportTimerRef.current = setTimeout(() => {
      setExportedCount(null)
    }, 2000)
  }

  const effectiveMask = snap.parsed.effectiveMask
  const isNarrowed = snap.rawQuery.trim() !== "" || snap.toggledMask !== LOG_SEVERITY_MASK_ALL

  const visibleDescriptors =
    mode === "unified"
      ? LOG_SEVERITY_BITS.filter((d) => d.bit !== LOG_SEVERITY_BIT_WATCH)
      : LOG_SEVERITY_BITS

  const elapsedLabel = stats.elapsedMs < 0.01 ? "<0.01ms" : `${stats.elapsedMs.toFixed(2)}ms`

  return (
    <section
      aria-label="Client-Side Bitwise Severity Filter"
      style={{
        backgroundColor: "#0f172a",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "#1e293b",
        borderRadius: "8px",
        padding: "12px 16px",
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
          gap: "10px",
        }}
      >
        {/* Client-side bitwise search input */}
        <div
          style={{
            position: "relative",
            flex: "1 1 320px",
            minWidth: "240px",
            display: "flex",
            alignItems: "center",
          }}
        >
          <Search
            size={14}
            aria-hidden="true"
            style={{
              position: "absolute",
              left: "11px",
              color: "#64748b",
              pointerEvents: "none",
            }}
          />
          <input
            type="text"
            data-system-logs-search-input="true"
            value={snap.rawQuery}
            onChange={(e) => store.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && snap.rawQuery !== "") {
                e.preventDefault()
                store.setQuery("")
              }
            }}
            aria-label="Search log messages by text content or bitwise severity flags"
            placeholder={
              mode === "weblogs"
                ? 'Filter log messages in real time: text, "quoted phrase", msg:error, IP, or crit|high...'
                : 'Filter log messages in real time: text, "webhook 502", msg:ok, source, or error|warn...'
            }
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 34px 8px 32px",
              borderRadius: "6px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor:
                snap.parsed.hasExplicitBitFilter ||
                snap.parsed.textTerms.length > 0 ||
                snap.parsed.excludeTextTerms.length > 0
                  ? "#38bdf8"
                  : "#334155",
              backgroundColor: "#070b14",
              color: "#f1f5f9",
              fontSize: "12px",
              fontFamily: MONO_FONT,
              outline: "none",
            }}
          />
          {snap.rawQuery !== "" ? (
            <button
              type="button"
              aria-label="Clear search query"
              onClick={() => store.setQuery("")}
              style={{
                position: "absolute",
                right: "6px",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "22px",
                height: "22px",
                borderRadius: "4px",
                borderWidth: "0px",
                backgroundColor: "transparent",
                color: "#94a3b8",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        {/* Interactive bitwise severity flag toggle buttons */}
        <div
          role="group"
          aria-label="Bitwise severity flag mask"
          style={{
            display: "inline-flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "4px",
            padding: "3px",
            borderRadius: "7px",
            backgroundColor: "#070b14",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#1e293b",
          }}
        >
          {visibleDescriptors.map((desc) => {
            const bitEnabled = (effectiveMask & desc.bit) !== 0
            const toggledOn = (snap.toggledMask & desc.bit) !== 0
            const count = countForBit(desc.bit, stats.bitCounts)
            const label = mode === "weblogs" ? desc.weblogLabel : desc.unifiedLabel
            return (
              <button
                key={desc.hex}
                type="button"
                data-bitwise-flag={desc.hex}
                aria-pressed={bitEnabled}
                title={`Toggle ${label} bit (${desc.hex}) via bitwise XOR`}
                onClick={() => store.toggleBit(desc.bit)}
                style={{
                  padding: "5px 9px",
                  borderRadius: "5px",
                  fontSize: "11px",
                  fontWeight: 600,
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  cursor: "pointer",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: bitEnabled
                    ? desc.activeBorder
                    : toggledOn
                      ? "#334155"
                      : "transparent",
                  backgroundColor: bitEnabled ? desc.activeBg : "transparent",
                  color: bitEnabled ? desc.fg : "#64748b",
                  opacity: bitEnabled ? 1 : 0.72,
                  transition:
                    "background-color 140ms ease, color 140ms ease, border-color 140ms ease",
                }}
              >
                {label} {desc.hex} ({count})
              </button>
            )
          })}

          {isNarrowed ? (
            <button
              type="button"
              onClick={() => store.reset()}
              title="Reset bitwise severity mask to 0x0F and clear query"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "5px 9px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 600,
                whiteSpace: "nowrap",
                flexShrink: 0,
                cursor: "pointer",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
                backgroundColor: "#1e293b",
                color: "#e2e8f0",
              }}
            >
              <RotateCcw size={11} aria-hidden="true" />
              Reset
            </button>
          ) : null}

          {onExportJson ? (
            <button
              type="button"
              data-system-logs-export-json="true"
              data-export-confirmed={exportedCount !== null ? "true" : undefined}
              disabled={stats.matchedCount === 0}
              onClick={() => void handleExportClick()}
              aria-label={
                stats.matchedCount === 0
                  ? "Export filtered logs to JSON (no matching logs)"
                  : `Export ${stats.matchedCount} currently filtered log rows to formatted JSON`
              }
              title={
                stats.matchedCount === 0
                  ? "No matching log entries in the current filtered view"
                  : `Download ${stats.matchedCount} currently filtered ${mode === "weblogs" ? "weblog" : "system log"} row${stats.matchedCount === 1 ? "" : "s"} as formatted JSON`
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 10px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 700,
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
                whiteSpace: "nowrap",
                flexShrink: 0,
                cursor: stats.matchedCount === 0 ? "not-allowed" : "pointer",
                opacity: stats.matchedCount === 0 ? 0.5 : 1,
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor:
                  exportedCount !== null ? "rgba(34, 197, 94, 0.55)" : "rgba(56, 189, 248, 0.45)",
                backgroundColor:
                  exportedCount !== null ? "rgba(34, 197, 94, 0.16)" : "rgba(56, 189, 248, 0.14)",
                color: exportedCount !== null ? "#86efac" : "#7dd3fc",
              }}
            >
              {exportedCount !== null ? (
                <>
                  <Check size={12} aria-hidden="true" />
                  <span>Exported {exportedCount}</span>
                </>
              ) : (
                <>
                  <Download size={12} aria-hidden="true" />
                  <span>Export JSON ({stats.matchedCount})</span>
                </>
              )}
            </button>
          ) : null}
        </div>
      </div>

      {/* Unboxed tabular readout with typographic separators */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          fontSize: "11px",
          color: "#94a3b8",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span style={{ color: "#e2e8f0", fontWeight: 600 }}>
            {stats.matchedCount} / {stats.totalCount} rows matched
          </span>
          <span aria-hidden="true">·</span>
          <span style={{ fontFamily: MONO_FONT, color: "#7dd3fc" }}>
            mask {formatBitmaskHex(effectiveMask)} ({formatBitmaskBinary(effectiveMask)})
          </span>
          <span aria-hidden="true">·</span>
          <span style={{ fontFamily: MONO_FONT }}>lookup {elapsedLabel}</span>
          {snap.parsed.textTerms.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>terms: {snap.parsed.textTerms.join(", ")}</span>
            </>
          ) : null}
          {snap.parsed.excludeTextTerms.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>exclude: {snap.parsed.excludeTextTerms.join(", ")}</span>
            </>
          ) : null}
        </div>

        <span style={{ color: "#64748b", fontFamily: MONO_FONT }}>
          Syntax: free text · "phrase" · msg:ok · crit|high · -info
        </span>
      </div>
    </section>
  )
})
