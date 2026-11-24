/**
 * Offline graded-export projection. Inputs are retained source observations, not verified lifecycle
 * records.
 */
import type { CustomerRetainedHistory } from "@sportsdesk-ops/contracts"
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")
function cents(v: unknown): number | null {
  if (typeof v !== "number" && (typeof v !== "string" || !/^\d+(?:\.0+)?$/.test(v.trim())))
    return null
  const n = Number(v)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}
interface Observation {
  customer: string
  stake: number | null
  won: number | null
  lost: number | null
  refund: number | null
  status: string
  free: string
  time: string
  fingerprint: string
  conflict: boolean
}
export function projectRetainedCustomerHistory(sources: readonly unknown[]) {
  const unique = new Map<string, Observation>()
  let inputRows = 0,
    duplicates = 0,
    invalidIdentityRows = 0,
    excludedWriterRows = 0
  for (const source of sources) {
    if (!Array.isArray(source))
      throw new Error("Graded history must be an array of provider export rows")
    for (const raw of source) {
      if (++inputRows > 1_000_000)
        throw new Error("Retained history exceeds one million source rows")
      if (!record(raw)) throw new Error("Graded history contains a non-object row")
      const writer = text(raw.TicketWriter).toUpperCase()
      if (writer === "ALERT" || writer === "BLOCKED") {
        excludedWriterRows++
        continue
      }
      const customer = text(raw.CustomerID).toUpperCase(),
        ticket = text(raw.TicketNumber),
        wager = text(raw.WagerNumber)
      if (!customer || !ticket || !wager) {
        invalidIdentityRows++
        continue
      }
      if (/^(SYNTH_|DEMO_|FIXTURE_)/.test(customer))
        throw new Error("Synthetic identity rejected from retained history")
      const stake = cents(raw.AmountWagered),
        won = cents(raw.AmountWon),
        lost = cents(raw.AmountLost),
        refund = cents(raw.AmountRefunded),
        status = text(raw.WagerStatus).toUpperCase(),
        free = text(raw.FreePlayFlag).toUpperCase(),
        time = text(raw.AcceptedDateTime)
      const fingerprint = JSON.stringify([stake, won, lost, refund, status, free, time])
      const key = JSON.stringify([customer, ticket, wager])
      const old = unique.get(key)
      if (old) {
        if (old.fingerprint === fingerprint) duplicates++
        else old.conflict = true
        continue
      }
      unique.set(key, {
        customer,
        stake,
        won,
        lost,
        refund,
        status,
        free,
        time,
        fingerprint,
        conflict: false,
      })
    }
  }
  const accounts = new Map<
    string,
    {
      retained: number
      excluded: number
      conflicts: number
      wins: number
      losses: number
      stake: number
      net: number
      stakes: number[]
      days: Set<string>
      first: string | null
      last: string | null
    }
  >()
  for (const row of unique.values()) {
    let a = accounts.get(row.customer)
    if (!a) {
      a = {
        retained: 0,
        excluded: 0,
        conflicts: 0,
        wins: 0,
        losses: 0,
        stake: 0,
        net: 0,
        stakes: [],
        days: new Set(),
        first: null,
        last: null,
      }
      accounts.set(row.customer, a)
    }
    a.retained++
    if (row.conflict) {
      a.conflicts++
      continue
    }
    if (
      row.free !== "N" ||
      row.refund !== 0 ||
      !(row.status === "W" || row.status === "L") ||
      row.stake === null ||
      row.stake <= 0 ||
      row.won === null ||
      row.lost === null
    ) {
      a.excluded++
      continue
    }
    a.stake += row.stake
    a.net += row.won - row.lost
    a.stakes.push(row.stake)
    if (row.status === "W") a.wins++
    else a.losses++
    if (!Number.isSafeInteger(a.stake) || !Number.isSafeInteger(a.net))
      throw new Error("Retained monetary totals exceed exact integer range")
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(row.time)) {
      const t = row.time.replace("T", " ")
      a.days.add(t.slice(0, 10))
      if (a.first === null || t < a.first) a.first = t
      if (a.last === null || t > a.last) a.last = t
    }
  }
  const records: Array<{ customerKey: string; metrics: CustomerRetainedHistory }> = []
  for (const [customerKey, a] of accounts) {
    const stakes = a.stakes.sort((x, y) => x - y),
      n = stakes.length
    let weighted = 0
    for (let i = 0; i < n; i++) weighted += (i + 1) * stakes[i]!
    const metrics: CustomerRetainedHistory = {
      basis: "source-reported-retained-wagers",
      wholeAccountHistory: false,
      currency: "USD",
      retainedWagers: a.retained,
      eligibleWagers: n,
      excludedWagers: a.excluded,
      conflictingWagers: a.conflicts,
      wins: a.wins,
      losses: a.losses,
      firstSourceTime: a.first,
      lastSourceTime: a.last,
      sourceTimeZone: "unverified-provider-wall-time",
      sourceDays: a.days.size,
      stakeUsd: n ? a.stake / 100 : null,
      meanStakeUsd: n ? a.stake / n / 100 : null,
      medianStakeUsd: n
        ? (n % 2 ? stakes[Math.floor(n / 2)]! : (stakes[n / 2 - 1]! + stakes[n / 2]!) / 2) / 100
        : null,
      p95StakeUsd: n ? stakes[Math.ceil(n * 0.95) - 1]! / 100 : null,
      maxStakeUsd: n ? stakes[n - 1]! / 100 : null,
      stakeGini: n >= 2 ? (2 * weighted) / (n * a.stake) - (n + 1) / n : null,
      reportedNetUsd: n ? a.net / 100 : null,
      provisionalRoiPct: n ? (a.net / a.stake) * 100 : null,
      reportedWinPct: n ? (a.wins / n) * 100 : null,
    }
    records.push({ customerKey, metrics })
  }
  return {
    schemaVersion: 1 as const,
    kind: "f402-retained-wager-metrics" as const,
    wholeAccountHistory: false as const,
    summary: {
      inputRows,
      uniqueWagers: unique.size,
      duplicates,
      invalidIdentityRows,
      excludedWriterRows,
      accounts: records.length,
    },
    records,
  }
}
