import type React from "react"
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react"
import { RotateCcw, Search, X } from "lucide-react"
import {
  evaluateBitwiseLogIndex,
  formatBitmaskBinary,
  formatBitmaskHex,
  LOG_SEVERITY_BIT_ERROR,
  LOG_SEVERITY_BIT_INFO,
  LOG_SEVERITY_BIT_WARN,
  LOG_SEVERITY_BIT_WATCH,
  LOG_SEVERITY_BITS,
  LOG_SEVERITY_MASK_ALL,
  type BitwiseLogFilterStore,
  type BitwiseLogIndex,
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
}: SystemLogBitwiseSearchBarProps): React.ReactElement {
  const snap = useSyncExternalStore(store.subscribeFilter, store.getSnapshot)
  const stats = useSyncExternalStore(store.subscribeStats, store.getStats)

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
            value={snap.rawQuery}
            onChange={(e) => store.setQuery(e.target.value)}
            aria-label="Client-side bitwise severity and log text search"
            placeholder={
              mode === "weblogs"
                ? "Instant bitwise filter: crit|high, -norm, mask:0x0c, IP, account, or bot key..."
                : "Instant bitwise filter: error|warn, -info, mask:0x0c, source, customer, or message..."
            }
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "8px 34px 8px 32px",
              borderRadius: "6px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: snap.parsed.hasExplicitBitFilter ? "#38bdf8" : "#334155",
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
        </div>

        <span style={{ color: "#64748b", fontFamily: MONO_FONT }}>
          Syntax: crit|high · -info · mask:0x0c · free text
        </span>
      </div>
    </section>
  )
})
