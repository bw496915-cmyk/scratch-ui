import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { NormalizedRankingsResult } from "../../packages/ui/src/hydration.ts"
import { buildHandleHeatLookup } from "../../packages/ui/src/panels/rankings_heatmap.ts"
import {
  buildConduitsCsv,
  buildDownlinesCsv,
  buildRankingsCsvFilename,
  buildSubAgentsCsv,
  downloadRankingsCsvBlob,
  RankingsTabPanel,
} from "../../packages/ui/src/panels/RankingsTabPanel.tsx"

describe("Rankings Tab Export to CSV", () => {
  const samplePlayers = [
    {
      rank: 1,
      id: "SYNTH_SYN_01",
      agentId: "SYNTH_AGENT_01",
      masterAgent: "BILLY666",
      handleUsd: 500_000,
      wagers: 42,
      gini: 0.112,
      alertRate: 64,
      score: 8.85,
      tier: "TIER_1",
      tierLabel: 'Tier 1, "Sharp"',
      dominantSport: "NFL",
      isProxy: true,
      limitUsd: 25_000,
      netUsd: -75_000,
      clvBps: 44,
      handleDelta24hPct: 6.3,
    },
    {
      rank: 2,
      id: "=EVIL_CMD",
      agentId: "SYNTH_AGENT_02",
      masterAgent: "BILLY666",
      handleUsd: 25_000,
      wagers: 12,
      gini: 0.24,
      alertRate: 15,
      score: 4.5,
      tier: "RECREATIONAL",
      tierLabel: "Recreational",
      dominantSport: "NBA",
      isProxy: false,
      limitUsd: 2_500,
      netUsd: 1_200,
      clvBps: -12,
      handleDelta24hPct: -3.4,
    },
  ] as const

  test("buildDownlinesCsv formats RFC-4180 CSV with 24h delta, desk share, heat bucket, and formula-injection neutralization", () => {
    const heat = buildHandleHeatLookup(
      samplePlayers,
      (p) => p.id.trim().toUpperCase(),
      (p) => p.handleUsd,
    )

    const csv = buildDownlinesCsv(samplePlayers, {
      totalDeskHandle: 1_000_000,
      heatByKey: heat.byKey,
    })

    const lines = csv.split("\r\n")
    expect(lines.length).toBe(3)
    expect(lines[0]).toBe(
      "rank,customer_id,sub_agent,master_forest,handle_usd,wagers,stake_gini,alert_rate_pct,composite_score,tier,dominant_sport,proxy_flag,limit_usd,net_usd,clv_bps,handle_delta_24h_pct,desk_handle_share_pct,heat_bucket,visible_handle_percentile",
    )
    // Properly quotes embedded comma and double quotes, preserves negative numbers without formula prefix
    expect(lines[1]).toContain('"Tier 1, ""Sharp"""')
    expect(lines[1]).toContain("-75000,44,6.3,50,5,")
    // Neutralizes leading '=' in untrusted string cell while keeping negative net/clv/delta numeric
    expect(lines[2]).toContain("'=EVIL_CMD")
    expect(lines[2]).toContain("1200,-12,-3.4,2.5,1,")
  })

  test("buildConduitsCsv and buildRankingsCsvFilename encode active view and filters safely", () => {
    const conduits = [
      {
        agentId: "BILLY666_SUB1",
        masterAgent: "BILLY666",
        handleUsd: 420_000,
        wagers: 88,
        topCust: "PEY101",
        concPct: 96.4,
        handleDelta24hPct: 4.1,
      },
    ] as const
    const heat = buildHandleHeatLookup(
      conduits,
      (c) => c.agentId.trim().toUpperCase(),
      (c) => c.handleUsd,
    )
    const csv = buildConduitsCsv(conduits, heat.byKey)
    expect(csv).toContain(
      "sub_agent_id,master_forest,handle_usd,wagers,top_customer,concentration_pct,handle_delta_24h_pct,heat_bucket,visible_handle_percentile",
    )
    expect(csv).toContain("BILLY666_SUB1,BILLY666,420000,88,PEY101,96.4,4.1,3,100")

    expect(
      buildRankingsCsvFilename({
        viewMode: "ALL",
        filter: "WHALES",
        selectedAgentIds: ["BILLY666"],
        masterForest: "ALL",
        dateIso: "2026-11-20T10:38:35Z",
      }),
    ).toBe("sportsdesk-rankings-whales-billy666-2026-11-20.csv")

    expect(
      buildRankingsCsvFilename({
        viewMode: "CONDUITS",
        filter: "ALL",
        selectedAgentIds: ["AG1", "AG2"],
        masterForest: "MASTER_01",
        dateIso: "2026-11-20T10:38:35Z",
      }),
    ).toBe("sportsdesk-rankings-conduits-master_01-2-agents-2026-11-20.csv")

    expect(
      buildRankingsCsvFilename({
        viewMode: "TREE",
        filter: "ALL",
        selectedAgentIds: ["BILLY666"],
        masterForest: "ALL",
        dateIso: "2026-11-20T10:38:35Z",
      }),
    ).toBe("sportsdesk-rankings-hierarchy-billy666-2026-11-20.csv")

    const subAgentCsv = buildSubAgentsCsv(
      [
        {
          agentId: "BILLY666_SUB1",
          masterAgent: "BILLY666",
          handleUsd: 420_000,
          wagers: 88,
          customerCount: 2,
          topCust: "PEY101",
          concPct: 96.4,
          isProxyConduit: true,
          avgScore: 8.2,
          totalNetUsd: -15_000,
          handleDelta24hPct: 4.1,
          players: [],
        },
      ],
      { totalDeskHandle: 1_000_000 },
    )
    expect(subAgentCsv).toContain(
      "sub_agent_id,master_forest,handle_usd,wagers,customer_count,top_customer,concentration_pct,is_proxy_conduit,avg_score,total_net_usd,handle_delta_24h_pct,desk_handle_share_pct,heat_bucket,visible_handle_percentile",
    )
    expect(subAgentCsv).toContain(
      "BILLY666_SUB1,BILLY666,420000,88,2,PEY101,96.4,PROXY,8.2,-15000,4.1,42,",
    )
  })

  test("downloadRankingsCsvBlob generates UTF-8 BOM Blob, triggers anchor download, and cleans up DOM", async () => {
    let capturedBlob: Blob | null = null
    let clicked = false
    let removed = false
    const fakeAnchor = {
      href: "",
      download: "",
      style: { display: "" },
      click: () => {
        clicked = true
      },
      remove: () => {
        removed = true
      },
    }

    const ok = downloadRankingsCsvBlob(
      "rank,customer_id\r\n1,SYNTH_SYN_01",
      "sportsdesk-rankings-2026-11-20.csv",
      {
        document: {
          createElement: () => fakeAnchor,
          body: { appendChild: () => {} },
        },
        createObjectURL: (blob) => {
          capturedBlob = blob
          return "blob:rankings-csv-test"
        },
        revokeObjectURL: () => {},
      },
    )

    expect(ok).toBe(true)
    expect(clicked).toBe(true)
    expect(removed).toBe(true)
    expect(fakeAnchor.href).toBe("blob:rankings-csv-test")
    expect(fakeAnchor.download).toBe("sportsdesk-rankings-2026-11-20.csv")
    expect(capturedBlob).toBeInstanceOf(Blob)
    expect(capturedBlob?.type).toContain("text/csv")
    const bytes = new Uint8Array(await capturedBlob!.arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const text = await capturedBlob!.text()
    expect(text).toBe("rank,customer_id\r\n1,SYNTH_SYN_01")
  })

  test("RankingsTabPanel renders enabled Export to CSV button with filtered count and disables it when filter matches 0 rows", () => {
    const rankings: NormalizedRankingsResult = {
      summary: {
        windowStart: "2026-10-21",
        windowEnd: "2026-11-20",
        generatedAtIso: "2026-11-20T18:00:00Z",
        inWindowWagers: 54,
        totalHandleUsd: 525_000,
        totalToWinUsd: 480_000,
        activeCustomerCount: 2,
        activeSubAgentCount: 2,
        activeMasterAgentCount: 1,
        conduitSubAgentCount: 1,
      },
      players: [...samplePlayers],
      subAgents: [],
      masterAgents: [],
      conduits: [],
      rejectedRows: 0,
      provenance: {
        source: "live",
        endpoint: "/api/rankings/all",
        fetchedAtIso: "2026-11-20T18:00:00Z",
      },
    }

    const htmlActive = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "SYNTH_SYN_01",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        rankings,
        rankingsStatus: "ready",
      }),
    )

    expect(htmlActive).toContain('class="sd-export-csv-btn"')
    expect(htmlActive).toContain('data-rankings-export-csv="true"')
    expect(htmlActive).toContain('data-export-row-count="1"')
    expect(htmlActive).toContain("Export to CSV (1)")
    expect(htmlActive).toContain("Export to CSV (1 filtered row)")
    expect(htmlActive).not.toContain('data-rankings-export-csv="true" disabled')

    const htmlEmpty = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "DOES_NOT_EXIST_999",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        rankings,
        rankingsStatus: "ready",
      }),
    )

    expect(htmlEmpty).toContain('data-rankings-export-csv="true"')
    expect(htmlEmpty).toContain('data-export-row-count="0"')
    expect(htmlEmpty).toContain("Export to CSV (no filtered rows available)")
    expect(htmlEmpty).toContain("disabled")
  })
})
