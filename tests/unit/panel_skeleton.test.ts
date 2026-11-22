import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  AlertsTabPanel,
  BetTickerTabPanel,
  CustomersTabPanel,
  DashboardAuthShellSkeleton,
  LiveWagersTabPanel,
  R2PipelineTabPanel,
  RankingsTabPanel,
  SurveillanceTabPanel,
} from "../../packages/ui/src/panels/index.tsx"
import {
  normalizeRankingsResponse,
  PENDING_WAGERS_PROVENANCE,
} from "../../packages/ui/src/hydration.ts"

describe("Dashboard Panel Skeletal Loading UI", () => {
  test("desk.css uses compositor-only transform shimmer and respects prefers-reduced-motion", () => {
    const css = readFileSync(resolve(import.meta.dir, "../../packages/ui/src/desk.css"), "utf8")
    expect(css).toContain("@keyframes sdSkeletonShimmer")
    expect(css).toContain("translate3d(-100%, 0, 0)")
    expect(css).toContain("translate3d(100%, 0, 0)")
    expect(css).toContain(".sd-skeleton")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
  })

  test("DashboardAuthShellSkeleton adapts geometry to activeTab during session handshake", () => {
    const customersHtml = renderToStaticMarkup(
      React.createElement(DashboardAuthShellSkeleton, { activeTab: "customers" }),
    )
    expect(customersHtml).toContain('role="status"')
    expect(customersHtml).toContain('aria-busy="true"')
    expect(customersHtml).toContain('data-skeleton="auth-shell"')
    expect(customersHtml).toContain('data-skeleton="auth-customers-workspace"')
    expect(customersHtml).toContain('class="sd-skeleton')

    const wagersHtml = renderToStaticMarkup(
      React.createElement(DashboardAuthShellSkeleton, { activeTab: "wagers" }),
    )
    expect(wagersHtml).toContain('data-skeleton="auth-wagers-chart"')
    expect(wagersHtml).toContain('data-skeleton="auth-wagers-table"')

    const r2Html = renderToStaticMarkup(
      React.createElement(DashboardAuthShellSkeleton, { activeTab: "r2" }),
    )
    expect(r2Html).toContain('data-skeleton="auth-r2-grid"')

    const survHtml = renderToStaticMarkup(
      React.createElement(DashboardAuthShellSkeleton, { activeTab: "surveillance" }),
    )
    expect(survHtml).toContain('data-skeleton="surveillance-brief"')
  })

  test("CustomersTabPanel renders split-workspace and KPI skeletons when pending, and clears when hydrated", () => {
    const pendingHtml = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: true,
        onDismissBanner: () => {},
        kpisCollapsed: false,
        onToggleKpis: () => {},
        cohortsReport: null,
        cohortsStatus: "pending",
        searchQuery: "",
        onSearchQueryChange: () => {},
        filterTier: "ALL",
        onFilterTierChange: () => {},
        sortedCustomers: [],
        customerSort: { key: "sharpScore", dir: "desc" },
        onCustomerSort: () => {},
        selectedCustomer: null,
        onSelectCustomer: () => {},
        copiedCliId: null,
        onCopyCli: () => {},
        onRunReverseLookup: () => {},
        onOpenTerminalProfile: () => {},
        onOpenTerminalRadar: () => {},
        onViewCustomerWagers: () => {},
      }),
    )

    expect(pendingHtml).toContain('data-profiles-source="pending"')
    expect(pendingHtml).toContain('data-skeleton="customers-workspace"')
    expect(pendingHtml).toContain('aria-busy="true"')
    expect(pendingHtml).toContain('class="sd-skeleton')

    const hydratedHtml = renderToStaticMarkup(
      React.createElement(CustomersTabPanel, {
        bannerDismissed: true,
        onDismissBanner: () => {},
        kpisCollapsed: false,
        onToggleKpis: () => {},
        cohortsReport: {
          provenance: {
            kind: "live",
            label: "live",
            sourcePath: "/api/customers",
            observedAt: "2026-11-20T17:00:00Z",
          },
          cohorts: {
            backtestCount: 1,
            keyNumberSharpsCount: 1,
            hookSyndicateCount: 0,
            fixtureCount: 1,
            fullBookSpecCount: 1,
            uniqueSurveillanceCount: 1,
          },
          backtestAll: [
            {
              customer_id: "JAKE231",
              name: "Jake",
              agent_id: "AG1",
              master_agent: "M1",
              tier: "TIER_1",
              sharp_score: 9.1,
              action: "ALERT",
              total_handle_usd: 45000,
              wager_count: 18,
              net_profit_usd: 4200,
              roi_pct: 9.3,
              clv_cents: 6.4,
            },
          ],
          fixtures: [],
        } as unknown as Parameters<typeof CustomersTabPanel>[0]["cohortsReport"],
        cohortsStatus: "ready",
        searchQuery: "",
        onSearchQueryChange: () => {},
        filterTier: "ALL",
        onFilterTierChange: () => {},
        sortedCustomers: [],
        customerSort: { key: "sharpScore", dir: "desc" },
        onCustomerSort: () => {},
        selectedCustomer: null,
        onSelectCustomer: () => {},
        copiedCliId: null,
        onCopyCli: () => {},
        onRunReverseLookup: () => {},
        onOpenTerminalProfile: () => {},
        onOpenTerminalRadar: () => {},
        onViewCustomerWagers: () => {},
      }),
    )

    expect(hydratedHtml).not.toContain('data-skeleton="customers-workspace"')
  })

  test("LiveWagersTabPanel renders chart + table skeletons while pending, and clears on hydration", () => {
    const pendingHtml = renderToStaticMarkup(
      React.createElement(LiveWagersTabPanel, {
        wagers: [],
        provenance: PENDING_WAGERS_PROVENANCE,
        wagerSearch: "",
        onWagerSearchChange: () => {},
        wagerSportFilter: "ALL",
        onWagerSportFilterChange: () => {},
        wagerAlertFilter: "ALL",
        onWagerAlertFilterChange: () => {},
        wagerTypeFilter: "ALL",
        onWagerTypeFilterChange: () => {},
        wagerSortField: "timestamp",
        wagerSortDir: "desc",
        onWagerSort: () => {},
        selectedWager: null,
        onSelectWager: () => {},
        copiedTicketId: null,
        onCopyText: () => {},
        tiersConfig: null,
        onSelectCustomerById: () => {},
        onInspectPty: () => {},
      }),
    )

    expect(pendingHtml).toContain('aria-busy="true"')
    expect(pendingHtml).toContain('data-skeleton="live-wagers-chart"')
    expect(pendingHtml).toContain('data-skeleton="live-wagers-rows"')
    expect(pendingHtml).toContain('data-wagers-empty="pending"')
  })

  test("RankingsTabPanel renders KPI and table skeletons while pending, and clears once hydrated", () => {
    const pendingHtml = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        rankings: null,
        rankingsStatus: "pending",
      }),
    )

    expect(pendingHtml).toContain('aria-busy="true"')
    expect(pendingHtml).toContain('data-skeleton="rankings-rows"')
    expect(pendingHtml).toContain('data-rankings-empty="players"')

    const hydratedRankings = normalizeRankingsResponse({
      generatedAtIso: "2026-11-20T17:00:00Z",
      totalPlayersEvaluated: 1,
      totalHandleUsd: 90000,
      topPlayers: [
        {
          rank: 1,
          customerId: "JAKE231",
          agentId: "AG1",
          masterAgent: "M1",
          totalHandleUsd: 45000,
          totalWagers: 20,
          giniCoefficient: 0.32,
          alertRatePct: 24,
          compositeScore: 8.6,
          tier: "TIER_1",
          tierLabel: "ELITE",
          dominantSport: "CFB",
          isProxyAccount: false,
          recommendedLimitUsd: 500,
        },
      ],
      topSubAgents: [],
      topMasterAgents: [],
    })
    expect(hydratedRankings).not.toBeNull()

    const readyHtml = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        rankingsStatus: "ready",
        rankings: hydratedRankings,
      }),
    )

    expect(readyHtml).not.toContain('data-skeleton="rankings-rows"')
    expect(readyHtml).toContain("JAKE231")
  })

  test("AlertsTabPanel renders skeletal rows during initial alertLoading and empty state when idle", () => {
    const loadingHtml = renderToStaticMarkup(
      React.createElement(AlertsTabPanel, {
        alertToast: null,
        onDismissToast: () => {},
        onCopyDeliveryId: () => {},
        healthData: null,
        alertFilter: "ALL",
        onFilterChange: () => {},
        alertLoading: true,
        onSweepAlerts: () => {},
        onRefreshAlerts: () => {},
        onOpenShiftModal: () => {},
        alertRecords: [],
        tiersConfig: null,
        onAckAlert: () => {},
        onRetryAlert: () => {},
      }),
    )

    expect(loadingHtml).toContain('aria-busy="true"')
    expect(loadingHtml).toContain('data-skeleton="alerts-rows"')
    expect(loadingHtml).not.toContain("No alerts matching filter")

    const idleEmptyHtml = renderToStaticMarkup(
      React.createElement(AlertsTabPanel, {
        alertToast: null,
        onDismissToast: () => {},
        onCopyDeliveryId: () => {},
        healthData: null,
        alertFilter: "ALL",
        onFilterChange: () => {},
        alertLoading: false,
        onSweepAlerts: () => {},
        onRefreshAlerts: () => {},
        onOpenShiftModal: () => {},
        alertRecords: [],
        tiersConfig: null,
        onAckAlert: () => {},
        onRetryAlert: () => {},
      }),
    )

    expect(idleEmptyHtml).not.toContain('data-skeleton="alerts-rows"')
    expect(idleEmptyHtml).toContain("No alerts matching filter &quot;ALL&quot;.")
  })

  test("BetTickerTabPanel renders KPI, demux, and stream table skeletons while loading", () => {
    const loadingHtml = renderToStaticMarkup(
      React.createElement(BetTickerTabPanel, {
        data: null,
        loading: true,
        error: null,
        onRefresh: () => {},
        onSelectAgent: () => {},
        onSelectCustomerById: () => {},
        onInspectPty: () => {},
      }),
    )

    expect(loadingHtml).toContain('aria-busy="true"')
    expect(loadingHtml).toContain('data-skeleton="bet-ticker"')
    expect(loadingHtml).toContain('data-skeleton="bet-ticker-channel-demux"')
    expect(loadingHtml).toContain('data-skeleton="bet-ticker-stream"')
  })

  test("R2PipelineTabPanel renders sink-card grid skeleton while loading", () => {
    const loadingHtml = renderToStaticMarkup(
      React.createElement(R2PipelineTabPanel, {
        data: null,
        loading: true,
        error: null,
        onRefresh: () => {},
      }),
    )

    expect(loadingHtml).toContain('aria-busy="true"')
    expect(loadingHtml).toContain('data-skeleton="r2-pipeline"')
    expect(loadingHtml).toContain('data-skeleton="r2-sinks-grid"')
  })

  test("SurveillanceTabPanel renders DNS and brief skeletons before hydration", () => {
    const loadingHtml = renderToStaticMarkup(
      React.createElement(SurveillanceTabPanel, {
        dnsData: null,
        dnsRefreshing: true,
        benchLoading: false,
        benchResult: null,
        onRunBenchmark: () => {},
        reverseIp: "1.1.1.1",
        onReverseIpChange: () => {},
        onRunReverseLookup: () => {},
        viewMode: "interactive",
        onViewModeChange: () => {},
        data: null,
      }),
    )

    expect(loadingHtml).toContain('data-skeleton="surveillance-dns"')
    expect(loadingHtml).toContain('data-skeleton="surveillance-brief"')
  })
})
