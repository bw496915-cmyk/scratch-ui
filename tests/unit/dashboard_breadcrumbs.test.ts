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
    expect(downlinesTrail.map((t) => t.label)).toEqual([
      "Dashboard",
      "Bettor Intelligence",
      "Downlines",
    ])
    const parent = resolveParentBreadcrumb(downlinesTrail)
    expect(parent?.label).toBe("Bettor Intelligence")
    expect(parent?.action).toEqual({
      kind: "navigate-tab",
      tab: "customers",
      clearContext: true,
    })

    const r2Trail = buildDashboardBreadcrumbs({ activeTab: "r2" })
    expect(r2Trail.map((t) => t.label)).toEqual([
      "Dashboard",
      "Platform & Infrastructure",
      "R2 Pipeline",
    ])
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
    expect(agentTrail.map((t) => t.label)).toEqual([
      "Dashboard",
      "Bettor Intelligence",
      "Downlines",
      "Agent BIGDAD",
    ])
    expect(resolveParentBreadcrumb(agentTrail)?.label).toBe("Downlines")

    const alertsTrail = buildDashboardBreadcrumbs({
      activeTab: "alerts",
      alertFilter: "FAILED",
    })
    expect(alertsTrail.map((t) => t.label)).toEqual([
      "Dashboard",
      "Operations & Telemetry",
      "DLQ & Alerts",
      "FAILED",
    ])
    expect(resolveParentBreadcrumb(alertsTrail)?.label).toBe("DLQ & Alerts")

    const logsTrail = buildDashboardBreadcrumbs({
      activeTab: "system-logs",
      systemLogSeverityFilter: "CRITICAL",
    })
    expect(logsTrail.map((t) => t.label)).toEqual([
      "Dashboard",
      "Operations & Telemetry",
      "System Logs",
      "CRITICAL",
    ])
    expect(resolveParentBreadcrumb(logsTrail)?.label).toBe("System Logs")
  })
})
