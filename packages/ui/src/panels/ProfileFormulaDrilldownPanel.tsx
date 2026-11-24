/**
 * Deep quantitative formula & countermeasure drill-downs for Profiled Bettors:
 *
 * - Interactive 5-axis sharpness conservation & input attribution audit
 * - Cohort percentile benchmarking & concrete risk-driver attribution strip
 * - Empirical Beta-Binomial Bayesian skill & fractional Kelly credible-interval bar
 * - Desk exposure / CVaR tail severity & Countermeasure Policy Gap matrix
 * - Live What-If Countermeasure Simulator + Nearest Peer Cohort pivot list
 *
 * @file Packages/ui/src/panels/ProfileFormulaDrilldownPanel.tsx
 */

import {
  ArrowUpRight,
  Calculator,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  RotateCcw,
  ShieldAlert,
  Sliders,
  Terminal,
  Users,
} from "lucide-react"
import React, { useEffect, useMemo, useState } from "react"

import { copyText } from "../clipboard.ts"
import {
  BREAKEVEN_PROB_MINUS_110,
  type CountermeasureSimulationParams,
  type ProfileQuantitativeModel,
  simulateCountermeasureImpact,
} from "../profile_formulas.ts"
import type { ProfileAxisKey, ProfileTypeSpec, ShowcaseCustomer } from "../types.ts"

export interface OverviewFormulaAuditStripProps {
  readonly customer: ShowcaseCustomer
  readonly model: ProfileQuantitativeModel
  readonly typeSpec: ProfileTypeSpec
  readonly onNavigateTab: (tab: "overview" | "formulas" | "activity" | "reconciliation") => void
}

/**
 * Compact Cohort Benchmark + Risk Drivers + Expandable 5-Axis Formula Inspector rendered inside the
 * Overview drilldown tab.
 */
export function OverviewFormulaAuditStrip({
  customer,
  model,
  typeSpec,
  onNavigateTab,
}: OverviewFormulaAuditStripProps): React.ReactElement {
  const [expandedAxis, setExpandedAxis] = useState<ProfileAxisKey | null>(null)
  const { benchmark, riskDrivers, axes, isConserved, axisSum, conservationDelta } = model

  return (
    <div className="sd-formula-stack" data-formula-overview="true">
      {/* Cohort Percentile & Archetype Posture Strip */}
      <div className="sd-formula-card">
        <div className="sd-formula-card__header">
          <span className="sd-formula-card__title">Cohort Benchmark &amp; Archetype Posture</span>
          <button
            type="button"
            className="sd-drilldown-inline-link"
            onClick={() => onNavigateTab("formulas")}
          >
            Open Formulas &amp; Sim <ArrowUpRight size={11} aria-hidden="true" />
          </button>
        </div>

        <div className="sd-formula-bench-grid">
          <div className="sd-formula-bench-cell">
            <span className="sd-formula-bench-label">Sharpness Rank</span>
            <strong className="sd-formula-bench-val sd-tabular">
              {benchmark.scorePercentile !== null ? `P${benchmark.scorePercentile}` : "—"}
            </strong>
            <span className="sd-formula-bench-sub sd-tabular">
              {benchmark.scoreRank !== null
                ? `#${benchmark.scoreRank} / ${benchmark.measuredScoreCount}`
                : "Unranked"}
            </span>
          </div>

          <div className="sd-formula-bench-cell">
            <span className="sd-formula-bench-label">Δ vs Cohort Med</span>
            <strong
              className="sd-formula-bench-val sd-tabular"
              style={{
                color:
                  benchmark.deltaFromMedianScore === null
                    ? "#94a3b8"
                    : benchmark.deltaFromMedianScore > 1.5
                      ? "#f87171"
                      : benchmark.deltaFromMedianScore > 0
                        ? "#fbbf24"
                        : "#4ade80",
              }}
            >
              {benchmark.deltaFromMedianScore !== null
                ? `${benchmark.deltaFromMedianScore >= 0 ? "+" : ""}${benchmark.deltaFromMedianScore.toFixed(2)}`
                : "—"}
            </strong>
            <span className="sd-formula-bench-sub sd-tabular">
              Med {benchmark.cohortMedianScore?.toFixed(1) ?? "—"} · P90{" "}
              {benchmark.cohortP90Score?.toFixed(1) ?? "—"}
            </span>
          </div>

          <div className="sd-formula-bench-cell">
            <span className="sd-formula-bench-label">Bayesian P(&gt;BE)</span>
            <strong
              className="sd-formula-bench-val sd-tabular"
              style={{
                color:
                  model.bayesian === null
                    ? "#94a3b8"
                    : model.bayesian.probAboveBreakeven >= 0.7
                      ? "#f87171"
                      : model.bayesian.probAboveBreakeven >= 0.55
                        ? "#fbbf24"
                        : "#4ade80",
              }}
            >
              {model.bayesian ? `${Math.round(model.bayesian.probAboveBreakeven * 100)}%` : "—"}
            </strong>
            <span className="sd-formula-bench-sub sd-tabular">
              {model.bayesian
                ? `${model.bayesian.impliedEdgePct >= 0 ? "+" : ""}${model.bayesian.impliedEdgePct.toFixed(2)}% EV`
                : "Unmeasured"}
            </span>
          </div>

          <div className="sd-formula-bench-cell">
            <span className="sd-formula-bench-label">Archetype Target</span>
            <strong className="sd-formula-bench-val sd-tabular" style={{ color: typeSpec.fg }}>
              {typeSpec.riskBand}
            </strong>
            <span className="sd-formula-bench-sub sd-tabular">
              {typeSpec.defaultDelaySec}s delay · {typeSpec.defaultShadeCents}¢ shade ·{" "}
              {typeSpec.limitMultiplier}× cap
            </span>
          </div>
        </div>

        {/* Weighted Risk Drivers */}
        {riskDrivers.length > 0 && (
          <div className="sd-driver-list" data-risk-drivers="true">
            {riskDrivers.map((driver) => (
              <button
                key={driver.id}
                type="button"
                className={`sd-driver-row sd-driver-row--${driver.severity}`}
                onClick={() => onNavigateTab(driver.targetTab)}
                title={`${driver.formulaNote} (click to inspect ${driver.targetTab})`}
              >
                <div className="sd-driver-row__main">
                  <span className="sd-driver-row__label">{driver.label}</span>
                  <span className="sd-driver-row__note">{driver.formulaNote}</span>
                </div>
                <div className="sd-driver-row__metric sd-tabular">
                  <strong>{driver.metricDisplay}</strong>
                  <span>{driver.thresholdDisplay}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Expandable 5-Axis Formula Conservation Inspector */}
      <div className="sd-formula-card" data-axis-formula-audit="true">
        <div className="sd-formula-card__header">
          <span className="sd-formula-card__title">5-Axis Formula Conservation Audit</span>
          <span
            className="sd-tabular"
            style={{
              fontSize: "10.5px",
              fontWeight: 600,
              color: isConserved ? "#4ade80" : "#fbbf24",
            }}
          >
            Σ {axisSum.toFixed(2)} / {customer.score.toFixed(2)}{" "}
            {isConserved ? "(Δ 0.00 conserved)" : `(Δ ${conservationDelta.toFixed(2)})`}
          </span>
        </div>

        <div className="sd-axis-audit-list">
          {axes.map((axis) => {
            const isOpen = expandedAxis === axis.key
            return (
              <div key={axis.key} className="sd-axis-audit-item">
                <button
                  type="button"
                  className="sd-axis-audit-row"
                  aria-expanded={isOpen}
                  onClick={() => setExpandedAxis(isOpen ? null : axis.key)}
                >
                  <span className="sd-axis-audit-row__name">
                    {isOpen ? (
                      <ChevronDown size={11} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={11} aria-hidden="true" />
                    )}
                    <span>{axis.label}</span>
                  </span>
                  <span className="sd-axis-audit-row__bar" aria-hidden="true">
                    <span
                      className="sd-axis-audit-row__fill"
                      style={{
                        width: `${Math.max(2, axis.utilizationPct)}%`,
                        backgroundColor:
                          axis.utilizationPct >= 80
                            ? "#f87171"
                            : axis.utilizationPct >= 55
                              ? "#fbbf24"
                              : "#38bdf8",
                      }}
                    />
                  </span>
                  <span className="sd-axis-audit-row__val sd-tabular">
                    {axis.value.toFixed(2)} / {axis.cap.toFixed(1)} ({axis.utilizationPct}%)
                  </span>
                </button>
                {isOpen && (
                  <div className="sd-axis-audit-detail">
                    <div>
                      <span className="sd-axis-audit-detail__k">Observed input:</span>{" "}
                      <span className="sd-tabular">{axis.observedInput}</span>
                    </div>
                    <div>
                      <span className="sd-axis-audit-detail__k">Formula:</span>{" "}
                      <code>{axis.formulaSummary}</code>
                    </div>
                    <div>
                      <span className="sd-axis-audit-detail__k">Share of composite:</span>{" "}
                      <span className="sd-tabular">{axis.shareOfTotalPct}%</span>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export interface ProfileFormulaDrilldownPanelProps {
  readonly customer: ShowcaseCustomer
  readonly model: ProfileQuantitativeModel
  readonly typeSpec: ProfileTypeSpec
  readonly onSelectCustomerById?: ((customerId: string) => void) | undefined
  readonly onRunTerminalCommand?: ((cmd: string) => void) | undefined
}

/** Full "Formulas & Sim" drilldown tab inside the Profiled Bettors inspector. */
export function ProfileFormulaDrilldownPanel({
  customer,
  model,
  typeSpec,
  onSelectCustomerById,
  onRunTerminalCommand,
}: ProfileFormulaDrilldownPanelProps): React.ReactElement {
  const { bayesian, exposure, nearestPeers } = model
  const [showEquation, setShowEquation] = useState(false)
  const [copiedPolicy, setCopiedPolicy] = useState(false)

  const defaultCap =
    exposure.hasMeasuredLimit && customer.recommendedLimitUsd > 0
      ? customer.recommendedLimitUsd
      : exposure.suggestedCapUsd
  const [simParams, setSimParams] = useState<CountermeasureSimulationParams>({
    limitCapUsd: exposure.suggestedCapUsd,
    lineShadeCents: exposure.suggestedShadeCents,
    inPlayDelaySec: exposure.suggestedDelaySec,
    probitBlockEnabled:
      customer.correlatedRisk === "CRITICAL" ||
      (customer.forensicDossier?.parlayBacktest?.probitRho ?? 0) >= 0.65,
  })

  // Reset simulator defaults whenever the operator selects a different customer
  useEffect(() => {
    setSimParams({
      limitCapUsd: exposure.suggestedCapUsd,
      lineShadeCents: exposure.suggestedShadeCents,
      inPlayDelaySec: exposure.suggestedDelaySec,
      probitBlockEnabled:
        customer.correlatedRisk === "CRITICAL" ||
        (customer.forensicDossier?.parlayBacktest?.probitRho ?? 0) >= 0.65,
    })
  }, [
    customer.id,
    customer.correlatedRisk,
    customer.forensicDossier?.parlayBacktest?.probitRho,
    exposure.suggestedCapUsd,
    exposure.suggestedShadeCents,
    exposure.suggestedDelaySec,
  ])

  const simulation = useMemo(
    () => simulateCountermeasureImpact(customer, bayesian, exposure, simParams),
    [customer, bayesian, exposure, simParams],
  )

  const maxCapSlider = Math.max(
    10_000,
    Math.ceil(Math.max(defaultCap, exposure.suggestedCapUsd, customer.meanStake * 3) / 500) * 500,
  )

  const handleCopyPolicy = async () => {
    await copyText(exposure.recommendedCliCommand)
    setCopiedPolicy(true)
    setTimeout(() => setCopiedPolicy(false), 1800)
  }

  // Credible interval bar coordinates mapped across [0.35, 0.70] probability scale
  const ciDomainMin = 0.35
  const ciDomainMax = 0.7
  const toPct = (prob: number) =>
    Math.min(100, Math.max(0, ((prob - ciDomainMin) / (ciDomainMax - ciDomainMin)) * 100))

  return (
    <div className="sd-formula-stack" data-formula-drilldown-tab="true">
      {/* 1. Empirical Bayesian Skill & Fractional Kelly Criterion */}
      <div className="sd-formula-card">
        <div className="sd-formula-card__header">
          <span className="sd-formula-card__title">
            <Calculator size={12} aria-hidden="true" />
            <span>Bayesian Skill Posterior &amp; Kelly Sizing</span>
          </span>
          {bayesian && (
            <button
              type="button"
              className="sd-drilldown-inline-link"
              onClick={() => setShowEquation((v) => !v)}
            >
              {showEquation ? "Hide Equation" : "Show Equation"}
            </button>
          )}
        </div>

        {bayesian ? (
          <>
            <div className="sd-formula-bench-grid">
              <div className="sd-formula-bench-cell">
                <span className="sd-formula-bench-label">Posterior Win %</span>
                <strong
                  className="sd-formula-bench-val sd-tabular"
                  style={{
                    color:
                      bayesian.posteriorWinRate > BREAKEVEN_PROB_MINUS_110 ? "#f87171" : "#4ade80",
                  }}
                >
                  {(bayesian.posteriorWinRate * 100).toFixed(2)}%
                </strong>
                <span className="sd-formula-bench-sub sd-tabular">
                  95% CI [{(bayesian.ciLow95 * 100).toFixed(1)}%,{" "}
                  {(bayesian.ciHigh95 * 100).toFixed(1)}%]
                </span>
              </div>

              <div className="sd-formula-bench-cell">
                <span className="sd-formula-bench-label">P(True Win &gt; BE)</span>
                <strong
                  className="sd-formula-bench-val sd-tabular"
                  style={{
                    color:
                      bayesian.probAboveBreakeven >= 0.75
                        ? "#f87171"
                        : bayesian.probAboveBreakeven >= 0.55
                          ? "#fbbf24"
                          : "#4ade80",
                  }}
                >
                  {(bayesian.probAboveBreakeven * 100).toFixed(1)}%
                </strong>
                <span className="sd-formula-bench-sub sd-tabular">vs 52.38% (-110 vig)</span>
              </div>

              <div className="sd-formula-bench-cell">
                <span className="sd-formula-bench-label">Implied Edge @ -110</span>
                <strong
                  className="sd-formula-bench-val sd-tabular"
                  style={{ color: bayesian.impliedEdgePct > 0 ? "#f87171" : "#4ade80" }}
                >
                  {bayesian.impliedEdgePct >= 0 ? "+" : ""}
                  {bayesian.impliedEdgePct.toFixed(2)}%
                </strong>
                <span className="sd-formula-bench-sub sd-tabular">
                  EV/bet{" "}
                  {bayesian.evPerBetUsd !== 0
                    ? `${bayesian.evPerBetUsd >= 0 ? "+" : "-"}$${Math.abs(bayesian.evPerBetUsd).toLocaleString()}`
                    : "—"}
                </span>
              </div>

              <div className="sd-formula-bench-cell">
                <span className="sd-formula-bench-label">¼ Kelly / Full Kelly</span>
                <strong className="sd-formula-bench-val sd-tabular">
                  {(bayesian.quarterKellyFraction * 100).toFixed(2)}%
                </strong>
                <span className="sd-formula-bench-sub sd-tabular">
                  Full {(bayesian.fullKellyFraction * 100).toFixed(2)}% · Unit $
                  {bayesian.quarterKellyStakeUsd.toLocaleString()}
                </span>
              </div>
            </div>

            {/* 95% Credible Interval Visual Bar vs 52.38% Breakeven */}
            <div className="sd-ci-wrap" aria-label="95 percent credible interval versus breakeven">
              <div className="sd-ci-labels sd-tabular">
                <span>35%</span>
                <span>52.38% (-110 BE)</span>
                <span>70%</span>
              </div>
              <div className="sd-ci-track">
                <div
                  className="sd-ci-breakeven"
                  style={{ left: `${toPct(BREAKEVEN_PROB_MINUS_110)}%` }}
                  title="Standard -110 breakeven win rate (52.38%)"
                />
                <div
                  className="sd-ci-range"
                  style={{
                    left: `${toPct(bayesian.ciLow95)}%`,
                    width: `${Math.max(2, toPct(bayesian.ciHigh95) - toPct(bayesian.ciLow95))}%`,
                  }}
                />
                <div
                  className="sd-ci-point"
                  style={{ left: `${toPct(bayesian.posteriorWinRate)}%` }}
                  title={`Posterior mean ${(bayesian.posteriorWinRate * 100).toFixed(2)}%`}
                />
              </div>
              <div className="sd-ci-caption sd-tabular">
                Sample basis: {bayesian.sampleBasis} (n = {bayesian.effectiveSampleSize}) · Prior
                Beta({bayesian.priorAlpha}, {bayesian.priorBeta})
              </div>
            </div>

            {showEquation && (
              <div className="sd-formula-equation sd-tabular">
                <div>{bayesian.formulaEquation}</div>
                <div>
                  f* = max(0, (b·p̂ − q) / b) with b = 100/110 = 0.9091 → Full Kelly{" "}
                  {(bayesian.fullKellyFraction * 100).toFixed(2)}%, Half{" "}
                  {(bayesian.halfKellyFraction * 100).toFixed(2)}%, Quarter{" "}
                  {(bayesian.quarterKellyFraction * 100).toFixed(2)}%
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="sd-formula-empty">
            Bayesian posterior withheld: sharpness and lifetime hold are unmeasured for this
            account.
          </div>
        )}
      </div>

      {/* 2. Desk Exposure, CVaR Tail Ratio & Countermeasure Policy Gap Matrix */}
      <div className="sd-formula-card" data-policy-gap-matrix="true">
        <div className="sd-formula-card__header">
          <span className="sd-formula-card__title">
            <ShieldAlert size={12} aria-hidden="true" />
            <span>
              Desk Policy Gap Matrix ({exposure.policyGapCount} gap
              {exposure.policyGapCount === 1 ? "" : "s"})
            </span>
          </span>
          <div style={{ display: "inline-flex", gap: "6px", alignItems: "center" }}>
            <button type="button" className="sd-action-btn" onClick={handleCopyPolicy}>
              {copiedPolicy ? <Check size={11} /> : <Copy size={11} />}
              <span>{copiedPolicy ? "Copied Policy CLI" : "Copy Policy CLI"}</span>
            </button>
            {onRunTerminalCommand && (
              <button
                type="button"
                className="sd-action-btn"
                onClick={() => onRunTerminalCommand(exposure.recommendedCliCommand)}
                title="Send recommended policy command to Bun.Terminal"
              >
                <Terminal size={11} />
                <span>Run CLI</span>
              </button>
            )}
          </div>
        </div>

        <div className="sd-policy-matrix-meta sd-tabular">
          <span>
            Archetype: <strong style={{ color: typeSpec.fg }}>{typeSpec.label}</strong>
          </span>
          <span>·</span>
          <span>
            Tail Severity: <strong>{exposure.tailSeverity}</strong>
            {exposure.cvarToVarRatio !== null
              ? ` (CVaR/VaR ${exposure.cvarToVarRatio.toFixed(2)}×)`
              : ""}
          </span>
          {exposure.expected7dDeskDrawdownUsd !== null && (
            <>
              <span>·</span>
              <span>
                Est. 7d Tail Drawdown:{" "}
                <strong style={{ color: "#fca5a5" }}>
                  ${exposure.expected7dDeskDrawdownUsd.toLocaleString()}
                </strong>
              </span>
            </>
          )}
        </div>

        <div className="sd-policy-table-wrap">
          <table className="sd-policy-table">
            <thead>
              <tr>
                <th>Control</th>
                <th>Current</th>
                <th>Formula Target</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {exposure.policyGaps.map((item) => (
                <tr key={item.field} title={item.rationale}>
                  <td>
                    <div className="sd-policy-table__label">{item.label}</div>
                    <div className="sd-policy-table__rationale">{item.rationale}</div>
                  </td>
                  <td className="sd-tabular">{item.currentDisplay}</td>
                  <td className="sd-tabular" style={{ fontWeight: 700, color: "#7dd3fc" }}>
                    {item.recommendedDisplay}
                  </td>
                  <td>
                    <span
                      className={`sd-policy-status sd-policy-status--${item.isGap ? item.severity : "ok"}`}
                    >
                      {item.isGap
                        ? item.severity === "critical"
                          ? "CRITICAL GAP"
                          : "GAP"
                        : "ALIGNED"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 3. Interactive What-If Countermeasure Simulator */}
      <div className="sd-formula-card" data-countermeasure-sim="true">
        <div className="sd-formula-card__header">
          <span className="sd-formula-card__title">
            <Sliders size={12} aria-hidden="true" />
            <span>Interactive Countermeasure What-If Simulator</span>
          </span>
          <div style={{ display: "inline-flex", gap: "6px" }}>
            <button
              type="button"
              className="sd-action-btn"
              onClick={() =>
                setSimParams({
                  limitCapUsd: exposure.suggestedCapUsd,
                  lineShadeCents: exposure.suggestedShadeCents,
                  inPlayDelaySec: exposure.suggestedDelaySec,
                  probitBlockEnabled: true,
                })
              }
            >
              Formula Target
            </button>
            <button
              type="button"
              className="sd-action-btn"
              onClick={() =>
                setSimParams({
                  limitCapUsd: defaultCap,
                  lineShadeCents: customer.lineShadeCents,
                  inPlayDelaySec: customer.inPlayDelaySec,
                  probitBlockEnabled: false,
                })
              }
            >
              <RotateCcw size={11} aria-hidden="true" />
              <span>Current</span>
            </button>
          </div>
        </div>

        <div className="sd-sim-controls">
          <label className="sd-sim-slider">
            <span className="sd-sim-slider__head">
              <span>Wager Cap</span>
              <strong className="sd-tabular">${simParams.limitCapUsd.toLocaleString()}</strong>
            </span>
            <input
              type="range"
              min={250}
              max={maxCapSlider}
              step={250}
              value={Math.min(maxCapSlider, simParams.limitCapUsd)}
              onChange={(e) =>
                setSimParams((prev) => ({ ...prev, limitCapUsd: Number(e.target.value) }))
              }
            />
          </label>

          <label className="sd-sim-slider">
            <span className="sd-sim-slider__head">
              <span>Line Shade</span>
              <strong className="sd-tabular">{simParams.lineShadeCents}¢</strong>
            </span>
            <input
              type="range"
              min={0}
              max={25}
              step={1}
              value={simParams.lineShadeCents}
              onChange={(e) =>
                setSimParams((prev) => ({ ...prev, lineShadeCents: Number(e.target.value) }))
              }
            />
          </label>

          <label className="sd-sim-slider">
            <span className="sd-sim-slider__head">
              <span>In-Play Delay</span>
              <strong className="sd-tabular">{simParams.inPlayDelaySec}s</strong>
            </span>
            <input
              type="range"
              min={0}
              max={15}
              step={1}
              value={simParams.inPlayDelaySec}
              onChange={(e) =>
                setSimParams((prev) => ({ ...prev, inPlayDelaySec: Number(e.target.value) }))
              }
            />
          </label>

          <label className="sd-sim-checkbox">
            <input
              type="checkbox"
              checked={simParams.probitBlockEnabled}
              onChange={(e) =>
                setSimParams((prev) => ({ ...prev, probitBlockEnabled: e.target.checked }))
              }
            />
            <span>Enforce Probit Alt-Subset Parlay Guard (ρ ≥ 0.65 block)</span>
          </label>
        </div>

        <div className="sd-formula-bench-grid">
          <div className="sd-formula-bench-cell">
            <span className="sd-formula-bench-label">Post-Control Edge</span>
            <strong
              className="sd-formula-bench-val sd-tabular"
              style={{
                color:
                  simulation.projectedEdgePct > 1
                    ? "#f87171"
                    : simulation.projectedEdgePct > 0
                      ? "#fbbf24"
                      : "#4ade80",
              }}
            >
              {simulation.projectedEdgePct >= 0 ? "+" : ""}
              {simulation.projectedEdgePct.toFixed(2)}%
            </strong>
            <span className="sd-formula-bench-sub sd-tabular">
              Base {simulation.baselineEdgePct >= 0 ? "+" : ""}
              {simulation.baselineEdgePct.toFixed(2)}% (−{simulation.edgeReductionPct.toFixed(2)}%)
            </span>
          </div>

          <div className="sd-formula-bench-cell">
            <span className="sd-formula-bench-label">30d Projected Savings</span>
            <strong
              className="sd-formula-bench-val sd-tabular"
              style={{ color: simulation.projected30dSavingsUsd >= 0 ? "#4ade80" : "#f87171" }}
            >
              {simulation.projected30dSavingsUsd >= 0 ? "+" : "-"}$
              {Math.abs(simulation.projected30dSavingsUsd).toLocaleString()}
            </strong>
            <span className="sd-formula-bench-sub sd-tabular">
              Net {simulation.projected30dDeskNetUsd >= 0 ? "+" : "-"}$
              {Math.abs(simulation.projected30dDeskNetUsd).toLocaleString()}
            </span>
          </div>

          <div className="sd-formula-bench-cell">
            <span className="sd-formula-bench-label">Sim VaR / Cap</span>
            <strong className="sd-formula-bench-val sd-tabular">
              {simulation.projectedVarToCapPct !== null
                ? `${simulation.projectedVarToCapPct}%`
                : "—"}
            </strong>
            <span className="sd-formula-bench-sub sd-tabular">
              Throttle {(simulation.breakdown.capThrottleFactor * 100).toFixed(0)}%
            </span>
          </div>

          <div className="sd-formula-bench-cell">
            <span className="sd-formula-bench-label">Post-Control Band</span>
            <strong
              className="sd-formula-bench-val sd-tabular"
              style={{
                color:
                  simulation.postControlRiskBand === "CRITICAL"
                    ? "#f87171"
                    : simulation.postControlRiskBand === "HIGH" ||
                        simulation.postControlRiskBand === "ELEVATED"
                      ? "#fbbf24"
                      : "#4ade80",
              }}
            >
              {simulation.postControlRiskBand}
            </strong>
            <span className="sd-formula-bench-sub sd-tabular">
              Shade −{simulation.breakdown.shadeEdgeOffsetPct}% · Delay −
              {simulation.breakdown.delayEdgeDecayPct}%
            </span>
          </div>
        </div>
      </div>

      {/* 4. Nearest Cohort Peers Drilldown */}
      {nearestPeers.length > 0 && (
        <div className="sd-formula-card" data-peer-cohort="true">
          <div className="sd-formula-card__header">
            <span className="sd-formula-card__title">
              <Users size={12} aria-hidden="true" />
              <span>Nearest Cohort Peers (Click to Pivot)</span>
            </span>
          </div>
          <div className="sd-peer-list">
            {nearestPeers.map((peer) => (
              <button
                key={peer.id}
                type="button"
                className="sd-peer-row"
                onClick={() => onSelectCustomerById?.(peer.id)}
                disabled={!onSelectCustomerById}
              >
                <div className="sd-peer-row__id">
                  <strong>{peer.id}</strong>
                  <span>
                    Agent {peer.agentId} · {peer.reason}
                  </span>
                </div>
                <div className="sd-peer-row__metrics sd-tabular">
                  <strong>{peer.score.toFixed(1)}</strong>
                  <span>
                    Δ {peer.scoreDelta >= 0 ? "+" : ""}
                    {peer.scoreDelta.toFixed(1)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
