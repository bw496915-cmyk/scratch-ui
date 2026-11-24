import { expect, test } from "bun:test"

import { projectRetainedCustomerHistory } from "../packages/backend/src/retained_customer_history.ts"
import { backtestRowsToProfiles, bookRowsToProfiles, mergeProfileRows } from "../packages/ui/src/profile_rows.ts"
import { executeNodeTerminalQuery } from "../server/adapters.ts"
import { stripAnsi } from "../server/desk_inspect.ts"
import {
  computeBayesianKelly,
  deriveSharpnessAxes,
  formatProfileInspectPayload,
  normalizeRawCustomerToProfileRecord,
} from "../server/profile_inspect.ts"

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
  for (const dependencies of [baseDependencies, { ...baseDependencies, listProfileRecords: async () => [record] }]) {
    for (const suffix of ["", " --json", " --table", " --radar"]) {
      const result = await executeNodeTerminalQuery(`profile ACCOUNT1 --no-color${suffix}`, dependencies)
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
    await writeFile(join(directory, "11-10-2026.jsonl"), [JSON.stringify(row), "{invalid"].join("\n"))
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

test("backtest BGD101 takes precedence over synthetic duplicate fixture and normalizes accurately", async () => {
  const backtestJson = (await Bun.file("docs/backtest-4wk-cfb-nba.json").json()) as {
    customerLeaderboard: Array<Record<string, unknown>>
  }
  const fixtureRows = (await Bun.file("tests/fixtures/backtest/enriched_customers_full.json").json()) as Array<
    Record<string, unknown>
  >

  const merged = mergeProfileRows(
    backtestRowsToProfiles(backtestJson.customerLeaderboard),
    bookRowsToProfiles(fixtureRows, "fixture"),
  )
  const bgdMerged = merged.find((row) => row.id === "BGD101")
  expect(bgdMerged).toBeDefined()
  expect(bgdMerged?.agentId).toBe("BIGDAD")
  expect(bgdMerged?.source).toBe("backtest")
  expect(bgdMerged?.meanStake).toBe(5000)

  const rawBacktestBgd = backtestJson.customerLeaderboard.find((r) => r.customerId === "BGD101")!
  const record = normalizeRawCustomerToProfileRecord({ ...rawBacktestBgd, source: "backtest" })
  expect(record.kind).toBe("modeled")
  if (record.kind !== "modeled") return

  expect(record.agentId).toBe("BIGDAD")
  expect(record.masterAgent).toBe("BILLY666")
  expect(record.score).toBe(9.1)
  expect(record.meanStake).toBe(5000)
  expect(record.holdPct).toBe(-49.23)
  expect(record.ltvUsd).toBe(-152600)
  expect(record.lifetimeVolumeUsd).toBe(310000)
  expect(record.lifetimeNetUsd).toBe(-152600)
  expect(record.betCount).toBe(62)
  expect(record.specialization).toBe("NBA_ALT_SPREAD_5000_SUBSET")
  // Unmeasured book fields stay explicitly flagged instead of fabricated
  expect(record.unknown).toContain("gini")
  expect(record.unknown).toContain("syndicate")
  expect(record.unknown).toContain("var95")
  expect(record.unknown).toContain("limit")
  expect(record.unknown).toContain("shade")
  expect(record.unknown).toContain("copy")

  const axisSum = Number(
    (record.clvScore + record.skillScore + record.sizingScore + record.sigScore + record.timingScore).toFixed(2),
  )
  expect(axisSum).toBeCloseTo(record.score, 2)
})

test("5-axis sharpness decomposition reconciles cleanly up to 10.0/10.0", () => {
  for (const [score, clvBps] of [
    [10.0, 999],
    [10.0, 0],
    [9.1, 295],
    [7.4, 120],
    [3.5, 0],
  ] as const) {
    const axes = deriveSharpnessAxes(score, clvBps)
    const sum = Number(
      (axes.clvScore + axes.skillScore + axes.sizingScore + axes.sigScore + axes.timingScore).toFixed(2),
    )
    expect(axes.clvScore).toBeLessThanOrEqual(3.0)
    expect(axes.skillScore).toBeLessThanOrEqual(2.5)
    expect(axes.sizingScore).toBeLessThanOrEqual(1.5)
    expect(axes.sigScore).toBeLessThanOrEqual(2.0)
    expect(axes.timingScore).toBeLessThanOrEqual(1.0)
    expect(sum).toBeCloseTo(score, 2)
  }
})

test("computeBayesianKelly reflects desk-net sign convention and avoids arbitrary $50 floor", () => {
  const winningBettor = normalizeRawCustomerToProfileRecord({
    id: "SHARP_WIN",
    score: 9.1,
    meanStake: 5000,
    lifetimeNetUsd: -152600,
  })
  const losingBettor = normalizeRawCustomerToProfileRecord({
    id: "SHARP_LOSE",
    score: 9.1,
    meanStake: 5000,
    lifetimeNetUsd: 152600,
  })
  const microStakeBettor = normalizeRawCustomerToProfileRecord({
    id: "MICRO_1",
    score: 10.0,
    meanStake: 1,
    lifetimeNetUsd: -1,
  })
  const negativeEdgeBettor = normalizeRawCustomerToProfileRecord({
    id: "REC_1",
    score: 4.0,
    meanStake: 500,
    lifetimeNetUsd: 25000,
  })

  if (
    winningBettor.kind !== "modeled" ||
    losingBettor.kind !== "modeled" ||
    microStakeBettor.kind !== "modeled" ||
    negativeEdgeBettor.kind !== "modeled"
  ) {
    throw new Error("Expected modeled records")
  }

  const winBk = computeBayesianKelly(winningBettor)
  const loseBk = computeBayesianKelly(losingBettor)
  const microBk = computeBayesianKelly(microStakeBettor)
  const recBk = computeBayesianKelly(negativeEdgeBettor)

  // Desk loss (negative lifetimeNetUsd) means bettor is winning -> higher posterior win rate
  expect(winBk.posteriorWinRate).toBeGreaterThan(loseBk.posteriorWinRate)
  expect(winBk.impliedEdgePct).toBeGreaterThan(loseBk.impliedEdgePct)
  // $1 mean stake should never be floored to $50
  expect(microBk.quarterKellyStakeUsd).toBe(1)
  // Negative edge -> zero Kelly stake
  expect(recBk.fullKelly).toBe(0)
  expect(recBk.quarterKellyStakeUsd).toBe(0)
})

test("ProfileView omits fabricated unmeasured telemetry and aligns --options CLI banner", () => {
  const sparse = normalizeRawCustomerToProfileRecord({
    customer_id: "SPARSE_SHARP",
    agent_id: "BIGDAD",
    master_agent: "BILLY666",
    sharp_score: 99.9,
    lifetime_volume_usd: 100000,
    lifetime_net_usd: -40000,
    hold_pct: -40,
    wager_limit_usd: 5000,
    delay_seconds: 0,
  })
  const payload = formatProfileInspectPayload({
    profiles: [sparse],
    selectedId: "SPARSE_SHARP",
    options: { colors: false, getters: true, maxArrayLength: 20, breakLength: 96 },
    showOptions: true,
  })

  const plainProfile = stripAnsi(payload.profileAnsi)
  expect(plainProfile).not.toContain("Gini=0.19")
  expect(plainProfile).not.toContain("Synd=HIGH (76%)")
  expect(plainProfile).not.toContain("Corr=HIGH (38%)")
  expect(plainProfile).not.toContain("Copy=1.50x")
  expect(plainProfile).not.toContain("Shade: 10¢")
  expect(plainProfile).toContain("Gini=—")
  expect(plainProfile).toContain("Shade: —")
  expect(plainProfile).toContain("Syndicate / Parlay   —")

  // Bottom --options banner CLI line must include --options to match top profileCliCommand
  expect(payload.cliFlags).toContain("--options")
  expect(payload.profileCliCommand).toBe("profile SPARSE_SHARP --no-color --getters --max-array=20 --options")
  expect(plainProfile).toContain("CLI: --no-color --getters --max-array=20 --options")
  expect(stripAnsi(payload.cohortAnsi)).toContain("CLI: --no-color --getters --max-array=20 --options")
  expect(stripAnsi(payload.radarAnsi)).toContain("CLI: --no-color --getters --max-array=20 --options")
  expect(stripAnsi(payload.tableAnsi)).toContain("CLI: --no-color --getters --max-array=20 --options")
})
