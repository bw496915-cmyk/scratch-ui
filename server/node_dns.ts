import { lookup } from "node:dns/promises"

const DNS_CACHE_CAPACITY = 256
const DNS_CACHE_TTL_MS = 30_000

/** Application-owned measurements; these do not describe Node's or the OS resolver cache. */
export function createNodeDnsService(
  options: {
    resolveAddress?: (hostname: string) => Promise<{ address: string }>
    now?: () => number
    measure?: () => number
  } = {},
) {
  const resolveAddress = options.resolveAddress ?? ((hostname: string) => lookup(hostname))
  const now = options.now ?? Date.now
  const measure = options.measure ?? (() => performance.now())
  const cache = new Map<string, { address: string; expiresAt: number }>()
  let hits = 0
  let misses = 0
  let errors = 0

  function pruneExpiredAddresses() {
    for (const [hostname, entry] of cache) {
      if (entry.expiresAt <= now()) cache.delete(hostname)
    }
  }

  async function resolveHostname(hostname: string, useCache = true): Promise<string> {
    pruneExpiredAddresses()
    const entry = useCache ? cache.get(hostname) : undefined
    if (entry) {
      hits++
      cache.delete(hostname)
      cache.set(hostname, entry)
      return entry.address
    }
    misses++
    try {
      const { address } = await resolveAddress(hostname)
      if (useCache) {
        if (cache.size >= DNS_CACHE_CAPACITY) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(hostname, { address, expiresAt: now() + DNS_CACHE_TTL_MS })
      }
      return address
    } catch (error) {
      errors++
      throw error
    }
  }

  function getTelemetry() {
    pruneExpiredAddresses()
    const total = hits + misses
    return {
      source: "node-application-cache",
      size: cache.size,
      capacity: DNS_CACHE_CAPACITY,
      hitRatePercent: total ? Math.round((hits / total) * 1000) / 10 : 0,
      cacheHitsCompleted: hits,
      cacheHitsInflight: 0,
      cacheMisses: misses,
      defaultTtlSeconds: DNS_CACHE_TTL_MS / 1000,
      errors,
      totalCount: total,
    }
  }

  async function benchmarkHostname(hostname: string) {
    const host = hostname.trim() || "fantasy402.com"
    let resolvedAddress = ""
    async function sample(useCache: boolean) {
      const samples: number[] = []
      for (let index = 0; index < 3; index++) {
        const startedAt = measure()
        resolvedAddress = await resolveHostname(host, useCache)
        samples.push(Math.max(0, measure() - startedAt))
      }
      return samples
    }
    const systemSamples = await sample(false)
    await resolveHostname(host) // Warm the application cache before measuring hits.
    const cachedSamples = await sample(true)
    const mean = (samples: number[]) => samples.reduce((sum, ms) => sum + ms, 0) / samples.length
    const meanSystem = mean(systemSamples)
    const meanCached = mean(cachedSamples)
    const fastestMs = Math.min(meanSystem, meanCached)
    return {
      host,
      resolvedAddress,
      fastestBackend: meanCached < meanSystem ? "node-cache" : "system",
      speedupFactor: fastestMs > 0 ? Math.max(meanSystem, meanCached) / fastestMs : null,
      metrics: [
        { backend: "node-cache", meanMs: meanCached, samples: cachedSamples },
        { backend: "system", meanMs: meanSystem, samples: systemSamples },
      ],
      timestamp: new Date(now()).toISOString(),
    }
  }

  return { resolveHostname, getTelemetry, benchmarkHostname }
}

export const nodeDnsService = createNodeDnsService()
