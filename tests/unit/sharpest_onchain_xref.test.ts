import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { applyGraphForensicsToProfiles, indexGraphLiveFeedForensics } from "../../packages/ui/src/customer_forensics.ts"
import { backtestRowsToProfiles } from "../../packages/ui/src/profile_rows.ts"
import {
  buildSharpestOnChainXrefReport,
  DEFAULT_SHARP_XREF_THRESHOLD,
  indexOnChainWalletTracking,
  isValidEvmAddress,
  parseCrossDomainBridgeSnapshot,
} from "../../packages/ui/src/sharpest_onchain_xref.ts"
import type { ShowcaseCustomer } from "../../packages/ui/src/types.ts"

const ROOT = resolve(import.meta.dir, "..", "..")

function loadJson(relPath: string): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, relPath), "utf8"))
}

function loadEnrichedBacktestProfiles(rawGraphFeed: unknown): readonly ShowcaseCustomer[] {
  const raw = loadJson("docs/backtest-4wk-cfb-nba.json") as {
    customerLeaderboard?: readonly Record<string, unknown>[]
  }
  const base = backtestRowsToProfiles(raw.customerLeaderboard ?? [])
  return applyGraphForensicsToProfiles(base, indexGraphLiveFeedForensics(rawGraphFeed))
}

describe("sharpest_onchain_xref", () => {
  test("validates 40-hex EVM addresses and rejects truncated/malformed addresses", () => {
    expect(isValidEvmAddress("0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612")).toBe(true)
    expect(isValidEvmAddress("0x0746672C2F1E3770520B2B1494A1E9C268D4D8C1")).toBe(true)
    // Truncated 33-hex invalid address observed in walletProfiles fixtures
    expect(isValidEvmAddress("0x3aF8c9104E2b78a142dE90B218a91D89D")).toBe(false)
    expect(isValidEvmAddress("")).toBe(false)
    expect(isValidEvmAddress(null)).toBe(false)
    expect(isValidEvmAddress("not-a-wallet")).toBe(false)
  })

  test("parses real docs/cross-domain-bridge.json snapshot and indexes live wallet tracking", () => {
    const rawGraphFeed = loadJson("docs/graph-live-feed.json")
    const rawBridge = loadJson("docs/cross-domain-bridge.json")

    const bridge = parseCrossDomainBridgeSnapshot(rawBridge)
    expect(bridge).not.toBeNull()
    expect(bridge!.leads.length).toBeGreaterThanOrEqual(8)
    expect(bridge!.linkedCustomers).toBeGreaterThan(0)
    expect(bridge!.sharedWallets).toBeGreaterThan(0)

    const walletIndex = indexOnChainWalletTracking(rawGraphFeed)
    expect(walletIndex.size).toBeGreaterThanOrEqual(30)

    const mj102 = walletIndex.get("MJ102")
    expect(mj102).toBeDefined()
    expect(mj102!.dataSource).toBe("LIVE")
    expect(mj102!.walletAddressValid).toBe(true)
    expect(mj102!.trackedTickets.some((t) => t.ticketId === "PM-ORD-8801-1Q")).toBe(true)

    const churn059 = walletIndex.get("CHURN_059")
    expect(churn059).toBeDefined()
    expect(churn059!.dataSource).toBe("LIVE")
    expect(churn059!.trackedTickets.some((t) => t.ticketId === "F402-901003-ALT")).toBe(true)
  })

  test("cross-references real Sharpest cohort against live on-chain tracking and bridge divergence", () => {
    const rawGraphFeed = loadJson("docs/graph-live-feed.json")
    const profiles = loadEnrichedBacktestProfiles(rawGraphFeed)
    const bridgeSnapshot = parseCrossDomainBridgeSnapshot(loadJson("docs/cross-domain-bridge.json"))

    const report = buildSharpestOnChainXrefReport({
      profiles,
      rawGraphFeed,
      bridgeSnapshot,
      minSharpScore: DEFAULT_SHARP_XREF_THRESHOLD,
    })

    expect(report.rows.length).toBeGreaterThan(0)
    expect(report.summary.totalSharpProfiles).toBe(report.rows.length)
    expect(report.summary.divergenceAlertCount).toBeGreaterThanOrEqual(1)
    expect(report.summary.verifiedLiveCount).toBeGreaterThanOrEqual(1)
    expect(report.summary.totalOnChainVolumeUsd).toBeGreaterThan(0)

    // BGD101 shares proxy wallet 0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612 with BB5127 and is a POLY_ONLY_UP lead
    const bgd101 = report.byCustomerId.get("BGD101")
    expect(bgd101).toBeDefined()
    expect(bgd101!.status).toBe("DIVERGENCE_ALERT")
    expect(bgd101!.flags).toContain("POLY_ONLY_UP_DIVERGENCE")
    expect(bgd101!.flags).toContain("SHARED_WALLET_CONDUIT")
    expect(bgd101!.sharedWithCustomerIds).toContain("BB5127")
    expect(bgd101!.bridgePriorityUsd).toBeGreaterThan(0)
    expect(bgd101!.walletFormatValid).toBe(true)

    // MJ102 is a tracked LIVE sharp wallet with shadow ticket PM-ORD-8801-1Q
    const mj102 = report.byCustomerId.get("MJ102")
    expect(mj102).toBeDefined()
    expect(mj102!.status).toBe("VERIFIED_LIVE")
    expect(mj102!.dataSource).toBe("LIVE")
    expect(mj102!.walletFormatValid).toBe(true)
    expect(mj102!.flags).toContain("SHADOW_TICKET_TRACKED")
    expect(mj102!.trackedTicketCount).toBeGreaterThanOrEqual(1)

    // CHURN_059 is a LIVE tracked sharp account with flagged ticket F402-901003-ALT
    const churn059 = report.byCustomerId.get("CHURN_059")
    expect(churn059).toBeDefined()
    expect(churn059!.dataSource).toBe("LIVE")
    expect(churn059!.walletFormatValid).toBe(true)
    expect(churn059!.trackedTicketCount).toBeGreaterThanOrEqual(1)

    // Deterministic priority sorting: DIVERGENCE_ALERT rows appear before VERIFIED_LIVE/UNLINKED_SHARP
    const firstVerifiedIdx = report.rows.findIndex((r) => r.status === "VERIFIED_LIVE")
    const lastDivergenceIdx = report.rows.findLastIndex((r) => r.status === "DIVERGENCE_ALERT")
    if (firstVerifiedIdx !== -1 && lastDivergenceIdx !== -1) {
      expect(lastDivergenceIdx).toBeLessThan(firstVerifiedIdx)
    }
  })

  test("flags QUARANTINED_WALLET for invalid EVM addresses, UNLINKED_SHARP for unmapped sharps, and WALLET_SOURCE_MISMATCH on conflict", () => {
    const rawGraphFeed = loadJson("docs/graph-live-feed.json")

    const quarantinedSharp: ShowcaseCustomer = {
      id: "BL4402",
      name: "BL4402 (Sharp Quarantine Test)",
      agentId: "AF420",
      masterAgent: "M_TEST",
      tier: "TIER_1_ELITE_ORIGINATOR",
      score: 8.6,
      action: "LIMIT_ALERT",
      clvScore: 8.4,
      timingScore: 7.9,
      sizingScore: 8.1,
      liquidityScore: 7.5,
      sigScore: 7.4,
      correlationScore: 7.2,
      holdPct: -4.2,
      ltvUsd: 120_000,
      meanStake: 3200,
      var95Usd: 18_000,
      recommendedLimitUsd: 2500,
      inPlayDelaySec: 8,
      lineShadeCents: 15,
      shadowCopyMultiplier: 1.5,
      timingArchetype: "STEAM_ORIGINATOR",
      ipAddress: "198.51.100.14",
      correlatedRisk: "HIGH",
      correlatedExploitRate: 0.42,
    }

    const unlinkedSharp: ShowcaseCustomer = {
      ...quarantinedSharp,
      id: "UNLINKED_SHARP_99",
      name: "Unlinked Sharp",
      score: 8.9,
    }

    const mismatchedSharp: ShowcaseCustomer = {
      ...quarantinedSharp,
      id: "MJ102",
      name: "MJ102 Mismatch Probe",
      score: 9.1,
      forensicDossier: {
        parlayBacktest: {
          rank: 1,
          totalParlayTickets: 20,
          totalParlayLegs: 48,
          totalParlayHandleUsd: 90_000,
          cfbParlayTickets: 8,
          nbaParlayTickets: 12,
          baselineDeskNetUsd: -15_000,
          protectedDeskNetUsd: 10_000,
          deskSavingsUsd: 25_000,
          probitRho: 0.65,
          primaryGuardTriggered: "GUARD_1",
          // Deliberately differs from MJ102's live feed proxyWallet
          proxyWallet: "0x1111111111111111111111111111111111111111",
          shortWallet: "0x1111...1111",
        },
        flaggedTickets: [],
      },
    }

    const report = buildSharpestOnChainXrefReport({
      profiles: [quarantinedSharp, unlinkedSharp, mismatchedSharp],
      rawGraphFeed,
      bridgeSnapshot: null,
    })

    const blRow = report.byCustomerId.get("BL4402")
    expect(blRow).toBeDefined()
    expect(blRow!.status).toBe("QUARANTINED_WALLET")
    expect(blRow!.flags).toContain("WALLET_ADDRESS_INVALID")
    expect(blRow!.walletFormatValid).toBe(false)

    const unlinkedRow = report.byCustomerId.get("UNLINKED_SHARP_99")
    expect(unlinkedRow).toBeDefined()
    expect(unlinkedRow!.status).toBe("UNLINKED_SHARP")
    expect(unlinkedRow!.flags).toContain("NO_ONCHAIN_ATTRIBUTION")
    expect(unlinkedRow!.dataSource).toBe("UNTRACKED")

    const mismatchRow = report.byCustomerId.get("MJ102")
    expect(mismatchRow).toBeDefined()
    expect(mismatchRow!.walletSourceMismatch).toBe(true)
    expect(mismatchRow!.flags).toContain("WALLET_SOURCE_MISMATCH")
    expect(mismatchRow!.status).toBe("DIVERGENCE_ALERT")
    expect(mismatchRow!.checksPassed).toBeLessThan(mismatchRow!.checksTotal)
  })
})
