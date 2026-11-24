import { describe, expect, test } from "bun:test"

import {
  computeProfileRiskHeadroom,
  summarizeCustomerLiveActivity,
} from "../../packages/ui/src/customer_drilldown_summary.ts"
import {
  clampRiskExposureLimitUsd,
  DEFAULT_RISK_EXPOSURE_LIMIT_USD,
  DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD,
  evaluateRiskExposureThreshold,
  MIN_RISK_EXPOSURE_LIMIT_USD,
  parseRiskExposureLimitInput,
  parseRiskThresholdPairInput,
  readStoredRiskExposureLimitUsd,
  readStoredRiskExposureThresholds,
  RISK_EXPOSURE_LIMIT_STORAGE_KEY,
  RISK_EXPOSURE_WARNING_LIMIT_STORAGE_KEY,
  writeStoredRiskExposureLimitUsd,
  writeStoredRiskExposureThresholds,
} from "../../packages/ui/src/risk_threshold_alert.ts"
import type { LiveWager, ShowcaseCustomer } from "../../packages/ui/src/types.ts"

function makeWager(overrides: Partial<LiveWager>): LiveWager {
  return {
    ticketId: "TKT-100",
    customerId: "CUST-1",
    agentId: "AGT-1",
    masterAgent: "MA-1",
    sport: "NBA",
    event: "LAL @ BOS",
    selection: "BOS -4.5",
    lineDisplay: "-4.5",
    oddsAmerican: "-110",
    betType: "STRAIGHT",
    writer: "web",
    riskUsd: 1000,
    toWinUsd: 909,
    clvCents: null,
    alertTier: "STANDARD",
    alertBadge: "STD",
    operatorDirective: "MONITOR",
    maxRecommendedStake: 2500,
    autoExecute: false,
    timestamp: "2026-11-21T20:00:00.000Z",
    ...overrides,
  }
}

function makeCustomer(overrides: Partial<ShowcaseCustomer>): ShowcaseCustomer {
  return {
    id: "CUST-1",
    name: "Test Bettor",
    agentId: "AGT-1",
    masterAgent: "MA-1",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 8.6,
    clvScore: 2.8,
    sharpnessScore: 2.2,
    sizingScore: 1.3,
    sigScore: 1.6,
    timingScore: 0.7,
    sizingStrategy: "KELLY",
    gini: 0.24,
    meanStake: 1850,
    var95Usd: 14500,
    cvar95Usd: 18200,
    holdPct: -4.2,
    ltvUsd: -12400,
    correlatedRisk: "HIGH",
    correlatedExploitRate: 0.42,
    timingArchetype: "STEAM_CHASER",
    syndicateProb: 0.78,
    syndicateRisk: "HIGH",
    action: "LIMIT_AND_SHADE",
    recommendedLimitUsd: 10000,
    inPlayDelaySec: 8,
    lineShadeCents: 15,
    shadowCopyMultiplier: 1.5,
    ipAddress: "198.51.100.12",
    ...overrides,
  } as ShowcaseCustomer
}

describe("60-minute aggregate risk threshold evaluation", () => {
  test("returns idle when no live data is present", () => {
    const res = evaluateRiskExposureThreshold(0, 25_000, { hasData: false })
    expect(res.status).toBe("idle")
    expect(res.isBreached).toBe(false)
    expect(res.isWarning).toBe(false)
    expect(res.remainingUsd).toBe(25_000)
  })

  test("returns ok below warning threshold, warn at 80%..100%, and breach strictly above limit", () => {
    const ok = evaluateRiskExposureThreshold(12_500, 25_000)
    expect(ok.status).toBe("ok")
    expect(ok.utilizationPct).toBeCloseTo(50, 4)
    expect(ok.remainingUsd).toBe(12_500)
    expect(ok.excessUsd).toBe(0)

    const warnAt80 = evaluateRiskExposureThreshold(20_000, 25_000)
    expect(warnAt80.status).toBe("warn")
    expect(warnAt80.isWarning).toBe(true)
    expect(warnAt80.isBreached).toBe(false)

    const warnAtExactLimit = evaluateRiskExposureThreshold(25_000, 25_000)
    expect(warnAtExactLimit.status).toBe("warn")
    expect(warnAtExactLimit.isBreached).toBe(false)
    expect(warnAtExactLimit.remainingUsd).toBe(0)

    const breached = evaluateRiskExposureThreshold(31_250, 25_000)
    expect(breached.status).toBe("breach")
    expect(breached.isBreached).toBe(true)
    expect(breached.isWarning).toBe(false)
    expect(breached.utilizationPct).toBeCloseTo(125, 4)
    expect(breached.excessUsd).toBe(6_250)
    expect(breached.remainingUsd).toBe(0)
  })

  test("parses operator USD inputs with commas, currency symbols, and k/m suffixes", () => {
    expect(parseRiskExposureLimitInput("$35,000")).toBe(35_000)
    expect(parseRiskExposureLimitInput("40k")).toBe(40_000)
    expect(parseRiskExposureLimitInput("1.25M")).toBe(1_250_000)
    expect(parseRiskExposureLimitInput("100")).toBe(MIN_RISK_EXPOSURE_LIMIT_USD)
    expect(parseRiskExposureLimitInput("")).toBeNull()
    expect(parseRiskExposureLimitInput("-5000")).toBeNull()
    expect(parseRiskExposureLimitInput("abc")).toBeNull()
    expect(clampRiskExposureLimitUsd(Number.NaN)).toBe(DEFAULT_RISK_EXPOSURE_LIMIT_USD)
  })

  test("reads and writes persisted thresholds safely via storage abstraction", () => {
    const backing = new Map<string, string>()
    const fakeStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        backing.set(k, v)
      },
    }

    expect(readStoredRiskExposureLimitUsd(fakeStorage)).toBe(DEFAULT_RISK_EXPOSURE_LIMIT_USD)
    const written = writeStoredRiskExposureLimitUsd(75_000, fakeStorage)
    expect(written).toBe(75_000)
    expect(backing.get(RISK_EXPOSURE_LIMIT_STORAGE_KEY)).toBe("75000")
    expect(readStoredRiskExposureLimitUsd(fakeStorage)).toBe(75_000)
  })

  test("validates custom warning and breach USD threshold pairs for modal submission", () => {
    const valid = parseRiskThresholdPairInput("$32,500", "50k")
    expect(valid.ok).toBe(true)
    if (valid.ok) {
      expect(valid.value.warningLimitUsd).toBe(32_500)
      expect(valid.value.breachLimitUsd).toBe(50_000)
    }

    const warnAboveBreach = parseRiskThresholdPairInput("60k", "50k")
    expect(warnAboveBreach.ok).toBe(false)
    if (!warnAboveBreach.ok) {
      expect(warnAboveBreach.field).toBe("warning")
    }

    const warnEqualBreach = parseRiskThresholdPairInput("25000", "25000")
    expect(warnEqualBreach.ok).toBe(false)
    if (!warnEqualBreach.ok) {
      expect(warnEqualBreach.field).toBe("warning")
    }

    const breachTooLow = parseRiskThresholdPairInput("250", "400")
    expect(breachTooLow.ok).toBe(false)
    if (!breachTooLow.ok) {
      expect(breachTooLow.field).toBe("breach")
    }

    const malformed = parseRiskThresholdPairInput("20k", "invalid")
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) {
      expect(malformed.field).toBe("breach")
    }
  })

  test("persists custom warning and breach USD thresholds to localStorage and supports legacy single-key fallback", () => {
    const backing = new Map<string, string>()
    const fakeStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => {
        backing.set(k, v)
      },
    }

    expect(readStoredRiskExposureThresholds(fakeStorage)).toEqual({
      breachLimitUsd: DEFAULT_RISK_EXPOSURE_LIMIT_USD,
      warningLimitUsd: DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD,
    })

    // Legacy single-key fallback derives 80% warning limit automatically
    backing.set(RISK_EXPOSURE_LIMIT_STORAGE_KEY, "100000")
    expect(readStoredRiskExposureThresholds(fakeStorage)).toEqual({
      breachLimitUsd: 100_000,
      warningLimitUsd: 80_000,
    })

    // Writing custom pair persists both keys cleanly
    const saved = writeStoredRiskExposureThresholds({ breachLimitUsd: 120_000, warningLimitUsd: 85_000 }, fakeStorage)
    expect(saved).toEqual({ breachLimitUsd: 120_000, warningLimitUsd: 85_000 })
    expect(backing.get(RISK_EXPOSURE_LIMIT_STORAGE_KEY)).toBe("120000")
    expect(backing.get(RISK_EXPOSURE_WARNING_LIMIT_STORAGE_KEY)).toBe("85000")
    expect(readStoredRiskExposureThresholds(fakeStorage)).toEqual({
      breachLimitUsd: 120_000,
      warningLimitUsd: 85_000,
    })
  })

  test("evaluates custom warningLimitUsd independently from the default 80% ratio", () => {
    const belowWarn = evaluateRiskExposureThreshold(29_000, 50_000, { warningLimitUsd: 30_000 })
    expect(belowWarn.status).toBe("ok")
    expect(belowWarn.warningLimitUsd).toBe(30_000)

    const atCustomWarn = evaluateRiskExposureThreshold(30_000, 50_000, { warningLimitUsd: 30_000 })
    expect(atCustomWarn.status).toBe("warn")
    expect(atCustomWarn.isWarning).toBe(true)
    expect(atCustomWarn.isBreached).toBe(false)

    const breached = evaluateRiskExposureThreshold(50_001, 50_000, { warningLimitUsd: 30_000 })
    expect(breached.status).toBe("breach")
    expect(breached.isBreached).toBe(true)
    expect(breached.excessUsd).toBe(1)
  })
})

describe("Customer profile drilldown summaries", () => {
  test("aggregates per-customer live wagers, excludes sentinels, and computes sport/CLV metrics", () => {
    const wagers: LiveWager[] = [
      makeWager({
        ticketId: "T-1",
        customerId: "brt106",
        sport: "NBA",
        riskUsd: 2_000,
        toWinUsd: 1_800,
        alertTier: "CRITICAL",
        writer: "gslive",
        clvCents: 6.5,
        timestamp: "2026-11-21T20:10:00.000Z",
      }),
      makeWager({
        ticketId: "T-2",
        customerId: "BRT106",
        sport: "NFL",
        riskUsd: 1_000,
        toWinUsd: 950,
        alertTier: "STANDARD",
        writer: "web",
        clvCents: 2.5,
        timestamp: "2026-11-21T20:15:00.000Z",
      }),
      makeWager({
        ticketId: "T-OTHER",
        customerId: "OTHER1",
        sport: "MLB",
        riskUsd: 5_000,
      }),
      makeWager({
        ticketId: "T-SENTINEL",
        customerId: "BRT106",
        writer: "alert",
        riskUsd: 9_999,
      }),
    ]

    const summary = summarizeCustomerLiveActivity("BRT106", wagers)
    expect(summary.ticketCount).toBe(2)
    expect(summary.totalRiskUsd).toBe(3_000)
    expect(summary.totalToWinUsd).toBe(2_750)
    expect(summary.criticalCount).toBe(1)
    expect(summary.liveInPlayCount).toBe(1)
    expect(summary.maxSingleStakeUsd).toBe(2_000)
    expect(summary.avgClvCents).toBeCloseTo(4.5, 4)
    expect(summary.tickets[0]?.ticketId).toBe("T-2")
    expect(summary.sportBreakdown[0]?.sport).toBe("NBA")
    expect(summary.sportBreakdown[0]?.sharePct).toBeCloseTo(66.6667, 2)
  })

  test("computes VaR-to-cap headroom and respects unknown fields", () => {
    const overCap = computeProfileRiskHeadroom(makeCustomer({ var95Usd: 14500, recommendedLimitUsd: 10000 }))
    expect(overCap.varToCapPct).toBe(145)
    expect(overCap.isVarOverCap).toBe(true)

    const unmeasured = computeProfileRiskHeadroom(makeCustomer({ unknown: ["var95", "limit", "holdPct", "ltv"] }))
    expect(unmeasured.varToCapPct).toBeNull()
    expect(unmeasured.isVarOverCap).toBe(false)
    expect(unmeasured.hasMeasuredVar).toBe(false)
    expect(unmeasured.hasMeasuredHold).toBe(false)
  })
})
