/**
 * Native Bun `Bun.fileURLToPath`, `Bun.pathToFileURL`, `Bun.gzipSync`, `Bun.gunzipSync`,
 * `Bun.deflateSync`, and `Bun.inflateSync` utilities with validated `ZlibCompressionOptions` and
 * seamless `node:url` / `node:zlib` fallback when running under Node.js (`tsx` dev server).
 *
 * @file Lib/bun_url_gzip.ts
 */
import assert from "node:assert/strict"
import { fileURLToPath as nodeFileURLToPath, pathToFileURL as nodePathToFileURL } from "node:url"
import {
  constants as zlibConstants,
  deflateRawSync as nodeDeflateRawSync,
  deflateSync as nodeDeflateSync,
  gunzipSync as nodeGunzipSync,
  gzipSync as nodeGzipSync,
  inflateRawSync as nodeInflateRawSync,
  inflateSync as nodeInflateSync,
} from "node:zlib"

export type ZlibCompressionLevel = -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type ZlibMemLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export type ZlibWindowBits =
  | -9
  | -10
  | -11
  | -12
  | -13
  | -14
  | -15
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 25
  | 26
  | 27
  | 28
  | 29
  | 30
  | 31

export type ZlibCompressionOptions = {
  level?: ZlibCompressionLevel
  memLevel?: ZlibMemLevel
  windowBits?: ZlibWindowBits
  strategy?: number
}

export const ZLIB_STRATEGIES = {
  Z_DEFAULT_STRATEGY: zlibConstants.Z_DEFAULT_STRATEGY,
  Z_FILTERED: zlibConstants.Z_FILTERED,
  Z_HUFFMAN_ONLY: zlibConstants.Z_HUFFMAN_ONLY,
  Z_RLE: zlibConstants.Z_RLE,
  Z_FIXED: zlibConstants.Z_FIXED,
} as const

export type BunUtilityEngine = "bun-native" | "node-fallback"

export interface GzipResultWithMeta {
  readonly bytes: Uint8Array
  readonly engine: BunUtilityEngine
  readonly originalBytes: number
  readonly compressedBytes: number
  readonly savedBytes: number
  readonly ratioPct: number
  readonly durationMs: number
  readonly options: Readonly<ZlibCompressionOptions>
}

interface BunUrlGzipApi {
  readonly fileURLToPath?: (url: string | URL) => string
  readonly pathToFileURL?: (path: string) => URL
  readonly gzipSync?: (data: Uint8Array, options?: ZlibCompressionOptions) => Uint8Array
  readonly gunzipSync?: (data: Uint8Array) => Uint8Array
  readonly deflateSync?: (data: Uint8Array, options?: ZlibCompressionOptions) => Uint8Array
  readonly inflateSync?: (data: Uint8Array) => Uint8Array
}

const VALID_STRATEGIES = new Set<number>([
  ZLIB_STRATEGIES.Z_DEFAULT_STRATEGY,
  ZLIB_STRATEGIES.Z_FILTERED,
  ZLIB_STRATEGIES.Z_HUFFMAN_ONLY,
  ZLIB_STRATEGIES.Z_RLE,
  ZLIB_STRATEGIES.Z_FIXED,
])

const textEncoder = new TextEncoder()

function getBunApi(): BunUrlGzipApi | null {
  const bun = (globalThis as { readonly Bun?: BunUrlGzipApi }).Bun
  return bun && typeof bun === "object" ? bun : null
}

function toUint8Array(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === "string") {
    return textEncoder.encode(data)
  }
  if (data instanceof Uint8Array) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  throw new TypeError("Expected Uint8Array, ArrayBuffer, or string input")
}

function isValidWindowBits(bits: number): boolean {
  if (!Number.isInteger(bits)) {
    return false
  }
  if (bits >= -15 && bits <= -9) {
    return true
  }
  if (bits >= 9 && bits <= 15) {
    return true
  }
  return bits >= 25 && bits <= 31
}

export function validateZlibOptions(
  options?: ZlibCompressionOptions,
): Readonly<ZlibCompressionOptions> {
  if (options === undefined) {
    return {}
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError("ZlibCompressionOptions must be an object")
  }

  const clean: ZlibCompressionOptions = {}
  if (options.level !== undefined) {
    if (!Number.isInteger(options.level) || options.level < -1 || options.level > 9) {
      throw new RangeError(`Invalid zlib level ${String(options.level)}: expected integer in -1..9`)
    }
    clean.level = options.level
  }

  if (options.memLevel !== undefined) {
    if (!Number.isInteger(options.memLevel) || options.memLevel < 1 || options.memLevel > 9) {
      throw new RangeError(
        `Invalid zlib memLevel ${String(options.memLevel)}: expected integer in 1..9`,
      )
    }
    clean.memLevel = options.memLevel
  }

  if (options.windowBits !== undefined) {
    if (!isValidWindowBits(options.windowBits)) {
      throw new RangeError(
        `Invalid zlib windowBits ${String(options.windowBits)}: ` +
          `expected -15..-9, 9..15, or 25..31`,
      )
    }
    clean.windowBits = options.windowBits
  }

  if (options.strategy !== undefined) {
    if (!Number.isInteger(options.strategy) || !VALID_STRATEGIES.has(options.strategy)) {
      throw new RangeError(
        `Invalid zlib strategy ${String(options.strategy)}: ` +
          `expected one of Z_DEFAULT_STRATEGY(0)..Z_FIXED(4)`,
      )
    }
    clean.strategy = options.strategy
  }

  return clean
}

export function bunFileURLToPath(url: string | URL): string {
  const bun = getBunApi()
  if (typeof bun?.fileURLToPath === "function") {
    return bun.fileURLToPath(url)
  }
  return nodeFileURLToPath(url)
}

export function bunPathToFileURL(path: string): URL {
  const bun = getBunApi()
  if (typeof bun?.pathToFileURL === "function") {
    return bun.pathToFileURL(path)
  }
  return nodePathToFileURL(path)
}

function toNodeGzipOptions(options: Readonly<ZlibCompressionOptions>): {
  level?: number
  memLevel?: number
  windowBits?: number
  strategy?: number
} {
  const out: {
    level?: number
    memLevel?: number
    windowBits?: number
    strategy?: number
  } = {}
  if (options.level !== undefined) {
    out.level = options.level
  }
  if (options.memLevel !== undefined) {
    out.memLevel = options.memLevel
  }
  if (options.strategy !== undefined) {
    out.strategy = options.strategy
  }
  if (options.windowBits !== undefined) {
    // node:zlib gzipSync adds +16 internally and requires windowBits in 9..15
    if (options.windowBits >= 25) {
      out.windowBits = options.windowBits - 16
    } else if (options.windowBits >= 9) {
      out.windowBits = options.windowBits
    } else {
      out.windowBits = Math.abs(options.windowBits)
    }
  }
  return out
}

export function bunGzipSync(
  data: Uint8Array | ArrayBuffer | string,
  options?: ZlibCompressionOptions,
): Uint8Array {
  const bytes = toUint8Array(data)
  const validated = validateZlibOptions(options)
  const bun = getBunApi()
  if (typeof bun?.gzipSync === "function") {
    const out = bun.gzipSync(bytes, validated)
    assert(out instanceof Uint8Array, "Bun.gzipSync must return Uint8Array")
    return out
  }
  const buf = nodeGzipSync(bytes, toNodeGzipOptions(validated))
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export function bunGzipSyncWithMeta(
  data: Uint8Array | ArrayBuffer | string,
  options?: ZlibCompressionOptions,
): GzipResultWithMeta {
  const bytes = toUint8Array(data)
  const validated = validateZlibOptions(options)
  const startedAt = performance.now()
  const bun = getBunApi()
  const useNative = typeof bun?.gzipSync === "function"
  const compressed = useNative
    ? bun.gzipSync!(bytes, validated)
    : (() => {
        const buf = nodeGzipSync(bytes, toNodeGzipOptions(validated))
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      })()
  const durationMs = Number((performance.now() - startedAt).toFixed(3))
  const originalBytes = bytes.byteLength
  const compressedBytes = compressed.byteLength
  const savedBytes = originalBytes - compressedBytes
  const ratioPct = originalBytes > 0 ? Number(((savedBytes / originalBytes) * 100).toFixed(2)) : 0

  return {
    bytes: compressed,
    engine: useNative ? "bun-native" : "node-fallback",
    originalBytes,
    compressedBytes,
    savedBytes,
    ratioPct,
    durationMs,
    options: validated,
  }
}

export function bunGunzipSync(data: Uint8Array | ArrayBuffer): Uint8Array {
  const bytes = toUint8Array(data)
  const bun = getBunApi()
  if (typeof bun?.gunzipSync === "function") {
    return bun.gunzipSync(bytes)
  }
  const buf = nodeGunzipSync(bytes)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export function bunDeflateSync(
  data: Uint8Array | ArrayBuffer | string,
  options?: ZlibCompressionOptions,
): Uint8Array {
  const bytes = toUint8Array(data)
  const validated = validateZlibOptions(options)
  const bun = getBunApi()
  if (typeof bun?.deflateSync === "function") {
    return bun.deflateSync(bytes, validated)
  }
  const useZlibHeader =
    validated.windowBits !== undefined && validated.windowBits >= 9 && validated.windowBits <= 15
  const nodeOpts = {
    level: validated.level,
    memLevel: validated.memLevel,
    strategy: validated.strategy,
    windowBits: validated.windowBits !== undefined ? Math.abs(validated.windowBits) : undefined,
  }
  const buf = useZlibHeader ? nodeDeflateSync(bytes, nodeOpts) : nodeDeflateRawSync(bytes, nodeOpts)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export function bunInflateSync(
  data: Uint8Array | ArrayBuffer,
  options?: { readonly zlibHeader?: boolean },
): Uint8Array {
  const bytes = toUint8Array(data)
  if (options?.zlibHeader) {
    const buf = nodeInflateSync(bytes)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  const bun = getBunApi()
  if (typeof bun?.inflateSync === "function") {
    return bun.inflateSync(bytes)
  }
  const buf = nodeInflateRawSync(bytes)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

export function getBunUrlGzipEngine(): BunUtilityEngine {
  const bun = getBunApi()
  if (
    typeof bun?.fileURLToPath === "function" &&
    typeof bun?.pathToFileURL === "function" &&
    typeof bun?.gzipSync === "function"
  ) {
    return "bun-native"
  }
  return "node-fallback"
}
