import { describe, expect, test } from "bun:test"

import { evaluateRiskExposureThreshold } from "../../packages/ui/src/risk_threshold_alert.ts"
import { buildSharpestOnChainXrefReport } from "../../packages/ui/src/sharpest_onchain_xref.ts"
import type { DashboardTabId, LiveWager, ShowcaseCustomer } from "../../packages/ui/src/types.ts"
import {
  registerSportsDeskWebMcpTools,
  resolveBrowserModelContext,
  SPORTS_DESK_WEB_MCP_TOOL_NAMES,
  type SportsDeskWebMcpActions,
  type SportsDeskWebMcpSnapshot,
  type WebMcpModelContext,
  type WebMcpToolRegistration,
} from "../../packages/ui/src/web_mcp.ts"

function makeSampleWager(overrides: Partial<LiveWager> = {}): LiveWager {
  const nowIso = new Date().toISOString()
  return {
    ticketId: "TKT-9001",
    timestamp: nowIso,
    customerId: "SHARP_01",
    agentId: "AG_10",
    masterAgent: "MA_01",
    sport: "NBA",
    betType: "SPREAD",
    event: "Lakers @ Celtics",
    selection: "Celtics -4.5",
    lineDisplay: "-4.5",
    oddsAmerican: "-110",
    riskUsd: 18_500,
    toWinUsd: 16_818,
    clvCents: 2.4,
    alertTier: "CRITICAL",
    maxRecommendedStake: 10_000,
    ticketWriter: "MOBILE",
    ...overrides,
  }
}

function makeSampleCustomer(overrides: Partial<ShowcaseCustomer> = {}): ShowcaseCustomer {
  return {
    id: "SHARP_01",
    name: "Sharp Originator 01",
    agentId: "AG_10",
    masterAgent: "MA_01",
    tier: "TIER_1_SHARP",
    score: 8.7,
    clvScore: 3.1,
    holdPct: -4.2,
    ltvUsd: -42_000,
    syndicateRisk: "HIGH",
    correlatedRisk: "ELEVATED",
    syndicateProb: 0.78,
    var95Usd: 12_500,
    cvar95Usd: 18_000,
    recommendedLimitUsd: 5_000,
    action: "LIMIT_TO_5K",
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<SportsDeskWebMcpSnapshot> = {}): SportsDeskWebMcpSnapshot {
  const nowMs = Date.now()
  const wagers = overrides.liveWagers ?? [
    makeSampleWager({ ticketId: "TKT-9001", riskUsd: 18_500, sport: "NBA", alertTier: "CRITICAL" }),
    makeSampleWager({
      ticketId: "TKT-9002",
      customerId: "SHARP_02",
      riskUsd: 9_500,
      sport: "NFL",
      alertTier: "STEAM",
      event: "Chiefs @ Bills",
      selection: "Bills +2.5",
    }),
  ]
  const customers = overrides.profileCustomers ?? [
    makeSampleCustomer({ id: "SHARP_01", score: 8.7 }),
    makeSampleCustomer({ id: "SHARP_02", name: "Sharp Originator 02", score: 7.4 }),
  ]
  const thresholds = overrides.riskThresholds ?? {
    warningLimitUsd: 20_000,
    breachLimitUsd: 25_000,
  }
  const totalRiskUsd = wagers.reduce((sum, w) => sum + w.riskUsd, 0)
  const riskThresholdEvaluation =
    overrides.riskThresholdEvaluation ??
    evaluateRiskExposureThreshold(totalRiskUsd, thresholds.breachLimitUsd, {
      warningLimitUsd: thresholds.warningLimitUsd,
      hasData: wagers.length > 0,
    })

  return {
    activeTab: "risk-overview",
    hasLiveWagerSnapshot: true,
    liveWagers: wagers,
    profileCustomers: customers,
    alertRecords: [],
    riskThresholds: thresholds,
    riskThresholdEvaluation,
    rolling60mIncludedTickets: wagers.length,
    rolling60mAnchorMs: nowMs,
    sharpestOnChainXref: buildSharpestOnChainXrefReport({
      profiles: customers,
      rawGraphFeed: null,
      bridgeSnapshot: null,
    }),
    wsConnected: true,
    wsLastPongAt: new Date(nowMs - 2_000).toISOString(),
    wsLastSyncAt: nowMs - 2_000,
    wsLatencyMs: 34,
    wagersUpdatedAt: nowMs - 1_500,
    lastTelemetryProbeAt: new Date(nowMs - 1_500).toISOString(),
    ...overrides,
  }
}

function createFakeModelContext() {
  const tools = new Map<string, WebMcpToolRegistration>()
  const signals = new Map<string, AbortSignal | undefined>()
  const unregistered: string[] = []

  const modelContext: WebMcpModelContext = {
    registerTool(tool, options) {
      tools.set(tool.name, tool)
      signals.set(tool.name, options?.signal)
    },
    unregisterTool(name) {
      tools.delete(name)
      unregistered.push(name)
    },
  }

  return { modelContext, tools, signals, unregistered }
}

describe("WebMCP browser-native integration (packages/ui/src/web_mcp.ts)", () => {
  test("detects navigator.modelContext first, falls back to document.modelContext, and returns null when absent", () => {
    const navCtx = createFakeModelContext().modelContext
    const docCtx = createFakeModelContext().modelContext

    expect(
      resolveBrowserModelContext({
        navigator: { modelContext: navCtx },
        document: { modelContext: docCtx },
      }),
    ).toBe(navCtx)
    expect(resolveBrowserModelContext({ navigator: {}, document: { modelContext: docCtx } })).toBe(
      docCtx,
    )
    expect(resolveBrowserModelContext({ navigator: {}, document: {} })).toBeNull()
  })

  test("registers all 8 tools with AbortSignal and cleans up via abort + unregisterTool on teardown", () => {
    const { modelContext, tools, signals, unregistered } = createFakeModelContext()
    const actions: SportsDeskWebMcpActions = {
      setActiveTab: () => {},
      applyWagerFilters: () => {},
      focusCustomer: () => {},
      updateRiskThresholds: () => {},
      refreshTelemetry: () => {},
    }

    const handle = registerSportsDeskWebMcpTools(modelContext, () => makeSnapshot(), actions)
    expect(handle.supported).toBe(true)
    expect(handle.toolNames).toEqual([...SPORTS_DESK_WEB_MCP_TOOL_NAMES])
    expect(tools.size).toBe(SPORTS_DESK_WEB_MCP_TOOL_NAMES.length)

    for (const name of SPORTS_DESK_WEB_MCP_TOOL_NAMES) {
      const sig = signals.get(name)
      expect(sig).toBeDefined()
      expect(sig?.aborted).toBe(false)
    }

    handle.unregister()
    expect(tools.size).toBe(0)
    expect(unregistered).toEqual([...SPORTS_DESK_WEB_MCP_TOOL_NAMES])
    for (const name of SPORTS_DESK_WEB_MCP_TOOL_NAMES) {
      expect(signals.get(name)?.aborted).toBe(true)
    }
  })

  test("read-only tools return structured risk overview, recent alerts, filtered wagers, xref, and formula-safe CSV", async () => {
    const { modelContext, tools } = createFakeModelContext()
    const snapshot = makeSnapshot()
    const actions: SportsDeskWebMcpActions = {
      setActiveTab: () => {},
      applyWagerFilters: () => {},
      focusCustomer: () => {},
      updateRiskThresholds: () => {},
      refreshTelemetry: () => {},
    }
    registerSportsDeskWebMcpTools(modelContext, () => snapshot, actions)

    // 1. desk_get_risk_overview
    const overviewRes = await tools.get("desk_get_risk_overview")!.execute({})
    expect(overviewRes.isError).toBeUndefined()
    const overview = JSON.parse(overviewRes.content[0]!.text) as {
      riskThreshold: { status: string; totalRiskUsd: number; isBreached: boolean }
      wsSync: { state: string }
    }
    expect(overview.riskThreshold.status).toBe("breach")
    expect(overview.riskThreshold.totalRiskUsd).toBe(28_000)
    expect(overview.riskThreshold.isBreached).toBe(true)
    expect(overview.wsSync.state).toBe("stable")

    // 2. desk_list_recent_risk_alerts
    const alertsRes = await tools.get("desk_list_recent_risk_alerts")!.execute({
      severity: "BREACH",
      limit: 5,
    })
    expect(alertsRes.isError).toBeUndefined()
    const alerts = JSON.parse(alertsRes.content[0]!.text) as {
      severityFilter: string
      items: Array<{ severity: string; ticketId: string; totalPayoutUsd: number | null }>
    }
    expect(alerts.severityFilter).toBe("BREACH")
    expect(alerts.items.length).toBeGreaterThan(0)
    expect(alerts.items.every((item) => item.severity === "BREACH")).toBe(true)

    // 3. desk_search_live_wagers
    const wagersRes = await tools.get("desk_search_live_wagers")!.execute({
      sport: "NFL",
      minRiskUsd: 5_000,
    })
    const wagersData = JSON.parse(wagersRes.content[0]!.text) as {
      totalMatching: number
      wagers: Array<{ ticketId: string; sport: string }>
    }
    expect(wagersData.totalMatching).toBe(1)
    expect(wagersData.wagers[0]?.ticketId).toBe("TKT-9002")

    // 4. desk_get_sharpest_onchain_xref
    const xrefRes = await tools.get("desk_get_sharpest_onchain_xref")!.execute({
      status: "UNLINKED_SHARP",
    })
    const xrefData = JSON.parse(xrefRes.content[0]!.text) as {
      summary: { totalSharpProfiles: number }
      rows: Array<{ status: string }>
    }
    expect(xrefData.summary.totalSharpProfiles).toBe(2)
    expect(xrefData.rows.every((r) => r.status === "UNLINKED_SHARP")).toBe(true)

    // 5. desk_export_risk_csv
    const csvRes = await tools.get("desk_export_risk_csv")!.execute({ maxRows: 10 })
    const csvData = JSON.parse(csvRes.content[0]!.text) as {
      filename: string
      rowCount: number
      csv: string
    }
    expect(csvData.filename).toMatch(/^sportsdesk-risk-overview-breaches-\d{4}-\d{2}-\d{2}\.csv$/)
    expect(csvData.rowCount).toBe(2)
    expect(csvData.csv).toContain("SHARP_01")
  })

  test("mutating tools validate inputs fail-closed and honor ModelContextClient.requestUserInteraction approval", async () => {
    const { modelContext, tools } = createFakeModelContext()
    let navigatedTab: DashboardTabId | null = null
    let appliedSport: string | undefined
    let focusedCustomer: string | null = null
    let savedThresholds: { warningLimitUsd: number; breachLimitUsd: number } | null = null
    let refreshedCount = 0

    const actions: SportsDeskWebMcpActions = {
      setActiveTab: (tab) => {
        navigatedTab = tab
      },
      applyWagerFilters: (f) => {
        appliedSport = f.sport
      },
      focusCustomer: (id) => {
        focusedCustomer = id
      },
      updateRiskThresholds: (next) => {
        savedThresholds = next
      },
      refreshTelemetry: () => {
        refreshedCount += 1
      },
    }
    registerSportsDeskWebMcpTools(modelContext, () => makeSnapshot(), actions)

    // Reject unknown tab
    const badNav = await tools.get("desk_navigate_view")!.execute({ tab: "nonexistent-tab" })
    expect(badNav.isError).toBe(true)
    expect(navigatedTab).toBeNull()

    // Valid navigation
    const goodNav = await tools.get("desk_navigate_view")!.execute({
      tab: "wagers",
      sport: "NBA",
      customerId: "sharp_01",
    })
    expect(goodNav.isError).toBeUndefined()
    expect(navigatedTab).toBe("wagers")
    expect(appliedSport).toBe("NBA")
    expect(focusedCustomer).toBe("SHARP_01")

    // Invalid threshold pair (warning >= breach) fails closed
    const badThresh = await tools.get("desk_set_risk_thresholds")!.execute({
      warningLimitUsd: 40_000,
      breachLimitUsd: 30_000,
    })
    expect(badThresh.isError).toBe(true)
    expect(savedThresholds).toBeNull()

    // Cancelled operator confirmation blocks mutation
    const cancelledThresh = await tools
      .get("desk_set_risk_thresholds")!
      .execute(
        { warningLimitUsd: 35_000, breachLimitUsd: 50_000 },
        { requestUserInteraction: async () => false as never },
      )
    expect(cancelledThresh.isError).toBe(true)
    expect(savedThresholds).toBeNull()

    // Approved operator confirmation persists mutation
    const approvedThresh = await tools
      .get("desk_set_risk_thresholds")!
      .execute(
        { warningLimitUsd: 35_000, breachLimitUsd: 50_000 },
        { requestUserInteraction: async (cb) => cb() },
      )
    expect(approvedThresh.isError).toBeUndefined()
    expect(savedThresholds).toEqual({ warningLimitUsd: 35_000, breachLimitUsd: 50_000 })

    // Telemetry refresh
    const refreshRes = await tools.get("desk_refresh_telemetry")!.execute({})
    expect(refreshRes.isError).toBeUndefined()
    expect(refreshedCount).toBe(1)
  })
})
