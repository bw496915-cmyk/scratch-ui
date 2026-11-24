/**
 * Bitwise SoA telemetry encoder & cross-feed correlator uniting Weblogs (`WebLogEntry`), Live
 * Wagers (`LiveWager`), and Profiles (`ProfileInspectRecord`). Design mirrors
 * `packages/contracts/src/slice_data_table.ts`:
 *
 * - Single-pass `Uint32` bitmasks (`>>> 0`) computed once per parsed record.
 * - Fixed-width `Uint32Array` SoA columns + `(count + 31) >>> 5` entity bitsets.
 * - 64-bit (2x `Uint32`) FNV-1a Bloom signature per entity for O(1) candidate pruning before exact
 *   ID/game/subnet correlation joins.
 *
 * @file Src/lib/telemetry_bitmask.ts
 */

import { isIP } from "node:net"

import { redactIpToSubnetHash } from "../../lib/http_auth.ts"
import type { LiveWager, LiveWagerLeg } from "../../lib/live_wagers.ts"
import type { ProfileInspectRecord } from "../../server/profile_inspect.ts"
import type { WebLogEntry } from "../../server/weblog_inspect.ts"

// ── 1. Weblog 32-bit Signal Mask ─────────────────────────────────────────────

export const WLOG_BIT_BOT_BLOCK = 1 << 0
export const WLOG_BIT_API_BLOCK = 1 << 1
export const WLOG_BIT_LOGIN_SUCCESS = 1 << 2
export const WLOG_BIT_LOGIN_TOKEN = 1 << 3
export const WLOG_BIT_RATE_LIMIT = 1 << 4
export const WLOG_BIT_PROXY_EXIT = 1 << 5
export const WLOG_BIT_DATACENTER = 1 << 6
export const WLOG_BIT_HAS_BOT_KEY = 1 << 7
export const WLOG_BIT_VALID_IPV4 = 1 << 8
export const WLOG_BIT_VALID_IPV6 = 1 << 9
export const WLOG_BIT_UNATTRIBUTED = 1 << 10
export const WLOG_BIT_BURST_CADENCE = 1 << 11

// Packed multi-bit fields inside Weblog mask (bits 12..19)
const WLOG_MARKET_SHIFT = 12 // 2 bits (0=none, 1=Spread, 2=Total, 3=ML)
const WLOG_PERIOD_SHIFT = 14 // 2 bits (0=FG, 1=1H, 2=2H, 3=Other)
const WLOG_SIDE_SHIFT = 16 // 3 bits (0=none, 1=O, 2=U, 3=H, 4=A)
const WLOG_SEV_SHIFT = 19 // 2 bits (0=NORMAL, 1=WATCH, 2=HIGH, 3=CRITICAL)

export const WLOG_BOT_ANY_BLOCK_MASK = (WLOG_BIT_BOT_BLOCK | WLOG_BIT_API_BLOCK) >>> 0
export const WLOG_HOSTING_RISK_MASK = (WLOG_BIT_PROXY_EXIT | WLOG_BIT_DATACENTER) >>> 0

// ── 2. Wager 32-bit Signal Mask ──────────────────────────────────────────────

export const WAGER_BIT_LIVE = 1 << 0
export const WAGER_BIT_COMPACT_GRAMMAR = 1 << 1
export const WAGER_BIT_MULTI_LEG = 1 << 2
export const WAGER_BIT_SENTINEL_ALERT = 1 << 3
export const WAGER_BIT_SENTINEL_BLOCKED = 1 << 4
export const WAGER_BIT_WRITER_GSLIVE = 1 << 5
export const WAGER_BIT_WRITER_INTERNET = 1 << 6
export const WAGER_BIT_VOLUME_DIFFERS = 1 << 7
export const WAGER_BIT_VIP = 1 << 8
export const WAGER_BIT_HAS_GAME_ID = 1 << 9
export const WAGER_BIT_FRACTIONAL_OR_ASIAN_LINE = 1 << 10
export const WAGER_BIT_ZERO_OR_MISSING_STAKE = 1 << 11

export const WAGER_SENTINEL_MASK = (WAGER_BIT_SENTINEL_ALERT | WAGER_BIT_SENTINEL_BLOCKED) >>> 0

// ── 3. Profile 32-bit Signal Mask ────────────────────────────────────────────

export const PROF_BIT_SHARP = 1 << 0
export const PROF_BIT_ORIGINATOR = 1 << 1
export const PROF_BIT_SYNDICATE_HIGH = 1 << 2
export const PROF_BIT_CORRELATED_EXPLOIT = 1 << 3
export const PROF_BIT_NEGATIVE_HOLD = 1 << 4
export const PROF_BIT_ESTIMATED_VOLUME = 1 << 5
export const PROF_BIT_HAS_RECONCILIATION = 1 << 6
export const PROF_BIT_DELAY_ENFORCED = 1 << 7
export const PROF_BIT_LINE_SHADED = 1 << 8
export const PROF_BIT_ACTION_RESTRICT_OR_ALERT = 1 << 9
export const PROF_BIT_HAS_IP_HASH = 1 << 10

// ── 4. Cross-Feed Correlation 32-bit Mask ────────────────────────────────────

export const CORR_BIT_SHARED_ENTITY = 1 << 0
export const CORR_BIT_SHARED_GAME_ID = 1 << 1
export const CORR_BIT_SHARED_SUBNET_HASH = 1 << 2
export const CORR_BIT_BLOCK_TO_FILL_RACE = 1 << 3
export const CORR_BIT_PROXY_SYNDICATE = 1 << 4
export const CORR_BIT_ESTIMATED_PROFILE_GAP = 1 << 5

// ── 5. Bitwise Primitives (SWAR Popcount, FNV-1a 64-bit Bloom, Bitsets) ──────

/** 32-bit SWAR Hamming weight (number of set bits in unsigned 32-bit integer). */
export function popcount32(x: number): number {
  let v = x >>> 0
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

/** Dual-hash 64-bit (lo, hi) FNV-1a token signature for fast bitwise Bloom overlap tests. */
export function fnv1a32(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** Sets 2 bits across a `[lo, hi]` 64-bit Bloom word pair for an arbitrary string key. */
export function setBloom64(lo: Uint32Array, hi: Uint32Array, rowIdx: number, key: string): void {
  const h1 = fnv1a32(key, 0x811c9dc5)
  const h2 = fnv1a32(key, 0x9e3779b9)
  const bit1 = 1 << (h1 & 31)
  const bit2 = 1 << (h2 & 31)
  if ((h1 & 32) === 0) {
    lo[rowIdx] = (lo[rowIdx]! | bit1) >>> 0
  } else {
    hi[rowIdx] = (hi[rowIdx]! | bit1) >>> 0
  }
  if ((h2 & 32) === 0) {
    lo[rowIdx] = (lo[rowIdx]! | bit2) >>> 0
  } else {
    hi[rowIdx] = (hi[rowIdx]! | bit2) >>> 0
  }
}

export function bloomMayOverlap64(aLo: number, aHi: number, bLo: number, bHi: number): boolean {
  return (aLo & bLo) !== 0 || (aHi & bHi) !== 0
}

/** Packed `Uint32Array` row-index bitset (`(capacity + 31) >>> 5` words). */
export function createRowBitset(capacity: number): Uint32Array {
  return new Uint32Array(Math.max(1, (capacity + 31) >>> 5))
}

export function setRowBit(bitset: Uint32Array, rowIdx: number): void {
  const word = rowIdx >>> 5
  bitset[word] = ((bitset[word] ?? 0) | (1 << (rowIdx & 31))) >>> 0
}

export function hasRowBit(bitset: Uint32Array, rowIdx: number): boolean {
  const word = rowIdx >>> 5
  return (((bitset[word] ?? 0) >>> (rowIdx & 31)) & 1) === 1
}

export function intersectBitsets(a: Uint32Array, b: Uint32Array): Uint32Array {
  const len = Math.min(a.length, b.length)
  const out = new Uint32Array(len)
  for (let i = 0; i < len; i += 1) {
    out[i] = (a[i]! & b[i]!) >>> 0
  }
  return out
}

export function countSetBits(bitset: Uint32Array): number {
  let total = 0
  for (let i = 0; i < bitset.length; i += 1) {
    total += popcount32(bitset[i]!)
  }
  return total
}

// ── 6. Fractional Line & Odds Extractor ──────────────────────────────────────

export interface ParsedLineAndOdds {
  readonly line: number | null
  readonly oddsAmerican: number | null
  readonly isFractionalOrAsian: boolean
}

function parseLineNumberToken(raw: string): number | null {
  const normalized = raw
    .trim()
    .replace(/½/g, ".5")
    .replace(/¼/g, ".25")
    .replace(/¾/g, ".75")
    .replace(/^[+-]?\./, (m) => (m.startsWith("-") ? "-0." : "0."))
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

/**
 * Extracts normalized numeric line (including `½` and Asian split `2½,3` -> `2.75`) and American
 * odds (`-140`, `+115`) from a `LiveWagerLeg.pick` string.
 */
export function parseWagerLineAndOdds(pick: string): ParsedLineAndOdds {
  const trimmed = pick
    .trim()
    .replace(/\s+#\d+\s*$/, "")
    .trim()
  if (!trimmed) {
    return { line: null, oddsAmerican: null, isFractionalOrAsian: false }
  }

  let oddsAmerican: number | null = null
  const oddsMatch = /(?:^|\s)([+-]\d{3,4}|EV|EVEN|PK|PICK)\s*$/i.exec(trimmed)
  let body = trimmed
  if (oddsMatch) {
    const token = oddsMatch[1]!.toUpperCase()
    oddsAmerican =
      token === "EV" || token === "EVEN" || token === "PK" || token === "PICK" ? 100 : Number(token)
    body = trimmed.slice(0, oddsMatch.index).trim()
  }

  // Asian split line like "2½,3" or "2.5,3.0"
  const asianMatch = /([+-]?\d+(?:[.,]\d+|[½¼¾])?)\s*,\s*([+-]?\d+(?:[.,]\d+|[½¼¾])?)\s*$/.exec(
    body,
  )
  if (asianMatch) {
    const a = parseLineNumberToken(asianMatch[1]!)
    const b = parseLineNumberToken(asianMatch[2]!)
    if (a !== null && b !== null) {
      return {
        line: Number(((a + b) / 2).toFixed(2)),
        oddsAmerican,
        isFractionalOrAsian: true,
      }
    }
  }

  const singleLineMatch = /([+-]?\d*(?:\.\d+|[½¼¾])|[+-]?\d+)\s*$/.exec(body)
  if (singleLineMatch && singleLineMatch[1]) {
    const line = parseLineNumberToken(singleLineMatch[1])
    return {
      line,
      oddsAmerican,
      isFractionalOrAsian: /[½¼¾,]/.test(singleLineMatch[1]),
    }
  }

  return { line: null, oddsAmerican, isFractionalOrAsian: false }
}

// ── 7. Single-Pass Bitmask Encoders ──────────────────────────────────────────

export function encodeWebLogSignalMask(
  entry: Pick<
    WebLogEntry,
    "eventKind" | "botKey" | "accountId" | "interArrivalSec" | "severity"
  > & { readonly rawIp?: string; readonly ipMeta: { readonly classification: string } },
): number {
  let mask = 0

  if (entry.eventKind === "BOT_BLOCK_LINE_ST") mask |= WLOG_BIT_BOT_BLOCK
  else if (entry.eventKind === "API_BLOCK_BET" || entry.eventKind === "WAGER_LIMIT") {
    mask |= WLOG_BIT_API_BLOCK
  } else if (entry.eventKind === "LOGIN_SUCCESS") mask |= WLOG_BIT_LOGIN_SUCCESS
  else if (entry.eventKind === "LOGIN_TOKEN") mask |= WLOG_BIT_LOGIN_TOKEN
  else if (entry.eventKind === "RATE_LIMIT") mask |= WLOG_BIT_RATE_LIMIT

  if (entry.ipMeta.classification === "PROXY_EXIT") {
    mask |= WLOG_BIT_PROXY_EXIT
  } else if (
    entry.ipMeta.classification === "DATACENTER" ||
    entry.ipMeta.classification === "AFRINIC_HOSTING"
  ) {
    mask |= WLOG_BIT_DATACENTER
  }

  if (entry.rawIp) {
    const ipVer = isIP(entry.rawIp.trim())
    if (ipVer === 4) mask |= WLOG_BIT_VALID_IPV4
    else if (ipVer === 6) mask |= WLOG_BIT_VALID_IPV6
  }

  const acct = entry.accountId.trim().toUpperCase()
  if (!acct || acct === "UNKNOWN" || acct === "UNATTRIBUTED") {
    mask |= WLOG_BIT_UNATTRIBUTED
  }

  if (entry.interArrivalSec !== null && entry.interArrivalSec <= 5) {
    mask |= WLOG_BIT_BURST_CADENCE
  }

  if (entry.botKey) {
    mask |= WLOG_BIT_HAS_BOT_KEY
    const mCode =
      entry.botKey.marketCode === "S"
        ? 1
        : entry.botKey.marketCode === "L"
          ? 2
          : entry.botKey.marketCode === "M"
            ? 3
            : 0
    const pCode =
      entry.botKey.periodCode === "0"
        ? 0
        : entry.botKey.periodCode === "1"
          ? 1
          : entry.botKey.periodCode === "2"
            ? 2
            : 3
    const sCode =
      entry.botKey.sideCode === "O"
        ? 1
        : entry.botKey.sideCode === "U"
          ? 2
          : entry.botKey.sideCode === "H"
            ? 3
            : entry.botKey.sideCode === "A"
              ? 4
              : 0
    mask |= (mCode & 3) << WLOG_MARKET_SHIFT
    mask |= (pCode & 3) << WLOG_PERIOD_SHIFT
    mask |= (sCode & 7) << WLOG_SIDE_SHIFT
  }

  const sevCode =
    entry.severity === "CRITICAL"
      ? 3
      : entry.severity === "HIGH"
        ? 2
        : entry.severity === "WATCH"
          ? 1
          : 0
  mask |= (sevCode & 3) << WLOG_SEV_SHIFT

  return mask >>> 0
}

export function encodeWagerSignalMask(
  wager: Pick<LiveWager, "live" | "legs" | "writer" | "volumeDiffers" | "vip" | "amountWagered">,
): number {
  let mask = 0

  if (wager.live) mask |= WAGER_BIT_LIVE
  if (wager.legs.length > 1) mask |= WAGER_BIT_MULTI_LEG
  if (wager.legs.some((leg: LiveWagerLeg) => leg.compact)) {
    mask |= WAGER_BIT_COMPACT_GRAMMAR
  }
  if (wager.legs.some((leg: LiveWagerLeg) => leg.gameNumber !== null)) {
    mask |= WAGER_BIT_HAS_GAME_ID
  }
  if (wager.legs.some((leg: LiveWagerLeg) => parseWagerLineAndOdds(leg.pick).isFractionalOrAsian)) {
    mask |= WAGER_BIT_FRACTIONAL_OR_ASIAN_LINE
  }

  if (wager.writer === "alert") mask |= WAGER_BIT_SENTINEL_ALERT
  else if (wager.writer === "blocked") mask |= WAGER_BIT_SENTINEL_BLOCKED
  else if (wager.writer === "gslive") mask |= WAGER_BIT_WRITER_GSLIVE
  else if (wager.writer === "internet") mask |= WAGER_BIT_WRITER_INTERNET

  if (wager.volumeDiffers) mask |= WAGER_BIT_VOLUME_DIFFERS
  if (wager.vip) mask |= WAGER_BIT_VIP
  if (!Number.isFinite(wager.amountWagered) || wager.amountWagered <= 0) {
    mask |= WAGER_BIT_ZERO_OR_MISSING_STAKE
  }

  return mask >>> 0
}

export function encodeProfileSignalMask(
  profile: Pick<
    Extract<ProfileInspectRecord, { readonly kind: "modeled" }>,
    | "tier"
    | "score"
    | "syndicateProb"
    | "correlatedExploitRate"
    | "holdPct"
    | "lifetimeVolumeUsd"
    | "portalReconciliation"
    | "inPlayDelaySec"
    | "lineShadeCents"
    | "action"
    | "ipAddress"
  > & { readonly volumeIsEstimated?: boolean },
): number {
  let mask = 0

  if (profile.score >= 6.5) mask |= PROF_BIT_SHARP
  if (
    profile.tier.toUpperCase().includes("TIER_1") ||
    profile.tier.toUpperCase().includes("ORIGINATOR") ||
    profile.score >= 8.0
  ) {
    mask |= PROF_BIT_ORIGINATOR
  }
  if (profile.syndicateProb >= 0.5) mask |= PROF_BIT_SYNDICATE_HIGH
  if (profile.correlatedExploitRate > 0) mask |= PROF_BIT_CORRELATED_EXPLOIT
  if (profile.holdPct < 0) mask |= PROF_BIT_NEGATIVE_HOLD
  if (
    profile.volumeIsEstimated ||
    profile.lifetimeVolumeUsd === undefined ||
    profile.lifetimeVolumeUsd === 48500
  ) {
    mask |= PROF_BIT_ESTIMATED_VOLUME
  }
  if (profile.portalReconciliation) mask |= PROF_BIT_HAS_RECONCILIATION
  if (profile.inPlayDelaySec > 0) mask |= PROF_BIT_DELAY_ENFORCED
  if (profile.lineShadeCents !== 0) mask |= PROF_BIT_LINE_SHADED

  const upperAct = profile.action.toUpperCase()
  if (upperAct.includes("ALERT") || upperAct.includes("RESTRICT") || upperAct.includes("SHADOW")) {
    mask |= PROF_BIT_ACTION_RESTRICT_OR_ALERT
  }

  if (profile.ipAddress && profile.ipAddress.trim().length > 0) {
    mask |= PROF_BIT_HAS_IP_HASH
  }

  return mask >>> 0
}

// ── 8. Unified SoA Bitmask Spine & Cross-Feed Correlator ─────────────────────

export interface EntityCorrelationResult {
  readonly entityId: string
  readonly weblogMask: number
  readonly wagerMask: number
  readonly profileMask: number
  readonly correlationMask: number
  readonly sharedGames: readonly string[]
  readonly sharedIpHashes: readonly string[]
  readonly minBlockToFillDeltaSec: number | null
  readonly compositeBitScore: number
}

export interface SurveillanceBitmaskIndex {
  readonly entityIds: readonly string[]
  readonly weblogMasks: Uint32Array
  readonly wagerMasks: Uint32Array
  readonly profileMasks: Uint32Array
  readonly correlationMasks: Uint32Array
  readonly gameBloomLo: Uint32Array
  readonly gameBloomHi: Uint32Array
  readonly ipBloomLo: Uint32Array
  readonly ipBloomHi: Uint32Array
  readonly bitsets: {
    readonly hasWeblogBlock: Uint32Array
    readonly hasWagerFill: Uint32Array
    readonly hasSharpProfile: Uint32Array
    readonly hasBlockToFillRace: Uint32Array
    readonly hasSharedGame: Uint32Array
  }
  readonly results: readonly EntityCorrelationResult[]
  queryByMask(predicate: {
    readonly weblogAll?: number
    readonly wagerAll?: number
    readonly profileAll?: number
    readonly correlationAll?: number
  }): readonly EntityCorrelationResult[]
}

function parseTimestampMs(raw: string): number | null {
  if (!raw) return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

function resolveIpHash(rawIpOrRedacted: string): string | null {
  const clean = rawIpOrRedacted.trim()
  if (!clean) return null
  const hashMatch = /#([0-9a-f]{8})$/i.exec(clean)
  if (hashMatch) return hashMatch[1]!.toLowerCase()
  if (isIP(clean) !== 0) {
    return redactIpToSubnetHash(clean).hash.toLowerCase()
  }
  return null
}

/**
 * Joins parsed Weblogs, Live Wagers, and Profiles into a unified SoA bitwise correlation spine for
 * sub-millisecond multi-predicate filtering & scoring.
 */
export function buildSurveillanceBitmaskIndex(input: {
  readonly weblogs: readonly WebLogEntry[]
  readonly wagers: readonly LiveWager[]
  readonly profiles: readonly ProfileInspectRecord[]
  readonly raceWindowSec?: number
}): SurveillanceBitmaskIndex {
  const raceWindowSec = input.raceWindowSec ?? 60

  interface EntityAccumulator {
    weblogMask: number
    wagerMask: number
    profileMask: number
    weblogGames: Set<string>
    wagerGames: Set<string>
    weblogIpHashes: Set<string>
    profileIpHashes: Set<string>
    blockEpochsMs: number[]
    fillEpochsMs: number[]
  }

  const map = new Map<string, EntityAccumulator>()
  const ensure = (rawId: string): EntityAccumulator | null => {
    const id = rawId.trim().toUpperCase()
    if (!id || id === "UNKNOWN" || id === "UNATTRIBUTED") return null
    let acc = map.get(id)
    if (!acc) {
      acc = {
        weblogMask: 0,
        wagerMask: 0,
        profileMask: 0,
        weblogGames: new Set(),
        wagerGames: new Set(),
        weblogIpHashes: new Set(),
        profileIpHashes: new Set(),
        blockEpochsMs: [],
        fillEpochsMs: [],
      }
      map.set(id, acc)
    }
    return acc
  }

  for (const w of input.weblogs) {
    const acc = ensure(w.accountId)
    if (!acc) continue
    const m = encodeWebLogSignalMask(w)
    acc.weblogMask = (acc.weblogMask | m) >>> 0
    const weblogGameId = w.botKey?.gameId ?? w.gameId
    if (weblogGameId) acc.weblogGames.add(weblogGameId)
    const hash = w.ipMeta.ipHash ?? resolveIpHash(w.ip)
    if (hash) acc.weblogIpHashes.add(hash.toLowerCase())
    if ((m & WLOG_BOT_ANY_BLOCK_MASK) !== 0) {
      acc.blockEpochsMs.push(w.epochMs)
    }
  }

  for (const wg of input.wagers) {
    const acc = ensure(wg.customerId || wg.login)
    if (!acc) continue
    const m = encodeWagerSignalMask(wg)
    acc.wagerMask = (acc.wagerMask | m) >>> 0
    for (const leg of wg.legs) {
      if (leg.gameNumber) acc.wagerGames.add(leg.gameNumber)
    }
    const ts = parseTimestampMs(wg.insertedAt)
    if (ts !== null) {
      if ((m & WAGER_BIT_SENTINEL_BLOCKED) !== 0) {
        acc.blockEpochsMs.push(ts)
      } else if ((m & WAGER_SENTINEL_MASK) === 0) {
        acc.fillEpochsMs.push(ts)
      }
    }
  }

  for (const p of input.profiles) {
    const acc = ensure(p.id)
    if (!acc) continue
    if (p.kind !== "modeled") continue
    const m = encodeProfileSignalMask(p)
    acc.profileMask = (acc.profileMask | m) >>> 0
    const hash = resolveIpHash(p.ipAddress)
    if (hash) acc.profileIpHashes.add(hash)
  }

  const entityIds = Array.from(map.keys()).sort()
  const n = entityIds.length

  const weblogMasks = new Uint32Array(n)
  const wagerMasks = new Uint32Array(n)
  const profileMasks = new Uint32Array(n)
  const correlationMasks = new Uint32Array(n)
  const gameBloomLo = new Uint32Array(n)
  const gameBloomHi = new Uint32Array(n)
  const ipBloomLo = new Uint32Array(n)
  const ipBloomHi = new Uint32Array(n)

  const hasWeblogBlock = createRowBitset(n)
  const hasWagerFill = createRowBitset(n)
  const hasSharpProfile = createRowBitset(n)
  const hasBlockToFillRace = createRowBitset(n)
  const hasSharedGame = createRowBitset(n)

  const results: EntityCorrelationResult[] = []

  for (let i = 0; i < n; i += 1) {
    const id = entityIds[i]!
    const acc = map.get(id)!

    weblogMasks[i] = acc.weblogMask >>> 0
    wagerMasks[i] = acc.wagerMask >>> 0
    profileMasks[i] = acc.profileMask >>> 0

    let corr = 0
    const presentFeeds =
      (acc.weblogMask !== 0 ? 1 : 0) +
      (acc.wagerMask !== 0 ? 1 : 0) +
      (acc.profileMask !== 0 ? 1 : 0)
    if (presentFeeds >= 2) corr |= CORR_BIT_SHARED_ENTITY

    for (const g of acc.weblogGames) setBloom64(gameBloomLo, gameBloomHi, i, g)
    for (const g of acc.wagerGames) setBloom64(gameBloomLo, gameBloomHi, i, g)
    for (const h of acc.weblogIpHashes) setBloom64(ipBloomLo, ipBloomHi, i, h)
    for (const h of acc.profileIpHashes) setBloom64(ipBloomLo, ipBloomHi, i, h)

    const sharedGames: string[] = []
    for (const g of acc.weblogGames) {
      if (acc.wagerGames.has(g)) sharedGames.push(g)
    }
    if (sharedGames.length > 0) corr |= CORR_BIT_SHARED_GAME_ID

    const sharedIpHashes: string[] = []
    for (const h of acc.weblogIpHashes) {
      if (acc.profileIpHashes.has(h)) sharedIpHashes.push(h)
    }
    if (sharedIpHashes.length > 0) corr |= CORR_BIT_SHARED_SUBNET_HASH

    let minDeltaSec: number | null = null
    for (const bMs of acc.blockEpochsMs) {
      for (const fMs of acc.fillEpochsMs) {
        const diffSec = Math.abs(fMs - bMs) / 1000
        if (diffSec <= raceWindowSec) {
          if (minDeltaSec === null || diffSec < minDeltaSec) {
            minDeltaSec = Number(diffSec.toFixed(2))
          }
        }
      }
    }
    if (minDeltaSec !== null) corr |= CORR_BIT_BLOCK_TO_FILL_RACE

    if (
      (acc.weblogMask & WLOG_HOSTING_RISK_MASK) !== 0 &&
      (acc.profileMask & (PROF_BIT_SHARP | PROF_BIT_SYNDICATE_HIGH)) !== 0
    ) {
      corr |= CORR_BIT_PROXY_SYNDICATE
    }

    if (
      (acc.profileMask & PROF_BIT_ESTIMATED_VOLUME) !== 0 &&
      (acc.weblogMask !== 0 || acc.wagerMask !== 0)
    ) {
      corr |= CORR_BIT_ESTIMATED_PROFILE_GAP
    }

    correlationMasks[i] = corr >>> 0

    if ((acc.weblogMask & WLOG_BOT_ANY_BLOCK_MASK) !== 0) {
      setRowBit(hasWeblogBlock, i)
    }
    if ((acc.wagerMask & (WAGER_BIT_WRITER_GSLIVE | WAGER_BIT_WRITER_INTERNET)) !== 0) {
      setRowBit(hasWagerFill, i)
    }
    if ((acc.profileMask & (PROF_BIT_SHARP | PROF_BIT_ORIGINATOR)) !== 0) {
      setRowBit(hasSharpProfile, i)
    }
    if ((corr & CORR_BIT_BLOCK_TO_FILL_RACE) !== 0) {
      setRowBit(hasBlockToFillRace, i)
    }
    if ((corr & CORR_BIT_SHARED_GAME_ID) !== 0) {
      setRowBit(hasSharedGame, i)
    }

    const compositeBitScore =
      popcount32(
        acc.weblogMask &
          (WLOG_BOT_ANY_BLOCK_MASK | WLOG_HOSTING_RISK_MASK | WLOG_BIT_BURST_CADENCE),
      ) +
      popcount32(
        acc.wagerMask & (WAGER_BIT_LIVE | WAGER_SENTINEL_MASK | WAGER_BIT_VOLUME_DIFFERS),
      ) +
      popcount32(
        acc.profileMask & (PROF_BIT_SHARP | PROF_BIT_ORIGINATOR | PROF_BIT_SYNDICATE_HIGH),
      ) +
      popcount32(corr) * 2

    results.push({
      entityId: id,
      weblogMask: acc.weblogMask >>> 0,
      wagerMask: acc.wagerMask >>> 0,
      profileMask: acc.profileMask >>> 0,
      correlationMask: corr >>> 0,
      sharedGames,
      sharedIpHashes,
      minBlockToFillDeltaSec: minDeltaSec,
      compositeBitScore,
    })
  }

  return {
    entityIds,
    weblogMasks,
    wagerMasks,
    profileMasks,
    correlationMasks,
    gameBloomLo,
    gameBloomHi,
    ipBloomLo,
    ipBloomHi,
    bitsets: {
      hasWeblogBlock,
      hasWagerFill,
      hasSharpProfile,
      hasBlockToFillRace,
      hasSharedGame,
    },
    results,
    queryByMask(predicate) {
      const wAll = (predicate.weblogAll ?? 0) >>> 0
      const wgAll = (predicate.wagerAll ?? 0) >>> 0
      const pAll = (predicate.profileAll ?? 0) >>> 0
      const cAll = (predicate.correlationAll ?? 0) >>> 0
      const matched: EntityCorrelationResult[] = []
      for (let i = 0; i < n; i += 1) {
        if (
          (weblogMasks[i]! & wAll) === wAll &&
          (wagerMasks[i]! & wgAll) === wgAll &&
          (profileMasks[i]! & pAll) === pAll &&
          (correlationMasks[i]! & cAll) === cAll
        ) {
          matched.push(results[i]!)
        }
      }
      return matched
    },
  }
}
