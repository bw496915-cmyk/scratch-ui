/**
 * Verifies scanner-safe SemVer wrappers against `Bun.semver` silent-wildcard traps, throwing `order()` inputs, uint64
 * overflow (> 2^64 - 1), and non-ASCII registry/lockfile strings.
 *
 * @file Tests/unit/bun_semver.test.ts
 */

import { describe, expect, test } from "bun:test"

import {
  eq,
  gt,
  gte,
  isValidSemver,
  isValidSemverRange,
  lt,
  lte,
  MAX_SEMVER_UINT64,
  parseSemver,
  safeSatisfies,
  safeSemverOrder,
} from "../../packages/contracts/src/bun_semver.ts"

describe("bun_semver: scanner-safe wrappers & gotcha guards", () => {
  test("prevents silent wildcard fallback on empty, invalid, dist-tag, and protocol ranges", () => {
    const malformedRanges = [
      "",
      "   ",
      "invalid",
      "typo-advisory-feed",
      "!=1.0.0",
      "latest",
      "workspace:*",
      "npm:react@19.0.1",
      "1.0.0 || invalid",
      "bad || 1.4.4",
      "1.0.0 - bad",
      "*.1.0",
    ]

    for (const badRange of malformedRanges) {
      expect(isValidSemverRange(badRange)).toBe(false)
      expect(safeSatisfies("1.4.4", badRange)).toBe(false)
      expect(safeSatisfies("0.0.0", badRange)).toBe(false)
      expect(safeSatisfies("999.0.0", badRange)).toBe(false)
    }
  })

  test("preserves valid SemVer wildcards and bounded range comparators", () => {
    expect(safeSatisfies("1.4.4", "*")).toBe(true)
    expect(safeSatisfies("1.4.4", "x")).toBe(true)
    expect(safeSatisfies("1.4.4", "X")).toBe(true)
    expect(safeSatisfies("1.4.4", "*.*.*")).toBe(true)
    expect(safeSatisfies("1.4.4", ">=0.0.0")).toBe(true)
    expect(safeSatisfies("1.4.4", "<9999999.0.0")).toBe(true)

    expect(safeSatisfies("1.4.4", "^1.4.0")).toBe(true)
    expect(safeSatisfies("2.0.0", "^1.4.0")).toBe(false)
    expect(safeSatisfies("1.4.4", "~1.4.0")).toBe(true)
    expect(safeSatisfies("1.5.0", "~1.4.0")).toBe(false)
    expect(safeSatisfies("1.4.4", ">=1.4.0 <1.5.0")).toBe(true)
    expect(safeSatisfies("1.4.4", "1.4.0 - 1.4.5")).toBe(true)
    expect(safeSatisfies("1.4.4", "1.2.0 || ^1.4.0")).toBe(true)
    expect(safeSatisfies("1.4.4", "1.4.x")).toBe(true)
    expect(safeSatisfies("1.4.4-rc.1", ">=1.4.4-rc.1")).toBe(true)
    expect(safeSatisfies("1.4.4-rc.1", ">=1.4.4")).toBe(false)
  })

  test("guards order/gt/gte/lt/lte/eq against throwing on invalid or untrusted lockfile strings", () => {
    expect(() => safeSemverOrder("bad", "1.0.0")).not.toThrow()
    expect(safeSemverOrder("bad", "1.0.0")).toBeNull()
    expect(safeSemverOrder("1.0.0", "1.2")).toBeNull()

    expect(gt("bad", "1.0.0")).toBe(false)
    expect(gte("bad", "1.0.0")).toBe(false)
    expect(lt("bad", "1.0.0")).toBe(false)
    expect(lte("bad", "1.0.0")).toBe(false)
    expect(eq("bad", "bad")).toBe(false)

    expect(gt("1.4.5", "1.4.4")).toBe(true)
    expect(gte("1.4.4", "1.4.4")).toBe(true)
    expect(lt("1.4.4-alpha.1", "1.4.4-beta.1")).toBe(true)
    expect(lt("1.4.4-rc.1", "1.4.4")).toBe(true)
    expect(lte("1.4.4", "1.4.5")).toBe(true)
    expect(eq("1.4.4+build.1", "1.4.4+build.2")).toBe(true)
    expect(eq("v1.4.4", "1.4.4")).toBe(true)
  })

  test("rejects uint64 overflow (> 2^64 - 1) and non-ASCII strings cleanly", () => {
    const maxValid = `${MAX_SEMVER_UINT64}.0.0`
    const overflow = `${MAX_SEMVER_UINT64 + 1n}.0.0`

    expect(isValidSemver(maxValid)).toBe(true)
    expect(parseSemver(maxValid)?.major).toBe(MAX_SEMVER_UINT64)

    expect(isValidSemver(overflow)).toBe(false)
    expect(parseSemver(overflow)).toBeNull()
    expect(safeSatisfies(overflow, "*")).toBe(false)
    expect(safeSatisfies("1.0.0", `>=${overflow}`)).toBe(false)
    expect(isValidSemverRange(`>=${overflow}`)).toBe(false)
    expect(safeSemverOrder(overflow, "1.0.0")).toBeNull()

    expect(isValidSemver("1.4.4-🚀")).toBe(false)
    expect(safeSatisfies("1.4.4-🚀", "*")).toBe(false)
    expect(safeSatisfies("1.4.4", "1.4.4-🚀")).toBe(false)
    expect(safeSemverOrder("1.4.4-🚀", "1.4.4")).toBeNull()
  })
})
