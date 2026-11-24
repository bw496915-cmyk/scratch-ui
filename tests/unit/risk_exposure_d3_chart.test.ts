import { describe, expect, test } from "bun:test"

import { buildRolling60MinRiskSeries, RISK_ROLLING_PULSE_MINUTES } from "../../packages/ui/src/risk_exposure_series.ts"
import type { LiveWager } from "../../packages/ui/src/types.ts"
import {
  computeRiskExposureD3Layout,
  findNearestExposureBucketIndex,
  primaryValueForMode,
  type RiskExposureD3Mode,
  secondaryValueForMode,
} from "../../packages/ui/src/viz/RiskExposureD3Chart.tsx"

function makeWager(overrides: Partial<LiveWager> & { timestampMs: number }): LiveWager {
  const { timestampMs, ...rest } = overrides
  return {
    ticketId: `T-${timestampMs}`,
    customerId: "CUST100",
    agentId: "AG01",
    masterAgent: "MA01",
    sport: "NBA",
    event: "Team A vs Team B",
    selection: "Team A -3.5",
    lineDisplay: "-3.5",
    oddsAmerican: "-110",
    betType: "STRAIGHT",
    writer: "web",
    riskUsd: 500,
    toWinUsd: 455,
    clvCents: null,
    alertTier: "STANDARD",
    alertBadge: "STD",
    operatorDirective: "MONITOR",
    maxRecommendedStake: 25_000,
    autoExecute: false,
    timestamp: new Date(timestampMs).toISOString(),
    ...rest,
  }
}

function buildSampleWagers(anchorMs: number): LiveWager[] {
  const wagers: LiveWager[] = []
  // Steady baseline wagers across the 60-minute window
  for (let m = 55; m >= 2; m -= 3) {
    wagers.push(
      makeWager({
        ticketId: `BASE-${m}`,
        timestampMs: anchorMs - m * 60_000,
        riskUsd: 400 + (m % 4) * 100,
        toWinUsd: 380 + (m % 4) * 90,
        alertTier: m % 9 === 0 ? "CRITICAL" : "STANDARD",
      }),
    )
  }
  // Sharp >2σ surge 6 minutes before anchor
  for (let i = 0; i < 4; i += 1) {
    wagers.push(
      makeWager({
        ticketId: `SURGE-${i}`,
        timestampMs: anchorMs - 6 * 60_000 + i * 5_000,
        riskUsd: 4_500,
        toWinUsd: 4_100,
        alertTier: "CRITICAL",
      }),
    )
  }
  return wagers
}

describe("RiskExposureD3Chart layout & bisector engine", () => {
  const anchorMs = Date.UTC(2026, 10, 23, 20, 0, 0)
  const wagers = buildSampleWagers(anchorMs)
  const series = buildRolling60MinRiskSeries(wagers, {
    anchorMs,
    windowMinutes: 60,
    rollingPulseMinutes: RISK_ROLLING_PULSE_MINUTES,
  })

  test("generates valid finite D3 SVG paths and axes across all 3 display modes", () => {
    const modes: RiskExposureD3Mode[] = ["rolling", "perMinute", "cumulative"]
    for (const mode of modes) {
      const layout = computeRiskExposureD3Layout({
        series,
        mode,
        width: 820,
        height: 256,
        showOverlay: true,
        exposureLimitUsd: 25_000,
        warningLimitUsd: 20_000,
        isBreached: true,
      })

      expect(layout.primaryPath).toBeTruthy()
      expect(layout.primaryPath!.startsWith("M")).toBe(true)
      expect(layout.primaryPath!.includes("NaN")).toBe(false)

      expect(layout.primaryAreaPath).toBeTruthy()
      expect(layout.primaryAreaPath!.startsWith("M")).toBe(true)
      expect(layout.primaryAreaPath!.includes("NaN")).toBe(false)

      expect(layout.secondaryPath).toBeTruthy()
      expect(layout.secondaryPath!.startsWith("M")).toBe(true)
      expect(layout.secondaryPath!.includes("NaN")).toBe(false)

      expect(layout.pointCoords.length).toBe(series.points.length)
      expect(layout.latestNode).not.toBeNull()
      expect(layout.xTicks.length).toBeGreaterThanOrEqual(4)
      expect(layout.xTicks[layout.xTicks.length - 1]!.label.endsWith("(Now)")).toBe(true)
      expect(layout.yTicks.length).toBeGreaterThanOrEqual(2)
      expect(layout.yDomainMax).toBeGreaterThan(0)
    }
  })

  test("marks >2σ surge diamond nodes in rolling/perMinute modes and hides them in cumulative mode", () => {
    expect(series.spikeCount).toBeGreaterThan(0)

    const rollingLayout = computeRiskExposureD3Layout({
      series,
      mode: "rolling",
      width: 860,
    })
    const perMinuteLayout = computeRiskExposureD3Layout({
      series,
      mode: "perMinute",
      width: 860,
    })
    const cumulativeLayout = computeRiskExposureD3Layout({
      series,
      mode: "cumulative",
      width: 860,
    })

    expect(rollingLayout.spikeNodes.length).toBe(series.spikeCount)
    expect(perMinuteLayout.spikeNodes.length).toBe(series.spikeCount)
    expect(cumulativeLayout.spikeNodes.length).toBe(0)

    for (const node of perMinuteLayout.spikeNodes) {
      expect(Number.isFinite(node.cx)).toBe(true)
      expect(Number.isFinite(node.cy)).toBe(true)
      expect(node.cx).toBeGreaterThanOrEqual(perMinuteLayout.plotLeft)
      expect(node.cx).toBeLessThanOrEqual(perMinuteLayout.plotRight)
      expect(node.zScore).toBeGreaterThan(2)
    }

    // perMinute mode renders mean and +2σ reference lines
    const refIds = perMinuteLayout.referenceLines.map((r) => r.id)
    expect(refIds).toContain("mean")
    expect(refIds).toContain("twoSigma")
  })

  test("cumulative mode scales y-domain for 60m cap, emits warning/breach reference lines, and shades breach zone", () => {
    const exposureLimitUsd = 50_000
    const warningLimitUsd = 40_000
    const layout = computeRiskExposureD3Layout({
      series,
      mode: "cumulative",
      width: 860,
      exposureLimitUsd,
      warningLimitUsd,
      isBreached: false,
    })

    expect(layout.yDomainMax).toBeGreaterThanOrEqual(exposureLimitUsd * 1.08)
    expect(layout.breachZoneHeight).toBeGreaterThan(0)

    const warnLine = layout.referenceLines.find((r) => r.id === "warning")
    const breachLine = layout.referenceLines.find((r) => r.id === "breach")
    expect(warnLine).toBeDefined()
    expect(breachLine).toBeDefined()
    expect(breachLine!.y).toBeLessThan(warnLine!.y) // higher value is closer to plotTop
    expect(breachLine!.label).toContain("60m Limit")

    const breachedLayout = computeRiskExposureD3Layout({
      series,
      mode: "cumulative",
      width: 860,
      exposureLimitUsd,
      warningLimitUsd,
      isBreached: true,
    })
    const breachedRef = breachedLayout.referenceLines.find((r) => r.id === "breach")
    expect(breachedRef?.tone).toBe("breach")
    expect(breachedRef?.label).toContain("Breach Limit")
  })

  test("clamps thermal activity heat bands inside plot bounds with positive widths", () => {
    const layout = computeRiskExposureD3Layout({
      series,
      mode: "rolling",
      width: 780,
    })

    expect(layout.heatRects.length).toBeGreaterThan(0)
    for (const rect of layout.heatRects) {
      expect(rect.x).toBeGreaterThanOrEqual(layout.plotLeft)
      expect(rect.x + rect.width).toBeLessThanOrEqual(layout.plotRight + 0.001)
      expect(rect.width).toBeGreaterThan(0)
      expect(rect.heatLevel).toBeGreaterThanOrEqual(1)
      expect(rect.heatLevel).toBeLessThanOrEqual(4)
    }
  })

  test("primaryValueForMode and secondaryValueForMode map expected series fields", () => {
    const sample = series.points[series.points.length - 1]!
    expect(primaryValueForMode(sample, "rolling")).toBe(sample.rollingRiskUsd)
    expect(primaryValueForMode(sample, "perMinute")).toBe(sample.minuteRiskUsd)
    expect(primaryValueForMode(sample, "cumulative")).toBe(sample.cumulativeRiskUsd)

    expect(secondaryValueForMode(sample, "rolling")).toBe(sample.rollingCriticalRiskUsd)
    expect(secondaryValueForMode(sample, "perMinute")).toBe(sample.minuteCriticalRiskUsd)
    expect(secondaryValueForMode(sample, "cumulative")).toBe(sample.cumulativeLiabilityUsd)
  })

  test("findNearestExposureBucketIndex snaps accurately via D3 center bisector", () => {
    expect(findNearestExposureBucketIndex([], anchorMs)).toBeNull()

    const first = series.points[0]!
    const midIdx = Math.floor(series.points.length / 2)
    const mid = series.points[midIdx]!
    const lastIdx = series.points.length - 1
    const last = series.points[lastIdx]!

    expect(findNearestExposureBucketIndex(series.points, first.bucketMs - 30_000)).toBe(0)
    expect(findNearestExposureBucketIndex(series.points, first.bucketMs)).toBe(0)
    expect(findNearestExposureBucketIndex(series.points, mid.bucketMs + 10_000)).toBe(midIdx)
    expect(findNearestExposureBucketIndex(series.points, last.bucketMs)).toBe(lastIdx)
    expect(findNearestExposureBucketIndex(series.points, last.bucketMs + 120_000)).toBe(lastIdx)
  })
})
