/**
 * @file lib/bun_dns.ts
 * @description Node.js DNS telemetry & reverse IP forensics adapter (replaces Bun native dns module).
 */

export type DnsResolverBackend = "c-ares" | "system" | "getaddrinfo" | "libc"

export const BUN_DNS_CACHE_CAPACITY = 256 as const

export interface HostTarget {
  readonly hostname: string
  readonly port: number
  readonly serviceName: string
}

export const SPORTSDESK_CORE_HOSTS: readonly HostTarget[] = [
  {
    hostname: "fantasy402.com",
    port: 443,
    serviceName: "Fantasy402 Manager Portal",
  },
  {
    hostname: "pub-d061f943df0e4477ba7ff200721eddb1.r2.dev",
    port: 443,
    serviceName: "Cloudflare R2 Public Gateway",
  },
  {
    hostname: "api.telegram.org",
    port: 443,
    serviceName: "Telegram Bot API (@demodevdeskbot)",
  },
  {
    hostname: "desk.bookdeskops.com",
    port: 443,
    serviceName: "SportsDesk VPS & Manager Desk",
  },
  {
    hostname: "clob.polymarket.com",
    port: 443,
    serviceName: "Polymarket CLOB Trading API",
  },
  {
    hostname: "gamma-api.polymarket.com",
    port: 443,
    serviceName: "Polymarket Gamma Markets API",
  },
] as const

export interface ReverseDnsClassification {
  readonly ipAddress: string
  readonly hostnames: readonly string[]
  readonly primaryHostname: string | null
  readonly isDatacenterOrCloud: boolean
  readonly isVpnOrProxySuspicious: boolean
  readonly organization: string
}
