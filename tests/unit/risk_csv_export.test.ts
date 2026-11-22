import { describe, expect, test } from "bun:test"
import {
  buildLiveWagersCsvFilename,
  buildLiveWagersRiskCsv,
  buildRiskOverviewAccountsCsv,
  buildRiskOverviewCsvFilename,
  downloadRiskCsvBlob,
  escapeRiskCsvCell,
  LIVE_WAGERS_RISK_CSV_HEADERS,
  RISK_OVERVIEW_ACCOUNTS_CSV_HEADERS,
} from "../../packages/ui/src/risk_csv_export.ts"
import type { LiveWager, ShowcaseCustomer } from "../../packages/ui/src/types.ts"

function makeWager(overrides: Partial<LiveWager> = {}): LiveWager {
  return {
    ticketId: "TKT-9001",
    timestamp: "2026-11-21T16:45:00Z",
    customerId: "SHARP-101",
    agentId: "AG-42",
    masterAgent: "MA-07",
    ticketWriter: "GSLIVE",
    writer: "GSLIVE",
    sport: "NBA",
    subSport: "NBA Regular",
    betType: "SPREAD",
    event: "Lakers @ Celtics, TD Garden",
    selection: "Celtics -3.5",
    lineDisplay: "-3.5",
    oddsAmerican: "-110",
    riskUsd: 2200,
    toWinUsd: 2000,
    clvCents: 4.5,
    alertTier: "CRITICAL",
    alertBadge: "CRITICAL",
    operatorDirective: 'HOLD & SHADE "2c", notify desk',
    maxRecommendedStake: 1000,
    autoExecute: false,
    ...overrides,
  }
}

function makeCustomer(overrides: Partial<ShowcaseCustomer> = {}): ShowcaseCustomer {
  return {
    id: "SHARP-101",
    name: "Apex Syndicate, LLC",
    agentId: "AG-42",
    masterAgent: "MA-07",
    tier: "TIER_1_ELITE_ORIGINATOR",
    score: 94.2,
    clvScore: 96,
    skillScore: 92,
    sizingScore: 88,
    sigScore: 91,
    timingScore: 95,
    sizingStrategy: "KELLY",
    gini: 0.41,
    meanStake: 1850,
    specialization: "NBA",
    timingArchetype: "STEAM_CHASER",
    correlatedRisk: "CRITICAL",
    correlatedExploitRate: 0.72,
    syndicateRisk: "HIGH",
    syndicateProb: 0.864,
    subAccountIndex: null,
    var95Usd: 18450,
    cvar95Usd: 24900,
    holdPct: -4.2,
    ltvUsd: -38000,
    recommendedLimitUsd: 500,
    inPlayDelaySec: 8,
    lineShadeCents: 4,
    shadowCopyMultiplier: 1.5,
    action: "CAP TO $500 & SHADE 4c",
    ipAddress: "198.51.100.14",
    openRiskUsd: 1200,
    ...overrides,
  }
}

describe("risk_csv_export", () => {
  test("escapeRiskCsvCell enforces RFC 4180 quoting and preserves signed odds while neutralizing formulas", () => {
    expect(escapeRiskCsvCell(null)).toBe("")
    expect(escapeRiskCsvCell(undefined)).toBe("")
    expect(escapeRiskCsvCell("-110")).toBe("-110")
    expect(escapeRiskCsvCell("+145")).toBe("+145")
    expect(escapeRiskCsvCell("-3.5")).toBe("-3.5")
    expect(escapeRiskCsvCell("Lakers, Celtics")).toBe('"Lakers, Celtics"')
    expect(escapeRiskCsvCell('Quote "test"')).toBe('"Quote ""test"""')
    expect(escapeRiskCsvCell("Line1\nLine2")).toBe('"Line1\nLine2"')
    expect(escapeRiskCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)")
    expect(escapeRiskCsvCell("@cmd")).toBe("'@cmd")
    expect(escapeRiskCsvCell("+cmd|' /C calc'!A0")).toBe("'+cmd|' /C calc'!A0")
    expect(escapeRiskCsvCell("-2+3")).toBe("'-2+3")
  })

  test("buildLiveWagersRiskCsv emits full risk breach rows with payout and cap utilization", () => {
    const csv = buildLiveWagersRiskCsv([
      makeWager(),
      makeWager({
        ticketId: "TKT-9002",
        clvCents: null,
        oddsAmerican: "+150",
        riskUsd: 500,
        toWinUsd: 750,
        maxRecommendedStake: 0,
        alertTier: "STEAM",
        subSport: null,
      }),
    ])
    const lines = csv.split("\r\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(LIVE_WAGERS_RISK_CSV_HEADERS.join(","))
    expect(lines[1]).toContain("TKT-9001")
    expect(lines[1]).toContain('"Lakers @ Celtics, TD Garden"')
    expect(lines[1]).toContain("-3.5,-110,2200.00,2000.00,4200.00,4.50,CRITICAL,1000.00,220.0")
    expect(lines[1]).toContain('"HOLD & SHADE ""2c"", notify desk"')
    // Null CLV and zero maxRecommendedStake emit empty cells cleanly
    expect(lines[2]).toContain("+150,500.00,750.00,1250.00,,STEAM,0.00,,")
  })

  test("buildLiveWagersCsvFilename includes active filter slugs and ignores ALL", () => {
    const fixedDate = new Date("2026-11-21T12:00:00Z")
    expect(
      buildLiveWagersCsvFilename({
        alertFilter: "ALL",
        sportFilter: "ALL",
        channelFilter: "ALL",
        date: fixedDate,
      }),
    ).toBe("sportsdesk-risk-wagers-2026-11-21.csv")

    expect(
      buildLiveWagersCsvFilename({
        alertFilter: "CRITICAL",
        sportFilter: "NBA",
        channelFilter: "GSLIVE",
        date: fixedDate,
      }),
    ).toBe("sportsdesk-risk-wagers-critical-nba-gslive-2026-11-21.csv")
  })

  test("buildRiskOverviewAccountsCsv aggregates live open risk and flagged breach tickets per customer", () => {
    const customers = [
      makeCustomer(),
      makeCustomer({
        id: "SHARP-202",
        name: "Quiet Steam",
        tier: "TIER_2_STEAM_SYNDICATE",
        tierLabel: "Steam Syndicate",
        var95Usd: 9200,
        cvar95Usd: 13100,
        openRiskUsd: 3300,
      }),
    ]
    const wagers = [
      makeWager({ customerId: "SHARP-101", riskUsd: 2200, alertTier: "CRITICAL" }),
      makeWager({
        customerId: "SHARP-101",
        ticketId: "TKT-9003",
        riskUsd: 1800,
        alertTier: "STEAM",
      }),
      makeWager({
        customerId: "SHARP-101",
        ticketId: "TKT-9004",
        riskUsd: 400,
        alertTier: "BASELINE",
      }),
    ]

    const csv = buildRiskOverviewAccountsCsv(customers, wagers)
    const lines = csv.split("\r\n")
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(RISK_OVERVIEW_ACCOUNTS_CSV_HEADERS.join(","))
    expect(lines[1]).toContain('"Apex Syndicate, LLC"')
    // Open Risk = 2200 + 1800 + 400 = 4400.00, Flagged Breach Tickets = 2 (CRITICAL + STEAM)
    expect(lines[1]).toContain("18450.00,24900.00,500.00,4400.00,2,CAP TO $500 & SHADE 4c")
    // Second customer falls back to c.openRiskUsd when not in live tape
    expect(lines[2]).toContain("SHARP-202,Quiet Steam,AG-42,MA-07,Steam Syndicate")
    expect(lines[2]).toContain("9200.00,13100.00,500.00,3300.00,0,")
  })

  test("buildRiskOverviewCsvFilename formats ISO date cleanly", () => {
    expect(buildRiskOverviewCsvFilename(new Date("2026-11-21T08:30:00Z"))).toBe(
      "sportsdesk-risk-overview-breaches-2026-11-21.csv",
    )
  })

  test("downloadRiskCsvBlob writes UTF-8 BOM, triggers anchor click, and revokes object URL", async () => {
    let capturedBlob: Blob | null = null
    let clicked = false
    let removed = false
    let revokedUrl: string | null = null
    const createdLink = {
      href: "",
      download: "",
      style: { display: "" },
      click() {
        clicked = true
      },
      remove() {
        removed = true
      },
    }

    const ok = downloadRiskCsvBlob("A,B\r\n1,2", "breaches.csv", {
      document: {
        createElement: () => createdLink,
        body: {
          appendChild: () => createdLink,
        },
      },
      URL: {
        createObjectURL: (blob: Blob) => {
          capturedBlob = blob
          return "blob:mock-risk-csv"
        },
        revokeObjectURL: (url: string) => {
          revokedUrl = url
        },
      },
    })

    expect(ok).toBe(true)
    expect(clicked).toBe(true)
    expect(removed).toBe(true)
    expect(createdLink.download).toBe("breaches.csv")
    expect(createdLink.href).toBe("blob:mock-risk-csv")
    expect(revokedUrl).toBe("blob:mock-risk-csv")
    expect(capturedBlob).not.toBeNull()
    const bytes = new Uint8Array(await (capturedBlob as unknown as Blob).arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const text = await (capturedBlob as unknown as Blob).text()
    expect(text).toBe("A,B\r\n1,2")

    // Safe fallback when DOM APIs are absent
    expect(downloadRiskCsvBlob("A,B", "x.csv", { document: null, URL: null })).toBe(false)
  })
})
