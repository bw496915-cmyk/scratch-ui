import { describe, expect, test } from "bun:test"

import {
  buildRecentAlertFrequencyBuckets,
  buildRecentRiskAlerts,
  estimateToWinFromAmericanOdds,
  filterRecentRiskAlerts,
  formatAlertWagerBrief,
  formatRelativeAlertAge,
  resolveAlertWagerContext,
} from "../../packages/ui/src/risk_recent_alerts.ts"
import type { DashboardAlertRecord, LiveWager } from "../../packages/ui/src/types.ts"

const ANCHOR_MS = Date.parse("2026-11-21T20:00:00.000Z")

function makeWager(overrides: Partial<LiveWager>): LiveWager {
  return {
    ticketId: "TKT-100",
    customerId: "BRT106",
    agentId: "AF420",
    masterAgent: "BILLY666",
    sport: "NBA",
    event: "LAL @ BOS",
    selection: "BOS -4.5",
    lineDisplay: "-4.5",
    oddsAmerican: "-110",
    betType: "STRAIGHT",
    writer: "web",
    riskUsd: 2_000,
    toWinUsd: 1_818,
    clvCents: null,
    alertTier: "STANDARD",
    alertBadge: "STD",
    operatorDirective: "MONITOR",
    maxRecommendedStake: 25_000,
    autoExecute: false,
    timestamp: new Date(ANCHOR_MS - 10 * 60_000).toISOString(),
    ...overrides,
  }
}

describe("60-minute Recent Alerts sidebar history builder", () => {
  test("detects chronological warning and breach threshold crossings linked to triggering wagers", () => {
    const w1 = makeWager({
      ticketId: "TKT-01",
      riskUsd: 12_000,
      timestamp: new Date(ANCHOR_MS - 35 * 60_000).toISOString(),
    })
    const w2 = makeWager({
      ticketId: "TKT-02",
      riskUsd: 9_000, // cumulative 21,000 >= 20,000 warning
      timestamp: new Date(ANCHOR_MS - 20 * 60_000).toISOString(),
    })
    const w3 = makeWager({
      ticketId: "TKT-03",
      riskUsd: 6_500, // cumulative 27,500 > 25,000 breach
      timestamp: new Date(ANCHOR_MS - 5 * 60_000).toISOString(),
    })

    const res = buildRecentRiskAlerts({
      wagers: [w3, w1, w2], // deliberately unsorted input
      breachLimitUsd: 25_000,
      warningLimitUsd: 20_000,
      anchorMs: ANCHOR_MS,
    })

    expect(res.windowMode).toBe("live")
    expect(res.breachCount).toBe(1)
    expect(res.warnCount).toBe(1)
    expect(res.items.length).toBe(2)

    // Newest-first ordering: Breach (5m ago) appears before Warning (20m ago)
    expect(res.items[0]?.kind).toBe("THRESHOLD_BREACH")
    expect(res.items[0]?.severity).toBe("BREACH")
    expect(res.items[0]?.ticketId).toBe("TKT-03")
    expect(res.items[0]?.linkedWager?.ticketId).toBe("TKT-03")
    expect(res.items[0]?.cumulativeRiskUsd).toBe(27_500)
    expect(res.items[0]?.relativeAgeLabel).toBe("5m ago")

    expect(res.items[1]?.kind).toBe("THRESHOLD_WARNING")
    expect(res.items[1]?.severity).toBe("WARN")
    expect(res.items[1]?.ticketId).toBe("TKT-02")
    expect(res.items[1]?.linkedWager?.ticketId).toBe("TKT-02")
    expect(res.items[1]?.cumulativeRiskUsd).toBe(21_000)
  })

  test("excludes wagers older than 60 minutes and sentinel tickets while capturing over-cap & steam alerts", () => {
    const expired = makeWager({
      ticketId: "TKT-OLD",
      riskUsd: 40_000,
      alertTier: "CRITICAL",
      timestamp: new Date(ANCHOR_MS - 75 * 60_000).toISOString(),
    })
    const sentinel = makeWager({
      ticketId: "TKT-SENTINEL",
      writer: "alert",
      riskUsd: 50_000,
      alertTier: "CRITICAL",
      timestamp: new Date(ANCHOR_MS - 3 * 60_000).toISOString(),
    })
    const overCap = makeWager({
      ticketId: "TKT-CAP",
      riskUsd: 4_500,
      maxRecommendedStake: 2_000,
      timestamp: new Date(ANCHOR_MS - 12 * 60_000).toISOString(),
    })
    const steam = makeWager({
      ticketId: "TKT-STEAM",
      riskUsd: 1_500,
      maxRecommendedStake: 5_000,
      alertTier: "STEAM",
      clvCents: 4.5,
      timestamp: new Date(ANCHOR_MS - 2 * 60_000).toISOString(),
    })

    const res = buildRecentRiskAlerts({
      wagers: [expired, sentinel, overCap, steam],
      breachLimitUsd: 50_000,
      warningLimitUsd: 40_000,
      anchorMs: ANCHOR_MS,
    })

    expect(res.items.map((i) => i.ticketId)).toEqual(["TKT-STEAM", "TKT-CAP"])
    expect(res.items[0]?.kind).toBe("SHARP_STEAM_ALERT")
    expect(res.items[0]?.severity).toBe("WARN")
    expect(res.items[0]?.linkedWager?.ticketId).toBe("TKT-STEAM")

    expect(res.items[1]?.kind).toBe("SINGLE_WAGER_BREACH")
    expect(res.items[1]?.severity).toBe("BREACH")
    expect(res.items[1]?.linkedWager?.ticketId).toBe("TKT-CAP")
  })

  test("merges recent DashboardAlertRecord entries without duplicating represented tickets", () => {
    const liveTicket = makeWager({
      ticketId: "TKT-LIVE-1",
      riskUsd: 3_000,
      alertTier: "CRITICAL",
      timestamp: new Date(ANCHOR_MS - 8 * 60_000).toISOString(),
    })

    const alertRecords: DashboardAlertRecord[] = [
      {
        deliveryId: "del-dup",
        wagerId: "TKT-LIVE-1",
        tier: "CRITICAL",
        status: "delivered",
        payload: { customerId: "BRT106", sport: "NBA", amountUsd: 3_000 },
        createdAt: new Date(ANCHOR_MS - 8 * 60_000).toISOString(),
        updatedAt: new Date(ANCHOR_MS - 8 * 60_000).toISOString(),
      },
      {
        deliveryId: "del-hist",
        wagerId: "TKT-OFF-TAPE",
        tier: "STEAM",
        status: "queued",
        payload: {
          customerId: "MJ102",
          sport: "NFL",
          selection: "KC -3",
          oddsAmerican: "-108",
          amountUsd: 5_500,
          directive: "SHADE_LINE",
        },
        createdAt: new Date(ANCHOR_MS - 4 * 60_000).toISOString(),
        updatedAt: new Date(ANCHOR_MS - 4 * 60_000).toISOString(),
      },
    ]

    const res = buildRecentRiskAlerts({
      wagers: [liveTicket],
      alertRecords,
      breachLimitUsd: 50_000,
      warningLimitUsd: 40_000,
      anchorMs: ANCHOR_MS,
    })

    expect(res.items.length).toBe(2)
    expect(res.items[0]?.ticketId).toBe("TKT-OFF-TAPE")
    expect(res.items[0]?.kind).toBe("DELIVERY_ALERT")
    expect(res.items[0]?.linkedWager).toBeNull()
    expect(res.items[1]?.ticketId).toBe("TKT-LIVE-1")
    expect(res.items[1]?.linkedWager?.ticketId).toBe("TKT-LIVE-1")
  })

  test("formats relative alert ages cleanly", () => {
    expect(formatRelativeAlertAge(ANCHOR_MS - 5_000, ANCHOR_MS)).toBe("Just now")
    expect(formatRelativeAlertAge(ANCHOR_MS - 42_000, ANCHOR_MS)).toBe("42s ago")
    expect(formatRelativeAlertAge(ANCHOR_MS - 18 * 60_000, ANCHOR_MS)).toBe("18m ago")
  })

  test("builds 12 five-minute D3 frequency buckets with severity counts, peak detection, and escalating trend", () => {
    const wagers: LiveWager[] = [
      // Early calm warning at -45m
      makeWager({
        ticketId: "T-EARLY",
        riskUsd: 4_000,
        alertTier: "STEAM",
        timestamp: new Date(ANCHOR_MS - 45 * 60_000).toISOString(),
      }),
      // Burst of breaches in final 5 minutes
      makeWager({
        ticketId: "T-BURST-1",
        riskUsd: 18_000,
        alertTier: "CRITICAL",
        timestamp: new Date(ANCHOR_MS - 4 * 60_000).toISOString(),
      }),
      makeWager({
        ticketId: "T-BURST-2",
        riskUsd: 12_000,
        alertTier: "CRITICAL",
        timestamp: new Date(ANCHOR_MS - 2 * 60_000).toISOString(),
      }),
      makeWager({
        ticketId: "T-BURST-3",
        riskUsd: 8_000,
        alertTier: "CRITICAL",
        timestamp: new Date(ANCHOR_MS - 1 * 60_000).toISOString(),
      }),
    ]

    const feed = buildRecentRiskAlerts({
      wagers,
      breachLimitUsd: 25_000,
      warningLimitUsd: 20_000,
      anchorMs: ANCHOR_MS,
    })

    const freq = buildRecentAlertFrequencyBuckets(feed, 12)
    expect(freq.buckets.length).toBe(12)

    const sumBreaches = freq.buckets.reduce((s, b) => s + b.breachCount, 0)
    const sumWarns = freq.buckets.reduce((s, b) => s + b.warnCount, 0)
    expect(sumBreaches).toBe(feed.breachCount)
    expect(sumWarns).toBe(feed.warnCount)
    expect(freq.peakBucketIndex).toBe(11)
    expect(freq.peakBucketTotal).toBeGreaterThanOrEqual(3)
    expect(freq.buckets[11]?.isBurst).toBe(true)
    expect(freq.trend).toBe("escalating")

    // Empty feed yields quiet trend and null peak
    const emptyFeed = buildRecentRiskAlerts({
      wagers: [],
      breachLimitUsd: 25_000,
      warningLimitUsd: 20_000,
      anchorMs: ANCHOR_MS,
    })
    const emptyFreq = buildRecentAlertFrequencyBuckets(emptyFeed, 12)
    expect(emptyFreq.trend).toBe("quiet")
    expect(emptyFreq.peakBucketIndex).toBeNull()
    expect(emptyFreq.maxBucketTotal).toBe(0)
  })

  test("resolves full wager context (payout, effective line, customer ID, odds math) for live and off-tape alerts", () => {
    const liveWager = makeWager({
      ticketId: "TKT-901",
      customerId: "SHARP_42",
      agentId: "AF420",
      masterAgent: "BILLY666",
      vip: true,
      sport: "NFL",
      subSport: "NFL_LIVE",
      betType: "SPREAD",
      event: "KC @ BUF",
      selection: "KC -3.5",
      lineDisplay: "-3.5",
      oddsAmerican: "-110",
      riskUsd: 5_500,
      toWinUsd: 5_000,
      clvCents: 3.8,
      maxRecommendedStake: 4_000,
      alertTier: "CRITICAL",
      operatorDirective: "SHADE_AND_CAP",
      timestamp: new Date(ANCHOR_MS - 3 * 60_000).toISOString(),
    })

    const offTapeAlert: DashboardAlertRecord = {
      deliveryId: "del-902",
      wagerId: "TKT-902",
      tier: "STEAM",
      status: "delivered",
      payload: {
        customerId: "MJ102",
        sport: "NBA",
        event: "DEN @ PHX",
        selection: "PHX +145",
        oddsAmerican: "+145",
        amountUsd: 2_000,
        clvCents: 2.1,
        directive: "WATCH_STEAM",
      },
      createdAt: new Date(ANCHOR_MS - 1 * 60_000).toISOString(),
      updatedAt: new Date(ANCHOR_MS - 1 * 60_000).toISOString(),
    }

    const feed = buildRecentRiskAlerts({
      wagers: [liveWager],
      alertRecords: [offTapeAlert],
      breachLimitUsd: 50_000,
      warningLimitUsd: 40_000,
      anchorMs: ANCHOR_MS,
    })

    const offTapeItem = feed.items.find((i) => i.ticketId === "TKT-902")
    const liveItem = feed.items.find((i) => i.ticketId === "TKT-901")
    expect(liveItem).toBeDefined()
    expect(offTapeItem).toBeDefined()

    // Live wager context
    const liveCtx = resolveAlertWagerContext(liveItem!)
    expect(liveCtx.customerId).toBe("SHARP_42")
    expect(liveCtx.agentId).toBe("AF420")
    expect(liveCtx.masterAgent).toBe("BILLY666")
    expect(liveCtx.vip).toBe(true)
    expect(liveCtx.effectiveLine).toBe("-3.5 (-110)")
    expect(liveCtx.riskUsd).toBe(5_500)
    expect(liveCtx.toWinUsd).toBe(5_000)
    expect(liveCtx.totalPayoutUsd).toBe(10_500)
    expect(liveCtx.payoutEstimatedFromOdds).toBe(false)
    expect(liveCtx.payoutMultiple).toBe(0.91)
    expect(liveCtx.totalReturnMultiple).toBe(1.91)
    expect(liveCtx.impliedProbability).toBe("52.4%")
    expect(liveCtx.capUtilizationPct).toBe(137.5)
    expect(liveCtx.clvCents).toBe(3.8)
    expect(liveCtx.operatorDirective).toBe("SHADE_AND_CAP")

    const brief = formatAlertWagerBrief(liveItem!, liveCtx)
    expect(brief).toContain("SHARP_42")
    expect(brief).toContain("-3.5 (-110)")
    expect(brief).toContain("$10,500")

    // Off-tape delivery alert context estimates payout from American odds without duplicating odds in effectiveLine
    const offCtx = resolveAlertWagerContext(offTapeItem!)
    expect(offCtx.hasLiveWagerRecord).toBe(false)
    expect(offCtx.customerId).toBe("MJ102")
    expect(offCtx.effectiveLine).toBe("PHX +145")
    expect(offCtx.toWinUsd).toBe(2_900)
    expect(offCtx.totalPayoutUsd).toBe(4_900)
    expect(offCtx.payoutEstimatedFromOdds).toBe(true)
    expect(offCtx.clvCents).toBe(2.1)
    expect(offCtx.deliveryStatus).toBe("delivered")

    // American odds helper sanity checks
    expect(estimateToWinFromAmericanOdds(1_100, "-110")).toBe(1_000)
    expect(estimateToWinFromAmericanOdds(1_000, "+250")).toBe(2_500)
    expect(estimateToWinFromAmericanOdds(1_000, "invalid")).toBeNull()
  })

  test("computes vertical USD threshold limit marker across crossed, approaching, and armed states", () => {
    const w1 = makeWager({
      ticketId: "T-LIM-1",
      riskUsd: 14_000,
      alertTier: "STEAM",
      timestamp: new Date(ANCHOR_MS - 42 * 60_000).toISOString(),
    })
    const w2 = makeWager({
      ticketId: "T-LIM-2",
      riskUsd: 13_000, // cumulative 27,000 -> crosses $25k limit at -20m (bucket 8)
      alertTier: "STANDARD",
      timestamp: new Date(ANCHOR_MS - 20 * 60_000).toISOString(),
    })
    const w3 = makeWager({
      ticketId: "T-LIM-3",
      riskUsd: 7_000, // cumulative 34,000 -> post-threshold escalation breach at -6m
      alertTier: "CRITICAL",
      timestamp: new Date(ANCHOR_MS - 6 * 60_000).toISOString(),
    })

    // 1. Crossed state at $25k limit
    const crossedFeed = buildRecentRiskAlerts({
      wagers: [w1, w2, w3],
      breachLimitUsd: 25_000,
      warningLimitUsd: 20_000,
      anchorMs: ANCHOR_MS,
    })
    const crossedSeries = buildRecentAlertFrequencyBuckets(crossedFeed, 12)
    const mCrossed = crossedSeries.thresholdMarker
    expect(mCrossed.status).toBe("crossed")
    expect(mCrossed.breachLimitUsd).toBe(25_000)
    expect(mCrossed.totalWindowRiskUsd).toBe(34_000)
    expect(mCrossed.crossedTicketId).toBe("T-LIM-2")
    expect(mCrossed.crossedAtMs).toBe(ANCHOR_MS - 20 * 60_000)
    expect(mCrossed.crossedBucketIndex).toBe(8)
    expect(mCrossed.normalizedX).toBeCloseTo(40 / 60, 2)
    expect(mCrossed.postThresholdAlertCount).toBe(2)
    expect(mCrossed.postThresholdBreachCount).toBe(2)

    // 2. Approaching state when operator raises limit to $40k (warn $32k, exposure $34k)
    const approachingFeed = buildRecentRiskAlerts({
      wagers: [w1, w2, w3],
      breachLimitUsd: 40_000,
      warningLimitUsd: 32_000,
      anchorMs: ANCHOR_MS,
    })
    const mApproaching = buildRecentAlertFrequencyBuckets(approachingFeed, 12).thresholdMarker
    expect(mApproaching.status).toBe("approaching")
    expect(mApproaching.crossedAtMs).toBeNull()
    expect(mApproaching.normalizedX).toBe(1)
    expect(mApproaching.utilizationPct).toBe(85)

    // 3. Armed state when operator raises limit to $100k (warn $80k, exposure $34k)
    const armedFeed = buildRecentRiskAlerts({
      wagers: [w1, w2, w3],
      breachLimitUsd: 100_000,
      warningLimitUsd: 80_000,
      anchorMs: ANCHOR_MS,
    })
    const mArmed = buildRecentAlertFrequencyBuckets(armedFeed, 12).thresholdMarker
    expect(mArmed.status).toBe("armed")
    expect(mArmed.crossedAtMs).toBeNull()
    expect(mArmed.normalizedX).toBe(1)
    expect(mArmed.utilizationPct).toBe(34)
  })

  test("isolates Warning and Breach severities via status filter while preserving 60m threshold context", () => {
    const warnWager = makeWager({
      ticketId: "T-WARN-1",
      riskUsd: 21_000, // crosses $20k warn threshold
      timestamp: new Date(ANCHOR_MS - 30 * 60_000).toISOString(),
    })
    const steamWarn = makeWager({
      ticketId: "T-WARN-2",
      riskUsd: 2_000,
      alertTier: "STEAM",
      timestamp: new Date(ANCHOR_MS - 18 * 60_000).toISOString(),
    })
    const breachWager = makeWager({
      ticketId: "T-BREACH-1",
      riskUsd: 5_000, // cumulative $28k -> breaches $25k cap
      timestamp: new Date(ANCHOR_MS - 6 * 60_000).toISOString(),
    })

    const feed = buildRecentRiskAlerts({
      wagers: [warnWager, steamWarn, breachWager],
      breachLimitUsd: 25_000,
      warningLimitUsd: 20_000,
      anchorMs: ANCHOR_MS,
    })

    expect(feed.items.length).toBe(3)
    expect(feed.warnCount).toBe(2)
    expect(feed.breachCount).toBe(1)

    // 'ALL' returns identity feed
    expect(filterRecentRiskAlerts(feed, "ALL")).toBe(feed)

    // 'WARN' isolates only warning items and zeroes breachCount while keeping threshold crossing intact
    const warnOnly = filterRecentRiskAlerts(feed, "WARN")
    expect(warnOnly.items.length).toBe(2)
    expect(warnOnly.items.every((i) => i.severity === "WARN")).toBe(true)
    expect(warnOnly.warnCount).toBe(2)
    expect(warnOnly.breachCount).toBe(0)
    expect(warnOnly.thresholdCrossedTicketId).toBe("T-BREACH-1")

    const warnBuckets = buildRecentAlertFrequencyBuckets(warnOnly, 12)
    expect(warnBuckets.buckets.reduce((s, b) => s + b.warnCount, 0)).toBe(2)
    expect(warnBuckets.buckets.reduce((s, b) => s + b.breachCount, 0)).toBe(0)
    expect(warnBuckets.thresholdMarker.status).toBe("crossed")

    // 'BREACH' isolates only breach items
    const breachOnly = filterRecentRiskAlerts(feed, "BREACH")
    expect(breachOnly.items.length).toBe(1)
    expect(breachOnly.items[0]?.ticketId).toBe("T-BREACH-1")
    expect(breachOnly.breachCount).toBe(1)
    expect(breachOnly.warnCount).toBe(0)

    const breachBuckets = buildRecentAlertFrequencyBuckets(breachOnly, 12)
    expect(breachBuckets.buckets.reduce((s, b) => s + b.breachCount, 0)).toBe(1)
    expect(breachBuckets.buckets.reduce((s, b) => s + b.warnCount, 0)).toBe(0)
    expect(breachBuckets.thresholdMarker.breachLimitUsd).toBe(25_000)
  })
})
