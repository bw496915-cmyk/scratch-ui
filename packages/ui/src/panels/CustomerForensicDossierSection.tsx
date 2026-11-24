import {
  AlertTriangle,
  ArrowUpRight,
  Clock,
  GitCompareArrows,
  Network,
  ShieldCheck,
  Ticket,
} from "lucide-react"
import React from "react"

import { formatFreshnessDuration } from "../customer_forensics.ts"
import type {
  CustomerBacktestParlayMetrics,
  CustomerFlaggedTicketForensics,
  CustomerForensicDossier,
} from "../types.ts"

function formatSignedUsd(value: number): string {
  const abs = Math.abs(Math.round(value)).toLocaleString()
  if (value > 0) return `+$${abs}`
  if (value < 0) return `-$${abs}`
  return "$0"
}

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

function formatSignedPct(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`
}

export interface ParlayProtectionImpactPanelProps {
  readonly metrics: CustomerBacktestParlayMetrics
}

/**
 * Displays 4-week CFB/NBA parlay protection economics: baseline unprotected vs. protected desk net,
 * hold swing, desk savings, sport split, and blocked Probit/subset guard attribution.
 */
export function ParlayProtectionImpactPanel({
  metrics,
}: ParlayProtectionImpactPanelProps): React.ReactElement {
  const holdSwingPp = metrics.protectedHoldPct - metrics.baselineHoldPct
  const avgLegsPerTicket =
    metrics.totalParlayTickets > 0
      ? (metrics.totalParlayLegs / metrics.totalParlayTickets).toFixed(2)
      : "—"
  const nbaSavings = metrics.nbaProtectedDeskNetUsd - metrics.nbaBaselineDeskNetUsd
  const cfbSavings = metrics.cfbProtectedDeskNetUsd - metrics.cfbBaselineDeskNetUsd

  return (
    <section
      className="sd-forensic-panel"
      aria-label="4-week parlay protection impact"
      data-forensic-section="parlay-protection"
    >
      <div className="sd-forensic-header">
        <div className="sd-forensic-title-row">
          <ShieldCheck size={14} className="sd-forensic-icon--emerald" aria-hidden="true" />
          <h4 className="sd-forensic-title">4-Week Parlay Protection Impact</h4>
        </div>
        <div className="sd-forensic-meta-line">
          {metrics.rank !== null && (
            <>
              <span>Backtest Rank #{metrics.rank}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <span>
            {metrics.totalParlayTickets} tickets / {metrics.totalParlayLegs} legs (
            {avgLegsPerTicket} avg)
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatUsd(metrics.totalParlayHandleUsd)} handle</span>
          <span aria-hidden="true">·</span>
          <span>+{metrics.avgClvBps} bps CLV</span>
        </div>
      </div>

      {/* 3-Column Financial Delta Strip */}
      <div className="sd-forensic-stat-grid sd-forensic-stat-grid--3">
        <div className="sd-forensic-stat-cell">
          <span className="sd-forensic-stat-label">Baseline Unprotected</span>
          <span
            className={`sd-forensic-stat-val ${metrics.baselineDeskNetUsd < 0 ? "sd-forensic-val--neg" : "sd-forensic-val--pos"}`}
          >
            {formatSignedUsd(metrics.baselineDeskNetUsd)}
          </span>
          <span className="sd-forensic-stat-sub">
            {formatSignedPct(metrics.baselineHoldPct)} desk hold
          </span>
        </div>

        <div className="sd-forensic-stat-cell">
          <span className="sd-forensic-stat-label">Protected Desk Net</span>
          <span
            className={`sd-forensic-stat-val ${metrics.protectedDeskNetUsd >= 0 ? "sd-forensic-val--pos" : "sd-forensic-val--neg"}`}
          >
            {formatSignedUsd(metrics.protectedDeskNetUsd)}
          </span>
          <span className="sd-forensic-stat-sub">
            {formatSignedPct(metrics.protectedHoldPct)} protected hold
          </span>
        </div>

        <div className="sd-forensic-stat-cell">
          <span className="sd-forensic-stat-label">Net Desk Savings</span>
          <span className="sd-forensic-stat-val sd-forensic-val--accent">
            {formatSignedUsd(metrics.deskSavingsUsd)}
          </span>
          <span className="sd-forensic-stat-sub">
            {holdSwingPp >= 0 ? "+" : ""}
            {holdSwingPp.toFixed(2)} pp hold swing
          </span>
        </div>
      </div>

      {/* Sport Breakdown Table */}
      <div className="sd-forensic-table-wrap">
        <table className="sd-forensic-table">
          <thead>
            <tr>
              <th>Sport Cohort</th>
              <th className="sd-forensic-num">Tickets</th>
              <th className="sd-forensic-num">Handle</th>
              <th className="sd-forensic-num">Baseline Net</th>
              <th className="sd-forensic-num">Protected Net</th>
              <th className="sd-forensic-num">Saved</th>
            </tr>
          </thead>
          <tbody>
            {metrics.nbaParlayTickets > 0 && (
              <tr>
                <td>NBA Parlays</td>
                <td className="sd-forensic-num">{metrics.nbaParlayTickets}</td>
                <td className="sd-forensic-num">{formatUsd(metrics.nbaParlayHandleUsd)}</td>
                <td className="sd-forensic-num sd-forensic-val--neg">
                  {formatSignedUsd(metrics.nbaBaselineDeskNetUsd)}
                </td>
                <td className="sd-forensic-num sd-forensic-val--pos">
                  {formatSignedUsd(metrics.nbaProtectedDeskNetUsd)}
                </td>
                <td className="sd-forensic-num sd-forensic-val--accent">
                  {formatSignedUsd(nbaSavings)}
                </td>
              </tr>
            )}
            {metrics.cfbParlayTickets > 0 && (
              <tr>
                <td>CFB Parlays</td>
                <td className="sd-forensic-num">{metrics.cfbParlayTickets}</td>
                <td className="sd-forensic-num">{formatUsd(metrics.cfbParlayHandleUsd)}</td>
                <td className="sd-forensic-num sd-forensic-val--neg">
                  {formatSignedUsd(metrics.cfbBaselineDeskNetUsd)}
                </td>
                <td className="sd-forensic-num sd-forensic-val--pos">
                  {formatSignedUsd(metrics.cfbProtectedDeskNetUsd)}
                </td>
                <td className="sd-forensic-num sd-forensic-val--accent">
                  {formatSignedUsd(cfbSavings)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Guard & Sample Trap Attribution */}
      <div className="sd-forensic-kv-block">
        <div className="sd-forensic-kv-row">
          <span>Primary Guard Triggered</span>
          <code className="sd-forensic-code sd-forensic-val--neg">
            {metrics.primaryGuardTriggered || "—"}
          </code>
        </div>
        <div className="sd-forensic-kv-row">
          <span>Dominant Combo Family</span>
          <code className="sd-forensic-code">
            {metrics.dominantComboFamily}
            {metrics.probitRho !== null ? ` · ρ=${metrics.probitRho.toFixed(3)}` : ""}
          </code>
        </div>
        {metrics.sampleComboSelection && (
          <div className="sd-forensic-sample-line">
            <span className="sd-forensic-sample-label">Blocked Sample</span>
            <span className="sd-forensic-sample-text">{metrics.sampleComboSelection}</span>
          </div>
        )}
      </div>
    </section>
  )
}

export interface ForensicBridgeSummaryCalloutProps {
  readonly dossier: CustomerForensicDossier
  readonly onOpenForensicsTab: () => void
  readonly onJumpToCustomer?: ((customerId: string) => void) | undefined
}

/**
 * Compact, single-elevation alert strip in Overview alerting the operator to an active Cross-Office
 * Beard Bridge or stale Mode 1 telemetry collection gap with one-click drill-through.
 */
export function ForensicBridgeSummaryCallout({
  dossier,
  onOpenForensicsTab,
  onJumpToCustomer,
}: ForensicBridgeSummaryCalloutProps): React.ReactElement | null {
  const bridge = dossier.beardBridge
  const telemetry = dossier.telemetryOverview
  const warningCount = telemetry?.missingDataWarnings.length ?? 0
  if (!bridge && warningCount === 0) return null

  return (
    <div
      className="sd-forensic-callout"
      role="region"
      aria-label="Active forensic bridge and telemetry alerts"
      data-forensic-section="overview-callout"
    >
      <div className="sd-forensic-callout-main">
        <div className="sd-forensic-callout-head">
          <AlertTriangle size={14} className="sd-forensic-icon--amber" aria-hidden="true" />
          <strong>
            {bridge
              ? `Cross-Office Beard Bridge (${bridge.groupId ?? bridge.sharedIpOrSubnet})`
              : "Mode 1 Telemetry Freshness Warning"}
          </strong>
          {bridge?.mfcsCompositeScore !== null && bridge?.mfcsCompositeScore !== undefined && (
            <>
              <span aria-hidden="true">·</span>
              <span className="sd-forensic-mono">MFCS {bridge.mfcsCompositeScore}/100</span>
            </>
          )}
          {warningCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="sd-forensic-val--amber">
                {warningCount} telemetry warning{warningCount === 1 ? "" : "s"}
              </span>
            </>
          )}
        </div>
        <div className="sd-forensic-callout-sub">
          {bridge ? bridge.recommendedDeskAction : telemetry?.missingDataWarnings.join(" · ")}
        </div>
      </div>

      <div className="sd-forensic-callout-actions">
        {bridge?.crossOfficeTwins.map((twin) =>
          onJumpToCustomer ? (
            <button
              key={twin.loginId}
              type="button"
              className="sd-forensic-action-btn"
              onClick={() => onJumpToCustomer(twin.loginId)}
              title={`Inspect linked cross-office twin ${twin.officeAgentId}/${twin.loginId}`}
            >
              <span>
                Twin {twin.loginId} ({twin.officeAgentId})
              </span>
              <ArrowUpRight size={12} aria-hidden="true" />
            </button>
          ) : null,
        )}
        <button
          type="button"
          className="sd-forensic-action-btn sd-forensic-action-btn--primary"
          onClick={onOpenForensicsTab}
        >
          <span>Inspect Bridge &amp; Telemetry</span>
        </button>
      </div>
    </div>
  )
}

export interface ForensicFlaggedTicketsPanelProps {
  readonly tickets: readonly CustomerFlaggedTicketForensics[]
}

/** Displays blocked or normalized forensic tickets from `docs/graph-live-feed.json`. */
export function ForensicFlaggedTicketsPanel({
  tickets,
}: ForensicFlaggedTicketsPanelProps): React.ReactElement | null {
  if (tickets.length === 0) return null

  return (
    <section
      className="sd-forensic-panel"
      aria-label="Forensic flagged tickets"
      data-forensic-section="flagged-tickets"
    >
      <div className="sd-forensic-header">
        <div className="sd-forensic-title-row">
          <Ticket size={14} className="sd-forensic-icon--red" aria-hidden="true" />
          <h4 className="sd-forensic-title">Flagged &amp; Blocked Tickets ({tickets.length})</h4>
        </div>
        <div className="sd-forensic-meta-line">
          <span>Graph Live Feed Surveillance Evidence</span>
        </div>
      </div>

      <div className="sd-forensic-ticket-list">
        {tickets.map((ticket) => (
          <div key={ticket.ticketId} className="sd-forensic-ticket-item">
            <div className="sd-forensic-ticket-top">
              <div className="sd-forensic-ticket-id-row">
                <code className="sd-forensic-code">{ticket.ticketId}</code>
                <span aria-hidden="true">·</span>
                <span>{ticket.sportAndPeriod}</span>
                <span aria-hidden="true">·</span>
                <span className="sd-forensic-mono">{ticket.oddsAmerican}</span>
              </div>
              <div className="sd-forensic-ticket-amounts">
                <span>
                  Risk <b>{formatUsd(ticket.riskUsd)}</b>
                </span>
                <span aria-hidden="true">/</span>
                <span>
                  To Win <b>{formatUsd(ticket.toWinUsd)}</b>
                </span>
              </div>
            </div>

            <div className="sd-forensic-ticket-mid">
              <code className="sd-forensic-code-muted">{ticket.canonicalMarket}</code>
              <span aria-hidden="true">·</span>
              <span>{ticket.pmEntryVsFair}</span>
              <span aria-hidden="true">·</span>
              <span className="sd-forensic-mono">{ticket.placedAtUtc}</span>
            </div>

            <div className="sd-forensic-ticket-verdict">
              <span>Desk Verdict:</span>
              <strong className="sd-forensic-val--neg">{ticket.deskVerdict}</strong>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export interface GraphForensicsDossierPanelProps {
  readonly customerId: string
  readonly dossier: CustomerForensicDossier
  readonly onSelectAgent?: ((agentId: string) => void) | undefined
  readonly onJumpToCustomer?: ((customerId: string) => void) | undefined
  readonly onRunReverseLookup?: ((ipAddress: string) => void) | undefined
}

/**
 * Full 10-Mode Graph Forensics panel rendered inside the Forensics & IP drilldown tab:
 *
 * - Cross-Office Beard Bridge (`perOfficeIpTrackerClusters` + `mode3SharedIpOverview`)
 * - Mode 6 Activity Overlap Non-Overlap Distinction (`mode6ActivityOverlap`)
 * - Mode 1 Telemetry Freshness & Collection Gap Warnings (`mode1CustomerOverview` + `walletProfiles`)
 */
export function GraphForensicsDossierPanel({
  customerId,
  dossier,
  onSelectAgent,
  onJumpToCustomer,
  onRunReverseLookup,
}: GraphForensicsDossierPanelProps): React.ReactElement | null {
  const { beardBridge, activityOverlap, telemetryOverview, parlayBacktest } = dossier
  if (!beardBridge && !activityOverlap && !telemetryOverview) return null

  const walletAddress = telemetryOverview?.polymarketWallet ?? parlayBacktest?.proxyWallet ?? null
  const shortWallet =
    parlayBacktest?.shortWallet ??
    (walletAddress && walletAddress.length > 12
      ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`
      : walletAddress)
  const polymarketUrl =
    telemetryOverview?.polymarketProfileUrl ?? parlayBacktest?.polymarketProfileUrl ?? null
  const polygonscanUrl =
    telemetryOverview?.polygonscanUrl ??
    (walletAddress ? `https://polygonscan.com/address/${walletAddress}` : null)

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {/* 1. Cross-Office Beard Bridge */}
      {beardBridge && (
        <section
          className="sd-forensic-panel"
          aria-label="Cross-office beard bridge forensics"
          data-forensic-section="beard-bridge"
        >
          <div className="sd-forensic-header">
            <div className="sd-forensic-title-row">
              <Network size={14} className="sd-forensic-icon--amber" aria-hidden="true" />
              <h4 className="sd-forensic-title">Cross-Office Beard Bridge</h4>
            </div>
            <div className="sd-forensic-meta-line">
              {beardBridge.groupId && (
                <>
                  <span className="sd-forensic-mono">{beardBridge.groupId}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <span>{beardBridge.matchClassification}</span>
              {beardBridge.dateWindowStartMdy && beardBridge.dateWindowEndMdy && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    {beardBridge.dateWindowStartMdy}–{beardBridge.dateWindowEndMdy}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="sd-forensic-stat-grid sd-forensic-stat-grid--3">
            <div className="sd-forensic-stat-cell">
              <span className="sd-forensic-stat-label">MFCS Composite</span>
              <span className="sd-forensic-stat-val sd-forensic-val--neg">
                {beardBridge.mfcsCompositeScore !== null
                  ? `${beardBridge.mfcsCompositeScore}/100`
                  : "—"}
              </span>
              <span className="sd-forensic-stat-sub">
                {beardBridge.scope ?? "CROSS_OFFICE_GLOBAL"}
              </span>
            </div>

            <div className="sd-forensic-stat-cell">
              <span className="sd-forensic-stat-label">Mode A Dwell</span>
              <span className="sd-forensic-stat-val sd-forensic-val--amber">
                {beardBridge.modeASessionDwellSeconds !== null
                  ? `${beardBridge.modeASessionDwellSeconds.toFixed(1)}s`
                  : "—"}
              </span>
              <span className="sd-forensic-stat-sub">Avg login-to-wager latency</span>
            </div>

            <div className="sd-forensic-stat-cell">
              <span className="sd-forensic-stat-label">Synced Rotations</span>
              <span className="sd-forensic-stat-val">
                {beardBridge.activeRotations.length > 0
                  ? beardBridge.activeRotations.join(", ")
                  : "—"}
              </span>
              <span className="sd-forensic-stat-sub">
                {beardBridge.bridgedPolymarketWallets.length} bridged Polymarket wallet
                {beardBridge.bridgedPolymarketWallets.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <div className="sd-forensic-kv-block">
            <div className="sd-forensic-kv-row">
              <span>Shared IP / Subnet</span>
              <div className="sd-forensic-inline-group">
                <code className="sd-forensic-code">{beardBridge.sharedIpOrSubnet}</code>
                {beardBridge.normalizedIp && onRunReverseLookup && (
                  <button
                    type="button"
                    className="sd-forensic-inline-btn"
                    onClick={() => onRunReverseLookup(beardBridge.normalizedIp!)}
                  >
                    rDNS {beardBridge.normalizedIp}
                  </button>
                )}
              </div>
            </div>

            <div className="sd-forensic-kv-row">
              <span>Linked Cross-Office Twin</span>
              <div className="sd-forensic-inline-group">
                <span className="sd-forensic-mono">
                  {beardBridge.officeAgentId}/{customerId}
                </span>
                <span aria-hidden="true">↔</span>
                {beardBridge.crossOfficeTwins.map((twin) => (
                  <span key={twin.loginId} className="sd-forensic-inline-group">
                    {onSelectAgent ? (
                      <button
                        type="button"
                        className="sd-drilldown-inline-link"
                        onClick={() => onSelectAgent(twin.officeAgentId)}
                        title={`Inspect Agent Conduit ${twin.officeAgentId}`}
                      >
                        {twin.officeAgentId}
                      </button>
                    ) : (
                      <b>{twin.officeAgentId}</b>
                    )}
                    <span>/</span>
                    {onJumpToCustomer ? (
                      <button
                        type="button"
                        className="sd-drilldown-inline-link"
                        onClick={() => onJumpToCustomer(twin.loginId)}
                        title={`Switch profile drilldown to ${twin.loginId}`}
                      >
                        {twin.loginId}
                        <ArrowUpRight size={11} aria-hidden="true" />
                      </button>
                    ) : (
                      <b>{twin.loginId}</b>
                    )}
                  </span>
                ))}
              </div>
            </div>

            <div className="sd-forensic-kv-row">
              <span>Recommended Desk Action</span>
              <span className="sd-forensic-action-summary">
                {beardBridge.recommendedDeskAction}
              </span>
            </div>
          </div>
        </section>
      )}

      {/* 2. Mode 6 Activity Overlap Distinction */}
      {activityOverlap && (
        <section
          className="sd-forensic-panel"
          aria-label="Mode 6 activity overlap distinction"
          data-forensic-section="activity-overlap"
        >
          <div className="sd-forensic-header">
            <div className="sd-forensic-title-row">
              <GitCompareArrows size={14} className="sd-forensic-icon--sky" aria-hidden="true" />
              <h4 className="sd-forensic-title">Mode 6 Activity Overlap Distinction</h4>
            </div>
            <div className="sd-forensic-meta-line">
              <span>{activityOverlap.distinctionVerdict}</span>
              <span aria-hidden="true">·</span>
              <span className="sd-forensic-mono">
                Gap {activityOverlap.gapBetweenWindowsSeconds}s
              </span>
              <span aria-hidden="true">·</span>
              <span className="sd-forensic-mono">
                Session Overlap {activityOverlap.overlapDurationSeconds}s
              </span>
            </div>
          </div>

          <div className="sd-forensic-timeline">
            {[activityOverlap.primaryWindow, activityOverlap.secondaryWindow].map((win, idx) => (
              <div key={`${win.accountId}-${idx}`} className="sd-forensic-timeline-row">
                <div className="sd-forensic-timeline-meta">
                  <span className="sd-forensic-mono">{win.startUtc}</span>
                  <span aria-hidden="true">·</span>
                  <strong>
                    {win.officeAgentId}/{win.accountId}
                  </strong>
                  <span aria-hidden="true">·</span>
                  <code className="sd-forensic-code-muted">{win.ipAddress}</code>
                </div>
                <div className="sd-forensic-timeline-desc">{win.actionSummary}</div>
              </div>
            ))}
          </div>

          {activityOverlap.explanation && (
            <p className="sd-forensic-note">{activityOverlap.explanation}</p>
          )}
        </section>
      )}

      {/* 3. Mode 1 Telemetry Freshness & External Identifiers */}
      {telemetryOverview && (
        <section
          className="sd-forensic-panel"
          aria-label="Mode 1 customer telemetry overview"
          data-forensic-section="mode1-telemetry"
        >
          <div className="sd-forensic-header">
            <div className="sd-forensic-title-row">
              <Clock
                size={14}
                className={
                  telemetryOverview.isAccessFresh
                    ? "sd-forensic-icon--emerald"
                    : "sd-forensic-icon--amber"
                }
                aria-hidden="true"
              />
              <h4 className="sd-forensic-title">Mode 1 Telemetry &amp; Wallet Linkage</h4>
            </div>
            <div className="sd-forensic-meta-line">
              {telemetryOverview.gsLivePlayerId && (
                <>
                  <span className="sd-forensic-mono">{telemetryOverview.gsLivePlayerId}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <span
                className={
                  telemetryOverview.isAccessFresh
                    ? "sd-forensic-val--pos"
                    : "sd-forensic-val--amber"
                }
              >
                {telemetryOverview.isAccessFresh
                  ? "Access telemetry fresh"
                  : `Stale access (${formatFreshnessDuration(telemetryOverview.accessFreshnessSeconds)})`}
              </span>
            </div>
          </div>

          <div className="sd-forensic-stat-grid sd-forensic-stat-grid--3">
            <div className="sd-forensic-stat-cell">
              <span className="sd-forensic-stat-label">Validated Net</span>
              <span className="sd-forensic-stat-val">
                {formatUsd(telemetryOverview.validatedNetUsd)}
              </span>
              <span className="sd-forensic-stat-sub">Mode 8 settled ledger</span>
            </div>

            <div className="sd-forensic-stat-cell">
              <span className="sd-forensic-stat-label">Pending Stake</span>
              <span className="sd-forensic-stat-val sd-forensic-val--amber">
                {formatUsd(telemetryOverview.pendingStakeUsd)}
              </span>
              <span className="sd-forensic-stat-sub">Mode 9 open risk</span>
            </div>

            <div className="sd-forensic-stat-cell">
              <span className="sd-forensic-stat-label">Defined Liability</span>
              <span className="sd-forensic-stat-val sd-forensic-val--neg">
                {formatUsd(telemetryOverview.pendingDefinedLiabilityUsd)}
              </span>
              <span className="sd-forensic-stat-sub">
                Last access {telemetryOverview.lastAccessUtc ?? "—"}
              </span>
            </div>
          </div>

          {telemetryOverview.missingDataWarnings.length > 0 && (
            <div className="sd-forensic-warning-strip" role="status">
              <AlertTriangle size={13} className="sd-forensic-icon--amber" aria-hidden="true" />
              <span>
                Collection Warnings:{" "}
                <strong className="sd-forensic-mono">
                  {telemetryOverview.missingDataWarnings.join(" · ")}
                </strong>
              </span>
            </div>
          )}

          <div className="sd-forensic-kv-block">
            {walletAddress && (
              <div className="sd-forensic-kv-row">
                <span>Polymarket Proxy Wallet</span>
                <code className="sd-forensic-code" title={walletAddress}>
                  {shortWallet}
                </code>
              </div>
            )}
            {telemetryOverview.archetype && (
              <div className="sd-forensic-kv-row">
                <span>Bridge Archetype</span>
                <span>{telemetryOverview.archetype}</span>
              </div>
            )}
          </div>

          <div className="sd-forensic-links-row">
            {telemetryOverview.gsLiveProfileUrl && (
              <a
                href={telemetryOverview.gsLiveProfileUrl}
                target="_blank"
                rel="noreferrer"
                className="sd-forensic-ext-link"
              >
                <span>GSLive Player Report</span>
                <ArrowUpRight size={11} aria-hidden="true" />
              </a>
            )}
            {telemetryOverview.gsLiveBetHistoryUrl && (
              <a
                href={telemetryOverview.gsLiveBetHistoryUrl}
                target="_blank"
                rel="noreferrer"
                className="sd-forensic-ext-link"
              >
                <span>GSLive Bet History</span>
                <ArrowUpRight size={11} aria-hidden="true" />
              </a>
            )}
            {polymarketUrl && (
              <a
                href={polymarketUrl}
                target="_blank"
                rel="noreferrer"
                className="sd-forensic-ext-link"
              >
                <span>Polymarket Profile</span>
                <ArrowUpRight size={11} aria-hidden="true" />
              </a>
            )}
            {polygonscanUrl && (
              <a
                href={polygonscanUrl}
                target="_blank"
                rel="noreferrer"
                className="sd-forensic-ext-link"
              >
                <span>Polygonscan</span>
                <ArrowUpRight size={11} aria-hidden="true" />
              </a>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
