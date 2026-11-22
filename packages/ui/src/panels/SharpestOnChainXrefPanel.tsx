import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Link2,
  ShieldAlert,
  Unlink,
} from "lucide-react"
import React, { useMemo, useState } from "react"

import type {
  OnChainXrefStatus,
  SharpestOnChainXrefReport,
  SharpProfileOnChainXrefRow,
} from "../sharpest_onchain_xref.ts"

function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

function formatSignedUsd(value: number): string {
  const abs = Math.abs(Math.round(value)).toLocaleString()
  if (value > 0) return `+$${abs}`
  if (value < 0) return `-$${abs}`
  return "$0"
}

function statusIcon(status: OnChainXrefStatus): React.ReactElement {
  switch (status) {
    case "DIVERGENCE_ALERT":
      return <ShieldAlert size={12} className="sd-xref-icon--red" aria-hidden="true" />
    case "QUARANTINED_WALLET":
      return <AlertTriangle size={12} className="sd-xref-icon--amber" aria-hidden="true" />
    case "VERIFIED_LIVE":
      return <CheckCircle2 size={12} className="sd-xref-icon--emerald" aria-hidden="true" />
    case "UNLINKED_SHARP":
      return <Unlink size={12} className="sd-xref-icon--muted" aria-hidden="true" />
  }
}

export interface SharpestOnChainXrefPanelProps {
  readonly report: SharpestOnChainXrefReport
  readonly selectedCustomerId?: string | null | undefined
  readonly onSelectCustomerById?: ((customerId: string) => void) | undefined
  readonly onSelectAgent?: ((agentId: string) => void) | undefined
}

type XrefFilter = "ALL" | OnChainXrefStatus

/**
 * Cohort-level audit matrix cross-referencing all Sharpest SportsDesk profiles (score >= 7.0)
 * against live on-chain Polymarket wallet tracking and Cross-Domain Bridge P&L divergence leads.
 */
export function SharpestOnChainXrefPanel({
  report,
  selectedCustomerId = null,
  onSelectCustomerById,
  onSelectAgent,
}: SharpestOnChainXrefPanelProps): React.ReactElement | null {
  const [filter, setFilter] = useState<XrefFilter>("ALL")
  const [collapsed, setCollapsed] = useState(false)

  const filteredRows = useMemo(() => {
    if (filter === "ALL") return report.rows
    return report.rows.filter((row) => row.status === filter)
  }, [report.rows, filter])

  if (report.rows.length === 0) return null

  const { summary } = report
  const filterCounts: Readonly<Record<XrefFilter, number>> = {
    ALL: report.rows.length,
    DIVERGENCE_ALERT: summary.divergenceAlertCount,
    QUARANTINED_WALLET: summary.quarantinedCount,
    VERIFIED_LIVE: summary.verifiedLiveCount,
    UNLINKED_SHARP: summary.unlinkedCount,
  }

  return (
    <section
      className="sd-xref-section"
      aria-label="Sharpest profiles to on-chain wager tracking cross-reference"
      data-sharpest-onchain-xref="true"
    >
      <div className="sd-xref-header">
        <div className="sd-xref-header-left">
          <div className="sd-xref-title-row">
            <Link2 size={15} className="sd-xref-icon--sky" aria-hidden="true" />
            <h3 className="sd-xref-title">
              Sharpest Profiles × On-Chain Wager Tracking Cross-Reference
            </h3>
          </div>
          <div className="sd-xref-meta-line">
            <span>
              Sharp threshold ≥ {summary.sharpThreshold.toFixed(1)} ({summary.totalSharpProfiles}{" "}
              accounts)
            </span>
            <span aria-hidden="true">·</span>
            <span>
              On-chain attribution {summary.linkedSharpCount}/{summary.totalSharpProfiles} (
              {summary.coveragePct.toFixed(1)}%)
            </span>
            {summary.bridgeEvidence && (
              <>
                <span aria-hidden="true">·</span>
                <span>Bridge feed {summary.bridgeEvidence}</span>
              </>
            )}
          </div>
        </div>

        <button
          type="button"
          className="sd-xref-collapse-btn"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <>
              <span>Expand Cross-Reference</span>
              <ChevronDown size={13} aria-hidden="true" />
            </>
          ) : (
            <>
              <span>Collapse</span>
              <ChevronUp size={13} aria-hidden="true" />
            </>
          )}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* 4-Column Tabular Summary Strip */}
          <div className="sd-xref-kpi-strip">
            <div className="sd-xref-kpi-cell">
              <span className="sd-xref-kpi-label">Divergence Alerts</span>
              <span
                className={`sd-xref-kpi-val ${summary.divergenceAlertCount > 0 ? "sd-xref-val--neg" : ""}`}
              >
                {summary.divergenceAlertCount}
              </span>
              <span className="sd-xref-kpi-sub">
                {formatUsd(summary.totalBridgePriorityUsd)} bridge priority ·{" "}
                {summary.sharedWalletAccountCount} shared wallet
              </span>
            </div>

            <div className="sd-xref-kpi-cell">
              <span className="sd-xref-kpi-label">Verified Live On-Chain</span>
              <span className="sd-xref-kpi-val sd-xref-val--pos">
                {summary.verifiedLiveCount + summary.divergenceAlertCount}
              </span>
              <span className="sd-xref-kpi-sub">
                {formatUsd(summary.totalOnChainVolumeUsd)} open vol ·{" "}
                {formatUsd(summary.totalPositionsValueUsd)} positions
              </span>
            </div>

            <div className="sd-xref-kpi-cell">
              <span className="sd-xref-kpi-label">Quarantined Wallets</span>
              <span
                className={`sd-xref-kpi-val ${summary.quarantinedCount > 0 ? "sd-xref-val--amber" : ""}`}
              >
                {summary.quarantinedCount}
              </span>
              <span className="sd-xref-kpi-sub">Invalid EVM address or fixture-only mapping</span>
            </div>

            <div className="sd-xref-kpi-cell">
              <span className="sd-xref-kpi-label">Unlinked Blind Spots</span>
              <span className="sd-xref-kpi-val">{summary.unlinkedCount}</span>
              <span className="sd-xref-kpi-sub">Sharp accounts with zero on-chain attribution</span>
            </div>
          </div>

          {/* Interactive Status Filter Bar */}
          <div
            className="sd-xref-filter-bar"
            role="tablist"
            aria-label="Cross-reference status filter"
          >
            {(
              [
                { id: "ALL", label: "All Sharpest" },
                { id: "DIVERGENCE_ALERT", label: "Divergence Alerts" },
                { id: "QUARANTINED_WALLET", label: "Quarantined" },
                { id: "VERIFIED_LIVE", label: "Verified Live" },
                { id: "UNLINKED_SHARP", label: "Unlinked Blind Spots" },
              ] as const
            ).map((tab) => {
              const active = filter === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setFilter(tab.id)}
                  className={`sd-xref-filter-btn${active ? " sd-xref-filter-btn--active" : ""}`}
                >
                  <span>{tab.label}</span>
                  <span className="sd-xref-filter-count">{filterCounts[tab.id]}</span>
                </button>
              )
            })}
          </div>

          {/* High-Density Cross-Reference Table */}
          <div className="sd-xref-table-wrap">
            <table className="sd-xref-table">
              <thead>
                <tr>
                  <th>Sharpest Profile</th>
                  <th>Cross-Ref Status</th>
                  <th>On-Chain Wallet Integrity</th>
                  <th className="sd-xref-num">On-Chain Volume &amp; Positions</th>
                  <th className="sd-xref-num">Cross-Domain P&amp;L (Desk vs Poly)</th>
                  <th className="sd-xref-num">Tracked Wagers</th>
                  <th>Proof</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const isSelected =
                    selectedCustomerId !== null &&
                    selectedCustomerId !== undefined &&
                    selectedCustomerId.toUpperCase() === row.customerId.toUpperCase()
                  return (
                    <tr
                      key={row.customerId}
                      className={isSelected ? "sd-xref-row--selected" : undefined}
                      onClick={() => onSelectCustomerById?.(row.customerId)}
                    >
                      <td>
                        <div className="sd-xref-primary-cell">
                          <button
                            type="button"
                            className="sd-xref-id-btn"
                            onClick={(e) => {
                              e.stopPropagation()
                              onSelectCustomerById?.(row.customerId)
                            }}
                          >
                            {row.customerId}
                          </button>
                          <span className="sd-xref-score">{row.sharpScore.toFixed(1)}</span>
                        </div>
                        <div className="sd-xref-sub-line">
                          {onSelectAgent ? (
                            <button
                              type="button"
                              className="sd-drilldown-inline-link"
                              onClick={(e) => {
                                e.stopPropagation()
                                onSelectAgent(row.agentId)
                              }}
                            >
                              {row.agentId}
                            </button>
                          ) : (
                            <span>{row.agentId}</span>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>{row.holdKnown ? `${row.holdPct}% hold` : "Hold —"}</span>
                        </div>
                      </td>

                      <td>
                        <div
                          className={`sd-xref-status sd-xref-status--${row.status.toLowerCase()}`}
                        >
                          {statusIcon(row.status)}
                          <span>{row.statusLabel}</span>
                        </div>
                        <div className="sd-xref-sub-line">
                          <span>
                            {row.checksPassed}/{row.checksTotal} checks
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{row.dataSource}</span>
                        </div>
                      </td>

                      <td>
                        {row.proxyWallet ? (
                          <>
                            <div className="sd-xref-wallet-line">
                              <code className="sd-xref-code" title={row.proxyWallet}>
                                {row.shortWallet}
                              </code>
                              {!row.walletFormatValid || row.walletAddressValid === false ? (
                                <span className="sd-xref-val--amber">
                                  Invalid ({row.proxyWallet.length - 2} hex)
                                </span>
                              ) : row.walletSourceMismatch ? (
                                <span className="sd-xref-val--neg">Source mismatch</span>
                              ) : (
                                <span className="sd-xref-val--pos">Valid EVM</span>
                              )}
                            </div>
                            {row.sharedWithCustomerIds.length > 0 ? (
                              <div className="sd-xref-sub-line sd-xref-val--amber">
                                <span>Shared w/</span>
                                {row.sharedWithCustomerIds.map((peer) => (
                                  <button
                                    key={peer}
                                    type="button"
                                    className="sd-drilldown-inline-link"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      onSelectCustomerById?.(peer)
                                    }}
                                  >
                                    {peer}
                                  </button>
                                ))}
                              </div>
                            ) : row.lastError ? (
                              <div className="sd-xref-sub-line sd-xref-val--amber">
                                {row.lastError}
                              </div>
                            ) : row.enforcementStatus ? (
                              <div className="sd-xref-sub-line">{row.enforcementStatus}</div>
                            ) : null}
                          </>
                        ) : (
                          <div className="sd-xref-sub-line">No proxy wallet mapped</div>
                        )}
                      </td>

                      <td className="sd-xref-num">
                        {row.dataSource === "LIVE" ? (
                          <>
                            <div className="sd-xref-mono-strong">
                              {formatUsd(row.openVolumeUsd)}
                            </div>
                            <div className="sd-xref-sub-line sd-xref-sub-line--right">
                              <span>{row.openLegsCount} legs</span>
                              <span aria-hidden="true">·</span>
                              <span>Pos {formatUsd(row.positionsValueUsd)}</span>
                            </div>
                          </>
                        ) : (
                          <span className="sd-xref-muted">—</span>
                        )}
                      </td>

                      <td className="sd-xref-num">
                        {row.bridgeVerdict ? (
                          <>
                            <div className="sd-xref-mono-strong">
                              <span className="sd-xref-val--neg">
                                {formatSignedUsd(row.bridgeDeskPnlUsd ?? 0)}
                              </span>
                              <span className="sd-xref-muted"> / </span>
                              <span
                                className={
                                  (row.bridgePolyPnlUsd ?? 0) >= 0
                                    ? "sd-xref-val--pos"
                                    : "sd-xref-val--neg"
                                }
                              >
                                {formatSignedUsd(row.bridgePolyPnlUsd ?? 0)}
                              </span>
                            </div>
                            <div className="sd-xref-sub-line sd-xref-sub-line--right">
                              <span
                                className={
                                  row.bridgeVerdict === "POLY_ONLY_UP"
                                    ? "sd-xref-val--neg"
                                    : undefined
                                }
                              >
                                {row.bridgeVerdict}
                              </span>
                              {row.bridgePriorityUsd > 0 && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span>{formatUsd(row.bridgePriorityUsd)} pri</span>
                                </>
                              )}
                            </div>
                          </>
                        ) : row.dataSource === "LIVE" && row.openPnlUsd !== 0 ? (
                          <>
                            <div
                              className={
                                row.openPnlUsd >= 0 ? "sd-xref-val--pos" : "sd-xref-val--neg"
                              }
                            >
                              {formatSignedUsd(row.openPnlUsd)} open
                            </div>
                            <div className="sd-xref-sub-line sd-xref-sub-line--right">
                              No bridge lead
                            </div>
                          </>
                        ) : (
                          <span className="sd-xref-muted">—</span>
                        )}
                      </td>

                      <td className="sd-xref-num">
                        {row.trackedTicketCount > 0 ? (
                          <>
                            <div className="sd-xref-mono-strong">
                              {formatUsd(row.trackedTicketRiskUsd)}
                            </div>
                            <div className="sd-xref-sub-line sd-xref-sub-line--right">
                              {row.trackedTicketCount} ticket
                              {row.trackedTicketCount === 1 ? "" : "s"}
                            </div>
                          </>
                        ) : (
                          <span className="sd-xref-muted">0</span>
                        )}
                      </td>

                      <td>
                        <div className="sd-xref-proof-links" onClick={(e) => e.stopPropagation()}>
                          {row.polymarketProfileUrl && row.walletFormatValid ? (
                            <a
                              href={row.polymarketProfileUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="sd-forensic-ext-link"
                              title="Open Polymarket profile"
                            >
                              <span>Poly</span>
                              <ArrowUpRight size={10} aria-hidden="true" />
                            </a>
                          ) : null}
                          {row.polygonscanUrl && row.walletFormatValid ? (
                            <a
                              href={row.polygonscanUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="sd-forensic-ext-link"
                              title="Verify address on Polygonscan"
                            >
                              <span>Scan</span>
                              <ArrowUpRight size={10} aria-hidden="true" />
                            </a>
                          ) : null}
                          {!row.walletFormatValid && <span className="sd-xref-muted">—</span>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="sd-xref-empty">
                      No sharpest profiles match the selected cross-reference filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

export interface ProfileOnChainXrefCardProps {
  readonly xref: SharpProfileOnChainXrefRow
  readonly onJumpToCustomer?: ((customerId: string) => void) | undefined
}

/**
 * Per-profile on-chain wager tracking cross-reference audit card rendered inside
 * the Profile Drilldown Forensics tab.
 */
export function ProfileOnChainXrefCard({
  xref,
  onJumpToCustomer,
}: ProfileOnChainXrefCardProps): React.ReactElement {
  const walletCheckOk = Boolean(
    xref.proxyWallet && xref.walletFormatValid && xref.walletAddressValid !== false,
  )
  const liveSyncOk = xref.dataSource === "LIVE" && !xref.lastError
  const uniqueWalletOk =
    Boolean(xref.proxyWallet) &&
    xref.sharedWithCustomerIds.length === 0 &&
    !xref.walletSourceMismatch
  const bridgeClear = xref.bridgeVerdict !== "POLY_ONLY_UP"

  return (
    <section
      className="sd-forensic-panel"
      aria-label="On-chain wager tracking cross-reference check"
      data-forensic-section="onchain-xref"
    >
      <div className="sd-forensic-header">
        <div className="sd-forensic-title-row">
          {statusIcon(xref.status)}
          <h4 className="sd-forensic-title">On-Chain Wager Tracking Cross-Reference</h4>
        </div>
        <div className="sd-forensic-meta-line">
          <span className={`sd-xref-status-inline sd-xref-status--${xref.status.toLowerCase()}`}>
            {xref.statusLabel}
          </span>
          <span aria-hidden="true">·</span>
          <span className="sd-forensic-mono">
            {xref.checksPassed}/{xref.checksTotal} checks passed
          </span>
          <span aria-hidden="true">·</span>
          <span>Source: {xref.dataSource}</span>
        </div>
      </div>

      {/* 4 Explicit Cross-Reference Verification Checks */}
      <div className="sd-xref-check-list">
        <div className="sd-xref-check-row">
          <span className="sd-xref-check-label">
            {walletCheckOk ? (
              <CheckCircle2 size={12} className="sd-xref-icon--emerald" aria-hidden="true" />
            ) : (
              <AlertTriangle size={12} className="sd-xref-icon--amber" aria-hidden="true" />
            )}
            <span>EVM Wallet Format &amp; Registry</span>
          </span>
          <span className="sd-xref-check-val">
            {xref.proxyWallet ? (
              <>
                <code className="sd-forensic-code" title={xref.proxyWallet}>
                  {xref.shortWallet}
                </code>{" "}
                <span className={walletCheckOk ? "sd-xref-val--pos" : "sd-xref-val--amber"}>
                  {walletCheckOk
                    ? "Verified 40-hex EVM"
                    : `Quarantined (${xref.lastError ?? "invalid format"})`}
                </span>
              </>
            ) : (
              <span className="sd-xref-muted">Unmapped (no proxy wallet)</span>
            )}
          </span>
        </div>

        <div className="sd-xref-check-row">
          <span className="sd-xref-check-label">
            {liveSyncOk ? (
              <CheckCircle2 size={12} className="sd-xref-icon--emerald" aria-hidden="true" />
            ) : (
              <Unlink size={12} className="sd-xref-icon--muted" aria-hidden="true" />
            )}
            <span>Live Polymarket Position Tracking</span>
          </span>
          <span className="sd-xref-check-val sd-forensic-mono">
            {liveSyncOk ? (
              <>
                {formatUsd(xref.openVolumeUsd)} vol · {xref.openLegsCount} legs · Pos{" "}
                {formatUsd(xref.positionsValueUsd)}
              </>
            ) : (
              <span className="sd-xref-muted">
                {xref.dataSource === "FIXTURE"
                  ? "Fixture-only (untracked live)"
                  : "Not tracked live"}
              </span>
            )}
          </span>
        </div>

        <div className="sd-xref-check-row">
          <span className="sd-xref-check-label">
            {uniqueWalletOk ? (
              <CheckCircle2 size={12} className="sd-xref-icon--emerald" aria-hidden="true" />
            ) : xref.sharedWithCustomerIds.length > 0 || xref.walletSourceMismatch ? (
              <ShieldAlert size={12} className="sd-xref-icon--red" aria-hidden="true" />
            ) : (
              <Unlink size={12} className="sd-xref-icon--muted" aria-hidden="true" />
            )}
            <span>Wallet Uniqueness &amp; Source Parity</span>
          </span>
          <span className="sd-xref-check-val">
            {xref.sharedWithCustomerIds.length > 0 ? (
              <span className="sd-forensic-inline-group">
                <span className="sd-xref-val--amber">Shared with</span>
                {xref.sharedWithCustomerIds.map((peer) =>
                  onJumpToCustomer ? (
                    <button
                      key={peer}
                      type="button"
                      className="sd-drilldown-inline-link"
                      onClick={() => onJumpToCustomer(peer)}
                    >
                      {peer}
                      <ArrowUpRight size={10} aria-hidden="true" />
                    </button>
                  ) : (
                    <b key={peer}>{peer}</b>
                  ),
                )}
              </span>
            ) : xref.walletSourceMismatch ? (
              <span className="sd-xref-val--neg">Mismatch across backtest / live feed</span>
            ) : xref.proxyWallet ? (
              <span className="sd-xref-val--pos">Unique across cohort</span>
            ) : (
              <span className="sd-xref-muted">—</span>
            )}
          </span>
        </div>

        <div className="sd-xref-check-row">
          <span className="sd-xref-check-label">
            {bridgeClear ? (
              <CheckCircle2 size={12} className="sd-xref-icon--emerald" aria-hidden="true" />
            ) : (
              <ShieldAlert size={12} className="sd-xref-icon--red" aria-hidden="true" />
            )}
            <span>Cross-Domain P&amp;L Bridge Parity</span>
          </span>
          <span className="sd-xref-check-val sd-forensic-mono">
            {xref.bridgeVerdict ? (
              <>
                <span className={bridgeClear ? undefined : "sd-xref-val--neg"}>
                  {xref.bridgeVerdict}
                </span>{" "}
                · Desk {formatSignedUsd(xref.bridgeDeskPnlUsd ?? 0)} vs Poly{" "}
                {formatSignedUsd(xref.bridgePolyPnlUsd ?? 0)}
                {xref.bridgePriorityUsd > 0 ? ` (${formatUsd(xref.bridgePriorityUsd)} pri)` : ""}
              </>
            ) : (
              <span className="sd-xref-muted">No bridge divergence alert</span>
            )}
          </span>
        </div>
      </div>

      {xref.openBetsSummary && xref.dataSource === "LIVE" && (
        <div className="sd-forensic-sample-line">
          <span className="sd-forensic-sample-label">Tracked On-Chain Open Positions</span>
          <span className="sd-forensic-sample-text">{xref.openBetsSummary}</span>
        </div>
      )}

      {xref.walletFormatValid &&
        (xref.polymarketProfileUrl || xref.polygonscanUrl || xref.polymarketPositionsApiUrl) && (
          <div className="sd-forensic-links-row">
            {xref.polymarketProfileUrl && (
              <a
                href={xref.polymarketProfileUrl}
                target="_blank"
                rel="noreferrer"
                className="sd-forensic-ext-link"
              >
                <span>Polymarket Profile</span>
                <ArrowUpRight size={11} aria-hidden="true" />
              </a>
            )}
            {xref.polymarketPositionsApiUrl && (
              <a
                href={xref.polymarketPositionsApiUrl}
                target="_blank"
                rel="noreferrer"
                className="sd-forensic-ext-link"
              >
                <span>Positions API JSON</span>
                <ArrowUpRight size={11} aria-hidden="true" />
              </a>
            )}
            {xref.polygonscanUrl && (
              <a
                href={xref.polygonscanUrl}
                target="_blank"
                rel="noreferrer"
                className="sd-forensic-ext-link"
              >
                <span>Polygonscan</span>
                <ArrowUpRight size={11} aria-hidden="true" />
              </a>
            )}
          </div>
        )}
    </section>
  )
}
