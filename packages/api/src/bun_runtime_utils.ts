/**
 * Native Bun 1.4.4 Runtime Utilities (`bun.com/docs/runtime/utils.md`) wired for SportsDesk Ops hot
 * paths with portable Node.js 22 fallbacks:
 *
 * - Zstd / Gzip / Deflate compression & HTTP `Accept-Encoding` negotiation
 * - SIMD `Bun.stripANSI`, `Bun.sliceAnsi`, `Bun.stringWidth`, `Bun.wrapAnsi`
 * - SIMD `Bun.indexOfLine` byte-level line scanning (NDJSON / AccessLog ingest)
 * - Zero-microtask `Bun.peek` & `Bun.peek.status`
 * - `Bun.deepMatch` subset predicate matching
 * - Deterministic `Bun.randomUUIDv5` namespace UUIDs
 * - `Bun.readableStreamTo*` stream consumers
 *
 * @file Packages/api/src/bun_runtime_utils.ts
 */

import { createHash } from "node:crypto"
import { gunzipSync as nodeGunzipSync, gzipSync as nodeGzipSync } from "node:zlib"

/** Deterministic RFC 4122 URL namespace for SportsDesk Ops idempotency & dedup keys. */
export const SPORTSDESK_UUID_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8" as const

type BunPeekFn = (<T>(promise: Promise<T> | T) => T | Promise<T>) & {
  readonly status?: (promise: Promise<unknown>) => "fulfilled" | "pending" | "rejected"
}

interface BunUtilsRuntime {
  readonly zstdCompressSync?: (
    data: Uint8Array,
    options?: { readonly level?: number },
  ) => Uint8Array
  readonly zstdDecompressSync?: (data: Uint8Array) => Uint8Array
  readonly zstdCompress?: (
    data: Uint8Array,
    options?: { readonly level?: number },
  ) => Promise<Uint8Array>
  readonly zstdDecompress?: (data: Uint8Array) => Promise<Uint8Array>
  readonly gzipSync?: (data: Uint8Array) => Uint8Array
  readonly gunzipSync?: (data: Uint8Array) => Uint8Array
  readonly stripANSI?: (input: string) => string
  readonly sliceAnsi?: (input: string, start: number, end?: number) => string
  readonly stringWidth?: (
    input: string,
    options?: { readonly countAnsiEscapeCodes?: boolean; readonly ambiguousIsNarrow?: boolean },
  ) => number
  readonly wrapAnsi?: (input: string, columns: number) => string
  readonly indexOfLine?: (buffer: Uint8Array, offset?: number) => number
  readonly peek?: BunPeekFn
  readonly deepMatch?: (subset: unknown, target: unknown) => boolean
  readonly randomUUIDv5?: (
    name: string | Uint8Array,
    namespace: string | Uint8Array,
    encoding?: "hex",
  ) => string
  readonly readableStreamToText?: (stream: ReadableStream) => Promise<string>
  readonly readableStreamToJSON?: (stream: ReadableStream) => Promise<unknown>
  readonly readableStreamToBytes?: (stream: ReadableStream) => Promise<Uint8Array>
  readonly readableStreamToArrayBuffer?: (stream: ReadableStream) => Promise<ArrayBuffer>
  readonly readableStreamToBlob?: (stream: ReadableStream) => Promise<Blob>
  readonly readableStreamToArray?: <T = unknown>(stream: ReadableStream<T>) => Promise<T[]>
}

function getBunUtils(): BunUtilsRuntime | undefined {
  return (globalThis as unknown as { readonly Bun?: BunUtilsRuntime }).Bun
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// ---------------------------------------------------------------------------
// 1. Zstd / Gzip Compression & HTTP Content-Encoding Negotiation
// ---------------------------------------------------------------------------

export function hasNativeZstd(): boolean {
  const bun = getBunUtils()
  return (
    typeof bun?.zstdCompressSync === "function" && typeof bun?.zstdDecompressSync === "function"
  )
}

export function zstdCompressBytes(input: Uint8Array | string, level?: number): Uint8Array | null {
  const bun = getBunUtils()
  if (typeof bun?.zstdCompressSync !== "function") return null
  const raw = typeof input === "string" ? textEncoder.encode(input) : input
  return level !== undefined ? bun.zstdCompressSync(raw, { level }) : bun.zstdCompressSync(raw)
}

export function zstdDecompressBytes(compressed: Uint8Array): Uint8Array | null {
  const bun = getBunUtils()
  if (typeof bun?.zstdDecompressSync !== "function") return null
  return bun.zstdDecompressSync(compressed)
}

export async function zstdCompressAsync(
  input: Uint8Array | string,
  level?: number,
): Promise<Uint8Array | null> {
  const bun = getBunUtils()
  const raw = typeof input === "string" ? textEncoder.encode(input) : input
  if (typeof bun?.zstdCompress === "function") {
    return level !== undefined ? bun.zstdCompress(raw, { level }) : bun.zstdCompress(raw)
  }
  return zstdCompressBytes(raw, level)
}

export async function zstdDecompressAsync(compressed: Uint8Array): Promise<Uint8Array | null> {
  const bun = getBunUtils()
  if (typeof bun?.zstdDecompress === "function") {
    return bun.zstdDecompress(compressed)
  }
  return zstdDecompressBytes(compressed)
}

export function gzipCompressBytes(input: Uint8Array | string): Uint8Array {
  const raw = typeof input === "string" ? textEncoder.encode(input) : input
  const bun = getBunUtils()
  if (typeof bun?.gzipSync === "function") {
    return bun.gzipSync(raw)
  }
  return new Uint8Array(nodeGzipSync(raw))
}

export function gzipDecompressBytes(compressed: Uint8Array): Uint8Array {
  const bun = getBunUtils()
  if (typeof bun?.gunzipSync === "function") {
    return bun.gunzipSync(compressed)
  }
  return new Uint8Array(nodeGunzipSync(compressed))
}

export type NegotiatedEncoding = "zstd" | "gzip" | "identity"

/**
 * Negotiate best supported HTTP response encoding from `Accept-Encoding`. Prefers native `zstd`
 * (Bun 1.4.4) over `gzip`, falling back to `identity`.
 */
export function negotiateResponseEncoding(acceptEncoding: string | null): NegotiatedEncoding {
  if (!acceptEncoding) return "identity"
  const tokens = acceptEncoding
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [enc, ...params] = part.trim().split(";")
      const qParam = params.find((p) => p.trim().startsWith("q="))
      const q = qParam ? Number(qParam.trim().slice(2)) : 1
      return { enc: (enc ?? "").trim(), q: Number.isFinite(q) ? q : 0 }
    })
    .filter((t) => t.enc !== "" && t.q > 0)

  const zstdEntry = tokens.find((t) => t.enc === "zstd")
  const gzipEntry = tokens.find((t) => t.enc === "gzip")
  if (zstdEntry && hasNativeZstd() && (!gzipEntry || zstdEntry.q >= gzipEntry.q)) {
    return "zstd"
  }
  if (gzipEntry) {
    return "gzip"
  }
  return "identity"
}

export const MIN_COMPRESS_BYTES = 1024

export function compressResponsePayload(
  bytes: Uint8Array,
  acceptEncoding: string | null,
  minBytes = MIN_COMPRESS_BYTES,
): { readonly body: Uint8Array; readonly encoding: NegotiatedEncoding } {
  if (bytes.byteLength < minBytes) {
    return { body: bytes, encoding: "identity" }
  }
  const chosen = negotiateResponseEncoding(acceptEncoding)
  if (chosen === "zstd") {
    const zst = zstdCompressBytes(bytes)
    if (zst && zst.byteLength < bytes.byteLength) {
      return { body: zst, encoding: "zstd" }
    }
  }
  if (chosen === "gzip") {
    const gz = gzipCompressBytes(bytes)
    if (gz.byteLength < bytes.byteLength) {
      return { body: gz, encoding: "gzip" }
    }
  }
  return { body: bytes, encoding: "identity" }
}

// ---------------------------------------------------------------------------
// 2. SIMD ANSI String Utilities (`stripANSI`, `sliceAnsi`, `stringWidth`, `wrapAnsi`)
// ---------------------------------------------------------------------------

const ANSI_FALLBACK_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g

export function stripAnsiNative(input: string): string {
  const bun = getBunUtils()
  if (typeof bun?.stripANSI === "function") {
    return bun.stripANSI(input)
  }
  return input.replace(ANSI_FALLBACK_RE, "")
}

export function stringWidthNative(input: string): number {
  const bun = getBunUtils()
  if (typeof bun?.stringWidth === "function") {
    return bun.stringWidth(input, { ambiguousIsNarrow: true, countAnsiEscapeCodes: false })
  }
  return Array.from(stripAnsiNative(input)).length
}

export function sliceAnsiNative(input: string, start: number, end?: number): string {
  const bun = getBunUtils()
  if (typeof bun?.sliceAnsi === "function") {
    return end === undefined ? bun.sliceAnsi(input, start) : bun.sliceAnsi(input, start, end)
  }
  const plain = stripAnsiNative(input)
  return Array.from(plain).slice(start, end).join("")
}

export function wrapAnsiNative(input: string, columns: number): string {
  const bun = getBunUtils()
  if (typeof bun?.wrapAnsi === "function") {
    return bun.wrapAnsi(input, columns)
  }
  return input
}

// ---------------------------------------------------------------------------
// 3. SIMD Byte Line Scanning (`Bun.indexOfLine`)
// ---------------------------------------------------------------------------

/**
 * Find the next newline byte offset (`0x0a`) in a byte buffer starting at `offset`, using native
 * SIMD `Bun.indexOfLine` when available. Returns `-1` if no newline remains.
 */
export function indexOfLineNative(buffer: Uint8Array, offset = 0): number {
  const start = Math.max(0, Math.trunc(offset))
  if (start >= buffer.byteLength) return -1
  const bun = getBunUtils()
  if (typeof bun?.indexOfLine === "function") {
    return bun.indexOfLine(buffer, start)
  }
  return buffer.indexOf(0x0a, start)
}

/**
 * Split a UTF-8 byte buffer into trimmed non-empty lines using SIMD `Bun.indexOfLine`, avoiding
 * full-buffer UTF-16 `.split("\n")` allocations on large AccessLog / NDJSON inputs.
 */
export function splitByteLines(buffer: Uint8Array, maxLines = 100_000): string[] {
  const lines: string[] = []
  let offset = 0
  const len = buffer.byteLength
  while (offset < len && lines.length < maxLines) {
    const nl = indexOfLineNative(buffer, offset)
    const end = nl === -1 ? len : nl
    const sliceEnd = end > offset && buffer[end - 1] === 0x0d ? end - 1 : end
    if (sliceEnd > offset) {
      lines.push(textDecoder.decode(buffer.subarray(offset, sliceEnd)))
    }
    if (nl === -1) break
    offset = nl + 1
  }
  return lines
}

// ---------------------------------------------------------------------------
// 4. Zero-Microtask Promise Inspection (`Bun.peek` / `Bun.peek.status`)
// ---------------------------------------------------------------------------

export function peekPromiseStatus(
  promise: Promise<unknown>,
): "fulfilled" | "pending" | "rejected" | "unknown" {
  const statusFn = getBunUtils()?.peek?.status
  if (typeof statusFn === "function") {
    return statusFn(promise)
  }
  return "unknown"
}

/**
 * Synchronously return the resolved value of an already-fulfilled Promise via `Bun.peek()` without
 * scheduling a microtask, or `undefined` if pending/rejected/unavailable.
 */
export function peekFulfilledValue<T>(
  promise: Promise<T>,
): { readonly settled: true; readonly value: T } | { readonly settled: false } {
  const peek = getBunUtils()?.peek
  if (typeof peek !== "function") {
    return { settled: false }
  }
  const status = typeof peek.status === "function" ? peek.status(promise) : "unknown"
  if (status === "fulfilled") {
    return { settled: true, value: peek(promise) as T }
  }
  if (status === "unknown") {
    const maybe = peek(promise)
    if (maybe !== promise) {
      return { settled: true, value: maybe as T }
    }
  }
  return { settled: false }
}

// ---------------------------------------------------------------------------
// 5. Subset Structural Matching (`Bun.deepMatch`)
// ---------------------------------------------------------------------------

/**
 * Returns `true` when every property in `subset` exists on `target` with deeply equal values,
 * delegating to native `Bun.deepMatch(subset, target)` under Bun.
 */
export function deepMatchNative(subset: unknown, target: unknown): boolean {
  const bun = getBunUtils()
  if (typeof bun?.deepMatch === "function") {
    try {
      return bun.deepMatch(subset, target)
    } catch {
      // fall through for primitive edge cases
    }
  }
  if (Object.is(subset, target)) return true
  if (
    typeof subset !== "object" ||
    subset === null ||
    typeof target !== "object" ||
    target === null
  ) {
    return false
  }
  if (Array.isArray(subset)) {
    if (!Array.isArray(target) || subset.length > target.length) return false
    for (let i = 0; i < subset.length; i += 1) {
      if (!deepMatchNative(subset[i], target[i])) return false
    }
    return true
  }
  const subRec = subset as Record<string, unknown>
  const tgtRec = target as Record<string, unknown>
  for (const key of Object.keys(subRec)) {
    if (!Object.prototype.hasOwnProperty.call(tgtRec, key)) return false
    if (!deepMatchNative(subRec[key], tgtRec[key])) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 6. Deterministic UUIDv5 (`Bun.randomUUIDv5`)
// ---------------------------------------------------------------------------

function uuidHexToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "")
  if (!/^[0-9a-f]{32}$/i.test(hex)) {
    throw new TypeError(`Invalid UUID namespace: ${uuid}`)
  }
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

/**
 * Generate a deterministic RFC 4122 UUIDv5 via native `Bun.randomUUIDv5(name, namespace)` (or SHA-1
 * RFC 4122 fallback under Node.js). Ideal for idempotent alert/archive keys.
 */
export function randomUuidV5(name: string, namespace: string = SPORTSDESK_UUID_NAMESPACE): string {
  const bun = getBunUtils()
  if (typeof bun?.randomUUIDv5 === "function") {
    return bun.randomUUIDv5(name, namespace)
  }
  const nsBytes = uuidHexToBytes(namespace)
  const nameBytes = textEncoder.encode(name)
  const digest = createHash("sha1").update(nsBytes).update(nameBytes).digest()
  const bytes = new Uint8Array(digest.subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// ---------------------------------------------------------------------------
// 7. Fast One-Call ReadableStream Consumers (`Bun.readableStreamTo*`)
// ---------------------------------------------------------------------------

export async function streamToText(stream: ReadableStream): Promise<string> {
  const fn = getBunUtils()?.readableStreamToText
  if (typeof fn === "function") return fn(stream)
  return new Response(stream).text()
}

export async function streamToJSON<T = unknown>(stream: ReadableStream): Promise<T> {
  const fn = getBunUtils()?.readableStreamToJSON
  if (typeof fn === "function") return (await fn(stream)) as T
  return (await new Response(stream).json()) as T
}

export async function streamToBytes(stream: ReadableStream): Promise<Uint8Array> {
  const fn = getBunUtils()?.readableStreamToBytes
  if (typeof fn === "function") return fn(stream)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function streamToArrayBuffer(stream: ReadableStream): Promise<ArrayBuffer> {
  const fn = getBunUtils()?.readableStreamToArrayBuffer
  if (typeof fn === "function") return fn(stream)
  return new Response(stream).arrayBuffer()
}

export async function streamToBlob(stream: ReadableStream): Promise<Blob> {
  const fn = getBunUtils()?.readableStreamToBlob
  if (typeof fn === "function") return fn(stream)
  return new Response(stream).blob()
}

export async function streamToArray<T = unknown>(stream: ReadableStream<T>): Promise<T[]> {
  const fn = getBunUtils()?.readableStreamToArray
  if (typeof fn === "function") return fn(stream)
  const out: T[] = []
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return out
}
