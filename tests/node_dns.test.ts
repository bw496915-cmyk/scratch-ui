import { describe, expect, test } from "bun:test"

import { createNodeDnsService } from "../server/node_dns.ts"

describe("measured Node DNS telemetry", () => {
  test("starts empty and measures hits, expiry, misses and failures", async () => {
    let clock = 0
    let calls = 0
    const dns = createNodeDnsService({
      now: () => clock,
      resolveAddress: async (host) => {
        calls++
        if (host === "invalid") throw new Error("unresolved")
        return { address: "127.0.0.1" }
      },
    })
    expect(dns.getTelemetry()).toMatchObject({ size: 0, totalCount: 0, hitRatePercent: 0 })
    await dns.resolveHostname("example.test")
    await dns.resolveHostname("example.test")
    expect(calls).toBe(1)
    expect(dns.getTelemetry()).toMatchObject({ size: 1, cacheHitsCompleted: 1, cacheMisses: 1 })
    clock = 30_000
    expect(dns.getTelemetry().size).toBe(0)
    await dns.resolveHostname("example.test")
    await expect(dns.resolveHostname("invalid")).rejects.toThrow("unresolved")
    expect(dns.getTelemetry()).toMatchObject({ cacheMisses: 3, errors: 1, totalCount: 4 })
  })

  test("bounds the cache and evicts the least recently used address", async () => {
    let calls = 0
    const dns = createNodeDnsService({
      resolveAddress: async () => {
        calls++
        return { address: "127.0.0.1" }
      },
    })
    for (let index = 0; index < 256; index++) await dns.resolveHostname(String(index))
    await dns.resolveHostname("0")
    await dns.resolveHostname("256")
    await dns.resolveHostname("1")
    expect(calls).toBe(258)
    expect(dns.getTelemetry().size).toBe(256)
  })

  test("benchmarks use measured intervals rather than scaled system samples", async () => {
    let clock = 0
    const dns = createNodeDnsService({
      measure: () => clock++,
      resolveAddress: async () => {
        clock += 10
        return { address: "127.0.0.1" }
      },
    })
    const result = await dns.benchmarkHostname("example.test")
    expect(result.metrics[0]?.samples).toEqual([1, 1, 1])
    expect(result.metrics[1]?.samples).toEqual([11, 11, 11])
    expect(result.speedupFactor).toBe(11)
    expect(dns.getTelemetry()).toMatchObject({ cacheHitsCompleted: 3, cacheMisses: 4 })
  })
})
