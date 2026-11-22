import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectRetainedCustomerHistory } from "../packages/backend/src/retained_customer_history.ts"
import { createLiveCustomerBook } from "../packages/backend/src/live_customer_book.ts"
import { bookRowsToProfiles } from "../packages/ui/src/profile_rows.ts"
import { buildCustomerProfileFromRow, buildCustomerRatingFromRow } from "../server/adapters.ts"
import { parseCustomerRetainedHistory } from "../packages/contracts/src/customer_history.ts"
const row = (patch: Record<string, unknown> = {}) => ({
  CustomerID: "ACCOUNT1 ",
  TicketNumber: "T1",
  WagerNumber: "W1",
  PlayNumber: "1",
  AmountWagered: "10000.0",
  AmountWon: "9000.0",
  AmountLost: "0.0",
  AmountRefunded: "0.0",
  FreePlayFlag: "N",
  WagerStatus: "W",
  AcceptedDateTime: "2026-11-10 12:00:00.000",
  TicketWriter: "Internet",
  ...patch,
})
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
test("wire cents, profit semantics, native-wager grain and retained denominators", () => {
  const win = row(),
    loss = row({
      TicketNumber: "T2",
      WagerNumber: "W2",
      AmountWagered: "20000",
      AmountWon: "0",
      AmountLost: "20000",
      WagerStatus: "L",
      AcceptedDateTime: "2026-11-11 12:00:00.000",
    })
  const result = projectRetainedCustomerHistory([[win, loss], [{ ...win, PlayNumber: "2" }]])
  expect(result.summary.duplicates).toBe(1)
  const m = result.records[0]!.metrics
  expect(m.eligibleWagers).toBe(2)
  expect(m.stakeUsd).toBe(300)
  expect(m.reportedNetUsd).toBe(-110)
  expect(m.meanStakeUsd).toBe(150)
  expect(m.medianStakeUsd).toBe(150)
  expect(m.p95StakeUsd).toBe(200)
  expect(m.stakeGini).toBeCloseTo(1 / 6)
  expect(m.provisionalRoiPct).toBeCloseTo((-110 / 300) * 100)
  expect(m.sourceDays).toBe(2)
  expect(m.wholeAccountHistory).toBe(false)
  expect(parseCustomerRetainedHistory(m)).toEqual(m)
  expect(JSON.stringify(m)).not.toContain("T1")
})
test("conflicting copies are withheld, rather than selecting the last row", () => {
  const result = projectRetainedCustomerHistory([[row()], [row({ AmountWon: "8000" })]])
  const m = result.records[0]!.metrics
  expect(m.conflictingWagers).toBe(1)
  expect(m.eligibleWagers).toBe(0)
  expect(m.reportedNetUsd).toBeNull()
  expect(m.stakeUsd).toBeNull()
})
test("unsupported statuses, missing finance, free plays and refunds remain outside the ratio", () => {
  const result = projectRetainedCustomerHistory([
    [
      row(),
      row({ WagerNumber: "W2", WagerStatus: "X" }),
      row({ WagerNumber: "W3", AmountWon: undefined }),
      row({ WagerNumber: "W4", FreePlayFlag: "Y" }),
      row({ WagerNumber: "W5", AmountRefunded: "10000" }),
      row({ WagerNumber: "W6", TicketWriter: " ALERT " }),
    ],
  ])
  expect(result.summary.excludedWriterRows).toBe(1)
  expect(result.records[0]!.metrics).toMatchObject({
    retainedWagers: 5,
    eligibleWagers: 1,
    excludedWagers: 4,
    reportedNetUsd: 90,
    stakeUsd: 100,
    stakeGini: null,
  })
  expect(
    projectRetainedCustomerHistory([[row(), row({ CustomerID: "ACCOUNT2" })]]).records,
  ).toHaveLength(2)
})
test("exact roster aliases join private metrics; risk models and lifetime figures remain null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sportsdesk-history-"))
  dirs.push(dir)
  const roster = join(dir, "roster.json"),
    history = join(dir, "history.json")
  await writeFile(
    roster,
    JSON.stringify({
      schemaVersion: 1,
      agents: [],
      players: [
        { customerId: "NATIVE1", login: "ACCOUNT1", agent: "AG" },
        { customerId: "NO_HISTORY", login: "NONE", agent: "AG" },
      ],
    }),
  )
  const projection = {
    ...projectRetainedCustomerHistory([[row()]]),
    generatedAt: "2026-11-19T00:00:00Z",
  }
  await writeFile(history, JSON.stringify(projection))
  const service = createLiveCustomerBook(roster, history),
    book = await service.load(),
    found = await service.find("NATIVE1")
  expect(book?.historyCoverage.matchedAccounts).toBe(1)
  const customer = bookRowsToProfiles([found!], "book")[0]!
  expect(customer.meanStake).toBe(100)
  expect(customer.unknown).not.toContain("meanStake")
  expect(customer.unknown).toEqual(
    expect.arrayContaining(["sharpness", "clv", "limit", "var95", "ltv", "sizing"]),
  )
  const profile = buildCustomerProfileFromRow(found!, "NATIVE1")
  expect(profile.meanStakeUsd).toBe(100)
  expect(profile.lifetimeVolumeUsd).toBeNull()
  expect(buildCustomerRatingFromRow(found!, "NATIVE1").bayesianSkill).toBeNull()
  expect((await service.find("NO_HISTORY"))?.retained_history).toBeUndefined()
  await writeFile(
    history,
    JSON.stringify({
      ...projection,
      records: [{ customerKey: "ACCOUNT1", metrics: { invented: true } }],
    }),
  )
  const invalid = await service.load()
  expect(invalid?.historyCoverage.status).toBe("invalid")
  expect((await service.find("NATIVE1"))?.retained_history).toBeUndefined()
})
test("reused roster login aliases never merge two accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sportsdesk-history-"))
  dirs.push(dir)
  const roster = join(dir, "roster.json"),
    history = join(dir, "history.json")
  await writeFile(
    roster,
    JSON.stringify({
      schemaVersion: 1,
      agents: [],
      players: [
        { customerId: "N1", login: "ACCOUNT1" },
        { customerId: "N2", login: "ACCOUNT1" },
      ],
    }),
  )
  await writeFile(
    history,
    JSON.stringify({
      ...projectRetainedCustomerHistory([[row()]]),
      generatedAt: "2026-11-19T00:00:00Z",
    }),
  )
  const result = await createLiveCustomerBook(roster, history).load()
  expect(result?.historyCoverage.ambiguousHistoryKeys).toBe(1)
  expect(result?.historyCoverage.matchedAccounts).toBe(0)
  expect(result?.rows.every((r) => r.retained_history === undefined)).toBe(true)
})
