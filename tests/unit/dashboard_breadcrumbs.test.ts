import { describe, expect, test } from "bun:test"

import {
  buildDashboardBreadcrumbs,
  getSectionForTab,
  resolveParentBreadcrumb,
  ROOT_DASHBOARD_TAB,
} from "../../packages/ui/src/panels/DashboardBreadcrumbs.tsx"
import { DASHBOARD_TAB_IDS } from "../../packages/ui/src/types.ts"

describe("DashboardBreadcrumbs — Hierarchy & Parent Navigation", () => {
  test("maps every DashboardTabId to a valid section and produces an accessible trail", () => {
    for (const tabId of DASHBOARD_TAB_IDS) {
      const section = getSectionForTab(tabId)
      expect(section.label.length).toBeGreaterThan(0)

      const trail = buildDashboardBreadcrumbs({ activeTab: tabId })
      expect(trail.length).toBeGreaterThanOrEqual(3)
      expect(trail[0]?.label).toBe("Dashboard")
      expect(trail[0]?.isRoot).toBe(true)
      expect(trail[1]?.label).toBe(section.label)
      expect(trail[trail.length - 1]?.isCurrent).toBe(true)
      // Exactly one crumb has isCurrent === true
      expect(trail.filter((item) => item.isCurrent)).toHaveLength(1)
    }
  })

  test("root landing (risk-overview) has no redundant parent up-action", () => {
    const trail = buildDashboardBreadcrumbs({ activeTab: ROOT_DASHBOARD_TAB })
    expect(trail.map((t) => t.label)).toEqual(["Dashboard", "Risk & Exposure", "Risk Overview"])
    expect(resolveParentBreadcrumb(trail)).toBeNull()
  })

  test("child tabs navigate up to their parent section landing tab", () => {
    const downlinesTrail = buildDashboardBreadcrumbs({ activeTab: "rankings" })
    expect(downlinesTrail.map((t) => t.label)).toEqual(["Dashboard", "Bettor Intelligence", "Downlines"])
    const parent = resolveParentBreadcrumb(downlinesTrail)
    expect(parent?.label).toBe("Bettor Intelligence")
    expect(parent?.action).toEqual({
      kind: "navigate-tab",
      tab: "customers",
      clearContext: true,
    })

    const r2Trail = buildDashboardBreadcrumbs({ activeTab: "r2" })
    expect(r2Trail.map((t) => t.label)).toEqual(["Dashboard", "Platform & Infrastructure", "R2 Pipeline"])
    expect(resolveParentBreadcrumb(r2Trail)?.action).toEqual({
      kind: "navigate-tab",
      tab: "status-dashboard",
      clearContext: true,
    })
  })

  test("nested customer inspection & wager ticket/filter crumbs support step-by-step parent navigation", () => {
    const customerTrail = buildDashboardBreadcrumbs({
      activeTab: "customers",
      customerTierFilter: "SHARP",
      selectedCustomerId: "RF2003",
    })
    expect(customerTrail.map((t) => t.label)).toEqual([
      "Dashboard",
      "Bettor Intelligence",
      "Profiles",
      "Tier: SHARP",
      "RF2003",
    ])
    expect(customerTrail[4]?.isCurrent).toBe(true)
    // Immediate parent of RF2003 is "Tier: SHARP", which clears customer selection while keeping tier
    expect(resolveParentBreadcrumb(customerTrail)?.label).toBe("Tier: SHARP")
    expect(resolveParentBreadcrumb(customerTrail)?.action).toEqual({ kind: "clear-customer" })
    // Clicking "Profiles" clears all customer context on the tab
    expect(customerTrail[2]?.action).toEqual({
      kind: "navigate-tab",
      tab: "customers",
      clearContext: true,
    })

    const wagerTrail = buildDashboardBreadcrumbs({
      activeTab: "wagers",
      wagerChannelFilter: "GSLIVE",
      wagerSportFilter: "NBA",
      selectedWagerTicketId: "99412",
    })
    expect(wagerTrail.map((t) => t.label)).toEqual([
      "Dashboard",
      "Risk & Exposure",
      "Live Wagers",
      "GSLIVE · NBA",
      "Ticket #99412",
    ])
    expect(resolveParentBreadcrumb(wagerTrail)?.label).toBe("GSLIVE · NBA")
    expect(resolveParentBreadcrumb(wagerTrail)?.action).toEqual({ kind: "clear-wager" })
  })

  test("agent, alert filter, and log severity sub-crumbs resolve back to their parent tab", () => {
    const agentTrail = buildDashboardBreadcrumbs({
      activeTab: "rankings",
      selectedAgentId: "BIGDAD",
    })
    expect(agentTrail.map((t) => t.label)).toEqual(["Dashboard", "Bettor Intelligence", "Downlines", "Agent BIGDAD"])
    expect(resolveParentBreadcrumb(agentTrail)?.label).toBe("Downlines")

    const alertsTrail = buildDashboardBreadcrumbs({
      activeTab: "alerts",
      alertFilter: "FAILED",
    })
    expect(alertsTrail.map((t) => t.label)).toEqual(["Dashboard", "Operations & Telemetry", "DLQ & Alerts", "FAILED"])
    expect(resolveParentBreadcrumb(alertsTrail)?.label).toBe("DLQ & Alerts")

    const logsTrail = buildDashboardBreadcrumbs({
      activeTab: "system-logs",
      systemLogSeverityFilter: "CRITICAL",
    })
    expect(logsTrail.map((t) => t.label)).toEqual(["Dashboard", "Operations & Telemetry", "System Logs", "CRITICAL"])
    expect(resolveParentBreadcrumb(logsTrail)?.label).toBe("System Logs")
  })

  test("attaches canonical hashed hrefs and supports all 7 SoA Discovery Dimensions in breadcrumbs", async () => {
    const {
      buildAbsoluteDiscoveryPermalink,
      buildCanonicalDashboardHref,
      computeBurstinessIndex,
      computeConditionalIntensityRatio,
      computeHypergeometricLift,
      computeLeadLagIndex,
      computeLiveExecutableDeltaBps,
      DISCOVERY_DIMENSION_IDS,
      DISCOVERY_DIMENSIONS,
      parseDashboardHash,
      resolveDiscoveryDimensionId,
      serializeDashboardHash,
    } = await import("../../packages/ui/src/discovery_hash.ts")
    const { buildDashboardSearch, readDashboardUrlState, writeDashboardUrl } =
      await import("../../packages/ui/src/url_state.ts")

    expect(DISCOVERY_DIMENSION_IDS).toEqual([
      "directional-asymmetry",
      "exogenous-conditioning",
      "information-flow",
      "timing-regularity",
      "null-model-significance",
      "live-realized-net-spread",
      "topology-discovery",
    ])

    // Alias resolution for concise CLI/hash links
    expect(resolveDiscoveryDimensionId("a_ij")).toBe("directional-asymmetry")
    expect(resolveDiscoveryDimensionId("lambda")).toBe("exogenous-conditioning")
    expect(resolveDiscoveryDimensionId("te")).toBe("information-flow")
    expect(resolveDiscoveryDimensionId("fano")).toBe("timing-regularity")
    expect(resolveDiscoveryDimensionId("lift")).toBe("null-model-significance")
    expect(resolveDiscoveryDimensionId("delta_exec")).toBe("live-realized-net-spread")
    expect(resolveDiscoveryDimensionId("csr")).toBe("topology-discovery")

    // Breadcrumb trail with nested customer + Discovery Dimension
    const trail = buildDashboardBreadcrumbs({
      activeTab: "customers",
      customerTierFilter: "SHARP",
      selectedCustomerId: "RF2003",
      discoveryDimension: "directional-asymmetry",
    })
    expect(trail.map((t) => t.label)).toEqual([
      "Dashboard",
      "Bettor Intelligence",
      "Profiles",
      "Tier: SHARP",
      "RF2003",
      "Directional Asymmetry",
    ])
    expect(trail[5]?.isCurrent).toBe(true)
    expect(trail[5]?.badge).toBe(DISCOVERY_DIMENSIONS["directional-asymmetry"].symbol)
    expect(trail[5]?.hashFragment).toBe(
      "#/bettor-intelligence/customers/tier:SHARP/customer:RF2003/dim:directional-asymmetry",
    )
    expect(trail[5]?.href).toBe(
      "?tab=customers&customer=RF2003&dim=directional-asymmetry#/bettor-intelligence/customers/tier:SHARP/customer:RF2003/dim:directional-asymmetry",
    )
    // Stepping up from the Discovery Dimension returns to RF2003 and clears only the dimension
    const parent = resolveParentBreadcrumb(trail)
    expect(parent?.label).toBe("RF2003")
    expect(parent?.action).toEqual({ kind: "clear-discovery-dimension" })
    expect(parent?.hashFragment).toBe("#/bettor-intelligence/customers/tier:SHARP/customer:RF2003")

    // Round-trip structured hash with ROT + pairwise accounts + dimension
    const complexHash = serializeDashboardHash({
      activeTab: "wagers",
      wagerChannelFilter: "GSLIVE",
      wagerSportFilter: "NBA",
      selectedWagerTicketId: "99412",
      rotId: "501",
      entityPair: ["RF2003", "BGD101"],
      discoveryDimension: "exogenous-conditioning",
    })
    expect(complexHash).toBe(
      "#/risk-exposure/wagers/ch:GSLIVE/sport:NBA/ticket:99412/rot:501/pair:RF2003~BGD101/dim:exogenous-conditioning",
    )
    const parsedComplex = parseDashboardHash(complexHash)
    expect(parsedComplex).toMatchObject({
      isStructured: true,
      sectionId: "risk-exposure",
      tab: "wagers",
      wagerChannelFilter: "GSLIVE",
      wagerSportFilter: "NBA",
      selectedWagerTicketId: "99412",
      rotId: "501",
      entityPair: ["RF2003", "BGD101"],
      discoveryDimension: "exogenous-conditioning",
    })

    // Legacy flat hash remains supported
    const parsedLegacy = parseDashboardHash("#wagers")
    expect(parsedLegacy?.isStructured).toBe(false)
    expect(parsedLegacy?.tab).toBe("wagers")
    expect(parsedLegacy?.sectionId).toBe("risk-exposure")

    // Absolute permalink preserves loopback apiBase
    const permalink = buildAbsoluteDiscoveryPermalink(
      {
        activeTab: "shadow",
        discoveryDimension: "live-realized-net-spread",
      },
      {
        origin: "https://ops.example.com",
        pathname: "/app",
        search: "?apiBase=http://127.0.0.1:4021",
      },
    )
    expect(permalink).toBe(
      "https://ops.example.com/app?tab=shadow&dim=live-realized-net-spread&apiBase=http%3A%2F%2F127.0.0.1%3A4021#/risk-exposure/shadow/dim:live-realized-net-spread",
    )
    expect(buildCanonicalDashboardHref({ activeTab: "risk-overview" })).toBe(
      "?tab=risk-overview#/risk-exposure/risk-overview",
    )

    // URL state reads structured hash & writes optional canonical hash cleanly
    const fromHash = readDashboardUrlState(
      "",
      "/",
      "#/bettor-intelligence/customers/customer:RF2003/dim:information-flow",
    )
    expect(fromHash.tab).toBe("customers")
    expect(fromHash.customer).toBe("RF2003")
    expect(fromHash.discovery).toBe("information-flow")
    expect(buildDashboardSearch(fromHash, "", "/")).toBe("customer=RF2003&dim=information-flow")

    let pushed: string | null = null
    const wrote = writeDashboardUrl(
      fromHash,
      {
        location: {
          origin: "https://ops.example.com",
          href: "https://ops.example.com/",
          pathname: "/",
          search: "",
          hash: "",
        },
        history: {
          replaceState: () => {},
          pushState: (_d, _u, url) => {
            pushed = url
          },
        },
      },
      {
        push: true,
        hash: "#/bettor-intelligence/customers/customer:RF2003/dim:information-flow",
      },
    )
    expect(wrote).toBe(true)
    expect(pushed).toBe(
      "/?customer=RF2003&dim=information-flow#/bettor-intelligence/customers/customer:RF2003/dim:information-flow",
    )

    // Pure SoA estimator math verification
    const leadLag = computeLeadLagIndex(new Float64Array([100, 200, 300, -50, 400]))
    expect(leadLag.aij).toBeCloseTo(0.6, 5)
    expect(leadLag.p50Ms).toBe(200)
    expect(leadLag.iqrMs).toBe(200)

    const periodic = computeBurstinessIndex(new Float64Array([1000, 1000, 1000, 1000]))
    expect(periodic.bij).toBeCloseTo(-1, 5)
    expect(periodic.fanoFactor).toBe(0)

    const lift = computeHypergeometricLift(12, 20, 30, 100)
    expect(lift.expected).toBeCloseTo(6, 5)
    expect(lift.lift).toBeCloseTo(2, 5)

    expect(computeConditionalIntensityRatio(0.45, 0.09)).toBeCloseTo(5, 5)
    expect(computeLiveExecutableDeltaBps(145, 32, 18)).toBe(95)
  })
})
