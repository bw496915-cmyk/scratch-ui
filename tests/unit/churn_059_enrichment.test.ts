import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  applyGraphForensicsToProfiles,
  formatFreshnessDuration,
  indexGraphLiveFeedForensics,
  parseProbitRho,
} from "../../packages/ui/src/customer_forensics.ts"
import { backtestRowsToProfiles } from "../../packages/ui/src/profile_rows.ts"
import { classifyCustomerProfile, customerMatchesSearch } from "../../packages/ui/src/profile_taxonomy.ts"

const ROOT = resolve(import.meta.dir, "../..")
const backtestRaw = JSON.parse(readFileSync(resolve(ROOT, "docs/backtest-4wk-cfb-nba.json"), "utf8")) as {
  customerLeaderboard: Record<string, unknown>[]
}
const graphLiveFeedRaw = JSON.parse(readFileSync(resolve(ROOT, "docs/graph-live-feed.json"), "utf8")) as Record<
  string,
  unknown
>

describe("CHURN_059 forensic backtest & 10-mode graph enrichment", () => {
  test("parses Probit rho and formats stale telemetry freshness durations", () => {
    expect(parseProbitRho("PROBIT SUBSET GUARD BLOCKED (ρ=0.756)")).toBe(0.756)
    expect(parseProbitRho("rho=0.68")).toBe(0.68)
    expect(parseProbitRho("no correlation")).toBeNull()
    expect(formatFreshnessDuration(196040)).toBe("54h 27m")
    expect(formatFreshnessDuration(24)).toBe("24s")
  })

  test("hydrates CHURN_059 parlay backtest metrics, hold, LTV, correlation, and sharpness decomposition", () => {
    const profiles = backtestRowsToProfiles(backtestRaw.customerLeaderboard)
    const churn059 = profiles.find((p) => p.id === "CHURN_059")
    expect(churn059).toBeDefined()

    expect(churn059!.agentId).toBe("LAKERS")
    expect(churn059!.masterAgent).toBe("BILLY666")
    expect(churn059!.score).toBe(8.87)
    expect(churn059!.holdPct).toBe(-49.91)
    expect(churn059!.ltvUsd).toBe(-114800)
    expect(churn059!.meanStake).toBe(4600)
    expect(churn059!.correlatedRisk).toBe("CRITICAL")
    expect(churn059!.correlatedExploitRate).toBe(0.76)
    expect(churn059!.action).toBe("ALERT_OPERATOR")
    expect(churn059!.sizingScore).toBeGreaterThan(0)
    expect(churn059!.sigScore).toBeGreaterThan(0)
    expect(churn059!.timingScore).toBeGreaterThan(0)

    const unknown = churn059!.unknown ?? []
    expect(unknown).not.toContain("holdPct")
    expect(unknown).not.toContain("ltv")
    expect(unknown).not.toContain("correlation")

    const pb = churn059!.forensicDossier?.parlayBacktest
    expect(pb).toBeDefined()
    expect(pb!.rank).toBe(4)
    expect(pb!.totalParlayTickets).toBe(50)
    expect(pb!.totalParlayLegs).toBe(114)
    expect(pb!.totalParlayHandleUsd).toBe(230000)
    expect(pb!.cfbParlayTickets).toBe(12)
    expect(pb!.nbaParlayTickets).toBe(38)
    expect(pb!.baselineDeskNetUsd).toBe(-114800)
    expect(pb!.protectedDeskNetUsd).toBe(35700)
    expect(pb!.deskSavingsUsd).toBe(150500)
    expect(pb!.probitRho).toBe(0.756)
    expect(pb!.primaryGuardTriggered).toBe("GUARD_1_PROBIT_ALT_SUBSET_BLOCK")
    expect(pb!.shortWallet).toBe("0x88d1...99c0")
  })

  test("attaches Cross-Office Beard Bridge, Mode 6 non-overlap distinction, Mode 1 telemetry gaps, and blocked ticket", () => {
    const baseProfiles = backtestRowsToProfiles(backtestRaw.customerLeaderboard)
    const forensicsIndex = indexGraphLiveFeedForensics(graphLiveFeedRaw)
    const enriched = applyGraphForensicsToProfiles(baseProfiles, forensicsIndex)

    const churn059 = enriched.find((p) => p.id === "CHURN_059")
    expect(churn059).toBeDefined()
    expect(churn059!.ipAddress).toBe("192.168.9.42")
    expect(churn059!.syndicateProb).toBe(0.93)
    expect(churn059!.syndicateRisk).toBe("HIGH")
    expect(churn059!.unknown ?? []).not.toContain("syndicate")

    const dossier = churn059!.forensicDossier!
    expect(dossier.beardBridge).toBeDefined()
    expect(dossier.beardBridge!.groupId).toBe("SHARED-IP-GRP-12")
    expect(dossier.beardBridge!.matchClassification).toBe("CROSS_OFFICE_BEARD_BRIDGE")
    expect(dossier.beardBridge!.mfcsCompositeScore).toBe(93)
    expect(dossier.beardBridge!.modeASessionDwellSeconds).toBe(4.6)
    expect(dossier.beardBridge!.activeRotations).toEqual(["ROT 5501", "ROT 501"])
    expect(dossier.beardBridge!.crossOfficeTwins).toEqual([{ loginId: "CHURN_049", officeAgentId: "SOUTHSHORE" }])

    expect(dossier.activityOverlap).toBeDefined()
    expect(dossier.activityOverlap!.distinctionVerdict).toBe("NEARBY_POINT_EVENTS_WITHOUT_SESSION_OVERLAP")
    expect(dossier.activityOverlap!.gapBetweenWindowsSeconds).toBe(24)
    expect(dossier.activityOverlap!.overlapDurationSeconds).toBe(0)

    expect(dossier.telemetryOverview).toBeDefined()
    expect(dossier.telemetryOverview!.gsLivePlayerId).toBe("player_CHURN_059")
    expect(dossier.telemetryOverview!.validatedNetUsd).toBe(19400)
    expect(dossier.telemetryOverview!.pendingStakeUsd).toBe(18000)
    expect(dossier.telemetryOverview!.pendingDefinedLiabilityUsd).toBe(43200)
    expect(dossier.telemetryOverview!.isAccessFresh).toBe(false)
    expect(dossier.telemetryOverview!.missingDataWarnings).toEqual([
      "STALE_ACCESS_TELEMETRY_54H",
      "WEBLOG_MODE_A_COLLECTION_GAP",
    ])

    expect(dossier.flaggedTickets).toHaveLength(1)
    expect(dossier.flaggedTickets[0]!.ticketId).toBe("F402-901003-ALT")
    expect(dossier.flaggedTickets[0]!.riskUsd).toBe(18000)
    expect(dossier.flaggedTickets[0]!.toWinUsd).toBe(43200)
    expect(dossier.flaggedTickets[0]!.deskVerdict).toContain("ρ=0.756")

    // Symmetric twin linkage on CHURN_049
    const churn049Dossier = forensicsIndex.get("CHURN_049")
    expect(churn049Dossier?.beardBridge?.crossOfficeTwins).toEqual([{ loginId: "CHURN_059", officeAgentId: "LAKERS" }])
  })

  test("derives forensic taxonomy tags and matches forensic search terms for CHURN_059", () => {
    const baseProfiles = backtestRowsToProfiles(backtestRaw.customerLeaderboard)
    const forensicsIndex = indexGraphLiveFeedForensics(graphLiveFeedRaw)
    const enriched = applyGraphForensicsToProfiles(baseProfiles, forensicsIndex)
    const churn059 = enriched.find((p) => p.id === "CHURN_059")!

    const classification = classifyCustomerProfile(churn059)
    const tagLabels = classification.tags.map((t) => t.label)
    expect(tagLabels).toContain("PROBIT-BLOCK")
    expect(tagLabels).toContain("BEARD-BRIDGE")
    expect(tagLabels).toContain("POLYMARKET-LINK")
    expect(tagLabels).toContain("TELEMETRY-GAP")

    expect(customerMatchesSearch(churn059, "CHURN_049", classification)).toBe(true)
    expect(customerMatchesSearch(churn059, "192.168.9.42", classification)).toBe(true)
    expect(customerMatchesSearch(churn059, "SHARED-IP-GRP-12", classification)).toBe(true)
    expect(customerMatchesSearch(churn059, "F402-901003-ALT", classification)).toBe(true)
    expect(customerMatchesSearch(churn059, "0x88d1", classification)).toBe(true)
  })
})
