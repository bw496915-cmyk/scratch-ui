import { afterEach, describe, expect, spyOn, test } from "bun:test"

import {
  assertCleanHostname,
  DnsBoundaryError,
  type DnsErrorCode,
  lookupStrictFamily,
} from "../../src/lib/dns_boundary.ts"
import { auditDnsDrift, isRetryableDnsError } from "../../src/lib/dns_drift_audit.ts"

describe("L1: Bun.dns Hostname & IP Family Boundaries", () => {
  test("assertCleanHostname normalizes valid domains and IPv4 literals", () => {
    expect(assertCleanHostname("Desk.BookDeskOps.com.")).toBe("desk.bookdeskops.com")
    expect(assertCleanHostname("127.0.0.1")).toBe("127.0.0.1")
  })

  test("assertCleanHostname rejects schemes, ports, brackets, and IPv6 zone IDs", () => {
    expect(() => assertCleanHostname("https://desk.bookdeskops.com")).toThrow("ERR_DNS_INVALID_HOSTNAME")
    expect(() => assertCleanHostname("desk.bookdeskops.com:443")).toThrow("ERR_DNS_INVALID_HOSTNAME")
    expect(() => assertCleanHostname("[::1]")).toThrow("ERR_DNS_INVALID_HOSTNAME")
    expect(() => assertCleanHostname("fe80::1%eth0")).toThrow("ERR_DNS_IPV6_ZONE_FORBIDDEN")
    expect(() => assertCleanHostname("fe80::1%25en0")).toThrow("ERR_DNS_IPV6_ZONE_FORBIDDEN")
    expect(() => assertCleanHostname("999.0.0.1")).toThrow("ERR_DNS_INVALID_HOSTNAME")
  })

  test("lookupStrictFamily resolves localhost strictly as IPv4 via system backend", async () => {
    const records = await lookupStrictFamily("localhost", {
      family: 4,
      backend: "system",
      timeoutMs: 2_000,
    })
    expect(records.length).toBeGreaterThan(0)
    for (const rec of records) {
      expect(rec.family).toBe(4)
      expect(rec.address).toBe("127.0.0.1")
    }
  })

  test("lookupStrictFamily rejects IP-family mismatches on literal IPs", async () => {
    let caught: unknown
    try {
      await lookupStrictFamily("127.0.0.1", { family: 6, timeoutMs: 2_000 })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DnsBoundaryError)
    expect((caught as DnsBoundaryError).code).toBe("ERR_DNS_FAMILY_MISMATCH")
  })

  test("lookupStrictFamily wraps lookup failures as ERR_DNS_LOOKUP_FAILED", async () => {
    let caught: unknown
    try {
      await lookupStrictFamily("nonexistent.sportsdesk.invalid", {
        family: 4,
        backend: "system",
        timeoutMs: 2_000,
      })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(DnsBoundaryError)
    expect((caught as DnsBoundaryError).code).toBe("ERR_DNS_LOOKUP_FAILED")
  })
})

describe("L1: isRetryableDnsError classification", () => {
  const retryableCodes: readonly DnsErrorCode[] = ["ERR_DNS_TIMEOUT", "ERR_DNS_LOOKUP_FAILED"]

  const nonRetryableCodes: readonly DnsErrorCode[] = [
    "ERR_DNS_INVALID_HOSTNAME",
    "ERR_DNS_IPV6_ZONE_FORBIDDEN",
    "ERR_DNS_FAMILY_MISMATCH",
    "ERR_DNS_EMPTY_RESULT",
  ]

  test.each(retryableCodes)("returns true for %s", (code) => {
    const err = new DnsBoundaryError(code, "simulated transient fault")
    expect(isRetryableDnsError(err)).toBe(true)
  })

  test.each(nonRetryableCodes)("returns false for %s", (code) => {
    const err = new DnsBoundaryError(code, "simulated permanent fault")
    expect(isRetryableDnsError(err)).toBe(false)
  })

  test("returns false for non-DnsBoundaryError values", () => {
    expect(isRetryableDnsError(new Error("ENOTFOUND"))).toBe(false)
    expect(isRetryableDnsError("ERR_DNS_TIMEOUT")).toBe(false)
    expect(isRetryableDnsError(null)).toBe(false)
    expect(isRetryableDnsError(undefined)).toBe(false)
  })
})

describe("L1: auditDnsDrift detection (mocked Bun.dns)", () => {
  let lookupSpy: ReturnType<typeof spyOn> | null = null
  let statsSpy: ReturnType<typeof spyOn> | null = null

  afterEach(() => {
    lookupSpy?.mockRestore()
    statsSpy?.mockRestore()
    lookupSpy = null
    statsSpy = null
  })

  test("emits DRIFT_ZERO_TTL_ON_EXTERNAL when c-ares returns ttl=0 for all records", async () => {
    lookupSpy = spyOn(Bun.dns, "lookup").mockResolvedValue([
      { address: "104.21.10.5", family: 4, ttl: 0 },
      { address: "172.67.150.20", family: 4, ttl: 0 },
    ])
    statsSpy = spyOn(Bun.dns, "getCacheStats").mockReturnValue({
      cacheHitsCompleted: 10,
      cacheHitsInflight: 0,
      cacheMissesCompleted: 2,
      size: 2,
      errors: 0,
      totalCount: 12,
    })

    const findings = await auditDnsDrift({
      externalHosts: ["desk.bookdeskops.com"],
      family: 4,
      backend: "c-ares",
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      code: "DRIFT_ZERO_TTL_ON_EXTERNAL",
      host: "desk.bookdeskops.com",
    })
  })

  test("does not emit DRIFT_ZERO_TTL_ON_EXTERNAL when c-ares returns positive TTL", async () => {
    lookupSpy = spyOn(Bun.dns, "lookup").mockResolvedValue([{ address: "104.21.10.5", family: 4, ttl: 300 }])
    statsSpy = spyOn(Bun.dns, "getCacheStats").mockReturnValue({
      cacheHitsCompleted: 25,
      cacheHitsInflight: 0,
      cacheMissesCompleted: 5,
      size: 5,
      errors: 0,
      totalCount: 30,
    })

    const findings = await auditDnsDrift({
      externalHosts: ["desk.bookdeskops.com"],
      family: 4,
      backend: "c-ares",
    })

    expect(findings).toEqual([])
  })

  test("does not emit DRIFT_ZERO_TTL_ON_EXTERNAL under system backend even when ttl=0", async () => {
    lookupSpy = spyOn(Bun.dns, "lookup").mockResolvedValue([{ address: "127.0.0.1", family: 4, ttl: 0 }])
    statsSpy = spyOn(Bun.dns, "getCacheStats").mockReturnValue({
      cacheHitsCompleted: 5,
      cacheHitsInflight: 0,
      cacheMissesCompleted: 1,
      size: 1,
      errors: 0,
      totalCount: 6,
    })

    const findings = await auditDnsDrift({
      externalHosts: ["localhost"],
      family: 4,
      backend: "system",
    })

    expect(findings).toEqual([])
  })

  test("emits DRIFT_CACHE_HIGH_MISS_RATIO when total >= 20 and miss ratio > 80%", async () => {
    lookupSpy = spyOn(Bun.dns, "lookup").mockResolvedValue([{ address: "104.21.10.5", family: 4, ttl: 120 }])
    statsSpy = spyOn(Bun.dns, "getCacheStats").mockReturnValue({
      cacheHitsCompleted: 3,
      cacheHitsInflight: 0,
      cacheMissesCompleted: 22,
      size: 22,
      errors: 0,
      totalCount: 25,
    })

    const findings = await auditDnsDrift({
      externalHosts: ["desk.bookdeskops.com"],
      family: 4,
      backend: "c-ares",
    })

    expect(findings).toHaveLength(1)
    expect(findings[0]?.code).toBe("DRIFT_CACHE_HIGH_MISS_RATIO")
    expect(findings[0]?.detail).toContain("88.0%")
  })
})
