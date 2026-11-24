import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ShieldAlert,
  User,
  X,
} from "lucide-react"
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"

import {
  formatAgentChain,
  formatAlertWagerBrief,
  type RecentRiskAlertItem,
  type RecentRiskAlertKind,
  resolveAlertWagerContext,
} from "../risk_recent_alerts.ts"
import type { ShowcaseCustomer } from "../types.ts"

export interface RiskAlertWagerModalProps {
  readonly item: RecentRiskAlertItem | null
  readonly activeIndex: number
  readonly totalCount: number
  readonly matchedCustomer?: ShowcaseCustomer | null | undefined
  readonly onClose: () => void
  readonly onNavigateOffset?: ((delta: -1 | 1) => void) | undefined
  readonly onOpenInLiveWagers: (item: RecentRiskAlertItem) => void
  readonly onOpenCustomerProfile?: ((customer: ShowcaseCustomer) => void) | undefined
}

function formatUsdFull(amount: number): string {
  const hasCents = Math.abs(amount - Math.round(amount)) >= 0.005
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  })
}

function kindFullLabel(kind: RecentRiskAlertKind): string {
  switch (kind) {
    case "THRESHOLD_BREACH":
      return "60m Aggregate Breach"
    case "THRESHOLD_WARNING":
      return "60m Threshold Warning"
    case "SINGLE_WAGER_BREACH":
      return "Single-Wager Cap Breach"
    case "SHARP_STEAM_ALERT":
      return "Sharp / Steam Alert"
    case "DELIVERY_ALERT":
      return "Alert Queue Dispatch"
  }
}

export function RiskAlertWagerModal({
  item,
  activeIndex,
  totalCount,
  matchedCustomer,
  onClose,
  onNavigateOffset,
  onOpenInLiveWagers,
  onOpenCustomerProfile,
}: RiskAlertWagerModalProps): React.ReactElement | null {
  const [copied, setCopied] = useState(false)
  const closeBtnRef = useRef<HTMLButtonElement | null>(null)
  const wasOpenRef = useRef(false)

  const open = item !== null

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const frame = requestAnimationFrame(() => {
        closeBtnRef.current?.focus()
      })
      wasOpenRef.current = true
      return () => cancelAnimationFrame(frame)
    }
    if (!open) {
      wasOpenRef.current = false
    }
    return undefined
  }, [open])

  useEffect(() => {
    setCopied(false)
  }, [item?.id])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
        return
      }
      if (!onNavigateOffset || totalCount <= 1) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return
      if (event.key === "ArrowLeft" && activeIndex > 0) {
        event.preventDefault()
        onNavigateOffset(-1)
      } else if (event.key === "ArrowRight" && activeIndex < totalCount - 1) {
        event.preventDefault()
        onNavigateOffset(1)
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, onClose, onNavigateOffset, activeIndex, totalCount])

  const ctx = useMemo(() => (item ? resolveAlertWagerContext(item) : null), [item])

  if (!item || !ctx) return null

  const isBreach = item.severity === "BREACH"
  const canStepPrev = Boolean(onNavigateOffset && activeIndex > 0)
  const canStepNext = Boolean(onNavigateOffset && activeIndex >= 0 && activeIndex < totalCount - 1)

  const handleCopyBrief = () => {
    const text = formatAlertWagerBrief(item, ctx)
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1800)
      })
    }
  }

  const handleOpenLiveWagers = () => {
    onClose()
    onOpenInLiveWagers(item)
  }

  const handleOpenCustomer = () => {
    if (!matchedCustomer || !onOpenCustomerProfile) return
    onClose()
    onOpenCustomerProfile(matchedCustomer)
  }

  const agentChain = formatAgentChain(ctx.agentId, ctx.masterAgent)

  const modalContent = (
    <div
      className="sd-alert-wager-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
      data-recent-alert-wager-backdrop="true"
    >
      <div
        className="sd-alert-wager-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sd-alert-wager-modal-title"
        aria-describedby="sd-alert-wager-modal-desc"
        data-recent-alert-wager-modal="true"
        data-recent-alert-modal-ticket={ctx.ticketId}
      >
        {/* Header */}
        <div className="sd-alert-wager-modal-header">
          <div className="sd-alert-wager-modal-title-group">
            <div className="sd-alert-wager-modal-kicker">
              <span
                className={`sd-alert-wager-modal-severity sd-alert-wager-modal-severity--${isBreach ? "breach" : "warn"}`}
              >
                {isBreach ? (
                  <ShieldAlert size={13} aria-hidden="true" />
                ) : (
                  <AlertTriangle size={13} aria-hidden="true" />
                )}
                <span>{isBreach ? "Breach" : "Warning"}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span>{kindFullLabel(item.kind)}</span>
              <span aria-hidden="true">·</span>
              <span className="sd-alert-wager-modal-mono">
                {item.clockLabel} ({item.relativeAgeLabel})
              </span>
            </div>

            <div className="sd-alert-wager-modal-heading-row">
              <h3 id="sd-alert-wager-modal-title" className="sd-alert-wager-modal-title">
                {item.title}
              </h3>
              <span className="sd-alert-wager-modal-ticket">#{ctx.ticketId}</span>
            </div>

            <p id="sd-alert-wager-modal-desc" className="sd-alert-wager-modal-subtitle">
              {item.detail}
            </p>
          </div>

          <div className="sd-alert-wager-modal-header-controls">
            {totalCount > 1 && onNavigateOffset ? (
              <div
                className="sd-alert-wager-modal-stepper"
                role="group"
                aria-label="Step between recent alerts"
              >
                <button
                  type="button"
                  className="sd-alert-wager-modal-step-btn"
                  onClick={() => onNavigateOffset(-1)}
                  disabled={!canStepPrev}
                  aria-label="Previous alert"
                  title="Previous alert (Left Arrow)"
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span className="sd-alert-wager-modal-step-count">
                  {activeIndex + 1}/{totalCount}
                </span>
                <button
                  type="button"
                  className="sd-alert-wager-modal-step-btn"
                  onClick={() => onNavigateOffset(1)}
                  disabled={!canStepNext}
                  aria-label="Next alert"
                  title="Next alert (Right Arrow)"
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}

            <button
              ref={closeBtnRef}
              type="button"
              className="sd-alert-wager-modal-close"
              onClick={onClose}
              aria-label="Close wager context modal"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Primary Financial, Effective Line & Customer Highlight Strip */}
        <div className="sd-alert-wager-modal-kpis">
          <div className="sd-alert-wager-modal-kpi" data-alert-modal-field="payout">
            <span className="sd-alert-wager-modal-kpi-label">Total Payout</span>
            <span className="sd-alert-wager-modal-kpi-val sd-alert-wager-modal-kpi-val--payout">
              {ctx.totalPayoutUsd !== null ? formatUsdFull(ctx.totalPayoutUsd) : "—"}
            </span>
            <span className="sd-alert-wager-modal-kpi-sub">
              {ctx.toWinUsd !== null ? (
                <>
                  To Win {formatUsdFull(ctx.toWinUsd)}
                  {ctx.payoutMultiple !== null ? ` · ${ctx.payoutMultiple.toFixed(2)}x` : ""}
                  {ctx.payoutEstimatedFromOdds ? " (est.)" : ""}
                </>
              ) : (
                "No quoted win figure"
              )}
            </span>
          </div>

          <div className="sd-alert-wager-modal-kpi" data-alert-modal-field="effective-line">
            <span className="sd-alert-wager-modal-kpi-label">Effective Line</span>
            <span className="sd-alert-wager-modal-kpi-val" title={ctx.effectiveLine}>
              {ctx.effectiveLine}
            </span>
            <span className="sd-alert-wager-modal-kpi-sub">
              Implied {ctx.impliedProbability} · {ctx.betType}
            </span>
          </div>

          <div className="sd-alert-wager-modal-kpi" data-alert-modal-field="customer-id">
            <span className="sd-alert-wager-modal-kpi-label">Customer ID</span>
            <span className="sd-alert-wager-modal-kpi-val sd-alert-wager-modal-kpi-val--customer">
              {ctx.customerId}
            </span>
            <span className="sd-alert-wager-modal-kpi-sub">
              {agentChain || "Unassigned agent"}
              {ctx.vip ? " · VIP" : ""}
            </span>
          </div>

          <div className="sd-alert-wager-modal-kpi" data-alert-modal-field="risk">
            <span className="sd-alert-wager-modal-kpi-label">Risk / Stake</span>
            <span className="sd-alert-wager-modal-kpi-val">
              {ctx.riskUsd > 0 ? formatUsdFull(ctx.riskUsd) : "—"}
            </span>
            <span className="sd-alert-wager-modal-kpi-sub">
              {ctx.capUtilizationPct !== null
                ? `${ctx.capUtilizationPct.toFixed(1)}% of rec. cap`
                : ctx.quotedHoldPct !== null
                  ? `Ticket hold ${ctx.quotedHoldPct.toFixed(1)}%`
                  : "Live exposure stake"}
            </span>
          </div>
        </div>

        {/* Detailed Wager & Surveillance Context Body */}
        <div className="sd-alert-wager-modal-body">
          <div className="sd-alert-wager-modal-section">
            <h4 className="sd-alert-wager-modal-section-title">Wager &amp; Market Context</h4>
            <dl className="sd-alert-wager-modal-dl">
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Event</dt>
                <dd>{ctx.event}</dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Full Selection</dt>
                <dd className="sd-alert-wager-modal-mono">{ctx.formattedPick}</dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Sport / League</dt>
                <dd>
                  {ctx.sport}
                  {ctx.subSport && ctx.subSport !== ctx.sport ? ` · ${ctx.subSport}` : ""}
                </dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Odds / Return</dt>
                <dd className="sd-alert-wager-modal-mono">
                  {ctx.oddsAmerican ?? "—"}
                  {ctx.totalReturnMultiple !== null
                    ? ` · ${ctx.totalReturnMultiple.toFixed(2)}x gross`
                    : ""}
                  {ctx.quotedHoldPct !== null ? ` · ${ctx.quotedHoldPct.toFixed(1)}% hold` : ""}
                </dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Intake Channel</dt>
                <dd>{ctx.channelLabel}</dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Ticket Timestamp</dt>
                <dd className="sd-alert-wager-modal-mono">{ctx.placedTimestamp}</dd>
              </div>
            </dl>
          </div>

          <div className="sd-alert-wager-modal-section">
            <h4 className="sd-alert-wager-modal-section-title">Risk &amp; Alert Telemetry</h4>
            <dl className="sd-alert-wager-modal-dl">
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Alert Tier</dt>
                <dd className="sd-alert-wager-modal-mono">
                  {ctx.alertTier ?? "—"}
                  {ctx.alertBadge && ctx.alertBadge !== ctx.alertTier ? ` · ${ctx.alertBadge}` : ""}
                </dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Closing Line Value</dt>
                <dd
                  className={`sd-alert-wager-modal-mono${
                    ctx.clvCents !== null && ctx.clvCents >= 3
                      ? " sd-alert-wager-modal-val--breach"
                      : ctx.clvCents !== null && ctx.clvCents > 0
                        ? " sd-alert-wager-modal-val--warn"
                        : ""
                  }`}
                >
                  {ctx.clvCents !== null
                    ? `${ctx.clvCents >= 0 ? "+" : ""}${ctx.clvCents.toFixed(1)}¢ CLV`
                    : "Unmeasured"}
                </dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Max Rec. Stake</dt>
                <dd className="sd-alert-wager-modal-mono">
                  {ctx.maxRecommendedStake !== null
                    ? `${formatUsdFull(ctx.maxRecommendedStake)}${
                        ctx.capUtilizationPct !== null
                          ? ` (${ctx.capUtilizationPct.toFixed(1)}%)`
                          : ""
                      }`
                    : "—"}
                </dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>60m Exposure Context</dt>
                <dd className="sd-alert-wager-modal-mono">
                  {item.kind === "SINGLE_WAGER_BREACH" && ctx.thresholdLimitUsd !== null
                    ? `${formatUsdFull(ctx.riskUsd)} stake vs ${formatUsdFull(ctx.thresholdLimitUsd)} max cap`
                    : ctx.cumulativeRiskUsd !== null && ctx.thresholdLimitUsd !== null
                      ? item.kind === "THRESHOLD_WARNING"
                        ? `${formatUsdFull(ctx.cumulativeRiskUsd)} vs ${formatUsdFull(ctx.thresholdLimitUsd)} warn${
                            ctx.breachLimitUsd !== null &&
                            ctx.breachLimitUsd !== ctx.thresholdLimitUsd
                              ? ` (${formatUsdFull(ctx.breachLimitUsd)} cap)`
                              : ""
                          }`
                        : `${formatUsdFull(ctx.cumulativeRiskUsd)} vs ${formatUsdFull(ctx.thresholdLimitUsd)} breach cap`
                      : ctx.deliveryStatus
                        ? `Dispatch ${ctx.deliveryStatus}`
                        : "Single-ticket trigger"}
                </dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Operator Directive</dt>
                <dd className="sd-alert-wager-modal-mono">{ctx.operatorDirective ?? "MONITOR"}</dd>
              </div>
              <div className="sd-alert-wager-modal-dl-row">
                <dt>Tape Status</dt>
                <dd>
                  {ctx.hasLiveWagerRecord
                    ? "Open on live tape · Manual review only"
                    : "Historical alert dispatch (off open tape)"}
                </dd>
              </div>
            </dl>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="sd-alert-wager-modal-footer">
          <button
            type="button"
            className="sd-alert-wager-modal-secondary-btn"
            onClick={handleCopyBrief}
            data-alert-modal-copy="true"
          >
            {copied ? (
              <Check size={13} aria-hidden="true" />
            ) : (
              <Copy size={13} aria-hidden="true" />
            )}
            <span>{copied ? "Brief Copied" : "Copy Wager Brief"}</span>
          </button>

          <div className="sd-alert-wager-modal-actions">
            {matchedCustomer && onOpenCustomerProfile ? (
              <button
                type="button"
                className="sd-alert-wager-modal-secondary-btn"
                onClick={handleOpenCustomer}
                data-alert-modal-open-customer="true"
              >
                <User size={13} aria-hidden="true" />
                <span>Profile ({matchedCustomer.id})</span>
              </button>
            ) : null}

            <button type="button" className="sd-alert-wager-modal-secondary-btn" onClick={onClose}>
              Close
            </button>

            <button
              type="button"
              className="sd-alert-wager-modal-primary-btn"
              onClick={handleOpenLiveWagers}
              data-alert-modal-open-wager="true"
            >
              <span>Open in Live Wagers</span>
              <ArrowUpRight size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  if (typeof document !== "undefined" && document.body) {
    return createPortal(modalContent, document.body)
  }
  return modalContent
}
