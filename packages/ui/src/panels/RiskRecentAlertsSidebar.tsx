import type React from "react"
import { useMemo, useState } from "react"
import {
  AlertTriangle,
  ArrowUpRight,
  Clock,
  Filter,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  X,
} from "lucide-react"
import {
  buildRecentAlertFrequencyBuckets,
  buildRecentRiskAlerts,
  filterRecentRiskAlerts,
  type RecentRiskAlertItem,
  type RecentRiskAlertKind,
  type RecentRiskAlertStatusFilter,
} from "../risk_recent_alerts.ts"
import { RiskAlertWagerModal } from "./RiskAlertWagerModal.tsx"
import { RiskRecentAlertsChart } from "../viz/RiskRecentAlertsChart.tsx"
import type { DashboardAlertRecord, LiveWager, ShowcaseCustomer } from "../types.ts"

export interface RiskRecentAlertsSidebarProps {
  readonly wagers: readonly LiveWager[]
  readonly alertRecords: readonly DashboardAlertRecord[]
  readonly customers?: readonly ShowcaseCustomer[] | undefined
  readonly breachLimitUsd: number
  readonly warningLimitUsd: number
  readonly anchorMs?: number | undefined
  readonly onSelectWager: (wager: LiveWager) => void
  readonly onSelectCustomer?: ((customer: ShowcaseCustomer) => void) | undefined
  readonly onInvestigateWagers: (filter: {
    sport?: string
    search?: string
    alert?: string
  }) => void
  readonly onOpenAlertQueue: () => void
  readonly onOpenThresholdModal: () => void
}

function formatUsdWhole(amount: number): string {
  return `$${Math.round(amount).toLocaleString("en-US")}`
}

function kindShortLabel(kind: RecentRiskAlertKind): string {
  switch (kind) {
    case "THRESHOLD_BREACH":
      return "60m Breach"
    case "THRESHOLD_WARNING":
      return "60m Warning"
    case "SINGLE_WAGER_BREACH":
      return "Cap Breach"
    case "SHARP_STEAM_ALERT":
      return "Steam / Sharp"
    case "DELIVERY_ALERT":
      return "Alert Dispatch"
  }
}

export function RiskRecentAlertsSidebar({
  wagers,
  alertRecords,
  customers,
  breachLimitUsd,
  warningLimitUsd,
  anchorMs,
  onSelectWager,
  onSelectCustomer,
  onInvestigateWagers,
  onOpenAlertQueue,
  onOpenThresholdModal,
}: RiskRecentAlertsSidebarProps): React.ReactElement {
  const [statusFilter, setStatusFilter] = useState<RecentRiskAlertStatusFilter>("ALL")
  const [selectedBucketIndex, setSelectedBucketIndex] = useState<number | null>(null)
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null)

  const feed = useMemo(
    () =>
      buildRecentRiskAlerts({
        wagers,
        alertRecords,
        breachLimitUsd,
        warningLimitUsd,
        anchorMs,
      }),
    [wagers, alertRecords, breachLimitUsd, warningLimitUsd, anchorMs],
  )

  const filteredFeed = useMemo(
    () => filterRecentRiskAlerts(feed, statusFilter),
    [feed, statusFilter],
  )

  const frequencySeries = useMemo(
    () => buildRecentAlertFrequencyBuckets(filteredFeed),
    [filteredFeed],
  )

  const selectedBucket =
    selectedBucketIndex !== null ? (frequencySeries.buckets[selectedBucketIndex] ?? null) : null

  const visibleItems = useMemo(() => {
    if (!selectedBucket) return filteredFeed.items
    const isLastBucket = selectedBucket.index === frequencySeries.buckets.length - 1
    return filteredFeed.items.filter(
      (item) =>
        item.timestampMs >= selectedBucket.startMs &&
        (isLastBucket
          ? item.timestampMs <= selectedBucket.endMs + 5 * 60_000
          : item.timestampMs < selectedBucket.endMs),
    )
  }, [filteredFeed.items, selectedBucket, frequencySeries.buckets.length])

  const handleStatusFilterChange = (next: RecentRiskAlertStatusFilter) => {
    setStatusFilter(next)
    if (selectedBucketIndex !== null) {
      const nextSeries = buildRecentAlertFrequencyBuckets(filterRecentRiskAlerts(feed, next))
      const bucket = nextSeries.buckets[selectedBucketIndex]
      if (!bucket || bucket.totalCount === 0) {
        setSelectedBucketIndex(null)
      }
    }
  }

  const activeAlertIndex = useMemo(() => {
    if (!selectedAlertId) return -1
    return visibleItems.findIndex((item) => item.id === selectedAlertId)
  }, [selectedAlertId, visibleItems])

  const activeAlertItem = useMemo(() => {
    if (!selectedAlertId) return null
    if (activeAlertIndex >= 0) return visibleItems[activeAlertIndex] ?? null
    return feed.items.find((item) => item.id === selectedAlertId) ?? null
  }, [selectedAlertId, activeAlertIndex, visibleItems, feed.items])

  const matchedCustomer = useMemo(() => {
    if (!activeAlertItem || !customers || customers.length === 0) return null
    const targetId = (activeAlertItem.linkedWager?.customerId || activeAlertItem.customerId)
      .trim()
      .toUpperCase()
    if (!targetId || targetId === "UNKNOWN") return null
    return customers.find((c) => c.id.trim().toUpperCase() === targetId) ?? null
  }, [activeAlertItem, customers])

  const handleOpenWagerInTape = (item: RecentRiskAlertItem) => {
    if (item.linkedWager) {
      onSelectWager(item.linkedWager)
      return
    }
    const query = item.ticketId || item.customerId
    onInvestigateWagers({
      sport: item.sport !== "LIVE" && item.sport !== "OTHER" ? item.sport : undefined,
      search: query,
    })
  }

  const handleStepAlert = (delta: -1 | 1) => {
    if (activeAlertIndex < 0) return
    const next = visibleItems[activeAlertIndex + delta]
    if (next) {
      setSelectedAlertId(next.id)
    }
  }

  return (
    <aside
      className="sd-recent-alerts-sidebar"
      aria-label="Recent risk breaches and threshold warnings"
      data-risk-recent-alerts="true"
    >
      {/* Header */}
      <div className="sd-recent-alerts-header">
        <div className="sd-recent-alerts-title-row">
          <div className="sd-recent-alerts-title-group">
            <ShieldAlert size={15} className="sd-recent-alerts-title-icon" aria-hidden="true" />
            <h3 className="sd-recent-alerts-title">Recent Alerts</h3>
          </div>
          <span className="sd-recent-alerts-window-label">
            <Clock size={11} aria-hidden="true" />
            <span>{feed.windowMode === "capture" ? "60m capture" : "Last 60 min"}</span>
          </span>
        </div>
        <div className="sd-recent-alerts-summary">
          <span className={feed.breachCount > 0 ? "sd-recent-alerts-count--breach" : undefined}>
            {feed.breachCount} breach{feed.breachCount === 1 ? "" : "es"}
          </span>
          <span aria-hidden="true">·</span>
          <span className={feed.warnCount > 0 ? "sd-recent-alerts-count--warn" : undefined}>
            {feed.warnCount} warning{feed.warnCount === 1 ? "" : "s"}
          </span>
          <span aria-hidden="true">·</span>
          <span>Click any alert for wager details</span>
        </div>

        {/* Status Filter Controls ('All', 'Warning', 'Breach') */}
        <div className="sd-recent-alerts-filter-block">
          <div className="sd-recent-alerts-filter-head">
            <span className="sd-recent-alerts-filter-label">
              <Filter size={11} aria-hidden="true" />
              <span>Status</span>
            </span>
            {statusFilter !== "ALL" || selectedBucket ? (
              <button
                type="button"
                onClick={() => {
                  setStatusFilter("ALL")
                  setSelectedBucketIndex(null)
                }}
                className="sd-recent-alerts-filter-reset"
                data-recent-alerts-filter-reset="true"
              >
                <X size={10} aria-hidden="true" />
                <span>Reset</span>
              </button>
            ) : null}
          </div>

          <div
            className="sd-recent-alerts-filters"
            role="group"
            aria-label="Filter recent risk alerts by status"
            data-recent-alerts-status-filter={statusFilter}
          >
            {(
              [
                { id: "ALL", label: "All", count: feed.items.length },
                { id: "WARN", label: "Warning", count: feed.warnCount },
                { id: "BREACH", label: "Breach", count: feed.breachCount },
              ] as const
            ).map((tab) => {
              const active = statusFilter === tab.id
              const toneClass =
                tab.id === "BREACH"
                  ? "sd-recent-alerts-filter-btn--breach"
                  : tab.id === "WARN"
                    ? "sd-recent-alerts-filter-btn--warn"
                    : "sd-recent-alerts-filter-btn--all"
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => handleStatusFilterChange(tab.id)}
                  className={`sd-recent-alerts-filter-btn ${toneClass}${active ? " sd-recent-alerts-filter-btn--active" : ""}`}
                  aria-pressed={active}
                  data-recent-alerts-filter={tab.id}
                >
                  {tab.id === "BREACH" ? (
                    <ShieldAlert size={11} aria-hidden="true" />
                  ) : tab.id === "WARN" ? (
                    <AlertTriangle size={11} aria-hidden="true" />
                  ) : null}
                  <span>{tab.label}</span>
                  <span className="sd-recent-alerts-filter-count">{tab.count}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* D3 60-Minute Breach & Warning Frequency / Severity Chart */}
      <RiskRecentAlertsChart
        series={frequencySeries}
        statusFilter={statusFilter}
        selectedBucketIndex={selectedBucketIndex}
        onSelectBucket={setSelectedBucketIndex}
        onChangeStatusFilter={handleStatusFilterChange}
        onOpenThresholdModal={onOpenThresholdModal}
      />

      {/* Active Isolation Status Strip */}
      {statusFilter !== "ALL" || selectedBucket ? (
        <div className="sd-recent-alerts-active-filter" data-recent-alerts-isolation-bar="true">
          <span className="sd-recent-alerts-active-filter-text">
            Showing{" "}
            <strong>
              {visibleItems.length} of {feed.items.length}
            </strong>
            {statusFilter !== "ALL"
              ? ` · ${statusFilter === "BREACH" ? "Breach" : "Warning"} only`
              : ""}
            {selectedBucket ? ` · ${selectedBucket.rangeLabel}` : ""}
          </span>
        </div>
      ) : null}

      {/* Scrollable Chronological Feed */}
      <div className="sd-recent-alerts-list" role="list">
        {visibleItems.length === 0 ? (
          <div className="sd-recent-alerts-empty" data-recent-alerts-empty="true">
            <ShieldCheck size={20} className="sd-recent-alerts-empty-icon" aria-hidden="true" />
            <div className="sd-recent-alerts-empty-title">
              {selectedBucket
                ? `No ${statusFilter === "BREACH" ? "breach " : statusFilter === "WARN" ? "warning " : ""}alerts in ${selectedBucket.rangeLabel}`
                : feed.items.length === 0
                  ? "No breaches or threshold warnings"
                  : `No ${statusFilter === "BREACH" ? "Breach" : "Warning"} events in window`}
            </div>
            <p className="sd-recent-alerts-empty-copy">
              {selectedBucket
                ? "Clear the active time slice or status filter to view all risk events from the last 60 minutes."
                : feed.items.length === 0
                  ? `Rolling 60-minute exposure stayed clear of the ${formatUsdWhole(warningLimitUsd)} warning and ${formatUsdWhole(breachLimitUsd)} breach limits.`
                  : "Switch the status filter back to All to inspect other alert severities from the last 60 minutes."}
            </p>
            {selectedBucket || statusFilter !== "ALL" ? (
              <button
                type="button"
                onClick={() => {
                  setStatusFilter("ALL")
                  setSelectedBucketIndex(null)
                }}
                className="sd-recent-alerts-empty-btn"
              >
                <span>
                  {statusFilter !== "ALL" && !selectedBucket
                    ? "Show All Severities"
                    : "Show All 60 Minutes"}
                </span>
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenThresholdModal}
                className="sd-recent-alerts-empty-btn"
              >
                <Sliders size={12} aria-hidden="true" />
                <span>Configure Thresholds</span>
              </button>
            )}
          </div>
        ) : (
          visibleItems.map((item) => {
            const isBreach = item.severity === "BREACH"
            const isActive = selectedAlertId === item.id
            return (
              <button
                key={item.id}
                type="button"
                role="listitem"
                onClick={() => setSelectedAlertId(item.id)}
                className={`sd-recent-alert-row sd-recent-alert-row--${isBreach ? "breach" : "warn"}${isActive ? " sd-recent-alert-row--active" : ""}`}
                aria-current={isActive ? "true" : undefined}
                aria-haspopup="dialog"
                data-recent-alert-kind={item.kind}
                data-recent-alert-ticket={item.ticketId}
                title={`View full wager context for #${item.ticketId} (${item.customerId})`}
              >
                <div className="sd-recent-alert-row-top">
                  <span
                    className={`sd-recent-alert-severity sd-recent-alert-severity--${isBreach ? "breach" : "warn"}`}
                  >
                    {isBreach ? (
                      <ShieldAlert size={12} aria-hidden="true" />
                    ) : (
                      <AlertTriangle size={12} aria-hidden="true" />
                    )}
                    <span>{kindShortLabel(item.kind)}</span>
                  </span>
                  <span className="sd-recent-alert-time" title={item.clockLabel}>
                    {item.clockLabel.slice(0, 5)} · {item.relativeAgeLabel}
                  </span>
                </div>

                <div className="sd-recent-alert-title">{item.title}</div>
                <div className="sd-recent-alert-detail">{item.detail}</div>

                <div className="sd-recent-alert-wager-line">
                  <div className="sd-recent-alert-wager-meta">
                    <span className="sd-recent-alert-ticket">#{item.ticketId}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.customerId}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.sport}</span>
                    {item.riskUsd > 0 ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="sd-recent-alert-risk">{formatUsdWhole(item.riskUsd)}</span>
                      </>
                    ) : null}
                  </div>
                  <span className="sd-recent-alert-cta">
                    <span>Details</span>
                    <ArrowUpRight size={11} aria-hidden="true" />
                  </span>
                </div>

                {item.selection && item.selection !== "—" ? (
                  <div className="sd-recent-alert-selection">
                    {item.selection}
                    {item.oddsAmerican ? ` (${item.oddsAmerican})` : ""}
                  </div>
                ) : null}
              </button>
            )
          })
        )}
      </div>

      {/* Footer Actions */}
      <div className="sd-recent-alerts-footer">
        <button
          type="button"
          onClick={onOpenThresholdModal}
          className="sd-recent-alerts-footer-btn"
        >
          <Sliders size={12} aria-hidden="true" />
          <span>Limits</span>
        </button>
        <button type="button" onClick={onOpenAlertQueue} className="sd-recent-alerts-footer-link">
          <span>Alert Queue</span>
          <ArrowUpRight size={12} aria-hidden="true" />
        </button>
      </div>
      {/* Full Wager Context Modal */}
      <RiskAlertWagerModal
        item={activeAlertItem}
        activeIndex={activeAlertIndex >= 0 ? activeAlertIndex : 0}
        totalCount={activeAlertIndex >= 0 ? visibleItems.length : 1}
        matchedCustomer={matchedCustomer}
        onClose={() => setSelectedAlertId(null)}
        onNavigateOffset={activeAlertIndex >= 0 ? handleStepAlert : undefined}
        onOpenInLiveWagers={handleOpenWagerInTape}
        onOpenCustomerProfile={onSelectCustomer}
      />
    </aside>
  )
}
