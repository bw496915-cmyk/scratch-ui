import {
  ALLOWED_S3_STORAGE_CLASSES,
  AMBIENT_S3_CREDENTIALS,
  assertNoSecretLeak,
  isAllowedS3StorageClass,
  isGlobalBunS3Sealed,
  isR2ObjectProbeKey,
  R2_CREDENTIALS,
  requireR2AdminScope,
  sealGlobalBunS3,
  SealedR2Handle,
  type S3ObjectProbe,
  type S3StorageClass,
  type S3WriteObjectResult,
} from "../src/s3/sealed_r2_handle.ts"
import { readBunDnsCacheStats } from "./bun_dns.ts"

declare const Bun: Pick<typeof import("bun"), "S3Client" | "version" | "dns">

export const R2_CLIENT_INSPECT_PATH = "/api/r2/client/inspect"
const S3_CHECK_CACHE_MS = 30_000

interface RuntimePreflightOptions {
  readonly allowAwsFallbackEnv?: boolean
  readonly maxDnsErrorRatioBps?: number
}

export function runRuntimePreflightAudit(options: RuntimePreflightOptions = {}) {
  if (typeof Bun === "undefined") return null
  if (typeof Bun.S3Client !== "function" || typeof Bun.dns?.getCacheStats !== "function") {
    throw new Error("ERR_BUN_RUNTIME_BINDINGS: Bun S3 or DNS telemetry is unavailable")
  }
  if (process.env.CLOUDFLARE_API_TOKEN && R2_CREDENTIALS.some((name) => process.env[name])) {
    throw new Error("ERR_CF_TOKEN_BLEED_10000: Separate Cloudflare API and R2 credentials")
  }
  if (!options.allowAwsFallbackEnv && AMBIENT_S3_CREDENTIALS.some((name) => process.env[name])) {
    throw new Error("ERR_CF_TOKEN_BLEED_10000: Implicit AWS and S3 credentials are disabled")
  }

  const sealedGlobalS3 = sealGlobalBunS3()
  const dnsCache = readBunDnsCacheStats()
  const { totalCount, errors } = dnsCache
  const dnsErrorRatioBps = totalCount > 0 ? Math.round((errors / totalCount) * 10_000) : 0
  const maxBps = options.maxDnsErrorRatioBps ?? 500
  if (dnsErrorRatioBps > maxBps) {
    throw new Error(
      `ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE: ${dnsErrorRatioBps} bps exceeds ${maxBps} bps`,
    )
  }
  const report = Object.freeze({
    bunVersion: Bun.version,
    sealedGlobalS3,
    dnsRequestCount: totalCount,
    dnsErrorRatioBps,
    dnsCache,
  })
  assertNoSecretLeak(JSON.stringify(report))
  return report
}

export type R2ClientConfiguration =
  | { readonly state: "configured"; readonly handle: SealedR2Handle }
  | { readonly state: "not-configured" | "incomplete" | "invalid" | "unavailable" }

type R2ProbeMeasurement = S3ObjectProbe & {
  readonly checkedAt: string
  readonly durationMs: number
}

type R2ObjectCheck =
  | {
      readonly state: "client-unavailable" | "key-not-configured" | "invalid-key" | "not-requested"
    }
  | (R2ProbeMeasurement & {
      readonly source: "live" | "cache"
      readonly freshness: "fresh" | "stale"
      readonly ageMs: number
    })

export function createR2ObjectCheck(
  configuration: R2ClientConfiguration,
  key?: string,
  now = () => performance.now(),
) {
  let last: { result: R2ProbeMeasurement; finishedAtMs: number } | undefined
  let pending: Promise<R2ProbeMeasurement> | undefined

  return async (requested: boolean): Promise<R2ObjectCheck> => {
    requireR2AdminScope()
    if (configuration.state !== "configured") return { state: "client-unavailable" }
    if (!key) return { state: "key-not-configured" }
    if (!isR2ObjectProbeKey(key)) return { state: "invalid-key" }
    if (last) {
      const age = now() - last.finishedAtMs
      const fresh = age < S3_CHECK_CACHE_MS
      if (!requested || fresh) {
        return {
          ...last.result,
          source: "cache",
          freshness: fresh ? "fresh" : "stale",
          ageMs: Math.floor(age),
        }
      }
    }
    if (!requested) return { state: "not-requested" }

    if (!pending) {
      const startedAt = now()
      pending = configuration.handle
        .probeObject(key)
        .then((probe) => {
          const finishedAt = now()
          const result = {
            ...probe,
            checkedAt: new Date().toISOString(),
            durationMs: Math.round(finishedAt - startedAt),
          }
          last = { result, finishedAtMs: finishedAt }
          return result
        })
        .finally(() => {
          pending = undefined
        })
    }
    return { ...(await pending), source: "live", freshness: "fresh", ageMs: 0 }
  }
}

export function loadR2ClientConfiguration(): R2ClientConfiguration {
  if (typeof Bun === "undefined") return { state: "unavailable" }
  const bucket = process.env.R2_BUCKET_NAME?.trim()
  const endpoint = process.env.R2_ENDPOINT?.trim()
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim()
  const sessionToken = process.env.R2_SESSION_TOKEN?.trim()
  if (!endpoint && !accessKeyId && !secretAccessKey && !sessionToken)
    return { state: "not-configured" }
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return { state: "incomplete" }
  try {
    return {
      state: "configured",
      handle: new SealedR2Handle({ bucket, endpoint, accessKeyId, secretAccessKey, sessionToken }),
    }
  } catch {
    return { state: "invalid" }
  }
}

export interface BunS3CapabilitiesSnapshot {
  readonly runtime: "bun" | "node"
  readonly bunVersion: string | null
  readonly sealedGlobalS3: boolean
  readonly clientState: R2ClientConfiguration["state"]
  readonly bucket: string | null
  readonly supportedFeatures: readonly string[]
  readonly allowedStorageClasses: readonly S3StorageClass[]
  readonly dnsCache: ReturnType<typeof readBunDnsCacheStats> | null
}

/**
 * Returns a zero-secret snapshot of Bun's native S3Client capabilities,
 * ambient `Bun.s3` seal posture, and DNS cache telemetry.
 */
export function getBunS3Capabilities(
  configuration: R2ClientConfiguration = loadR2ClientConfiguration(),
): BunS3CapabilitiesSnapshot {
  const isBun = typeof Bun !== "undefined" && typeof Bun.S3Client === "function"
  const proto = isBun ? (Bun.S3Client.prototype as unknown as Record<string, unknown>) : null
  const supportedFeatures: string[] = []
  if (proto) {
    for (const method of ["list", "stat", "write", "presign", "exists", "delete", "file"]) {
      if (typeof proto[method] === "function") supportedFeatures.push(method)
    }
    supportedFeatures.push("storageClass", "requestPayer", "contentDisposition")
  }

  const snapshot: BunS3CapabilitiesSnapshot = {
    runtime: isBun ? "bun" : "node",
    bunVersion: isBun ? Bun.version : null,
    sealedGlobalS3: isGlobalBunS3Sealed(),
    clientState: configuration.state,
    bucket: configuration.state === "configured" ? configuration.handle.toJSON().bucket : null,
    supportedFeatures,
    allowedStorageClasses: ALLOWED_S3_STORAGE_CLASSES,
    dnsCache: isBun ? readBunDnsCacheStats() : null,
  }
  assertNoSecretLeak(JSON.stringify(snapshot))
  return snapshot
}

export interface RedactedWebLogArchiveEntryLike {
  readonly id: string
  readonly dateLabel: string
  readonly timeEst: string
  readonly epochMs: number
  readonly ipMeta: {
    readonly ip: string
    readonly family: string
    readonly subnet24: string
  }
  readonly accountId: string
  readonly eventKind: string
  readonly severity: string
  readonly vectorScore: number
  readonly interArrivalSec: number | null
  readonly clusterLabel: string
  readonly ticketId?: string | null | undefined
  readonly ticketNumber?: string | null | undefined
  readonly gameId?: string | null | undefined
  readonly botKey?: { readonly gameId: string } | null | undefined
  readonly deviceMarker: string | null
  readonly apiMarked: boolean
}

export interface RedactedWebLogArchiveSource {
  readonly source: string
  readonly generatedAt: string
  readonly summary: Readonly<Record<string, unknown>>
  readonly entries: readonly RedactedWebLogArchiveEntryLike[]
}

export interface RedactedWebLogsNdjsonPayload {
  readonly ndjson: string
  readonly entryCount: number
  readonly bytes: number
}

/**
 * Serializes already-redacted weblog entries (subnet-redacted IPv4/IPv6 + keyed hash)
 * into deterministic NDJSON verified against secret leakage before R2 archival.
 */
export function buildRedactedWebLogsNdjson(
  result: RedactedWebLogArchiveSource,
  maxEntries = 500,
): RedactedWebLogsNdjsonPayload {
  const capped = result.entries.slice(0, Math.min(2_000, Math.max(1, Math.trunc(maxEntries))))
  const lines: string[] = [
    JSON.stringify({
      recordType: "weblog_archive_header",
      schemaVersion: "1.0",
      source: result.source,
      generatedAt: result.generatedAt,
      entryCount: capped.length,
      summary: result.summary,
    }),
  ]

  for (const entry of capped) {
    lines.push(
      JSON.stringify({
        recordType: "weblog_entry",
        id: entry.id,
        dateLabel: entry.dateLabel,
        timeEst: entry.timeEst,
        epochMs: entry.epochMs,
        ipRedacted: entry.ipMeta.ip,
        ipFamily: entry.ipMeta.family,
        subnet: entry.ipMeta.subnet24,
        accountId: entry.accountId,
        eventKind: entry.eventKind,
        severity: entry.severity,
        vectorScore: entry.vectorScore,
        interArrivalSec: entry.interArrivalSec,
        clusterLabel: entry.clusterLabel,
        ticketId: entry.ticketId ?? entry.ticketNumber ?? null,
        gameId: entry.gameId ?? entry.botKey?.gameId ?? null,
        deviceMarker: entry.deviceMarker,
        apiMarked: entry.apiMarked,
      }),
    )
  }

  const ndjson = `${lines.join("\n")}\n`
  assertNoSecretLeak(ndjson)
  return {
    ndjson,
    entryCount: capped.length,
    bytes: Buffer.byteLength(ndjson, "utf8"),
  }
}

export interface ArchiveWebLogsToR2Options {
  readonly storageClass?: S3StorageClass | undefined
  readonly prefix?: string | undefined
  readonly maxEntries?: number | undefined
  readonly nowEpochMs?: number | undefined
}

export interface ArchiveWebLogsToR2Result extends S3WriteObjectResult {
  readonly archived: true
  readonly entryCount: number
  readonly generatedAt: string
}

/**
 * Archives redacted weblog entries directly to Cloudflare R2 using Bun's native
 * `S3Client` (`SealedR2Handle.writeObject`) with configurable `storageClass`.
 */
export async function archiveWebLogsToR2(
  configuration: R2ClientConfiguration,
  result: RedactedWebLogArchiveSource,
  options: ArchiveWebLogsToR2Options = {},
): Promise<ArchiveWebLogsToR2Result> {
  requireR2AdminScope()
  if (configuration.state !== "configured") {
    throw new Error(`ERR_R2_CLIENT_UNAVAILABLE: R2 S3 client state is ${configuration.state}`)
  }
  const storageClass: S3StorageClass = options.storageClass ?? "STANDARD_IA"
  if (!isAllowedS3StorageClass(storageClass)) {
    throw new Error("ERR_S3_INVALID_STORAGE_CLASS: Unsupported S3 storage class")
  }
  const nowMs = options.nowEpochMs ?? Date.now()
  const daySlug = new Date(nowMs).toISOString().slice(0, 10)
  const rawPrefix = (options.prefix ?? "weblogs/archives").replace(/^\/+|\/+$/g, "")
  if (!rawPrefix.startsWith("weblogs/archives")) {
    throw new Error("ERR_S3_ARCHIVE_PREFIX_DENIED: Archive prefix must stay under weblogs/archives")
  }
  const key = `${rawPrefix}/${daySlug}/weblogs-${nowMs}.ndjson`
  if (!isR2ObjectProbeKey(key)) {
    throw new Error("ERR_S3_INVALID_KEY: Derived archive object key is invalid")
  }

  const payload = buildRedactedWebLogsNdjson(result, options.maxEntries)
  const writeResult = await configuration.handle.writeObject(key, payload.ndjson, {
    contentType: "application/x-ndjson",
    storageClass,
  })
  return {
    ...writeResult,
    archived: true,
    entryCount: payload.entryCount,
    generatedAt: result.generatedAt,
  }
}
