/**
 * @file packages/ui/src/panels/LiveTickerOverlay.tsx
 * @description Optional dockable Bloomberg-style Live Wager Ticker overlay so operators
 * can monitor sharp/whale wager flow without leaving the Profiles or Downlines context.
 */
import { ArrowUpRight, Dock, Filter, Radio, X } from "lucide-react"
import type React from "react"
import { useMemo, useState } from "react"

import type { LiveWager } from "../types.ts"

export interface LiveTickerOverlayProps {
  readonly open: boolean
  readonly wagers: readonly LiveWager[]
  readonly onClose: () => void
  readonly onSelectWager: (wager: LiveWager) => void
  readonly onSelectCustomerById?: ((customerId: string) => void) | undefined
  readonly onOpenFullTicker: () => void
}

const WHALE_THRESHOLD_USD = 2500

function isWhaleWager(wager: LiveWager): boolean {
  return wager.riskUsd >= WHALE_THRESHOLD_USD || (wager.volumeUsd ?? 0) >= WHALE_THRESHOLD_USD
}

function isSharpWager(wager: LiveWager): boolean {
  return (
    wager.alertTier === "CRITICAL" ||
    wager.alertTier === "STEAM" ||
    (typeof wager.clvCents === "number" && wager.clvCents > 0)
  )
}

function formatTickerTime(raw: string): string {
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return raw.slice(0, 8)
  return new Date(parsed).toLocaleTimeString([], {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

export function LiveTickerOverlay({
  open,
  wagers,
  onClose,
  onSelectWager,
  onSelectCustomerById,
  onOpenFullTicker,
}: LiveTickerOverlayProps): React.ReactElement | null {
  const [sharpOnly, setSharpOnly] = useState<boolean>(false)
  const [dockSide, setDockSide] = useState<"bottom" | "right">("bottom")

  const rows = useMemo(() => {
    const filtered = sharpOnly ? wagers.filter((w) => isSharpWager(w) || isWhaleWager(w)) : wagers
    return [...filtered]
      .sort((a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || ""))
      .slice(0, 24)
  }, [wagers, sharpOnly])

  const sharpCount = useMemo(() => wagers.filter((w) => isSharpWager(w)).length, [wagers])
  const whaleCount = useMemo(() => wagers.filter((w) => isWhaleWager(w)).length, [wagers])

  if (!open) return null

  return (
    <aside
      className={`sd-ticker-overlay sd-ticker-overlay--${dockSide}`}
      data-type="live-ticker-overlay"
      data-dock={dockSide}
      role="region"
      aria-label="Dockable live wager ticker"
    >
      <div className="sd-ticker-overlay__header">
        <div className="sd-ticker-overlay__title-wrap">
          <Radio size={13} aria-hidden="true" className="sd-ticker-overlay__icon" />
          <span className="sd-ticker-overlay__title">Live Ticker</span>
          <span className="sd-ticker-overlay__counts sd-tabular">
            {rows.length}/{wagers.length}
            {sharpCount > 0 ? ` · ${sharpCount} sharp` : ""}
            {whaleCount > 0 ? ` · ${whaleCount} whale` : ""}
          </span>
        </div>

        <div className="sd-ticker-overlay__actions">
          <button
            type="button"
            onClick={() => setSharpOnly((prev) => !prev)}
            aria-pressed={sharpOnly}
            className={`sd-action-btn${sharpOnly ? " sd-action-btn--primary" : ""}`}
            title="Show only Sharp, Steam, and Whale wagers"
          >
            <Filter size={11} aria-hidden="true" />
            <span>{sharpOnly ? "Sharp/Whale" : "All"}</span>
          </button>

          <button
            type="button"
            onClick={() => setDockSide((prev) => (prev === "bottom" ? "right" : "bottom"))}
            className="sd-action-btn"
            title={
              dockSide === "bottom"
                ? "Dock Live Ticker to right rail"
                : "Dock Live Ticker to bottom-right"
            }
          >
            <Dock size={11} aria-hidden="true" />
            <span>{dockSide === "bottom" ? "Rail" : "Float"}</span>
          </button>

          <button
            type="button"
            onClick={onOpenFullTicker}
            className="sd-action-btn"
            title="Open full Bet Ticker workspace"
          >
            <span>Full</span>
            <ArrowUpRight size={11} aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onClose}
            className="sd-action-btn"
            aria-label="Close dockable live ticker"
            title="Hide dockable live ticker"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="sd-ticker-overlay__body">
        {rows.length === 0 ? (
          <div className="sd-ticker-overlay__empty">
            {sharpOnly
              ? "No sharp or whale wagers in the current live window."
              : "Awaiting live wager flow from ticker stream."}
          </div>
        ) : (
          rows.map((wager) => {
            const whale = isWhaleWager(wager)
            const sharp = isSharpWager(wager)
            const severity =
              wager.alertTier === "CRITICAL" ? "critical" : whale || sharp ? "warning" : "healthy"

            return (
              <div
                key={wager.ticketId}
                role="button"
                tabIndex={0}
                onClick={() => onSelectWager(wager)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    onSelectWager(wager)
                  }
                }}
                className={`sd-ticker-item${whale ? " sd-ticker-item--whale" : ""}${
                  sharp ? " sd-ticker-item--sharp" : ""
                }`}
                data-severity={severity}
                data-type={whale ? "whale" : sharp ? "sharp" : "standard"}
                data-alert={wager.alertTier.toLowerCase()}
              >
                <div className="sd-ticker-item__top">
                  <div className="sd-ticker-item__who">
                    {onSelectCustomerById ? (
                      <button
                        type="button"
                        className="sd-ticker-item__cust"
                        onClick={(e) => {
                          e.stopPropagation()
                          onSelectCustomerById(wager.customerId)
                        }}
                        title={`Focus ${wager.customerId} in Profiles`}
                      >
                        {wager.customerId}
                      </button>
                    ) : (
                      <span className="sd-ticker-item__cust">{wager.customerId}</span>
                    )}
                    <span className="sd-ticker-item__sport">{wager.sport}</span>
                    {whale && (
                      <span className="sd-badge sd-badge--whale" data-type="whale">
                        Whale
                      </span>
                    )}
                    {sharp && (
                      <span className="sd-badge sd-badge--sharp" data-type="sharp">
                        {wager.alertTier === "CRITICAL" ? "Critical" : "Sharp"}
                      </span>
                    )}
                  </div>
                  <div className="sd-ticker-item__figures sd-tabular">
                    <span className="sd-ticker-item__amount">
                      ${Math.round(wager.riskUsd).toLocaleString()}
                    </span>
                    {typeof wager.clvCents === "number" && wager.clvCents !== 0 && (
                      <span
                        className={`sd-ticker-item__clv${
                          wager.clvCents > 0
                            ? " sd-ticker-item__clv--pos"
                            : " sd-ticker-item__clv--neg"
                        }`}
                      >
                        {wager.clvCents > 0 ? "+" : ""}
                        {wager.clvCents.toFixed(1)}¢
                      </span>
                    )}
                  </div>
                </div>

                <div className="sd-ticker-item__bottom">
                  <span className="sd-ticker-item__market">{wager.selection || wager.event}</span>
                  <span className="sd-ticker-item__time sd-tabular">
                    {formatTickerTime(wager.timestamp)}
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
