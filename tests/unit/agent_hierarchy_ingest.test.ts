import { describe, expect, test } from "bun:test"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  createAgentDetailService,
  createAgentHierarchyStore,
  parseFantasy402HierarchyPayload,
} from "../../packages/backend/src/index.ts"
import {
  getActiveRateEntries,
  sanitizeFantasy402RawTextBeforeUpload,
  stripSensitiveFieldsFromFantasy402Object,
} from "../../packages/contracts/src/agent_hierarchy.ts"
import { AgentHierarchyPanel } from "../../packages/ui/src/panels/AgentHierarchyPanel.tsx"
import { AgentInspectorModal } from "../../packages/ui/src/panels/AgentInspectorModal.tsx"
import { executeNodeTerminalQuery } from "../../server/adapters.ts"
import { validateTerminalCommand } from "../../src/lib/shell_boundary.ts"

const SYNTHETIC_SECRET_MARKER = "SYNTHETIC_NEVER_RETAIN_9911"

const SAMPLE_F402_PAYLOAD = {
  EXTRA: false,
  GENERAL: [
    {
      AgentID: "BILLY667  ",
      SeqNumber: 5223,
      Level: 1,
      AgentType: "A",
      Login: "BILLY667  ",
      HeadCountRateM: 1,
      InetHeadCountRateM: 0,
      LiveBettingRateM: 0,
      LiveBetting2RateM: 0,
      LiveCasinoRateM: 0,
      CasinoHeadCountRateM: 0,
      PropBuilderRateM: 0,
      BetBuilderRate: 0,
      AmigoTechRate: 0,
      CrashRate: 0,
      ExtPropsRate: 0,
      FantasyRate: 0,
      FlashBetsRate: 0,
      GitCasinoRate: 0,
    },
    {
      AgentID: "NOLAWOLF  ",
      SeqNumber: 5224,
      Level: 1,
      AgentType: "M",
      Login: "NOLAWOLF  ",
      HeadCountRateM: 10,
      LiveBettingRateM: 5,
    },
    {
      AgentID: "BOTMASTER ",
      SeqNumber: 5225,
      Level: 2,
      AgentType: "M",
      Login: "BOTMASTER",
      HeadCountRateM: 0,
    },
    {
      AgentID: "GABRIELCS ",
      SeqNumber: 5226,
      Level: 3,
      AgentType: "M",
      Login: "GABRIELCS",
      HeadCountRateM: 0,
    },
    {
      AgentID: "APPTEST   ",
      SeqNumber: 5227,
      Level: 4,
      AgentType: "A",
      Login: "APPTEST   ",
      HeadCountRateM: 0,
    },
    {
      AgentID: "NOLAPPH   ",
      SeqNumber: 5230,
      Level: 2,
      AgentType: "M",
      Login: "NOLAPPH",
      HeadCountRateM: 0,
    },
    {
      AgentID: "AUSTINPPH2",
      SeqNumber: 5231,
      Level: 3,
      AgentType: "M",
      Login: "AUSTINPPH2",
      HeadCountRateM: 8,
    },
    {
      AgentID: "BAILEYMA  ",
      SeqNumber: 5232,
      Level: 4,
      AgentType: "M",
      Login: "BAILEYMA",
      HeadCountRateM: 5,
      PropBuilderRateM: 2,
    },
    {
      AgentID: "AFB1BB    ",
      SeqNumber: 5233,
      Level: 5,
      AgentType: "A",
      Login: "AFB1BB    ",
      HeadCountRateM: 5,
    },
    {
      AgentID: "LP1.      ",
      SeqNumber: 5234,
      Level: 5,
      AgentType: "A",
      Login: "LP1.",
      HeadCountRateM: 0,
    },
    {
      AgentID: "LP1       ",
      SeqNumber: 5235,
      Level: 5,
      AgentType: "A",
      Login: "LP1",
      HeadCountRateM: 0,
    },
  ],
  PLAYERS: [
    {
      customerID: "1_0       ",
      Login: "1",
      NameFirst: "Dummy",
      Password: SYNTHETIC_SECRET_MARKER,
      Agent: "AFB1BB",
    },
    {
      customerID: "1001      ",
      Login: "1001",
      NameFirst: "Orphan Player",
      Password: `${SYNTHETIC_SECRET_MARKER}_2`,
      Agent: "UNKNOWN_ORPHAN",
    },
  ],
}

describe("Fantasy402 Agent Hierarchy & Player Directory Ingest", () => {
  test("reconstructs pre-order (SeqNumber, Level) parent links, trims whitespace, detects collisions & orphans", () => {
    const parsed = parseFantasy402HierarchyPayload(SAMPLE_F402_PAYLOAD)

    expect(parsed.summary.totalAgents).toBe(11)
    expect(parsed.summary.roots).toEqual(["BILLY667", "NOLAWOLF"])
    expect(parsed.summary.masterCount).toBe(6)
    expect(parsed.summary.subAgentCount).toBe(5)
    expect(parsed.summary.maxDepth).toBe(5)
    expect(parsed.summary.extraFlag).toBe(false)
    expect(parsed.summary.totalPlayers).toBe(2)
    expect(parsed.summary.mappedPlayers).toBe(1)
    expect(parsed.summary.orphanPlayers).toBe(1)
    expect(parsed.summary.orphanAgentIds).toEqual(["UNKNOWN_ORPHAN"])
    expect(parsed.summary.collisionCount).toBe(1)
    expect(parsed.summary.collisions[0]).toEqual({
      canonicalKey: "LP1",
      agentIds: ["LP1", "LP1."],
    })

    const billy = parsed.nodesById.get("BILLY667")
    expect(billy?.parentAgentId).toBeNull()
    expect(billy?.rateCard?.headCountRateM).toBe(1)
    expect(billy?.rateCard?.activeRateCount).toBe(1)

    const afb = parsed.nodesById.get("AFB1BB")
    expect(afb?.parentAgentId).toBe("BAILEYMA")
    expect(afb?.rootMasterAgent).toBe("NOLAWOLF")
    expect(afb?.ancestors).toEqual(["NOLAWOLF", "NOLAPPH", "AUSTINPPH2", "BAILEYMA"])
    expect(afb?.playerCount).toBe(1)

    const appt = parsed.nodesById.get("APPTEST")
    expect(appt?.parentAgentId).toBe("GABRIELCS")
    expect(appt?.ancestors).toEqual(["NOLAWOLF", "BOTMASTER", "GABRIELCS"])

    const bailey = parsed.nodesById.get("BAILEYMA")
    expect(bailey?.directChildCount).toBe(3)
    expect(bailey?.rateCard?.totalMonthlyRateUsd).toBe(7)
    expect(getActiveRateEntries(bailey?.rateCard).map((r) => r.key)).toEqual(["headCountRateM", "propBuilderRateM"])
  })

  test("strictly strips PLAYERS[].Password at both client pre-flight and server ingest (zero retention)", () => {
    const rawJson = JSON.stringify(SAMPLE_F402_PAYLOAD)

    // Client-side pre-flight sanitizer
    const preflight = sanitizeFantasy402RawTextBeforeUpload(rawJson)
    expect(preflight.parsedAsJson).toBe(true)
    expect(preflight.passwordsStripped).toBe(2)
    expect(preflight.sanitizedText).not.toContain(SYNTHETIC_SECRET_MARKER)
    expect(preflight.sanitizedText).not.toContain("Password")

    // Object sanitizer
    const objSanitized = stripSensitiveFieldsFromFantasy402Object(SAMPLE_F402_PAYLOAD)
    expect(objSanitized.passwordsStripped).toBe(2)
    expect(JSON.stringify(objSanitized.sanitized)).not.toContain(SYNTHETIC_SECRET_MARKER)

    // Server-side parser + store (even if raw unsanitized payload is posted directly)
    const store = createAgentHierarchyStore()
    const ingestRes = store.ingest(SAMPLE_F402_PAYLOAD)
    expect(ingestRes.passwordsStripped).toBe(2)

    const queryRes = store.query({ includePlayers: true })
    const serialized = JSON.stringify({
      ingestRes,
      queryRes,
      node: store.getAgentNode("AFB1BB"),
      legacy: store.toLegacyAgentTreeJson(),
    })
    expect(serialized).not.toContain(SYNTHETIC_SECRET_MARKER)
    expect(queryRes.players[0]).toEqual({
      customerId: "1_0",
      login: "1",
      nameFirst: "Dummy",
      agentId: "AFB1BB",
      rootMasterAgent: "NOLAWOLF",
    })
  })

  test("rejects truncated Chrome DevTools console dumps with an actionable hint", () => {
    const truncatedDump = `{,…}\nGENERAL: [{AgentID: "BILLY667 "}]\n[100 … 199]`
    expect(() => parseFantasy402HierarchyPayload(truncatedDump)).toThrow(/truncated Chrome DevTools preview/i)
  })

  test("enriches createAgentDetailService (/api/agent/:id) and terminal agent-tree command", async () => {
    const store = createAgentHierarchyStore()
    store.ingest(SAMPLE_F402_PAYLOAD)

    const agentDetailService = createAgentDetailService({
      getHierarchyNode: (id) => store.getAgentNode(id),
    })

    const detail = await agentDetailService.getAgentDetail("afb1bb")
    expect(detail.found).toBe(true)
    expect(detail.masterAgent).toBe("BAILEYMA")
    expect(detail.rootMasterAgent).toBe("NOLAWOLF")
    expect(detail.ancestors).toEqual(["NOLAWOLF", "NOLAPPH", "AUSTINPPH2", "BAILEYMA"])
    expect(detail.seqNumber).toBe(5233)
    expect(detail.rateCard?.headCountRateM).toBe(5)
    expect(detail.directoryPlayerCount).toBe(1)
    expect(detail.directoryPlayers?.[0]?.customerId).toBe("1_0")
    expect(JSON.stringify(detail)).not.toContain(SYNTHETIC_SECRET_MARKER)

    // Terminal boundary & command execution
    expect(validateTerminalCommand("agent-tree AFB1BB").ok).toBe(true)
    expect(validateTerminalCommand("hierarchy --root=NOLAWOLF --level=4").ok).toBe(true)

    const termRes = await executeNodeTerminalQuery("agent-tree AFB1BB --plain", {
      findCustomerRow: async () => null,
      getTiersConfig: async () => ({}),
      getLiveWagers: async () => ({ wagers: [] }),
      queryAgentHierarchy: (opts) => store.query(opts),
      getAgentHierarchyNode: (id) => store.getAgentNode(id),
    })
    expect(termRes.exitCode).toBe(0)
    expect(termRes.stdout).toContain("AFB1BB")
    expect(termRes.stdout).toContain("NOLAWOLF -> NOLAPPH -> AUSTINPPH2 -> BAILEYMA -> AFB1BB")
    expect(termRes.stdout).toContain("1_0")
    expect(termRes.stdout).not.toContain(SYNTHETIC_SECRET_MARKER)
  })

  test("loads baseline disk agent-tree.json + agent-index.json and renders AgentHierarchyPanel + AgentInspectorModal", () => {
    const store = createAgentHierarchyStore({ cwd: process.cwd() })
    const dir = store.query({ limit: 10 })
    expect(dir.summary.totalAgents).toBeGreaterThan(100)
    expect(dir.summary.roots).toContain("NOLAWOLF")

    const panelHtml = renderToStaticMarkup(
      React.createElement(AgentHierarchyPanel, {
        initialDirectory: dir,
        onSelectAgent: () => {},
        onSelectCustomerById: () => {},
      }),
    )
    expect(panelHtml).toContain("Fantasy402 Agent Tree &amp; Player Directory")
    expect(panelHtml).toContain("Ingest GENERAL / PLAYERS JSON")
    expect(panelHtml).toContain('data-agent-hierarchy-table="true"')

    // Verify enriched AgentInspectorModal renders lineage + rate card + assigned players without passwords
    const liveStore = createAgentHierarchyStore()
    liveStore.ingest(SAMPLE_F402_PAYLOAD)
    const nodeDetail = liveStore.getAgentNode("AFB1BB")!
    const modalHtml = renderToStaticMarkup(
      React.createElement(AgentInspectorModal, {
        agentId: "AFB1BB",
        initialDetail: {
          schemaVersion: 1,
          agentId: "AFB1BB",
          found: true,
          masterAgent: nodeDetail.node.parentAgentId,
          level: nodeDetail.node.level,
          agentType: nodeDetail.node.agentType,
          seqNumber: nodeDetail.node.seqNumber,
          login: nodeDetail.node.login,
          rootMasterAgent: nodeDetail.node.rootMasterAgent,
          ancestors: nodeDetail.node.ancestors,
          rateCard: nodeDetail.node.rateCard,
          directoryPlayers: nodeDetail.players,
          directoryPlayerCount: nodeDetail.players.length,
          childAgents: nodeDetail.childAgents,
          conduit30d: null,
          customers: [],
          recentWagers: [],
          observedAt: "2026-11-20T00:00:00.000Z",
          autoExecute: false,
        },
        onClose: () => {},
        onSelectAgent: () => {},
        onSelectCustomerById: () => {},
        onInspectPty: () => {},
      }),
    )
    expect(modalHtml).toContain('data-agent-hierarchy-meta="true"')
    expect(modalHtml).toContain('data-agent-rate-card="true"')
    expect(modalHtml).toContain('data-agent-directory-players="true"')
    expect(modalHtml).toContain("BAILEYMA")
    expect(modalHtml).toContain("Head Count / Mo: $5")
    expect(modalHtml).not.toContain(SYNTHETIC_SECRET_MARKER)
  })
})
