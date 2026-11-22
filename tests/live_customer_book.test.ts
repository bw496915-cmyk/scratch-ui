import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { computeCustomersCohortPayload } from "../packages/backend/src/customers.ts"
import { createLiveCustomerBook } from "../packages/backend/src/live_customer_book.ts"
import {
  deriveCustomerCohortKpiCards,
  normalizeCustomersCohortResponse,
} from "../packages/ui/src/hydration.ts"
import { bookRowsToProfiles } from "../packages/ui/src/profile_rows.ts"
import { classifyCustomerProfileType } from "../packages/ui/src/profile_taxonomy.ts"
import { buildCustomerProfileFromRow, buildCustomerRatingFromRow } from "../server/adapters.ts"
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})
test("live roster projects identities, deduplicates and never invents risk metrics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sportsdesk-live-book-"))
  directories.push(dir)
  const file = join(dir, "roster.json")
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      capturedAt: "2026-11-19T23:00:00Z",
      agents: [],
      players: [
        {
          customerId: "ACCOUNT1 ",
          login: "login1",
          agent: "AGENT",
          password: "must-not-leak",
          sharp_score: 99,
        },
        { customerId: "ACCOUNT1", agent: "AGENT" },
      ],
    }),
  )
  const source = createLiveCustomerBook(file)
  const book = await source.load()
  expect(book?.rows).toHaveLength(1)
  expect(JSON.stringify(book?.rows)).not.toContain("must-not-leak")
  expect(book?.provenance.observedAt).toBe("2026-11-19T23:00:00Z")
  expect(await source.find("account1")).toEqual(book?.rows[0])
  expect(buildCustomerProfileFromRow(book!.rows[0]!, "ACCOUNT1").lifetimeVolumeUsd).toBeNull()
  expect(buildCustomerRatingFromRow(book!.rows[0]!, "ACCOUNT1").bayesianSkill).toBeNull()
  const mapped = bookRowsToProfiles(book?.rows ?? [], "book")[0]!
  expect(mapped.unknown).toEqual(
    expect.arrayContaining(["sharpness", "clv", "limit", "ltv", "holdPct"]),
  )
  expect(mapped.action).toBe("UNMEASURED")
  expect(classifyCustomerProfileType(mapped).id).toBe("UNMEASURED")
  const payload = computeCustomersCohortPayload({
    backtestLeaderboard: [],
    fixtures: [],
    keyNumberBuyerIds: [],
    hookSyndicateIds: [],
    localBookRows: book?.rows ?? [],
    provenance: book?.provenance,
  })
  expect(normalizeCustomersCohortResponse(payload)?.bookRows).toHaveLength(1)
  expect(payload.cohorts.fixtureCount).toBe(0)
  const normalized = normalizeCustomersCohortResponse(payload)!
  expect(
    deriveCustomerCohortKpiCards({ report: normalized, status: "ready" }).find(
      (card) => card.id === "key-number-sharps",
    )?.count,
  ).toBeNull()
})
test("missing and invalid sources cannot fall back to fixtures", async () => {
  expect(await createLiveCustomerBook(undefined).load()).toBeNull()
  await expect(createLiveCustomerBook("/nonexistent/live-roster.json").load()).rejects.toThrow()
  const dir = await mkdtemp(join(tmpdir(), "sportsdesk-live-book-"))
  directories.push(dir)
  const file = join(dir, "roster.json")
  await writeFile(file, JSON.stringify([{ customer_id: "SYNTH_DEMO" }]))
  await expect(createLiveCustomerBook(file).load()).rejects.toThrow("projected manager roster")
  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 1, agents: [], players: [{ customerId: "SYNTH_DEMO" }] }),
  )
  await expect(createLiveCustomerBook(file).load()).rejects.toThrow("Synthetic identity")
})
