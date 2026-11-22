/**
 * @file packages/contracts/src/bun_semver.ts
 * @description Scanner-safe wrappers around `Bun.semver` (`satisfies` and `order`)
 * with deterministic SemVer 2.0 / uint64 bounds checking and Node/browser fallback.
 *
 * Addresses known `Bun.semver` runtime gotchas:
 * 1. Silent wildcard fallback: `Bun.semver.satisfies(v, "")` or `"invalid"` or
 *    `"latest"` or `"!=1.0.0"` returns `true` for any valid stable version.
 *    `safeSatisfies()` validates the range grammar upfront so malformed advisory
 *    or lockfile feeds never degrade into `*`.
 * 2. Throwing comparator: `Bun.semver.order(a, b)` throws on invalid strings.
 *    `safeSemverOrder()` and `gt`/`gte`/`lt`/`lte`/`eq` guard inputs first and
 *    never throw on untrusted lockfile/manifest input.
 * 3. uint64 overflow (`> 2^64 - 1`) & non-ASCII strings: rejected cleanly as
 *    invalid versions/ranges without crashing.
 */

export const MAX_SEMVER_UINT64 = 18_446_744_073_709_551_615n

export type SemverOrderResult = -1 | 0 | 1

export interface ParsedSemver {
  readonly raw: string
  readonly major: bigint
  readonly minor: bigint
  readonly patch: bigint
  readonly prerelease: readonly (bigint | string)[]
  readonly build: readonly string[]
}

interface BunSemverEngine {
  readonly satisfies: (version: string, range: string) => boolean
  readonly order: (a: string, b: string) => SemverOrderResult
}

function getBunSemverEngine(): BunSemverEngine | null {
  const bunObj = (globalThis as { readonly Bun?: { readonly semver?: Partial<BunSemverEngine> } })
    .Bun
  if (
    bunObj?.semver &&
    typeof bunObj.semver.satisfies === "function" &&
    typeof bunObj.semver.order === "function"
  ) {
    return bunObj.semver as BunSemverEngine
  }
  return null
}

const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/
const STRICT_VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const RANGE_COMPARATOR_RE =
  /^(<=|>=|<|>|=|~|\^)?\s*v?(\d+|[*xX])(?:\.(\d+|[*xX])(?:\.(\d+|[*xX])(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)?)?$/
const PARTIAL_VERSION_RE =
  /^v?(\d+|[*xX])(?:\.(\d+|[*xX])(?:\.(\d+|[*xX])(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)?)?$/

function parseUint64Segment(segment: string): bigint | null {
  if (!/^\d+$/.test(segment)) return null
  try {
    const val = BigInt(segment)
    return val <= MAX_SEMVER_UINT64 ? val : null
  } catch {
    return null
  }
}

function parsePrereleaseParts(raw: string | undefined): readonly (bigint | string)[] | null {
  if (!raw) return []
  const out: (bigint | string)[] = []
  for (const part of raw.split(".")) {
    if (!part) return null
    if (/^\d+$/.test(part)) {
      const val = parseUint64Segment(part)
      if (val === null) return null
      out.push(val)
    } else {
      out.push(part)
    }
  }
  return out
}

/**
 * Parses and validates an ASCII SemVer 2.0 string with uint64 (`<= 2^64 - 1`)
 * component bounds. Returns `null` on invalid, empty, overflowing, or non-ASCII input.
 */
export function parseSemver(version: string): ParsedSemver | null {
  if (typeof version !== "string") return null
  const trimmed = version.trim()
  if (!trimmed || !ASCII_PRINTABLE_RE.test(trimmed)) return null

  const match = STRICT_VERSION_RE.exec(trimmed)
  if (!match) return null

  const major = parseUint64Segment(match[1]!)
  const minor = parseUint64Segment(match[2]!)
  const patch = parseUint64Segment(match[3]!)
  if (major === null || minor === null || patch === null) return null

  const prerelease = parsePrereleaseParts(match[4])
  if (prerelease === null) return null

  const build = match[5] ? match[5].split(".") : []
  const engine = getBunSemverEngine()
  if (engine) {
    try {
      const probeRange = prerelease.length > 0 ? `>=${major}.${minor}.${patch}-0` : "*"
      if (!engine.satisfies(trimmed, probeRange)) {
        return null
      }
    } catch {
      return null
    }
  }

  return {
    raw: trimmed,
    major,
    minor,
    patch,
    prerelease,
    build,
  }
}

/** Returns `true` iff `version` is a valid, non-overflowing SemVer string. */
export function isValidSemver(version: string): boolean {
  return parseSemver(version) !== null
}

function compareParsedSemver(a: ParsedSemver, b: ParsedSemver): SemverOrderResult {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1

  const aPre = a.prerelease
  const bPre = b.prerelease
  if (aPre.length === 0 && bPre.length === 0) return 0
  if (aPre.length === 0) return 1
  if (bPre.length === 0) return -1

  const len = Math.max(aPre.length, bPre.length)
  for (let i = 0; i < len; i += 1) {
    const ap = aPre[i]
    const bp = bPre[i]
    if (ap === undefined) return -1
    if (bp === undefined) return 1
    if (ap === bp) continue
    const aNum = typeof ap === "bigint"
    const bNum = typeof bp === "bigint"
    if (aNum && bNum) return ap < bp ? -1 : 1
    if (aNum) return -1
    if (bNum) return 1
    return ap < bp ? -1 : 1
  }
  return 0
}

/**
 * Guards `Bun.semver.order(a, b)` against invalid/unparseable or overflowing
 * version strings. Returns `-1 | 0 | 1`, or `null` if either input is invalid.
 */
export function safeSemverOrder(a: string, b: string): SemverOrderResult | null {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return null

  const engine = getBunSemverEngine()
  if (engine) {
    try {
      return engine.order(pa.raw, pb.raw)
    } catch {
      return null
    }
  }
  return compareParsedSemver(pa, pb)
}

/** Safe `a > b` comparison (`false` on invalid versions, never throws). */
export const gt = (a: string, b: string): boolean => safeSemverOrder(a, b) === 1

/** Safe `a >= b` comparison (`false` on invalid versions, never throws). */
export function gte(a: string, b: string): boolean {
  const ord = safeSemverOrder(a, b)
  return ord === 0 || ord === 1
}

/** Safe `a < b` comparison (`false` on invalid versions, never throws). */
export const lt = (a: string, b: string): boolean => safeSemverOrder(a, b) === -1

/** Safe `a <= b` comparison (`false` on invalid versions, never throws). */
export function lte(a: string, b: string): boolean {
  const ord = safeSemverOrder(a, b)
  return ord === -1 || ord === 0
}

/** Safe `a === b` SemVer equality (`false` on invalid versions, never throws). */
export const eq = (a: string, b: string): boolean => safeSemverOrder(a, b) === 0

interface PartialSemver {
  readonly major: bigint | null // null => wildcard
  readonly minor: bigint | null
  readonly patch: bigint | null
  readonly prerelease: readonly (bigint | string)[]
  readonly hasPrerelease: boolean
}

function isWildcardToken(tok: string | undefined): boolean {
  return tok === "*" || tok === "x" || tok === "X"
}

function parsePartialSemver(raw: string): PartialSemver | null {
  const match = PARTIAL_VERSION_RE.exec(raw.trim())
  if (!match) return null

  const rawMajor = match[1]!
  const rawMinor = match[2]
  const rawPatch = match[3]
  const rawPre = match[4]

  const major = isWildcardToken(rawMajor) ? null : parseUint64Segment(rawMajor)
  if (!isWildcardToken(rawMajor) && major === null) return null

  let minor: bigint | null = null
  if (rawMinor !== undefined && !isWildcardToken(rawMinor)) {
    minor = parseUint64Segment(rawMinor)
    if (minor === null) return null
    if (major === null) return null // e.g. *.1.0 is malformed
  }

  let patch: bigint | null = null
  if (rawPatch !== undefined && !isWildcardToken(rawPatch)) {
    patch = parseUint64Segment(rawPatch)
    if (patch === null) return null
    if (major === null || minor === null) return null // e.g. 1.*.0 is malformed
  }

  const prerelease = parsePrereleaseParts(rawPre)
  if (prerelease === null) return null
  if (prerelease.length > 0 && (major === null || minor === null || patch === null)) {
    return null
  }

  return {
    major,
    minor,
    patch,
    prerelease,
    hasPrerelease: Boolean(rawPre),
  }
}

interface Comparator {
  readonly op: "<" | "<=" | ">" | ">=" | "="
  readonly target: ParsedSemver
}

function makeParsed(
  major: bigint,
  minor: bigint,
  patch: bigint,
  prerelease: readonly (bigint | string)[] = [],
): ParsedSemver {
  return {
    raw: `${major}.${minor}.${patch}`,
    major,
    minor,
    patch,
    prerelease,
    build: [],
  }
}

function expandComparatorToken(token: string): readonly Comparator[] | null {
  const match = RANGE_COMPARATOR_RE.exec(token.trim())
  if (!match) return null

  const op = match[1] ?? ""
  const partialRaw = token.trim().slice(op.length).trim()
  const p = parsePartialSemver(partialRaw)
  if (!p) return null

  // Wildcard without comparison operator
  if (p.major === null) {
    if (op === ">" || op === "<") return null
    return [{ op: ">=", target: makeParsed(0n, 0n, 0n) }]
  }

  if (op === "~") {
    const min = makeParsed(p.major, p.minor ?? 0n, p.patch ?? 0n, p.prerelease)
    const max =
      p.minor === null
        ? makeParsed(p.major + 1n, 0n, 0n, [0n])
        : makeParsed(p.major, p.minor + 1n, 0n, [0n])
    return [
      { op: ">=", target: min },
      { op: "<", target: max },
    ]
  }

  if (op === "^") {
    const min = makeParsed(p.major, p.minor ?? 0n, p.patch ?? 0n, p.prerelease)
    let max: ParsedSemver
    if (p.major > 0n) {
      max = makeParsed(p.major + 1n, 0n, 0n, [0n])
    } else if (p.minor !== null && p.minor > 0n) {
      max = makeParsed(0n, p.minor + 1n, 0n, [0n])
    } else if (p.minor === null) {
      max = makeParsed(1n, 0n, 0n, [0n])
    } else if (p.patch === null) {
      max = makeParsed(0n, 1n, 0n, [0n])
    } else {
      max = makeParsed(0n, 0n, p.patch + 1n, [0n])
    }
    return [
      { op: ">=", target: min },
      { op: "<", target: max },
    ]
  }

  if (op === "" || op === "=") {
    if (p.minor === null) {
      return [
        { op: ">=", target: makeParsed(p.major, 0n, 0n) },
        { op: "<", target: makeParsed(p.major + 1n, 0n, 0n, [0n]) },
      ]
    }
    if (p.patch === null) {
      return [
        { op: ">=", target: makeParsed(p.major, p.minor, 0n) },
        { op: "<", target: makeParsed(p.major, p.minor + 1n, 0n, [0n]) },
      ]
    }
    return [{ op: "=", target: makeParsed(p.major, p.minor, p.patch, p.prerelease) }]
  }

  // Relational operators (<, <=, >, >=)
  const resolved = makeParsed(p.major, p.minor ?? 0n, p.patch ?? 0n, p.prerelease)
  if (op === ">") {
    if (p.minor === null) {
      return [{ op: ">=", target: makeParsed(p.major + 1n, 0n, 0n) }]
    }
    if (p.patch === null) {
      return [{ op: ">=", target: makeParsed(p.major, p.minor + 1n, 0n) }]
    }
    return [{ op: ">", target: resolved }]
  }
  if (op === ">=") {
    return [{ op: ">=", target: resolved }]
  }
  if (op === "<") {
    if (p.minor === null || p.patch === null) {
      return [{ op: "<", target: makeParsed(p.major, p.minor ?? 0n, p.patch ?? 0n, [0n]) }]
    }
    return [{ op: "<", target: resolved }]
  }
  if (op === "<=") {
    if (p.minor === null) {
      return [{ op: "<", target: makeParsed(p.major + 1n, 0n, 0n, [0n]) }]
    }
    if (p.patch === null) {
      return [{ op: "<", target: makeParsed(p.major, p.minor + 1n, 0n, [0n]) }]
    }
    return [{ op: "<=", target: resolved }]
  }
  return null
}

function parseClauseComparators(clause: string): readonly Comparator[] | null {
  const trimmed = clause.trim()
  if (!trimmed) return null

  const hyphenParts = trimmed.split(/\s+-\s+/)
  if (hyphenParts.length > 2) return null
  if (hyphenParts.length === 2) {
    const left = parsePartialSemver(hyphenParts[0]!)
    const right = parsePartialSemver(hyphenParts[1]!)
    if (!left || !right) return null

    const out: Comparator[] = []
    if (left.major !== null) {
      out.push({
        op: ">=",
        target: makeParsed(left.major, left.minor ?? 0n, left.patch ?? 0n, left.prerelease),
      })
    } else {
      out.push({ op: ">=", target: makeParsed(0n, 0n, 0n) })
    }

    if (right.major !== null) {
      if (right.minor === null) {
        out.push({ op: "<", target: makeParsed(right.major + 1n, 0n, 0n, [0n]) })
      } else if (right.patch === null) {
        out.push({ op: "<", target: makeParsed(right.major, right.minor + 1n, 0n, [0n]) })
      } else {
        out.push({
          op: "<=",
          target: makeParsed(right.major, right.minor, right.patch, right.prerelease),
        })
      }
    }
    return out
  }

  // Join operator + version if separated by space (e.g. `>= 1.0.0`)
  const normalized = trimmed.replace(/(<=|>=|<|>|=|~|\^)\s+/g, "$1")
  const tokens = normalized.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  const comparators: Comparator[] = []
  for (const tok of tokens) {
    const expanded = expandComparatorToken(tok)
    if (!expanded) return null
    comparators.push(...expanded)
  }
  return comparators
}

function parseSemverRangeAst(range: string): readonly (readonly Comparator[])[] | null {
  if (typeof range !== "string") return null
  const trimmed = range.trim()
  if (!trimmed || !ASCII_PRINTABLE_RE.test(trimmed)) return null

  const rawClauses = trimmed.split("||")
  const clauses: (readonly Comparator[])[] = []
  for (const rawClause of rawClauses) {
    const parsed = parseClauseComparators(rawClause)
    if (!parsed) return null
    clauses.push(parsed)
  }
  return clauses.length > 0 ? clauses : null
}

/**
 * Returns `true` iff `range` is a syntactically valid SemVer range expression
 * with uint64-bounded components. Rejects `""`, `"invalid"`, `"latest"`,
 * `"workspace:*"`, `"npm:..."`, `"!=..."`, and non-ASCII strings so callers
 * never trigger `Bun.semver.satisfies` silent-wildcard degradation.
 */
export function isValidSemverRange(range: string): boolean {
  return parseSemverRangeAst(range) !== null
}

function satisfiesClause(version: ParsedSemver, comparators: readonly Comparator[]): boolean {
  for (const cmp of comparators) {
    const ord = compareParsedSemver(version, cmp.target)
    if (cmp.op === "=" && ord !== 0) return false
    if (cmp.op === ">" && ord !== 1) return false
    if (cmp.op === ">=" && ord < 0) return false
    if (cmp.op === "<" && ord !== -1) return false
    if (cmp.op === "<=" && ord > 0) return false
  }

  // SemVer prerelease rule: a prerelease version matches a comparator set only if at
  // least one comparator in the set specifies the exact same [major, minor, patch]
  // tuple WITH a prerelease tag.
  if (version.prerelease.length > 0) {
    const allowedByPrereleaseTuple = comparators.some(
      (c) =>
        c.target.prerelease.length > 0 &&
        c.target.major === version.major &&
        c.target.minor === version.minor &&
        c.target.patch === version.patch,
    )
    if (!allowedByPrereleaseTuple) return false
  }

  return true
}

/**
 * Scanner-safe replacement for `Bun.semver.satisfies(version, range)`.
 *
 * Prevents malformed, empty, or dist-tag/protocol advisory ranges from silently
 * degrading to `*` and flagging every version of a package.
 */
export function safeSatisfies(version: string, range: string): boolean {
  const parsedVersion = parseSemver(version)
  if (!parsedVersion) return false

  const clauses = parseSemverRangeAst(range)
  if (!clauses) return false

  const trimmedRange = range.trim()
  const engine = getBunSemverEngine()
  if (engine) {
    try {
      // Defensive secondary silent-wildcard guard against any future Bun range quirks
      const hasOpenBound = /[*xX]|>=|>/.test(trimmedRange)
      if (
        !hasOpenBound &&
        engine.satisfies("0.0.0", trimmedRange) &&
        engine.satisfies("18446744073709551615.0.0", trimmedRange)
      ) {
        return false
      }
      return engine.satisfies(parsedVersion.raw, trimmedRange)
    } catch {
      return false
    }
  }

  return clauses.some((clause) => satisfiesClause(parsedVersion, clause))
}
