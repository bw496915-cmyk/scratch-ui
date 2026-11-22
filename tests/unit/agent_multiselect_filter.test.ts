import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { runBatchedRanking } from "../../lib/customer_rankings.ts"
import { normalizeRankingsResponse } from "../../packages/ui/src/hydration.ts"
import {
  type AgentFilterOption,
  AgentMultiSelectFilter,
  buildF402TransactionHistoryParams,
  filterAgentOptions,
  parseAgentIdsFromInput,
} from "../../packages/ui/src/panels/AgentMultiSelectFilter.tsx"
import { RankingsTabPanel } from "../../packages/ui/src/panels/RankingsTabPanel.tsx"
import { buildDashboardSearch, readDashboardUrlState } from "../../packages/ui/src/url_state.ts"

const F402_TX_QUERY_SAMPLE =
  "agentID=BILLY666&customerID=&startDate=2026-11-20&endDate=2026-11-20&deposits=checked&withdrawals=checked&adjustments=checked&transfers=checked&fess=checked&promotional=checked&balances=checked&distribution=unchecked&freeFlag=player&operation=getTransactionHistory&RRO=1&agentOwner=BILLY666"

describe("Downlines Searchable Multi-Select Agent ID Filter", () => {
  test("parseAgentIdsFromInput extracts Agent IDs from plain lists and Fantasy402 transaction query strings", () => {
    expect(parseAgentIdsFromInput(F402_TX_QUERY_SAMPLE)).toEqual(["BILLY666"])

    expect(
      parseAgentIdsFromInput(
        "agentID=synth_agent_01,synth_agent_02&operation=getTransactionHistory&agentOwner=BILLY666",
      ),
    ).toEqual(["SYNTH_AGENT_01", "SYNTH_AGENT_02", "BILLY666"])

    expect(parseAgentIdsFromInput("billy666, synth_agent_01  synth_agent_02")).toEqual([
      "BILLY666",
      "SYNTH_AGENT_01",
      "SYNTH_AGENT_02",
    ])

    expect(parseAgentIdsFromInput("   ")).toEqual([])
  })

  test("buildF402TransactionHistoryParams produces the exact Fantasy402 getTransactionHistory query parameters", () => {
    const params = buildF402TransactionHistoryParams({
      agentId: "billy666",
      agentOwner: "billy666",
      customerId: "",
      startDate: "2026-11-20",
      endDate: "2026-11-20",
    })

    expect(params.toString()).toBe(F402_TX_QUERY_SAMPLE)
    expect(params.get("agentID")).toBe("BILLY666")
    expect(params.get("agentOwner")).toBe("BILLY666")
    expect(params.get("fess")).toBe("checked")
    expect(params.get("distribution")).toBe("unchecked")
    expect(params.get("freeFlag")).toBe("player")
    expect(params.get("operation")).toBe("getTransactionHistory")
    expect(params.get("RRO")).toBe("1")
  })

  test("filterAgentOptions matches by Agent ID, Master Forest, conduit keyword, or pasted query string", () => {
    const options: readonly AgentFilterOption[] = [
      {
        agentId: "SYNTH_AGENT_01",
        masterAgent: "SYNTH_MASTER_01",
        role: "sub-agent",
        handleUsd: 500000,
        customerCount: 1,
        concPct: 100,
        isProxyConduit: true,
      },
      {
        agentId: "SYNTH_AGENT_02",
        masterAgent: "BILLY666",
        role: "sub-agent",
        handleUsd: 240000,
        customerCount: 4,
        concPct: 45,
        isProxyConduit: false,
      },
      {
        agentId: "BILLY666",
        masterAgent: "BILLY666",
        role: "master-forest",
        handleUsd: 740000,
        customerCount: 5,
        concPct: null,
        isProxyConduit: false,
      },
    ]

    expect(filterAgentOptions(options, "conduit").map((o) => o.agentId)).toEqual(["SYNTH_AGENT_01"])
    expect(filterAgentOptions(options, "", "CONDUITS").map((o) => o.agentId)).toEqual([
      "SYNTH_AGENT_01",
    ])
    expect(filterAgentOptions(options, "", "MASTERS").map((o) => o.agentId)).toEqual(["BILLY666"])
    expect(filterAgentOptions(options, "", "SUB_AGENTS").map((o) => o.agentId)).toEqual([
      "SYNTH_AGENT_01",
      "SYNTH_AGENT_02",
    ])
    expect(filterAgentOptions(options, F402_TX_QUERY_SAMPLE).map((o) => o.agentId)).toEqual([
      "SYNTH_AGENT_02",
      "BILLY666",
    ])
  })

  test("url_state parses Fantasy402 agentID/agentOwner params, routes to rankings, and serializes multi-select lists", () => {
    const fromF402 = readDashboardUrlState(`?${F402_TX_QUERY_SAMPLE}`, "/")
    expect(fromF402.tab).toBe("rankings")
    expect(fromF402.downlineAgents).toEqual(["BILLY666"])

    const serializedMulti = buildDashboardSearch(
      {
        ...fromF402,
        tab: "rankings",
        downlineAgents: ["BILLY666", "SYNTH_AGENT_01"],
      },
      "?tab=rankings",
      "/",
    )
    expect(serializedMulti).toContain("tab=rankings")
    expect(serializedMulti).toContain("agentID=BILLY666%2CSYNTH_AGENT_01")

    const cleared = buildDashboardSearch(
      { ...fromF402, tab: "rankings", downlineAgents: [] },
      `?${F402_TX_QUERY_SAMPLE}&tab=rankings`,
      "/",
    )
    expect(cleared).not.toContain("agentID=")
    expect(cleared).not.toContain("agentOwner=")
  })

  test("AgentMultiSelectFilter renders trigger, search box, role/conduit scope tabs, Only buttons, and options when open", () => {
    const options: readonly AgentFilterOption[] = [
      {
        agentId: "SYNTH_AGENT_01",
        masterAgent: "BILLY666",
        role: "sub-agent",
        handleUsd: 500000,
        customerCount: 1,
        concPct: 100,
        isProxyConduit: true,
      },
      {
        agentId: "BILLY666",
        masterAgent: "BILLY666",
        role: "master-forest",
        handleUsd: 500000,
        customerCount: 1,
        concPct: null,
        isProxyConduit: false,
      },
    ]

    const html = renderToStaticMarkup(
      React.createElement(AgentMultiSelectFilter, {
        options,
        selectedAgentIds: ["BILLY666"],
        onChange: () => {},
        defaultOpen: true,
      }),
    )

    expect(html).toContain('data-agent-multiselect="true"')
    expect(html).toContain("Agent ID: BILLY666")
    expect(html).toContain('data-agent-filter-search="true"')
    expect(html).toContain('data-agent-role-filter="true"')
    expect(html).toContain('data-agent-scope-tab="CONDUITS"')
    expect(html).toContain('data-agent-scope-tab="MASTERS"')
    expect(html).toContain('data-agent-select-conduits="true"')
    expect(html).toContain('data-agent-option="SYNTH_AGENT_01"')
    expect(html).toContain('data-agent-only="SYNTH_AGENT_01"')
    expect(html).toContain('data-agent-option="BILLY666"')
    expect(html).toContain("CONDUIT")
  })

  test("RankingsTabPanel narrows hierarchy, customer rows, and conduits to selected Agent IDs and renders the Active Agent Filter Bar", async () => {
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
        selectedAgentIds: ["SYNTH_AGENT_01"],
        onSelectedAgentIdsChange: () => {},
        rankings: normalized,
        rankingsStatus: "ready",
      }),
    )

    expect(html).toContain('data-agent-multiselect="true"')
    expect(html).toContain("Agent ID: SYNTH_AGENT_01")
    expect(html).toContain('data-downline-agent-filter-bar="true"')
    expect(html).toContain('data-selected-agent-chip="SYNTH_AGENT_01"')
    expect(html).toContain('data-copy-f402-tx-query="true"')
    expect(html).toContain("Copy F402 Tx Query")

    // Selected sub-agent, its customer, and its conduit toggle remain visible
    expect(html).toContain('data-downline-agent="SYNTH_AGENT_01"')
    expect(html).toContain('data-downline-customer-row="SYNTH_SYN_01"')
    expect(html).toContain('data-conduit-filter-toggle="SYNTH_AGENT_01"')

    // Unrelated sub-agents and their customers are narrowed out
    expect(html).not.toContain('data-downline-agent="SYNTH_AGENT_02"')
    expect(html).not.toContain('data-downline-customer-row="SYNTH_SNIPER_02"')
  })
})
