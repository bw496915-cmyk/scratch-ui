import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createParlayComparison } from "../server/parlay_comparison.ts"
import { createRetainedWeblogReader } from "../server/profile_weblog_evidence.ts"
import { parseFantasy402Action } from "../server/weblog_inspect.ts"

const quote =
  "Football #451 Example +130 - For Game Hockey #471 Sample 3½ -135 - buying &amp;#189; For Game"
const time = "2026-11-19 23:38:13.530"
const earlierTime = "2026-11-18 23:38:13.530"
const tickerWager = {
  AgentID: "AGENT1",
  CustomerID: "ACCOUNT1",
  Login: "ACCOUNT1",
  WagerNumber: "101",
  WagerType: "P",
  InsertDateTime: time,
  TicketWriter: "GSBuilder",
  AmountWagered: 500,
  ToWinAmount: 1000,
  ShortDesc: quote,
}

test("concurrent readers share a retained weblog scan and pick up the next file update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sportsdesk-weblogs-"))
  const capture = join(dir, "11-19-2026.jsonl")
  const row = { LoginID: "ACCOUNT1", AccessDateTime: time, Operation: "View Pending" }
  try {
    await writeFile(capture, JSON.stringify(row) + "\n")
    const read = createRetainedWeblogReader(dir)
    const first = read()
    expect(read()).toBe(first)
    expect((await first).rows).toHaveLength(1)

    await writeFile(
      capture,
      [row, { ...row, Operation: "View Lines" }].map((entry) => JSON.stringify(entry)).join("\n") +
        "\n",
    )
    expect((await read()).rows).toHaveLength(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("parlay operations preserve leg prices and point buys without creating a ticket", () => {
  const result = parseFantasy402Action(`API LOG | PARLAY : ${quote}`)
  expect(result.eventKind).toBe("API_PARLAY_DESCRIPTION")
  expect(result.ticketNumber).toBeNull()
  expect(result.parlayLegs).toEqual([
    {
      sport: "Football",
      listedNumber: "451",
      period: "Game",
      market: null,
      selection: "Example",
      priceAmerican: "+130",
      pointsBought: null,
    },
    {
      sport: "Hockey",
      listedNumber: "471",
      period: "Game",
      market: null,
      selection: "Sample 3½",
      priceAmerican: "-135",
      pointsBought: "½",
    },
  ])
})

test("parlay comparison keeps ticker account scopes and weblog messages separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sportsdesk-parlays-"))
  const archive = join(dir, "bets.jsonl")
  try {
    await writeFile(
      archive,
      [
        tickerWager,
        tickerWager,
        { ...tickerWager, AgentID: "AGENT2" },
        {
          ...tickerWager,
          Login: "ACCOUNT2",
          WagerNumber: "102",
          TicketWriter: '<strong style="color:#d90000">ALERT</strong>',
        },
        { ...tickerWager, Login: "ACCOUNT3", WagerNumber: "103" },
        { ...tickerWager, Login: "ACCOUNT3", WagerNumber: "103", ShortDesc: "conflict" },
        { ...tickerWager, InsertDateTime: earlierTime },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    )
    const compare = createParlayComparison(archive, async () => ({
      rows: [
        {
          account: "ACCOUNT1",
          time: earlierTime,
          operation: `API LOG | PARLAY : ${quote}`,
          address: "",
        },
        {
          account: "ACCOUNT2",
          time: earlierTime,
          operation: "API LOG | PARLAY | Ticket: 1076964221",
          address: "",
        },
      ],
    }))
    const ticker = await compare({ source: "ticker", account: "ACCOUNT1, ACCOUNT2" })
    expect(ticker.available).toBe(true)
    if (!ticker.available) return
    expect(ticker.sourceDay).toBe("2026-11-19")
    expect(ticker.scopeCount).toBe(2)
    expect(ticker.accounts.map((x) => x.agent)).toEqual(["AGENT1", "AGENT2"])
    expect(ticker.total).toMatchObject({
      rows: 2,
      parsedRows: 2,
      twoLegRows: 2,
      mixedSportRows: 2,
      pointBuyRows: 2,
    })
    expect(ticker.excluded).toMatchObject({ duplicateRows: 1, sentinelRows: 1, conflictGroups: 1 })
    expect(await compare({ source: "ticker", day: "2026-11-18" })).toMatchObject({
      sourceDay: "2026-11-18",
      total: { rows: 1 },
    })
    const weblog = await compare({ source: "weblog" })
    expect(weblog.available).toBe(true)
    if (!weblog.available) return
    expect(weblog.sourceDay).toBe("2026-11-18")
    expect(weblog.total.rows).toBe(1)
    expect(weblog.accounts[0]).toMatchObject({ login: "ACCOUNT1", customer: null, agent: null })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("ticker comparison opens without weblog capture and keeps a final record without a newline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sportsdesk-parlays-"))
  const archive = join(dir, "bets.jsonl")
  try {
    await writeFile(archive, JSON.stringify(tickerWager))
    const compare = createParlayComparison(archive, async () => ({ rows: [] }))

    const expected = {
      available: true,
      sourceDay: "2026-11-19",
      total: { rows: 1, parsedRows: 1 },
      excluded: { invalidRows: 0 },
    }
    expect(await compare({ source: "ticker", day: "2026-11-19" })).toMatchObject(expected)
    expect(await compare({ source: "ticker" })).toMatchObject(expected)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("ticker comparison counts an incomplete final archive record as invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sportsdesk-parlays-"))
  const archive = join(dir, "bets.jsonl")
  try {
    await writeFile(archive, `${JSON.stringify(tickerWager)}\n{"WagerNumber":`)
    const compare = createParlayComparison(archive, async () => ({ rows: [] }))

    expect(await compare({ source: "ticker", day: "2026-11-19" })).toMatchObject({
      available: true,
      total: { rows: 1 },
      excluded: { invalidRows: 1 },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
