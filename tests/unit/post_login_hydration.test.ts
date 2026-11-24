import { afterEach, describe, expect, test } from "bun:test"

import { createHttpAuthController } from "../../lib/http_auth.ts"
import { createDashboardApi } from "../../packages/api/src/router.ts"
import { resetApiUsage, setDevCsrfToken, setDevSessionToken, trackedFetch } from "../../packages/ui/src/api_usage.ts"
import {
  fetchRankingsSlice,
  hydrateDashboardFeeds,
  normalizeRankingsResponse,
} from "../../packages/ui/src/hydration.ts"

describe("Post-Login Hydration & Rankings Normalization", () => {
  const originalFetch = globalThis.fetch
  const originalSessionStorage = (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage

  afterEach(() => {
    globalThis.fetch = originalFetch
    setDevSessionToken(null)
    setDevCsrfToken(null)
    resetApiUsage()
    ;(globalThis as unknown as { sessionStorage?: unknown }).sessionStorage = originalSessionStorage
  })

  test("normalizeRankingsResponse accepts live BatchedRankingResult (topPlayers) shape", () => {
    const normalized = normalizeRankingsResponse({
      generatedAtIso: "2026-11-20T17:18:51.367Z",
      totalPlayersEvaluated: 6,
      totalHandleUsd: 150000,
      topPlayers: [
        {
          rank: 1,
          customerId: "SYNTH_SYN_01",
          agentId: "SYNTH_AGENT_01",
          masterAgent: "SYNTH_MASTER_01",
          totalHandleUsd: 25000,
          totalWagers: 40,
          giniCoefficient: 0.35,
          alertRatePct: 33.5,
          compositeScore: 5.15,
          tier: "TIER_4_SEMI_SHARP",
          tierLabel: "SEMI SHARP",
          dominantSport: "Football",
          isProxyAccount: false,
          recommendedLimitUsd: 2500,
        },
      ],
      topSubAgents: [
        {
          agentId: "SYNTH_AGENT_01",
          masterAgent: "SYNTH_MASTER_01",
          totalHandleUsd: 150000,
          totalWagers: 240,
          customerCount: 6,
          topCustomer: "SYNTH_SYN_01",
          topCustomerConcentrationPct: 85.0,
          isProxyConduit: true,
        },
      ],
      topMasterAgents: [
        {
          masterAgent: "SYNTH_MASTER_01",
          subAgentCount: 1,
          totalHandleUsd: 150000,
          totalWagers: 240,
        },
      ],
    })

    expect(normalized).not.toBeNull()
    expect(normalized?.players.length).toBe(1)
    expect(normalized?.players[0]?.id).toBe("SYNTH_SYN_01")
    expect(normalized?.players[0]?.handleUsd).toBe(25000)
    expect(normalized?.players[0]?.gini).toBe(0.35)
    expect(normalized?.conduits.length).toBe(1)
    expect(normalized?.summary.activeCustomerCount).toBe(6)
    expect(normalized?.summary.inWindowWagers).toBe(240)
    expect(normalized?.summary.activeMasterAgentCount).toBe(1)
    expect(normalized?.summary.conduitSubAgentCount).toBe(1)
  })

  test("normalizeRankingsResponse retains compatibility with legacy topRankedPlayers shape", () => {
    const normalized = normalizeRankingsResponse({
      generatedAtIso: "2026-11-20T12:00:00Z",
      windowStart: "2026-10-21",
      windowEnd: "2026-11-20",
      inWindowWagers: 120,
      totalHandleUsd: 90000,
      totalToWinUsd: 82000,
      activeCustomerCount: 12,
      activeSubAgentCount: 3,
      activeMasterAgentCount: 1,
      conduitSubAgentCount: 1,
      topRankedPlayers: [
        {
          rank: 1,
          customerId: "JAKE231",
          agentId: "AG1",
          masterAgent: "M1",
          handleUsd: 45000,
          totalWagers: 50,
          stakeGini: 0.42,
          alertRatePct: 24,
          compositeScore: 8.6,
          tier: "TIER_1",
          tierLabel: "ELITE",
          dominantSport: "CFB",
          isProxyConduit: false,
          recommendedLimitUsd: 500,
        },
      ],
      topSubAgents: [],
    })

    expect(normalized).not.toBeNull()
    expect(normalized?.summary.windowStart).toBe("2026-10-21")
    expect(normalized?.summary.inWindowWagers).toBe(120)
    expect(normalized?.players[0]?.id).toBe("JAKE231")
  })

  test("trackedFetch hydrates wagers, customers, tiers, and rankings after devQuickLogin token is stored", async () => {
    const store = new Map<string, string>()
    ;(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
      get length() {
        return store.size
      },
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      removeItem: (k: string) => {
        store.delete(k)
      },
      setItem: (k: string, v: string) => {
        store.set(k, v)
      },
    }

    const env = {
      NODE_ENV: "development",
      SPORTSDESK_DEV_SERVER: "1",
    }
    const auth = createHttpAuthController({ env })
    const api = createDashboardApi({
      enforceAuth: (req) => auth.enforceAuth(req),
      env,
      auth: auth.auth,
      getHealthPayload: () => ({ status: "ok" }),
      loadDashboardMarkdown: async () => ({
        stamp: "1",
        markdown: "# Desk",
        html: "<h1>Desk</h1>",
      }),
      dns: {
        getTelemetryPayload: () => ({ success: true }),
        benchmark: async (host) => ({ host }),
        classifyIp: async (ip) => ({ ip }),
      },
      customers: {
        getCohortReport: async () => ({
          versionStamp: "1",
          payload: {
            cohorts: {
              backtestCount: 1,
              keyNumberSharpsCount: 1,
              hookSyndicateCount: 0,
              fixtureCount: 1,
              fullBookSpecCount: 1,
              uniqueSurveillanceCount: 2,
            },
            backtestAll: [{ customer_id: "JAKE231", sharp_score: 8.8 }],
            fixtures: [{ customer_id: "SYNTH_01", sharp_score: 7.4 }],
          },
        }),
        getProfile: async () => null,
        getRating: async () => null,
      },
      execTerminal: async () => ({}),
      rankings: {
        getAll: async () => ({
          generatedAtIso: "2026-11-20T17:00:00Z",
          payload: {
            generatedAtIso: "2026-11-20T17:00:00Z",
            totalPlayersEvaluated: 1,
            totalHandleUsd: 25000,
            topPlayers: [
              {
                rank: 1,
                customerId: "JAKE231",
                agentId: "AG01",
                masterAgent: "M01",
                totalHandleUsd: 25000,
                totalWagers: 20,
                giniCoefficient: 0.3,
                alertRatePct: 20,
                compositeScore: 8.8,
                tier: "TIER_1",
                tierLabel: "ELITE",
                dominantSport: "CFB",
                isProxyAccount: false,
                recommendedLimitUsd: 500,
              },
            ],
            topSubAgents: [],
            topMasterAgents: [],
          },
        }),
        getConduits: async () => [],
      },
      getLiveWagersPayload: async () => ({
        wagers: [{ ticketId: "T-100", customerId: "JAKE231", riskUsd: 500, toWinUsd: 455 }],
      }),
      getTiersConfig: async () => ({
        tiers: { TIER_1: { label: "ELITE", color: "#ef4444" } },
      }),
      alerts: {
        sweepOnce: async () => ({}),
        list: () => [],
        ack: async () => false,
        retry: async () => null,
        getShiftSummary: () => ({}),
      },
      getTaxonomyCatalog: () => [],
      runShadowPricing: async () => ({}),
      getBuildMatrix: async () => ({ targets: [], generatedAt: "" }),
    })

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const absUrl = rawUrl.startsWith("http") ? rawUrl : `http://127.0.0.1:3000${rawUrl}`
      return api.fetch(new Request(absUrl, init))
    }) as typeof fetch

    // 1. Before login, feeds fail closed with 401
    const preLogin = await hydrateDashboardFeeds(trackedFetch)
    expect(preLogin.wagers.ok).toBe(false)
    expect(preLogin.customers.ok).toBe(false)

    // 2. Simulate devQuickLogin storing devSessionToken + csrfToken
    const loginRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          devQuickLogin: true,
          role: "ADMIN",
          operatorId: "dev-admin",
        }),
      }),
    )
    const loginJson = (await loginRes.json()) as {
      devSessionToken: string
      csrfToken: string
    }
    expect(loginRes.status).toBe(200)
    setDevSessionToken(loginJson.devSessionToken)
    setDevCsrfToken(loginJson.csrfToken)

    // 3. Post-login hydration succeeds across all slices
    const [postLogin, rankingsSlice] = await Promise.all([
      hydrateDashboardFeeds(trackedFetch),
      fetchRankingsSlice(trackedFetch),
    ])
    expect(postLogin.wagers.ok).toBe(true)
    expect(postLogin.customers.ok).toBe(true)
    expect(postLogin.tiers.ok).toBe(true)
    expect(rankingsSlice.ok).toBe(true)
    if (postLogin.customers.ok) {
      expect(postLogin.customers.data.cohorts.uniqueSurveillanceCount).toBe(2)
    }
    if (rankingsSlice.ok) {
      expect(rankingsSlice.data.players.length).toBe(1)
    }
  })
})
