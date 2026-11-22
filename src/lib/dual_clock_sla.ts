/**
 * @file src/lib/dual_clock_sla.ts
 * @description Zero-allocation DualClock (MonotonicClock + WallClock) SLA evaluator
 * wired to `design/tokens.toml` SLA tokens and `Bun.dns.getCacheStats()` telemetry.
 *
 * Hot-path invariants:
 * - Elapsed probe intervals come strictly from `MonotonicClock` (`Bun.nanoseconds()`
 *   when running on Bun, monotonic `performance.now() * 1e6` fallback otherwise).
 * - Freshness stamps and data-window lag come strictly from `WallClock` (`Date.now()`).
 * - `beginProbe()`, `endProbe()`, `tick()`, `tickDnsStats()`, and `getToken()` perform
 *   zero heap allocations (no object literals, no arrays, no template strings).
 * - All threshold comparisons use integer milliseconds / integer basis points (`0..10_000`).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse as parseToml } from "smol-toml"
import type { BunDnsCacheStats } from "./dns_drift_audit.ts"

// ── 1. Deterministic SLA State Codes & Token Registry ────────────────────────

export const SLA_STATE_FRESH = 0 as const
export const SLA_STATE_WARN = 1 as const
export const SLA_STATE_STALE = 2 as const
export const SLA_STATE_POISON = 3 as const

export type SlaStateCode =
  | typeof SLA_STATE_FRESH
  | typeof SLA_STATE_WARN
  | typeof SLA_STATE_STALE
  | typeof SLA_STATE_POISON

export type SlaStateId = "SLA_FRESH" | "SLA_WARN" | "SLA_STALE" | "SLA_POISON"

export type SlaBorderStyle = "solid" | "dashed" | "double"

export interface SlaTokenSpec {
  readonly code: SlaStateCode
  readonly stateId: SlaStateId
  readonly tokenName: string
  readonly fgHex: string
  readonly bgHex: string
  readonly borderHex: string
  readonly borderStyle: SlaBorderStyle
  readonly glyph: string
  readonly description: string
}

/**
 * Canonical SLA state tokens locked 1:1 to `design/tokens.toml` `[sla.*]`.
 * Pre-allocated and frozen so `SLA_TOKEN_TABLE[code]` is O(1) with zero allocation.
 */
export const SLA_TOKEN_TABLE: readonly [SlaTokenSpec, SlaTokenSpec, SlaTokenSpec, SlaTokenSpec] =
  Object.freeze([
    Object.freeze({
      code: SLA_STATE_FRESH,
      stateId: "SLA_FRESH",
      tokenName: "--sd-sla-fresh",
      fgHex: "#34d399",
      bgHex: "#0a2922",
      borderHex: "#10b981",
      borderStyle: "solid",
      glyph: "●",
      description: "Publish age and upstream data_window_max_epoch_ms within SLA",
    }),
    Object.freeze({
      code: SLA_STATE_WARN,
      stateId: "SLA_WARN",
      tokenName: "--sd-sla-warn",
      fgHex: "#38bdf8",
      bgHex: "#0c2438",
      borderHex: "#29b6f6",
      borderStyle: "solid",
      glyph: "◐",
      description: "Half-window aging advisory; polling active",
    }),
    Object.freeze({
      code: SLA_STATE_STALE,
      stateId: "SLA_STALE",
      tokenName: "--sd-sla-stale",
      fgHex: "#fbbf24",
      bgHex: "#2b200c",
      borderHex: "#f59e0b",
      borderStyle: "dashed",
      glyph: "▲",
      description: "BLK_R2_PUBLISH_STALE or BLK_R2_WINDOW_LAG_STALE breached",
    }),
    Object.freeze({
      code: SLA_STATE_POISON,
      stateId: "SLA_POISON",
      tokenName: "--sd-sla-poison",
      fgHex: "#fca5a5",
      bgHex: "#2d161d",
      borderHex: "#ff7878",
      borderStyle: "double",
      glyph: "✖",
      description: "STALE_SNAPSHOT_POISON_BIT set or Class A HTML-on-200 quarantine",
    }),
  ] as const)

/** `design/tokens.toml` `[bitmasks.ui_state]` poison bit (`1 << 30`). */
export const STALE_SNAPSHOT_POISON_BIT = 0x40000000 as const

// ── 2. Deterministic SLA Reason Bitmask Flags (Zero-Allocation Uint32) ───────

export const SLA_REASON_NONE = 0 as const
export const SLA_REASON_PROBE_WARN = (1 << 0) >>> 0
export const SLA_REASON_PROBE_STALE = (1 << 1) >>> 0
export const SLA_REASON_PUBLISH_WARN = (1 << 2) >>> 0
export const SLA_REASON_PUBLISH_STALE = (1 << 3) >>> 0
export const SLA_REASON_WINDOW_LAG_WARN = (1 << 4) >>> 0
export const SLA_REASON_WINDOW_LAG_STALE = (1 << 5) >>> 0
export const SLA_REASON_DNS_MISS_WARN = (1 << 6) >>> 0
export const SLA_REASON_DNS_MISS_STALE = (1 << 7) >>> 0
export const SLA_REASON_DNS_INFLIGHT_WARN = (1 << 8) >>> 0
export const SLA_REASON_DNS_ERROR_WARN = (1 << 9) >>> 0
export const SLA_REASON_DNS_ERROR_STALE = (1 << 10) >>> 0
export const SLA_REASON_DNS_ERROR_POISON = (1 << 11) >>> 0
export const SLA_REASON_CLOCK_SKEW_POISON = (1 << 12) >>> 0
export const SLA_REASON_POISON_BIT_LATCHED = STALE_SNAPSHOT_POISON_BIT

// ── 3. Ingestion Channel SLA Table (ms) Mapped from `design/tokens.toml` ─────

/**
 * Channel count (`channel_id` 0..10 in `design/tokens.toml` `[ingestion.*]`).
 * `0` indicates `sentinel_drop` (no latency budget).
 */
export const INGESTION_CHANNEL_COUNT = 11 as const

/**
 * Precomputed `Uint16Array` of latency SLA budgets in milliseconds indexed by
 * `channel_id` (`0..10`) from `design/tokens.toml` `[ingestion.*]`.
 *
 * - 0: NON_SPORTS (sentinel_drop -> 0)
 * - 1: Internet (1500ms)
 * - 2: BLOCKED (sentinel_drop -> 0)
 * - 3: GATEWAY (1000ms)
 * - 4: ALERT (250ms)
 * - 5: GSBUILDER (1000ms)
 * - 6: GSLIVE (500ms)
 * - 7: CSLEVEL2 (2000ms)
 * - 8: LIVEBETTINGCWS (750ms)
 * - 9: PHONE (1500ms)
 * - 10: HOUSE (1500ms)
 */
export const CHANNEL_SLA_MS_TABLE: Uint16Array = Uint16Array.from([
  0, 1500, 0, 1000, 250, 1000, 500, 2000, 750, 1500, 1500,
])

/**
 * Precomputed `Uint16Array` of half-window advisory (`SLA_WARN`) thresholds in ms
 * (`Math.floor(sla_ms / 2)`), indexed by `channel_id`.
 */
export const CHANNEL_WARN_MS_TABLE: Uint16Array = Uint16Array.from([
  0, 750, 0, 500, 125, 500, 250, 1000, 375, 750, 750,
])

// ── 4. DualClock Abstractions (MonotonicClock + WallClock) ───────────────────

export type MonotonicClockFn = () => number
export type WallClockFn = () => number

export interface DualClockSources {
  /** Monotonic nanoseconds (`Bun.nanoseconds()` on Bun). */
  readonly monotonicNs: MonotonicClockFn
  /** UTC wall-clock epoch milliseconds (`Date.now()`). */
  readonly wallEpochMs: WallClockFn
}

interface BunRuntimeClockLike {
  readonly nanoseconds?: () => number
  readonly dns?: {
    readonly getCacheStats?: () => BunDnsCacheStats
  }
}

/**
 * Default monotonic clock reading `Bun.nanoseconds()` when running under Bun,
 * falling back to `Math.trunc(performance.now() * 1_000_000)` on Node/browser.
 * Zero allocations.
 */
export function defaultMonotonicNs(): number {
  const bun = (globalThis as unknown as { Bun?: BunRuntimeClockLike }).Bun
  if (bun && typeof bun.nanoseconds === "function") {
    return bun.nanoseconds()
  }
  return Math.trunc(performance.now() * 1_000_000)
}

/** Default wall-clock epoch milliseconds (`Date.now()`). Zero allocations. */
export function defaultWallEpochMs(): number {
  return Date.now()
}

export const DEFAULT_DUAL_CLOCK: DualClockSources = Object.freeze({
  monotonicNs: defaultMonotonicNs,
  wallEpochMs: defaultWallEpochMs,
})

// ── 5. Threshold Configuration & TOML Loader ─────────────────────────────────

export interface DualClockSlaThresholds {
  /** Monotonic probe interval (ms) at or above which `SLA_WARN` triggers. */
  readonly probeWarnMs: number
  /** Monotonic probe interval (ms) strictly above which `SLA_STALE` triggers. */
  readonly probeStaleMs: number
  /** Wall-clock publish age (ms) at or above which `SLA_WARN` triggers. */
  readonly publishWarnMs: number
  /** Wall-clock publish age (ms) strictly above which `BLK_R2_PUBLISH_STALE` triggers. */
  readonly publishStaleMs: number
  /** Wall-clock data window lag (ms) at or above which `SLA_WARN` triggers. */
  readonly windowLagWarnMs: number
  /** Wall-clock data window lag (ms) strictly above which `BLK_R2_WINDOW_LAG_STALE` triggers. */
  readonly windowLagStaleMs: number
  /** Maximum tolerated future wall-clock skew (ms) before latching `SLA_POISON`. */
  readonly maxFutureSkewMs: number
  /** Minimum DNS total lookups before miss/error ratios evaluate. */
  readonly dnsMinSamples: number
  /** DNS cache miss ratio (bps, 0..10_000) triggering `SLA_WARN`. */
  readonly dnsMissWarnBps: number
  /** DNS cache miss ratio (bps, 0..10_000) triggering `SLA_STALE`. */
  readonly dnsMissStaleBps: number
  /** DNS error ratio (bps, 0..10_000) triggering `SLA_WARN`. */
  readonly dnsErrorWarnBps: number
  /** DNS error ratio (bps, 0..10_000) triggering `SLA_STALE`. */
  readonly dnsErrorStaleBps: number
  /** DNS error ratio (bps, 0..10_000) triggering `SLA_POISON`. */
  readonly dnsErrorPoisonBps: number
  /** Inflight DNS requests at or above which `SLA_WARN` triggers. */
  readonly dnsInflightWarnCount: number
}

/**
 * Default operational SLA thresholds derived from `design/tokens.toml`
 * (`ALERT` / `GSLIVE` / `Internet` latency windows, 30s R2/DNS TTL, and
 * `dns_drift_audit.ts` / `bun_r2_inspect.ts` DNS guardrails).
 */
export const DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS: DualClockSlaThresholds = Object.freeze({
  probeWarnMs: 500, // Half of 1000ms GATEWAY/GSBUILDER SLA window
  probeStaleMs: 1_000, // Full 1000ms SLA window
  publishWarnMs: 15_000, // Half of 30s R2/DNS freshness window
  publishStaleMs: 30_000, // BLK_R2_PUBLISH_STALE (30s)
  windowLagWarnMs: 30_000, // Half of 60s upstream data window
  windowLagStaleMs: 60_000, // BLK_R2_WINDOW_LAG_STALE (60s)
  maxFutureSkewMs: 5_000, // Future clock skew quarantine threshold
  dnsMinSamples: 20, // Matches dns_drift_audit.ts DEFAULT_MIN_CACHE_SAMPLES
  dnsMissWarnBps: 5_000, // 50.0% miss ratio advisory
  dnsMissStaleBps: 8_000, // 80.0% miss ratio breach (DRIFT_CACHE_HIGH_MISS_RATIO)
  dnsErrorWarnBps: 200, // 2.0% DNS error ratio advisory
  dnsErrorStaleBps: 500, // 5.0% DNS error ratio breach (bun_r2_inspect.ts maxDnsErrorRatioBps)
  dnsErrorPoisonBps: 2_000, // 20.0% severe resolver failure -> SLA_POISON
  dnsInflightWarnCount: 8, // Concurrent inflight DNS saturation advisory
})

/**
 * Builds channel-scoped SLA thresholds from `CHANNEL_SLA_MS_TABLE` (`design/tokens.toml`).
 * For `sentinel_drop` channels (`slaMs === 0`), falls back to `DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS`.
 */
export function thresholdsForChannel(
  channelId: number,
  overrides: Partial<DualClockSlaThresholds> = {},
): DualClockSlaThresholds {
  const rawSlaMs =
    channelId >= 0 && channelId < CHANNEL_SLA_MS_TABLE.length
      ? (CHANNEL_SLA_MS_TABLE[channelId] ?? 0)
      : 0
  const probeStaleMs =
    overrides.probeStaleMs ?? (rawSlaMs > 0 ? rawSlaMs : DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.probeStaleMs)
  const probeWarnMs = overrides.probeWarnMs ?? (probeStaleMs >>> 1)

  return Object.freeze({
    ...DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS,
    ...overrides,
    probeWarnMs,
    probeStaleMs,
  })
}

export interface LoadedTokensSlaConfig {
  readonly version: string
  readonly slaTokens: readonly SlaTokenSpec[]
  readonly channelSlaMs: Uint16Array
  readonly channelWarnMs: Uint16Array
  readonly poisonBitPosition: number
  readonly poisonBitMask: number
  readonly ariaLiveCoalesceMs: number
}

interface RawTokensToml {
  readonly meta?: { readonly version?: string }
  readonly motion?: { readonly aria_live_coalesce_ms?: number }
  readonly sla?: Record<
    string,
    {
      readonly state_id?: string
      readonly token_name?: string
      readonly fg_hex?: string
      readonly bg_hex?: string
      readonly border_hex?: string
      readonly border_style?: string
      readonly glyph?: string
      readonly description?: string
    }
  >
  readonly ingestion?: Record<
    string,
    {
      readonly channel_id?: number
      readonly sla_kind?: string
      readonly sla_ms?: number
      readonly sla_tens_of_ms?: number
    }
  >
  readonly bitmasks?: {
    readonly ui_state?: {
      readonly STALE_SNAPSHOT_POISON_BIT?: number
    }
  }
}

const SLA_STATE_ORDER: readonly { readonly key: string; readonly code: SlaStateCode }[] = [
  { key: "fresh", code: SLA_STATE_FRESH },
  { key: "warn", code: SLA_STATE_WARN },
  { key: "stale", code: SLA_STATE_STALE },
  { key: "poison", code: SLA_STATE_POISON },
]

/**
 * Cold-path loader that parses `design/tokens.toml` and extracts the authoritative
 * SLA tokens, per-channel latency SLA `Uint16Array` tables, and `STALE_SNAPSHOT_POISON_BIT`.
 */
export function loadSlaTokensFromToml(
  tomlPath: string = resolve(process.cwd(), "design/tokens.toml"),
): LoadedTokensSlaConfig {
  const rawText = readFileSync(tomlPath, "utf8")
  const parsed = parseToml(rawText) as unknown as RawTokensToml

  const version = parsed.meta?.version ?? "unknown"
  const slaSection = parsed.sla ?? {}
  const slaTokens: SlaTokenSpec[] = []

  for (const entry of SLA_STATE_ORDER) {
    const raw = slaSection[entry.key]
    if (!raw || !raw.state_id || !raw.token_name || !raw.fg_hex || !raw.bg_hex || !raw.border_hex) {
      throw new Error(`design/tokens.toml missing required [sla.${entry.key}] fields`)
    }
    const borderStyle: SlaBorderStyle =
      raw.border_style === "dashed" || raw.border_style === "double" ? raw.border_style : "solid"
    slaTokens.push(
      Object.freeze({
        code: entry.code,
        stateId: raw.state_id as SlaStateId,
        tokenName: raw.token_name,
        fgHex: raw.fg_hex,
        bgHex: raw.bg_hex,
        borderHex: raw.border_hex,
        borderStyle,
        glyph: raw.glyph ?? "",
        description: raw.description ?? "",
      }),
    )
  }

  const ingestionEntries = Object.values(parsed.ingestion ?? {})
  let maxChannelId = INGESTION_CHANNEL_COUNT - 1
  for (const item of ingestionEntries) {
    if (typeof item.channel_id === "number" && item.channel_id > maxChannelId) {
      maxChannelId = item.channel_id
    }
  }

  const channelSlaMs = new Uint16Array(maxChannelId + 1)
  const channelWarnMs = new Uint16Array(maxChannelId + 1)
  for (const item of ingestionEntries) {
    if (typeof item.channel_id !== "number" || item.channel_id < 0) continue
    const ms =
      item.sla_kind === "latency"
        ? typeof item.sla_ms === "number"
          ? item.sla_ms
          : (item.sla_tens_of_ms ?? 0) * 10
        : 0
    channelSlaMs[item.channel_id] = ms
    channelWarnMs[item.channel_id] = ms >>> 1
  }

  const poisonBitPosition = parsed.bitmasks?.ui_state?.STALE_SNAPSHOT_POISON_BIT ?? 30
  const poisonBitMask = (1 << poisonBitPosition) >>> 0
  const ariaLiveCoalesceMs = parsed.motion?.aria_live_coalesce_ms ?? 500

  return Object.freeze({
    version,
    slaTokens: Object.freeze(slaTokens),
    channelSlaMs,
    channelWarnMs,
    poisonBitPosition,
    poisonBitMask,
    ariaLiveCoalesceMs,
  })
}

// ── 6. Cold-Path Snapshot Shape ──────────────────────────────────────────────

export interface DualClockSlaSnapshot {
  readonly stateCode: SlaStateCode
  readonly stateId: SlaStateId
  readonly tokenName: string
  readonly fgHex: string
  readonly bgHex: string
  readonly borderHex: string
  readonly borderStyle: SlaBorderStyle
  readonly glyph: string
  readonly reasonMask: number
  readonly poisonLatched: boolean
  readonly elapsedNs: number
  readonly elapsedMs: number
  readonly wallNowMs: number
  readonly publishAgeMs: number
  readonly windowLagMs: number
  readonly dnsTotalCount: number
  readonly dnsHitsCompleted: number
  readonly dnsHitsInflight: number
  readonly dnsMisses: number
  readonly dnsErrors: number
  readonly dnsCacheSize: number
  readonly dnsHitRateBps: number
  readonly dnsMissRateBps: number
  readonly dnsErrorRateBps: number
  readonly tickCount: number
  readonly transitionCount: number
}

// ── 7. Zero-Allocation DualClock SLA Evaluator ───────────────────────────────

/**
 * Pre-allocated mutable evaluation buffer indices (`Float64Array` / `Uint32Array`)
 * are kept directly as primitive scalar fields on the evaluator instance so V8/JSC
 * keep them unboxed with zero heap allocations on every probe/tick call.
 */
export class DualClockSlaEvaluator {
  private readonly monotonicNsFn: MonotonicClockFn
  private readonly wallEpochMsFn: WallClockFn

  // Threshold scalars (primitive integers for zero indirection on hot path)
  private probeWarnMs: number
  private probeStaleMs: number
  private publishWarnMs: number
  private publishStaleMs: number
  private windowLagWarnMs: number
  private windowLagStaleMs: number
  private maxFutureSkewMs: number
  private dnsMinSamples: number
  private dnsMissWarnBps: number
  private dnsMissStaleBps: number
  private dnsErrorWarnBps: number
  private dnsErrorStaleBps: number
  private dnsErrorPoisonBps: number
  private dnsInflightWarnCount: number

  // Active monotonic probe start timestamp (ns), -1 when idle
  private probeStartNs: number = -1

  // Last evaluated deterministic state & counters (all primitive scalars)
  private _stateCode: SlaStateCode = SLA_STATE_FRESH
  private _reasonMask: number = SLA_REASON_NONE
  private _poisonLatched: boolean = false
  private _lastElapsedNs: number = 0
  private _lastElapsedMs: number = 0
  private _lastWallNowMs: number = 0
  private _lastPublishAgeMs: number = 0
  private _lastWindowLagMs: number = 0
  private _dnsTotalCount: number = 0
  private _dnsHitsCompleted: number = 0
  private _dnsHitsInflight: number = 0
  private _dnsMisses: number = 0
  private _dnsErrors: number = 0
  private _dnsCacheSize: number = 0
  private _dnsHitRateBps: number = 0
  private _dnsMissRateBps: number = 0
  private _dnsErrorRateBps: number = 0
  private _tickCount: number = 0
  private _transitionCount: number = 0

  constructor(
    thresholds: Partial<DualClockSlaThresholds> = {},
    clocks: DualClockSources = DEFAULT_DUAL_CLOCK,
  ) {
    this.monotonicNsFn = clocks.monotonicNs
    this.wallEpochMsFn = clocks.wallEpochMs

    this.probeWarnMs = thresholds.probeWarnMs ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.probeWarnMs
    this.probeStaleMs = thresholds.probeStaleMs ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.probeStaleMs
    this.publishWarnMs = thresholds.publishWarnMs ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.publishWarnMs
    this.publishStaleMs =
      thresholds.publishStaleMs ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.publishStaleMs
    this.windowLagWarnMs =
      thresholds.windowLagWarnMs ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.windowLagWarnMs
    this.windowLagStaleMs =
      thresholds.windowLagStaleMs ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.windowLagStaleMs
    this.maxFutureSkewMs =
      thresholds.maxFutureSkewMs ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.maxFutureSkewMs
    this.dnsMinSamples = thresholds.dnsMinSamples ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.dnsMinSamples
    this.dnsMissWarnBps =
      thresholds.dnsMissWarnBps ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.dnsMissWarnBps
    this.dnsMissStaleBps =
      thresholds.dnsMissStaleBps ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.dnsMissStaleBps
    this.dnsErrorWarnBps =
      thresholds.dnsErrorWarnBps ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.dnsErrorWarnBps
    this.dnsErrorStaleBps =
      thresholds.dnsErrorStaleBps ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.dnsErrorStaleBps
    this.dnsErrorPoisonBps =
      thresholds.dnsErrorPoisonBps ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.dnsErrorPoisonBps
    this.dnsInflightWarnCount =
      thresholds.dnsInflightWarnCount ?? DEFAULT_DUAL_CLOCK_SLA_THRESHOLDS.dnsInflightWarnCount
  }

  /** Re-bind probe SLA thresholds to an ingestion channel ID in O(1) with zero allocation. */
  selectChannelSla(channelId: number): this {
    if (channelId >= 0 && channelId < CHANNEL_SLA_MS_TABLE.length) {
      const staleMs = CHANNEL_SLA_MS_TABLE[channelId] ?? 0
      if (staleMs > 0) {
        this.probeStaleMs = staleMs
        this.probeWarnMs = CHANNEL_WARN_MS_TABLE[channelId] ?? (staleMs >>> 1)
      }
    }
    return this
  }

  /** Marks the start of a monotonic probe interval. Zero allocations. */
  beginProbe(): number {
    const startNs = this.monotonicNsFn()
    this.probeStartNs = startNs
    return startNs
  }

  /**
   * Ends the active monotonic probe interval and returns elapsed nanoseconds (>= 0).
   * Zero allocations.
   */
  endProbe(): number {
    const endNs = this.monotonicNsFn()
    const elapsedNs = this.probeStartNs >= 0 && endNs >= this.probeStartNs ? endNs - this.probeStartNs : 0
    this.probeStartNs = -1
    this._lastElapsedNs = elapsedNs
    this._lastElapsedMs = Math.trunc(elapsedNs / 1_000_000)
    return elapsedNs
  }

  /**
   * Zero-allocation scalar hot-path tick.
   * Evaluates monotonic probe elapsed interval, wall-clock freshness stamps,
   * UI poison bitmask, and DNS cache telemetry counters into a deterministic `SlaStateCode`.
   *
   * Pass `-1` for `publishedEpochMs` or `dataWindowMaxEpochMs` when not applicable.
   * Pass `-1` for `elapsedNsOverride` to measure from the active `beginProbe()` stamp
   * (or reuse `_lastElapsedNs` if `endProbe()` already completed).
   */
  tickScalars(
    cacheHitsCompleted: number,
    cacheHitsInflight: number,
    cacheMisses: number,
    errors: number,
    cacheSize: number,
    totalCount: number,
    publishedEpochMs: number = -1,
    dataWindowMaxEpochMs: number = -1,
    uiStateMask: number = 0,
    elapsedNsOverride: number = -1,
  ): SlaStateCode {
    // 1. Monotonic elapsed interval
    let elapsedNs: number
    if (elapsedNsOverride >= 0) {
      elapsedNs = elapsedNsOverride
    } else if (this.probeStartNs >= 0) {
      const nowNs = this.monotonicNsFn()
      elapsedNs = nowNs >= this.probeStartNs ? nowNs - this.probeStartNs : 0
      this.probeStartNs = -1
    } else {
      elapsedNs = this._lastElapsedNs
    }
    const elapsedMs = Math.trunc(elapsedNs / 1_000_000)
    this._lastElapsedNs = elapsedNs
    this._lastElapsedMs = elapsedMs

    // 2. Wall-clock freshness stamps
    const wallNowMs = this.wallEpochMsFn()
    this._lastWallNowMs = wallNowMs

    let reasonMask = SLA_REASON_NONE
    let nextState: SlaStateCode = SLA_STATE_FRESH

    // Check monotonic probe interval against SLA window
    if (elapsedMs > this.probeStaleMs) {
      reasonMask = (reasonMask | SLA_REASON_PROBE_STALE) >>> 0
      if (nextState < SLA_STATE_STALE) nextState = SLA_STATE_STALE
    } else if (elapsedMs >= this.probeWarnMs) {
      reasonMask = (reasonMask | SLA_REASON_PROBE_WARN) >>> 0
      if (nextState < SLA_STATE_WARN) nextState = SLA_STATE_WARN
    }

    // Check wall-clock publish age (BLK_R2_PUBLISH_STALE)
    if (publishedEpochMs >= 0) {
      const publishAgeMs = wallNowMs - publishedEpochMs
      this._lastPublishAgeMs = publishAgeMs
      if (publishAgeMs < -this.maxFutureSkewMs) {
        reasonMask = (reasonMask | SLA_REASON_CLOCK_SKEW_POISON) >>> 0
        nextState = SLA_STATE_POISON
      } else if (publishAgeMs > this.publishStaleMs) {
        reasonMask = (reasonMask | SLA_REASON_PUBLISH_STALE) >>> 0
        if (nextState < SLA_STATE_STALE) nextState = SLA_STATE_STALE
      } else if (publishAgeMs >= this.publishWarnMs) {
        reasonMask = (reasonMask | SLA_REASON_PUBLISH_WARN) >>> 0
        if (nextState < SLA_STATE_WARN) nextState = SLA_STATE_WARN
      }
    } else {
      this._lastPublishAgeMs = 0
    }

    // Check wall-clock upstream data window lag (BLK_R2_WINDOW_LAG_STALE)
    if (dataWindowMaxEpochMs >= 0) {
      const windowLagMs = wallNowMs - dataWindowMaxEpochMs
      this._lastWindowLagMs = windowLagMs
      if (windowLagMs < -this.maxFutureSkewMs) {
        reasonMask = (reasonMask | SLA_REASON_CLOCK_SKEW_POISON) >>> 0
        nextState = SLA_STATE_POISON
      } else if (windowLagMs > this.windowLagStaleMs) {
        reasonMask = (reasonMask | SLA_REASON_WINDOW_LAG_STALE) >>> 0
        if (nextState < SLA_STATE_STALE) nextState = SLA_STATE_STALE
      } else if (windowLagMs >= this.windowLagWarnMs) {
        reasonMask = (reasonMask | SLA_REASON_WINDOW_LAG_WARN) >>> 0
        if (nextState < SLA_STATE_WARN) nextState = SLA_STATE_WARN
      }
    } else {
      this._lastWindowLagMs = 0
    }

    // 3. Bind Bun.dns.getCacheStats() counters into deterministic SLA transitions
    const hits = cacheHitsCompleted + cacheHitsInflight
    const effectiveTotal = totalCount > 0 ? totalCount : hits + cacheMisses + errors

    this._dnsHitsCompleted = cacheHitsCompleted
    this._dnsHitsInflight = cacheHitsInflight
    this._dnsMisses = cacheMisses
    this._dnsErrors = errors
    this._dnsCacheSize = cacheSize
    this._dnsTotalCount = effectiveTotal

    let hitRateBps = 0
    let missRateBps = 0
    let errorRateBps = 0

    if (effectiveTotal > 0) {
      hitRateBps = Math.trunc((hits * 10_000) / effectiveTotal)
      missRateBps = Math.trunc((cacheMisses * 10_000) / effectiveTotal)
      errorRateBps = Math.trunc((errors * 10_000) / effectiveTotal)
    }

    this._dnsHitRateBps = hitRateBps
    this._dnsMissRateBps = missRateBps
    this._dnsErrorRateBps = errorRateBps

    if (cacheHitsInflight >= this.dnsInflightWarnCount) {
      reasonMask = (reasonMask | SLA_REASON_DNS_INFLIGHT_WARN) >>> 0
      if (nextState < SLA_STATE_WARN) nextState = SLA_STATE_WARN
    }

    if (effectiveTotal >= this.dnsMinSamples) {
      if (errorRateBps >= this.dnsErrorPoisonBps) {
        reasonMask = (reasonMask | SLA_REASON_DNS_ERROR_POISON) >>> 0
        nextState = SLA_STATE_POISON
      } else if (errorRateBps > this.dnsErrorStaleBps) {
        reasonMask = (reasonMask | SLA_REASON_DNS_ERROR_STALE) >>> 0
        if (nextState < SLA_STATE_STALE) nextState = SLA_STATE_STALE
      } else if (errorRateBps >= this.dnsErrorWarnBps) {
        reasonMask = (reasonMask | SLA_REASON_DNS_ERROR_WARN) >>> 0
        if (nextState < SLA_STATE_WARN) nextState = SLA_STATE_WARN
      }

      if (missRateBps > this.dnsMissStaleBps) {
        reasonMask = (reasonMask | SLA_REASON_DNS_MISS_STALE) >>> 0
        if (nextState < SLA_STATE_STALE) nextState = SLA_STATE_STALE
      } else if (missRateBps >= this.dnsMissWarnBps) {
        reasonMask = (reasonMask | SLA_REASON_DNS_MISS_WARN) >>> 0
        if (nextState < SLA_STATE_WARN) nextState = SLA_STATE_WARN
      }
    }

    // 4. Poison bit & latch invariant (STALE_SNAPSHOT_POISON_BIT = 0x40000000)
    if ((uiStateMask & STALE_SNAPSHOT_POISON_BIT) !== 0 || this._poisonLatched) {
      this._poisonLatched = true
      reasonMask = (reasonMask | SLA_REASON_POISON_BIT_LATCHED) >>> 0
      nextState = SLA_STATE_POISON
    } else if (nextState === SLA_STATE_POISON) {
      this._poisonLatched = true
    }

    this._tickCount += 1
    if (nextState !== this._stateCode) {
      this._transitionCount += 1
      this._stateCode = nextState
    }
    this._reasonMask = reasonMask
    return nextState
  }

  /**
   * Evaluates a `Bun.dns.getCacheStats()` object (supporting both `cacheMisses`
   * and `cacheMissesCompleted` property names) with zero allocations.
   */
  tickDnsStats(
    stats: BunDnsCacheStats | null | undefined,
    publishedEpochMs: number = -1,
    dataWindowMaxEpochMs: number = -1,
    uiStateMask: number = 0,
    elapsedNsOverride: number = -1,
  ): SlaStateCode {
    const hitsCompleted = stats?.cacheHitsCompleted ?? 0
    const hitsInflight = stats?.cacheHitsInflight ?? 0
    const misses = stats?.cacheMisses ?? stats?.cacheMissesCompleted ?? 0
    const errors = stats?.errors ?? 0
    const size = stats?.size ?? 0
    const totalCount = stats?.totalCount ?? 0

    return this.tickScalars(
      hitsCompleted,
      hitsInflight,
      misses,
      errors,
      size,
      totalCount,
      publishedEpochMs,
      dataWindowMaxEpochMs,
      uiStateMask,
      elapsedNsOverride,
    )
  }

  /**
   * Probes live `Bun.dns.getCacheStats()` directly on the hot path with zero
   * evaluator allocations.
   */
  probeLiveDns(
    publishedEpochMs: number = -1,
    dataWindowMaxEpochMs: number = -1,
    uiStateMask: number = 0,
  ): SlaStateCode {
    const startNs = this.monotonicNsFn()
    const bun = (globalThis as unknown as { Bun?: BunRuntimeClockLike }).Bun
    const stats =
      bun?.dns && typeof bun.dns.getCacheStats === "function" ? bun.dns.getCacheStats() : null
    const endNs = this.monotonicNsFn()
    const elapsedNs = endNs >= startNs ? endNs - startNs : 0

    return this.tickDnsStats(
      stats,
      publishedEpochMs,
      dataWindowMaxEpochMs,
      uiStateMask,
      elapsedNs,
    )
  }

  /** Explicitly clears a latched `SLA_POISON` state after operator quarantine recovery. */
  clearPoison(): this {
    this._poisonLatched = false
    if (this._stateCode === SLA_STATE_POISON) {
      this._stateCode = SLA_STATE_FRESH
      this._reasonMask = SLA_REASON_NONE
      this._transitionCount += 1
    }
    return this
  }

  /** Resets all runtime counters and clocks for buffer reuse. Zero allocations. */
  reset(): this {
    this.probeStartNs = -1
    this._stateCode = SLA_STATE_FRESH
    this._reasonMask = SLA_REASON_NONE
    this._poisonLatched = false
    this._lastElapsedNs = 0
    this._lastElapsedMs = 0
    this._lastWallNowMs = 0
    this._lastPublishAgeMs = 0
    this._lastWindowLagMs = 0
    this._dnsTotalCount = 0
    this._dnsHitsCompleted = 0
    this._dnsHitsInflight = 0
    this._dnsMisses = 0
    this._dnsErrors = 0
    this._dnsCacheSize = 0
    this._dnsHitRateBps = 0
    this._dnsMissRateBps = 0
    this._dnsErrorRateBps = 0
    this._tickCount = 0
    this._transitionCount = 0
    return this
  }

  // Zero-allocation scalar getters
  get stateCode(): SlaStateCode {
    return this._stateCode
  }
  get reasonMask(): number {
    return this._reasonMask
  }
  get poisonLatched(): boolean {
    return this._poisonLatched
  }
  get lastElapsedNs(): number {
    return this._lastElapsedNs
  }
  get lastElapsedMs(): number {
    return this._lastElapsedMs
  }
  get lastWallNowMs(): number {
    return this._lastWallNowMs
  }
  get lastPublishAgeMs(): number {
    return this._lastPublishAgeMs
  }
  get lastWindowLagMs(): number {
    return this._lastWindowLagMs
  }
  get dnsHitRateBps(): number {
    return this._dnsHitRateBps
  }
  get dnsMissRateBps(): number {
    return this._dnsMissRateBps
  }
  get dnsErrorRateBps(): number {
    return this._dnsErrorRateBps
  }
  get tickCount(): number {
    return this._tickCount
  }
  get transitionCount(): number {
    return this._transitionCount
  }

  /** Returns the pre-allocated frozen SLA token for the current state. Zero allocations. */
  getToken(): SlaTokenSpec {
    return SLA_TOKEN_TABLE[this._stateCode]
  }

  /**
   * Cold-path serializer for API responses / diagnostics.
   * Do NOT call on the hot probe loop; use `stateCode`, `reasonMask`, and `getToken()` there.
   */
  snapshot(): DualClockSlaSnapshot {
    const token = SLA_TOKEN_TABLE[this._stateCode]
    return Object.freeze({
      stateCode: this._stateCode,
      stateId: token.stateId,
      tokenName: token.tokenName,
      fgHex: token.fgHex,
      bgHex: token.bgHex,
      borderHex: token.borderHex,
      borderStyle: token.borderStyle,
      glyph: token.glyph,
      reasonMask: this._reasonMask,
      poisonLatched: this._poisonLatched,
      elapsedNs: this._lastElapsedNs,
      elapsedMs: this._lastElapsedMs,
      wallNowMs: this._lastWallNowMs,
      publishAgeMs: this._lastPublishAgeMs,
      windowLagMs: this._lastWindowLagMs,
      dnsTotalCount: this._dnsTotalCount,
      dnsHitsCompleted: this._dnsHitsCompleted,
      dnsHitsInflight: this._dnsHitsInflight,
      dnsMisses: this._dnsMisses,
      dnsErrors: this._dnsErrors,
      dnsCacheSize: this._dnsCacheSize,
      dnsHitRateBps: this._dnsHitRateBps,
      dnsMissRateBps: this._dnsMissRateBps,
      dnsErrorRateBps: this._dnsErrorRateBps,
      tickCount: this._tickCount,
      transitionCount: this._transitionCount,
    })
  }
}
