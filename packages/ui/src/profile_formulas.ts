/**
 * Single-source-of-truth quantitative formulas for Profiled Bettors:
 *
 * - Strictly conserved 5-axis sharpness decomposition (3.0 + 2.5 + 1.5 + 2.0 + 1.0 = 10.0)
 * - Exact stake distribution statistics (Gini, CV, Parametric/Empirical VaR95 & Analytical CVaR95)
 * - Empirical Beta-Binomial Bayesian skill posterior & fractional Kelly criterion
 * - Desk exposure, tail severity, and dynamic countermeasure policy gap model
 * - Cohort percentile benchmarking, risk driver attribution, and interactive What-If simulation
 *
 * @file Packages/ui/src/profile_formulas.ts
 */

import type { CustomerLiveActivitySummary } from "./customer_drilldown_summary.ts"
import type { NormalizedRankingsResult } from "./hydration.ts"
import type { ProfileAxisKey, ProfileRiskBand, RankedPlayer30d, ShowcaseCustomer } from "./types.ts"

/** Standard -110 sportsbook vig breakeven probability: 110 / 210 ≈ 0.5238095 */
export const BREAKEVEN_PROB_MINUS_110 = 110 / 210
/** Decimal profit per $1 risked at -110: 100 / 110 ≈ 0.9090909 */
export const NET_ODDS_MINUS_110 = 100 / 110
/** Standard normal 95th percentile z-score: Φ⁻¹(0.95) */
export const Z_95 = 1.6448536
/** Exact Normal 95% Expected Shortfall multiplier: φ(z_0.95) / 0.05 ≈ 2.0627128 */
export const NORMAL_CVAR_95_MULTIPLIER = 2.0627128

export const SHARPNESS_AXIS_CAPS: Readonly<Record<ProfileAxisKey, number>> = {
  clvScore: 3.0,
  skillScore: 2.5,
  sizingScore: 1.5,
  sigScore: 2.0,
  timingScore: 1.0,
}

export interface SharpnessAxisMeta {
  readonly key: ProfileAxisKey
  readonly label: string
  readonly shortLabel: string
  readonly cap: number
  readonly weightPct: number
  readonly formulaSummary: string
}

export const SHARPNESS_AXIS_SPECS: readonly SharpnessAxisMeta[] = [
  {
    key: "clvScore",
    label: "CLV Beat Margin",
    shortLabel: "CLV",
    cap: 3.0,
    weightPct: 30,
    formulaSummary: "min(3.0, max(0, clv_bps / 100)) water-filled to conserved score Σ",
  },
  {
    key: "skillScore",
    label: "Bayesian Skill",
    shortLabel: "Skill",
    cap: 2.5,
    weightPct: 25,
    formulaSummary: "Beta(α₀+W, β₀+L) posterior lift above 52.38% (-110 vig breakeven)",
  },
  {
    key: "sizingScore",
    label: "Sizing Discipline",
    shortLabel: "Sizing",
    cap: 1.5,
    weightPct: 15,
    formulaSummary: "Stake consistency & Kelly scaling from CV, Gini, and mean stake",
  },
  {
    key: "sigScore",
    label: "Signature Specialization",
    shortLabel: "Spec",
    cap: 2.0,
    weightPct: 20,
    formulaSummary: "Market concentration, multi-leg structure & alert-rate density",
  },
  {
    key: "timingScore",
    label: "Timing / Parlay Exploitation",
    shortLabel: "Timing",
    cap: 1.0,
    weightPct: 10,
    formulaSummary: "Probit correlation ρ, steam/opener cadence & in-play latency edge",
  },
]

export interface SharpnessSignalInputs {
  readonly clvBps?: number | null | undefined
  readonly holdPct?: number | null | undefined
  readonly meanStakeUsd?: number | null | undefined
  readonly stakeCv?: number | null | undefined
  readonly gini?: number | null | undefined
  readonly avgParlayLegs?: number | null | undefined
  readonly probitRho?: number | null | undefined
  readonly delaySec?: number | null | undefined
  readonly alertRate?: number | null | undefined
  readonly isProxy?: boolean | undefined
}

export interface ReconciledSharpnessAxes {
  readonly clvScore: number
  readonly skillScore: number
  readonly sizingScore: number
  readonly sigScore: number
  readonly timingScore: number
  readonly totalScore: number
  readonly conservationDelta: number
}

export interface SharpnessAxisDetail {
  readonly key: ProfileAxisKey
  readonly label: string
  readonly shortLabel: string
  readonly value: number
  readonly cap: number
  readonly utilizationPct: number
  readonly shareOfTotalPct: number
  readonly formulaSummary: string
  readonly observedInput: string
}

export interface StakeDistributionMetrics {
  readonly count: number
  readonly meanUsd: number
  readonly stdDevUsd: number
  readonly cv: number
  readonly gini: number
  readonly minUsd: number
  readonly maxUsd: number
  readonly p95EmpiricalUsd: number
  readonly var95Usd: number
  readonly cvar95Usd: number
  readonly cvarToVarRatio: number
}

export type BayesianSampleBasis =
  "backtest-tickets" | "retained-history" | "live-tape" | "score-prior"

export interface BayesianSkillEstimate {
  readonly priorAlpha: number
  readonly priorBeta: number
  readonly posteriorAlpha: number
  readonly posteriorBeta: number
  readonly effectiveSampleSize: number
  readonly sampleBasis: BayesianSampleBasis
  readonly posteriorWinRate: number
  readonly posteriorStdErr: number
  readonly ciLow95: number
  readonly ciHigh95: number
  readonly impliedEdgePct: number
  readonly probAboveBreakeven: number
  readonly fullKellyFraction: number
  readonly halfKellyFraction: number
  readonly quarterKellyFraction: number
  readonly quarterKellyStakeUsd: number
  readonly evPerBetUsd: number
  readonly formulaEquation: string
}

export type TailSeverity = "EXTREME" | "ELEVATED" | "NORMAL" | "UNMEASURED"

export interface PolicyGapItem {
  readonly field: "cap" | "delay" | "shade" | "shadow"
  readonly label: string
  readonly currentDisplay: string
  readonly recommendedDisplay: string
  readonly isGap: boolean
  readonly severity: "critical" | "warning" | "ok"
  readonly rationale: string
}

export interface DeskExposureModel {
  readonly hasMeasuredVar: boolean
  readonly hasMeasuredLimit: boolean
  readonly hasMeasuredHold: boolean
  readonly hasMeasuredLtv: boolean
  readonly var95Usd: number | null
  readonly cvar95Usd: number | null
  readonly varToCapPct: number | null
  readonly isVarOverCap: boolean
  readonly cvarToVarRatio: number | null
  readonly tailSeverity: TailSeverity
  readonly suggestedCapUsd: number
  readonly suggestedDelaySec: number
  readonly suggestedShadeCents: number
  readonly suggestedShadowMultiplier: number
  readonly expected7dDeskDrawdownUsd: number | null
  readonly policyGaps: readonly PolicyGapItem[]
  readonly policyGapCount: number
  readonly recommendedCliCommand: string
}

export interface CohortBenchmarkComparison {
  readonly cohortSize: number
  readonly measuredScoreCount: number
  readonly scoreRank: number | null
  readonly scorePercentile: number | null
  readonly clvPercentile: number | null
  readonly varPercentile: number | null
  readonly giniPercentile: number | null
  readonly cohortMedianScore: number | null
  readonly cohortMeanScore: number | null
  readonly cohortP90Score: number | null
  readonly deltaFromMedianScore: number | null
}

export interface ProfileRiskDriver {
  readonly id: string
  readonly label: string
  readonly severity: "critical" | "warning" | "info" | "positive"
  readonly metricDisplay: string
  readonly thresholdDisplay: string
  readonly formulaNote: string
  readonly targetTab: "overview" | "formulas" | "activity" | "reconciliation"
}

export interface PeerProfileMatch {
  readonly id: string
  readonly agentId: string
  readonly score: number
  readonly scoreDelta: number
  readonly holdPct: number
  readonly sharedAgent: boolean
  readonly sharedTier: boolean
  readonly sharedSport: boolean
  readonly reason: string
}

export interface CountermeasureSimulationParams {
  readonly limitCapUsd: number
  readonly lineShadeCents: number
  readonly inPlayDelaySec: number
  readonly probitBlockEnabled: boolean
}

export interface CountermeasureSimulationResult {
  readonly baselineEdgePct: number
  readonly projectedEdgePct: number
  readonly edgeReductionPct: number
  readonly baseline30dDeskNetUsd: number
  readonly projected30dDeskNetUsd: number
  readonly projected30dSavingsUsd: number
  readonly projectedVarToCapPct: number | null
  readonly postControlRiskBand: ProfileRiskBand
  readonly breakdown: {
    readonly shadeEdgeOffsetPct: number
    readonly delayEdgeDecayPct: number
    readonly capThrottleFactor: number
    readonly probitSavingsUsd: number
  }
}

export interface ProfileQuantitativeModel {
  readonly customerId: string
  readonly isUnmeasured: boolean
  readonly axes: readonly SharpnessAxisDetail[]
  readonly axisSum: number
  readonly conservationDelta: number
  readonly isConserved: boolean
  readonly dominatingAxis: SharpnessAxisDetail | null
  readonly bayesian: BayesianSkillEstimate | null
  readonly exposure: DeskExposureModel
  readonly benchmark: CohortBenchmarkComparison
  readonly riskDrivers: readonly ProfileRiskDriver[]
  readonly nearestPeers: readonly PeerProfileMatch[]
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const round = (value: number, places = 2): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** Abramowitz-Stegun 7.1.26 approximation for standard normal CDF Φ(z), max error < 1.5e-7. */
export function standardNormalCdf(z: number): number {
  if (!Number.isFinite(z)) return 0.5
  if (z < -8) return 0
  if (z > 8) return 1
  const sign = z < 0 ? -1 : 1
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x)
  return 0.5 * (1 + sign * erf)
}

/** Exact Gini coefficient for a non-negative sample array. */
export function computeGiniCoefficient(values: readonly number[]): number {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0)
  if (positive.length < 2) return 0
  const sorted = [...positive].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  if (sum <= 0) return 0
  const weighted = sorted.reduce((acc, v, idx) => acc + (idx + 1) * v, 0)
  return clamp((2 * weighted) / (sorted.length * sum) - (sorted.length + 1) / sorted.length, 0, 1)
}

/**
 * Exact stake distribution metrics:
 *
 * - Sample mean μ, Bessel-corrected std dev σ (when n >= 2), CV = σ/μ, Gini
 * - Normal 95% VaR = μ + z₀.₉₅·σ and analytical Normal 95% CVaR = μ + (φ(z₀.₉₅)/0.05)·σ
 */
export function computeStakeDistribution(stakes: readonly number[]): StakeDistributionMetrics {
  const valid = stakes.filter((v) => Number.isFinite(v) && v > 0)
  const n = valid.length
  if (n === 0) {
    return {
      count: 0,
      meanUsd: 0,
      stdDevUsd: 0,
      cv: 0,
      gini: 0,
      minUsd: 0,
      maxUsd: 0,
      p95EmpiricalUsd: 0,
      var95Usd: 0,
      cvar95Usd: 0,
      cvarToVarRatio: 0,
    }
  }
  const sorted = [...valid].sort((a, b) => a - b)
  const meanUsd = sorted.reduce((acc, v) => acc + v, 0) / n
  const denom = n >= 2 ? n - 1 : 1
  const variance = n >= 2 ? sorted.reduce((acc, v) => acc + (v - meanUsd) ** 2, 0) / denom : 0
  const stdDevUsd = Math.sqrt(variance)
  const cv = meanUsd > 0 ? stdDevUsd / meanUsd : 0
  const gini = computeGiniCoefficient(sorted)
  const p95Idx = Math.min(n - 1, Math.max(0, Math.ceil(0.95 * n) - 1))
  const p95EmpiricalUsd = sorted[p95Idx] ?? meanUsd
  const var95Usd = n >= 2 ? round(meanUsd + Z_95 * stdDevUsd, 2) : 0
  const cvar95Usd = n >= 2 ? round(meanUsd + NORMAL_CVAR_95_MULTIPLIER * stdDevUsd, 2) : 0

  return {
    count: n,
    meanUsd: round(meanUsd, 2),
    stdDevUsd: round(stdDevUsd, 2),
    cv: round(cv, 4),
    gini: round(gini, 4),
    minUsd: round(sorted[0] ?? 0, 2),
    maxUsd: round(sorted[n - 1] ?? 0, 2),
    p95EmpiricalUsd: round(p95EmpiricalUsd, 2),
    var95Usd,
    cvar95Usd,
    cvarToVarRatio: var95Usd > 0 ? round(cvar95Usd / var95Usd, 3) : 0,
  }
}

/**
 * Water-filling exact conserved 5-axis sharpness decomposition.
 *
 * Guarantees: 0 <= axis_i <= cap_i for all 5 axes round(Σ axis_i, 2) === round(clamp(score, 0, 10), 2)
 * (exact 0.00 conservation delta)
 *
 * Observed signals bias the relative weights of each axis before constrained water-filling so
 * high-CLV bettors concentrate points on CLV, Probit/steam bettors concentrate on Timing,
 * disciplined sizers concentrate on Sizing, etc.
 */
export function reconcileSharpnessAxes(
  rawScore: number,
  signals: SharpnessSignalInputs = {},
): ReconciledSharpnessAxes {
  const totalScore = round(clamp(Number.isFinite(rawScore) ? rawScore : 0, 0, 10), 2)
  const caps = [
    SHARPNESS_AXIS_CAPS.clvScore,
    SHARPNESS_AXIS_CAPS.skillScore,
    SHARPNESS_AXIS_CAPS.sizingScore,
    SHARPNESS_AXIS_CAPS.sigScore,
    SHARPNESS_AXIS_CAPS.timingScore,
  ]

  if (totalScore <= 0) {
    return {
      clvScore: 0,
      skillScore: 0,
      sizingScore: 0,
      sigScore: 0,
      timingScore: 0,
      totalScore: 0,
      conservationDelta: 0,
    }
  }

  // Signal-informed relative affinity weights (strictly positive so no axis collapses arbitrarily)
  const baseRatio = totalScore / 10
  const clvSignal =
    typeof signals.clvBps === "number" && Number.isFinite(signals.clvBps) && signals.clvBps > 0
      ? clamp(signals.clvBps / 100, 0.2, 3.0)
      : caps[0]! * baseRatio

  const holdLift =
    typeof signals.holdPct === "number" && Number.isFinite(signals.holdPct)
      ? clamp(1 + (-signals.holdPct / 35) * 0.45, 0.45, 1.55)
      : 1.0
  const skillSignal = clamp(caps[1]! * baseRatio * holdLift, 0.12, caps[1]!)

  const sizingSignal =
    typeof signals.stakeCv === "number" && Number.isFinite(signals.stakeCv)
      ? clamp(1.35 - signals.stakeCv * 0.55, 0.2, caps[2]!)
      : typeof signals.gini === "number" && Number.isFinite(signals.gini)
        ? clamp(1.35 - signals.gini * 0.65, 0.2, caps[2]!)
        : typeof signals.meanStakeUsd === "number" &&
            Number.isFinite(signals.meanStakeUsd) &&
            signals.meanStakeUsd > 0
          ? clamp(Math.log10(Math.max(10, signals.meanStakeUsd) / 40) * 0.62, 0.25, caps[2]!)
          : caps[2]! * baseRatio

  const sigSignal =
    typeof signals.avgParlayLegs === "number" &&
    Number.isFinite(signals.avgParlayLegs) &&
    signals.avgParlayLegs > 0
      ? clamp(0.75 + (signals.avgParlayLegs - 1.5) * 0.65, 0.3, caps[3]!)
      : typeof signals.alertRate === "number" && Number.isFinite(signals.alertRate)
        ? clamp(0.55 + signals.alertRate * 1.25, 0.2, caps[3]!)
        : caps[3]! * baseRatio

  const timingSignal =
    typeof signals.probitRho === "number" && Number.isFinite(signals.probitRho)
      ? clamp(signals.probitRho * 1.15, 0.2, caps[4]!)
      : signals.isProxy
        ? 0.88
        : typeof signals.delaySec === "number" && signals.delaySec > 0
          ? clamp(0.45 + signals.delaySec * 0.06, 0.25, caps[4]!)
          : caps[4]! * baseRatio

  const weights = [
    Math.max(0.05, clvSignal),
    Math.max(0.05, skillSignal),
    Math.max(0.05, sizingSignal),
    Math.max(0.05, sigSignal),
    Math.max(0.05, timingSignal),
  ]

  // Constrained proportional water-filling under per-axis caps
  const values = [0, 0, 0, 0, 0]
  const active = [0, 1, 2, 3, 4]
  let remaining = totalScore

  while (remaining > 1e-7 && active.length > 0) {
    const activeWeightSum = active.reduce((sum, idx) => sum + weights[idx]!, 0)
    if (activeWeightSum <= 1e-9) break
    let cappedAny = false
    for (let i = active.length - 1; i >= 0; i--) {
      const idx = active[i]!
      const room = caps[idx]! - values[idx]!
      const share = remaining * (weights[idx]! / activeWeightSum)
      if (share >= room - 1e-9) {
        values[idx] = caps[idx]!
        remaining -= room
        active.splice(i, 1)
        cappedAny = true
      }
    }
    if (!cappedAny) {
      for (const idx of active) {
        values[idx] = values[idx]! + remaining * (weights[idx]! / activeWeightSum)
      }
      remaining = 0
    }
  }

  // Exact centesimal (0.01) integer reconciliation so Σ axes === totalScore with 0.00 drift
  const targetUnits = Math.round(totalScore * 100)
  const capUnits = caps.map((c) => Math.round(c * 100))
  const exactUnits = values.map((v) => v * 100)
  const floorUnits = exactUnits.map((u, i) => Math.min(capUnits[i]!, Math.floor(u)))
  let deltaUnits = targetUnits - floorUnits.reduce((s, u) => s + u, 0)

  if (deltaUnits > 0) {
    const remainders = exactUnits
      .map((u, idx) => ({ idx, rem: u - floorUnits[idx]! }))
      .sort((a, b) => b.rem - a.rem)
    for (const entry of remainders) {
      if (deltaUnits <= 0) break
      if (floorUnits[entry.idx]! < capUnits[entry.idx]!) {
        floorUnits[entry.idx]! += 1
        deltaUnits -= 1
      }
    }
  } else if (deltaUnits < 0) {
    const remainders = exactUnits
      .map((u, idx) => ({ idx, rem: u - floorUnits[idx]! }))
      .sort((a, b) => a.rem - b.rem)
    for (const entry of remainders) {
      if (deltaUnits >= 0) break
      if (floorUnits[entry.idx]! > 0) {
        floorUnits[entry.idx]! -= 1
        deltaUnits += 1
      }
    }
  }

  const clvScore = floorUnits[0]! / 100
  const skillScore = floorUnits[1]! / 100
  const sizingScore = floorUnits[2]! / 100
  const sigScore = floorUnits[3]! / 100
  const timingScore = floorUnits[4]! / 100
  const sum = round(clvScore + skillScore + sizingScore + sigScore + timingScore, 2)

  return {
    clvScore,
    skillScore,
    sizingScore,
    sigScore,
    timingScore,
    totalScore,
    conservationDelta: round(sum - totalScore, 2),
  }
}

/**
 * Empirical Beta-Binomial Bayesian Skill & Fractional Kelly Model.
 *
 * Uses a symmetric Beta(24, 24) prior (equivalent to 48 neutral coin-flip bets) updated with
 * observed sample size and implied bettor win rate from desk hold/net and CLV/sharpness.
 * Desk-perspective convention: negative holdPct / negative ltvUsd means bettor profit.
 */
export function computeProfileBayesianSkill(
  cust: ShowcaseCustomer,
  liveActivity?: CustomerLiveActivitySummary | null,
): BayesianSkillEstimate | null {
  const unknown = cust.unknown ?? []
  const sharpKnown = !unknown.includes("sharpness")
  const holdKnown = !unknown.includes("holdPct")
  if (!sharpKnown && !holdKnown) return null

  const priorAlpha = 24
  const priorBeta = 24

  const parlayTickets = cust.forensicDossier?.parlayBacktest?.totalParlayTickets ?? 0
  const retainedTickets = cust.retainedHistory?.eligibleWagers ?? 0
  const liveTickets = liveActivity?.ticketCount ?? 0

  let sampleSize: number
  let sampleBasis: BayesianSampleBasis
  if (parlayTickets >= 10) {
    sampleSize = parlayTickets
    sampleBasis = "backtest-tickets"
  } else if (retainedTickets >= 5) {
    sampleSize = retainedTickets
    sampleBasis = "retained-history"
  } else if (liveTickets >= 5) {
    sampleSize = liveTickets
    sampleBasis = "live-tape"
  } else {
    sampleSize = 48
    sampleBasis = "score-prior"
  }

  // Convert observed desk-perspective signals into an observed bettor win-rate estimate
  // At -110 odds: ROI_bettor ≈ p * 1.90909 - 1  =>  p ≈ (1 + ROI_bettor) / 1.90909
  let observedWinRate: number
  if (holdKnown && Number.isFinite(cust.holdPct)) {
    // Cap extreme short-run parlay hold swings when mapping to equivalent straight-bet skill
    const bettorRoi = clamp(-cust.holdPct / 100, -0.18, 0.22)
    const holdImpliedP = (1 + bettorRoi) / (1 + NET_ODDS_MINUS_110)
    const scorePriorP = 0.5 + (cust.score - 5.2) * 0.014
    observedWinRate = clamp(holdImpliedP * 0.65 + scorePriorP * 0.35, 0.42, 0.64)
  } else {
    const clvLift = clamp(cust.clvScore * 0.012, -0.02, 0.036)
    const netLift =
      !unknown.includes("ltv") && cust.ltvUsd < 0
        ? 0.015
        : !unknown.includes("ltv") && cust.ltvUsd > 0
          ? -0.01
          : 0
    observedWinRate = clamp(0.5 + (cust.score - 5.2) * 0.015 + clvLift * 0.4 + netLift, 0.43, 0.62)
  }

  const pseudoWins = sampleSize * observedWinRate
  const pseudoLosses = sampleSize * (1 - observedWinRate)
  const posteriorAlpha = round(priorAlpha + pseudoWins, 2)
  const posteriorBeta = round(priorBeta + pseudoLosses, 2)
  const totalN = posteriorAlpha + posteriorBeta

  const posteriorWinRate = posteriorAlpha / totalN
  const variance = (posteriorAlpha * posteriorBeta) / (totalN * totalN * (totalN + 1))
  const posteriorStdErr = Math.sqrt(variance)
  const ciLow95 = clamp(posteriorWinRate - 1.96 * posteriorStdErr, 0.25, 0.85)
  const ciHigh95 = clamp(posteriorWinRate + 1.96 * posteriorStdErr, 0.25, 0.85)

  const zAboveBreakeven =
    posteriorStdErr > 1e-6 ? (posteriorWinRate - BREAKEVEN_PROB_MINUS_110) / posteriorStdErr : 0
  const probAboveBreakeven = clamp(standardNormalCdf(zAboveBreakeven), 0.01, 0.999)

  // Implied EV% and Kelly fraction at standard -110 odds (b = 100/110)
  const impliedEdgePct = (posteriorWinRate * (1 + NET_ODDS_MINUS_110) - 1) * 100
  const fullKellyFraction = Math.max(
    0,
    (posteriorWinRate * NET_ODDS_MINUS_110 - (1 - posteriorWinRate)) / NET_ODDS_MINUS_110,
  )
  const halfKellyFraction = fullKellyFraction * 0.5
  const quarterKellyFraction = fullKellyFraction * 0.25

  const hasStake = !unknown.includes("meanStake") && cust.meanStake > 0
  const quarterKellyStakeUsd =
    fullKellyFraction <= 0 || !hasStake
      ? 0
      : Math.max(1, Math.round(cust.meanStake * Math.min(1.5, fullKellyFraction * 2.5)))
  const evPerBetUsd = hasStake ? round(cust.meanStake * (impliedEdgePct / 100), 2) : 0

  return {
    priorAlpha,
    priorBeta,
    posteriorAlpha,
    posteriorBeta,
    effectiveSampleSize: sampleSize,
    sampleBasis,
    posteriorWinRate: round(posteriorWinRate, 4),
    posteriorStdErr: round(posteriorStdErr, 4),
    ciLow95: round(ciLow95, 4),
    ciHigh95: round(ciHigh95, 4),
    impliedEdgePct: round(impliedEdgePct, 2),
    probAboveBreakeven: round(probAboveBreakeven, 4),
    fullKellyFraction: round(fullKellyFraction, 4),
    halfKellyFraction: round(halfKellyFraction, 4),
    quarterKellyFraction: round(quarterKellyFraction, 4),
    quarterKellyStakeUsd,
    evPerBetUsd,
    formulaEquation: `Beta(${posteriorAlpha.toFixed(1)}, ${posteriorBeta.toFixed(1)}) = prior(24,24) + ${sampleSize} obs · p̂=${(posteriorWinRate * 100).toFixed(2)}% ± ${(1.96 * posteriorStdErr * 100).toFixed(2)}%`,
  }
}

/**
 * Dynamic desk exposure & countermeasure policy gap model. Computes formula-recommended cap, delay,
 * shade, and shadow multiplier from observed signals, and flags every gap against the currently
 * applied account posture.
 */
export function computeDeskExposureModel(cust: ShowcaseCustomer): DeskExposureModel {
  const unknown = cust.unknown ?? []
  const hasMeasuredVar = !unknown.includes("var95") && cust.var95Usd > 0
  const hasMeasuredLimit = !unknown.includes("limit") && cust.recommendedLimitUsd > 0
  const hasMeasuredHold = !unknown.includes("holdPct")
  const hasMeasuredLtv = !unknown.includes("ltv")

  const var95Usd = hasMeasuredVar ? cust.var95Usd : null
  const cvar95Usd = hasMeasuredVar && cust.cvar95Usd > 0 ? cust.cvar95Usd : null
  const varToCapPct =
    var95Usd !== null && hasMeasuredLimit
      ? Math.round((var95Usd / cust.recommendedLimitUsd) * 100)
      : null
  const isVarOverCap = var95Usd !== null && hasMeasuredLimit && var95Usd > cust.recommendedLimitUsd
  const cvarToVarRatio =
    var95Usd !== null && cvar95Usd !== null && var95Usd > 0 ? round(cvar95Usd / var95Usd, 2) : null

  const tailSeverity: TailSeverity =
    cvarToVarRatio === null
      ? "UNMEASURED"
      : cvarToVarRatio >= 1.35 || isVarOverCap
        ? "EXTREME"
        : cvarToVarRatio >= 1.18
          ? "ELEVATED"
          : "NORMAL"

  // Formula-recommended countermeasures anchored strictly to measured signals
  const probitRho = cust.forensicDossier?.parlayBacktest?.probitRho ?? null
  const isParlayCrit =
    cust.correlatedRisk === "CRITICAL" || (probitRho !== null && probitRho >= 0.65)
  const isHighSyndicate = cust.syndicateRisk === "HIGH" || cust.syndicateProb >= 0.7

  const baselineStake = !unknown.includes("meanStake") && cust.meanStake > 0 ? cust.meanStake : 1000
  const capMultiplier =
    cust.score >= 8.5 || isParlayCrit
      ? 0.35
      : cust.score >= 7.0 || isHighSyndicate
        ? 0.6
        : cust.score >= 5.5
          ? 1.0
          : 2.5
  const suggestedCapUsd = Math.max(250, Math.round((baselineStake * capMultiplier) / 50) * 50)

  const suggestedDelaySec =
    cust.score >= 8.5 || isHighSyndicate
      ? 8
      : cust.score >= 7.0 || isParlayCrit
        ? 6
        : cust.score >= 5.5
          ? 3
          : 0

  const suggestedShadeCents =
    cust.score >= 8.5 ? 15 : cust.score >= 7.0 || isParlayCrit ? 10 : cust.score >= 5.5 ? 5 : 0

  const suggestedShadowMultiplier =
    cust.score >= 8.5 && (!hasMeasuredHold || cust.holdPct < 0)
      ? 1.5
      : cust.score >= 7.5
        ? 1.25
        : 1.0

  const expected7dDeskDrawdownUsd =
    cvar95Usd !== null
      ? round(cvar95Usd, 0)
      : hasMeasuredHold && cust.holdPct < 0 && baselineStake > 0
        ? round(baselineStake * 7 * Math.min(0.45, Math.abs(cust.holdPct) / 100), 0)
        : null

  const policyGaps: PolicyGapItem[] = []

  const capGap = hasMeasuredLimit && cust.recommendedLimitUsd > suggestedCapUsd * 1.25
  policyGaps.push({
    field: "cap",
    label: "Max Wager Cap",
    currentDisplay: hasMeasuredLimit ? `$${cust.recommendedLimitUsd.toLocaleString()}` : "Unset",
    recommendedDisplay: `$${suggestedCapUsd.toLocaleString()}`,
    isGap: !hasMeasuredLimit || capGap,
    severity: capGap && cust.score >= 7.5 ? "critical" : !hasMeasuredLimit ? "warning" : "ok",
    rationale: isParlayCrit
      ? "Probit correlation ≥ 0.65 / Critical parlay risk requires 0.35× mean-stake cap"
      : `Scaled as ${capMultiplier.toFixed(2)}× mean stake ($${Math.round(baselineStake).toLocaleString()})`,
  })

  const currentDelay = !unknown.includes("delay") ? cust.inPlayDelaySec : null
  const delayGap =
    suggestedDelaySec > 0 && (currentDelay === null || currentDelay < suggestedDelaySec)
  policyGaps.push({
    field: "delay",
    label: "In-Play Delay",
    currentDisplay: currentDelay !== null ? `${currentDelay}s` : "Unset",
    recommendedDisplay: `${suggestedDelaySec}s`,
    isGap: delayGap,
    severity: delayGap && suggestedDelaySec >= 6 ? "critical" : delayGap ? "warning" : "ok",
    rationale:
      suggestedDelaySec > 0
        ? "Neutralizes steam-chase / court-siding latency window"
        : "No latency throttle required",
  })

  const shadeGap = suggestedShadeCents > 0 && cust.lineShadeCents < suggestedShadeCents
  policyGaps.push({
    field: "shade",
    label: "Line Shade",
    currentDisplay: `${cust.lineShadeCents}¢`,
    recommendedDisplay: `${suggestedShadeCents}¢`,
    isGap: shadeGap,
    severity: shadeGap && suggestedShadeCents >= 10 ? "critical" : shadeGap ? "warning" : "ok",
    rationale:
      suggestedShadeCents > 0
        ? `Offsets ~${Math.round(suggestedShadeCents * 0.45 * 10) / 10}% theoretical bettor CLV margin`
        : "Standard market juice sufficient",
  })

  const shadowGap =
    suggestedShadowMultiplier > 1.0 && cust.shadowCopyMultiplier < suggestedShadowMultiplier
  policyGaps.push({
    field: "shadow",
    label: "Shadow Copy",
    currentDisplay: `${cust.shadowCopyMultiplier.toFixed(2)}x`,
    recommendedDisplay: `${suggestedShadowMultiplier.toFixed(2)}x`,
    isGap: shadowGap,
    severity: shadowGap ? "warning" : "ok",
    rationale:
      suggestedShadowMultiplier > 1.0
        ? "Originator signal eligible for automated line-move weight / copy"
        : "No shadow-copy multiplier needed",
  })

  const policyGapCount = policyGaps.filter((g) => g.isGap).length
  const recommendedCliCommand = `policy apply ${cust.id} --cap=${suggestedCapUsd} --delay=${suggestedDelaySec}s --shade=${suggestedShadeCents}c --shadow=${suggestedShadowMultiplier.toFixed(2)}x${isParlayCrit ? " --probit-block" : ""}`

  return {
    hasMeasuredVar,
    hasMeasuredLimit,
    hasMeasuredHold,
    hasMeasuredLtv,
    var95Usd,
    cvar95Usd,
    varToCapPct,
    isVarOverCap,
    cvarToVarRatio,
    tailSeverity,
    suggestedCapUsd,
    suggestedDelaySec,
    suggestedShadeCents,
    suggestedShadowMultiplier,
    expected7dDeskDrawdownUsd,
    policyGaps,
    policyGapCount,
    recommendedCliCommand,
  }
}

function percentileRank(sortedAsc: readonly number[], value: number): number | null {
  if (sortedAsc.length === 0 || !Number.isFinite(value)) return null
  if (sortedAsc.length === 1) return 100
  let below = 0
  let equal = 0
  for (const v of sortedAsc) {
    if (v < value) below += 1
    else if (v === value) equal += 1
  }
  return Math.round(((below + 0.5 * equal) / sortedAsc.length) * 100)
}

function quantile(sortedAsc: readonly number[], q: number): number | null {
  if (sortedAsc.length === 0) return null
  const idx = clamp(q * (sortedAsc.length - 1), 0, sortedAsc.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sortedAsc[lo] ?? null
  const frac = idx - lo
  return (sortedAsc[lo] ?? 0) * (1 - frac) + (sortedAsc[hi] ?? 0) * frac
}

/** Rank the selected bettor across the active cohort (sharpness, CLV, VaR, Gini). */
export function computeCohortBenchmarks(
  cust: ShowcaseCustomer,
  cohort: readonly ShowcaseCustomer[],
): CohortBenchmarkComparison {
  const unknown = cust.unknown ?? []
  const measuredScores = cohort
    .filter((c) => !(c.unknown ?? []).includes("sharpness"))
    .map((c) => c.score)
    .sort((a, b) => a - b)

  const measuredClv = cohort
    .filter((c) => !(c.unknown ?? []).includes("clv") && !(c.unknown ?? []).includes("sharpness"))
    .map((c) => c.clvScore)
    .sort((a, b) => a - b)

  const measuredVar = cohort
    .filter((c) => !(c.unknown ?? []).includes("var95") && c.var95Usd > 0)
    .map((c) => c.var95Usd)
    .sort((a, b) => a - b)

  const measuredGini = cohort
    .filter((c) => !(c.unknown ?? []).includes("gini"))
    .map((c) => c.gini)
    .sort((a, b) => a - b)

  const scoreMedian = quantile(measuredScores, 0.5)
  const scoreP90 = quantile(measuredScores, 0.9)
  const scoreMean =
    measuredScores.length > 0
      ? measuredScores.reduce((s, v) => s + v, 0) / measuredScores.length
      : null

  const hasScore = !unknown.includes("sharpness")
  const scoreRank = hasScore ? measuredScores.filter((v) => v > cust.score).length + 1 : null

  return {
    cohortSize: cohort.length,
    measuredScoreCount: measuredScores.length,
    scoreRank,
    scorePercentile: hasScore ? percentileRank(measuredScores, cust.score) : null,
    clvPercentile:
      !unknown.includes("clv") && hasScore ? percentileRank(measuredClv, cust.clvScore) : null,
    varPercentile:
      !unknown.includes("var95") && cust.var95Usd > 0
        ? percentileRank(measuredVar, cust.var95Usd)
        : null,
    giniPercentile: !unknown.includes("gini") ? percentileRank(measuredGini, cust.gini) : null,
    cohortMedianScore: scoreMedian !== null ? round(scoreMedian, 2) : null,
    cohortMeanScore: scoreMean !== null ? round(scoreMean, 2) : null,
    cohortP90Score: scoreP90 !== null ? round(scoreP90, 2) : null,
    deltaFromMedianScore:
      hasScore && scoreMedian !== null ? round(cust.score - scoreMedian, 2) : null,
  }
}

/** Identify the top 4 nearest peer accounts by agent/bridge, tier, sport, and score proximity. */
export function findNearestPeerProfiles(
  cust: ShowcaseCustomer,
  cohort: readonly ShowcaseCustomer[],
  limit = 4,
): readonly PeerProfileMatch[] {
  const targetId = cust.id.toUpperCase()
  const twinIds = new Set(
    (cust.forensicDossier?.beardBridge?.crossOfficeTwins ?? []).map((t) => t.loginId.toUpperCase()),
  )
  const sportToken = cust.specialization.split(/[\s_/]+/)[0]?.toUpperCase() ?? ""

  const candidates = cohort
    .filter((other) => other.id.toUpperCase() !== targetId)
    .map((other) => {
      const otherUpper = other.id.toUpperCase()
      const isTwin = twinIds.has(otherUpper)
      const sharedAgent =
        cust.agentId !== "—" &&
        other.agentId !== "—" &&
        other.agentId.toUpperCase() === cust.agentId.toUpperCase()
      const sharedTier = other.tier === cust.tier
      const sharedSport =
        sportToken.length >= 2 && other.specialization.toUpperCase().includes(sportToken)
      const scoreDelta = round(other.score - cust.score, 2)
      const dist = Math.abs(scoreDelta)

      // Lower rankDistance = closer peer
      const rankDistance =
        dist -
        (isTwin ? 12 : 0) -
        (sharedAgent ? 2.2 : 0) -
        (sharedTier ? 1.4 : 0) -
        (sharedSport ? 0.8 : 0)

      const reasons: string[] = []
      if (isTwin) reasons.push("Cross-office bridge twin")
      if (sharedAgent) reasons.push(`Same agent (${other.agentId})`)
      if (sharedTier) reasons.push("Same tier")
      if (sharedSport) reasons.push(`Shared ${sportToken}`)
      if (reasons.length === 0) reasons.push(`Δ ${Math.abs(scoreDelta).toFixed(1)} score`)

      return {
        rankDistance,
        match: {
          id: other.id,
          agentId: other.agentId,
          score: other.score,
          scoreDelta,
          holdPct: other.holdPct,
          sharedAgent,
          sharedTier,
          sharedSport,
          reason: reasons.slice(0, 2).join(" · "),
        } satisfies PeerProfileMatch,
      }
    })
    .sort((a, b) => a.rankDistance - b.rankDistance)

  return candidates.slice(0, limit).map((c) => c.match)
}

/** Extract concrete, formula-backed risk drivers explaining why a bettor is flagged. */
export function extractProfileRiskDrivers(
  cust: ShowcaseCustomer,
  bayesian: BayesianSkillEstimate | null,
  exposure: DeskExposureModel,
): readonly ProfileRiskDriver[] {
  const drivers: ProfileRiskDriver[] = []
  const unknown = cust.unknown ?? []
  const probitRho = cust.forensicDossier?.parlayBacktest?.probitRho ?? null

  if (probitRho !== null && probitRho >= 0.55) {
    drivers.push({
      id: "driver-probit",
      label: "Correlated Parlay Probit ρ",
      severity: probitRho >= 0.65 ? "critical" : "warning",
      metricDisplay: `ρ = ${probitRho.toFixed(3)}`,
      thresholdDisplay: "≥ 0.65 block",
      formulaNote: "Gaussian copula leg correlation triggers alt-subset guard",
      targetTab: "reconciliation",
    })
  } else if (!unknown.includes("correlation") && cust.correlatedRisk === "CRITICAL") {
    drivers.push({
      id: "driver-corr",
      label: "Critical Parlay Correlation",
      severity: "critical",
      metricDisplay: `${Math.round(cust.correlatedExploitRate * 100)}% exploit`,
      thresholdDisplay: "≥ 45% high",
      formulaNote: "Repeated correlated SGP / alt-subset leg combinations",
      targetTab: "reconciliation",
    })
  }

  if (cust.syndicateProb >= 0.6 || cust.syndicateRisk === "HIGH") {
    drivers.push({
      id: "driver-syndicate",
      label: "Syndicate / Beard Bridge Link",
      severity: cust.syndicateProb >= 0.75 ? "critical" : "warning",
      metricDisplay: `${Math.round(cust.syndicateProb * 100)}% prob`,
      thresholdDisplay: "≥ 70% high",
      formulaNote: cust.forensicDossier?.beardBridge
        ? `MFCS ${cust.forensicDossier.beardBridge.mfcsCompositeScore ?? "—"} on ${cust.forensicDossier.beardBridge.sharedIpOrSubnet}`
        : "Downline cluster & shared-IP correlation signal",
      targetTab: "reconciliation",
    })
  }

  if (bayesian && bayesian.impliedEdgePct > 0.5) {
    drivers.push({
      id: "driver-bayesian",
      label: "Positive Bayesian Skill Edge",
      severity: bayesian.probAboveBreakeven >= 0.75 ? "critical" : "warning",
      metricDisplay: `+${bayesian.impliedEdgePct.toFixed(2)}% EV (${Math.round(bayesian.probAboveBreakeven * 100)}% P>BE)`,
      thresholdDisplay: "> 52.38% (-110 BE)",
      formulaNote: `Beta(${bayesian.posteriorAlpha.toFixed(0)}, ${bayesian.posteriorBeta.toFixed(0)}) posterior ${(bayesian.posteriorWinRate * 100).toFixed(1)}%`,
      targetTab: "formulas",
    })
  }

  if (exposure.isVarOverCap && exposure.varToCapPct !== null) {
    drivers.push({
      id: "driver-var-cap",
      label: "7d 95% VaR Breaches Cap",
      severity: "critical",
      metricDisplay: `${exposure.varToCapPct}% of cap`,
      thresholdDisplay: "≤ 100% cap",
      formulaNote: `VaR95 $${cust.var95Usd.toLocaleString()} > limit $${cust.recommendedLimitUsd.toLocaleString()}`,
      targetTab: "formulas",
    })
  }

  if (!unknown.includes("holdPct") && cust.holdPct < -5) {
    drivers.push({
      id: "driver-neg-hold",
      label: "Severe Negative Desk Hold",
      severity: cust.holdPct <= -20 ? "critical" : "warning",
      metricDisplay: `${cust.holdPct.toFixed(1)}% hold`,
      thresholdDisplay: "< 0% desk loss",
      formulaNote: !unknown.includes("ltv")
        ? `Desk net ${cust.ltvUsd < 0 ? "-" : "+"}$${Math.abs(cust.ltvUsd).toLocaleString()}`
        : "Sustained negative desk hold against house margin",
      targetTab: "overview",
    })
  } else if (!unknown.includes("holdPct") && cust.holdPct >= 5) {
    drivers.push({
      id: "driver-pos-hold",
      label: "Favorable House Hold",
      severity: "positive",
      metricDisplay: `+${cust.holdPct.toFixed(1)}% hold`,
      thresholdDisplay: "≥ 5.0% VIP target",
      formulaNote: "Positive desk hold supports retention & full limit allocation",
      targetTab: "formulas",
    })
  }

  if (exposure.policyGapCount > 0 && cust.score >= 6.5) {
    drivers.push({
      id: "driver-policy-gap",
      label: "Desk Countermeasure Policy Gaps",
      severity: exposure.policyGapCount >= 3 ? "critical" : "warning",
      metricDisplay: `${exposure.policyGapCount} gap${exposure.policyGapCount === 1 ? "" : "s"}`,
      thresholdDisplay: "0 gaps",
      formulaNote: "Active cap, delay, or shade is looser than quantitative recommendation",
      targetTab: "formulas",
    })
  }

  return drivers.slice(0, 4)
}

/**
 * Interactive What-If Desk Countermeasure Simulator. Pure, deterministic calculation (<1ms)
 * projecting post-control bettor edge and 30d desk P&L delta.
 */
export function simulateCountermeasureImpact(
  cust: ShowcaseCustomer,
  bayesian: BayesianSkillEstimate | null,
  exposure: DeskExposureModel,
  params: CountermeasureSimulationParams,
): CountermeasureSimulationResult {
  const baselineEdgePct = bayesian
    ? bayesian.impliedEdgePct
    : !cust.unknown?.includes("holdPct")
      ? round(-cust.holdPct, 2)
      : round((cust.score - 5.2) * 1.6, 2)

  // Every 1¢ of line shade trims ~0.42% theoretical bettor edge (standard ~22¢ ≈ 9.1% swing)
  const shadeDeltaCents = Math.max(0, params.lineShadeCents - cust.lineShadeCents)
  const shadeEdgeOffsetPct = round(shadeDeltaCents * 0.42, 2)

  // In-play / steam confirmation delay decays timing-sensitive edge asymptotically
  const timingSensitivity =
    cust.timingArchetype.toUpperCase().includes("STEAM") ||
    cust.timingArchetype.toUpperCase().includes("LIVE") ||
    cust.syndicateProb >= 0.5
      ? 1.0
      : 0.45
  const delayDeltaSec = Math.max(0, params.inPlayDelaySec - cust.inPlayDelaySec)
  const delayEdgeDecayPct = round(
    Math.max(0, baselineEdgePct) * timingSensitivity * (1 - Math.exp(-delayDeltaSec / 7.5)) * 0.45,
    2,
  )

  const projectedEdgePct = round(baselineEdgePct - shadeEdgeOffsetPct - delayEdgeDecayPct, 2)
  const edgeReductionPct = round(baselineEdgePct - projectedEdgePct, 2)

  // Cap throttling scales expected 30d handle proportionally when tighter than mean stake / current cap
  const baseStake =
    !cust.unknown?.includes("meanStake") && cust.meanStake > 0 ? cust.meanStake : 1000
  const referenceCap =
    exposure.hasMeasuredLimit && cust.recommendedLimitUsd > 0
      ? cust.recommendedLimitUsd
      : Math.max(baseStake * 1.5, 2500)
  const capThrottleFactor = round(clamp(params.limitCapUsd / referenceCap, 0.1, 1.5), 3)

  const parlayBacktest = cust.forensicDossier?.parlayBacktest
  const estimated30dHandleUsd =
    parlayBacktest && parlayBacktest.totalParlayHandleUsd > 0
      ? parlayBacktest.totalParlayHandleUsd
      : Math.max(5000, baseStake * 24)

  const baseline30dDeskNetUsd =
    parlayBacktest !== undefined
      ? round(parlayBacktest.baselineDeskNetUsd, 0)
      : round(-estimated30dHandleUsd * (baselineEdgePct / 100), 0)

  const probitSavingsUsd =
    params.probitBlockEnabled && parlayBacktest
      ? round(Math.max(0, parlayBacktest.deskSavingsUsd), 0)
      : params.probitBlockEnabled && cust.correlatedRisk === "CRITICAL"
        ? round(estimated30dHandleUsd * Math.max(0.05, cust.correlatedExploitRate * 0.18), 0)
        : 0

  const throttledHandleUsd = estimated30dHandleUsd * Math.min(1, capThrottleFactor)
  const postEdgeNetUsd = round(-throttledHandleUsd * (projectedEdgePct / 100), 0)
  const projected30dDeskNetUsd =
    parlayBacktest && params.probitBlockEnabled
      ? round(
          Math.max(
            postEdgeNetUsd,
            parlayBacktest.protectedDeskNetUsd +
              throttledHandleUsd * ((shadeEdgeOffsetPct + delayEdgeDecayPct) / 100) * 0.35,
          ),
          0,
        )
      : round(postEdgeNetUsd + probitSavingsUsd * 0.5, 0)

  const projected30dSavingsUsd = round(projected30dDeskNetUsd - baseline30dDeskNetUsd, 0)
  const projectedVarToCapPct =
    exposure.var95Usd !== null && params.limitCapUsd > 0
      ? Math.round((exposure.var95Usd / params.limitCapUsd) * 100)
      : null

  const postControlRiskBand: ProfileRiskBand =
    projectedEdgePct >= 4.0 || (projectedVarToCapPct !== null && projectedVarToCapPct > 125)
      ? "CRITICAL"
      : projectedEdgePct >= 1.5 || (projectedVarToCapPct !== null && projectedVarToCapPct > 90)
        ? "HIGH"
        : projectedEdgePct > 0
          ? "ELEVATED"
          : projectedEdgePct > -3
            ? "MODERATE"
            : "LOW"

  return {
    baselineEdgePct,
    projectedEdgePct,
    edgeReductionPct,
    baseline30dDeskNetUsd,
    projected30dDeskNetUsd,
    projected30dSavingsUsd,
    projectedVarToCapPct,
    postControlRiskBand,
    breakdown: {
      shadeEdgeOffsetPct,
      delayEdgeDecayPct,
      capThrottleFactor,
      probitSavingsUsd,
    },
  }
}

/** Build the complete quantitative model for a single Profiled Bettor. */
export function evaluateProfileQuantitativeModel(
  cust: ShowcaseCustomer,
  cohort: readonly ShowcaseCustomer[] = [],
  liveActivity?: CustomerLiveActivitySummary | null,
): ProfileQuantitativeModel {
  const unknown = cust.unknown ?? []
  const isUnmeasured =
    cust.source === "book" && unknown.includes("sharpness") && unknown.includes("holdPct")

  const rawAxisSum = round(
    cust.clvScore + cust.skillScore + cust.sizingScore + cust.sigScore + cust.timingScore,
    2,
  )
  const conservationDelta = round(rawAxisSum - cust.score, 2)
  const isConserved = Math.abs(conservationDelta) <= 0.02

  const probitRho = cust.forensicDossier?.parlayBacktest?.probitRho ?? null
  const axes: SharpnessAxisDetail[] = SHARPNESS_AXIS_SPECS.map((spec) => {
    const value = round(cust[spec.key], 2)
    const utilizationPct = spec.cap > 0 ? Math.round(clamp((value / spec.cap) * 100, 0, 100)) : 0
    const shareOfTotalPct =
      cust.score > 0 ? Math.round(clamp((value / cust.score) * 100, 0, 100)) : 0

    let observedInput = "Model-derived"
    if (spec.key === "clvScore") {
      const bps = cust.forensicDossier?.parlayBacktest?.avgClvBps
      observedInput =
        bps !== undefined
          ? `Avg CLV ${bps >= 0 ? "+" : ""}${bps} bps`
          : unknown.includes("clv")
            ? "CLV prior from score"
            : `CLV score ${cust.clvScore.toFixed(2)} / 3.0`
    } else if (spec.key === "skillScore") {
      observedInput = unknown.includes("holdPct")
        ? `Composite score ${cust.score.toFixed(1)}/10`
        : `Desk hold ${cust.holdPct.toFixed(1)}% · Net ${cust.ltvUsd < 0 ? "-" : "+"}$${Math.abs(cust.ltvUsd).toLocaleString()}`
    } else if (spec.key === "sizingScore") {
      observedInput = unknown.includes("gini")
        ? unknown.includes("meanStake")
          ? "Stake variance unmeasured"
          : `Mean stake $${cust.meanStake.toLocaleString()} · ${cust.sizingStrategy}`
        : `Gini ${cust.gini.toFixed(3)} · Mean $${cust.meanStake.toLocaleString()}`
    } else if (spec.key === "sigScore") {
      const pb = cust.forensicDossier?.parlayBacktest
      observedInput =
        pb && pb.totalParlayTickets > 0
          ? `${pb.totalParlayTickets} parlays · ${(pb.totalParlayLegs / pb.totalParlayTickets).toFixed(2)} legs/tkt`
          : cust.specialization
    } else if (spec.key === "timingScore") {
      observedInput =
        probitRho !== null
          ? `Probit ρ=${probitRho.toFixed(3)} · ${cust.timingArchetype}`
          : `${cust.timingArchetype}${!unknown.includes("delay") && cust.inPlayDelaySec > 0 ? ` · ${cust.inPlayDelaySec}s delay` : ""}`
    }

    return {
      key: spec.key,
      label: spec.label,
      shortLabel: spec.shortLabel,
      value,
      cap: spec.cap,
      utilizationPct,
      shareOfTotalPct,
      formulaSummary: spec.formulaSummary,
      observedInput,
    }
  })

  const dominatingAxis =
    axes.length > 0 && cust.score > 0
      ? ([...axes].sort((a, b) => b.utilizationPct - a.utilizationPct || b.value - a.value)[0] ??
        null)
      : null

  const bayesian = isUnmeasured ? null : computeProfileBayesianSkill(cust, liveActivity)
  const exposure = computeDeskExposureModel(cust)
  const benchmark = computeCohortBenchmarks(cust, cohort.length > 0 ? cohort : [cust])
  const riskDrivers = isUnmeasured ? [] : extractProfileRiskDrivers(cust, bayesian, exposure)
  const nearestPeers = cohort.length > 1 ? findNearestPeerProfiles(cust, cohort, 4) : []

  return {
    customerId: cust.id,
    isUnmeasured,
    axes,
    axisSum: rawAxisSum,
    conservationDelta,
    isConserved,
    dominatingAxis,
    bayesian,
    exposure,
    benchmark,
    riskDrivers,
    nearestPeers,
  }
}

export interface SharpnessHeatmapOverlay {
  readonly isSharp: boolean
  readonly isClvLeader: boolean
  /** Discrete thermal heat level: 0 = baseline, 1..5 = rising CLV/sharpness intensity. */
  readonly heatLevel: 0 | 1 | 2 | 3 | 4 | 5
  readonly rankedMatch: RankedPlayer30d | null
  /** Basis points of CLV signal from rankings or backtest dossier, or null if absent. */
  readonly clvBps: number | null
  readonly clvSignalLabel: string | null
  readonly rankLabel: string | null
  readonly summaryTitle: string
}

export interface SharpnessHeatmapSummary {
  readonly rankedTotal: number
  readonly matchedCount: number
  readonly sharpCount: number
  readonly clvLeaderCount: number
}

/** Index `NormalizedRankingsResult.players` by uppercase player ID for O(1) profile correlation. */
export function buildRankingsPlayerLookup(
  rankings?: NormalizedRankingsResult | null,
): ReadonlyMap<string, RankedPlayer30d> {
  const byId = new Map<string, RankedPlayer30d>()
  if (!rankings?.players) return byId
  for (const player of rankings.players) {
    const key = player.id.trim().toUpperCase()
    if (!key) continue
    const prev = byId.get(key)
    if (
      !prev ||
      player.score > prev.score ||
      (player.score === prev.score && player.rank < prev.rank)
    ) {
      byId.set(key, player)
    }
  }
  return byId
}

/**
 * Evaluate CLV-leader & sharpness heatmap overlay signals for a single `ShowcaseCustomer` against
 * the 30-day `rankings` index.
 */
export function evaluateSharpnessHeatmapOverlay(
  cust: ShowcaseCustomer,
  rankingsById: ReadonlyMap<string, RankedPlayer30d>,
): SharpnessHeatmapOverlay {
  const rankedMatch = rankingsById.get(cust.id.trim().toUpperCase()) ?? null
  const unknown = cust.unknown ?? []
  const custClvKnown = !unknown.includes("clv")
  const custSharpKnown = !unknown.includes("sharpness")

  const dossierClvBps = cust.forensicDossier?.parlayBacktest?.avgClvBps
  const clvBps =
    rankedMatch?.clvBps !== undefined && Number.isFinite(rankedMatch.clvBps)
      ? rankedMatch.clvBps
      : typeof dossierClvBps === "number" && Number.isFinite(dossierClvBps)
        ? dossierClvBps
        : null

  const rankedTierSharp =
    rankedMatch !== null &&
    (rankedMatch.tier.startsWith("TIER_1") ||
      rankedMatch.tier.startsWith("TIER_2") ||
      rankedMatch.score >= 7.0 ||
      rankedMatch.alertRate >= 25)

  const rankedClvLeader =
    rankedMatch !== null &&
    ((rankedMatch.clvBps !== undefined && rankedMatch.clvBps >= 80) ||
      (rankedMatch.score >= 7.5 && rankedMatch.alertRate >= 25) ||
      (rankedMatch.netUsd !== undefined && rankedMatch.netUsd < 0 && rankedMatch.score >= 6.8))

  const custClvLeader = (custClvKnown && cust.clvScore >= 2.2) || (clvBps !== null && clvBps >= 80)
  const isClvLeader = rankedClvLeader || custClvLeader

  const custSharp = custSharpKnown && cust.score >= 7.5
  const isSharp =
    isClvLeader ||
    rankedTierSharp ||
    (rankedMatch !== null && rankedMatch.score >= 6.5) ||
    custSharp

  let heatLevel: 0 | 1 | 2 | 3 | 4 | 5 = 0
  if (isSharp) {
    const baseScore = Math.max(rankedMatch?.score ?? 0, custSharpKnown ? cust.score : 0)
    const clvBoost = isClvLeader ? 0.9 : 0
    const bpsBoost =
      clvBps !== null && clvBps >= 150 ? 0.6 : clvBps !== null && clvBps >= 80 ? 0.3 : 0
    const alertBoost = rankedMatch && rankedMatch.alertRate >= 35 ? 0.4 : 0
    const composite = baseScore + clvBoost + bpsBoost + alertBoost
    heatLevel =
      composite >= 10.2 ? 5 : composite >= 9.2 ? 4 : composite >= 8.2 ? 3 : composite >= 7.2 ? 2 : 1
  }

  const rankLabel = rankedMatch ? `#${rankedMatch.rank} 30d` : null
  let clvSignalLabel: string | null = null
  if (clvBps !== null) {
    clvSignalLabel = `${clvBps >= 0 ? "+" : ""}${Math.round(clvBps)} bps CLV`
  } else if (rankedMatch && isClvLeader) {
    clvSignalLabel = `CLV-Leader · ${rankedMatch.score.toFixed(1)}`
  } else if (custClvKnown && cust.clvScore >= 2.2) {
    clvSignalLabel = `CLV ${cust.clvScore.toFixed(2)}/3`
  } else if (rankedMatch) {
    clvSignalLabel = `30d ${rankedMatch.score.toFixed(1)} · ${rankedMatch.alertRate.toFixed(0)}% alert`
  }

  const parts: string[] = []
  if (rankedMatch) {
    parts.push(
      `30d Rank #${rankedMatch.rank} (${rankedMatch.tierLabel || rankedMatch.tier}, score ${rankedMatch.score.toFixed(1)})`,
    )
    parts.push(`alert ${rankedMatch.alertRate.toFixed(1)}%`)
  }
  if (clvBps !== null) {
    parts.push(`CLV ${clvBps >= 0 ? "+" : ""}${Math.round(clvBps)} bps`)
  } else if (custClvKnown && cust.clvScore > 0) {
    parts.push(`CLV axis ${cust.clvScore.toFixed(2)}/3.0`)
  }
  if (isClvLeader) {
    parts.push("CLV-Leader signal")
  }

  return {
    isSharp,
    isClvLeader,
    heatLevel,
    rankedMatch,
    clvBps,
    clvSignalLabel,
    rankLabel,
    summaryTitle:
      parts.length > 0
        ? `Sharpness Heatmap: ${parts.join(" · ")}`
        : "No active 30d rankings sharp/CLV overlay signal",
  }
}

/** Summarize Sharpness Heatmap coverage across the currently visible profiled customer rows. */
export function summarizeSharpnessHeatmap(
  customers: readonly ShowcaseCustomer[],
  rankings?: NormalizedRankingsResult | null,
): {
  readonly overlaysById: ReadonlyMap<string, SharpnessHeatmapOverlay>
  readonly summary: SharpnessHeatmapSummary
} {
  const rankingsById = buildRankingsPlayerLookup(rankings)
  const overlaysById = new Map<string, SharpnessHeatmapOverlay>()
  let matchedCount = 0
  let sharpCount = 0
  let clvLeaderCount = 0

  for (const cust of customers) {
    const overlay = evaluateSharpnessHeatmapOverlay(cust, rankingsById)
    overlaysById.set(cust.id, overlay)
    if (overlay.rankedMatch !== null) matchedCount += 1
    if (overlay.isSharp) sharpCount += 1
    if (overlay.isClvLeader) clvLeaderCount += 1
  }

  return {
    overlaysById,
    summary: {
      rankedTotal: rankings?.players.length ?? 0,
      matchedCount,
      sharpCount,
      clvLeaderCount,
    },
  }
}
