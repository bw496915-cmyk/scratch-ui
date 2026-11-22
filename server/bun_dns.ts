import { isIP } from "node:net"

import {
  DualClockSlaEvaluator,
  type DualClockSlaSnapshot,
  type SlaStateCode,
} from "../src/lib/dual_clock_sla.ts"

declare const Bun: Pick<typeof import("bun"), "dns">

const BUN_DNS_BACKENDS = ["c-ares", "system", "getaddrinfo"] as const
const bunDnsSlaEvaluator = new DualClockSlaEvaluator()

export function readBunDnsCacheStats() {
  const { cacheHitsCompleted, cacheHitsInflight, cacheMisses, size, errors, totalCount } =
    Bun.dns.getCacheStats()
  return Object.freeze({
    cacheHitsCompleted,
    cacheHitsInflight,
    cacheMisses,
    size,
    errors,
    totalCount,
  })
}

/**
 * Evaluates live `Bun.dns.getCacheStats()` through the module-level zero-allocation
 * `DualClockSlaEvaluator` and returns the deterministic `SlaStateCode`.
 */
export function evaluateBunDnsSla(
  publishedEpochMs: number = -1,
  dataWindowMaxEpochMs: number = -1,
  uiStateMask: number = 0,
): SlaStateCode {
  return bunDnsSlaEvaluator.probeLiveDns(publishedEpochMs, dataWindowMaxEpochMs, uiStateMask)
}

export function getBunDnsSlaSnapshot(): DualClockSlaSnapshot {
  return bunDnsSlaEvaluator.snapshot()
}

export function readBunDnsTelemetry() {
  if (typeof Bun === "undefined") return null
  bunDnsSlaEvaluator.beginProbe()
  const stats = readBunDnsCacheStats()
  bunDnsSlaEvaluator.endProbe()
  bunDnsSlaEvaluator.tickScalars(
    stats.cacheHitsCompleted,
    stats.cacheHitsInflight,
    stats.cacheMisses,
    stats.errors,
    stats.size,
    stats.totalCount,
  )
  const hits = stats.cacheHitsCompleted + stats.cacheHitsInflight
  const slaToken = bunDnsSlaEvaluator.getToken()
  return {
    ...stats,
    source: "bun-native-cache",
    capacity: 256,
    defaultTtlSeconds: 30,
    hitRatePercent: stats.totalCount ? Math.round((hits / stats.totalCount) * 1000) / 10 : 0,
    slaState: slaToken.stateId,
    slaToken: slaToken.tokenName,
    slaReasonMask: bunDnsSlaEvaluator.reasonMask,
  }
}

export function prefetchBunDnsOrigins(origins: readonly (string | undefined)[]): void {
  if (typeof Bun === "undefined") return
  const endpoints = new Map<string, { hostname: string; port: number }>()
  for (const origin of origins) {
    const url = origin ? URL.parse(origin) : null
    if (!url || url.username || url.password || !["http:", "https:"].includes(url.protocol))
      continue
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    if (isIP(hostname)) continue
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80
    if (port === 0) continue
    endpoints.set(`${hostname}:${port}`, { hostname, port })
  }
  for (const { hostname, port } of endpoints.values()) Bun.dns.prefetch(hostname, port)
}

export async function benchmarkBunDns(hostname: string) {
  const host = hostname.trim() || "fantasy402.com"
  const observations = await Promise.all(
    BUN_DNS_BACKENDS.map(async (backend) => {
      const samples: number[] = []
      let resolvedAddress = ""
      try {
        for (let index = 0; index < 3; index++) {
          const startedAt = performance.now()
          const [address] = await Bun.dns.lookup(host, { backend })
          if (!address) break
          samples.push(performance.now() - startedAt)
          resolvedAddress = address.address
        }
      } catch {
        // The other resolver backends can still complete.
      }
      const meanMs =
        samples.length === 3 ? samples.reduce((sum, time) => sum + time, 0) / samples.length : null
      return { backend, meanMs, samples, resolvedAddress }
    }),
  )

  const completed = observations
    .filter((row): row is typeof row & { meanMs: number } => row.meanMs !== null)
    .sort((a, b) => a.meanMs - b.meanMs)
  const fastest = completed[0]
  const slowest = completed.at(-1)
  return {
    host,
    resolvedAddress: fastest?.resolvedAddress ?? "",
    fastestBackend: fastest?.backend ?? null,
    speedupFactor:
      fastest && slowest && fastest !== slowest && fastest.meanMs > 0
        ? slowest.meanMs / fastest.meanMs
        : null,
    metrics: observations.map(({ backend, meanMs, samples }) => ({ backend, meanMs, samples })),
    timestamp: new Date().toISOString(),
  }
}
