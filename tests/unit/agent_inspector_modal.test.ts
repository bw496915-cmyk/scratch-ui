import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NormalizedRankingsResult } from "../../packages/ui/src/hydration.ts";
import {
  AgentInspectorModal,
  buildAgentHandleTrendSeries,
  buildAgentInspectorTelemetry,
} from "../../packages/ui/src/panels/AgentInspectorModal.tsx";
import { RankingsTabPanel } from "../../packages/ui/src/panels/RankingsTabPanel.tsx";

describe("Rankings Row-Click & Agent Inspector Modal Telemetry", () => {
  const sampleRankings: NormalizedRankingsResult = {
    summary: {
      windowStart: "2026-10-21",
      windowEnd: "2026-11-20",
      generatedAtIso: "2026-11-20T18:00:00Z",
      inWindowWagers: 320,
      totalHandleUsd: 1_000_000,
      totalToWinUsd: 900_000,
      activeCustomerCount: 3,
      activeSubAgentCount: 2,
      activeMasterAgentCount: 1,
      conduitSubAgentCount: 1,
    },
    players: [
      {
        rank: 1,
        id: "PEY101",
        agentId: "BILLY666_SUB1",
        masterAgent: "BILLY666",
        handleUsd: 600_000,
        wagers: 180,
        gini: 0.12,
        alertRate: 58,
        score: 8.9,
        tier: "TIER_1",
        tierLabel: "Tier 1 Sharp",
        dominantSport: "NFL",
        isProxy: true,
        limitUsd: 25_000,
        netUsd: -45_000,
        clvBps: 42,
        handleDelta24hPct: 7.2,
      },
      {
        rank: 2,
        id: "BGD101",
        agentId: "BILLY666_SUB2",
        masterAgent: "BILLY666",
        handleUsd: 400_000,
        wagers: 140,
        gini: 0.21,
        alertRate: 18,
        score: 6.2,
        tier: "TIER_3",
        tierLabel: "Tier 3 Sharp",
        dominantSport: "NBA",
        isProxy: false,
        limitUsd: 5_000,
        netUsd: 12_000,
        clvBps: -8,
        handleDelta24hPct: -3.5,
      },
    ],
    subAgents: [
      {
        agentId: "BILLY666_SUB1",
        masterAgent: "BILLY666",
        handleUsd: 600_000,
        wagers: 180,
        customerCount: 1,
        topCust: "PEY101",
        concPct: 100,
        isProxyConduit: true,
        handleDelta24hPct: 7.2,
      },
      {
        agentId: "BILLY666_SUB2",
        masterAgent: "BILLY666",
        handleUsd: 400_000,
        wagers: 140,
        customerCount: 1,
        topCust: "BGD101",
        concPct: 55.4,
        isProxyConduit: false,
        handleDelta24hPct: -3.5,
      },
    ],
    masterAgents: [
      {
        masterAgent: "BILLY666",
        subAgentCount: 2,
        customerCount: 2,
        conduitCount: 1,
        handleUsd: 1_000_000,
        wagers: 320,
        handleDelta24hPct: 2.9,
      },
    ],
    conduits: [
      {
        agentId: "BILLY666_SUB1",
        masterAgent: "BILLY666",
        handleUsd: 600_000,
        wagers: 180,
        topCust: "PEY101",
        concPct: 100,
        handleDelta24hPct: 7.2,
      },
    ],
    rejectedRows: 0,
    provenance: {
      source: "live",
      endpoint: "/api/rankings/all",
      fetchedAtIso: "2026-11-20T18:00:00Z",
    },
  };

  test("buildAgentInspectorTelemetry resolves Master Forest and Sub-Agent handle trends and sub-conduits", () => {
    const masterTelemetry = buildAgentInspectorTelemetry(
      "BILLY666",
      sampleRankings,
    );
    expect(masterTelemetry).not.toBeNull();
    expect(masterTelemetry?.role).toBe("master");
    expect(masterTelemetry?.handleUsd).toBe(1_000_000);
    expect(masterTelemetry?.handleDelta24hPct).toBe(2.9);
    expect(masterTelemetry?.deskHandleSharePct).toBeCloseTo(100, 4);
    expect(masterTelemetry?.subConduits.length).toBe(2);
    expect(masterTelemetry?.subConduits[0]?.agentId).toBe("BILLY666_SUB1");
    expect(masterTelemetry?.subConduits[0]?.shareOfParentPct).toBeCloseTo(60, 4);

    const subTelemetry = buildAgentInspectorTelemetry(
      "billy666_sub1",
      sampleRankings,
    );
    expect(subTelemetry).not.toBeNull();
    expect(subTelemetry?.role).toBe("conduit");
    expect(subTelemetry?.handleUsd).toBe(600_000);
    expect(subTelemetry?.handleDelta24hPct).toBe(7.2);
    expect(subTelemetry?.isProxyConduit).toBe(true);
    expect(subTelemetry?.subConduits.length).toBe(2);
    expect(
      subTelemetry?.subConduits.find((s) => s.agentId === "BILLY666_SUB1")
        ?.isCurrentAgent,
    ).toBe(true);
  });

  test("buildAgentHandleTrendSeries derives deterministic 7-day cadence matching 24h delta", () => {
    const up = buildAgentHandleTrendSeries(600_000, 7.2, "BILLY666_SUB1");
    expect(up).not.toBeNull();
    expect(up?.points.length).toBe(7);
    expect(up?.direction).toBe("up");
    expect(up?.dailyAvgUsd).toBe(20_000);
    expect(up?.latest24hUsd).toBeGreaterThan(up!.prior24hUsd);

    const down = buildAgentHandleTrendSeries(400_000, -3.5, "BILLY666_SUB2");
    expect(down).not.toBeNull();
    expect(down?.direction).toBe("down");
    expect(down?.latest24hUsd).toBeLessThan(down!.prior24hUsd);

    const flat = buildAgentHandleTrendSeries(300_000, 0, "BILLY666");
    expect(flat?.direction).toBe("flat");
    expect(flat?.latest24hUsd).toBe(flat?.prior24hUsd);

    expect(buildAgentHandleTrendSeries(0, 4.0, "EMPTY")).toBeNull();
    expect(buildAgentHandleTrendSeries(null, 4.0, "EMPTY")).toBeNull();
  });

  test("AgentInspectorModal renders 24h handle trends, 7-day sparkline, and clickable sub-conduit rows", () => {
    const html = renderToStaticMarkup(
      React.createElement(AgentInspectorModal, {
        agentId: "BILLY666_SUB1",
        rankings: sampleRankings,
        onClose: () => {},
        onSelectAgent: () => {},
        onSelectCustomerById: () => {},
        onInspectPty: () => {},
      }),
    );

    expect(html).toContain('data-agent-inspector-modal="BILLY666_SUB1"');
    expect(html).toContain('data-agent-handle-trends="true"');
    expect(html).toContain('data-agent-handle-trend-chart="true"');
    expect(html).toContain('data-handle-trend-direction="up"');
    expect(html).toContain("7-Day Daily Handle Cadence (BILLY666_SUB1)");
    expect(html).toContain('data-handle-trend-24h="up"');
    expect(html).toContain("+7.2%");
    expect(html).toContain('data-agent-sub-conduits="true"');
    expect(html).toContain('data-sub-conduit-row="BILLY666_SUB1"');
    expect(html).toContain('data-sub-conduit-row="BILLY666_SUB2"');
    expect(html).toContain("Click row to inspect sub-conduit BILLY666_SUB2");
    expect(html).toContain("60.0%");
    expect(html).toContain("40.0%");
  });

  test("RankingsTabPanel wires clickable row attributes across master forest, sub-agents, customer rankings, and conduits", () => {
    const html = renderToStaticMarkup(
      React.createElement(RankingsTabPanel, {
        rankingsSearch: "",
        onRankingsSearchChange: () => {},
        rankingsFilter: "ALL",
        onRankingsFilterChange: () => {},
        onInspectPty: () => {},
        onSelectAgent: () => {},
        rankings: sampleRankings,
        rankingsStatus: "ready",
      }),
    );

    expect(html).toContain('class="sd-rankings-clickable-row"');
    expect(html).toContain('data-downline-master-row="BILLY666"');
    expect(html).toContain('data-rankings-row-agent="BILLY666"');
    expect(html).toContain("Click row to inspect Master Forest BILLY666");
    expect(html).toContain('data-downline-agent-row="BILLY666_SUB1"');
    expect(html).toContain('data-downline-customer-row="PEY101"');
    expect(html).toContain('data-rankings-row-agent="BILLY666_SUB1"');
    expect(html).toContain('data-rankings-row-agent="BILLY666_SUB2"');
    expect(html).toContain("Click row to inspect agent BILLY666_SUB1");
  });
});
