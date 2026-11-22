import { expect, test } from "bun:test"
import { executeNodeTerminalQuery } from "../server/adapters.ts"
import {
  formatProfileInspectPayload,
  normalizeRawCustomerToProfileRecord,
} from "../server/profile_inspect.ts"
import { projectRetainedCustomerHistory } from "../packages/backend/src/retained_customer_history.ts"

const identity = { customer_id: "ACCOUNT1", provenance: "projected-manager-roster" }
const history = projectRetainedCustomerHistory([
  [10000, 20000].map((stake, index) => ({
    CustomerID: "ACCOUNT1",
    TicketNumber: `T${index}`,
    WagerNumber: `W${index}`,
    AmountWagered: String(stake),
    AmountWon: "0",
    AmountLost: String(stake),
    AmountRefunded: "0",
    FreePlayFlag: "N",
    WagerStatus: "L",
    AcceptedDateTime: "2026-11-10 12:00:00",
    TicketWriter: "Internet",
  })),
]).records[0]!.metrics

function expectUnavailableRisk(record: ReturnType<typeof normalizeRawCustomerToProfileRecord>) {
  for (const field of [
    "score",
    "clvScore",
    "skillScore",
    "sizingScore",
    "sigScore",
    "timingScore",
    "var95Usd",
    "cvar95Usd",
    "ltvUsd",
    "recommendedLimitUsd",
    "lifetimeVolumeUsd",
    "lifetimeNetUsd",
    "betCount",
    "inPlayDelaySec",
    "lineShadeCents",
    "shadowCopyMultiplier",
  ]) {
    expect(Reflect.get(record, field) == null).toBe(true)
  }
  expect(Reflect.get(record, "masterAgent")).not.toBe("BILLY666")
}

function expectUnavailableSummary(payload: ReturnType<typeof formatProfileInspectPayload>) {
  expect(payload.summary).toMatchObject({
    avgSharpness: null,
    alertCount: null,
    totalVar95Usd: null,
    totalLimitCapUsd: null,
  })
}

test("identity-only live inspection withholds model, stake, and lifetime values", () => {
  const record = normalizeRawCustomerToProfileRecord(identity)
  expect(record.id).toBe("ACCOUNT1")
  expectUnavailableRisk(record)
  expect(record.meanStake).toBeNull()
  expect(record.gini).toBeNull()
  const payload = formatProfileInspectPayload({ profiles: [record], selectedId: record.id })
  expectUnavailableSummary(payload)
  expect(payload.profileAnsi).toContain("ACCOUNT1")
  expect(payload.profileAnsi).toMatch(/unavailable|unmeasured/i)
  expect(payload.profileAnsi).not.toMatch(/48,?500|BILLY666/)
})

test("raw live rows retain measured stake and Gini with retained scope", () => {
  const raw = { ...identity, retained_history: history }
  const record = normalizeRawCustomerToProfileRecord(raw)
  expect(record.meanStake).toBe(150)
  expect(record.gini).toBeCloseTo(1 / 6)
  expectUnavailableRisk(record)
  const payload = formatProfileInspectPayload({ profiles: [record], selectedId: record.id })
  expectUnavailableSummary(payload)
  expect(payload.profileAnsi).toMatch(/retained/i)
  expect(payload.profileAnsi).toContain("150")
})

test("terminal lookup fallback and list path preserve live unavailable values", async () => {
  const raw = { ...identity, retained_history: history }
  const record = normalizeRawCustomerToProfileRecord(raw)
  const baseDependencies = {
    findCustomerRow: async () => raw,
    getTiersConfig: async () => ({}),
    getLiveWagers: async () => ({ wagers: [] }),
  }
  for (const dependencies of [
    baseDependencies,
    { ...baseDependencies, listProfileRecords: async () => [record] },
  ]) {
    for (const suffix of ["", " --json", " --table", " --radar"]) {
      const result = await executeNodeTerminalQuery(
        `profile ACCOUNT1 --no-color${suffix}`,
        dependencies,
      )
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("ACCOUNT1")
      expect(result.stdout).not.toMatch(/48,?500|BILLY666|NaN/)
      if (!suffix) {
        expect(result.stdout).toMatch(/retained/i)
        expect(result.stdout).toContain("150")
      }
      if (suffix === " --json") {
        expect(result.stdout).toMatch(/meanStake:\s*150/)
        expect(result.stdout).toMatch(/score:\s*null/)
      }
    }
  }
})

test("explicit legacy fixture metrics remain inspectable", () => {
  const record = normalizeRawCustomerToProfileRecord({
    id: "FIXTURE_ACCOUNT",
    source: "fixture",
    score: 7,
    meanStake: 125,
    gini: 0.25,
    var95Usd: 200,
    recommendedLimitUsd: 500,
  })
  expect(record.score).toBe(7)
  expect(record.meanStake).toBe(125)
  expect(record.gini).toBe(0.25)
  const payload = formatProfileInspectPayload({ profiles: [record], selectedId: record.id })
  expect(payload.profileAnsi).toContain("FIXTURE_ACCOUNT")
  expect(payload.summary.avgSharpness).toBe(7)
})

test("invalid retained metrics cannot supply apparent measurements", () => {
  const record = normalizeRawCustomerToProfileRecord({
    ...identity,
    meanStake: 999999,
    gini: 0.7,
    retained_history: { ...history, wholeAccountHistory: true },
  })
  expect(record.meanStake).toBeNull()
  expect(record.gini).toBeNull()
  expectUnavailableRisk(record)
})

test("radar renders retained evidence through Bun and Node and keeps unmatched accounts distinct", async () => {
  const { inspect } = await import("node:util")
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { ProfileRadarView } = await import("../server/profile_inspect.ts")
  const { createProfileWeblogReader, restrictWeblogEvidenceToUniqueLogins } =
    await import("../server/profile_weblog_evidence.ts")
  const directory = await mkdtemp(join(tmpdir(), "profile-radar-weblog-"))
  const row = {
    LoginID: "account1",
    AccessDateTime: "2026-11-10 11:59:59.000",
    IPAddress: "192.0.2.51",
    Operation: "private example activity",
  }
  try {
    await writeFile(
      join(directory, "11-10-2026.jsonl"),
      [JSON.stringify(row), "{invalid"].join("\n"),
    )
    await writeFile(
      join(directory, "11-11-2026.jsonl"),
      [JSON.stringify(row), JSON.stringify({ ...row, LoginID: "ACCOUNT10" })].join("\n"),
    )
    const weblogEvidence = await createProfileWeblogReader(directory)()
    expect(weblogEvidence).toMatchObject({
      kind: "retained-mode-a",
      filesRead: 2,
      retainedRows: 2,
      invalidRows: 1,
      duplicateRows: 1,
    })
    const record = normalizeRawCustomerToProfileRecord({
      ...identity,
      login: "ACCOUNT1",
      retained_history: history,
    })
    const duplicateLogin = restrictWeblogEvidenceToUniqueLogins(weblogEvidence, [
      { customer_id: "A", login: "ACCOUNT1" },
      { customer_id: "B", login: "account1" },
    ])
    expect(new ProfileRadarView([record], { weblogEvidence: duplicateLogin }).toPlain()).toContain(
      "Weblogs withheld: ambiguous roster login",
    )
    const view = new ProfileRadarView([record], { weblogEvidence })
    const options = { colors: false, breakLength: 64, depth: 2, compact: false }
    for (const output of [Bun.inspect(view, options), inspect(view, options)]) {
      expect(output).toContain("[ProfileRadarView[Bun.inspect.custom]]")
      expect(output).toContain("Wagers 2 retained · 2 eligible")
      expect(output).toContain("Eligible stake $300.00")
      expect(output).toContain("Weblogs 1 rows · 1 source days")
      expect(output).toContain("CLV / Sharpness / Kelly: Unavailable")
      expect(output).not.toMatch(/192\.0\.2\.51|private example activity|ACCOUNT10/)
    }
    const missing = formatProfileInspectPayload({
      profiles: [record],
      selectedId: "ACCOUNT10",
      weblogEvidence,
    })
    expect(missing.selectedId).toBeNull()
    expect(missing.radarAnsi).toContain("No exact profile for ACCOUNT10")
    const result = await executeNodeTerminalQuery("profile ACCOUNT1 --radar --weblogs --no-color", {
      findCustomerRow: async () => null,
      listProfileRecords: async () => [record],
      getTiersConfig: async () => ({}),
      getLiveWagers: async () => ({ wagers: [] }),
      loadProfileWeblogs: async () => weblogEvidence,
      queryWebLogs: () => {
        throw new Error("Demo store must not be queried by radar")
      },
    })
    expect(result.stdout).toContain("Weblogs 1 rows")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
