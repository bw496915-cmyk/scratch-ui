import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import {
  DualClockSlaEvaluator,
  SLA_STATE_FRESH,
  SLA_STATE_POISON,
  SLA_STATE_STALE,
  SLA_STATE_WARN,
  STALE_SNAPSHOT_POISON_BIT,
} from "../../src/lib/dual_clock_sla.ts"
import {
  CHANNEL_GROUP_MASK,
  CHANNEL_ID,
  CHANNEL_MASK,
  compileTokenBitsetsFromToml,
  createPresetMaskWords,
  PACKED_META_FLAG_CRITICAL_OR_ALERT,
  PACKED_META_FLAG_DROPPED,
  PACKED_META_FLAG_LATENCY_GATED,
  PRECOMPUTED_TOKEN_BITSETS,
  ROUTE_GROUP_MASK,
  ROUTE_ID,
  ROUTE_MASK,
  SLA_STATE_MASK,
  SURFACE_GROUP_MASK,
  SURFACE_ID,
  SURFACE_MASK,
  TOKEN_BITSET_WORD_COUNT,
  TokenBitsetBuffer,
  unpackBridgeIdFromMeta,
  unpackChannelIdFromMeta,
  unpackSlaTensOfMsFromMeta,
  WORD_INGESTION,
  WORD_ROUTE,
  WORD_SLA_UI,
  WORD_SURFACE,
} from "../../src/lib/token_bitsets.ts"

const TOKENS_TOML_PATH = resolve(process.cwd(), "design/tokens.toml")

describe("Precomputed Uint32Array Token Bitsets — design/tokens.toml compilation parity", () => {
  test("compileTokenBitsetsFromToml matches PRECOMPUTED_TOKEN_BITSETS byte-for-byte", () => {
    const compiled = compileTokenBitsetsFromToml(TOKENS_TOML_PATH)

    expect(compiled.channelMasks).toBeInstanceOf(Uint32Array)
    expect(compiled.channelPackedMeta).toBeInstanceOf(Uint32Array)
    expect(compiled.surfaceMasks).toBeInstanceOf(Uint32Array)
    expect(compiled.routeMasks).toBeInstanceOf(Uint32Array)
    expect(compiled.slaMasks).toBeInstanceOf(Uint32Array)

    expect(Array.from(compiled.channelMasks)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.channelMasks),
    )
    expect(Array.from(compiled.channelPackedMeta)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.channelPackedMeta),
    )
    expect(Array.from(compiled.surfaceMasks)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.surfaceMasks),
    )
    expect(Array.from(compiled.routeMasks)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.routeMasks),
    )
    expect(Array.from(compiled.slaMasks)).toEqual(Array.from(PRECOMPUTED_TOKEN_BITSETS.slaMasks))

    expect(Array.from(compiled.presets.activeDomSurveillance)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.presets.activeDomSurveillance),
    )
    expect(Array.from(compiled.presets.criticalInplayEscalation)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.presets.criticalInplayEscalation),
    )
    expect(Array.from(compiled.presets.droppedSentinelFilter)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.presets.droppedSentinelFilter),
    )
    expect(Array.from(compiled.presets.poisonQuarantineGate)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.presets.poisonQuarantineGate),
    )
    expect(Array.from(compiled.presets.partner118Routes)).toEqual(
      Array.from(PRECOMPUTED_TOKEN_BITSETS.presets.partner118Routes),
    )
  })

  test("packed channel metadata words decode channel_id, sla_tens_of_ms, bridge_id, and flags", () => {
    const meta = PRECOMPUTED_TOKEN_BITSETS.channelPackedMeta

    // ALERT (channel 4): 250ms -> 25 tens-of-ms, Fantasy402 bridge 1, latency + critical/alert
    const alertWord = meta[CHANNEL_ID.ALERT]!
    expect(unpackChannelIdFromMeta(alertWord)).toBe(4)
    expect(unpackSlaTensOfMsFromMeta(alertWord)).toBe(25)
    expect(unpackBridgeIdFromMeta(alertWord)).toBe(1)
    expect((alertWord & PACKED_META_FLAG_LATENCY_GATED) !== 0).toBe(true)
    expect((alertWord & PACKED_META_FLAG_CRITICAL_OR_ALERT) !== 0).toBe(true)

    // GSLIVE (channel 6): 500ms -> 50 tens-of-ms, Partner 118 bridge 2
    const gsliveWord = meta[CHANNEL_ID.GSLIVE]!
    expect(unpackChannelIdFromMeta(gsliveWord)).toBe(6)
    expect(unpackSlaTensOfMsFromMeta(gsliveWord)).toBe(50)
    expect(unpackBridgeIdFromMeta(gsliveWord)).toBe(2)
    expect((gsliveWord & PACKED_META_FLAG_CRITICAL_OR_ALERT) !== 0).toBe(true)

    // NON_SPORTS (channel 0): sentinel_drop -> 0, bridge 0, dropped flag
    const dropWord = meta[CHANNEL_ID.NON_SPORTS]!
    expect(unpackChannelIdFromMeta(dropWord)).toBe(0)
    expect(unpackSlaTensOfMsFromMeta(dropWord)).toBe(0)
    expect(unpackBridgeIdFromMeta(dropWord)).toBe(0)
    expect((dropWord & PACKED_META_FLAG_DROPPED) !== 0).toBe(true)
    expect((dropWord & PACKED_META_FLAG_LATENCY_GATED) !== 0).toBe(false)
  })

  test("maps all wire aliases, surface tokens, and risk route flags in O(1)", () => {
    const compiled = compileTokenBitsetsFromToml(TOKENS_TOML_PATH)

    expect(compiled.aliasToChannelId.get("CASINO")).toBe(CHANNEL_ID.NON_SPORTS)
    expect(compiled.aliasToChannelId.get("MOBILE")).toBe(CHANNEL_ID.INTERNET)
    expect(compiled.aliasToChannelId.get("BLOCKED")).toBe(CHANNEL_ID.BLOCKED)
    expect(compiled.aliasToChannelId.get("EZLIVE")).toBe(CHANNEL_ID.LIVEBETTINGCWS)
    expect(compiled.aliasToChannelId.get("CLERK")).toBe(CHANNEL_ID.PHONE)
    expect(compiled.aliasToChannelId.get("AGENT")).toBe(CHANNEL_ID.HOUSE)

    expect(compiled.tokenNameToSurfaceId.get("--sd-surface-bg")).toBe(SURFACE_ID.DOM)
    expect(compiled.tokenNameToSurfaceId.get("--sd-surface-cli")).toBe(SURFACE_ID.CLI)
    expect(compiled.tokenNameToSurfaceId.get("--sd-surface-selected")).toBe(SURFACE_ID.SELECTED)

    expect(compiled.moveFlagToRouteId.get("STEAM_CONVERGENCE")).toBe(ROUTE_ID.DEVIG)
    expect(compiled.moveFlagToRouteId.get("SHRINKAGE_SHARP")).toBe(ROUTE_ID.SHARP)
    expect(compiled.moveFlagToRouteId.get("LIQUIDITY_HALT")).toBe(ROUTE_ID.PENDING)
    expect(compiled.moveFlagToRouteId.get("TERMINAL_ENFORCE")).toBe(ROUTE_ID.MANAGER)
  })

  test("all precomputed single-bit masks obey unsigned BitSet32 invariant (positive, power of two)", () => {
    const checkPowerOfTwo = (arr: Uint32Array) => {
      for (let i = 0; i < arr.length; i += 1) {
        const m = arr[i]!
        expect(m).toBeGreaterThan(0)
        expect(m <= 0x40000000).toBe(true)
        expect((m & (m - 1)) === 0).toBe(true)
      }
    }
    checkPowerOfTwo(PRECOMPUTED_TOKEN_BITSETS.channelMasks)
    checkPowerOfTwo(PRECOMPUTED_TOKEN_BITSETS.surfaceMasks)
    checkPowerOfTwo(PRECOMPUTED_TOKEN_BITSETS.routeMasks)
    checkPowerOfTwo(PRECOMPUTED_TOKEN_BITSETS.slaMasks)
  })
})

describe("TokenBitsetBuffer — reusable .clear() O(1) hot-path classification", () => {
  test("reuses the exact underlying Uint32Array across .clear() and hot-path classify loops", () => {
    const buf = new TokenBitsetBuffer(PRECOMPUTED_TOKEN_BITSETS)
    const backingRef = buf.words

    expect(backingRef).toBeInstanceOf(Uint32Array)
    expect(backingRef.length).toBe(TOKEN_BITSET_WORD_COUNT)

    buf.classify(CHANNEL_ID.GSLIVE, SURFACE_ID.DOM, ROUTE_ID.MANAGER, SLA_STATE_STALE)
    expect(buf.hasChannel(CHANNEL_ID.GSLIVE)).toBe(true)
    expect(buf.hasSurface(SURFACE_ID.DOM)).toBe(true)
    expect(buf.hasRoute(ROUTE_ID.MANAGER)).toBe(true)
    expect(buf.hasSlaState(SLA_STATE_STALE)).toBe(true)
    expect(buf.popcount()).toBe(4)
    expect(buf.matchesPreset(PRECOMPUTED_TOKEN_BITSETS.presets.criticalInplayEscalation)).toBe(true)
    expect(buf.matchesPreset(PRECOMPUTED_TOKEN_BITSETS.presets.activeDomSurveillance)).toBe(false)

    // .clear() zeroes all words in place without allocating a new Uint32Array
    buf.clear()
    expect(buf.words).toBe(backingRef)
    expect(buf.words[WORD_INGESTION]).toBe(0)
    expect(buf.words[WORD_SURFACE]).toBe(0)
    expect(buf.words[WORD_ROUTE]).toBe(0)
    expect(buf.words[WORD_SLA_UI]).toBe(0)
    expect(buf.popcount()).toBe(0)

    // Re-classify 25,000 events reusing the single buffer
    for (let i = 0; i < 25_000; i += 1) {
      const ch = i % 11
      const sf = i % 7
      const rt = i % 4
      const sla = (i % 4) as 0 | 1 | 2 | 3
      buf.clear().classify(ch, sf, rt, sla)
      expect(buf.hasChannel(ch)).toBe(true)
      expect(buf.hasSurface(sf)).toBe(true)
      expect(buf.hasRoute(rt)).toBe(true)
      expect(buf.hasSlaState(sla)).toBe(true)
    }
    expect(buf.words).toBe(backingRef)
  })

  test("supports bitwise set composition (orInto, andInto, intersects, containsAll)", () => {
    const buf = new TokenBitsetBuffer()
    buf
      .setChannelMask(CHANNEL_GROUP_MASK.PARTNER_118_BRIDGE)
      .setSurface(SURFACE_ID.CARD)
      .setSurface(SURFACE_ID.SELECTED)
      .setRouteMask(ROUTE_GROUP_MASK.REPRICE_OR_RECALIBRATE)
      .setSlaState(SLA_STATE_FRESH)

    expect(buf.matchesChannelMask(CHANNEL_MASK.GSBUILDER)).toBe(true)
    expect(buf.matchesChannelMask(CHANNEL_MASK.GSLIVE)).toBe(true)
    expect(buf.matchesChannelMask(CHANNEL_MASK.INTERNET)).toBe(false)
    expect(buf.matchesSurfaceMask(SURFACE_GROUP_MASK.UI_CHROME)).toBe(true)
    expect(buf.matchesRouteMask(ROUTE_MASK.SHARP)).toBe(true)

    const required = createPresetMaskWords(
      CHANNEL_MASK.GSLIVE,
      SURFACE_MASK.SELECTED,
      ROUTE_MASK.DEVIG,
      SLA_STATE_MASK.FRESH,
    )
    expect(buf.containsAll(required)).toBe(true)
    expect(buf.intersects(PRECOMPUTED_TOKEN_BITSETS.presets.partner118Routes)).toBe(true)

    // Intersect in-place with partner118Routes preset
    buf.andInto(PRECOMPUTED_TOKEN_BITSETS.presets.partner118Routes)
    expect(buf.hasChannel(CHANNEL_ID.GSLIVE)).toBe(true)
    expect(buf.hasSurface(SURFACE_ID.CARD)).toBe(true)
    expect(buf.hasRoute(ROUTE_ID.DEVIG)).toBe(true)

    // OR in poison quarantine gate
    buf.orInto(PRECOMPUTED_TOKEN_BITSETS.presets.poisonQuarantineGate)
    expect(buf.hasPoisonBit()).toBe(true)
    expect(buf.hasSlaState(SLA_STATE_POISON)).toBe(true)
  })

  test("integrates directly with DualClockSlaEvaluator states for O(1) quarantine gating", () => {
    const evaluator = new DualClockSlaEvaluator(
      {},
      { monotonicNs: () => 2_000_000, wallEpochMs: () => 1_760_000_000_000 },
    )
    const classifier = new TokenBitsetBuffer()

    // 1. Healthy tick -> matches activeDomSurveillance
    const freshSla = evaluator.tickScalars(
      95,
      0,
      5,
      0,
      12,
      100,
      1_760_000_000_000,
      1_760_000_000_000,
    )
    classifier.classify(CHANNEL_ID.INTERNET, SURFACE_ID.CARD, ROUTE_ID.DEVIG, freshSla)
    expect(classifier.matchesPreset(PRECOMPUTED_TOKEN_BITSETS.presets.activeDomSurveillance)).toBe(
      true,
    )
    expect(classifier.matchesPreset(PRECOMPUTED_TOKEN_BITSETS.presets.poisonQuarantineGate)).toBe(
      false,
    )

    // 2. Poison DNS error spike -> matches poisonQuarantineGate
    const poisonSla = evaluator.tickScalars(
      50,
      0,
      10,
      40,
      12,
      100,
      1_760_000_000_000,
      1_760_000_000_000,
      STALE_SNAPSHOT_POISON_BIT,
    )
    expect(poisonSla).toBe(SLA_STATE_POISON)
    classifier.classify(
      CHANNEL_ID.GSLIVE,
      SURFACE_ID.DOM,
      ROUTE_ID.MANAGER,
      poisonSla,
      evaluator.reasonMask,
    )
    expect(classifier.matchesPreset(PRECOMPUTED_TOKEN_BITSETS.presets.poisonQuarantineGate)).toBe(
      true,
    )
    expect(classifier.hasPoisonBit()).toBe(true)
  })
})
