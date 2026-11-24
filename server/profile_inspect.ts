/**
 * Bun.inspect.custom formatters for SportsDesk Customer Profiles (ProfileView, ProfileCohortView,
 * ProfileRadarView, and Bun.inspect.table()), mirroring the WebLogView / WebLogVectorView
 * architecture with full Bun.inspect.options & CLI `--options` parity.
 *
 * @file Server/profile_inspect.ts
 */

import {
  type CustomerRetainedHistory,
  parseCustomerRetainedHistory,
} from "@sportsdesk-ops/contracts"

import { redactIpToSubnetHash } from "../lib/http_auth.ts"
import {
  ANSI,
  type BunInspectOptions,
  DeskView,
  formatInspectCliFlags,
  formatInspectCurrency,
  formatInspectNumber,
  formatInspectOptionsObject,
  inspectDeskValue,
  inspectTable,
  padVisibleEnd,
  paint,
  renderInspectOptionsBanner,
  renderProgressBar,
  type ResolvedBunInspectOptions,
  resolveInspectOptions,
  truncateVisible,
} from "./desk_inspect.ts"
import type { ProfileWeblogEvidence } from "./profile_weblog_evidence.ts"

export interface ProfileInspectReconciliation {
  readonly creditLimitUsd: number
  readonly currentBalanceUsd: number
  readonly pendingWagerBalanceUsd: number
  readonly pendingWagerCount: number
  readonly availableBalanceUsd: number
  readonly creditEquationBalanced: boolean
  readonly carryOverUsd: number
  readonly previousBalanceUsd?: number
  readonly carryOverParityMatched?: boolean
  readonly carryOverWindow?: string
  readonly postCarryOverNetUsd: number
  readonly net31dUsd: number
  readonly activeDays31d?: number
  readonly winDays31d?: number
  readonly lossDays31d?: number
  readonly wagerLimitUsd: number
  readonly settleFigureUsd: number
  readonly confirmationDelaySec: number
  readonly wiseLineMovementWeight: number
  readonly inetTarget: string
  readonly assignedParlayName: string
  readonly postureFlags: readonly string[]
}

interface ModeledProfileRecord {
  readonly kind: "modeled"
  readonly id: string
  readonly name: string
  readonly agentId: string
  readonly masterAgent: string
  readonly tier: string
  readonly tierLabel?: string
  readonly profileTypeLabel?: string
  readonly score: number
  readonly clvScore: number
  readonly skillScore: number
  readonly sizingScore: number
  readonly sigScore: number
  readonly timingScore: number
  readonly sizingStrategy: string
  readonly gini: number
  readonly meanStake: number
  readonly specialization: string
  readonly timingArchetype: string
  readonly correlatedRisk: string
  readonly correlatedExploitRate: number
  readonly syndicateRisk: string
  readonly syndicateProb: number
  readonly subAccountIndex?: number | null
  readonly var95Usd: number
  readonly cvar95Usd: number
  readonly holdPct: number
  readonly ltvUsd: number
  readonly recommendedLimitUsd: number
  readonly inPlayDelaySec: number
  readonly lineShadeCents: number
  readonly shadowCopyMultiplier: number
  readonly action: string
  readonly ipAddress: string
  readonly source?: string
  readonly unknown?: readonly string[]
  readonly tags?: readonly string[]
  readonly betCount?: number
  readonly lifetimeVolumeUsd?: number
  readonly lifetimeNetUsd?: number
  readonly openRiskUsd?: number
  readonly portalReconciliation?: ProfileInspectReconciliation
}

interface LiveProfileRecord {
  readonly kind: "live-book"
  readonly id: string
  readonly name: string | null
  readonly agentId: string | null
  readonly source: "book"
  readonly tier: "UNMEASURED"
  readonly score: null
  readonly specialization: null
  readonly ipAddress: null
  readonly var95Usd: null
  readonly holdPct: null
  readonly recommendedLimitUsd: null
  readonly syndicateProb: null
  readonly gini: number | null
  readonly meanStake: number | null
  readonly retainedHistory: CustomerRetainedHistory | null
}

export type ProfileInspectRecord = ModeledProfileRecord | LiveProfileRecord

export type ProfileInspectSortField =
  "score" | "id" | "var95Usd" | "holdPct" | "gini" | "limit" | "meanStake" | "syndicateProb"

export interface ProfileInspectPayload {
  readonly selectedId: string | null
  readonly totalCount: number
  readonly displayedCount: number
  readonly summary: {
    readonly avgSharpness: number | null
    readonly alertCount: number | null
    readonly totalVar95Usd: number | null
    readonly totalLimitCapUsd: number | null
    readonly tierCounts: Record<string, number>
  }
  readonly profileAnsi: string
  readonly cohortAnsi: string
  readonly radarAnsi: string
  readonly tableAnsi: string
  readonly optionsBannerAnsi: string
  readonly resolvedOptions: ResolvedBunInspectOptions
  readonly optionsJsLiteral: string
  readonly cliFlags: string
  readonly profileCliCommand: string
  readonly cohortCliCommand: string
  readonly radarCliCommand: string
  readonly generatedAt: string
}

function tierColor(tier: string): string {
  const upper = tier.toUpperCase()
  if (upper.includes("TIER_1") || upper.includes("ORIGINATOR")) {
    return ANSI.boldRed
  }
  if (upper.includes("TIER_2") || upper.includes("SYNDICATE")) {
    return ANSI.boldYellow
  }
  if (upper.includes("TIER_3") || upper.includes("SHARP")) {
    return ANSI.boldCyan
  }
  if (upper.includes("TIER_4") || upper.includes("SEMI")) {
    return ANSI.magenta
  }
  return ANSI.green
}

function shortTier(tier: string): string {
  const upper = tier.toUpperCase()
  if (upper.includes("TIER_1")) return "T1·ORIG"
  if (upper.includes("TIER_2")) return "T2·SYND"
  if (upper.includes("TIER_3")) return "T3·SHRP"
  if (upper.includes("TIER_4")) return "T4·SEMI"
  if (upper.includes("TIER_5")) return "T5·REC "
  return tier.slice(0, 7)
}

function scoreTone(score: number): "red" | "yellow" | "cyan" | "green" {
  if (score >= 8.0) return "red"
  if (score >= 6.5) return "yellow"
  if (score >= 5.0) return "cyan"
  return "green"
}

function actionColor(action: string): string {
  const upper = action.toUpperCase()
  if (upper.includes("ALERT") || upper.includes("RESTRICT") || upper.includes("SHADOW")) {
    return ANSI.boldRed
  }
  if (upper.includes("MONITOR") || upper.includes("THROTTLE")) {
    return ANSI.boldYellow
  }
  return ANSI.green
}

const AXIS_CAPS = {
  clvScore: 3.0,
  skillScore: 2.5,
  sizingScore: 1.5,
  sigScore: 2.0,
  timingScore: 1.0,
} as const

function finiteNum(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function firstFinite(...values: readonly unknown[]): number | null {
  for (const v of values) {
    const n = finiteNum(v)
    if (n !== null) return n
  }
  return null
}

function clampAxis(value: number, max: number): number {
  return Number(Math.min(max, Math.max(0, value)).toFixed(2))
}

/**
 * Reconciles derived 5-axis sharpness scores (3.0 + 2.5 + 1.5 + 2.0 + 1.0 = 10.0) so their sum
 * equals the composite score without exceeding any axis cap.
 */
export function deriveSharpnessAxes(score: number, clvBps = 0) {
  const clampedScore = Number(Math.min(10, Math.max(0, score)).toFixed(2))
  const clvScore = clampAxis(
    clvBps > 0
      ? Math.min(clampedScore, Math.max(clampedScore * 0.3, clvBps / 100))
      : clampedScore * 0.3,
    AXIS_CAPS.clvScore,
  )
  const otherCaps = [
    AXIS_CAPS.skillScore,
    AXIS_CAPS.sizingScore,
    AXIS_CAPS.sigScore,
    AXIS_CAPS.timingScore,
  ] as const
  let remaining = Math.max(0, clampedScore - clvScore)
  const values = [0, 0, 0, 0]
  const active = [0, 1, 2, 3]
  while (remaining > 1e-6 && active.length > 0) {
    const capSum = active.reduce((sum, idx) => sum + (otherCaps[idx]! - values[idx]!), 0)
    if (capSum <= 1e-6) break
    let overflowed = false
    for (let i = active.length - 1; i >= 0; i--) {
      const idx = active[i]!
      const room = otherCaps[idx]! - values[idx]!
      const share = remaining * (room / capSum)
      if (share >= room - 1e-9) {
        values[idx] = otherCaps[idx]!
        remaining -= room
        active.splice(i, 1)
        overflowed = true
      }
    }
    if (!overflowed) {
      for (const idx of active) {
        const room = otherCaps[idx]! - values[idx]!
        values[idx] = values[idx]! + remaining * (room / capSum)
      }
      remaining = 0
    }
  }
  const rounded = values.map((v, i) => clampAxis(v, otherCaps[i]!))
  const drift = Number(
    (clampedScore - (clvScore + rounded[0]! + rounded[1]! + rounded[2]! + rounded[3]!)).toFixed(2),
  )
  if (drift !== 0) {
    for (let i = 0; i < 4; i++) {
      const candidate = Number((rounded[i]! + drift).toFixed(2))
      if (candidate >= 0 && candidate <= otherCaps[i]!) {
        rounded[i] = candidate
        break
      }
    }
  }
  return {
    clvScore,
    skillScore: rounded[0]!,
    sizingScore: rounded[1]!,
    sigScore: rounded[2]!,
    timingScore: rounded[3]!,
  }
}

export function computeBayesianKelly(p: ModeledProfileRecord) {
  // Desk-perspective net: negative means desk loss (bettor profit), positive means desk profit.
  const deskNetUsd = p.lifetimeNetUsd ?? p.ltvUsd
  const netAdjustment = deskNetUsd < 0 ? 0.018 : deskNetUsd > 0 ? -0.01 : 0
  const volUsd = p.lifetimeVolumeUsd ?? Math.max(1000, p.meanStake * (p.betCount ?? 64))
  const posteriorWinRate = Number(
    Math.min(0.62, Math.max(0.44, 0.5 + (p.score - 5.2) * 0.016 + netAdjustment)).toFixed(4),
  )
  const ciLow = Number(Math.max(0.35, posteriorWinRate - 0.038).toFixed(4))
  const ciHigh = Number(Math.min(0.72, posteriorWinRate + 0.038).toFixed(4))
  const impliedEdgePct = Number(((posteriorWinRate * 1.909 - 1) * 100).toFixed(2))
  const fullKelly = Number(Math.max(0, (posteriorWinRate * 1.909 - 1) / 0.909).toFixed(4))
  const quarterKellyStakeUsd =
    fullKelly <= 0 || p.meanStake <= 0
      ? 0
      : Math.max(1, Math.round(p.meanStake * Math.min(1, fullKelly * 2.5)))
  const probAboveBreakeven =
    posteriorWinRate > 0.5238
      ? Math.min(0.96, Number((0.62 + (posteriorWinRate - 0.5238) * 5.2).toFixed(2)))
      : Math.max(0.12, Number((0.45 - (0.5238 - posteriorWinRate) * 4.5).toFixed(2)))

  return {
    posteriorWinRate,
    ciLow,
    ciHigh,
    impliedEdgePct,
    fullKelly,
    quarterKellyStakeUsd,
    probAboveBreakeven,
    estimatedVolumeUsd: Math.round(volUsd),
  }
}

export function normalizeRawCustomerToProfileRecord(
  row: Record<string, unknown>,
  fallbackId?: string,
): ProfileInspectRecord {
  const id = String(row.id ?? row.customer_id ?? row.customerId ?? fallbackId ?? "UNKNOWN")
    .trim()
    .toUpperCase()
  if (row.provenance === "projected-manager-roster") {
    const history = parseCustomerRetainedHistory(row.retained_history)
    return {
      kind: "live-book",
      id,
      name: typeof row.login === "string" && row.login ? row.login : null,
      agentId: typeof row.agent_id === "string" && row.agent_id ? row.agent_id : null,
      source: "book",
      tier: "UNMEASURED",
      score: null,
      specialization: null,
      ipAddress: null,
      var95Usd: null,
      holdPct: null,
      recommendedLimitUsd: null,
      syndicateProb: null,
      gini: history?.stakeGini ?? null,
      meanStake: history?.meanStakeUsd ?? null,
      retainedHistory: history,
    }
  }
  const unknownSet = new Set<string>(
    Array.isArray(row.unknown) ? row.unknown.map((u) => String(u)) : [],
  )

  const rawLifetimeVol = firstFinite(
    row.lifetimeVolumeUsd,
    row.lifetime_volume_usd,
    row.totalParlayHandleUsd,
    row.total_volume,
    row.lifetime_volume,
    row.volume,
    row.handleUsd,
  )
  const lifetimeVol = rawLifetimeVol !== null && rawLifetimeVol > 0 ? rawLifetimeVol : 48500
  const rawLifetimeNet = firstFinite(
    row.lifetimeNetUsd,
    row.lifetime_net_usd,
    row.baselineDeskNetUsd,
    row.net_pnl,
    row.lifetime_net,
    row.net,
  )
  const lifetimeNet = rawLifetimeNet ?? 0
  const recentTickets = Array.isArray(row.recent_tickets)
    ? (row.recent_tickets as Array<Record<string, unknown>>)
    : []
  const rawBetCount = firstFinite(
    row.betCount,
    row.bet_count,
    row.totalParlayTickets,
    row.total_bets,
    row.wagers,
  )
  const betCount =
    rawBetCount !== null && rawBetCount > 0
      ? rawBetCount
      : recentTickets.length > 0
        ? Math.max(24, recentTickets.length * 16)
        : 64
  const rawMeanStake = firstFinite(row.meanStake, row.mean_stake, row.avg_stake)
  const meanStake = unknownSet.has("meanStake")
    ? (rawMeanStake ?? 0)
    : rawMeanStake !== null && rawMeanStake > 0
      ? rawMeanStake
      : recentTickets.length > 0
        ? Math.round(
            recentTickets.reduce((acc, t) => acc + (Number(t.risk_usd) || 0), 0) /
              recentTickets.length,
          ) || 250
        : rawLifetimeVol !== null && rawLifetimeVol > 0 && betCount > 0
          ? Math.round(rawLifetimeVol / betCount)
          : betCount > 0
            ? Math.round(lifetimeVol / betCount)
            : 250
  const rawHoldPct = firstFinite(row.holdPct, row.hold_pct, row.baselineHoldPct)
  const holdPct =
    rawHoldPct !== null
      ? Number(rawHoldPct.toFixed(2))
      : rawLifetimeNet !== null && lifetimeVol > 0
        ? Number(((lifetimeNet / lifetimeVol) * 100).toFixed(2))
        : 4.5
  const rawSharpInput = firstFinite(row.score, row.compositeScore, row.sharpScore, row.sharp_score)
  const rawSharpScore =
    rawSharpInput !== null ? (rawSharpInput > 10 ? rawSharpInput / 10 : rawSharpInput) : null
  const score =
    rawSharpScore !== null
      ? Number(Math.min(10, Math.max(0.5, rawSharpScore)).toFixed(1))
      : Number(
          Math.min(
            9.8,
            Math.max(2.5, 5.2 + (lifetimeNet < 0 ? 1.8 : -0.7) + (meanStake > 800 ? 1.3 : 0.4)),
          ).toFixed(1),
        )
  const rawContextType =
    typeof row.contextType === "string"
      ? row.contextType
      : typeof row.context_type === "string"
        ? row.context_type
        : ""
  const contextType = rawContextType.toUpperCase()
  const tier = String(
    row.tier ??
      (contextType.includes("STEAM") || contextType.includes("SYNDICATE")
        ? "TIER_2_STEAM_SYNDICATE"
        : score >= 8.5
          ? "TIER_1_ELITE_ORIGINATOR"
          : score >= 7.5
            ? "TIER_2_STEAM_SYNDICATE"
            : score >= 6.5
              ? "TIER_3_SHARP_DISCIPLINED"
              : score >= 5.0
                ? "TIER_4_SEMI_SHARP"
                : "TIER_5_RECREATIONAL"),
  )

  const rawGini = firstFinite(row.gini, row.giniCoefficient)
  const giniKnown = rawGini !== null && !unknownSet.has("gini")
  if (!giniKnown) unknownSet.add("gini")
  const gini = giniKnown ? rawGini : 0

  const sizingKnown =
    !unknownSet.has("sizing") && (typeof row.sizingStrategy === "string" || giniKnown)
  if (!sizingKnown) unknownSet.add("sizing")
  const sizingStrategy =
    typeof row.sizingStrategy === "string"
      ? row.sizingStrategy
      : giniKnown
        ? gini < 0.28
          ? "FLAT_UNIT"
          : gini < 0.45
            ? "KELLY_SCALED"
            : "VARIABLE"
        : "UNMEASURED"

  const sports7dVol = finiteNum(row.sports_7d_volume_usd) ?? 0
  const rawVar95 = firstFinite(row.var95Usd, row.var_95_usd)
  const var95Known = !unknownSet.has("var95") && (rawVar95 !== null || sports7dVol > 0)
  if (!var95Known) unknownSet.add("var95")
  const var95Usd = var95Known ? (rawVar95 ?? Math.round(sports7dVol * 0.24)) : 0
  const rawCvar95 = firstFinite(row.cvar95Usd, row.cvar_95_usd)
  const cvar95Usd = var95Known ? (rawCvar95 ?? Math.round(var95Usd * 1.35)) : 0

  const rawLimit = firstFinite(row.recommendedLimitUsd, row.limitUsd, row.wager_limit_usd)
  const limitKnown = rawLimit !== null && !unknownSet.has("limit")
  if (!limitKnown) unknownSet.add("limit")
  const recommendedLimitUsd = limitKnown ? rawLimit : 0

  const rawDelay = firstFinite(row.inPlayDelaySec, row.delay_seconds)
  const delayKnown = rawDelay !== null && !unknownSet.has("delay")
  if (!delayKnown) unknownSet.add("delay")
  const inPlayDelaySec = delayKnown ? rawDelay : 0

  const rawShade = firstFinite(row.lineShadeCents, row.line_shade_cents)
  const shadeKnown = rawShade !== null && !unknownSet.has("shade")
  if (!shadeKnown) unknownSet.add("shade")
  const lineShadeCents = shadeKnown ? rawShade : 0

  const rawCopy = firstFinite(row.shadowCopyMultiplier, row.shadow_copy_multiplier)
  const copyKnown = rawCopy !== null && !unknownSet.has("copy")
  if (!copyKnown) unknownSet.add("copy")
  const shadowCopyMultiplier = copyKnown ? rawCopy : 0

  const rawSyndicateProb = firstFinite(row.syndicateProb, row.syndicate_prob)
  const syndicateKnown = rawSyndicateProb !== null && !unknownSet.has("syndicate")
  if (!syndicateKnown) unknownSet.add("syndicate")
  const syndicateProb = syndicateKnown ? Math.min(1, Math.max(0, rawSyndicateProb)) : 0
  const syndicateRisk = syndicateKnown
    ? String(
        row.syndicateRisk ??
          row.syndicate_risk ??
          (syndicateProb >= 0.7 ? "HIGH" : syndicateProb >= 0.4 ? "ELEVATED" : "LOW"),
      )
    : "UNMEASURED"

  const rawProbitRho = firstFinite(row.probitRho, row.probit_rho)
  const rawCorrRate = firstFinite(
    row.correlatedExploitRate,
    row.correlated_exploit_rate,
    rawProbitRho,
  )
  const guardUpper =
    typeof row.primaryGuardTriggered === "string" ? row.primaryGuardTriggered.toUpperCase() : ""
  const deskSavingsUsd = finiteNum(row.deskSavingsUsd) ?? 0
  const hasBacktestCorrelation =
    rawProbitRho !== null ||
    contextType.includes("PARLAY") ||
    guardUpper.includes("PROBIT") ||
    guardUpper.includes("SUBSET") ||
    guardUpper.includes("CORREL")
  const correlationKnown =
    !unknownSet.has("correlation") &&
    (rawCorrRate !== null ||
      hasBacktestCorrelation ||
      (typeof row.correlatedRisk === "string" &&
        row.correlatedRisk !== "NONE" &&
        row.correlatedRisk !== "UNMEASURED"))
  if (!correlationKnown) unknownSet.add("correlation")
  const correlatedExploitRate = correlationKnown
    ? (rawCorrRate ?? Number(Math.min(0.95, Math.max(0.25, Math.abs(holdPct) / 100)).toFixed(2)))
    : 0
  const correlatedRisk = correlationKnown
    ? String(
        row.correlatedRisk ??
          ((rawProbitRho !== null && rawProbitRho >= 0.65) ||
          guardUpper.includes("PROBIT") ||
          deskSavingsUsd >= 100_000
            ? "CRITICAL"
            : correlatedExploitRate >= 0.45
              ? "HIGH"
              : "MODERATE"),
      )
    : "UNMEASURED"

  const clvBps = firstFinite(row.avgClvBps, row.clv_bps) ?? 0
  const derivedAxes = deriveSharpnessAxes(score, clvBps)
  const rawClvScore = firstFinite(row.clvScore)
  const rawSkillScore = firstFinite(row.skillScore)
  const rawSizingScore = firstFinite(row.sizingScore)
  const rawSigScore = firstFinite(row.sigScore)
  const rawTimingScore = firstFinite(row.timingScore)
  const clvScore =
    rawClvScore !== null ? clampAxis(rawClvScore, AXIS_CAPS.clvScore) : derivedAxes.clvScore
  const skillScore =
    rawSkillScore !== null ? clampAxis(rawSkillScore, AXIS_CAPS.skillScore) : derivedAxes.skillScore
  const sizingScore =
    rawSizingScore !== null
      ? clampAxis(rawSizingScore, AXIS_CAPS.sizingScore)
      : derivedAxes.sizingScore
  const sigScore =
    rawSigScore !== null ? clampAxis(rawSigScore, AXIS_CAPS.sigScore) : derivedAxes.sigScore
  const timingScore =
    rawTimingScore !== null
      ? clampAxis(rawTimingScore, AXIS_CAPS.timingScore)
      : derivedAxes.timingScore

  const firstLeague =
    recentTickets.length > 0 && typeof recentTickets[0]?.league === "string"
      ? `${String(recentTickets[0].league)} ${String(recentTickets[0].market ?? "")}`.trim()
      : null
  const rawLtv = firstFinite(row.ltvUsd, row.ltv_usd)
  const ltvUsd = rawLtv !== null ? Math.round(rawLtv) : Math.round(lifetimeNet)

  return {
    kind: "modeled",
    id,
    name: String(row.name ?? row.customer_name ?? id),
    agentId: String(row.agentId ?? row.agent_id ?? row.agent ?? "BILLY666"),
    masterAgent: String(row.masterAgent ?? row.master_agent ?? "BILLY666"),
    tier,
    tierLabel: typeof row.tierLabel === "string" ? row.tierLabel : undefined,
    profileTypeLabel:
      typeof row.profileTypeLabel === "string" ? row.profileTypeLabel : contextType || undefined,
    score,
    clvScore,
    skillScore,
    sizingScore,
    sigScore,
    timingScore,
    sizingStrategy,
    gini,
    meanStake,
    specialization: String(
      row.specialization ??
        row.dominantComboFamily ??
        row.dominantSport ??
        firstLeague ??
        "Multi-Market",
    ),
    timingArchetype: String(
      row.timingArchetype ??
        (contextType || (score >= 7.5 ? "EARLY_OPENER" : "RECREATIONAL_PREGAME")),
    ),
    correlatedRisk,
    correlatedExploitRate,
    syndicateRisk,
    syndicateProb,
    subAccountIndex: typeof row.subAccountIndex === "number" ? row.subAccountIndex : null,
    var95Usd,
    cvar95Usd,
    holdPct,
    ltvUsd,
    recommendedLimitUsd,
    inPlayDelaySec,
    lineShadeCents,
    shadowCopyMultiplier,
    action: String(
      row.action ??
        (score >= 8
          ? "ALERT · SHADOW & RESTRICT KEY BUYS"
          : score >= 6.5
            ? "MONITOR · CAP KEY-NUMBER BUYS"
            : "ACCEPT · STANDARD SURVEILLANCE"),
    ),
    ipAddress: redactIpToSubnetHash(
      String(
        row.ipAddress ??
          row.ip_address ??
          row.ipSubnet ??
          row.ip_subnet ??
          row.ip ??
          "102.128.164.122",
      ),
    ).redacted,
    source: typeof row.source === "string" ? row.source : "cohort",
    unknown: unknownSet.size > 0 ? Array.from(unknownSet) : undefined,
    tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t)) : undefined,
    betCount,
    lifetimeVolumeUsd: lifetimeVol,
    lifetimeNetUsd: lifetimeNet,
    openRiskUsd: typeof row.openRiskUsd === "number" ? row.openRiskUsd : undefined,
    portalReconciliation:
      row.portalReconciliation && typeof row.portalReconciliation === "object"
        ? (row.portalReconciliation as ProfileInspectReconciliation)
        : undefined,
  }
}

export function sortProfileRecords(
  records: readonly ProfileInspectRecord[],
  sort: ProfileInspectSortField = "score",
  dir: "asc" | "desc" = "desc",
): ProfileInspectRecord[] {
  const factor = dir === "asc" ? 1 : -1
  if (sort === "id") return [...records].sort((a, b) => a.id.localeCompare(b.id) * factor)
  const key = sort === "limit" ? "recommendedLimitUsd" : sort
  const compare = (a: number | null, b: number | null) =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : (a - b) * factor
  return [...records].sort(
    (a, b) =>
      compare(a[key], b[key]) ||
      (sort === "score" ? compare(a.var95Usd, b.var95Usd) : compare(a.score, b.score)),
  )
}

// ── 1. ProfileView (Single Customer Deep Forensic Card) ──────────────────────

export class ProfileView extends DeskView<ProfileInspectRecord> {
  private readonly meta: { readonly showOptions?: boolean }
  constructor(
    profile: ProfileInspectRecord,
    meta: {
      readonly showOptions?: boolean
    } = {},
  ) {
    super([profile])
    this.meta = meta
  }

  render(options: BunInspectOptions = {}): string {
    const opts = resolveInspectOptions(options)
    const colors = opts.colors
    const p = this.rows[0]
    if (!p) {
      return paint("◆ ProfileView: (no profile selected)", ANSI.gray, colors)
    }

    if (p.kind === "live-book") {
      const history = p.retainedHistory
      const usd = (value: number | null) =>
        value === null ? "Unavailable" : `$${formatInspectNumber(value, { ...opts, decimals: 2 })}`
      return [
        paint(`◆ PROFILE INSPECTOR: ${p.id}`, ANSI.boldCyan, colors),
        `Login: ${p.name ?? "Unavailable"} · Agent: ${p.agentId ?? "Unavailable"}`,
        ...(history
          ? [
              `Retained wagers: ${history.retainedWagers} · Eligible: ${history.eligibleWagers} · Excluded: ${history.excludedWagers} · Conflicting: ${history.conflictingWagers}`,
              `Eligible stake: ${usd(history.stakeUsd)} · Mean stake: ${usd(p.meanStake)} · Stake Gini: ${p.gini ?? "Unavailable"}`,
              `Reported wins/losses: ${history.wins}/${history.losses} · Reported net: ${usd(history.reportedNetUsd)} · Provisional ROI: ${history.provisionalRoiPct === null ? "Unavailable" : history.provisionalRoiPct + "%"}`,
            ]
          : ["Retained wager history: Unavailable"]),
        "Lifetime totals, risk ratings and trading directives: Unavailable",
        ...(this.meta.showOptions
          ? [renderInspectOptionsBanner(opts, "ProfileView --options", { showOptions: true })]
          : []),
      ].join("\n")
    }

    const cardWidth = Math.max(60, Math.min(116, opts.breakLength - 2))
    const innerWidth = cardWidth - 2
    const top = paint(`╔${"═".repeat(cardWidth)}╗`, ANSI.boldCyan, colors)
    const div = paint(`╠${"═".repeat(cardWidth)}╣`, ANSI.boldCyan, colors)
    const bot = paint(`╚${"═".repeat(cardWidth)}╝`, ANSI.boldCyan, colors)
    const frame = (content: string) =>
      paint("║ ", ANSI.boldCyan, colors) +
      padVisibleEnd(truncateVisible(content, innerWidth), innerWidth) +
      paint(" ║", ANSI.boldCyan, colors)

    const fmtCur = (val: number, signed = false) =>
      formatInspectCurrency(val, {
        numericSeparator: opts.numericSeparator,
        signed,
      })
    const fmtNum = (val: number, decimals?: number) =>
      formatInspectNumber(val, {
        numericSeparator: opts.numericSeparator,
        decimals,
      })

    const tone = scoreTone(p.score)
    const scoreBarW = opts.compact ? 12 : 18
    const scoreGauge = renderProgressBar(p.score, 10, scoreBarW, tone, colors)
    const unknownSet = new Set(p.unknown ?? [])

    const lines: string[] = [
      top,
      frame(
        `${paint(`◆ PROFILE INSPECTOR: ${p.id}`, ANSI.boldWhite, colors)} ` +
          `${paint(`[ProfileView[Bun.inspect.custom]]`, ANSI.cyan, colors)}`,
      ),
      frame(
        paint(
          `opts: depth=${opts.depth} · ${opts.compact ? "compact" : "full"} · sorted=${opts.sorted} · hidden=${opts.showHidden} · numSep=${opts.numericSeparator} · getters=${opts.getters}`,
          ANSI.gray,
          colors,
        ),
      ),
      div,
      frame(
        `${paint("Identity:", ANSI.gray, colors)} ${paint(p.id, ANSI.boldWhite, colors)} (${truncateVisible(p.name, 20)})  ` +
          `${paint("Agent:", ANSI.gray, colors)} ${paint(p.agentId, ANSI.cyan, colors)}/${p.masterAgent}  ` +
          `${paint("IP:", ANSI.gray, colors)} ${paint(p.ipAddress, ANSI.yellow, colors)}`,
      ),
      frame(
        `${paint("Tier:", ANSI.gray, colors)} ${paint(p.profileTypeLabel ?? p.tierLabel ?? p.tier, tierColor(p.tier), colors)}  ` +
          `${paint("Sharp:", ANSI.gray, colors)} [${scoreGauge}] ${paint(`${fmtNum(p.score, 1)}/10.0`, tierColor(p.tier), colors)}`,
      ),
      frame(
        `${paint("Directive:", ANSI.gray, colors)} ${paint(p.action, actionColor(p.action), colors)}`,
      ),
    ]

    // Depth >= 1: Core risk & capital controls
    if (opts.depth >= 1) {
      lines.push(div)
      lines.push(frame(paint("CAPITAL EXPOSURE & DESK DIRECTIVES", ANSI.boldYellow, colors)))
      const metrics: Array<{ k: string; v: string; c: string }> = [
        {
          k: "7d 95% VaR / CVaR",
          v: unknownSet.has("var95") ? "—" : `${fmtCur(p.var95Usd)} / ${fmtCur(p.cvar95Usd)}`,
          c: ANSI.yellow,
        },
        {
          k: "Recommended Limit",
          v:
            unknownSet.has("limit") && unknownSet.has("delay") && unknownSet.has("shade")
              ? "—"
              : `${unknownSet.has("limit") ? "—" : fmtCur(p.recommendedLimitUsd)} · Delay: ${unknownSet.has("delay") ? "—" : `${p.inPlayDelaySec}s`} · Shade: ${unknownSet.has("shade") ? "—" : `${p.lineShadeCents}¢`}`,
          c: ANSI.cyan,
        },
        {
          k: "Lifetime Hold / LTV",
          v: `${unknownSet.has("holdPct") ? "—" : `${fmtNum(p.holdPct, 2)}%`}  ·  LTV: ${unknownSet.has("ltv") ? "—" : fmtCur(p.ltvUsd, true)}`,
          c: p.holdPct < 0 ? ANSI.boldRed : ANSI.green,
        },
        {
          k: "Sizing & Gini",
          v: `${unknownSet.has("sizing") ? "—" : p.sizingStrategy} · Gini=${unknownSet.has("gini") ? "—" : fmtNum(p.gini, 2)} · Mean=${unknownSet.has("meanStake") ? "—" : fmtCur(p.meanStake)}`,
          c: ANSI.white,
        },
        {
          k: "Syndicate / Parlay",
          v:
            unknownSet.has("syndicate") && unknownSet.has("correlation") && unknownSet.has("copy")
              ? "—"
              : `Synd=${unknownSet.has("syndicate") ? "—" : `${p.syndicateRisk} (${Math.round(p.syndicateProb * 100)}%)`} · Corr=${unknownSet.has("correlation") ? "—" : `${p.correlatedRisk} (${Math.round(p.correlatedExploitRate * 100)}%)`} · Copy=${unknownSet.has("copy") ? "—" : `${p.shadowCopyMultiplier.toFixed(2)}x`}`,
          c:
            (!unknownSet.has("syndicate") && p.syndicateRisk === "HIGH") ||
            (!unknownSet.has("correlation") &&
              (p.correlatedRisk === "CRITICAL" || p.correlatedRisk === "HIGH"))
              ? ANSI.boldRed
              : ANSI.yellow,
        },
      ]
      const orderedMetrics = opts.sorted
        ? [...metrics].sort((a, b) => a.k.localeCompare(b.k))
        : metrics
      for (const m of orderedMetrics) {
        lines.push(
          frame(`  ${paint(m.k.padEnd(20), ANSI.gray, colors)} ${paint(m.v, m.c, colors)}`),
        )
      }
    }

    // Depth >= 2: 5-Axis Sharpness Decomposition Radar Bars
    if (opts.depth >= 2) {
      lines.push(div)
      lines.push(
        frame(
          `${paint("5-AXIS SHARPNESS DECOMPOSITION", ANSI.boldCyan, colors)} ` +
            `${paint(`· ${p.specialization} · ${p.timingArchetype}`, ANSI.gray, colors)}`,
        ),
      )
      const axes: Array<{
        label: string
        value: number
        max: number
        tone: "red" | "yellow" | "cyan" | "green"
      }> = [
        { label: "CLV Beat Margin", value: p.clvScore, max: 3.0, tone: "red" },
        { label: "Bayesian Skill", value: p.skillScore, max: 2.5, tone: "yellow" },
        { label: "Sizing Discipline", value: p.sizingScore, max: 1.5, tone: "cyan" },
        { label: "Signature Spec.", value: p.sigScore, max: 2.0, tone: "yellow" },
        { label: "Timing / Parlay", value: p.timingScore, max: 1.0, tone: "green" },
      ]
      const orderedAxes = opts.sorted
        ? [...axes].sort((a, b) => a.label.localeCompare(b.label))
        : axes
      const barW = opts.compact ? 14 : 24
      for (const axis of orderedAxes) {
        const pct = Math.round((axis.value / axis.max) * 100)
        const gauge = renderProgressBar(axis.value, axis.max, barW, axis.tone, colors)
        lines.push(
          frame(
            `  ${paint(axis.label.padEnd(18), ANSI.white, colors)} ${gauge} ` +
              `${paint(`${axis.value.toFixed(2)}/${axis.max.toFixed(1)}`, ANSI.boldWhite, colors)} ` +
              `${paint(`(${String(pct).padStart(3)}%)`, ANSI.gray, colors)}`,
          ),
        )
      }
    }

    // Depth >= 3 or getters: Bayesian/Kelly & Portal Reconciliation & Tags
    if (opts.depth >= 3 || opts.getters) {
      const bk = computeBayesianKelly(p)
      lines.push(
        frame(
          `${paint("BAYESIAN POSTERIOR & KELLY METRICS", ANSI.boldMagenta, colors)} ` +
            `${paint(opts.getters ? "(getters=true)" : "(depth>=3)", ANSI.gray, colors)}`,
        ),
      )
      lines.push(
        frame(
          `  ${paint("Posterior WinRate:", ANSI.gray, colors)} ${paint(`${(bk.posteriorWinRate * 100).toFixed(2)}%`, ANSI.boldYellow, colors)} ` +
            `${paint(`CI95=[${(bk.ciLow * 100).toFixed(1)}%, ${(bk.ciHigh * 100).toFixed(1)}%]`, ANSI.gray, colors)}  ` +
            `${paint(`P(>BE)=${Math.round(bk.probAboveBreakeven * 100)}%`, ANSI.cyan, colors)}`,
        ),
      )
      lines.push(
        frame(
          `  ${paint("Implied Edge:", ANSI.gray, colors)} ${paint(`${bk.impliedEdgePct >= 0 ? "+" : ""}${bk.impliedEdgePct.toFixed(2)}%`, bk.impliedEdgePct > 0 ? ANSI.boldRed : ANSI.green, colors)}  ` +
            `${paint("Full Kelly:", ANSI.gray, colors)} ${paint(`${(bk.fullKelly * 100).toFixed(2)}%`, ANSI.white, colors)}  ` +
            `${paint("¼-Kelly Stake:", ANSI.gray, colors)} ${paint(unknownSet.has("meanStake") ? "—" : fmtCur(bk.quarterKellyStakeUsd), ANSI.yellow, colors)}`,
        ),
      )

      if (p.tags && p.tags.length > 0) {
        const tagList = opts.sorted ? [...p.tags].sort() : p.tags
        lines.push(
          frame(
            `  ${paint("Profile Tags:", ANSI.gray, colors)} ${paint(tagList.join(" · "), ANSI.cyan, colors)}`,
          ),
        )
      }

      if (p.portalReconciliation) {
        const pr = p.portalReconciliation
        lines.push(div)
        lines.push(
          frame(
            `${paint("PORTAL CREDIT & CARRYOVER RECONCILIATION", ANSI.boldGreen, colors)} ` +
              `${paint(pr.creditEquationBalanced ? "✓ 0¢ DELTA" : "⚠ LEDGER DELTA", pr.creditEquationBalanced ? ANSI.green : ANSI.boldRed, colors)}`,
          ),
        )
        lines.push(
          frame(
            `  ${paint("Credit:", ANSI.gray, colors)} ${fmtCur(pr.creditLimitUsd)} · ` +
              `${paint("Bal:", ANSI.gray, colors)} ${fmtCur(pr.currentBalanceUsd, true)} · ` +
              `${paint("Pending:", ANSI.gray, colors)} ${fmtCur(pr.pendingWagerBalanceUsd)} (${pr.pendingWagerCount}) · ` +
              `${paint("Avail:", ANSI.gray, colors)} ${fmtCur(pr.availableBalanceUsd)}`,
          ),
        )
        lines.push(
          frame(
            `  ${paint("CarryOver:", ANSI.gray, colors)} ${fmtCur(pr.carryOverUsd, true)} · ` +
              `${paint("31d Net:", ANSI.gray, colors)} ${fmtCur(pr.net31dUsd, true)} · ` +
              `${paint("WiseWt:", ANSI.gray, colors)} ${pr.wiseLineMovementWeight} · ` +
              `${paint("Inet:", ANSI.gray, colors)} ${pr.inetTarget}`,
          ),
        )
        if (pr.postureFlags.length > 0) {
          lines.push(
            frame(
              `  ${paint("Posture Flags:", ANSI.gray, colors)} ${paint(pr.postureFlags.join(", "), ANSI.yellow, colors)}`,
            ),
          )
        }
      }
    }

    // showHidden: Internal diagnostics & provenance symbols
    if (opts.showHidden) {
      lines.push(div)
      lines.push(
        frame(
          paint("[Symbol(showHidden)] INTERNAL PROVENANCE & DIAGNOSTICS", ANSI.magenta, colors),
        ),
      )
      lines.push(
        frame(
          `  source=${p.source ?? "cohort"} · subAccountIdx=${p.subAccountIndex ?? "null"} · openRisk=${p.openRiskUsd !== undefined ? fmtCur(p.openRiskUsd) : "—"}`,
        ),
      )
      lines.push(
        frame(
          `  unknownFields=[${(p.unknown ?? []).join(", ") || "none"}] · inspectHook=Symbol.for("Bun.inspect.custom")`,
        ),
      )
    }

    lines.push(bot)

    if (this.meta.showOptions) {
      lines.push(renderInspectOptionsBanner(opts, "ProfileView --options", { showOptions: true }))
    }

    return lines.join("\n")
  }
}

// ── 2. ProfileCohortView (Multi-Profile Cohort Table & Distribution Meter) ──

function summarizeProfiles(
  rows: readonly ProfileInspectRecord[],
): ProfileInspectPayload["summary"] {
  const tierCounts: Record<string, number> = {}
  let score = 0,
    alerts = 0,
    valueAtRisk = 0,
    limits = 0
  let complete = rows.length > 0
  for (const row of rows) {
    tierCounts[row.tier] = (tierCounts[row.tier] ?? 0) + 1
    if (row.kind === "live-book") {
      complete = false
      continue
    }
    score += row.score
    alerts += Number(row.action.toUpperCase().includes("ALERT"))
    valueAtRisk += row.var95Usd
    limits += row.recommendedLimitUsd
  }
  return {
    avgSharpness: complete ? Number((score / rows.length).toFixed(2)) : null,
    alertCount: complete ? alerts : null,
    totalVar95Usd: complete ? valueAtRisk : null,
    totalLimitCapUsd: complete ? limits : null,
    tierCounts,
  }
}

export class ProfileCohortView extends DeskView<ProfileInspectRecord> {
  private readonly meta: {
    readonly totalCount: number
    readonly sort: ProfileInspectSortField
    readonly dir: "asc" | "desc"
    readonly activeFilters?: readonly string[]
    readonly showOptions?: boolean
  }
  constructor(
    rows: readonly ProfileInspectRecord[],
    meta: {
      readonly totalCount: number
      readonly sort: ProfileInspectSortField
      readonly dir: "asc" | "desc"
      readonly activeFilters?: readonly string[]
      readonly showOptions?: boolean
    },
  ) {
    super(rows)
    this.meta = meta
  }

  render(options: BunInspectOptions = {}): string {
    const opts = resolveInspectOptions(options)
    const colors = opts.colors
    const frameWidth = Math.max(60, Math.min(116, opts.breakLength))
    const rule = paint("─".repeat(frameWidth), ANSI.gray, colors)

    const summary = summarizeProfiles(this.rows)
    const hasLiveProfiles = this.rows.some((row) => row.kind === "live-book")
    const formatTotal = (amount: number | null) =>
      amount === null ? "—" : formatInspectCurrency(amount, opts)

    const header = paint(
      "◆ SPORTSDESK PROFILES COHORT INSPECTOR [ProfileCohortView[Bun.inspect.custom]]",
      ANSI.boldCyan,
      colors,
    )
    const subtitleParts = [
      `rows=${formatInspectNumber(this.rows.length, { numericSeparator: opts.numericSeparator })}/${formatInspectNumber(this.meta.totalCount, { numericSeparator: opts.numericSeparator })}`,
      `avgSharp=${summary.avgSharpness?.toFixed(1) ?? "—"}`,
      `alerts=${summary.alertCount ?? "—"}`,
      `ΣVaR=${formatTotal(summary.totalVar95Usd)}`,
      `ΣCap=${formatTotal(summary.totalLimitCapUsd)}`,
      `sort=${this.meta.sort}:${this.meta.dir}`,
      `depth=${opts.depth}`,
      opts.compact ? "compact" : "full",
      opts.sorted ? "sorted=id" : null,
    ].filter(Boolean)
    const subtitle = paint(`  ${subtitleParts.join(" · ")}`, ANSI.gray, colors)

    const filterLine =
      this.meta.activeFilters && this.meta.activeFilters.length > 0
        ? paint(`  filters: ${this.meta.activeFilters.join(" · ")}`, ANSI.yellow, colors)
        : null

    if (this.rows.length === 0) {
      return [
        header,
        subtitle,
        ...(filterLine ? [filterLine] : []),
        paint("  No customer profiles match the active filters.", ANSI.gray, colors),
        ...(this.meta.showOptions
          ? [renderInspectOptionsBanner(opts, "ProfileCohortView --options", { showOptions: true })]
          : []),
      ].join("\n")
    }

    // Tier distribution meter
    const counts = { t1: 0, t2: 0, t3: 0, t4: 0, t5: 0 }
    for (const r of this.rows) {
      const t = r.tier.toUpperCase()
      if (t.includes("TIER_1")) counts.t1 += 1
      else if (t.includes("TIER_2")) counts.t2 += 1
      else if (t.includes("TIER_3")) counts.t3 += 1
      else if (t.includes("TIER_4")) counts.t4 += 1
      else if (t.includes("TIER_5")) counts.t5 += 1
    }
    const meterW = opts.compact ? 20 : 30
    const tot = this.rows.length
    const w1 = Math.round((counts.t1 / tot) * meterW)
    const w2 = Math.round((counts.t2 / tot) * meterW)
    const w3 = Math.round((counts.t3 / tot) * meterW)
    const w4 = Math.round((counts.t4 / tot) * meterW)
    const unmeasuredWidth = Math.round(((summary.tierCounts.UNMEASURED ?? 0) / tot) * meterW)
    const w5 = Math.max(0, meterW - w1 - w2 - w3 - w4 - unmeasuredWidth)
    const tierBar =
      paint("█".repeat(w1), ANSI.boldRed, colors) +
      paint("█".repeat(w2), ANSI.yellow, colors) +
      paint("█".repeat(w3), ANSI.cyan, colors) +
      paint("█".repeat(w4), ANSI.magenta, colors) +
      paint("█".repeat(w5), ANSI.green, colors) +
      paint("░".repeat(unmeasuredWidth), ANSI.gray, colors)
    const tierLegend = [
      paint(`T1:${counts.t1}`, ANSI.boldRed, colors),
      paint(`T2:${counts.t2}`, ANSI.yellow, colors),
      paint(`T3:${counts.t3}`, ANSI.cyan, colors),
      paint(`T4:${counts.t4}`, ANSI.magenta, colors),
      paint(`T5:${counts.t5}`, ANSI.green, colors),
      ...(hasLiveProfiles ? [`Unmeasured:${summary.tierCounts.UNMEASURED}`] : []),
    ].join(" ")
    const meterLine = `  ${paint("TIERS", ANSI.boldWhite, colors)} [${tierBar}] ${tierLegend}`

    const displayRows = opts.sorted
      ? [...this.rows].sort((a, b) => a.id.localeCompare(b.id))
      : this.rows

    const effectiveMaxRows =
      options.maxArrayLength !== undefined
        ? opts.maxArrayLength
        : opts.depth <= 1
          ? 8
          : opts.compact
            ? 14
            : opts.depth >= 3
              ? 30
              : 18

    const formatted = displayRows.map((p) => {
      if (p.kind === "live-book")
        return {
          CUSTOMER: p.id,
          TIER: p.tier,
          AGENT: p.agentId,
          GINI: p.gini,
          MEAN: p.meanStake,
          SRC: p.source,
        }
      const bk = opts.getters ? computeBayesianKelly(p) : null
      const unknownSet = new Set(p.unknown ?? [])
      return {
        CUSTOMER: paint(p.id, ANSI.boldWhite, colors),
        TIER: paint(shortTier(p.tier), tierColor(p.tier), colors),
        SHARP: paint(p.score.toFixed(1), tierColor(p.tier), colors),
        AGENT: paint(p.agentId, ANSI.cyan, colors),
        GINI: unknownSet.has("gini") ? "—" : p.gini,
        MEAN: unknownSet.has("meanStake") ? "—" : p.meanStake,
        VAR95: unknownSet.has("var95") ? "—" : p.var95Usd,
        HOLD: unknownSet.has("holdPct")
          ? "—"
          : paint(`${p.holdPct.toFixed(1)}%`, p.holdPct < 0 ? ANSI.boldRed : ANSI.green, colors),
        LIMIT: unknownSet.has("limit") ? "—" : p.recommendedLimitUsd,
        DIRECTIVE: paint(
          truncateVisible(p.action, Math.min(opts.maxStringLength, opts.compact ? 18 : 26)),
          actionColor(p.action),
          colors,
        ),
        ...(opts.getters && bk
          ? {
              "EDGE%": paint(
                `${bk.impliedEdgePct >= 0 ? "+" : ""}${bk.impliedEdgePct.toFixed(1)}%`,
                bk.impliedEdgePct > 0 ? ANSI.boldRed : ANSI.green,
                colors,
              ),
            }
          : {}),
        ...(opts.showHidden
          ? {
              SRC: paint(p.source ?? "cohort", ANSI.gray, colors),
            }
          : {}),
      }
    })

    const cols: string[] = opts.compact
      ? ["CUSTOMER", "TIER", "SHARP", "VAR95", "HOLD", "LIMIT"]
      : ["CUSTOMER", "TIER", "SHARP", "AGENT", "GINI", "VAR95", "HOLD", "LIMIT", "DIRECTIVE"]
    if (hasLiveProfiles) cols.push("MEAN")
    if (opts.getters) cols.push("EDGE%")
    if (opts.showHidden) cols.push("SRC")

    const table = inspectTable(formatted, cols, {
      ...opts,
      maxArrayLength: effectiveMaxRows,
      maxColWidth: Math.min(opts.maxStringLength, opts.compact ? 18 : 28),
    })

    const deepLines: string[] = []
    if (opts.depth >= 3) {
      const topRisks = this.rows
        .filter((row) => row.kind === "modeled")
        .sort((a, b) => b.score - a.score || b.var95Usd - a.var95Usd)
        .slice(0, 5)
      if (topRisks.length)
        deepLines.push(
          `  ${paint("HIGH-PRIORITY SYNDICATE & SHARP HOTSPOTS (depth>=3)", ANSI.boldYellow, colors)}`,
        )
      for (const r of topRisks) {
        deepLines.push(
          `  • ${paint(r.id.padEnd(10), ANSI.boldWhite, colors)} ` +
            `${paint(shortTier(r.tier), tierColor(r.tier), colors)} ` +
            `sharp=${paint(r.score.toFixed(1), ANSI.yellow, colors)} · ` +
            `VaR=${formatInspectCurrency(r.var95Usd, { numericSeparator: opts.numericSeparator })} · ` +
            `IP=${paint(r.ipAddress, ANSI.cyan, colors)} · ` +
            `${paint(r.specialization, ANSI.gray, colors)}`,
        )
      }
    }

    return [
      header,
      subtitle,
      ...(filterLine ? [filterLine] : []),
      rule,
      meterLine,
      table,
      ...deepLines,
      ...(this.meta.showOptions
        ? [renderInspectOptionsBanner(opts, "ProfileCohortView --options", { showOptions: true })]
        : []),
    ].join("\n")
  }
}

// ── 3. ProfileRadarView (5-Axis Behavioral Sharpness Embeddings Card) ────────

export class ProfileRadarView extends DeskView<ProfileInspectRecord> {
  constructor(
    rows: readonly ProfileInspectRecord[],
    private readonly meta: {
      readonly showOptions?: boolean | undefined
      readonly weblogEvidence?: ProfileWeblogEvidence | undefined
      readonly requestedAccount?: string | undefined
    } = {},
  ) {
    super(rows)
  }

  render(options: BunInspectOptions = {}): string {
    const opts = resolveInspectOptions(options)
    const colors = opts.colors
    const cardWidth = Math.min(112, opts.breakLength - 2)
    const innerWidth = cardWidth - 2
    const top = paint(`╔${"═".repeat(cardWidth)}╗`, ANSI.boldCyan, colors)
    const div = paint(`╠${"═".repeat(cardWidth)}╣`, ANSI.boldCyan, colors)
    const bot = paint(`╚${"═".repeat(cardWidth)}╝`, ANSI.boldCyan, colors)
    const frame = (content: string) =>
      paint("║ ", ANSI.boldCyan, colors) +
      padVisibleEnd(truncateVisible(content, innerWidth), innerWidth) +
      paint(" ║", ANSI.boldCyan, colors)

    const lines: string[] = [
      top,
      frame(paint("◆ PROFILE EVIDENCE RADAR", ANSI.boldWhite, colors)),
      frame("[ProfileRadarView[Bun.inspect.custom]]"),
    ]
    const web = this.meta.weblogEvidence
    if (web?.kind === "retained-mode-a") {
      lines.push(
        frame(`Mode A weblogs: ${web.filesRead} files · ${web.retainedRows} distinct rows`),
      )
      if (web.skippedFiles || web.invalidRows || web.duplicateRows) {
        lines.push(
          frame(
            `Skipped: ${web.skippedFiles} files · ${web.invalidRows} invalid · ${web.duplicateRows} duplicate`,
          ),
        )
      }
    }
    const money = (value: number | null) =>
      value === null
        ? "Unavailable"
        : `${value < 0 ? "−" : ""}$${formatInspectNumber(Math.abs(value), { ...opts, decimals: 2 })}`

    const list = opts.sorted ? [...this.rows].sort((a, b) => a.id.localeCompare(b.id)) : this.rows
    const maxItems = Math.min(opts.maxArrayLength, opts.depth <= 1 ? 3 : opts.depth >= 3 ? 10 : 6)

    if (list.length === 0) {
      lines.push(
        div,
        frame(
          this.meta.requestedAccount
            ? `No exact profile for ${this.meta.requestedAccount}`
            : "No profiles in this selection",
        ),
      )
    }
    for (const p of list.slice(0, maxItems)) {
      if (p.kind === "live-book") {
        const history = p.retainedHistory
        const login = p.name?.trim().toUpperCase() ?? ""
        const access = web?.kind === "retained-mode-a" ? web.byAccount.get(login) : undefined
        lines.push(div, frame(`${p.id} · Retained account evidence`))
        if (history) {
          lines.push(
            frame(`Wagers ${history.retainedWagers} retained · ${history.eligibleWagers} eligible`),
            frame(`Excluded ${history.excludedWagers} · Conflicts ${history.conflictingWagers}`),
            frame(`Eligible stake ${money(history.stakeUsd)}`),
            frame(`Reported wins/losses ${history.wins}/${history.losses}`),
            frame(`Reported net ${money(history.reportedNetUsd)}`),
            frame(
              `Provisional ROI ${history.provisionalRoiPct === null ? "Unavailable" : `${history.provisionalRoiPct.toFixed(1)}%`}`,
            ),
          )
          if (opts.depth >= 2 && !opts.compact) {
            lines.push(
              frame(`Mean stake ${money(history.meanStakeUsd)}`),
              frame(
                `Stake Gini ${history.stakeGini?.toFixed(3) ?? "Unavailable"} · ${history.sourceDays} source days`,
              ),
              frame(`First wager ${history.firstSourceTime ?? "Unavailable"}`),
              frame(`Last wager  ${history.lastSourceTime ?? "Unavailable"}`),
            )
          }
        } else {
          lines.push(frame("Retained wagers: Unavailable"))
        }
        if (access) {
          lines.push(
            frame(`Weblogs ${access.retainedRows} rows · ${access.sourceDays} source days`),
          )
          if (opts.depth >= 2 && !opts.compact) {
            lines.push(
              frame(`Observed addresses ${access.observedAddresses} (count only)`),
              frame(`First access ${access.firstSourceTime}`),
              frame(`Last access  ${access.lastSourceTime}`),
            )
          }
        } else {
          lines.push(
            frame(
              web?.kind === "retained-mode-a"
                ? web.ambiguousLogins?.has(login)
                  ? "Weblogs withheld: ambiguous roster login"
                  : "Weblogs: No retained rows for this actor"
                : "Weblogs: No readable retained capture",
            ),
          )
        }
        lines.push(
          frame("Times above are provider wall time"),
          frame("CLV / Sharpness / Kelly: Unavailable"),
        )
        continue
      }
      lines.push(div, frame("Modeled profile · illustrative model metrics"))
      const bk = computeBayesianKelly(p)
      const unknownSet = new Set(p.unknown ?? [])
      lines.push(div)
      lines.push(
        frame(
          `${paint(p.id, ANSI.boldCyan, colors)} (${paint(p.agentId, ANSI.boldWhite, colors)}) · ` +
            `${paint(`${shortTier(p.tier)} ${p.score.toFixed(1)}/10`, tierColor(p.tier), colors)} · ` +
            `${paint(`edge=${bk.impliedEdgePct >= 0 ? "+" : ""}${bk.impliedEdgePct.toFixed(1)}%`, bk.impliedEdgePct > 0 ? ANSI.boldRed : ANSI.green, colors)}`,
        ),
      )
      lines.push(
        frame(
          `${paint("Vec:", ANSI.gray, colors)} [${p.clvScore.toFixed(2)}, ${p.skillScore.toFixed(2)}, ${p.sizingScore.toFixed(2)}, ${p.sigScore.toFixed(2)}, ${p.timingScore.toFixed(2)}]  ` +
            `${paint("Gini:", ANSI.gray, colors)} ${unknownSet.has("gini") ? "—" : p.gini.toFixed(2)}  ` +
            `${paint("Synd:", ANSI.gray, colors)} ${unknownSet.has("syndicate") ? "—" : `${Math.round(p.syndicateProb * 100)}%`}`,
        ),
      )
      if (!opts.compact) {
        const w = 8
        lines.push(
          frame(
            `  CLV ${renderProgressBar(p.clvScore, 3.0, w, "red", colors)}  ` +
              `SKL ${renderProgressBar(p.skillScore, 2.5, w, "yellow", colors)}  ` +
              `SIZ ${renderProgressBar(p.sizingScore, 1.5, w, "cyan", colors)}`,
          ),
        )
        if (opts.depth >= 2) {
          lines.push(
            frame(
              `  SIG ${renderProgressBar(p.sigScore, 2.0, w, "yellow", colors)}  ` +
                `TIM ${renderProgressBar(p.timingScore, 1.0, w, "green", colors)}  ` +
                `${paint(`¼Kelly=${unknownSet.has("meanStake") ? "—" : formatInspectCurrency(bk.quarterKellyStakeUsd, { numericSeparator: opts.numericSeparator })}`, ANSI.white, colors)}`,
            ),
          )
        }
      }
      if (opts.showHidden) {
        lines.push(
          frame(
            paint(
              `  [hidden] src=${p.source ?? "cohort"} · tags=${(p.tags ?? []).join(",") || "none"}`,
              ANSI.gray,
              colors,
            ),
          ),
        )
      }
    }

    if (list.length > maxItems)
      lines.push(frame(`${list.length - maxItems} additional profiles omitted by inspect limit`))
    lines.push(bot)
    if (this.meta.showOptions) {
      lines.push(
        renderInspectOptionsBanner(opts, "ProfileRadarView --options", { showOptions: true }),
      )
    }
    return lines.join("\n")
  }
}

// ── 4. Unified Formatter Payload Builder (API + Terminal SSOT) ───────────────

export function formatProfileInspectPayload(params: {
  readonly profiles: readonly ProfileInspectRecord[]
  readonly selectedId?: string | null
  readonly totalCount?: number
  readonly sort?: ProfileInspectSortField
  readonly dir?: "asc" | "desc"
  readonly activeFilters?: readonly string[]
  readonly options?: BunInspectOptions
  readonly weblogEvidence?: ProfileWeblogEvidence | undefined
  readonly showOptions?: boolean
}): ProfileInspectPayload {
  const sort = params.sort ?? "score"
  const dir = params.dir ?? "desc"
  const resolved = resolveInspectOptions(params.options)
  const ordered = sortProfileRecords(params.profiles, sort, dir)

  const requested = params.selectedId?.trim().toUpperCase()
  const selected = requested
    ? (ordered.find((p) => p.id.toUpperCase() === requested) ?? null)
    : (ordered[0] ?? null)

  const profileView = selected
    ? new ProfileView(selected, { showOptions: params.showOptions })
    : null
  const cohortView = new ProfileCohortView(ordered, {
    totalCount: params.totalCount ?? ordered.length,
    sort,
    dir,
    activeFilters: params.activeFilters,
    showOptions: params.showOptions,
  })
  const radarView = new ProfileRadarView(requested ? (selected ? [selected] : []) : ordered, {
    showOptions: params.showOptions,
    weblogEvidence: params.weblogEvidence,
    requestedAccount: requested,
  })

  const tableRows = ordered.map((p) => ({
    id: p.id,
    tier: p.kind === "live-book" ? p.tier : shortTier(p.tier),
    score: p.score,
    agentId: p.agentId,
    gini: p.gini,
    var95Usd: p.var95Usd,
    holdPct: p.holdPct,
    limitUsd: p.recommendedLimitUsd,
    meanStake: p.meanStake,
    ipAddress: p.ipAddress,
  }))

  const cliFlags = formatInspectCliFlags(resolved, {
    showOptions: params.showOptions,
  })
  const flagSuffix = cliFlags ? ` ${cliFlags}` : ""
  const selectedToken = selected ? selected.id : "<CUSTOMER_ID>"

  const columns = [
    "id",
    "tier",
    "score",
    "agentId",
    "gini",
    "var95Usd",
    "holdPct",
    "limitUsd",
    ...(ordered.some((row) => row.kind === "live-book") ? ["meanStake"] : []),
    ...(resolved.showHidden ? ["ipAddress"] : []),
  ]
  const tableHeader = paint(
    `◆ Bun.inspect.table(profiles, ${JSON.stringify(columns)}, ${formatInspectOptionsObject(resolved)})`,
    ANSI.boldCyan,
    resolved.colors,
  )
  const tableBody = inspectTable(tableRows, columns, resolved)
  const tableAnsi = [
    tableHeader,
    tableBody,
    ...(params.showOptions
      ? [
          renderInspectOptionsBanner(resolved, "Bun.inspect.table --options", {
            showOptions: true,
          }),
        ]
      : []),
  ].join("\n")

  return {
    selectedId: selected?.id ?? null,
    totalCount: params.totalCount ?? ordered.length,
    displayedCount: ordered.length,
    summary: summarizeProfiles(ordered),
    profileAnsi: profileView
      ? inspectDeskValue(profileView, resolved)
      : paint("◆ No customer profile selected.", ANSI.gray, resolved.colors),
    cohortAnsi: inspectDeskValue(cohortView, resolved),
    radarAnsi: inspectDeskValue(radarView, resolved),
    tableAnsi,
    optionsBannerAnsi: renderInspectOptionsBanner(resolved, "Profiles Bun.inspect.options", {
      showOptions: params.showOptions,
    }),
    resolvedOptions: resolved,
    optionsJsLiteral: formatInspectOptionsObject(resolved),
    cliFlags,
    profileCliCommand: `profile ${selectedToken}${flagSuffix}`,
    cohortCliCommand: `profiles --sort=${sort}${dir === "asc" ? " --asc" : ""}${flagSuffix}`,
    radarCliCommand: `profile ${selectedToken} --radar${flagSuffix}`,
    generatedAt: new Date().toISOString(),
  }
}
