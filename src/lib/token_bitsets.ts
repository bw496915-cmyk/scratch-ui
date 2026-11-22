/**
 * @file src/lib/token_bitsets.ts
 * @description Precomputed `Uint32Array` bitset masks compiled from `design/tokens.toml`
 * covering ingestion channels, surveillance surfaces, risk routes, and DualClock SLA states.
 *
 * Hot-path classification contract:
 * - `TokenBitsetBuffer` reuses a fixed 4-word `Uint32Array` via `.clear()` (`words.fill(0)`).
 * - Bitwise set/test/intersect/containsAll operations run in O(1) with zero heap allocations.
 * - All bit positions are strictly <= 30 (`>>> 0` unsigned contract, avoiding negative 32-bit SMIs).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parse as parseToml } from "smol-toml"

import {
  SLA_STATE_FRESH,
  SLA_STATE_POISON,
  SLA_STATE_STALE,
  SLA_STATE_WARN,
  type SlaStateCode,
  STALE_SNAPSHOT_POISON_BIT,
} from "./dual_clock_sla.ts"
import { popcount32 } from "./telemetry_bitmask.ts"

// ── 1. Multi-Word Bitset Layout Constants ────────────────────────────────────

export const TOKEN_BITSET_WORD_COUNT = 4 as const
export const WORD_INGESTION = 0 as const
export const WORD_SURFACE = 1 as const
export const WORD_ROUTE = 2 as const
export const WORD_SLA_UI = 3 as const

// ── 2. Ingestion Channel Bit Positions & Masks (`design/tokens.toml` [ingestion.*])

export const CHANNEL_ID = Object.freeze({
  NON_SPORTS: 0,
  INTERNET: 1,
  BLOCKED: 2,
  GATEWAY: 3,
  ALERT: 4,
  GSBUILDER: 5,
  GSLIVE: 6,
  CSLEVEL2: 7,
  LIVEBETTINGCWS: 8,
  PHONE: 9,
  HOUSE: 10,
} as const)

export type IngestionChannelId = (typeof CHANNEL_ID)[keyof typeof CHANNEL_ID]

export const CHANNEL_MASK = Object.freeze({
  NON_SPORTS: (1 << CHANNEL_ID.NON_SPORTS) >>> 0,
  INTERNET: (1 << CHANNEL_ID.INTERNET) >>> 0,
  BLOCKED: (1 << CHANNEL_ID.BLOCKED) >>> 0,
  GATEWAY: (1 << CHANNEL_ID.GATEWAY) >>> 0,
  ALERT: (1 << CHANNEL_ID.ALERT) >>> 0,
  GSBUILDER: (1 << CHANNEL_ID.GSBUILDER) >>> 0,
  GSLIVE: (1 << CHANNEL_ID.GSLIVE) >>> 0,
  CSLEVEL2: (1 << CHANNEL_ID.CSLEVEL2) >>> 0,
  LIVEBETTINGCWS: (1 << CHANNEL_ID.LIVEBETTINGCWS) >>> 0,
  PHONE: (1 << CHANNEL_ID.PHONE) >>> 0,
  HOUSE: (1 << CHANNEL_ID.HOUSE) >>> 0,
} as const)

/** Precomputed ingestion composite masks aligned to `design/tokens.toml`. */
export const CHANNEL_GROUP_MASK = Object.freeze({
  DROPPED: (CHANNEL_MASK.NON_SPORTS | CHANNEL_MASK.BLOCKED) >>> 0,
  ACTIVE:
    (CHANNEL_MASK.INTERNET |
      CHANNEL_MASK.GATEWAY |
      CHANNEL_MASK.LIVEBETTINGCWS |
      CHANNEL_MASK.PHONE |
      CHANNEL_MASK.HOUSE) >>>
    0,
  ALERT_OR_CRITICAL: (CHANNEL_MASK.ALERT | CHANNEL_MASK.GSLIVE) >>> 0,
  STEERABLE_OR_SUPPRESSED: (CHANNEL_MASK.GSBUILDER | CHANNEL_MASK.CSLEVEL2) >>> 0,
  INPLAY: (CHANNEL_MASK.GSLIVE | CHANNEL_MASK.LIVEBETTINGCWS) >>> 0,
  PARTNER_118_BRIDGE: (CHANNEL_MASK.GSBUILDER | CHANNEL_MASK.GSLIVE) >>> 0,
  FANTASY_402_BRIDGE:
    (CHANNEL_MASK.INTERNET |
      CHANNEL_MASK.BLOCKED |
      CHANNEL_MASK.GATEWAY |
      CHANNEL_MASK.ALERT |
      CHANNEL_MASK.CSLEVEL2 |
      CHANNEL_MASK.LIVEBETTINGCWS |
      CHANNEL_MASK.PHONE |
      CHANNEL_MASK.HOUSE) >>>
    0,
  LATENCY_GATED:
    (CHANNEL_MASK.INTERNET |
      CHANNEL_MASK.GATEWAY |
      CHANNEL_MASK.ALERT |
      CHANNEL_MASK.GSBUILDER |
      CHANNEL_MASK.GSLIVE |
      CHANNEL_MASK.CSLEVEL2 |
      CHANNEL_MASK.LIVEBETTINGCWS |
      CHANNEL_MASK.PHONE |
      CHANNEL_MASK.HOUSE) >>>
    0,
  ALL: ((1 << 11) - 1) >>> 0,
} as const)

// ── 3. Surface Bit Positions & Masks (`design/tokens.toml` [surfaces.*] & [ui.surface_*])

export const SURFACE_ID = Object.freeze({
  DOM: 0,
  CLI: 1,
  CARD: 2,
  ELEVATED: 3,
  HOVER: 4,
  RAISED: 5,
  SELECTED: 6,
} as const)

export type SurveillanceSurfaceId = (typeof SURFACE_ID)[keyof typeof SURFACE_ID]

export const SURFACE_MASK = Object.freeze({
  DOM: (1 << SURFACE_ID.DOM) >>> 0,
  CLI: (1 << SURFACE_ID.CLI) >>> 0,
  CARD: (1 << SURFACE_ID.CARD) >>> 0,
  ELEVATED: (1 << SURFACE_ID.ELEVATED) >>> 0,
  HOVER: (1 << SURFACE_ID.HOVER) >>> 0,
  RAISED: (1 << SURFACE_ID.RAISED) >>> 0,
  SELECTED: (1 << SURFACE_ID.SELECTED) >>> 0,
} as const)

export const SURFACE_GROUP_MASK = Object.freeze({
  BASE_CANVAS: (SURFACE_MASK.DOM | SURFACE_MASK.CLI) >>> 0,
  UI_CHROME:
    (SURFACE_MASK.CARD |
      SURFACE_MASK.ELEVATED |
      SURFACE_MASK.HOVER |
      SURFACE_MASK.RAISED |
      SURFACE_MASK.SELECTED) >>>
    0,
  INTERACTIVE_STATES: (SURFACE_MASK.HOVER | SURFACE_MASK.SELECTED) >>> 0,
  ALL: ((1 << 7) - 1) >>> 0,
} as const)

// ── 4. Risk Route Bit Positions & Masks (`design/tokens.toml` [routes.*]) ────

export const ROUTE_ID = Object.freeze({
  DEVIG: 0, // L25.N1882 STEAM_CONVERGENCE
  SHARP: 1, // L26.N3104 SHRINKAGE_SHARP
  PENDING: 2, // L27.N0912 LIQUIDITY_HALT
  MANAGER: 3, // L28.N2501 TERMINAL_ENFORCE
} as const)

export type RiskRouteId = (typeof ROUTE_ID)[keyof typeof ROUTE_ID]

export const ROUTE_MASK = Object.freeze({
  DEVIG: (1 << ROUTE_ID.DEVIG) >>> 0,
  SHARP: (1 << ROUTE_ID.SHARP) >>> 0,
  PENDING: (1 << ROUTE_ID.PENDING) >>> 0,
  MANAGER: (1 << ROUTE_ID.MANAGER) >>> 0,
} as const)

export const ROUTE_GROUP_MASK = Object.freeze({
  REPRICE_OR_RECALIBRATE: (ROUTE_MASK.DEVIG | ROUTE_MASK.SHARP) >>> 0,
  HALT_OR_ENFORCE: (ROUTE_MASK.PENDING | ROUTE_MASK.MANAGER) >>> 0,
  ALL: ((1 << 4) - 1) >>> 0,
} as const)

// ── 5. SLA State Bit Masks (Word 3) ──────────────────────────────────────────

export const SLA_STATE_MASK = Object.freeze({
  FRESH: (1 << SLA_STATE_FRESH) >>> 0,
  WARN: (1 << SLA_STATE_WARN) >>> 0,
  STALE: (1 << SLA_STATE_STALE) >>> 0,
  POISON: (1 << SLA_STATE_POISON) >>> 0,
  DEGRADED: ((1 << SLA_STATE_STALE) | (1 << SLA_STATE_POISON)) >>> 0,
  POISON_LATCH_BIT: STALE_SNAPSHOT_POISON_BIT,
} as const)

// ── 6. Compiled Bitset Registry Shape ────────────────────────────────────────

export interface CompiledTokenBitsets {
  readonly version: string
  /** Single-bit `Uint32Array` per ingestion channel (`index === channel_id`). */
  readonly channelMasks: Uint32Array
  /** Packed metadata word per channel: `[4b channelId | 8b slaTensOfMs | 2b bridgeId | 18b flags]`. */
  readonly channelPackedMeta: Uint32Array
  /** Single-bit `Uint32Array` per surveillance surface (`index === surfaceId`). */
  readonly surfaceMasks: Uint32Array
  /** Single-bit `Uint32Array` per risk route (`index === route_id`). */
  readonly routeMasks: Uint32Array
  /** Single-bit `Uint32Array` per DualClock SLA state (`index === SlaStateCode`). */
  readonly slaMasks: Uint32Array
  /** Aggregate group masks packed into a reusable 4-word `Uint32Array` per preset. */
  readonly presets: {
    readonly activeDomSurveillance: Uint32Array
    readonly criticalInplayEscalation: Uint32Array
    readonly droppedSentinelFilter: Uint32Array
    readonly poisonQuarantineGate: Uint32Array
    readonly partner118Routes: Uint32Array
  }
  /** O(1) normalized uppercase alias / channel_code -> `channel_id` lookup table. */
  readonly aliasToChannelId: ReadonlyMap<string, number>
  /** O(1) `--sd-*` surface token name -> `surfaceId` lookup table. */
  readonly tokenNameToSurfaceId: ReadonlyMap<string, number>
  /** O(1) `move_flag` / `--sd-route-*` token name -> `route_id` lookup table. */
  readonly moveFlagToRouteId: ReadonlyMap<string, number>
}

export const PACKED_META_FLAG_LATENCY_GATED = (1 << 0) >>> 0
export const PACKED_META_FLAG_DROPPED = (1 << 1) >>> 0
export const PACKED_META_FLAG_CRITICAL_OR_ALERT = (1 << 2) >>> 0

export function packChannelMetaWord32(
  channelId: number,
  slaTensOfMs: number,
  sourceBridgeId: number,
  flags: number,
): number {
  return (
    (((channelId & 0xf) << 28) |
      ((slaTensOfMs & 0xff) << 20) |
      ((sourceBridgeId & 0x3) << 18) |
      (flags & 0x3ffff)) >>>
    0
  )
}

export function unpackChannelIdFromMeta(word: number): number {
  return (word >>> 28) & 0xf
}

export function unpackSlaTensOfMsFromMeta(word: number): number {
  return (word >>> 20) & 0xff
}

export function unpackBridgeIdFromMeta(word: number): number {
  return (word >>> 18) & 0x3
}

/**
 * Creates a 4-word `Uint32Array` preset mask `[ingestion, surface, route, slaUi]`.
 */
export function createPresetMaskWords(
  ingestionMask: number,
  surfaceMask: number,
  routeMask: number,
  slaUiMask: number,
): Uint32Array {
  const words = new Uint32Array(TOKEN_BITSET_WORD_COUNT)
  words[WORD_INGESTION] = ingestionMask >>> 0
  words[WORD_SURFACE] = surfaceMask >>> 0
  words[WORD_ROUTE] = routeMask >>> 0
  words[WORD_SLA_UI] = slaUiMask >>> 0
  return words
}

function buildStaticTokenBitsets(): CompiledTokenBitsets {
  const channelMasks = new Uint32Array(11)
  for (let i = 0; i < 11; i += 1) {
    channelMasks[i] = (1 << i) >>> 0
  }

  // [channelId, slaTensOfMs, sourceBridgeId, flags] locked to design/tokens.toml
  const channelSpecs: readonly (readonly [number, number, number, number])[] = [
    [0, 0, 0, PACKED_META_FLAG_DROPPED],
    [1, 150, 1, PACKED_META_FLAG_LATENCY_GATED],
    [2, 0, 1, PACKED_META_FLAG_DROPPED],
    [3, 100, 1, PACKED_META_FLAG_LATENCY_GATED],
    [4, 25, 1, PACKED_META_FLAG_LATENCY_GATED | PACKED_META_FLAG_CRITICAL_OR_ALERT],
    [5, 100, 2, PACKED_META_FLAG_LATENCY_GATED],
    [6, 50, 2, PACKED_META_FLAG_LATENCY_GATED | PACKED_META_FLAG_CRITICAL_OR_ALERT],
    [7, 200, 1, PACKED_META_FLAG_LATENCY_GATED],
    [8, 75, 1, PACKED_META_FLAG_LATENCY_GATED],
    [9, 150, 1, PACKED_META_FLAG_LATENCY_GATED],
    [10, 150, 1, PACKED_META_FLAG_LATENCY_GATED],
  ]
  const channelPackedMeta = new Uint32Array(11)
  for (const [id, slaTens, bridge, flags] of channelSpecs) {
    channelPackedMeta[id] = packChannelMetaWord32(id, slaTens, bridge, flags)
  }

  const surfaceMasks = new Uint32Array(7)
  for (let i = 0; i < 7; i += 1) {
    surfaceMasks[i] = (1 << i) >>> 0
  }

  const routeMasks = new Uint32Array(4)
  for (let i = 0; i < 4; i += 1) {
    routeMasks[i] = (1 << i) >>> 0
  }

  const slaMasks = new Uint32Array(4)
  for (let i = 0; i < 4; i += 1) {
    slaMasks[i] = (1 << i) >>> 0
  }

  const aliasToChannelId = new Map<string, number>([
    ["NON_SPORTS", 0],
    ["CASINO", 0],
    ["VIRTUAL", 0],
    ["WAGER_TYPE_C", 0],
    ["WAGER_TYPE_A", 0],
    ["INTERNET", 1],
    ["MOBILE", 1],
    ["WAP", 1],
    ["BLOCKED", 2],
    ["GATEWAY", 3],
    ["ALERT", 4],
    ["GSBUILDER", 5],
    ["GSLIVE", 6],
    ["CSLEVEL2", 7],
    ["LIVEBETTINGCWS", 8],
    ["EZLIVE", 8],
    ["PHONE", 9],
    ["CLERK", 9],
    ["HOUSE", 10],
    ["AGENT", 10],
    ["ADMIN", 10],
  ])

  const tokenNameToSurfaceId = new Map<string, number>([
    ["--sd-surface-bg", SURFACE_ID.DOM],
    ["--sd-surface-cli", SURFACE_ID.CLI],
    ["--sd-surface-card", SURFACE_ID.CARD],
    ["--sd-surface-elevated", SURFACE_ID.ELEVATED],
    ["--sd-surface-hover", SURFACE_ID.HOVER],
    ["--sd-surface-raised", SURFACE_ID.RAISED],
    ["--sd-surface-selected", SURFACE_ID.SELECTED],
  ])

  const moveFlagToRouteId = new Map<string, number>([
    ["STEAM_CONVERGENCE", ROUTE_ID.DEVIG],
    ["--sd-route-devig", ROUTE_ID.DEVIG],
    ["SHRINKAGE_SHARP", ROUTE_ID.SHARP],
    ["--sd-route-sharp", ROUTE_ID.SHARP],
    ["LIQUIDITY_HALT", ROUTE_ID.PENDING],
    ["--sd-route-pending", ROUTE_ID.PENDING],
    ["TERMINAL_ENFORCE", ROUTE_ID.MANAGER],
    ["--sd-route-manager", ROUTE_ID.MANAGER],
  ])

  return Object.freeze({
    version: "1.5.0",
    channelMasks,
    channelPackedMeta,
    surfaceMasks,
    routeMasks,
    slaMasks,
    presets: Object.freeze({
      activeDomSurveillance: createPresetMaskWords(
        CHANNEL_GROUP_MASK.ACTIVE,
        SURFACE_MASK.DOM | SURFACE_GROUP_MASK.UI_CHROME,
        ROUTE_GROUP_MASK.ALL,
        SLA_STATE_MASK.FRESH | SLA_STATE_MASK.WARN,
      ),
      criticalInplayEscalation: createPresetMaskWords(
        CHANNEL_GROUP_MASK.ALERT_OR_CRITICAL | CHANNEL_GROUP_MASK.INPLAY,
        SURFACE_GROUP_MASK.ALL,
        ROUTE_GROUP_MASK.HALT_OR_ENFORCE,
        SLA_STATE_MASK.WARN | SLA_STATE_MASK.STALE | SLA_STATE_MASK.POISON,
      ),
      droppedSentinelFilter: createPresetMaskWords(
        CHANNEL_GROUP_MASK.DROPPED,
        SURFACE_GROUP_MASK.ALL,
        0,
        0,
      ),
      poisonQuarantineGate: createPresetMaskWords(
        CHANNEL_GROUP_MASK.ALL,
        SURFACE_GROUP_MASK.ALL,
        ROUTE_MASK.MANAGER,
        SLA_STATE_MASK.POISON | SLA_STATE_MASK.POISON_LATCH_BIT,
      ),
      partner118Routes: createPresetMaskWords(
        CHANNEL_GROUP_MASK.PARTNER_118_BRIDGE,
        SURFACE_MASK.DOM | SURFACE_MASK.CARD | SURFACE_MASK.SELECTED,
        ROUTE_MASK.DEVIG | ROUTE_MASK.SHARP,
        SLA_STATE_MASK.FRESH | SLA_STATE_MASK.WARN,
      ),
    }),
    aliasToChannelId,
    tokenNameToSurfaceId,
    moveFlagToRouteId,
  })
}

/** Static precompiled bitset registry (zero runtime I/O). */
export const PRECOMPUTED_TOKEN_BITSETS: CompiledTokenBitsets = buildStaticTokenBitsets()

// ── 7. Dynamic Compiler from `design/tokens.toml` ────────────────────────────

interface RawTomlForBitsets {
  readonly meta?: { readonly version?: string }
  readonly surfaces?: Record<string, { readonly token_name?: string }>
  readonly ui?: Record<string, { readonly token_name?: string; readonly role?: string }>
  readonly ingestion?: Record<
    string,
    {
      readonly channel_id?: number
      readonly source_bridge_id?: number
      readonly channel_code?: string
      readonly wire_aliases?: readonly string[]
      readonly channel_status?: string
      readonly sla_kind?: string
      readonly sla_tens_of_ms?: number
    }
  >
  readonly routes?: Record<
    string,
    {
      readonly route_id?: number
      readonly token_name?: string
      readonly move_flag?: string
    }
  >
}

const CANONICAL_SURFACE_ORDER: readonly string[] = [
  "--sd-surface-bg",
  "--sd-surface-cli",
  "--sd-surface-card",
  "--sd-surface-elevated",
  "--sd-surface-hover",
  "--sd-surface-raised",
  "--sd-surface-selected",
]

/**
 * Compiles `design/tokens.toml` directly into `Uint32Array` bitset masks and O(1) lookup tables.
 */
export function compileTokenBitsetsFromToml(
  tomlPath: string = resolve(process.cwd(), "design/tokens.toml"),
): CompiledTokenBitsets {
  const raw = readFileSync(tomlPath, "utf8")
  const parsed = parseToml(raw) as unknown as RawTomlForBitsets

  const ingestionList = Object.values(parsed.ingestion ?? {})
  let maxChannelId = 0
  for (const ch of ingestionList) {
    if (typeof ch.channel_id === "number" && ch.channel_id > maxChannelId) {
      maxChannelId = ch.channel_id
    }
  }
  if (maxChannelId > 30) {
    throw new RangeError(`Ingestion channel_id ${maxChannelId} exceeds BitSet32 bit-30 invariant`)
  }

  const channelMasks = new Uint32Array(maxChannelId + 1)
  const channelPackedMeta = new Uint32Array(maxChannelId + 1)
  const aliasToChannelId = new Map<string, number>()

  let activeChannelsMask = 0
  let droppedChannelsMask = 0
  let alertOrCriticalMask = 0
  let partner118Mask = 0

  for (const ch of ingestionList) {
    const id = ch.channel_id
    if (typeof id !== "number" || id < 0) continue
    const bit = (1 << id) >>> 0
    channelMasks[id] = bit

    let flags = 0
    if (ch.sla_kind === "latency") flags = (flags | PACKED_META_FLAG_LATENCY_GATED) >>> 0
    if (ch.channel_status === "DROPPED") {
      flags = (flags | PACKED_META_FLAG_DROPPED) >>> 0
      droppedChannelsMask = (droppedChannelsMask | bit) >>> 0
    }
    if (ch.channel_status === "ACTIVE") {
      activeChannelsMask = (activeChannelsMask | bit) >>> 0
    }
    if (ch.channel_status === "ALERT" || ch.channel_status === "CRITICAL") {
      flags = (flags | PACKED_META_FLAG_CRITICAL_OR_ALERT) >>> 0
      alertOrCriticalMask = (alertOrCriticalMask | bit) >>> 0
    }
    if (ch.source_bridge_id === 2) {
      partner118Mask = (partner118Mask | bit) >>> 0
    }

    channelPackedMeta[id] = packChannelMetaWord32(
      id,
      ch.sla_tens_of_ms ?? 0,
      ch.source_bridge_id ?? 0,
      flags,
    )

    if (ch.channel_code) {
      aliasToChannelId.set(ch.channel_code.trim().toUpperCase(), id)
    }
    if (Array.isArray(ch.wire_aliases)) {
      for (const alias of ch.wire_aliases) {
        aliasToChannelId.set(alias.trim().toUpperCase(), id)
      }
    }
  }

  // Surfaces ([surfaces.*] + [ui.*] with role === "surface")
  const discoveredSurfaces = new Set<string>()
  for (const s of Object.values(parsed.surfaces ?? {})) {
    if (s.token_name) discoveredSurfaces.add(s.token_name)
  }
  for (const u of Object.values(parsed.ui ?? {})) {
    if (u.role === "surface" && u.token_name) discoveredSurfaces.add(u.token_name)
  }

  const orderedSurfaces: string[] = []
  for (const name of CANONICAL_SURFACE_ORDER) {
    if (discoveredSurfaces.has(name)) orderedSurfaces.push(name)
  }
  for (const name of discoveredSurfaces) {
    if (!orderedSurfaces.includes(name)) orderedSurfaces.push(name)
  }
  if (orderedSurfaces.length > 31) {
    throw new RangeError(
      `Surface count ${orderedSurfaces.length} exceeds BitSet32 bit-30 invariant`,
    )
  }

  const surfaceMasks = new Uint32Array(orderedSurfaces.length)
  const tokenNameToSurfaceId = new Map<string, number>()
  let allSurfacesMask = 0
  for (let i = 0; i < orderedSurfaces.length; i += 1) {
    const bit = (1 << i) >>> 0
    surfaceMasks[i] = bit
    tokenNameToSurfaceId.set(orderedSurfaces[i]!, i)
    allSurfacesMask = (allSurfacesMask | bit) >>> 0
  }

  // Routes ([routes.*])
  const routeList = Object.values(parsed.routes ?? {})
  let maxRouteId = 0
  for (const r of routeList) {
    if (typeof r.route_id === "number" && r.route_id > maxRouteId) {
      maxRouteId = r.route_id
    }
  }
  const routeMasks = new Uint32Array(maxRouteId + 1)
  const moveFlagToRouteId = new Map<string, number>()
  let allRoutesMask = 0
  for (const r of routeList) {
    const id = r.route_id
    if (typeof id !== "number" || id < 0) continue
    const bit = (1 << id) >>> 0
    routeMasks[id] = bit
    allRoutesMask = (allRoutesMask | bit) >>> 0
    if (r.move_flag) moveFlagToRouteId.set(r.move_flag, id)
    if (r.token_name) moveFlagToRouteId.set(r.token_name, id)
  }

  const slaMasks = Uint32Array.from([
    SLA_STATE_MASK.FRESH,
    SLA_STATE_MASK.WARN,
    SLA_STATE_MASK.STALE,
    SLA_STATE_MASK.POISON,
  ])

  const allChannelsMask = ((1 << channelMasks.length) - 1) >>> 0
  const uiChromeMask = (allSurfacesMask & ~SURFACE_MASK.CLI) >>> 0
  const inplayMask =
    ((aliasToChannelId.has("GSLIVE") ? channelMasks[aliasToChannelId.get("GSLIVE")!]! : 0) |
      (aliasToChannelId.has("LIVEBETTINGCWS")
        ? channelMasks[aliasToChannelId.get("LIVEBETTINGCWS")!]!
        : 0)) >>>
    0

  return Object.freeze({
    version: parsed.meta?.version ?? "unknown",
    channelMasks,
    channelPackedMeta,
    surfaceMasks,
    routeMasks,
    slaMasks,
    presets: Object.freeze({
      activeDomSurveillance: createPresetMaskWords(
        activeChannelsMask,
        uiChromeMask,
        allRoutesMask,
        SLA_STATE_MASK.FRESH | SLA_STATE_MASK.WARN,
      ),
      criticalInplayEscalation: createPresetMaskWords(
        (alertOrCriticalMask | inplayMask) >>> 0,
        allSurfacesMask,
        ROUTE_GROUP_MASK.HALT_OR_ENFORCE,
        SLA_STATE_MASK.WARN | SLA_STATE_MASK.STALE | SLA_STATE_MASK.POISON,
      ),
      droppedSentinelFilter: createPresetMaskWords(droppedChannelsMask, allSurfacesMask, 0, 0),
      poisonQuarantineGate: createPresetMaskWords(
        allChannelsMask,
        allSurfacesMask,
        ROUTE_MASK.MANAGER,
        SLA_STATE_MASK.POISON | SLA_STATE_MASK.POISON_LATCH_BIT,
      ),
      partner118Routes: createPresetMaskWords(
        partner118Mask,
        SURFACE_MASK.DOM | SURFACE_MASK.CARD | SURFACE_MASK.SELECTED,
        ROUTE_MASK.DEVIG | ROUTE_MASK.SHARP,
        SLA_STATE_MASK.FRESH | SLA_STATE_MASK.WARN,
      ),
    }),
    aliasToChannelId,
    tokenNameToSurfaceId,
    moveFlagToRouteId,
  })
}

// ── 8. Reusable Zero-Allocation `TokenBitsetBuffer` ──────────────────────────

/**
 * Reusable 4-word `Uint32Array` hot-path classification buffer.
 * Call `.clear()` between events/ticks to reset all words to zero in O(1)
 * without allocating a new `Uint32Array`.
 */
export class TokenBitsetBuffer {
  readonly words: Uint32Array
  private readonly registry: CompiledTokenBitsets

  constructor(registry: CompiledTokenBitsets = PRECOMPUTED_TOKEN_BITSETS) {
    this.registry = registry
    this.words = new Uint32Array(TOKEN_BITSET_WORD_COUNT)
  }

  /** Resets all bitset words in place (`words.fill(0)`). O(1), zero allocations. */
  clear(): this {
    this.words.fill(0)
    return this
  }

  /**
   * Single-call O(1) hot-path event classifier: clears the reusable buffer and
   * populates ingestion channel, surface, route, and DualClock SLA state bits.
   * Pass `-1` for any axis not applicable to the current event.
   */
  classify(
    channelId: number,
    surfaceId: number,
    routeId: number,
    slaStateCode: SlaStateCode | -1,
    uiStateMask: number = 0,
  ): this {
    const w = this.words
    w[WORD_INGESTION] =
      channelId >= 0 && channelId < this.registry.channelMasks.length
        ? (this.registry.channelMasks[channelId] ?? 0)
        : 0
    w[WORD_SURFACE] =
      surfaceId >= 0 && surfaceId < this.registry.surfaceMasks.length
        ? (this.registry.surfaceMasks[surfaceId] ?? 0)
        : 0
    w[WORD_ROUTE] =
      routeId >= 0 && routeId < this.registry.routeMasks.length
        ? (this.registry.routeMasks[routeId] ?? 0)
        : 0
    const slaBit =
      slaStateCode >= 0 && slaStateCode < this.registry.slaMasks.length
        ? (this.registry.slaMasks[slaStateCode] ?? 0)
        : 0
    w[WORD_SLA_UI] = (slaBit | (uiStateMask & STALE_SNAPSHOT_POISON_BIT)) >>> 0
    return this
  }

  setChannel(channelId: number): this {
    if (channelId >= 0 && channelId < this.registry.channelMasks.length) {
      this.words[WORD_INGESTION] =
        (this.words[WORD_INGESTION]! | this.registry.channelMasks[channelId]!) >>> 0
    }
    return this
  }

  setChannelMask(mask: number): this {
    this.words[WORD_INGESTION] = (this.words[WORD_INGESTION]! | (mask >>> 0)) >>> 0
    return this
  }

  hasChannel(channelId: number): boolean {
    if (channelId < 0 || channelId >= this.registry.channelMasks.length) return false
    return (this.words[WORD_INGESTION]! & this.registry.channelMasks[channelId]!) !== 0
  }

  matchesChannelMask(mask: number): boolean {
    return (this.words[WORD_INGESTION]! & (mask >>> 0)) !== 0
  }

  setSurface(surfaceId: number): this {
    if (surfaceId >= 0 && surfaceId < this.registry.surfaceMasks.length) {
      this.words[WORD_SURFACE] =
        (this.words[WORD_SURFACE]! | this.registry.surfaceMasks[surfaceId]!) >>> 0
    }
    return this
  }

  setSurfaceMask(mask: number): this {
    this.words[WORD_SURFACE] = (this.words[WORD_SURFACE]! | (mask >>> 0)) >>> 0
    return this
  }

  hasSurface(surfaceId: number): boolean {
    if (surfaceId < 0 || surfaceId >= this.registry.surfaceMasks.length) return false
    return (this.words[WORD_SURFACE]! & this.registry.surfaceMasks[surfaceId]!) !== 0
  }

  matchesSurfaceMask(mask: number): boolean {
    return (this.words[WORD_SURFACE]! & (mask >>> 0)) !== 0
  }

  setRoute(routeId: number): this {
    if (routeId >= 0 && routeId < this.registry.routeMasks.length) {
      this.words[WORD_ROUTE] = (this.words[WORD_ROUTE]! | this.registry.routeMasks[routeId]!) >>> 0
    }
    return this
  }

  setRouteMask(mask: number): this {
    this.words[WORD_ROUTE] = (this.words[WORD_ROUTE]! | (mask >>> 0)) >>> 0
    return this
  }

  hasRoute(routeId: number): boolean {
    if (routeId < 0 || routeId >= this.registry.routeMasks.length) return false
    return (this.words[WORD_ROUTE]! & this.registry.routeMasks[routeId]!) !== 0
  }

  matchesRouteMask(mask: number): boolean {
    return (this.words[WORD_ROUTE]! & (mask >>> 0)) !== 0
  }

  setSlaState(stateCode: SlaStateCode): this {
    if (stateCode >= 0 && stateCode < this.registry.slaMasks.length) {
      this.words[WORD_SLA_UI] =
        (this.words[WORD_SLA_UI]! | this.registry.slaMasks[stateCode]!) >>> 0
    }
    return this
  }

  hasSlaState(stateCode: SlaStateCode): boolean {
    if (stateCode < 0 || stateCode >= this.registry.slaMasks.length) return false
    return (this.words[WORD_SLA_UI]! & this.registry.slaMasks[stateCode]!) !== 0
  }

  setPoisonBit(): this {
    this.words[WORD_SLA_UI] = (this.words[WORD_SLA_UI]! | STALE_SNAPSHOT_POISON_BIT) >>> 0
    return this
  }

  hasPoisonBit(): boolean {
    return (this.words[WORD_SLA_UI]! & STALE_SNAPSHOT_POISON_BIT) !== 0
  }

  /** In-place bitwise OR with a 4-word `Uint32Array` mask. Zero allocations. */
  orInto(maskWords: Uint32Array): this {
    const w = this.words
    w[0] = (w[0]! | (maskWords[0] ?? 0)) >>> 0
    w[1] = (w[1]! | (maskWords[1] ?? 0)) >>> 0
    w[2] = (w[2]! | (maskWords[2] ?? 0)) >>> 0
    w[3] = (w[3]! | (maskWords[3] ?? 0)) >>> 0
    return this
  }

  /** In-place bitwise AND with a 4-word `Uint32Array` mask. Zero allocations. */
  andInto(maskWords: Uint32Array): this {
    const w = this.words
    w[0] = (w[0]! & (maskWords[0] ?? 0)) >>> 0
    w[1] = (w[1]! & (maskWords[1] ?? 0)) >>> 0
    w[2] = (w[2]! & (maskWords[2] ?? 0)) >>> 0
    w[3] = (w[3]! & (maskWords[3] ?? 0)) >>> 0
    return this
  }

  /** True if every non-zero axis word in `presetWords` overlaps with this buffer. O(1). */
  matchesPreset(presetWords: Uint32Array): boolean {
    const w = this.words
    if (presetWords[0]! !== 0 && (w[0]! & presetWords[0]!) === 0) return false
    if (presetWords[1]! !== 0 && (w[1]! & presetWords[1]!) === 0) return false
    if (presetWords[2]! !== 0 && (w[2]! & presetWords[2]!) === 0) return false
    if (presetWords[3]! !== 0 && (w[3]! & presetWords[3]!) === 0) return false
    return true
  }

  /** True if any bit overlaps across all 4 words. O(1). */
  intersects(otherWords: Uint32Array): boolean {
    const w = this.words
    return (
      (w[0]! & (otherWords[0] ?? 0)) !== 0 ||
      (w[1]! & (otherWords[1] ?? 0)) !== 0 ||
      (w[2]! & (otherWords[2] ?? 0)) !== 0 ||
      (w[3]! & (otherWords[3] ?? 0)) !== 0
    )
  }

  /** True if every set bit in `requiredWords` is present in this buffer. O(1). */
  containsAll(requiredWords: Uint32Array): boolean {
    const w = this.words
    return (
      (w[0]! & (requiredWords[0] ?? 0)) === (requiredWords[0] ?? 0) >>> 0 &&
      (w[1]! & (requiredWords[1] ?? 0)) === (requiredWords[1] ?? 0) >>> 0 &&
      (w[2]! & (requiredWords[2] ?? 0)) === (requiredWords[2] ?? 0) >>> 0 &&
      (w[3]! & (requiredWords[3] ?? 0)) === (requiredWords[3] ?? 0) >>> 0
    )
  }

  /** Total set bits across all 4 words using SWAR `popcount32`. O(1). */
  popcount(): number {
    const w = this.words
    return popcount32(w[0]!) + popcount32(w[1]!) + popcount32(w[2]!) + popcount32(w[3]!)
  }
}
