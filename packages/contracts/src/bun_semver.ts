/**
 * @file packages/contracts/src/bun_semver.ts
 * @description Scanner-safe wrappers around `Bun.semver` (`satisfies` and `order`)
 * with deterministic SemVer 2.0 / uint64 bounds checking and Node/browser fallback.
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

interface PartialSemver {
  readonly major: bigint | null
  readonly minor: bigint | null
  readonly patch: bigint | null
  readonly prerelease: readonly (bigint | string)[]
}

interface Comparator {
  readonly op: "<" | "<=" | ">" | ">=" | "="
  readonly target: ParsedSemver
}

const ASCII_PRINTABLE_RE = /^[\x20-\x7e]+$/
const STRICT_VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/
const RANGE_COMPARATOR_RE =
  /^(<=|>=|<|>|=|~|\^)?\s*v?(\d+|[*xX])(?:\.(\d+|[*xX])(?:\.(\d+|[*xX])(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)?)?$/
const PARTIAL_VERSION_RE =
  /^v?(\d+|[*xX])(?:\.(\d+|[*xX])(?:\.(\d+|[*xX])(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)?)?$/

function getBunSemverEngine(): BunSemverEngine | null {
  const semver = (globalThis as { readonly Bun?: { readonly semver?: BunSemverEngine } }).Bun
    ?.semver
  if (typeof semver?.satisfies === "function" && typeof semver?.order === "function") {
    return semver
  }
  return null
}

function parseUint64Segment(segment: string): bigint | null {
  if (!/^\d+$/.test(segment)) {
    return null
  }
  const val = BigInt(segment)
  return val <= MAX_SEMVER_UINT64 ? val : null
}

function parsePrereleaseParts(raw: string | undefined): readonly (bigint | string)[] | null {
  if (!raw) {
    return []
  }
  const out: (bigint | string)[] = []
  for (const part of raw.split(".")) {
    if (!part) {
      return null
    }
    const val = /^\d+$/.test(part) ? parseUint64Segment(part) : part
    if (val === null) {
      return null
    }
    out.push(val)
  }
  return out
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

/**
 * Parses and validates an ASCII SemVer 2.0 string with uint64 (`<= 2^64 - 1`)
 * component bounds. Returns `null` on invalid, empty, overflowing, or non-ASCII input.
 */
export function parseSemver(version: string): ParsedSemver | null {
  if (typeof version !== "string") {
    return null
  }
  const trimmed = version.trim()
  if (!trimmed || !ASCII_PRINTABLE_RE.test(trimmed)) {
    return null
  }

  const match = STRICT_VERSION_RE.exec(trimmed)
  if (!match) {
    return null
  }

  const major = parseUint64Segment(match[1]!)
  const minor = parseUint64Segment(match[2]!)
  const patch = parseUint64Segment(match[3]!)
  const prerelease = parsePrereleaseParts(match[4])
  if (major === null || minor === null || patch === null || prerelease === null) {
    return null
  }

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
    build: match[5] ? match[5].split(".") : [],
  }
}

/** Returns `true` iff `version` is a valid, non-overflowing SemVer string. */
export function isValidSemver(version: string): boolean {
  return parseSemver(version) !== null
}

function compareParsedSemver(a: ParsedSemver, b: ParsedSemver): SemverOrderResult {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1
  }

  const aPre = a.prerelease
  const bPre = b.prerelease
  if (aPre.length === 0 && bPre.length === 0) {
    return 0
  }
  if (aPre.length === 0 || bPre.length === 0) {
    return aPre.length === 0 ? 1 : -1
  }

  const len = Math.max(aPre.length, bPre.length)
  for (let i = 0; i < len; i += 1) {
    const ap = aPre[i]
    const bp = bPre[i]
    if (ap === undefined) {
      return -1
    }
    if (bp === undefined) {
      return 1
    }
    if (ap === bp) {
      continue
    }
    const aNum = typeof ap === "bigint"
    const bNum = typeof bp === "bigint"
    if (aNum !== bNum) {
      return aNum ? -1 : 1
    }
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
  if (!pa || !pb) {
    return null
  }

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
export const gte = (a: string, b: string): boolean => (safeSemverOrder(a, b) ?? -1) >= 0

/** Safe `a < b` comparison (`false` on invalid versions, never throws). */
export const lt = (a: string, b: string): boolean => safeSemverOrder(a, b) === -1

/** Safe `a <= b` comparison (`false` on invalid versions, never throws). */
export const lte = (a: string, b: string): boolean => (safeSemverOrder(a, b) ?? 1) <= 0

/** Safe `a === b` SemVer equality (`false` on invalid versions, never throws). */
export const eq = (a: string, b: string): boolean => safeSemverOrder(a, b) === 0

function parsePartialSemver(raw: string): PartialSemver | null {
  const match = PARTIAL_VERSION_RE.exec(raw.trim())
  if (!match) {
    return null
  }

  const parseSegment = (tok: string | undefined): bigint | null | false => {
    if (tok === undefined || tok === "*" || tok === "x" || tok === "X") {
      return null
    }
    return parseUint64Segment(tok) ?? false
  }

  const major = parseSegment(match[1])
  const minor = parseSegment(match[2])
  const patch = parseSegment(match[3])
  const prerelease = parsePrereleaseParts(match[4])
  if (
    major === false ||
    minor === false ||
    patch === false ||
    prerelease === null ||
    (minor !== null && major === null) ||
    (patch !== null && (major === null || minor === null)) ||
    (prerelease.length > 0 && (major === null || minor === null || patch === null))
  ) {
    return null
  }

  return { major, minor, patch, prerelease }
}

function bumpPartialUpper(p: PartialSemver, pre: readonly (bigint | string)[] = []): ParsedSemver {
  if (p.minor === null) {
    return makeParsed(p.major! + 1n, 0n, 0n, pre)
  }
  return makeParsed(p.major!, p.minor + 1n, 0n, pre)
}

function parseSemverRangeAst(range: string): readonly (readonly Comparator[])[] | null {
  if (typeof range !== "string") {
    return null
  }
  const trimmed = range.trim()
  if (!trimmed || !ASCII_PRINTABLE_RE.test(trimmed)) {
    return null
  }

  const clauses: (readonly Comparator[])[] = []
  for (const rawClause of trimmed.split("||")) {
    const clause = rawClause.trim()
    if (!clause) {
      return null
    }

    const hyphenParts = clause.split(/\s+-\s+/)
    if (hyphenParts.length > 2) {
      return null
    }
    if (hyphenParts.length === 2) {
      const left = parsePartialSemver(hyphenParts[0]!)
      const right = parsePartialSemver(hyphenParts[1]!)
      if (!left || !right) {
        return null
      }
      const out: Comparator[] = [
        {
          op: ">=",
          target:
            left.major !== null
              ? makeParsed(left.major, left.minor ?? 0n, left.patch ?? 0n, left.prerelease)
              : makeParsed(0n, 0n, 0n),
        },
      ]
      if (right.major !== null) {
        out.push(
          right.minor === null || right.patch === null
            ? { op: "<", target: bumpPartialUpper(right, [0n]) }
            : {
                op: "<=",
                target: makeParsed(right.major, right.minor, right.patch, right.prerelease),
              },
        )
      }
      clauses.push(out)
      continue
    }

    const tokens = clause
      .replace(/(<=|>=|<|>|=|~|\^)\s+/g, "$1")
      .split(/\s+/)
      .filter(Boolean)
    if (tokens.length === 0) {
      return null
    }

    const comparators: Comparator[] = []
    for (const tok of tokens) {
      const match = RANGE_COMPARATOR_RE.exec(tok.trim())
      if (!match) {
        return null
      }
      const op = match[1] ?? ""
      const p = parsePartialSemver(tok.trim().slice(op.length))
      if (!p) {
        return null
      }

      if (p.major === null) {
        if (op === ">" || op === "<") {
          return null
        }
        comparators.push({ op: ">=", target: makeParsed(0n, 0n, 0n) })
        continue
      }

      const resolved = makeParsed(p.major, p.minor ?? 0n, p.patch ?? 0n, p.prerelease)
      if (op === "~") {
        comparators.push(
          { op: ">=", target: resolved },
          { op: "<", target: bumpPartialUpper(p, [0n]) },
        )
      } else if (op === "^") {
        let max: ParsedSemver
        if (p.major > 0n) {
          max = makeParsed(p.major + 1n, 0n, 0n, [0n])
        } else if (p.minor === null) {
          max = makeParsed(1n, 0n, 0n, [0n])
        } else if (p.minor > 0n) {
          max = makeParsed(0n, p.minor + 1n, 0n, [0n])
        } else if (p.patch === null) {
          max = makeParsed(0n, 1n, 0n, [0n])
        } else {
          max = makeParsed(0n, 0n, p.patch + 1n, [0n])
        }
        comparators.push({ op: ">=", target: resolved }, { op: "<", target: max })
      } else if (op === "" || op === "=") {
        if (p.minor === null || p.patch === null) {
          comparators.push(
            { op: ">=", target: makeParsed(p.major, p.minor ?? 0n, 0n) },
            { op: "<", target: bumpPartialUpper(p, [0n]) },
          )
        } else {
          comparators.push({ op: "=", target: resolved })
        }
      } else if (op === ">") {
        comparators.push(
          p.minor === null || p.patch === null
            ? { op: ">=", target: bumpPartialUpper(p) }
            : { op: ">", target: resolved },
        )
      } else if (op === ">=") {
        comparators.push({ op: ">=", target: resolved })
      } else if (op === "<") {
        comparators.push({
          op: "<",
          target:
            p.minor === null || p.patch === null
              ? makeParsed(p.major, p.minor ?? 0n, p.patch ?? 0n, [0n])
              : resolved,
        })
      } else if (op === "<=") {
        comparators.push(
          p.minor === null || p.patch === null
            ? { op: "<", target: bumpPartialUpper(p, [0n]) }
            : { op: "<=", target: resolved },
        )
      } else {
        return null
      }
    }
    clauses.push(comparators)
  }

  return clauses.length > 0 ? clauses : null
}

/**
 * Returns `true` iff `range` is a syntactically valid SemVer range expression
 * with uint64-bounded components. Rejects `""`, `"invalid"`, `"latest"`,
 * `"workspace:*"`, `"npm:..."`, `"!=..."`, and non-ASCII strings.
 */
export function isValidSemverRange(range: string): boolean {
  return parseSemverRangeAst(range) !== null
}

/**
 * Scanner-safe replacement for `Bun.semver.satisfies(version, range)` that
 * rejects malformed, empty, or dist-tag/protocol ranges before matching.
 */
export function safeSatisfies(version: string, range: string): boolean {
  const parsedVersion = parseSemver(version)
  if (!parsedVersion) {
    return false
  }

  const clauses = parseSemverRangeAst(range)
  if (!clauses) {
    return false
  }

  const trimmedRange = range.trim()
  const engine = getBunSemverEngine()
  if (engine) {
    try {
      if (
        !/[*xX]|>=|>/.test(trimmedRange) &&
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

  return clauses.some((comparators) => {
    for (const cmp of comparators) {
      const ord = compareParsedSemver(parsedVersion, cmp.target)
      if (
        (cmp.op === "=" && ord !== 0) ||
        (cmp.op === ">" && ord !== 1) ||
        (cmp.op === ">=" && ord < 0) ||
        (cmp.op === "<" && ord !== -1) ||
        (cmp.op === "<=" && ord > 0)
      ) {
        return false
      }
    }
    return (
      parsedVersion.prerelease.length === 0 ||
      comparators.some(
        (c) =>
          c.target.prerelease.length > 0 &&
          c.target.major === parsedVersion.major &&
          c.target.minor === parsedVersion.minor &&
          c.target.patch === parsedVersion.patch,
      )
    )
  })
}
