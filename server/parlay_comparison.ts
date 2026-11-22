import { open } from "node:fs/promises"
import type {
  ParlayAccountComposition,
  ParlayComparisonResponse,
  ParlayComparisonSource,
  ParlayComposition,
  ParsedParlayLeg,
} from "@sportsdesk-ops/contracts"
import {
  isPartialParlayPeriod,
  parseParlayLegs,
  readParlayOperation,
} from "../lib/parlay_description.ts"
import { isSentinelTickerWriter } from "../packages/backend/src/wagers.ts"
import type { RetainedWeblogRow } from "./profile_weblog_evidence.ts"

const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const ARCHIVE_CACHE_MS = 10_000
const SOURCE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/

interface TickerObservation {
  readonly day: string
  readonly agent: string
  readonly customer: string
  readonly login: string
  readonly id: string
  readonly type: string
  readonly writer: string
  readonly stake: string
  readonly toWin: string
  readonly description: string
}

interface TickerArchive {
  readonly bytes: number
  readonly records: readonly TickerObservation[]
  readonly malformed: number
  readonly latestDay: string | null
}

type ParlayScope = Pick<ParlayAccountComposition, "login" | "agent" | "customer">
interface ParlayObservation extends ParlayScope {
  readonly legs: readonly ParsedParlayLeg[] | null
}

const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value).trim() : ""

function readTickerObservation(value: unknown): TickerObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value))
  const time = text(fields.InsertDateTime)
  if (!SOURCE_TIME.test(time)) return null
  return {
    day: time.slice(0, 10),
    agent: text(fields.AgentID),
    customer: text(fields.CustomerID),
    login: text(fields.Login),
    id: text(fields.WagerNumber),
    type: text(fields.WagerType).toUpperCase(),
    writer: text(fields.TicketWriter)
      .replace(/^<strong\b[^>]*>([^<]*)<\/strong>$/i, "$1")
      .trim(),
    stake: text(fields.AmountWagered),
    toWin: text(fields.ToWinAmount),
    description: text(fields.ShortDesc),
  }
}

async function readTickerArchive(path: string): Promise<TickerArchive | null> {
  const file = await open(path, "r").catch(() => null)
  if (!file) return null
  try {
    const info = await file.stat()
    if (!info.isFile()) return null
    const start = Math.max(0, info.size - MAX_ARCHIVE_BYTES)
    const buffer = Buffer.alloc(info.size - start)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, start + offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const lines = buffer.subarray(0, offset).toString("utf8").split("\n")
    const records: TickerObservation[] = []
    let malformed = 0
    let latestDay: string | null = null
    for (const line of lines.slice(start === 0 ? 0 : 1)) {
      if (!line.trim()) continue
      try {
        const value: unknown = JSON.parse(line)
        const record = readTickerObservation(value)
        if (record) {
          records.push(record)
          if (latestDay === null || record.day > latestDay) latestDay = record.day
        } else {
          malformed++
        }
      } catch {
        malformed++
      }
    }
    return { bytes: offset, records, malformed, latestDay }
  } catch {
    return null
  } finally {
    await file.close()
  }
}

function summarizeParlays(rows: readonly ParlayObservation[]): ParlayComposition {
  const legCounts: number[] = []
  const mixes = new Map<string, number>()
  let twoLegRows = 0
  let mixedSportRows = 0
  let partialPeriodRows = 0
  let missingPeriodRows = 0
  let pointBuyRows = 0
  for (const { legs } of rows) {
    if (!legs) continue
    legCounts.push(legs.length)
    const sports = [...new Set(legs.map(({ sport }) => sport))].sort()
    const mix = sports.join(" + ")
    mixes.set(mix, (mixes.get(mix) ?? 0) + 1)
    if (legs.length === 2) twoLegRows++
    if (sports.length > 1) mixedSportRows++
    if (legs.some(({ period }) => isPartialParlayPeriod(period))) partialPeriodRows++
    if (legs.some(({ period }) => !period)) missingPeriodRows++
    if (legs.some(({ pointsBought }) => pointsBought)) pointBuyRows++
  }
  legCounts.sort((a, b) => a - b)
  const low = legCounts[Math.floor((legCounts.length - 1) / 2)]
  const high = legCounts[Math.floor(legCounts.length / 2)]
  const top = [...mixes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return {
    rows: rows.length,
    parsedRows: legCounts.length,
    medianLegs: low !== undefined && high !== undefined ? (low + high) / 2 : null,
    twoLegRows,
    mixedSportRows,
    partialPeriodRows,
    missingPeriodRows,
    pointBuyRows,
    topMix: top ? { label: top[0], rows: top[1] } : null,
  }
}

interface ParlayComparisonQuery {
  readonly source: ParlayComparisonSource
  readonly day?: string | undefined
  readonly account?: string | undefined
}

export function createParlayComparison(
  tickerPath: string | undefined,
  readWeblogs: () => Promise<{ readonly rows: readonly RetainedWeblogRow[] }>,
) {
  let archiveCache: { expiresAt: number; loading: Promise<TickerArchive | null> } | undefined
  return async function compareParlays(
    query: ParlayComparisonQuery,
  ): Promise<ParlayComparisonResponse> {
    const { source } = query
    let sourceDay = query.day || null
    const rows: ParlayObservation[] = []
    let archiveBytes: number | null = null
    let duplicateRows = 0
    let conflictGroups = 0
    let sentinelRows = 0
    let invalidRows = 0
    if (source === "weblog") {
      const { rows: logs } = await readWeblogs()
      sourceDay ??= logs.reduce<string | null>((latest, row) => {
        const day = row.time.slice(0, 10)
        return day && (latest === null || day > latest) ? day : latest
      }, null)
      if (!sourceDay)
        return {
          source,
          available: false,
          sourceDay,
          reason: "Choose a date with retained activity.",
        }
      for (const row of logs) {
        if (!row.time.startsWith(sourceDay)) continue
        const description = readParlayOperation(row.operation)
        if (!description) continue
        rows.push({
          login: row.account,
          customer: null,
          agent: null,
          legs: parseParlayLegs(description),
        })
      }
    } else {
      if (!tickerPath)
        return { source, available: false, sourceDay, reason: "Ticker archive is unconfigured." }
      if (!archiveCache || archiveCache.expiresAt <= Date.now()) {
        archiveCache = {
          expiresAt: Date.now() + ARCHIVE_CACHE_MS,
          loading: readTickerArchive(tickerPath),
        }
      }
      const archive = await archiveCache.loading
      if (!archive)
        return { source, available: false, sourceDay, reason: "Ticker archive is unavailable." }
      sourceDay ??= archive.latestDay
      if (!sourceDay)
        return {
          source,
          available: false,
          sourceDay,
          reason: "Choose a date with retained activity.",
        }
      archiveBytes = archive.bytes
      invalidRows = archive.malformed
      const tickets = new Map<
        string,
        {
          record: TickerObservation
          signature: string
          parlayRows: number
          conflicting: boolean
        }
      >()
      for (const record of archive.records) {
        if (record.day !== sourceDay) continue
        const parlay = record.type === "P"
        if (isSentinelTickerWriter(record.writer)) {
          if (parlay) sentinelRows++
          continue
        }
        const { agent, customer, login, id, type, description, writer, stake, toWin } = record
        if (
          !agent ||
          !customer ||
          !login ||
          !/^\d+$/.test(id) ||
          !Number.isFinite(Number(stake)) ||
          Number(stake) <= 0
        ) {
          if (parlay) invalidRows++
          continue
        }
        const key = JSON.stringify([agent, customer, login, id])
        const signature = JSON.stringify([type, description, writer.toLowerCase(), stake, toWin])
        const existing = tickets.get(key)
        if (existing) {
          existing.parlayRows += Number(parlay)
          existing.conflicting ||= signature !== existing.signature
        } else {
          tickets.set(key, { record, signature, parlayRows: Number(parlay), conflicting: false })
        }
      }
      for (const { record, parlayRows, conflicting } of tickets.values()) {
        if (!parlayRows) continue
        if (conflicting) {
          conflictGroups++
          continue
        }
        duplicateRows += parlayRows - 1
        rows.push({
          login: record.login,
          customer: record.customer,
          agent: record.agent,
          legs: parseParlayLegs(record.description),
        })
      }
    }

    const groups = new Map<string, { scope: ParlayScope; rows: ParlayObservation[] }>()
    for (const { login, customer, agent, legs } of rows) {
      const key = JSON.stringify([agent, customer, login])
      const group = groups.get(key) ?? { scope: { login, customer, agent }, rows: [] }
      group.rows.push({ login, customer, agent, legs })
      groups.set(key, group)
    }
    const requested = (query.account ?? "")
      .split(",")
      .map((account) => account.trim().toLowerCase())
      .filter(Boolean)
    const matching = [...groups.values()].filter(
      ({ scope: { agent, customer, login } }) =>
        requested.length === 0 ||
        requested.some((account) =>
          [login, customer, agent].some((value) => value?.toLowerCase().includes(account)),
        ),
    )
    const accounts = matching
      .map(({ scope, rows }) => ({ ...scope, ...summarizeParlays(rows) }))
      .sort(
        (a, b) => b.parsedRows - a.parsedRows || b.rows - a.rows || a.login.localeCompare(b.login),
      )
      .slice(0, 20)

    return {
      source,
      available: true,
      sourceDay,
      archiveBytes,
      scopeCount: groups.size,
      matchingScopeCount: matching.length,
      total: summarizeParlays(rows),
      accounts,
      excluded: { duplicateRows, conflictGroups, sentinelRows, invalidRows },
    }
  }
}
