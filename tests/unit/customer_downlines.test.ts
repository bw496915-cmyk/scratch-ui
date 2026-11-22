import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { runBatchedRanking } from "../../lib/customer_rankings.ts"
import { normalizeRankingsResponse } from "../../packages/ui/src/hydration.ts"
import {
  buildDownlineForests,
  buildDownlinesCsv,
  RankingsTabPanel,
} from "../../packages/ui/src/panels/RankingsTabPanel.tsx"
import {
  buildDashboardSearch,
  DEFAULT_DASHBOARD_URL_STATE,
  readDashboardUrlState,
} from "../../packages/ui/src/url_state.ts"

describe("Customer URL Focus Scoping & Enhanced Customer Downlines", () => {
  test("url_state reads ?customer=BGD101&tab=rankings and scrubs customer when cleared or leaving customer-scoped tabs", () => {
    const parsed = readDashboardUrlState("?customer=BGD101&tab=rankings", "/")
    expect(parsed.tab).toBe("rankings")
    expect(parsed.customer).toBe("BGD101")

    // Clearing customer focus removes ?customer=BGD101 immediately
    const cleared = buildDashboardSearch(
      { ...parsed, customer: "" },
      "?customer=BGD101&tab=rankings",
      "/",
    )
    expect(cleared).toBe("tab=rankings")
    expect(cleared).not.toContain("BGD101")

    // Navigating to a non-customer tab removes stale ?customer=
    const onWagers = buildDashboardSearch(
      { ...parsed, tab: "wagers" },
      "?customer=BGD101&tab=rankings",
      "/",
    )
    expect(onWagers).toBe("tab=wagers")
    expect(onWagers).not.toContain("customer=")

    // Default Profiles view without explicit customer focus produces a clean URL
    const cleanHome = buildDashboardSearch(
      { ...DEFAULT_DASHBOARD_URL_STATE, customer: "" },
      "?customer=BGD101",
      "/",
    )
    expect(cleanHome).toBe("")
  })

  test("runBatchedRanking derives real volume, sport, net P&L, and full master/sub-agent downlines from the customer book", async () => {
    const result = await runBatchedRanking({ limitPlayers: 50 })
    expect(result.topPlayers.length).toBeGreaterThanOrEqual(5)

    // SYNTH_SYN_01 has lifetime_volume_usd=500000 in the fixture book (never hardcoded 25000)
    const synth01 = result.topPlayers.find((p) => p.customerId === "SYNTH_SYN_01")
    expect(synth01).toBeDefined()
    expect(synth01?.totalHandleUsd).toBe(500000)
    expect(synth01?.totalWagers).toBe(3)
    expect(synth01?.dominantSport).toBe("CFB")
    expect(synth01?.netUsd).toBe(-75000)
    expect(synth01?.giniCoefficient).toBeGreaterThan(0)

    // BGD101 is not stuck at rank 1 by handle because its fixture volume is $1
    expect(result.topPlayers[0]?.customerId).toBe("SYNTH_SYN_01")
    expect(result.topSubAgents.length).toBeGreaterThanOrEqual(4)
    expect(result.topMasterAgents.length).toBeGreaterThanOrEqual(2)
    expect(result.topMasterAgents[0]?.customerCount).toBeGreaterThanOrEqual(1)
  })

  test("normalizeRankingsResponse preserves subAgents and masterAgents rollups and buildDownlineForests assembles the hierarchy", async () => {
    const raw = await runBatchedRanking({ limitPlayers: 50 })
    const normalized = normalizeRankingsResponse(raw)
    expect(normalized).not.toBeNull()
    expect(normalized?.subAgents.length).toBe(raw.topSubAgents.length)
    expect(normalized?.masterAgents.length).toBe(raw.topMasterAgents.length)

    const forests = buildDownlineForests(
      normalized?.players ?? [],
      normalized?.subAgents ?? [],
      normalized?.masterAgents ?? [],
    )
    expect(forests.length).toBeGreaterThanOrEqual(2)
    const synthMaster = forests.find((f) => f.masterAgent === "SYNTH_MASTER_01")
    expect(synthMaster).toBeDefined()
    expect(synthMaster?.subAgents[0]?.agentId).toBe("SYNTH_AGENT_01")
    expect(synthMaster?.subAgents[0]?.players[0]?.id).toBe("SYNTH_SYN_01")

    const csv = buildDownlinesCsv(normalized?.players ?? [])
    expect(csv).toContain("rank,customer_id,sub_agent,master_forest")
    expect(csv).toContain("SYNTH_SYN_01,SYNTH_AGENT_01,SYNTH_MASTER_01,500000")
  })

  test("RankingsTabPanel renders dismissible customer focus bar, hierarchy explorer, and full downlines when focused on BGD101", async () => {
    const raw = await runBatchedRanking({ limitPlayers: 50 })
    const normalized = normalizeRankingsResponse(raw)
    expect(normalized).not.toBeNull()

    const html = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        onSelectAgent: () => {},
        onSelectCustomerById: () => {},
        focusedCustomerId: "BGD101",
        onFocusCustomer: () => {},
        onClearFocusedCustomer: () => {},
        rankings: normalized,
        rankingsStatus: "ready",
      }),
    )

    // Focused customer bar shows BGD101 lineage + clear control
    expect(html).toContain('data-downline-customer-focus="BGD101"')
    expect(html).toContain('data-downline-clear-focus="true"')
    expect(html).toContain("Clear Focus")
    expect(html).toContain("SYNTH_DUPLICATE_AGENT")

    // Full hierarchy explorer and other accounts remain accessible (never stuck on BGD101)
    expect(html).toContain('data-downlines-hierarchy="true"')
    expect(html).toContain('data-downlines-master-bar="true"')
    expect(html).toContain("SYNTH_SYN_01")
    expect(html).toContain("SYNTH_SNIPER_02")
    expect(html).toContain("PEY101")
    expect(html).toContain("Export to CSV")
  })
})
