import { AsyncLocalStorage } from "node:async_hooks"
import { stripVTControlCharacters } from "node:util"
import type { S3Client } from "bun"
import {
  NODE_INSPECT_CUSTOM,
  resolveInspectOptions,
  type BunInspectOptions,
} from "../../server/desk_inspect.ts"
import { hasControlChars, isColorEnabled, stripControls } from "../theme/ansi_tokens.ts"
import { formatKeyValueRows, renderThemedMarkdown } from "../theme/markdown_ansi.ts"

declare const Bun: Pick<typeof import("bun"), "inspect" | "s3" | "S3Client">

const S3_CHECK_TIMEOUT_MS = 5_000
export type InspectRole = "ROLE_VIEWER" | "ROLE_OPS_ADMIN"
const roleStore = new AsyncLocalStorage<InspectRole>()
const SEAL_MARKER = Symbol("sportsdesk.bun.s3.sealed")

export function getInspectRole(): InspectRole {
  return roleStore.getStore() ?? "ROLE_VIEWER"
}

/** Callers establish the scope from trusted authentication or an internal task. */
export function withInspectRole<T>(role: InspectRole, work: () => T): T {
  return roleStore.run(role, work)
}

export function requireR2AdminScope(): void {
  if (getInspectRole() !== "ROLE_OPS_ADMIN") {
    throw new Error("ERR_INSP_ROLE_DENIED: ROLE_OPS_ADMIN required for bucket access")
  }
}

export function isR2ObjectProbeKey(key: string): boolean {
  const bytes = Buffer.byteLength(key)
  return (
    bytes > 0 &&
    bytes <= 1024 &&
    !hasControlChars(key) &&
    !/[\t\n\\]/.test(key) &&
    !key.split("/").some((segment) => segment === "." || segment === "..")
  )
}

export function isR2ObjectPrefix(prefix: string): boolean {
  if (prefix === "") return true
  const bytes = Buffer.byteLength(prefix)
  return (
    bytes <= 1024 &&
    !hasControlChars(prefix) &&
    !/[\t\n\\]/.test(prefix) &&
    !prefix.split("/").some((segment) => segment === "." || segment === "..")
  )
}

export const ALLOWED_S3_STORAGE_CLASSES = [
  "STANDARD",
  "STANDARD_IA",
  "ONEZONE_IA",
  "INTELLIGENT_TIERING",
  "GLACIER",
  "GLACIER_IR",
  "DEEP_ARCHIVE",
  "REDUCED_REDUNDANCY",
  "EXPRESS_ONEZONE",
] as const

export type S3StorageClass = (typeof ALLOWED_S3_STORAGE_CLASSES)[number]

const ALLOWED_S3_STORAGE_CLASS_SET = new Set<string>(ALLOWED_S3_STORAGE_CLASSES)
const MAX_S3_WRITE_BYTES = 5 * 1024 * 1024 // 5 MiB
const MAX_S3_PRESIGN_EXPIRES_SEC = 900
const DEFAULT_S3_PRESIGN_EXPIRES_SEC = 60

export function isAllowedS3StorageClass(value: unknown): value is S3StorageClass {
  return typeof value === "string" && ALLOWED_S3_STORAGE_CLASS_SET.has(value)
}

export function sanitizeContentDispositionFilename(filename: string): string {
  const cleaned = filename
    .replace(/[\r\n"'\\/]/g, "")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, 128)
  return cleaned || "export.bin"
}

const REDACTED_SECRET = "[REDACTED_SECRET]"
const REDACTED_HOST = "[REDACTED_HOST]"
export const AMBIENT_S3_CREDENTIALS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
] as const
export const R2_CREDENTIALS = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_SESSION_TOKEN",
  "CLOUDFLARE_R2_API_TOKEN",
] as const
const SECRET_ENV_NAMES = [
  ...AMBIENT_S3_CREDENTIALS,
  ...R2_CREDENTIALS,
  "CLOUDFLARE_API_TOKEN",
  "F402_AUTH_JWT",
  "GSLIVE_SESSION_ID",
  "DATABASE_URL",
  "SPORTSDESK_DASHBOARD_TOKEN",
  "SPORTSDESK_OPERATOR_PASSWORD",
  "SPORTSDESK_ADMIN_TOKEN",
  "CSRF_SECRET",
] as const
const BEARER_LEAK =
  /\bbearer[ \t]+(?!\[REDACTED_SECRET\]|REDACTED(?=$|[\s"'\],;)}]))[a-z0-9._~+/=-]+/i
const SESSION_COOKIE_LEAK =
  /\b(?:gslive_session_id|sd_session|sd_csrf)[ \t]*=[ \t]*["']?(?!\[REDACTED_SECRET\]|REDACTED(?=$|[\s"'\],;)}]))[^\s"'\],;)}]+/i
const AWS_ACCESS_KEY_LEAK = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
const SIGNED_S3_URL_LEAK = /[?&](?:amp;)?x-amz-(?:credential|signature|security-token)=[^\s"'&]+/i
export function assertNoSecretLeak(surface: string, suppliedSecrets: readonly string[] = []): void {
  const plain = stripControls(stripVTControlCharacters(surface))
  const activeSecrets = [...suppliedSecrets, ...SECRET_ENV_NAMES.map((name) => process.env[name])]
  if (
    activeSecrets.some(
      (secret) => secret && (surface.includes(secret) || plain.includes(secret)),
    ) ||
    BEARER_LEAK.test(plain) ||
    SESSION_COOKIE_LEAK.test(plain) ||
    AWS_ACCESS_KEY_LEAK.test(plain) ||
    SIGNED_S3_URL_LEAK.test(plain)
  ) {
    throw new Error("ERR_INSP_SECRET_REDACTION_LEAK: Redaction check failed")
  }
}

function readGlobalS3Summary() {
  return {
    singleton: "Bun.s3",
    credentials: REDACTED_SECRET,
    policy: "Use an explicit R2 client",
    implicitCredentialsConfigured: AMBIENT_S3_CREDENTIALS.some((name) =>
      Boolean(process.env[name]),
    ),
  }
}

function inspectGlobalS3(_depth?: number, options?: BunInspectOptions) {
  const summary = Bun.inspect(readGlobalS3Summary(), { colors: isColorEnabled(options?.colors) })
  assertNoSecretLeak(summary)
  return summary
}

export function isGlobalBunS3Sealed(): boolean {
  if (typeof Bun === "undefined" || typeof Bun.s3 !== "object" || Bun.s3 === null) return false
  const singleton = Bun.s3
  return (
    Object.isSealed(singleton) &&
    Object.getOwnPropertyDescriptor(singleton, SEAL_MARKER)?.value === true &&
    Object.getOwnPropertyDescriptor(singleton, "toJSON")?.value === readGlobalS3Summary &&
    Object.getOwnPropertyDescriptor(singleton, Bun.inspect.custom)?.value === inspectGlobalS3
  )
}

/** Protect diagnostic output from the implicit client and verify its raw view. */
export function sealGlobalBunS3(): boolean {
  if (typeof Bun === "undefined" || typeof Bun.s3 !== "object" || Bun.s3 === null) return false
  const singleton = Bun.s3
  if (!isGlobalBunS3Sealed()) {
    if (
      !Object.isExtensible(singleton) ||
      Object.getOwnPropertyDescriptor(singleton, "toJSON")?.configurable === false ||
      Object.getOwnPropertyDescriptor(singleton, Bun.inspect.custom)?.configurable === false
    ) {
      throw new Error("ERR_BUN_S3_SEAL_CONFLICT: Bun.s3 diagnostic properties cannot be installed")
    }
    Object.defineProperties(singleton, {
      [SEAL_MARKER]: { value: true },
      toJSON: {
        value: readGlobalS3Summary,
        enumerable: false,
        writable: false,
        configurable: false,
      },
      [Bun.inspect.custom]: {
        value: inspectGlobalS3,
        enumerable: false,
        writable: false,
        configurable: false,
      },
    })
    Object.seal(singleton)
  }

  const inspectOptions = { showHidden: true, depth: Infinity }
  const rawInspectOptions = { ...inspectOptions, customInspect: false }
  assertNoSecretLeak(Bun.inspect(singleton, inspectOptions))
  assertNoSecretLeak(Bun.inspect(singleton, rawInspectOptions))
  assertNoSecretLeak(Bun.inspect(Object.getOwnPropertyDescriptors(singleton), rawInspectOptions))
  assertNoSecretLeak(JSON.stringify(singleton))
  return isGlobalBunS3Sealed()
}

interface R2ClientOptions {
  readonly bucket: string
  readonly endpoint: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string | undefined
}

export type S3ObjectProbe = {
  readonly state:
    | "available"
    | "access-denied"
    | "not-found"
    | "redirect"
    | "service-error"
    | "request-rejected"
    | "unreachable"
    | "timeout"
  readonly httpStatus: number | null
  readonly sizeBytes: number | null
}

export interface S3ObjectStatResult {
  readonly state: "available" | "not-found" | "request-rejected" | "error"
  readonly key: string
  readonly bucket: string
  readonly size: number | null
  readonly etag: string | null
  readonly lastModifiedIso: string | null
  readonly contentType: string | null
}

export interface S3ListObjectsQuery {
  readonly prefix?: string | undefined
  readonly maxKeys?: number | undefined
  readonly startAfter?: string | undefined
  readonly continuationToken?: string | undefined
  readonly delimiter?: string | undefined
}

export interface S3ListedObjectItem {
  readonly key: string
  readonly size: number
  readonly etag: string | null
  readonly lastModifiedIso: string | null
  readonly storageClass: string | null
}

export interface S3ListObjectsSummary {
  readonly bucket: string
  readonly prefix: string
  readonly keyCount: number
  readonly isTruncated: boolean
  readonly nextContinuationToken: string | null
  readonly contents: readonly S3ListedObjectItem[]
  readonly commonPrefixes: readonly string[]
}

export interface S3WriteObjectOptions {
  readonly contentType?: string | undefined
  readonly storageClass?: S3StorageClass | undefined
  readonly requestPayer?: boolean | undefined
}

export interface S3WriteObjectResult {
  readonly bucket: string
  readonly key: string
  readonly bytesWritten: number
  readonly contentType: string
  readonly storageClass: S3StorageClass
}

export interface S3PresignDownloadOptions {
  readonly method?: "GET" | "HEAD" | undefined
  readonly expiresInSec?: number | undefined
  readonly contentType?: string | undefined
  readonly filename?: string | undefined
}

export interface S3PresignedDownloadResult {
  readonly bucket: string
  readonly key: string
  readonly method: "GET" | "HEAD"
  readonly expiresInSec: number
  readonly url: string
}

export class SealedR2Handle {
  readonly #bucket: string
  readonly #endpointHost: string
  readonly #client: S3Client

  constructor(options: R2ClientOptions) {
    const endpoint = URL.parse(options.endpoint)
    if (
      !endpoint ||
      hasControlChars(options.endpoint) ||
      /[\t\n]/.test(options.endpoint) ||
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== "/" ||
      hasControlChars(options.bucket) ||
      /[\t\n]/.test(options.bucket) ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      !options.accessKeyId ||
      !options.secretAccessKey
    ) {
      throw new Error("Invalid explicit R2 client configuration")
    }
    this.#bucket = options.bucket
    this.#endpointHost = endpoint.host
    const suppliedSecrets = [
      options.accessKeyId,
      options.secretAccessKey,
      options.sessionToken ?? "",
    ]
    assertNoSecretLeak(`${this.#bucket}\n${this.#endpointHost}`, suppliedSecrets)
    this.#client = new Bun.S3Client({
      bucket: this.#bucket,
      endpoint: endpoint.origin,
      region: "auto",
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken ?? "",
    })
    // Bun 1.4.4 can fall back to the ambient session token for an empty option.
    // Signing locally proves which credential the client selected without sending it.
    const canary = new URL(
      this.#client.file("credential-selection-canary").presign({
        method: "HEAD",
        expiresIn: 1,
      }),
    )
    if (
      !canary.searchParams.get("X-Amz-Credential")?.startsWith(`${options.accessKeyId}/`) ||
      canary.searchParams.get("X-Amz-Security-Token") !== (options.sessionToken || null)
    ) {
      throw new Error("The explicit R2 client selected an unexpected credential")
    }
    Object.freeze(this)
  }

  file(key: string) {
    requireR2AdminScope()
    return this.#client.file(key)
  }

  async probeObject(key: string): Promise<S3ObjectProbe> {
    requireR2AdminScope()
    if (!isR2ObjectProbeKey(key)) {
      return { state: "request-rejected", httpStatus: null, sizeBytes: null }
    }
    const file = this.#client.file(key)
    const signal = AbortSignal.timeout(S3_CHECK_TIMEOUT_MS)
    try {
      const url = new URL(file.presign({ method: "HEAD", expiresIn: 15 }))
      if (
        url.protocol !== "https:" ||
        url.host !== this.#endpointHost ||
        decodeURIComponent(url.pathname) !== `/${this.#bucket}/${key}`
      ) {
        return { state: "request-rejected", httpStatus: null, sizeBytes: null }
      }
      const requestOptions = {
        method: "HEAD",
        redirect: "manual",
        signal,
        proxy: false,
        verbose: false,
      } satisfies RequestInit & { proxy: false; verbose: false }
      const response = await fetch(url, requestOptions)
      const status = response.status
      if (status === 200) {
        const length = response.headers.get("content-length")
        const size = length && /^\d+$/.test(length) ? Number(length) : NaN
        return {
          state: "available",
          httpStatus: status,
          sizeBytes: Number.isSafeInteger(size) ? size : null,
        }
      }
      if (status === 401 || status === 403) {
        return { state: "access-denied", httpStatus: status, sizeBytes: null }
      }
      if (status === 404) return { state: "not-found", httpStatus: status, sizeBytes: null }
      if (status >= 500) return { state: "service-error", httpStatus: status, sizeBytes: null }
      if (status >= 300 && status < 400) {
        return { state: "redirect", httpStatus: status, sizeBytes: null }
      }
      return { state: "request-rejected", httpStatus: status, sizeBytes: null }
    } catch {
      return {
        state: signal.aborted ? "timeout" : "unreachable",
        httpStatus: null,
        sizeBytes: null,
      }
    }
  }

  /**
   * Native Bun `S3Client.prototype.stat()` wrapper with strict key validation
   * and optional Requester Pays (`requestPayer: true`) support.
   */
  async statObject(
    key: string,
    options?: { readonly requestPayer?: boolean | undefined },
  ): Promise<S3ObjectStatResult> {
    requireR2AdminScope()
    if (!isR2ObjectProbeKey(key)) {
      return {
        state: "request-rejected",
        key,
        bucket: this.#bucket,
        size: null,
        etag: null,
        lastModifiedIso: null,
        contentType: null,
      }
    }
    try {
      const statOpts =
        options?.requestPayer === true
          ? ({ requestPayer: true } as unknown as Parameters<S3Client["stat"]>[1])
          : undefined
      const stats = await this.#client.stat(key, statOpts)
      const result: S3ObjectStatResult = {
        state: "available",
        key,
        bucket: this.#bucket,
        size: typeof stats.size === "number" && Number.isFinite(stats.size) ? stats.size : null,
        etag: typeof stats.etag === "string" ? stats.etag : null,
        lastModifiedIso:
          stats.lastModified instanceof Date && Number.isFinite(stats.lastModified.getTime())
            ? stats.lastModified.toISOString()
            : null,
        contentType: typeof stats.type === "string" ? stats.type : null,
      }
      assertNoSecretLeak(JSON.stringify(result))
      return result
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? String((err as { code?: unknown }).code ?? "")
          : ""
      const isNotFound = code === "NoSuchKey" || code === "404" || code === "ENOENT"
      return {
        state: isNotFound ? "not-found" : "error",
        key,
        bucket: this.#bucket,
        size: null,
        etag: null,
        lastModifiedIso: null,
        contentType: null,
      }
    }
  }

  /**
   * Native Bun `S3Client.prototype.list()` wrapper (ListObjectsV2) with strict
   * prefix validation and bounded page sizes.
   */
  async listObjects(query: S3ListObjectsQuery = {}): Promise<S3ListObjectsSummary> {
    requireR2AdminScope()
    const prefix = query.prefix ?? ""
    if (!isR2ObjectPrefix(prefix)) {
      throw new Error("ERR_S3_INVALID_PREFIX: Invalid object prefix")
    }
    if (query.startAfter !== undefined && !isR2ObjectProbeKey(query.startAfter)) {
      throw new Error("ERR_S3_INVALID_START_AFTER: Invalid startAfter key")
    }
    if (
      query.delimiter !== undefined &&
      (query.delimiter.length > 8 || hasControlChars(query.delimiter))
    ) {
      throw new Error("ERR_S3_INVALID_DELIMITER: Invalid list delimiter")
    }
    const maxKeys = Math.min(200, Math.max(1, Math.trunc(query.maxKeys ?? 50)))

    const response = await this.#client.list({
      prefix: prefix || undefined,
      maxKeys,
      startAfter: query.startAfter,
      continuationToken: query.continuationToken,
      delimiter: query.delimiter,
    })

    const contents: S3ListedObjectItem[] = (response.contents ?? []).map((item) => ({
      key: String(item.key ?? ""),
      size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0,
      etag: typeof item.eTag === "string" ? item.eTag : null,
      lastModifiedIso:
        typeof item.lastModified === "string"
          ? item.lastModified
          : (item.lastModified as unknown) instanceof Date
            ? (item.lastModified as unknown as Date).toISOString()
            : null,
      storageClass: typeof item.storageClass === "string" ? item.storageClass : null,
    }))

    const commonPrefixes: string[] = (response.commonPrefixes ?? [])
      .map((entry) => (typeof entry?.prefix === "string" ? entry.prefix : ""))
      .filter(Boolean)

    const summary: S3ListObjectsSummary = {
      bucket: this.#bucket,
      prefix,
      keyCount: typeof response.keyCount === "number" ? response.keyCount : contents.length,
      isTruncated: Boolean(response.isTruncated),
      nextContinuationToken:
        typeof response.nextContinuationToken === "string" && response.nextContinuationToken
          ? response.nextContinuationToken
          : null,
      contents,
      commonPrefixes,
    }
    assertNoSecretLeak(JSON.stringify(summary))
    return summary
  }

  /**
   * Native Bun `S3Client.prototype.write()` wrapper supporting Bun 1.3/1.4
   * `storageClass`, `type`, and `requestPayer` options with a 5 MiB safety cap.
   */
  async writeObject(
    key: string,
    body: string | Uint8Array,
    options: S3WriteObjectOptions = {},
  ): Promise<S3WriteObjectResult> {
    requireR2AdminScope()
    if (!isR2ObjectProbeKey(key)) {
      throw new Error("ERR_S3_INVALID_KEY: Invalid R2 object key")
    }
    const storageClass: S3StorageClass = options.storageClass ?? "STANDARD"
    if (!isAllowedS3StorageClass(storageClass)) {
      throw new Error("ERR_S3_INVALID_STORAGE_CLASS: Unsupported S3 storage class")
    }
    const byteLength = typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength
    if (byteLength > MAX_S3_WRITE_BYTES) {
      throw new Error("ERR_S3_PAYLOAD_TOO_LARGE: Object payload exceeds 5 MiB limit")
    }
    const contentType = options.contentType?.trim() || "application/octet-stream"
    if (hasControlChars(contentType) || /[\r\n]/.test(contentType)) {
      throw new Error("ERR_S3_INVALID_CONTENT_TYPE: Invalid Content-Type header value")
    }

    const writeOpts = {
      type: contentType,
      storageClass,
      ...(options.requestPayer === true ? { requestPayer: true } : {}),
    } as Parameters<S3Client["write"]>[2]

    const bytesWritten = await this.#client.write(key, body, writeOpts)
    const result: S3WriteObjectResult = {
      bucket: this.#bucket,
      key,
      bytesWritten: typeof bytesWritten === "number" ? bytesWritten : byteLength,
      contentType,
      storageClass,
    }
    assertNoSecretLeak(JSON.stringify(result))
    return result
  }

  /**
   * Native Bun 1.3.7+ `S3File.prototype.presign()` wrapper supporting
   * `response-content-disposition` and `response-content-type` query parameters
   * with strict TTL bounds (1..900s) and endpoint host verification.
   */
  presignDownload(key: string, options: S3PresignDownloadOptions = {}): S3PresignedDownloadResult {
    requireR2AdminScope()
    if (!isR2ObjectProbeKey(key)) {
      throw new Error("ERR_S3_INVALID_KEY: Invalid R2 object key")
    }
    const method: "GET" | "HEAD" = options.method === "HEAD" ? "HEAD" : "GET"
    const expiresInSec = Math.min(
      MAX_S3_PRESIGN_EXPIRES_SEC,
      Math.max(1, Math.trunc(options.expiresInSec ?? DEFAULT_S3_PRESIGN_EXPIRES_SEC)),
    )
    const contentDisposition = options.filename
      ? `attachment; filename="${sanitizeContentDispositionFilename(options.filename)}"`
      : undefined
    const contentType = options.contentType?.trim() || undefined
    if (contentType && (hasControlChars(contentType) || /[\r\n]/.test(contentType))) {
      throw new Error("ERR_S3_INVALID_CONTENT_TYPE: Invalid Content-Type value")
    }

    const presignOpts = {
      method,
      expiresIn: expiresInSec,
      ...(contentType ? { type: contentType } : {}),
      ...(contentDisposition ? { contentDisposition } : {}),
    } as Parameters<ReturnType<S3Client["file"]>["presign"]>[0]

    const signed = this.#client.file(key).presign(presignOpts)
    const parsed = new URL(signed)
    if (
      parsed.protocol !== "https:" ||
      parsed.host !== this.#endpointHost ||
      decodeURIComponent(parsed.pathname) !== `/${this.#bucket}/${key}`
    ) {
      throw new Error("ERR_S3_PRESIGN_TARGET_MISMATCH: Presigned URL target validation failed")
    }

    return {
      bucket: this.#bucket,
      key,
      method,
      expiresInSec,
      url: parsed.toString(),
    }
  }

  toJSON() {
    const result = {
      bucket: this.#bucket,
      endpointHost: getInspectRole() === "ROLE_OPS_ADMIN" ? this.#endpointHost : REDACTED_HOST,
      credentials: REDACTED_SECRET,
      globalS3Sealed: isGlobalBunS3Sealed(),
    }
    assertNoSecretLeak(JSON.stringify(result))
    return result
  }

  [NODE_INSPECT_CUSTOM](depth?: number, options?: BunInspectOptions): string {
    const { colors, breakLength } = resolveInspectOptions(options)
    if (depth !== undefined && depth < 0) {
      const output = `[SealedR2Handle ${this.#bucket}]`
      assertNoSecretLeak(output)
      return output
    }
    const metadata = this.toJSON()
    const fields = [
      ["Role", getInspectRole()],
      ["Bucket", metadata.bucket],
      ["Endpoint host", metadata.endpointHost],
      ["Credentials", metadata.credentials],
      ["Global Bun.s3", metadata.globalS3Sealed ? "Sealed" : "UNSEALED"],
    ] as const
    const heading = renderThemedMarkdown("### SealedR2Handle", {
      colors,
      columns: breakLength,
    }).trimEnd()
    const output = [heading, formatKeyValueRows(fields, { colors, keyWidth: 14 })].join("\n")
    assertNoSecretLeak(output)
    return output
  }
}
