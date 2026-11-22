/**
 * @file src/lib/dns_boundary.ts
 * @description L1 boundary module for strict hostname validation and IP-family-enforced Bun.dns lookups.
 */

import { lookup as nodeDnsLookup } from "node:dns/promises"
import { isIP, isIPv4, isIPv6 } from "node:net"

import type { DnsResolverBackend } from "../../lib/bun_dns.ts"

export type { DnsResolverBackend }

export type DnsErrorCode =
  | "ERR_DNS_INVALID_HOSTNAME"
  | "ERR_DNS_IPV6_ZONE_FORBIDDEN"
  | "ERR_DNS_LOOKUP_FAILED"
  | "ERR_DNS_TIMEOUT"
  | "ERR_DNS_FAMILY_MISMATCH"
  | "ERR_DNS_EMPTY_RESULT"

export type DnsBoundaryErrorCode = DnsErrorCode

export class DnsBoundaryError extends Error {
  readonly code: DnsBoundaryErrorCode
  override readonly cause?: unknown

  constructor(code: DnsBoundaryErrorCode, message: string, cause?: unknown) {
    super(message.includes(code) ? message : `${code}: ${message}`)
    this.name = "DnsBoundaryError"
    this.code = code
    if (cause !== undefined) {
      this.cause = cause
    }
  }
}

export interface DnsLookupRecord {
  readonly address: string
  readonly family: 4 | 6
  readonly ttl: number
}

export interface LookupStrictFamilyOptions {
  readonly family?: 4 | 6
  readonly backend?: DnsResolverBackend
  readonly timeoutMs?: number
}

interface BunDnsLookupOptions {
  readonly family?: 0 | 4 | 6 | "IPv4" | "IPv6" | "any"
  readonly backend?: DnsResolverBackend
}

interface BunGlobalLike {
  readonly dns?: {
    lookup(hostname: string, options?: BunDnsLookupOptions): Promise<readonly DnsLookupRecord[]>
  }
}

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000

/**
 * Validates and normalizes a bare hostname or literal IP (no schemes, ports, brackets, or IPv6 zone IDs).
 */
export function assertCleanHostname(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new DnsBoundaryError("ERR_DNS_INVALID_HOSTNAME", "Hostname must be a non-empty string.")
  }

  // Reject whitespace and ASCII control characters
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Hostname contains invalid whitespace or control characters: ${JSON.stringify(raw)}`,
    )
  }

  // Reject URLs, paths, queries, fragments, and userinfo
  if (
    raw.includes("://") ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes("?") ||
    raw.includes("#") ||
    raw.includes("@")
  ) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Hostname must not contain schemes, paths, or URL delimiters: ${raw}`,
    )
  }

  // Reject bracketed IPv6 literals like [::1]
  if (raw.includes("[") || raw.includes("]")) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Bracketed hostnames are forbidden: ${raw}`,
    )
  }

  // Reject IPv6 zone IDs (both literal % and percent-encoded %25)
  if (raw.includes("%")) {
    throw new DnsBoundaryError(
      "ERR_DNS_IPV6_ZONE_FORBIDDEN",
      `IPv6 zone identifiers are forbidden in hostnames: ${raw}`,
    )
  }

  const lower = raw.toLowerCase()

  // Handle IPv6 literals vs host:port rejections
  if (lower.includes(":")) {
    if (isIPv6(lower)) {
      return lower
    }
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Hostname contains a port or invalid IPv6 literal: ${raw}`,
    )
  }

  // Strip at most one trailing DNS root dot
  if (lower.endsWith("..")) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Hostname contains trailing empty labels: ${raw}`,
    )
  }

  const normalized = lower.endsWith(".") ? lower.slice(0, -1) : lower

  if (normalized.length === 0 || normalized.length > 253) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Hostname length out of bounds (1..253): ${raw}`,
    )
  }

  // All-numeric dotted strings must strictly parse as IPv4 (rejects e.g. 999.0.0.1)
  if (/^[0-9.]+$/.test(normalized)) {
    if (isIPv4(normalized)) {
      return normalized
    }
    throw new DnsBoundaryError("ERR_DNS_INVALID_HOSTNAME", `Invalid numeric IPv4 literal: ${raw}`)
  }

  const labels = normalized.split(".")
  for (const label of labels) {
    if (!DNS_LABEL_RE.test(label)) {
      throw new DnsBoundaryError(
        "ERR_DNS_INVALID_HOSTNAME",
        `Invalid DNS label "${label}" in hostname: ${raw}`,
      )
    }
  }

  // Multi-label domain TLD cannot be purely numeric
  const tld = labels[labels.length - 1]
  if (labels.length > 1 && /^\d+$/.test(tld)) {
    throw new DnsBoundaryError(
      "ERR_DNS_INVALID_HOSTNAME",
      `Numeric TLD is forbidden in hostname: ${raw}`,
    )
  }

  return normalized
}

async function resolveWithAdapter(
  cleanHost: string,
  family: 4 | 6,
  backend: DnsResolverBackend,
): Promise<readonly DnsLookupRecord[]> {
  const bunGlobal = (globalThis as unknown as { Bun?: BunGlobalLike }).Bun
  if (bunGlobal?.dns && typeof bunGlobal.dns.lookup === "function") {
    return bunGlobal.dns.lookup(cleanHost, { family, backend })
  }

  const results = await nodeDnsLookup(cleanHost, {
    family,
    all: true,
    verbatim: true,
  })

  return results.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
    ttl: 0,
  }))
}

/**
 * Resolves a validated hostname strictly enforcing the requested IP family (4 or 6) and timeout.
 */
export async function lookupStrictFamily(
  hostname: string,
  options: LookupStrictFamilyOptions = {},
): Promise<readonly DnsLookupRecord[]> {
  const cleanHost = assertCleanHostname(hostname)
  const family: 4 | 6 = options.family ?? 4

  if (family !== 4 && family !== 6) {
    throw new DnsBoundaryError(
      "ERR_DNS_FAMILY_MISMATCH",
      `Unsupported IP family ${String(family)}; expected 4 or 6.`,
    )
  }

  const literalFamily = isIP(cleanHost)
  if (literalFamily !== 0 && literalFamily !== family) {
    throw new DnsBoundaryError(
      "ERR_DNS_FAMILY_MISMATCH",
      `Literal IP "${cleanHost}" is IPv${literalFamily}, but IPv${family} was requested.`,
    )
  }

  const backend: DnsResolverBackend = options.backend ?? "system"
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new DnsBoundaryError(
      "ERR_DNS_TIMEOUT",
      `Lookup timeoutMs must be a positive finite number, received ${timeoutMs}.`,
    )
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined

  const lookupPromise = resolveWithAdapter(cleanHost, family, backend).catch((err: unknown) => {
    if (err instanceof DnsBoundaryError) {
      throw err
    }
    throw new DnsBoundaryError(
      "ERR_DNS_LOOKUP_FAILED",
      `DNS lookup failed for "${cleanHost}" (family=${family}, backend=${backend})`,
      err,
    )
  })

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(
        new DnsBoundaryError(
          "ERR_DNS_TIMEOUT",
          `DNS lookup for "${cleanHost}" timed out after ${timeoutMs}ms`,
        ),
      )
    }, timeoutMs)
  })

  let records: readonly DnsLookupRecord[]
  try {
    records = await Promise.race([lookupPromise, timeoutPromise])
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle)
    }
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new DnsBoundaryError(
      "ERR_DNS_EMPTY_RESULT",
      `DNS lookup for "${cleanHost}" returned zero records.`,
    )
  }

  const validated: DnsLookupRecord[] = []
  for (const rec of records) {
    const addrFamily = isIP(rec.address)
    if (rec.family !== family || addrFamily !== family) {
      throw new DnsBoundaryError(
        "ERR_DNS_FAMILY_MISMATCH",
        `Expected IPv${family} record for "${cleanHost}", got family=${rec.family} address="${rec.address}"`,
      )
    }
    validated.push({
      address: rec.address,
      family,
      ttl: typeof rec.ttl === "number" ? rec.ttl : 0,
    })
  }

  return validated
}
