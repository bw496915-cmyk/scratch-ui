import { describe, expect, test } from "bun:test"
import {
  buildRolling60MinHandleSeries,
  formatHandleCompactUsd,
  HANDLE_WINDOW_MINUTES,
  handleUsdOf,
  isSentinelWager,
  parseWagerTimestampMs,
} from "../../packages/ui/src/handle_volume_series.ts"
import type { LiveWager } from "../../packages/ui/src/types.ts"

function makeWager(overrides: Partial<LiveWager> = {}): LiveWager {
  return {
    ticketId: "W-10001",
    customerId: "CUST-01",
    agentId: "AG-01",
    sport: "NBA",
    betType: "STRAIGHT",
    event: "LAL @ BOS",
    selection: "LAL +4.5 (-110)",
    riskUsd: 500,
    toWinUsd: 454.55,
    clvCents: 1.5,
    alertTier: "NORMAL",
    alertBadge: "Normal",
    timestamp: "2026-11-20T18:00:00.000Z",
    ticketWriter: "INTERNET",
    ...overrides,
  }
}

describe("handle_volume_series: timestamp & handle helpers", () => {
  test("parseWagerTimestampMs parses ISO 8601, SQL timestamps, and desk wall clocks", () => {
    const anchor = Date.parse("2026-11-20T18:30:00.000Z")

    expect(parseWagerTimestampMs("2026-11-20T18:15:10.000Z", anchor)).toBe(
      Date.parse("2026-11-20T18:15:10.000Z"),
    )

    const sqlParsed = parseWagerTimestampMs("2026-11-01 17:15:02.770", anchor)
    expect(sqlParsed).not.toBeNull()
    expect(sqlParsed).toBe(Date.parse("2026-11-01T17:15:02.770"))

    // Desk clock format ("6:25:00 PM ET" -> 18:25:00 local to anchor day)
    const deskParsed = parseWagerTimestampMs("6:25:00 PM ET", anchor)
    expect(deskParsed).not.toBeNull()
    const deskDate = new Date(deskParsed!)
    expect(deskDate.getHours()).toBe(18)
    expect(deskDate.getMinutes()).toBe(25)
    expect(deskDate.getSeconds()).toBe(0)

    // Midnight wraparound: 23:55 wager anchored at 00:05 resolves to previous day
    const postMidnightAnchor = new Date(2026, 10, 20, 0, 5, 0, 0).getTime()
    const preMidnight = parseWagerTimestampMs("11:55:00 PM ET", postMidnightAnchor)
    expect(preMidnight).not.toBeNull()
    expect(postMidnightAnchor - preMidnight!).toBe(10 * 60_000)

    // Invalid / empty inputs
    expect(parseWagerTimestampMs("", anchor)).toBeNull()
    expect(parseWagerTimestampMs(null, anchor)).toBeNull()
    expect(parseWagerTimestampMs("not-a-timestamp", anchor)).toBeNull()
  })

  test("isSentinelWager and handleUsdOf exclude ALERT/BLOCKED and prefer volumeUsd", () => {
    const normalRiskOnly = makeWager({ riskUsd: 400 })
    expect(isSentinelWager(normalRiskOnly)).toBe(false)
    expect(handleUsdOf(normalRiskOnly)).toBe(400)

    const withVolume = makeWager({ riskUsd: 400, volumeUsd: 880 })
    expect(handleUsdOf(withVolume)).toBe(880)

    const alertSentinel = makeWager({
      ticketWriter: "ALERT",
      writer: "alert",
      riskUsd: 2500,
      volumeUsd: 5000,
    })
    expect(isSentinelWager(alertSentinel)).toBe(true)
    expect(handleUsdOf(alertSentinel)).toBe(0)

    const blockedSentinel = makeWager({
      ticketWriter: "BLOCKED",
      writer: "blocked",
      riskUsd: 1000,
    })
    expect(isSentinelWager(blockedSentinel)).toBe(true)
    expect(handleUsdOf(blockedSentinel)).toBe(0)
  })

  test("formatHandleCompactUsd formats currency cleanly across scales", () => {
    expect(formatHandleCompactUsd(0)).toBe("$0")
    expect(formatHandleCompactUsd(750)).toBe("$750")
    expect(formatHandleCompactUsd(2_450)).toBe("$2.45k")
    expect(formatHandleCompactUsd(48_200)).toBe("$48.2k")
    expect(formatHandleCompactUsd(1_250_000)).toBe("$1.25M")
  })
})

describe("handle_volume_series: buildRolling60MinHandleSeries", () => {
  test("buckets live wagers into 60 one-minute intervals and computes cumulative aggregate", () => {
    const anchorMs = Date.parse("2026-11-20T18:59:30.000Z")

    const wagers: LiveWager[] = [
      // 45 minutes before anchor -> bucket index 14
      makeWager({
        ticketId: "W-1",
        timestamp: "2026-11-20T18:14:15.000Z",
        riskUsd: 1000,
      }),
      // Same minute as W-1 -> aggregates in same bucket
      makeWager({
        ticketId: "W-2",
        timestamp: "2026-11-20T18:14:48.000Z",
        riskUsd: 500,
        volumeUsd: 750,
      }),
      // 5 minutes before anchor
      makeWager({
        ticketId: "W-3",
        timestamp: "2026-11-20T18:54:05.000Z",
        riskUsd: 2200,
      }),
      // Current minute (Now)
      makeWager({
        ticketId: "W-4",
        timestamp: "2026-11-20T18:59:10.000Z",
        riskUsd: 800,
      }),
      // Outside 60-minute window (75 minutes old) -> excluded from buckets
      makeWager({
        ticketId: "W-OLD",
        timestamp: "2026-11-20T17:44:00.000Z",
        riskUsd: 9999,
      }),
      // Sentinel row inside window -> excluded
      makeWager({
        ticketId: "W-SENTINEL",
        timestamp: "2026-11-20T18:58:00.000Z",
        ticketWriter: "ALERT",
        writer: "alert",
        riskUsd: 5000,
      }),
    ]

    const result = buildRolling60MinHandleSeries(wagers, { anchorMs })

    expect(result.points).toHaveLength(HANDLE_WINDOW_MINUTES)
    expect(result.windowMode).toBe("live")
    expect(result.includedTickets).toBe(4)
    expect(result.excludedSentinelTickets).toBe(1)
    expect(result.unparsedTimestampTickets).toBe(0)
    // 1000 + 750 + 2200 + 800 = 4750
    expect(result.totalHandleUsd).toBe(4750)
    expect(result.peakMinuteHandleUsd).toBe(2200)
    expect(result.points[0]?.relativeLabel).toBe("-59m")
    expect(result.points[59]?.relativeLabel).toBe("Now")
    expect(result.points[59]?.cumulativeHandleUsd).toBe(4750)
    expect(result.points[59]?.cumulativeTickets).toBe(4)

    // Cumulative series must be monotonically non-decreasing
    for (let i = 1; i < result.points.length; i += 1) {
      expect(result.points[i]!.cumulativeHandleUsd).toBeGreaterThanOrEqual(
        result.points[i - 1]!.cumulativeHandleUsd,
      )
    }
  })

  test("falls back to capture-window anchoring for historical snapshots older than 60 minutes", () => {
    const nowMs = Date.parse("2026-11-20T20:00:00.000Z")
    const historicalWagers: LiveWager[] = [
      makeWager({
        ticketId: "H-1",
        timestamp: "2026-11-01 17:10:00.000",
        riskUsd: 600,
      }),
      makeWager({
        ticketId: "H-2",
        timestamp: "2026-11-01 17:15:02.770",
        riskUsd: 1400,
      }),
    ]

    const result = buildRolling60MinHandleSeries(historicalWagers, {
      anchorMs: nowMs,
    })

    expect(result.windowMode).toBe("capture")
    expect(result.includedTickets).toBe(2)
    expect(result.totalHandleUsd).toBe(2000)
    expect(result.points[59]?.minuteHandleUsd).toBe(1400)
    expect(result.points[59]?.cumulativeHandleUsd).toBe(2000)
  })

  test("returns zeroed 60-minute baseline for empty input", () => {
    const anchorMs = Date.parse("2026-11-20T18:00:00.000Z")
    const result = buildRolling60MinHandleSeries([], { anchorMs })

    expect(result.points).toHaveLength(60)
    expect(result.windowMode).toBe("live")
    expect(result.totalHandleUsd).toBe(0)
    expect(result.meanMinuteHandleUsd).toBe(0)
    expect(result.stdDevMinuteHandleUsd).toBe(0)
    expect(result.twoSigmaThresholdUsd).toBe(0)
    expect(result.anomalyCount).toBe(0)
    expect(result.includedTickets).toBe(0)
    expect(result.peakMinuteHandleUsd).toBe(0)
    expect(result.peakMinuteLabel).toBeNull()
  })

  test("flags only buckets strictly exceeding 2 standard deviations above the 60-minute mean volume", () => {
    const anchorMs = Date.parse("2026-11-20T18:59:30.000Z")
    const wagers: LiveWager[] = []

    // Baseline steady flow of $100/min across 58 minutes
    for (let m = 0; m < 58; m += 1) {
      const ts = new Date(Date.parse("2026-11-20T18:00:15.000Z") + m * 60_000).toISOString()
      wagers.push(
        makeWager({
          ticketId: `B-${m}`,
          timestamp: ts,
          riskUsd: 100,
        }),
      )
    }

    // Moderate bump at minute 58 ($150) — should NOT exceed +2σ
    wagers.push(
      makeWager({
        ticketId: "B-MOD",
        timestamp: "2026-11-20T18:58:10.000Z",
        riskUsd: 150,
      }),
    )

    // Major volume spike at minute 59 ($5,000) — clearly exceeds mean + 2σ
    wagers.push(
      makeWager({
        ticketId: "B-SPIKE",
        timestamp: "2026-11-20T18:59:10.000Z",
        riskUsd: 5_000,
      }),
    )

    const result = buildRolling60MinHandleSeries(wagers, { anchorMs })

    expect(result.anomalyCount).toBe(1)
    expect(result.meanMinuteHandleUsd).toBeGreaterThan(180)
    expect(result.stdDevMinuteHandleUsd).toBeGreaterThan(600)
    expect(result.twoSigmaThresholdUsd).toBeCloseTo(
      result.meanMinuteHandleUsd + 2 * result.stdDevMinuteHandleUsd,
      1,
    )

    const anomalies = result.points.filter((pt) => pt.isAnomaly)
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]?.relativeLabel).toBe("Now")
    expect(anomalies[0]?.minuteHandleUsd).toBe(5_000)
    expect(anomalies[0]?.zScore).toBeGreaterThan(2)

    // Non-spike buckets remain unmarked
    expect(result.points[58]?.isAnomaly).toBe(false)
    expect(result.points[0]?.isAnomaly).toBe(false)
  })

  test("marks zero anomalies when all 60 buckets have uniform volume (stdDev = 0)", () => {
    const anchorMs = Date.parse("2026-11-20T18:59:30.000Z")
    const uniformWagers: LiveWager[] = Array.from({ length: 60 }, (_, m) =>
      makeWager({
        ticketId: `U-${m}`,
        timestamp: new Date(Date.parse("2026-11-20T18:00:10.000Z") + m * 60_000).toISOString(),
        riskUsd: 250,
      }),
    )

    const result = buildRolling60MinHandleSeries(uniformWagers, { anchorMs })
    expect(result.meanMinuteHandleUsd).toBe(250)
    expect(result.stdDevMinuteHandleUsd).toBe(0)
    expect(result.twoSigmaThresholdUsd).toBe(250)
    expect(result.anomalyCount).toBe(0)
    expect(result.points.every((pt) => !pt.isAnomaly && pt.zScore === 0)).toBe(true)
  })
})
