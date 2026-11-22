import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { computeHandleDelta24hPct, runBatchedRanking } from "../../lib/customer_rankings.ts"
import { normalizeRankingsResponse } from "../../packages/ui/src/hydration.ts"
import { AgentMultiSelectFilter } from "../../packages/ui/src/panels/AgentMultiSelectFilter.tsx"
import {
  HandleTrendIndicator,
  RankingsTabPanel,
  resolveHandleTrend24h,
} from "../../packages/ui/src/panels/RankingsTabPanel.tsx"

describe("Rankings 24h Handle Performance Trend Indicator", () => {
  test("computeHandleDelta24hPct derives positive, negative, and neutral shifts from book telemetry", () => {
    const upward = computeHandleDelta24hPct({
      lifetimeVolumeUsd: 100000,
      sevenDayVolumeUsd: 40000,
      tickets: [
        { placed_at: "2026-11-18T10:00:00Z", risk_usd: 1000 },
        { placed_at: "2026-11-20T09:00:00Z", risk_usd: 2500 },
      ],
      netUsd: 5000,
      clvBps: 30,
    })
    expect(upward).toBeGreaterThan(0)

    const downward = computeHandleDelta24hPct({
      lifetimeVolumeUsd: 300000,
      sevenDayVolumeUsd: 14000,
      tickets: [
        { placed_at: "2026-11-18T10:00:00Z", risk_usd: 5000 },
        { placed_at: "2026-11-20T09:00:00Z", risk_usd: 1500 },
      ],
      netUsd: -12000,
      clvBps: -20,
    })
    expect(downward).toBeLessThan(0)

    const neutral = computeHandleDelta24hPct({
      lifetimeVolumeUsd: 0,
      sevenDayVolumeUsd: null,
      tickets: [],
      netUsd: 0,
      clvBps: null,
    })
    expect(neutral).toBe(0)
  })

  test("resolveHandleTrend24h and HandleTrendIndicator render accessible up, down, flat, and null states", () => {
    expect(resolveHandleTrend24h(null)).toBeNull()
    expect(resolveHandleTrend24h(undefined)).toBeNull()

    const up = resolveHandleTrend24h(6.42)
    expect(up?.direction).toBe("up")
    expect(up?.formatted).toBe("+6.4%")

    const down = resolveHandleTrend24h(-4.84)
    expect(down?.direction).toBe("down")
    expect(down?.formatted).toBe("-4.8%")

    const flat = resolveHandleTrend24h(0.02)
    expect(flat?.direction).toBe("flat")
    expect(flat?.formatted).toBe("0.0%")

    const upHtml = renderToStaticMarkup(
      React.createElement(HandleTrendIndicator, {
        deltaPct: 6.4,
        label: "BILLY666 24h shift",
      }),
    )
    expect(upHtml).toContain('data-handle-trend-24h="up"')
    expect(upHtml).toContain('data-handle-trend-arrow="up"')
    expect(upHtml).toContain("+6.4%")
    expect(upHtml).toContain("BILLY666 24h shift: up +6.4% over last 24h")

    const downHtml = renderToStaticMarkup(
      React.createElement(HandleTrendIndicator, {
        deltaPct: -4.8,
        label: "SYNTH_AGENT_01 24h shift",
      }),
    )
    expect(downHtml).toContain('data-handle-trend-24h="down"')
    expect(downHtml).toContain('data-handle-trend-arrow="down"')
    expect(downHtml).toContain("-4.8%")
  })

  test("runBatchedRanking, normalizeRankingsResponse, RankingsTabPanel, and AgentMultiSelectFilter surface 24h trends beside handle percentages", async () => {
    const raw = await runBatchedRanking({ limitPlayers: 50 })
    expect(raw.topSubAgents.length).toBeGreaterThan(0)
    expect(typeof raw.topSubAgents[0]?.handleDelta24hPct).toBe("number")
    expect(typeof raw.topMasterAgents[0]?.handleDelta24hPct).toBe("number")

    const normalized = normalizeRankingsResponse(raw)
    expect(normalized).not.toBeNull()
    expect(typeof normalized?.subAgents[0]?.handleDelta24hPct).toBe("number")
    expect(typeof normalized?.masterAgents[0]?.handleDelta24hPct).toBe("number")

    const html = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        rankings: normalized,
        rankingsStatus: "ready",
      }),
    )

    expect(html).toContain("data-handle-trend-24h=")
    expect(html).toContain("over last 24h")

    const dropdownHtml = renderToStaticMarkup(
      React.createElement(AgentMultiSelectFilter, {
        options: [
          {
            agentId: "SYNTH_AGENT_01",
            masterAgent: "BILLY666",
            role: "sub-agent",
            handleUsd: 500000,
            customerCount: 1,
            concPct: 100,
            isProxyConduit: true,
            handleDelta24hPct: 5.2,
          },
        ],
        selectedAgentIds: [],
        onChange: () => {},
        defaultOpen: true,
      }),
    )
    expect(dropdownHtml).toContain('data-agent-option-trend="up"')
    expect(dropdownHtml).toContain("+5.2%")
  })
})
