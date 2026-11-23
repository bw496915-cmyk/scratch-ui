import { describe, expect, test } from "bun:test"

import type { NormalizedRankingsResult } from "../../packages/ui/src/hydration.ts"
import {
  buildRankingsPlayerLookup,
  computeDeskExposureModel,
  computeProfileBayesianSkill,
  computeStakeDistribution,
  evaluateProfileQuantitativeModel,
  evaluateSharpnessHeatmapOverlay,
  reconcileSharpnessAxes,
  simulateCountermeasureImpact,
  summarizeSharpnessHeatmap,
} from "../../packages/ui/src/profile_formulas.ts"
import { classifyCustomerProfileType } from "../../packages/ui/src/profile_taxonomy.ts"
import {
  PROFILE_TYPE_IDS,
  type RankedPlayer30d,
  type ShowcaseCustomer,
} from "../../packages/ui/src/types.ts"

function makeCustomer(overrides: Partial<ShowcaseCustomer> = {}): ShowcaseCustomer {
  const axes = reconcileSharpnessAxes(7.8, {
    clvBps: 145,
    holdPct: -4.2,
    gini: 0.24,
  })
  return {
    id: "BGD101",
    agentId: "BIGDAD",
    subAccountIndex: 1,
    score: axes.totalScore,
    tier: "TIER_1_SHARP_ORIGINATOR",
    clvScore: axes.clvScore,
    skillScore: axes.skillScore,
    sizingScore: axes.sizingScore,
    sigScore: axes.sigScore,
    timingScore: axes.timingScore,
    sizingStrategy: "FIXED_QUARTER_KELLY",
    gini: 0.24,
    meanStake: 1800,
    specialization: "NBA Props",
    correlatedRisk: "LOW",
    correlatedExploitRate: 0.08,
    timingArchetype: "OPENING_STEAM",
    var95Usd: 12400,
    cvar95Usd: 16200,
    recommendedLimitUsd: 1500,
    inPlayDelaySec: 4,
    lineShadeCents: 3,
    shadowCopyMultiplier: 1.25,
    action: "SHADE_AND_SHADOW",
    holdPct: -4.2,
    ltvUsd: -14500,
    syndicateProb: 0.22,
    syndicateRisk: "LOW",
    ...overrides,
  }
}

function makeRankedPlayer(overrides: Partial<RankedPlayer30d> = {}): RankedPlayer30d {
  return {
    rank: 1,
    id: "BGD101",
    agentId: "BIGDAD",
    masterAgent: "MASTER1",
    handleUsd: 245000,
    wagers: 142,
    gini: 0.24,
    alertRate: 38.5,
    score: 9.1,
    tier: "TIER_1_SHARP_ORIGINATOR",
    tierLabel: "T1 Originator",
    dominantSport: "NBA",
    isProxy: false,
    limitUsd: 2000,
    netUsd: -14500,
    clvBps: 185,
    ...overrides,
  }
}

function makeRankings(players: readonly RankedPlayer30d[]): NormalizedRankingsResult {
  return {
    summary: {
      generatedAtIso: "2026-11-22T18:00:00.000Z",
      windowStart: "2026-10-23",
      windowEnd: "2026-11-22",
      inWindowWagers: 1200,
      totalHandleUsd: 1450000,
      totalToWinUsd: 1320000,
      activeCustomerCount: players.length,
      activeSubAgentCount: 4,
      activeMasterAgentCount: 2,
      conduitSubAgentCount: 1,
    },
    players,
    conduits: [],
    subAgents: [],
    masterAgents: [],
    rejectedRows: 0,
  }
}

describe("Profiled Bettors quantitative formulas & archetypes", () => {
  test("reconcileSharpnessAxes conserves total score within 0.00 drift across edge scores", () => {
    for (const target of [0, 1.23, 5.55, 7.89, 9.14, 10, 14.5, -2]) {
      const reconciled = reconcileSharpnessAxes(target, {
        clvBps: 295,
        holdPct: -12,
        gini: 0.15,
        correlatedRisk: "CRITICAL",
        probitRho: 0.78,
      })
      const sum = Number(
        (
          reconciled.clvScore +
          reconciled.skillScore +
          reconciled.sizingScore +
          reconciled.sigScore +
          reconciled.timingScore
        ).toFixed(2),
      )
      expect(sum).toBe(reconciled.totalScore)
      expect(reconciled.conservationDelta).toBe(0)
      expect(reconciled.clvScore).toBeLessThanOrEqual(3.0)
      expect(reconciled.skillScore).toBeLessThanOrEqual(2.5)
      expect(reconciled.sizingScore).toBeLessThanOrEqual(1.5)
      expect(reconciled.sigScore).toBeLessThanOrEqual(2.0)
      expect(reconciled.timingScore).toBeLessThanOrEqual(1.0)
    }
  })

  test("PROFILE_TYPE_IDS includes all 9 archetypes and classifies CORRELATED_PARLAY_EXPLOITER & BONUS_ARB_SCALPER", () => {
    expect(PROFILE_TYPE_IDS).toContain("CORRELATED_PARLAY_EXPLOITER")
    expect(PROFILE_TYPE_IDS).toContain("BONUS_ARB_SCALPER")
    expect(PROFILE_TYPE_IDS.length).toBe(9)

    const parlayCustomer = makeCustomer({
      id: "SGP777",
      score: 7.4,
      tier: "TIER_3_MONITOR",
      correlatedRisk: "CRITICAL",
      correlatedExploitRate: 0.62,
      syndicateProb: 0.25,
      syndicateRisk: "LOW",
    })
    expect(classifyCustomerProfileType(parlayCustomer).id).toBe("CORRELATED_PARLAY_EXPLOITER")

    const arbCustomer = makeCustomer({
      id: "ARB404",
      score: 6.2,
      tier: "TIER_3_MONITOR",
      correlatedRisk: "LOW",
      correlatedExploitRate: 0.05,
      syndicateProb: 0.2,
      syndicateRisk: "LOW",
      timingArchetype: "STEAM_LATENCY_ARB",
    })
    expect(classifyCustomerProfileType(arbCustomer).id).toBe("BONUS_ARB_SCALPER")
  })

  test("computeStakeDistribution, Bayesian skill, exposure policy gap, and simulator stay finite and sign-consistent", () => {
    const dist = computeStakeDistribution([500, 500, 1000, 2000, 4000])
    expect(dist.count).toBe(5)
    expect(dist.meanUsd).toBe(1600)
    expect(dist.gini).toBeGreaterThan(0.3)
    expect(dist.cvar95Usd).toBeGreaterThanOrEqual(dist.var95Usd)

    const sharpAxes = reconcileSharpnessAxes(9.1, {
      clvBps: 210,
      holdPct: -8.5,
      gini: 0.24,
    })
    const sharpCust = makeCustomer({
      score: sharpAxes.totalScore,
      clvScore: sharpAxes.clvScore,
      skillScore: sharpAxes.skillScore,
      sizingScore: sharpAxes.sizingScore,
      sigScore: sharpAxes.sigScore,
      timingScore: sharpAxes.timingScore,
      holdPct: -8.5,
      ltvUsd: -42000,
      recommendedLimitUsd: 5000,
      inPlayDelaySec: 0,
      lineShadeCents: 0,
      var95Usd: 19500,
      cvar95Usd: 27000,
    })
    const bayes = computeProfileBayesianSkill(sharpCust)
    expect(bayes).not.toBeNull()
    expect(bayes!.posteriorWinRate).toBeGreaterThan(0.5238)
    expect(bayes!.ciLow95).toBeLessThan(bayes!.posteriorWinRate)
    expect(bayes!.ciHigh95).toBeGreaterThan(bayes!.posteriorWinRate)

    const exposure = computeDeskExposureModel(sharpCust)
    expect(exposure.isVarOverCap).toBe(true)
    expect(exposure.policyGapCount).toBeGreaterThan(0)

    const sim = simulateCountermeasureImpact(sharpCust, bayes, exposure, {
      limitCapUsd: 1000,
      inPlayDelaySec: 6,
      lineShadeCents: 4,
      probitBlockEnabled: true,
    })
    expect(sim.projected30dSavingsUsd).toBeGreaterThan(0)
    expect(sim.projectedEdgePct).toBeLessThanOrEqual(sim.baselineEdgePct)

    const model = evaluateProfileQuantitativeModel(sharpCust, [sharpCust])
    expect(model.isConserved).toBe(true)
    expect(model.riskDrivers.length).toBeGreaterThan(0)
  })
})

describe("Sharpness Heatmap rankings overlay evaluator", () => {
  test("correlates ShowcaseCustomer rows against NormalizedRankingsResult players to mark CLV leaders", () => {
    const clvLeaderCust = makeCustomer({ id: "bgd101", clvScore: 2.5, score: 9.1 })
    const midSharpCust = makeCustomer({
      id: "MID202",
      score: 7.3,
      clvScore: 1.4,
      holdPct: 1.2,
      ltvUsd: 1800,
      action: "MONITOR",
    })
    const recCust = makeCustomer({
      id: "REC900",
      score: 3.1,
      tier: "TIER_5_RECREATIONAL",
      clvScore: 0.4,
      holdPct: 7.5,
      ltvUsd: 6200,
      action: "ACCEPT_LIMIT_FULL",
    })
    const unmeasuredBook = makeCustomer({
      id: "BK999",
      source: "book",
      score: 0,
      clvScore: 0,
      unknown: ["sharpness", "clv", "holdPct", "var95", "limit"],
    })

    const rankings = makeRankings([
      makeRankedPlayer({ id: "BGD101", rank: 1, clvBps: 215, score: 9.2, alertRate: 44 }),
      makeRankedPlayer({
        id: "MID202",
        rank: 6,
        clvBps: 95,
        score: 7.4,
        tier: "TIER_2_SEMI_SHARP",
        tierLabel: "T2 Semi-Sharp",
        alertRate: 28,
        netUsd: -2200,
      }),
      makeRankedPlayer({
        id: "REC900",
        rank: 42,
        clvBps: -35,
        score: 3.2,
        tier: "TIER_5_RECREATIONAL",
        tierLabel: "T5 Recreational",
        alertRate: 4,
        netUsd: 6200,
      }),
    ])

    const lookup = buildRankingsPlayerLookup(rankings)
    expect(lookup.size).toBe(3)

    const bgdOverlay = evaluateSharpnessHeatmapOverlay(clvLeaderCust, lookup)
    expect(bgdOverlay.isSharp).toBe(true)
    expect(bgdOverlay.isClvLeader).toBe(true)
    expect(bgdOverlay.heatLevel).toBe(5)
    expect(bgdOverlay.rankLabel).toBe("#1 30d")
    expect(bgdOverlay.clvSignalLabel).toBe("+215 bps CLV")

    const midOverlay = evaluateSharpnessHeatmapOverlay(midSharpCust, lookup)
    expect(midOverlay.isSharp).toBe(true)
    expect(midOverlay.isClvLeader).toBe(true)
    expect(midOverlay.heatLevel).toBeGreaterThanOrEqual(2)
    expect(midOverlay.rankLabel).toBe("#6 30d")

    const recOverlay = evaluateSharpnessHeatmapOverlay(recCust, lookup)
    expect(recOverlay.isSharp).toBe(false)
    expect(recOverlay.isClvLeader).toBe(false)
    expect(recOverlay.heatLevel).toBe(0)

    const bookOverlay = evaluateSharpnessHeatmapOverlay(unmeasuredBook, lookup)
    expect(bookOverlay.isSharp).toBe(false)
    expect(bookOverlay.isClvLeader).toBe(false)

    const { summary } = summarizeSharpnessHeatmap(
      [clvLeaderCust, midSharpCust, recCust, unmeasuredBook],
      rankings,
    )
    expect(summary.rankedTotal).toBe(3)
    expect(summary.matchedCount).toBe(3)
    expect(summary.sharpCount).toBe(2)
    expect(summary.clvLeaderCount).toBe(2)
  })

  test("degrades gracefully when rankings state is null or empty", () => {
    const clvCust = makeCustomer({ id: "BGD101", clvScore: 2.4, score: 8.6 })
    const lowCust = makeCustomer({
      id: "REC1",
      clvScore: 0.5,
      score: 3.5,
      action: "ACCEPT_LIMIT_FULL",
    })

    const { overlaysById, summary } = summarizeSharpnessHeatmap([clvCust, lowCust], null)
    expect(summary.rankedTotal).toBe(0)
    expect(summary.matchedCount).toBe(0)
    expect(summary.sharpCount).toBe(1)
    expect(summary.clvLeaderCount).toBe(1)
    expect(overlaysById.get("BGD101")?.isSharp).toBe(true)
    expect(overlaysById.get("REC1")?.isSharp).toBe(false)
  })
})
