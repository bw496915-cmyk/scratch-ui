import { describe, expect, test } from "bun:test"

import {
  buildEnrichedWebLogs,
  createWebLogStore,
  extractWebLogIngestRawText,
  parseFantasy402Action,
  parseRawWebLogText,
} from "../../server/weblog_inspect.ts"
import {
  buildSurveillanceBitmaskIndex,
  encodeWebLogSignalMask,
  WLOG_BIT_API_BLOCK,
} from "../../src/lib/telemetry_bitmask.ts"

const FANTASY402_ACCESS_LOG_LIST_FIXTURE = {
  LIST: [
    {
      AccessDateTime: "2026-11-16 18:01:44.120",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: "View Pending [ v1.0.287 | www.betolive.ag ]",
      Data: "",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:01:43.700",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: "Round Robin [ v1.0.287 | www.betolive.ag ]",
      Data: "Ticket : 1081067734 | ",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:01:43.653",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation:
        "Round Robin / Selections :    2s  3 Parlay(s)    3s  1 Parlay(s)  [ v1.0.287 | www.betolive.ag ]",
      Data: "Ticket : 1081067734 | ",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:01:43.547",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: "API LOG | ROUND ROBIN | Ticket: 1081067734",
      Data: "Selections : Football #285 Chargers +4½ -110 - For Game Football #311 Colts +500 - For Game Football #453 Buccaneers/Lions O 46½ -110 - For Game  | Risk : 150 Win : 3000",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:01:43.543",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation:
        " Chosen Team  : Indianapolis Colts | Game Num : 619135722 | Wager Number : 4 | Item Number : 2",
      Data: "",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:01:43.543",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation:
        " Chosen Team  : Tampa Bay Buccaneers/Detroit Lions | Game Num : 619135733 | Wager Number : 4 | Item Number : 3",
      Data: "",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:01:43.540",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: "API LOG | ROUND ROBIN | Ticket: 1081067734",
      Data: "Selections : Football #311 Colts +500 - For Game Football #453 Buccaneers/Lions O 46½ -110 - For Game  | Risk : 150 Win : 1500",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:01:43.540",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation:
        " Chosen Team  : Los Angeles Chargers | Game Num : 619129776 | Wager Number : 4 | Item Number : 1",
      Data: "",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:01:01.767",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: " (M) Parlay Lines Displayed (M)  [ v1.0.287 | www.betolive.ag ]",
      Data: "",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:00:54.990",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: " (M) Login successful (M)  [ v1.0.287 | www.betolive.ag ]",
      Data: "",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-16 18:00:54.940",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: "Login successful",
      Data: "Token",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-09 18:45:44.413",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: "SET OPEN PARLAY [ v1.0.283 | www.betolive.ag ]",
      Data: "Ticket : 1077530083 / 1 Open Spot(s)",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-09 18:45:44.200",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: "API LOG | PARLAY | Ticket: 1077530083",
      Data: "Risk:500 Win:1406.09",
      IPAddress: "23.114.233.204",
    },
    {
      AccessDateTime: "2026-11-09 18:45:23.097",
      ClientCode: "www.betolive.ag                         ",
      LoginID: "AF12                                              ",
      Operation: "Maximum wager amount for this selection is $500.00",
      Data: "LOG : Parlay-10 / Limit : 500 / Amount : 5000",
      IPAddress: "23.114.233.204",
    },
  ],
  INFO: "",
}

describe("Fantasy402 { LIST, INFO } AccessLog Ingestion & Forensics", () => {
  test("parseRawWebLogText unwraps { LIST: [...], INFO } and preserves padded IDs, portalHost, and ms timestamps", () => {
    const seeds = parseRawWebLogText(JSON.stringify(FANTASY402_ACCESS_LOG_LIST_FIXTURE))
    expect(seeds).toHaveLength(FANTASY402_ACCESS_LOG_LIST_FIXTURE.LIST.length)

    const { entries } = buildEnrichedWebLogs(seeds)
    expect(entries).toHaveLength(FANTASY402_ACCESS_LOG_LIST_FIXTURE.LIST.length)

    for (const entry of entries) {
      expect(entry.accountId).toBe("AF12")
      expect(entry.portalHost).toBe("www.betolive.ag")
      // Security Invariant F3: raw IPv4 address is always redacted
      expect(entry.ip).toMatch(/^23\.114\.233\.0\/24#[0-9a-f]{8}$/)
      expect(entry.ip).not.toContain("23.114.233.204")
      expect(entry.rawAction).not.toContain("23.114.233.204")
    }

    // Sub-second millisecond ordering preserved (18:01:43.547 > 18:01:43.543 > 18:01:43.540)
    const rrFull = entries[3]!
    const chosenColts = entries[4]!
    const rrTwoLeg = entries[6]!
    expect(rrFull.epochMs).toBeGreaterThan(chosenColts.epochMs)
    expect(chosenColts.epochMs).toBeGreaterThan(rrTwoLeg.epochMs)
    expect(rrFull.epochMs - rrTwoLeg.epochMs).toBe(7)
  })

  test("parseFantasy402Action classifies Round Robin, Parlay, Limit Rejections, Mobile (M), and Game Num", () => {
    const rr = parseFantasy402Action(
      "API LOG | ROUND ROBIN | Ticket: 1081067734 | Selections : Football #285 Chargers +4½ -110 | Risk : 150 Win : 3000",
    )
    expect(rr.eventKind).toBe("API_ROUND_ROBIN")
    expect(rr.actionMeta?.ticketId).toBe("1081067734")
    expect(rr.actionMeta?.riskUsd).toBe(150)
    expect(rr.actionMeta?.winUsd).toBe(3000)

    const chosen = parseFantasy402Action(
      "Chosen Team  : Indianapolis Colts | Game Num : 619135722 | Wager Number : 4 | Item Number : 2",
    )
    expect(chosen.eventKind).toBe("TEAM_CHOSEN")
    expect(chosen.actionMeta?.gameId).toBe("619135722")
    expect(chosen.actionMeta?.selectionSummary).toBe("Indianapolis Colts")

    const limit = parseFantasy402Action(
      "Maximum wager amount for this selection is $500.00 | LOG : Parlay-10 / Limit : 500 / Amount : 5000",
    )
    expect(limit.eventKind).toBe("WAGER_LIMIT")
    expect(limit.actionMeta?.limitUsd).toBe(500)
    expect(limit.actionMeta?.attemptedUsd).toBe(5000)

    const mobileLogin = parseFantasy402Action(
      "(M) Login successful (M)  [ v1.0.287 | www.betolive.ag ]",
    )
    expect(mobileLogin.eventKind).toBe("LOGIN_SUCCESS")
    expect(mobileLogin.clientVersion).toBe("v1.0.287")
    expect(mobileLogin.portalHost).toBe("www.betolive.ag")
    expect(mobileLogin.actionMeta?.channel).toBe("mobile")

    const parlay = parseFantasy402Action(
      "SET OPEN PARLAY [ v1.0.283 | www.betolive.ag ] | Ticket : 1077530083 / 1 Open Spot(s)",
    )
    expect(parlay.eventKind).toBe("API_PARLAY")
    expect(parlay.actionMeta?.ticketId).toBe("1077530083")
    expect(parlay.clientVersion).toBe("v1.0.283")
  })

  test("telemetry bitmask encodes LIMIT_REJECTED and indexes Game Num from AccessLog events", () => {
    const seeds = parseRawWebLogText(JSON.stringify(FANTASY402_ACCESS_LOG_LIST_FIXTURE))
    const { entries } = buildEnrichedWebLogs(seeds)
    const limitEntry = entries.find((e) => e.eventKind === "WAGER_LIMIT")!
    expect(limitEntry).toBeDefined()

    const mask = encodeWebLogSignalMask(limitEntry)
    expect((mask & WLOG_BIT_API_BLOCK) !== 0).toBe(true)

    const bitmaskIndex = buildSurveillanceBitmaskIndex({
      weblogs: entries,
      wagers: [],
      profiles: [],
    })
    expect(bitmaskIndex.entityIds).toContain("AF12")
  })

  test("createWebLogStore().query filters by ticketId, gameId, and portalHost and redacts raw IP", () => {
    const store = createWebLogStore()
    const { ingestedCount, result } = store.ingest(
      JSON.stringify(FANTASY402_ACCESS_LOG_LIST_FIXTURE),
    )
    expect(ingestedCount).toBe(FANTASY402_ACCESS_LOG_LIST_FIXTURE.LIST.length)
    expect(result.availableAccounts).toContain("AF12")

    const byHost = store.query({ q: "betolive.ag" })
    expect(byHost.entries).toHaveLength(FANTASY402_ACCESS_LOG_LIST_FIXTURE.LIST.length)

    const byTicket = store.query({ q: "1081067734" })
    expect(byTicket.entries.length).toBeGreaterThanOrEqual(4)

    const byGame = store.query({ q: "619135722" })
    expect(byGame.entries.length).toBe(1)
    expect(byGame.entries[0]?.gameId).toBe("619135722")

    const serialized = JSON.stringify(byHost)
    expect(serialized).not.toContain("23.114.233.204")
  })

  test("extractWebLogIngestRawText accepts both { rawText } and direct { LIST: [...] } JSON bodies", () => {
    const store = createWebLogStore()

    const directBodyText = extractWebLogIngestRawText(FANTASY402_ACCESS_LOG_LIST_FIXTURE)
    expect(directBodyText.length).toBeGreaterThan(0)
    const directRes = store.ingest(directBodyText)
    expect(directRes.ingestedCount).toBe(FANTASY402_ACCESS_LOG_LIST_FIXTURE.LIST.length)
    expect(directRes.result.availableAccounts).toContain("AF12")
    expect(JSON.stringify(directRes.result)).not.toContain("23.114.233.204")

    const wrappedBodyText = extractWebLogIngestRawText({
      rawText: JSON.stringify(FANTASY402_ACCESS_LOG_LIST_FIXTURE),
    })
    expect(store.ingest(wrappedBodyText).ingestedCount).toBe(
      FANTASY402_ACCESS_LOG_LIST_FIXTURE.LIST.length,
    )

    expect(extractWebLogIngestRawText({})).toBe("")
    expect(extractWebLogIngestRawText({ rawText: "" })).toBe("")
  })
})
