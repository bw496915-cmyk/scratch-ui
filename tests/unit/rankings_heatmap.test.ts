import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { NormalizedRankingsResult } from "../../packages/ui/src/hydration.ts"
import {
  buildHandleHeatLookup,
  createHandleHeatScale,
  evaluateHandleHeatCell,
  formatHeatCurrencyCompact,
  parseStoredRankingsHeatMapValue,
  RANKINGS_HEATMAP_STORAGE_KEY,
  readStoredRankingsHeatMap,
  writeStoredRankingsHeatMap,
} from "../../packages/ui/src/panels/rankings_heatmap.ts"
import { RankingsHeatMapLegend, RankingsTabPanel } from "../../packages/ui/src/panels/RankingsTabPanel.tsx"
import { buildDashboardSearch, readDashboardUrlState } from "../../packages/ui/src/url_state.ts"

describe("Rankings Handle Volume Heat-Map Overlay", () => {
  test("log10 + P5–P95 clamping prevents a whale outlier from compressing normal agents into bucket 1", () => {
    const handles = [
      1_000,
      2_500,
      5_000,
      8_000,
      12_000,
      18_000,
      25_000,
      36_000,
      50_000,
      75_000,
      120_000,
      180_000,
      260_000,
      400_000,
      50_000_000, // Extreme syndicate whale outlier
    ]

    const scale = createHandleHeatScale(handles)
    expect(scale.positiveCount).toBe(handles.length)
    expect(scale.min).toBe(1_000)
    expect(scale.median).toBe(36_000)
    expect(scale.p95).toBeLessThan(50_000_000)

    const nonWhaleBuckets = handles.slice(0, -1).map((h) => evaluateHandleHeatCell(scale, h).bucket)
    const distinctNonWhaleBuckets = new Set(nonWhaleBuckets)
    // Normal agents must distribute across multiple buckets (not compressed into bucket 1).
    expect(distinctNonWhaleBuckets.size).toBeGreaterThanOrEqual(4)
    expect(evaluateHandleHeatCell(scale, 1_000).bucket).toBe(1)
    expect(evaluateHandleHeatCell(scale, 50_000_000).bucket).toBe(5)
    expect(evaluateHandleHeatCell(scale, 50_000_000).percentileRank).toBeGreaterThanOrEqual(95)
  })

  test("null, undefined, NaN, and 0 handles strictly map to bucket 0 while low active handles map to >= 1", () => {
    const scale = createHandleHeatScale([0, null, undefined, 500, 5_000, 50_000])
    expect(scale.positiveCount).toBe(3)
    expect(scale.totalCount).toBe(6)

    for (const inactive of [null, undefined, 0, -50, Number.NaN]) {
      const cell = evaluateHandleHeatCell(scale, inactive)
      expect(cell.bucket).toBe(0)
      expect(cell.isInactive).toBe(true)
      expect(cell.shareOfVisiblePct).toBe(0)
      expect(cell.percentileRank).toBe(0)
      expect(cell.percentileLabel).toBe("Inactive")
    }

    const lowActive = evaluateHandleHeatCell(scale, 500)
    expect(lowActive.bucket).toBe(1)
    expect(lowActive.isInactive).toBe(false)
    expect(lowActive.exactHandleLabel).toBe("$500")

    // Uniform / single positive handle still distinguishes active from inactive bucket 0
    const singleScale = createHandleHeatScale([25_000])
    const singleCell = evaluateHandleHeatCell(singleScale, 25_000)
    expect(singleCell.bucket).toBe(3)
    expect(singleCell.shareOfVisiblePct).toBeCloseTo(100, 5)
    expect(singleCell.percentileRank).toBe(100)
  })

  test("localStorage and URL state persist heat-map toggle cleanly (default on, ?heatmap=0 when off)", () => {
    const store = new Map<string, string>()
    const fakeStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
    }

    expect(readStoredRankingsHeatMap(fakeStorage)).toBeNull()
    expect(parseStoredRankingsHeatMapValue("1")).toBe(true)
    expect(parseStoredRankingsHeatMapValue("0")).toBe(false)
    expect(parseStoredRankingsHeatMapValue("true")).toBe(true)
    expect(parseStoredRankingsHeatMapValue("false")).toBe(false)
    expect(parseStoredRankingsHeatMapValue("invalid")).toBeNull()
    writeStoredRankingsHeatMap(false, fakeStorage)
    expect(store.get(RANKINGS_HEATMAP_STORAGE_KEY)).toBe("0")
    expect(readStoredRankingsHeatMap(fakeStorage)).toBe(false)
    writeStoredRankingsHeatMap(true, fakeStorage)
    expect(readStoredRankingsHeatMap(fakeStorage)).toBe(true)

    const parsedOff = readDashboardUrlState("?tab=rankings&heatmap=0", "/", "")
    expect(parsedOff.tab).toBe("rankings")
    expect(parsedOff.rankingsHeatmap).toBe(false)

    const serializedOff = buildDashboardSearch(parsedOff, "", "/")
    expect(serializedOff).toContain("tab=rankings")
    expect(serializedOff).toContain("heatmap=0")

    // Default-on keeps URL clean (omits heatmap param)
    const serializedOn = buildDashboardSearch({ ...parsedOff, rankingsHeatmap: true }, "?tab=rankings&heatmap=0", "/")
    expect(serializedOn).not.toContain("heatmap=")

    // Leaving rankings scrubs heatmap param
    const serializedAway = buildDashboardSearch({ ...parsedOff, tab: "wagers" }, "?tab=rankings&heatmap=0", "/")
    expect(serializedAway).not.toContain("heatmap=")
  })

  test("RankingsTabPanel renders toggle, 6-step inline legend, bucketed cells (including 0 inactive), and hover tooltips", () => {
    const mockRankings: NormalizedRankingsResult = {
      summary: {
        windowStart: "2026-10-21",
        windowEnd: "2026-11-20",
        generatedAtIso: "2026-11-20T18:00:00Z",
        inWindowWagers: 520,
        totalHandleUsd: 2_620_000,
        totalToWinUsd: 2_300_000,
        activeCustomerCount: 4,
        activeSubAgentCount: 4,
        activeMasterAgentCount: 2,
        conduitSubAgentCount: 2,
      },
      players: [
        {
          rank: 1,
          id: "WHALE_01",
          agentId: "AG_WHALE",
          masterAgent: "BILLY666",
          handleUsd: 2_500_000,
          wagers: 220,
          gini: 0.11,
          alertRate: 64,
          score: 8.9,
          tier: "TIER_1",
          tierLabel: "Tier 1 Sharp",
          dominantSport: "NFL",
          isProxy: true,
          limitUsd: 25_000,
          netUsd: 120_000,
          handleDelta24hPct: 4.5,
        },
        {
          rank: 2,
          id: "MID_02",
          agentId: "AG_MID",
          masterAgent: "BILLY666",
          handleUsd: 100_000,
          wagers: 180,
          gini: 0.19,
          alertRate: 22,
          score: 6.4,
          tier: "TIER_3",
          tierLabel: "Tier 3 Sharp",
          dominantSport: "NBA",
          isProxy: false,
          limitUsd: 5_000,
          netUsd: -14_000,
          handleDelta24hPct: -2.1,
        },
        {
          rank: 3,
          id: "LOW_03",
          agentId: "AG_LOW",
          masterAgent: "MASTER_B",
          handleUsd: 20_000,
          wagers: 120,
          gini: 0.25,
          alertRate: 10,
          score: 4.2,
          tier: "RECREATIONAL",
          tierLabel: "Recreational",
          dominantSport: "MLB",
          isProxy: false,
          limitUsd: 2_000,
          netUsd: -2_000,
          handleDelta24hPct: 0.0,
        },
        {
          rank: 4,
          id: "ZERO_04",
          agentId: "AG_ZERO",
          masterAgent: "MASTER_B",
          handleUsd: 0,
          wagers: 0,
          gini: 0.0,
          alertRate: 0,
          score: 1.0,
          tier: "RECREATIONAL",
          tierLabel: "Inactive",
          dominantSport: "NFL",
          isProxy: false,
          limitUsd: 500,
          netUsd: 0,
          handleDelta24hPct: 0,
        },
      ],
      subAgents: [
        {
          agentId: "AG_WHALE",
          masterAgent: "BILLY666",
          handleUsd: 2_500_000,
          wagers: 220,
          customerCount: 1,
          topCust: "WHALE_01",
          concPct: 100,
          isProxyConduit: true,
          handleDelta24hPct: 4.5,
        },
        {
          agentId: "AG_MID",
          masterAgent: "BILLY666",
          handleUsd: 100_000,
          wagers: 180,
          customerCount: 1,
          topCust: "MID_02",
          concPct: 100,
          isProxyConduit: true,
          handleDelta24hPct: -2.1,
        },
        {
          agentId: "AG_LOW",
          masterAgent: "MASTER_B",
          handleUsd: 20_000,
          wagers: 120,
          customerCount: 1,
          topCust: "LOW_03",
          concPct: 100,
          isProxyConduit: false,
          handleDelta24hPct: 0,
        },
        {
          agentId: "AG_ZERO",
          masterAgent: "MASTER_B",
          handleUsd: 0,
          wagers: 0,
          customerCount: 1,
          topCust: "ZERO_04",
          concPct: 0,
          isProxyConduit: false,
          handleDelta24hPct: 0,
        },
      ],
      masterAgents: [
        {
          masterAgent: "BILLY666",
          subAgentCount: 2,
          customerCount: 2,
          conduitCount: 2,
          handleUsd: 2_600_000,
          wagers: 400,
          handleDelta24hPct: 3.1,
        },
        {
          masterAgent: "MASTER_B",
          subAgentCount: 2,
          customerCount: 2,
          conduitCount: 0,
          handleUsd: 20_000,
          wagers: 120,
          handleDelta24hPct: 0,
        },
      ],
      conduits: [
        {
          agentId: "AG_WHALE",
          masterAgent: "BILLY666",
          handleUsd: 2_500_000,
          wagers: 220,
          topCust: "WHALE_01",
          concPct: 100,
          handleDelta24hPct: 4.5,
        },
        {
          agentId: "AG_MID",
          masterAgent: "BILLY666",
          handleUsd: 100_000,
          wagers: 180,
          topCust: "MID_02",
          concPct: 100,
          handleDelta24hPct: -2.1,
        },
      ],
      rejectedRows: 0,
      provenance: {
        source: "live",
        endpoint: "/api/rankings/all",
        fetchedAtIso: "2026-11-20T18:00:00Z",
      },
    }

    const htmlOn = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        rankings: mockRankings,
        rankingsStatus: "ready",
      }),
    )

    expect(htmlOn).toContain('data-heatmap-enabled="true"')
    expect(htmlOn).toContain('class="sd-heatmap-toggle"')
    expect(htmlOn).toContain('data-heatmap-toggle="true"')
    expect(htmlOn).toContain(`data-heatmap-storage-key="${RANKINGS_HEATMAP_STORAGE_KEY}"`)
    expect(htmlOn).toContain('class="sd-heatmap-toggle-track"')
    expect(htmlOn).toContain('aria-pressed="true"')
    expect(htmlOn).toContain("Heat Map: On")
    expect(htmlOn).toContain('data-heatmap-legend="true"')
    for (let b = 0; b <= 5; b += 1) {
      expect(htmlOn).toContain(`data-legend-bucket="${b}"`)
    }
    expect(htmlOn).toContain("Min $20.0K")
    expect(htmlOn).toContain("Median $100.0K")
    expect(htmlOn).toContain("P95+")
    // Zero-handle row gets bucket="0", highest gets bucket="5"
    expect(htmlOn).toContain('data-heat-bucket="0"')
    expect(htmlOn).toContain('data-heat-bucket="5"')
    // Pure CSS hover tooltip carries exact handle, % visible handle, and percentile rank
    expect(htmlOn).toContain('data-heat-tooltip="true"')
    expect(htmlOn).toContain("Exact Handle")
    expect(htmlOn).toContain("% Visible Handle")
    expect(htmlOn).toContain("Percentile Rank")
    expect(htmlOn).toContain("$2,500,000")

    // Disabled state turns off overlay and hides legend while keeping toggle accessible
    const htmlOff = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        heatMapEnabled: false,
        rankings: mockRankings,
        rankingsStatus: "ready",
      }),
    )
    expect(htmlOff).toContain('data-heatmap-enabled="false"')
    expect(htmlOff).toContain('aria-pressed="false"')
    expect(htmlOff).toContain("Heat Map: Off")
    expect(htmlOff).not.toContain('data-heatmap-legend="true"')

    // Direct lookup & legend verification
    const lookup = buildHandleHeatLookup(
      mockRankings.subAgents,
      (a) => a.agentId,
      (a) => a.handleUsd,
    )
    expect(lookup.byKey.get("AG_ZERO")?.bucket).toBe(0)
    expect(lookup.byKey.get("AG_WHALE")?.bucket).toBe(5)
    expect(formatHeatCurrencyCompact(lookup.scale.min)).toBe("$20.0K")

    const legendHtml = renderToStaticMarkup(
      React.createElement(RankingsHeatMapLegend, {
        scale: lookup.scale,
        scopeLabel: "Filtered Sub-Agents",
      }),
    )
    expect(legendHtml).toContain("0 / Inactive")
    expect(legendHtml).toContain("log10 · P5–P95 clamped")
  })
})
