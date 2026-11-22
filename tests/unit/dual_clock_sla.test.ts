import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { resolve } from "node:path"

import { readBunDnsTelemetry } from "../../server/bun_dns.ts"
import {
  CHANNEL_SLA_MS_TABLE,
  CHANNEL_WARN_MS_TABLE,
  DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS,
  DualClockSlaEvaluator,
  loadSlaTokensFromToml,
  SLA_REASON_CLOCK_SKEW_POISON,
  SLA_REASON_DNS_ERROR_POISON,
  SLA_REASON_DNS_ERROR_STALE,
  SLA_REASON_DNS_ERROR_WARN,
  SLA_REASON_DNS_INFLIGHT_WARN,
  SLA_REASON_DNS_MISS_STALE,
  SLA_REASON_DNS_MISS_WARN,
  SLA_REASON_NONE,
  SLA_REASON_POISON_BIT_LATCHED,
  SLA_REASON_PROBE_STALE,
  SLA_REASON_PROBE_WARN,
  SLA_REASON_PUBLISH_STALE,
  SLA_REASON_PUBLISH_WARN,
  SLA_REASON_WINDOW_LAG_STALE,
  SLA_REASON_WINDOW_LAG_WARN,
  SLA_STATE_FRESH,
  SLA_STATE_POISON,
  SLA_STATE_STALE,
  SLA_STATE_WARN,
  SLA_TOKEN_TABLE,
  STALE_SNAPSHOT_POISON_BIT,
  thresholdsForChannel,
} from "../../src/lib/dual_clock_sla.ts"
import { CHANNEL_ID } from "../../src/lib/token_bitsets.ts"

const TOKENS_TOML_PATH = resolve(process.cwd(), "design/tokens.toml")

describe("DualClock SLA Evaluator — design/tokens.toml SSOT parity", () => {
  test("SLA_TOKEN_TABLE and CHANNEL_SLA_MS_TABLE stay byte-identical to design/tokens.toml", () => {
    const loaded = loadSlaTokensFromToml(TOKENS_TOML_PATH)

    expect(loaded.slaTokens).toHaveLength(4)
    for (let i = 0; i < 4; i += 1) {
      expect(SLA_TOKEN_TABLE[i]).toEqual(loaded.slaTokens[i])
    }

    expect(Array.from(CHANNEL_SLA_MS_TABLE)).toEqual(Array.from(loaded.channelSlaMs))
    expect(Array.from(CHANNEL_WARN_MS_TABLE)).toEqual(Array.from(loaded.channelWarnMs))
    expect(loaded.poisonBitPosition).toBe(30)
    expect(loaded.poisonBitMask).toBe(STALE_SNAPSHOT_POISON_BIT)
    expect(STALE_SNAPSHOT_POISON_BIT).toBe(0x40000000)
  })

  test("thresholdsForChannel maps channel latency budgets and half-window warn thresholds", () => {
    const alert = thresholdsForChannel(CHANNEL_ID.ALERT)
    expect(alert.probeStaleMs).toBe(250)
    expect(alert.probeWarnMs).toBe(125)

    const gslive = thresholdsForChannel(CHANNEL_ID.GSLIVE)
    expect(gslive.probeStaleMs).toBe(500)
    expect(gslive.probeWarnMs).toBe(250)

    const internet = thresholdsForChannel(CHANNEL_ID.INTERNET)
    expect(internet.probeStaleMs).toBe(1500)
    expect(internet.probeWarnMs).toBe(750)

    // Sentinel drop channels inherit default operational probe window
    const blocked = thresholdsForChannel(CHANNEL_ID.BLOCKED)
    expect(blocked.probeStaleMs).toBe(DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.probeStaleMs)
    expect(blocked.probeWarnMs).toBe(DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.probeWarnMs)
  })
})

describe("DualClock SLA Evaluator — MonotonicClock & WallClock transitions", () => {
  test("maps monotonic elapsed probe intervals to FRESH -> WARN -> STALE per channel SLA", () => {
    let monoNs = 1_000_000_000
    let wallMs = 1_760_000_000_000

    const evaluator = new DualClockSlaEvaluator(thresholdsForChannel(CHANNEL_ID.ALERT), {
      monotonicNs: () => monoNs,
      wallEpochMs: () => wallMs,
    })

    // 1. Fresh probe (80ms < 125ms warn for ALERT 250ms SLA)
    evaluator.beginProbe()
    monoNs += 80_000_000
    expect(evaluator.tickScalars(40, 0, 2, 0, 10, 42, wallMs - 1_000, wallMs - 2_000)).toBe(
      SLA_STATE_FRESH,
    )
    expect(evaluator.reasonMask).toBe(SLA_REASON_NONE)
    expect(evaluator.lastElapsedMs).toBe(80)
    expect(evaluator.getToken().stateId).toBe("SLA_FRESH")
    expect(evaluator.getToken().tokenName).toBe("--sd-sla-fresh")

    // 2. Half-window aging advisory (125ms >= 125ms warn, <= 250ms stale)
    evaluator.beginProbe()
    monoNs += 150_000_000
    expect(evaluator.tickScalars(40, 0, 2, 0, 10, 42, wallMs - 1_000, wallMs - 2_000)).toBe(
      SLA_STATE_WARN,
    )
    expect((evaluator.reasonMask & SLA_REASON_PROBE_WARN) !== 0).toBe(true)
    expect(evaluator.getToken().stateId).toBe("SLA_WARN")
    expect(evaluator.getToken().glyph).toBe("◐")

    // 3. Stale probe (> 250ms ALERT SLA)
    evaluator.beginProbe()
    monoNs += 280_000_000
    expect(evaluator.tickScalars(40, 0, 2, 0, 10, 42, wallMs - 1_000, wallMs - 2_000)).toBe(
      SLA_STATE_STALE,
    )
    expect((evaluator.reasonMask & SLA_REASON_PROBE_STALE) !== 0).toBe(true)
    expect(evaluator.getToken().stateId).toBe("SLA_STALE")
    expect(evaluator.getToken().borderStyle).toBe("dashed")

    // 4. Switching channel SLA dynamically to Internet (1500ms) restores FRESH for 280ms
    evaluator.selectChannelSla(CHANNEL_ID.INTERNET)
    evaluator.beginProbe()
    monoNs += 280_000_000
    expect(evaluator.tickScalars(40, 0, 2, 0, 10, 42, wallMs - 1_000, wallMs - 2_000)).toBe(
      SLA_STATE_FRESH,
    )
  })

  test("evaluates wall-clock publish age, window lag, and future clock skew", () => {
    const monoNs = 500_000_000
    const wallMs = 1_760_000_100_000

    const evaluator = new DualClockSlaEvaluator(
      {},
      { monotonicNs: () => monoNs, wallEpochMs: () => wallMs },
    )

    // Half-window publish age (20s >= 15s warn, <= 30s stale)
    expect(
      evaluator.tickScalars(30, 0, 1, 0, 5, 31, wallMs - 20_000, wallMs - 5_000, 0, 10_000_000),
    ).toBe(SLA_STATE_WARN)
    expect((evaluator.reasonMask & SLA_REASON_PUBLISH_WARN) !== 0).toBe(true)

    // BLK_R2_PUBLISH_STALE (35s > 30s)
    expect(
      evaluator.tickScalars(30, 0, 1, 0, 5, 31, wallMs - 35_000, wallMs - 5_000, 0, 10_000_000),
    ).toBe(SLA_STATE_STALE)
    expect((evaluator.reasonMask & SLA_REASON_PUBLISH_STALE) !== 0).toBe(true)

    // Half-window upstream data lag (40s >= 30s warn)
    expect(
      evaluator.tickScalars(30, 0, 1, 0, 5, 31, wallMs - 2_000, wallMs - 40_000, 0, 10_000_000),
    ).toBe(SLA_STATE_WARN)
    expect((evaluator.reasonMask & SLA_REASON_WINDOW_LAG_WARN) !== 0).toBe(true)

    // BLK_R2_WINDOW_LAG_STALE (65s > 60s)
    expect(
      evaluator.tickScalars(30, 0, 1, 0, 5, 31, wallMs - 2_000, wallMs - 65_000, 0, 10_000_000),
    ).toBe(SLA_STATE_STALE)
    expect((evaluator.reasonMask & SLA_REASON_WINDOW_LAG_STALE) !== 0).toBe(true)

    // Future wall-clock skew (> 5s in the future) latches SLA_POISON
    expect(evaluator.tickScalars(30, 0, 1, 0, 5, 31, wallMs + 10_000, wallMs, 0, 10_000_000)).toBe(
      SLA_STATE_POISON,
    )
    expect((evaluator.reasonMask & SLA_REASON_CLOCK_SKEW_POISON) !== 0).toBe(true)
    expect(evaluator.poisonLatched).toBe(true)
  })
})

describe("DualClock SLA Evaluator — Bun.dns.getCacheStats() binding & poison latch", () => {
  let statsSpy: ReturnType<typeof spyOn> | null = null

  afterEach(() => {
    statsSpy?.mockRestore()
    statsSpy = null
  })

  test("binds cacheHitsCompleted, cacheHitsInflight, cacheMisses, and errors to deterministic SLA states", () => {
    const evaluator = new DualClockSlaEvaluator(
      {},
      { monotonicNs: () => 10_000_000, wallEpochMs: () => 1_760_000_000_000 },
    )

    // Healthy cache: 90% hit rate, 0 errors -> SLA_FRESH
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 88,
          cacheHitsInflight: 2,
          cacheMisses: 10,
          errors: 0,
          size: 10,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_FRESH)
    expect(evaluator.dnsHitRateBps).toBe(9000)
    expect(evaluator.dnsMissRateBps).toBe(1000)
    expect(evaluator.dnsErrorRateBps).toBe(0)

    // Inflight spike (10 >= 8) -> SLA_WARN
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 80,
          cacheHitsInflight: 10,
          cacheMisses: 10,
          errors: 0,
          size: 10,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_WARN)
    expect((evaluator.reasonMask & SLA_REASON_DNS_INFLIGHT_WARN) !== 0).toBe(true)

    // Elevated cache misses (60% >= 50% warn) -> SLA_WARN
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 40,
          cacheHitsInflight: 0,
          cacheMisses: 60,
          errors: 0,
          size: 20,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_WARN)
    expect((evaluator.reasonMask & SLA_REASON_DNS_MISS_WARN) !== 0).toBe(true)

    // Cache thrash (85% > 80% stale) -> SLA_STALE
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 15,
          cacheHitsInflight: 0,
          cacheMisses: 85,
          errors: 0,
          size: 25,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_STALE)
    expect((evaluator.reasonMask & SLA_REASON_DNS_MISS_STALE) !== 0).toBe(true)

    // DNS error warn (3% >= 2% warn) -> SLA_WARN
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 90,
          cacheHitsInflight: 0,
          cacheMisses: 7,
          errors: 3,
          size: 10,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_WARN)
    expect((evaluator.reasonMask & SLA_REASON_DNS_ERROR_WARN) !== 0).toBe(true)

    // DNS error stale (8% > 5% stale) -> SLA_STALE
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 85,
          cacheHitsInflight: 0,
          cacheMisses: 7,
          errors: 8,
          size: 10,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_STALE)
    expect((evaluator.reasonMask & SLA_REASON_DNS_ERROR_STALE) !== 0).toBe(true)

    // DNS error poison (25% >= 20% poison) -> latches SLA_POISON
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 60,
          cacheHitsInflight: 0,
          cacheMisses: 15,
          errors: 25,
          size: 10,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_POISON)
    expect((evaluator.reasonMask & SLA_REASON_DNS_ERROR_POISON) !== 0).toBe(true)
    expect(evaluator.poisonLatched).toBe(true)

    // Healthy sample still stays SLA_POISON until explicit clearPoison()
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 99,
          cacheHitsInflight: 0,
          cacheMisses: 1,
          errors: 0,
          size: 10,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_POISON)
    expect((evaluator.reasonMask & SLA_REASON_POISON_BIT_LATCHED) !== 0).toBe(true)

    // Explicit clearPoison() restores normal evaluation
    evaluator.clearPoison()
    expect(evaluator.poisonLatched).toBe(false)
    expect(
      evaluator.tickDnsStats(
        {
          cacheHitsCompleted: 99,
          cacheHitsInflight: 0,
          cacheMisses: 1,
          errors: 0,
          size: 10,
          totalCount: 100,
        },
        -1,
        -1,
        0,
        5_000_000,
      ),
    ).toBe(SLA_STATE_FRESH)
  })

  test("STALE_SNAPSHOT_POISON_BIT in uiStateMask immediately latches SLA_POISON", () => {
    const evaluator = new DualClockSlaEvaluator(
      {},
      { monotonicNs: () => 1_000_000, wallEpochMs: () => 1_760_000_000_000 },
    )
    const state = evaluator.tickScalars(
      100,
      0,
      0,
      0,
      10,
      100,
      1_760_000_000_000,
      1_760_000_000_000,
      STALE_SNAPSHOT_POISON_BIT,
      1_000_000,
    )
    expect(state).toBe(SLA_STATE_POISON)
    expect(evaluator.getToken().stateId).toBe("SLA_POISON")
    expect(evaluator.getToken().borderStyle).toBe("double")
    expect((evaluator.reasonMask & SLA_REASON_POISON_BIT_LATCHED) !== 0).toBe(true)
  })

  test("probeLiveDns() and server/bun_dns.ts readBunDnsTelemetry() bind live Bun.dns.getCacheStats()", () => {
    statsSpy = spyOn(Bun.dns, "getCacheStats").mockReturnValue({
      cacheHitsCompleted: 5,
      cacheHitsInflight: 0,
      cacheMisses: 45,
      size: 12,
      errors: 0,
      totalCount: 50,
    })

    const evaluator = new DualClockSlaEvaluator()
    const state = evaluator.probeLiveDns()
    expect(state).toBe(SLA_STATE_STALE)
    expect((evaluator.reasonMask & SLA_REASON_DNS_MISS_STALE) !== 0).toBe(true)

    const telemetry = readBunDnsTelemetry()
    expect(telemetry).not.toBeNull()
    expect(telemetry?.slaState).toBe("SLA_STALE")
    expect(telemetry?.slaToken).toBe("--sd-sla-stale")
    expect(((telemetry?.slaReasonMask ?? 0) & SLA_REASON_DNS_MISS_STALE) !== 0).toBe(true)
  })

  test("zero-allocation hot-path contract: 50,000 ticks reuse pre-allocated frozen token references", () => {
    let monoNs = 0
    let wallMs = 1_760_000_000_000
    const evaluator = new DualClockSlaEvaluator(
      {},
      { monotonicNs: () => monoNs, wallEpochMs: () => wallMs },
    )

    const freshTokenRef = SLA_TOKEN_TABLE[SLA_STATE_FRESH]
    const warnTokenRef = SLA_TOKEN_TABLE[SLA_STATE_WARN]

    for (let i = 0; i < 50_000; i += 1) {
      evaluator.beginProbe()
      monoNs += (i & 1) === 0 ? 50_000_000 : 600_000_000
      wallMs += 10
      const code = evaluator.tickScalars(90, 0, 10, 0, 16, 100, wallMs - 1000, wallMs - 2000)
      const tok = evaluator.getToken()
      if ((i & 1) === 0) {
        expect(code).toBe(SLA_STATE_FRESH)
        expect(tok).toBe(freshTokenRef)
      } else {
        expect(code).toBe(SLA_STATE_WARN)
        expect(tok).toBe(warnTokenRef)
      }
    }

    expect(evaluator.tickCount).toBe(50_000)
    expect(evaluator.transitionCount).toBe(49_999)
    const snap = evaluator.snapshot()
    expect(snap.tickCount).toBe(50_000)
    expect(Object.isFrozen(snap)).toBe(true)
  })
})
