/**
 * @file src/lib/dns_drift_audit.ts
 * @description L1 DNS retryability classification and Bun.dns cache/TTL drift detection.
 */

import {
  DnsBoundaryError,
  type DnsErrorCode,
  type DnsResolverBackend,
  lookupStrictFamily,
} from "./dns_boundary.ts"

export type DnsDriftCode =
  "DRIFT_ZERO_TTL_ON_EXTERNAL" | "DRIFT_CACHE_HIGH_MISS_RATIO" | "DRIFT_LOOKUP_FAILED"

export interface DnsDriftFinding {
  readonly code: DnsDriftCode
  readonly host?: string
  readonly detail: string
}

export interface BunDnsCacheStats {
  readonly cacheHitsCompleted?: number
  readonly cacheHitsInflight?: number
  readonly cacheMissesCompleted?: number
  readonly cacheMisses?: number
  readonly size?: number
  readonly errors?: number
  readonly totalCount?: number
}

export interface AuditDnsDriftOptions {
  readonly externalHosts?: readonly string[]
  readonly family?: 4 | 6
  readonly backend?: DnsResolverBackend
  readonly timeoutMs?: number
  readonly minCacheSamples?: number
  readonly maxMissRatio?: number
}

interface BunDnsGlobalLike {
  readonly dns?: {
    getCacheStats?: () => BunDnsCacheStats
  }
}

const RETRYABLE_DNS_ERROR_CODES: ReadonlySet<DnsErrorCode> = new Set<DnsErrorCode>([
  "ERR_DNS_TIMEOUT",
  "ERR_DNS_LOOKUP_FAILED",
])

const DEFAULT_MIN_CACHE_SAMPLES = 20
const DEFAULT_MAX_MISS_RATIO = 0.8

/**
 * Returns true only for transient DnsBoundaryError codes eligible for bounded retry.
 */
export function isRetryableDnsError(err: unknown): boolean {
  if (!(err instanceof DnsBoundaryError)) {
    return false
  }
  return RETRYABLE_DNS_ERROR_CODES.has(err.code)
}

function readBunDnsCacheStats(): BunDnsCacheStats | null {
  const bunGlobal = (globalThis as unknown as { Bun?: BunDnsGlobalLike }).Bun
  if (bunGlobal?.dns && typeof bunGlobal.dns.getCacheStats === "function") {
    return bunGlobal.dns.getCacheStats()
  }
  return null
}

/**
 * Audits external DNS lookups and Bun.dns cache telemetry for TTL/miss-ratio drift.
 */
export async function auditDnsDrift(
  options: AuditDnsDriftOptions = {},
): Promise<readonly DnsDriftFinding[]> {
  const findings: DnsDriftFinding[] = []
  const hosts = options.externalHosts ?? []
  const family: 4 | 6 = options.family ?? 4
  const backend: DnsResolverBackend = options.backend ?? "c-ares"
  const timeoutMs = options.timeoutMs ?? 2_000
  const minCacheSamples = options.minCacheSamples ?? DEFAULT_MIN_CACHE_SAMPLES
  const maxMissRatio = options.maxMissRatio ?? DEFAULT_MAX_MISS_RATIO

  for (const host of hosts) {
    try {
      const records = await lookupStrictFamily(host, {
        family,
        backend,
        timeoutMs,
      })

      if (backend === "c-ares" && records.length > 0 && records.every((rec) => rec.ttl === 0)) {
        findings.push({
          code: "DRIFT_ZERO_TTL_ON_EXTERNAL",
          host,
          detail: `c-ares returned ttl=0 for all ${records.length} record(s) on "${host}"`,
        })
      }
    } catch (err) {
      findings.push({
        code: "DRIFT_LOOKUP_FAILED",
        host,
        detail: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const stats = readBunDnsCacheStats()
  if (stats) {
    const misses = stats.cacheMissesCompleted ?? stats.cacheMisses ?? 0
    const total = stats.totalCount ?? 0
    if (total >= minCacheSamples && total > 0) {
      const missRatio = misses / total
      if (missRatio > maxMissRatio) {
        const pct = (missRatio * 100).toFixed(1)
        findings.push({
          code: "DRIFT_CACHE_HIGH_MISS_RATIO",
          detail: `Bun.dns cache miss ratio is ${pct}% (${misses}/${total}, threshold > ${(maxMissRatio * 100).toFixed(0)}%)`,
        })
      }
    }
  }

  return findings
}
