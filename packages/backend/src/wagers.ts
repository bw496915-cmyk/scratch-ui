/**
 * Live wager normalization and risk classification (`autoExecute: false`).
 *
 * @file Packages/backend/src/wagers.ts
 */

import { readFile } from "node:fs/promises"
import { basename, relative, resolve } from "node:path"

import type { DashboardSourceProvenance, WagerTier } from "@sportsdesk-ops/contracts"

import { BoundedStampCache, statStamp } from "./cache.ts"

export interface ParsedShortDescLeg {
  readonly sport?: string | undefined
  readonly game?: string | undefined
  readonly pick?: string | undefined
}

export interface ParsedShortDescLike {
  readonly isLive?: boolean | undefined
  readonly legs: readonly ParsedShortDescLeg[]
}

export function isSentinelTickerWriter(raw: unknown): boolean {
  if (typeof raw !== "string") return false
  const normalized = raw.trim().toUpperCase()
  return normalized === "ALERT" || normalized === "BLOCKED"
}

export interface ProjectedDevWagerRow {
  readonly ticketId: string
  readonly timestamp: string
  readonly customerId: string
  readonly agentId: string
  readonly masterAgent: string
  readonly ticketWriter: string
  readonly sport: string
  /** Operator label derived from {@link ProjectedDevWagerRow.wagerTypeCode}. */
  readonly betType: string
  /**
   * Raw wire `WagerType`, upper-cased and trimmed, preserved so the derivation is auditable. The
   * wire value is never rewritten; `betType` is a separate declared projection of it.
   */
  readonly wagerTypeCode: string
  /** True when the wire carried a code the projection cannot label statically. */
  readonly unknownWagerType: boolean
  readonly event: string
  readonly selection: string
  readonly lineDisplay: string
  readonly oddsAmerican: string
  readonly riskUsd: number
  readonly volumeUsd?: number
  readonly toWinUsd: number
  /** Real CLV in cents, or null when no closing-line comparison exists. */
  readonly clvCents: number | null
  readonly vip: boolean
  readonly isSentinelNoise: boolean
  readonly alertTier: WagerTier
  readonly alertBadge: string
  readonly operatorDirective: string
  readonly maxRecommendedStake: number
  readonly autoExecute: false
}

export interface LiveWagersPayload {
  readonly wagers: ReadonlyArray<Record<string, unknown>>
  readonly totalRiskUsd: number
  readonly totalToWinUsd: number
  readonly criticalSteamCount: number
  readonly autoExecute: false
  readonly timestamp: string
  readonly provenance: DashboardSourceProvenance
  /** Host-supplied raw-row conformance check (see lib/wagers_wire_contract.ts). */
  readonly wire_contract?: unknown
  /** Host-supplied slab policy summary (see config/slab.toml). */
  readonly slab_policy?: unknown
}

export interface ProjectLiveWagerDeps {
  readonly parseShortDesc: (raw: unknown) => ParsedShortDescLike
  readonly sharpCustomerIds: ReadonlySet<string>
}

function readWagerAmount(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || value.trim() === ""))
    return undefined
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined
}

function isPlaceholderOddsToken(raw: string): boolean {
  const normalized = raw.trim().toLowerCase()
  return (
    normalized === "" ||
    normalized === "—" ||
    normalized === "–" ||
    normalized === "-" ||
    normalized === "n/a" ||
    normalized === "null" ||
    normalized === "undefined"
  )
}

function extractSingleLegAmericanOdds(pick: string | undefined): string | null {
  if (!pick) return null
  const cleaned = pick.trim().replace(/\s+/g, " ")
  if (!cleaned) return null
  const match = /(?:^|\s)([+-]\d{3,5})$/.exec(cleaned)
  if (match?.[1]) {
    const parsed = Number.parseInt(match[1], 10)
    if (Number.isFinite(parsed) && Math.abs(parsed) >= 100) {
      return match[1]
    }
  }
  if (/(?:^|\s)(?:EV|EVEN)$/i.test(cleaned)) {
    return "+100"
  }
  return null
}

/** Project a measured ticker row. Missing identity or amounts make it unusable in aggregate totals. */
export function projectLiveWagerRow(
  item: Record<string, unknown>,
  deps: ProjectLiveWagerDeps,
): (ProjectedDevWagerRow & Record<string, unknown>) | null {
  const id = item.WagerNumber ?? item.ticketId
  const ticketId = typeof id === "string" || typeof id === "number" ? String(id).trim() : ""
  const riskUsd = readWagerAmount(item.AmountWagered ?? item.amountWagered ?? item.riskUsd)
  const toWinUsd = readWagerAmount(item.ToWinAmount ?? item.toWinUsd ?? item.toWinAmount)
  if (!ticketId || riskUsd === undefined || toWinUsd === undefined) return null
  const parsed = deps.parseShortDesc(item.ShortDesc ?? item.shortDesc ?? item.description ?? "")
  const firstLeg = parsed.legs[0]
  const customerId = String(
    item.CustomerID ?? item.customerId ?? item.Login ?? item.login ?? "—",
  ).trim()
  const isSharp = deps.sharpCustomerIds.has(customerId.toUpperCase())
  // No invented CLV: a row without an explicit closing-line comparison reports null.
  const clvCents =
    typeof item.clvCents === "number" && Number.isFinite(item.clvCents) ? item.clvCents : null

  let alertTier: WagerTier = "RECREATIONAL"
  let alertBadge = "✅ RECREATIONAL"
  let operatorDirective = "Accept Normal (autoExecute: false)"
  let maxRecommendedStake = 25000

  if ((clvCents !== null && clvCents >= 10) || isSharp) {
    alertTier = "CRITICAL"
    alertBadge = isSharp ? "🚨 CRITICAL (T1 Originator)" : "🚨 CRITICAL (High CLV)"
    operatorDirective = "Clamp Max $250 (autoExecute: false)"
    maxRecommendedStake = 250
  } else if (clvCents !== null && clvCents >= 5) {
    alertTier = "STEAM"
    alertBadge = "⚡ STEAM (Line Mover)"
    operatorDirective = "Clamp Max $500 (autoExecute: false)"
    maxRecommendedStake = 500
  } else if (parsed.isLive || Boolean(item.live)) {
    alertTier = "LATENCY"
    alertBadge = "⚠️ LATENCY (In-Play)"
    operatorDirective = "Delay 3s + Cap $1,000 (autoExecute: false)"
    maxRecommendedStake = 1000
  }

  const ticketWriter =
    typeof item.TicketWriter === "string" && item.TicketWriter.trim() !== ""
      ? item.TicketWriter.trim()
      : typeof item.ticketWriter === "string" && item.ticketWriter.trim() !== ""
        ? item.ticketWriter.trim()
        : typeof item.writer === "string" && item.writer.trim() !== ""
          ? item.writer.trim()
          : "—"
  const sentinelNoise = isSentinelTickerWriter(ticketWriter)
  const volumeUsd = readWagerAmount(item.VolumeAmount ?? item.volumeAmount ?? item.volumeUsd)
  const vip = item.VIP === true || item.vip === true || String(item.VIP ?? "").trim() === "1"
  const wagerTypeProjection = projectWagerType(item)
  const rawOdds = typeof item.oddsAmerican === "string" ? item.oddsAmerican.trim() : ""
  const resolvedOdds = !isPlaceholderOddsToken(rawOdds)
    ? rawOdds
    : wagerTypeProjection.wagerTypeCode !== "P" && parsed.legs.length === 1
      ? (extractSingleLegAmericanOdds(firstLeg?.pick) ?? "—")
      : "—"

  return {
    ticketId,
    timestamp: String(item.InsertDateTime ?? item.timestamp ?? "—"),
    customerId,
    agentId: String(item.AgentID ?? item.agentId ?? "—").trim(),
    masterAgent: String(item.AgentLogin ?? item.masterAgent ?? "—").trim(),
    ticketWriter,
    sport: String(
      firstLeg?.sport?.toUpperCase() ||
        (item.sport === undefined || item.sport === null ? "" : String(item.sport).toUpperCase()),
    ),
    subSport: (() => {
      const rawSubSport = item.SubSport ?? item.subSport ?? item.SportSubType
      const normalized =
        rawSubSport === undefined || rawSubSport === null ? "" : String(rawSubSport).trim()
      return normalized === "" ? null : normalized.toUpperCase()
    })(),
    // Declared projection of the raw wire code, not a rewrite of it:
    // `wagerTypeCode` keeps what the vendor sent, `betType` is the label.
    ...wagerTypeProjection,
    event: String(firstLeg?.game || (item.event ?? "—")),
    selection: String(firstLeg?.pick || (item.selection ?? "—")),
    lineDisplay: String(firstLeg?.pick || (item.lineDisplay ?? "—")),
    oddsAmerican: resolvedOdds,
    riskUsd,
    ...(volumeUsd === undefined ? {} : { volumeUsd }),
    toWinUsd,
    clvCents,
    vip,
    isSentinelNoise: sentinelNoise,
    alertTier,
    alertBadge,
    operatorDirective,
    maxRecommendedStake,
    autoExecute: false as const,
  }
}

/**
 * Wire `WagerType` -> operator label.
 *
 * Mirrors the pinned vendor bundle's `getTypeInfo` switch
 * (`verification/manager-boot-oracle/pinned/util.js`, v43.0.27), ported as `getVendorWagerTypeInfo`
 * in `lib/f402_core_vendor.ts`. The two contextual codes (`I`, `G`) are deliberately absent: the
 * vendor resolves them from `birdCage`/`ARLink`/`PlacedOn`, which this projection does not receive,
 * so they surface as `Unknown (<code>)` instead of being guessed.
 *
 * `tests/wagers_field_roundtrip.test.ts` asserts this table agrees with the vendor function for
 * every code it covers.
 */
const WAGER_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  A: "Manual Play",
  C: "Future/Props",
  E: "Team Total",
  L: "Total",
  M: "Moneyline",
  P: "Parlay",
  S: "Spread",
  T: "Teaser",
})

export const WAGER_TYPE_UNKNOWN_PREFIX = "Unknown"

function projectWagerType(item: Record<string, unknown>): {
  readonly wagerTypeCode: string
  readonly betType: string
  readonly unknownWagerType: boolean
} {
  const wagerTypeCode = String(item.WagerType ?? item.wagerType ?? "")
    .trim()
    .toUpperCase()
  if (wagerTypeCode === "") {
    // No wire code on the row: keep a caller-supplied label (showcase rows).
    return {
      wagerTypeCode: "",
      betType: String(item.betType ?? "Unknown"),
      unknownWagerType: false,
    }
  }
  const label = WAGER_TYPE_LABELS[wagerTypeCode]
  return {
    wagerTypeCode,
    betType: label ?? `${WAGER_TYPE_UNKNOWN_PREFIX} (${wagerTypeCode})`,
    unknownWagerType: label === undefined,
  }
}

export interface DevLiveWagersLoaderOptions {
  readonly cwd?: string | undefined
  readonly candidatePaths?: readonly string[] | undefined
  readonly loadSharpDeps: () => Promise<ProjectLiveWagerDeps>
  /**
   * Optional raw-row inspector, called with the pre-projection rows. The host injects the vendor
   * contract check here so this package stays vendor-agnostic. A throw is reported as `{ error }`
   * rather than failing the feed.
   */
  readonly inspectRawRows?:
    ((rows: readonly Record<string, unknown>[]) => unknown | Promise<unknown>) | undefined
  /**
   * Optional slab-policy descriptor. The host injects the validated `config/slab.toml` summary so
   * this package stays config-agnostic.
   */
  readonly describeSlab?: (() => unknown) | undefined
}

export interface WagerSourceDescriptor {
  readonly kind: "capture" | "fixture" | "live"
  readonly label: string
  readonly sourcePath: string
}

export interface DevLiveWagersLoadResult {
  readonly rows: Array<Record<string, unknown>>
  /** Every row read from disk, including sentinel-noise rows (wire conformance scope). */
  readonly rawRows?: readonly Record<string, unknown>[] | undefined
  readonly observedAt?: string
  readonly omittedRowCount?: number
  readonly latestTicketTime?: string
  readonly partial?: boolean
  readonly rawRowCount?: number | undefined
  readonly sentinelNoiseCount?: number | undefined
  readonly source: WagerSourceDescriptor | null
}

/**
 * Classify a candidate wager JSON path as `"capture"` vs `"fixture"` without leaking absolute host
 * paths.
 */
export function classifyWagerCandidateSource(
  candidatePath: string,
  cwd: string,
): WagerSourceDescriptor {
  const rel = relative(cwd, candidatePath).replace(/\\/g, "/")
  const safePath =
    rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : basename(candidatePath)
  const normFull = candidatePath.replace(/\\/g, "/").toLowerCase()
  if (normFull.includes("/fixtures/") || basename(normFull).includes("fixture")) {
    return {
      kind: "fixture",
      label: "Synthetic Fixture",
      sourcePath: safePath,
    }
  }
  return {
    kind: "capture",
    label: "Local Capture",
    sourcePath: safePath,
  }
}

function isWagerRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readCaptureTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    return ""
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms <= Date.now() + 5_000 ? new Date(ms).toISOString() : ""
}

/** Create a stat-cached live wagers loader + KPI aggregator for the dashboard backend. */
export function createDevLiveWagersLoader(options: DevLiveWagersLoaderOptions) {
  const cwd = options.cwd ?? process.cwd()
  const candidatePaths = options.candidatePaths ?? [resolve(cwd, "data/live-wagers.json")]
  const cache = new BoundedStampCache<DevLiveWagersLoadResult>(8)

  const loadDevLiveWagersDetailed = async (): Promise<DevLiveWagersLoadResult> => {
    for (const candidatePath of candidatePaths) {
      const stamp = await statStamp(candidatePath)
      if (stamp === null) continue

      const hit = cache.getIfFresh(candidatePath, stamp)
      if (hit !== undefined) return hit

      try {
        const data: unknown = JSON.parse(await readFile(candidatePath, "utf8"))
        const metadata = isWagerRecord(data) ? data : null
        const list: unknown[] | null = Array.isArray(metadata?.LIST)
          ? metadata.LIST
          : Array.isArray(metadata?.wagers)
            ? metadata.wagers
            : Array.isArray(data)
              ? data
              : null

        if (list !== null) {
          const sharpDeps = await options.loadSharpDeps()
          const rawRows = list.filter(isWagerRecord)
          const projected = rawRows.flatMap((item) => {
            const wager = projectLiveWagerRow(item, sharpDeps)
            return wager ? [wager] : []
          })
          const actionableRows = projected.filter((row) => !row.isSentinelNoise)
          const latestTicketTime = actionableRows.reduce((latest, row) => {
            const time = row.timestamp.replace("T", " ")
            return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(time) && time > latest
              ? time
              : latest
          }, "")
          const frozenRawRows = Object.freeze(rawRows.map((row) => Object.freeze(row)))
          const observedAt = readCaptureTime(metadata?.observedAt ?? metadata?.capturedAt)
          const candidate = classifyWagerCandidateSource(candidatePath, cwd)
          const source =
            candidate.kind === "capture" &&
            observedAt !== "" &&
            metadata?.source === `live:/cloud/api/Manager/getBetTicker@${metadata?.observedAt}`
              ? { ...candidate, kind: "live" as const, label: "Fantasy402 Bet Ticker" }
              : candidate
          const result: DevLiveWagersLoadResult = {
            rows: actionableRows,
            rawRows: frozenRawRows,
            rawRowCount: list.length,
            sentinelNoiseCount: projected.length - actionableRows.length,
            observedAt,
            omittedRowCount: list.length - projected.length,
            latestTicketTime,
            partial: metadata?.partial === true,
            source,
          }
          cache.set(candidatePath, stamp, result)
          return result
        }
      } catch {
        // Unreadable captures cannot support wager totals.
      }
    }
    return { rows: [], source: null }
  }

  const loadDevLiveWagers = async (): Promise<Array<Record<string, unknown>>> => {
    const detailed = await loadDevLiveWagersDetailed()
    return detailed.rows
  }

  const buildLiveWagersPayload = async (): Promise<LiveWagersPayload> => {
    const nowIso = new Date().toISOString()
    const loaded = await loadDevLiveWagersDetailed()
    const wagers: ReadonlyArray<Record<string, unknown>> = loaded.rows
    const allRowsInvalid =
      (loaded.rawRowCount ?? 0) > 0 && loaded.omittedRowCount === loaded.rawRowCount
    const provenance: DashboardSourceProvenance =
      loaded.source !== null
        ? {
            kind: allRowsInvalid ? "unavailable" : loaded.source.kind,
            label: allRowsInvalid ? "Capture contained no usable wager rows" : loaded.source.label,
            sourcePath: loaded.source.sourcePath,
            observedAt: loaded.observedAt ?? "",
            ...(loaded.partial ? { partial: true } : {}),
            ...(loaded.latestTicketTime ? { latestTicketTime: loaded.latestTicketTime } : {}),
            ...(loaded.omittedRowCount ? { omittedRowCount: loaded.omittedRowCount } : {}),
          }
        : {
            kind: "unavailable",
            label: "Wager capture missing or unreadable",
            sourcePath: candidatePaths[0]
              ? classifyWagerCandidateSource(candidatePaths[0], cwd).sourcePath
              : null,
            observedAt: "",
          }

    let wire_contract: unknown
    const rawRows = loaded.rawRows ?? loaded.rows
    if (options.inspectRawRows && rawRows.length > 0) {
      try {
        wire_contract = await options.inspectRawRows(rawRows)
      } catch (err) {
        wire_contract = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    const slab_policy = options.describeSlab?.()

    return {
      wagers,
      ...(wire_contract === undefined ? {} : { wire_contract }),
      ...(slab_policy === undefined ? {} : { slab_policy }),
      totalRiskUsd: wagers.reduce((sum, w) => sum + (Number(w.riskUsd) || 0), 0),
      totalToWinUsd: wagers.reduce((sum, w) => sum + (Number(w.toWinUsd) || 0), 0),
      criticalSteamCount: wagers.filter(
        (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
      ).length,
      autoExecute: false,
      timestamp: nowIso,
      provenance,
    }
  }

  return {
    loadDevLiveWagers,
    loadDevLiveWagersDetailed,
    buildLiveWagersPayload,
    clearCache: () => cache.clear(),
  }
}
