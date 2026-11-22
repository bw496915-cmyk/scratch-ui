/**
 * @file packages/ui/src/system_log_bitwise_filter.ts
 * @description High-speed client-side bitwise severity flag filter engine and
 * external store for the System Logs panel. Designed so typing in the search
 * input or toggling severity bit flags evaluates a contiguous Uint8Array index
 * in microseconds and updates DOM row visibility without triggering full React
 * panel or table re-renders.
 */

export const LOG_SEVERITY_BIT_INFO = 1 << 0 // 0x01 — INFO / NORMAL
export const LOG_SEVERITY_BIT_WATCH = 1 << 1 // 0x02 — WATCH
export const LOG_SEVERITY_BIT_WARN = 1 << 2 // 0x04 — WARN / HIGH
export const LOG_SEVERITY_BIT_ERROR = 1 << 3 // 0x08 — ERROR / CRITICAL
export const LOG_SEVERITY_MASK_ALL =
  LOG_SEVERITY_BIT_INFO | LOG_SEVERITY_BIT_WATCH | LOG_SEVERITY_BIT_WARN | LOG_SEVERITY_BIT_ERROR // 0x0F

export interface SeverityBitDescriptor {
  readonly bit: number
  readonly hex: string
  readonly weblogLabel: string
  readonly unifiedLabel: string
  readonly shortLabel: string
  readonly fg: string
  readonly activeBg: string
  readonly activeBorder: string
}

export const LOG_SEVERITY_BITS: readonly SeverityBitDescriptor[] = [
  {
    bit: LOG_SEVERITY_BIT_ERROR,
    hex: "0x08",
    weblogLabel: "CRIT",
    unifiedLabel: "ERROR",
    shortLabel: "CRIT/ERR",
    fg: "#fca5a5",
    activeBg: "rgba(239, 68, 68, 0.18)",
    activeBorder: "#ef4444",
  },
  {
    bit: LOG_SEVERITY_BIT_WARN,
    hex: "0x04",
    weblogLabel: "HIGH",
    unifiedLabel: "WARN",
    shortLabel: "HIGH/WARN",
    fg: "#fcd34d",
    activeBg: "rgba(245, 158, 11, 0.18)",
    activeBorder: "#f59e0b",
  },
  {
    bit: LOG_SEVERITY_BIT_WATCH,
    hex: "0x02",
    weblogLabel: "WATCH",
    unifiedLabel: "WATCH",
    shortLabel: "WATCH",
    fg: "#7dd3fc",
    activeBg: "rgba(56, 189, 248, 0.18)",
    activeBorder: "#38bdf8",
  },
  {
    bit: LOG_SEVERITY_BIT_INFO,
    hex: "0x01",
    weblogLabel: "NORM",
    unifiedLabel: "INFO",
    shortLabel: "NORM/INFO",
    fg: "#86efac",
    activeBg: "rgba(34, 197, 94, 0.18)",
    activeBorder: "#22c55e",
  },
] as const

const SEVERITY_TOKEN_TO_BIT: Readonly<Record<string, number>> = {
  crit: LOG_SEVERITY_BIT_ERROR,
  critical: LOG_SEVERITY_BIT_ERROR,
  err: LOG_SEVERITY_BIT_ERROR,
  error: LOG_SEVERITY_BIT_ERROR,
  fatal: LOG_SEVERITY_BIT_ERROR,
  high: LOG_SEVERITY_BIT_WARN,
  warn: LOG_SEVERITY_BIT_WARN,
  warning: LOG_SEVERITY_BIT_WARN,
  watch: LOG_SEVERITY_BIT_WATCH,
  med: LOG_SEVERITY_BIT_WATCH,
  medium: LOG_SEVERITY_BIT_WATCH,
  norm: LOG_SEVERITY_BIT_INFO,
  normal: LOG_SEVERITY_BIT_INFO,
  info: LOG_SEVERITY_BIT_INFO,
  ok: LOG_SEVERITY_BIT_INFO,
  all: LOG_SEVERITY_MASK_ALL,
}

/** Maps a weblog or unified system log severity label onto its 4-bit flag. */
export function severityLabelToBit(label: string): number {
  const key = label.trim().toLowerCase()
  return SEVERITY_TOKEN_TO_BIT[key] ?? LOG_SEVERITY_BIT_INFO
}

/** Toggles a single severity bit via bitwise XOR, clamped to valid 4-bit range. */
export function toggleSeverityBit(mask: number, bit: number): number {
  return (mask ^ bit) & LOG_SEVERITY_MASK_ALL
}

export function formatBitmaskHex(mask: number): string {
  const clamped = mask & LOG_SEVERITY_MASK_ALL
  return `0x${clamped.toString(16).toUpperCase().padStart(2, "0")}`
}

export function formatBitmaskBinary(mask: number): string {
  const clamped = mask & LOG_SEVERITY_MASK_ALL
  return `0b${clamped.toString(2).padStart(4, "0")}`
}

export interface ParsedBitwiseLogQuery {
  readonly rawQuery: string
  readonly baseMask: number
  readonly includeMask: number
  readonly excludeMask: number
  readonly effectiveMask: number
  readonly textTerms: readonly string[]
  readonly hasExplicitBitFilter: boolean
}

function parseNumericMaskLiteral(literal: string): number | null {
  const trimmed = literal.trim().toLowerCase()
  if (/^0x[0-9a-f]+$/.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 16) & LOG_SEVERITY_MASK_ALL
  }
  if (/^0b[01]+$/.test(trimmed)) {
    return Number.parseInt(trimmed.slice(2), 2) & LOG_SEVERITY_MASK_ALL
  }
  if (/^\d+$/.test(trimmed)) {
    const num = Number.parseInt(trimmed, 10)
    if (num >= 0 && num <= 15) return num & LOG_SEVERITY_MASK_ALL
  }
  return null
}

function parseSeverityCompoundExpr(expr: string): number | null {
  const numeric = parseNumericMaskLiteral(expr)
  if (numeric !== null) return numeric

  const parts = expr.split(/[|,+]/).filter(Boolean)
  if (parts.length === 0) return null

  let acc = 0
  for (const part of parts) {
    const bit = SEVERITY_TOKEN_TO_BIT[part.toLowerCase()]
    if (bit === undefined) {
      const partNumeric = parseNumericMaskLiteral(part)
      if (partNumeric === null) return null
      acc |= partNumeric
    } else {
      acc |= bit
    }
  }
  return acc & LOG_SEVERITY_MASK_ALL
}

/**
 * Parses a client-side search string combining bitwise severity expressions
 * and free-text terms:
 * - Prefixed bitmask expressions: `sev:crit|warn`, `flag:0x0c`, `mask:0b1100`
 * - Bare compound/single severity flags: `crit|high`, `error`, `warn,watch`
 * - Negation (bitwise AND-NOT): `-info`, `!normal`, `~watch`, `-sev:info|watch`
 * - Free-text terms: any non-flag tokens (e.g. `BB55103`, `104.28`, `bot_619`)
 */
export function parseBitwiseSeverityQuery(
  rawQuery: string,
  baseMask: number = LOG_SEVERITY_MASK_ALL,
): ParsedBitwiseLogQuery {
  const clampedBase = baseMask & LOG_SEVERITY_MASK_ALL
  const trimmed = rawQuery.trim()
  if (!trimmed) {
    return {
      rawQuery,
      baseMask: clampedBase,
      includeMask: clampedBase,
      excludeMask: 0,
      effectiveMask: clampedBase,
      textTerms: [],
      hasExplicitBitFilter: false,
    }
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean)
  let explicitInclude = 0
  let hasExplicitInclude = false
  let excludeMask = 0
  let hasExplicitExclude = false
  const textTerms: string[] = []

  for (const token of tokens) {
    const lower = token.toLowerCase()

    // 1. Negated severity flag (`-info`, `!normal`, `~watch`, `-sev:info|watch`)
    if (
      lower.length > 1 &&
      (lower.startsWith("-") || lower.startsWith("!") || lower.startsWith("~"))
    ) {
      const body = lower.slice(1)
      const stripped = body.replace(/^(?:sev|severity|level|lvl|flag|mask):/, "")
      const parsed = parseSeverityCompoundExpr(stripped)
      if (parsed !== null) {
        excludeMask |= parsed
        hasExplicitExclude = true
        continue
      }
    }

    // 2. Explicit prefixed expression (`sev:crit|warn`, `mask:0x0c`, `flag:0b1100`)
    const prefixMatch = /^(?:sev|severity|level|lvl|flag|mask):(.+)$/.exec(lower)
    if (prefixMatch?.[1]) {
      const parsed = parseSeverityCompoundExpr(prefixMatch[1])
      if (parsed !== null) {
        explicitInclude |= parsed
        hasExplicitInclude = true
        continue
      }
    }

    // 3. Bare hex/binary mask literal (`0x0c`, `0b1100`)
    if (/^0[xb][0-9a-f]+$/.test(lower)) {
      const parsed = parseNumericMaskLiteral(lower)
      if (parsed !== null) {
        explicitInclude |= parsed
        hasExplicitInclude = true
        continue
      }
    }

    // 4. Bare severity keyword or bitwise OR compound (`crit`, `crit|high`, `error,warn`)
    const bareExpr = parseSeverityCompoundExpr(lower)
    if (bareExpr !== null) {
      explicitInclude |= bareExpr
      hasExplicitInclude = true
      continue
    }

    // 5. Regular client-side substring lookup term
    textTerms.push(lower)
  }

  // If the user explicitly named severity flags in the search input, intersect
  // with toggled buttons unless all buttons are toggled off or narrowed.
  const includeMask = hasExplicitInclude
    ? clampedBase === LOG_SEVERITY_MASK_ALL
      ? explicitInclude
      : explicitInclude & clampedBase
    : clampedBase

  const effectiveMask = includeMask & ~excludeMask & LOG_SEVERITY_MASK_ALL

  return {
    rawQuery,
    baseMask: clampedBase,
    includeMask,
    excludeMask,
    effectiveMask,
    textTerms,
    hasExplicitBitFilter: hasExplicitInclude || hasExplicitExclude,
  }
}

export interface BitwiseSeverityCounts {
  readonly error: number
  readonly warn: number
  readonly watch: number
  readonly info: number
}

/**
 * Contiguous Structure-of-Arrays (SoA) index over a rendered log list.
 * Built once when the log list changes; queried in microseconds on each keystroke.
 */
export interface BitwiseLogIndex {
  readonly length: number
  readonly severityFlags: Uint8Array
  readonly haystacks: readonly string[]
  readonly bitCounts: BitwiseSeverityCounts
}

export function buildBitwiseLogIndex<T>(
  rows: readonly T[],
  getSeverityBit: (row: T) => number,
  getHaystack: (row: T) => string,
): BitwiseLogIndex {
  const len = rows.length
  const severityFlags = new Uint8Array(len)
  const haystacks = new Array<string>(len)
  let error = 0
  let warn = 0
  let watch = 0
  let info = 0

  for (let i = 0; i < len; i += 1) {
    const row = rows[i]!
    const bit = getSeverityBit(row) & LOG_SEVERITY_MASK_ALL
    severityFlags[i] = bit
    haystacks[i] = getHaystack(row).toLowerCase()

    if ((bit & LOG_SEVERITY_BIT_ERROR) !== 0) error += 1
    if ((bit & LOG_SEVERITY_BIT_WARN) !== 0) warn += 1
    if ((bit & LOG_SEVERITY_BIT_WATCH) !== 0) watch += 1
    if ((bit & LOG_SEVERITY_BIT_INFO) !== 0) info += 1
  }

  return {
    length: len,
    severityFlags,
    haystacks,
    bitCounts: { error, warn, watch, info },
  }
}

export interface BitwiseEvaluationResult {
  readonly visible: Uint8Array
  readonly matchedCount: number
  readonly totalCount: number
  readonly effectiveMask: number
  readonly elapsedMs: number
}

/**
 * Evaluates a parsed bitwise query against the contiguous SoA `BitwiseLogIndex`.
 * Bitwise flag check `(flags[i] & effectiveMask) === 0` short-circuits before
 * any string comparison, reusing `outBitmap` to avoid per-keystroke allocations.
 */
export function evaluateBitwiseLogIndex(
  index: BitwiseLogIndex,
  query: ParsedBitwiseLogQuery,
  outBitmap?: Uint8Array,
): BitwiseEvaluationResult {
  const start = typeof performance !== "undefined" ? performance.now() : Date.now()
  const len = index.length
  const visible = outBitmap && outBitmap.length === len ? outBitmap : new Uint8Array(len)
  const flags = index.severityFlags
  const haystacks = index.haystacks
  const effectiveMask = query.effectiveMask
  const terms = query.textTerms
  const termCount = terms.length

  let matchedCount = 0

  if (effectiveMask === 0) {
    visible.fill(0)
  } else if (termCount === 0) {
    // Pure bitwise scan — single CPU bitwise AND per row
    for (let i = 0; i < len; i += 1) {
      const match = (flags[i]! & effectiveMask) !== 0 ? 1 : 0
      visible[i] = match
      matchedCount += match
    }
  } else if (termCount === 1) {
    const term0 = terms[0]!
    for (let i = 0; i < len; i += 1) {
      if ((flags[i]! & effectiveMask) === 0) {
        visible[i] = 0
        continue
      }
      const match = haystacks[i]!.includes(term0) ? 1 : 0
      visible[i] = match
      matchedCount += match
    }
  } else {
    for (let i = 0; i < len; i += 1) {
      if ((flags[i]! & effectiveMask) === 0) {
        visible[i] = 0
        continue
      }
      const hay = haystacks[i]!
      let ok = 1
      for (let t = 0; t < termCount; t += 1) {
        if (!hay.includes(terms[t]!)) {
          ok = 0
          break
        }
      }
      visible[i] = ok
      matchedCount += ok
    }
  }

  const elapsedMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - start

  return {
    visible,
    matchedCount,
    totalCount: len,
    effectiveMask,
    elapsedMs,
  }
}

export interface BitwiseFilterSnapshot {
  readonly rawQuery: string
  readonly toggledMask: number
  readonly parsed: ParsedBitwiseLogQuery
}

export interface BitwiseFilterStats {
  readonly matchedCount: number
  readonly totalCount: number
  readonly effectiveMask: number
  readonly elapsedMs: number
  readonly bitCounts: BitwiseSeverityCounts
}

const EMPTY_STATS: BitwiseFilterStats = {
  matchedCount: 0,
  totalCount: 0,
  effectiveMask: LOG_SEVERITY_MASK_ALL,
  elapsedMs: 0,
  bitCounts: { error: 0, warn: 0, watch: 0, info: 0 },
}

/**
 * Lightweight external store holding the System Logs bitwise search query and
 * severity bitmask outside React parent state so keystrokes and bit toggles
 * never trigger full re-renders of the System Logs panel or table rows.
 */
export class BitwiseLogFilterStore {
  private snapshot: BitwiseFilterSnapshot
  private stats: BitwiseFilterStats = EMPTY_STATS
  private readonly filterListeners = new Set<() => void>()
  private readonly statsListeners = new Set<() => void>()

  constructor(initialQuery = "", initialMask: number = LOG_SEVERITY_MASK_ALL) {
    const clamped = initialMask & LOG_SEVERITY_MASK_ALL
    this.snapshot = {
      rawQuery: initialQuery,
      toggledMask: clamped,
      parsed: parseBitwiseSeverityQuery(initialQuery, clamped),
    }
  }

  getSnapshot = (): BitwiseFilterSnapshot => this.snapshot

  getStats = (): BitwiseFilterStats => this.stats

  setQuery = (rawQuery: string): void => {
    if (rawQuery === this.snapshot.rawQuery) return
    this.snapshot = {
      rawQuery,
      toggledMask: this.snapshot.toggledMask,
      parsed: parseBitwiseSeverityQuery(rawQuery, this.snapshot.toggledMask),
    }
    this.emitFilter()
  }

  toggleBit = (bit: number): void => {
    const nextMask = toggleSeverityBit(this.snapshot.toggledMask, bit)
    if (nextMask === this.snapshot.toggledMask) return
    this.snapshot = {
      rawQuery: this.snapshot.rawQuery,
      toggledMask: nextMask,
      parsed: parseBitwiseSeverityQuery(this.snapshot.rawQuery, nextMask),
    }
    this.emitFilter()
  }

  setMask = (mask: number): void => {
    const clamped = mask & LOG_SEVERITY_MASK_ALL
    if (clamped === this.snapshot.toggledMask) return
    this.snapshot = {
      rawQuery: this.snapshot.rawQuery,
      toggledMask: clamped,
      parsed: parseBitwiseSeverityQuery(this.snapshot.rawQuery, clamped),
    }
    this.emitFilter()
  }

  reset = (): void => {
    if (this.snapshot.rawQuery === "" && this.snapshot.toggledMask === LOG_SEVERITY_MASK_ALL) {
      return
    }
    this.snapshot = {
      rawQuery: "",
      toggledMask: LOG_SEVERITY_MASK_ALL,
      parsed: parseBitwiseSeverityQuery("", LOG_SEVERITY_MASK_ALL),
    }
    this.emitFilter()
  }

  reportStats = (next: BitwiseFilterStats): void => {
    const prev = this.stats
    if (
      prev.matchedCount === next.matchedCount &&
      prev.totalCount === next.totalCount &&
      prev.effectiveMask === next.effectiveMask &&
      prev.bitCounts.error === next.bitCounts.error &&
      prev.bitCounts.warn === next.bitCounts.warn &&
      prev.bitCounts.watch === next.bitCounts.watch &&
      prev.bitCounts.info === next.bitCounts.info &&
      Math.abs(prev.elapsedMs - next.elapsedMs) < 0.005
    ) {
      return
    }
    this.stats = next
    for (const listener of this.statsListeners) {
      listener()
    }
  }

  subscribeFilter = (listener: () => void): (() => void) => {
    this.filterListeners.add(listener)
    return () => {
      this.filterListeners.delete(listener)
    }
  }

  subscribeStats = (listener: () => void): (() => void) => {
    this.statsListeners.add(listener)
    return () => {
      this.statsListeners.delete(listener)
    }
  }

  private emitFilter(): void {
    for (const listener of this.filterListeners) {
      listener()
    }
  }
}
