/**
 * @file lib/binary.ts
 * @description Unified binary helpers (`toBytes`, `peekBytes`, `sha256Hex`, `crc32Of`,
 * `crc32Bytes`, `concatBytes`) over `BinaryInput`, preferring native Bun 1.4.4 fast paths
 * (`Bun.hash.crc32`, `Bun.CryptoHasher`, `Bun.concatArrayBuffers`) with portable Node/Web fallbacks.
 */
import { createHash } from "node:crypto"

export type BinaryInput =
  | Uint8Array
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | Response
  | string

interface BunBinaryRuntime {
  readonly hash?: {
    readonly crc32?: (input: Uint8Array | ArrayBuffer | string) => number
  }
  readonly CryptoHasher?: new (algorithm: string) => {
    update(data: Uint8Array | string): unknown
    digest(encoding: "hex"): string
  }
  readonly concatArrayBuffers?: (parts: Uint8Array[]) => ArrayBuffer
}

const textEncoder = new TextEncoder()

function getBunRuntime(): BunBinaryRuntime | undefined {
  return (globalThis as unknown as { readonly Bun?: BunBinaryRuntime }).Bun
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

/**
 * Synchronous IEEE 802.3 CRC-32 over raw bytes (used by PNG `iTXt` chunk emission).
 * Delegates to native `Bun.hash.crc32` when running under Bun, with a table fallback on Node.js.
 */
export function crc32Bytes(bytes: Uint8Array): number {
  const nativeCrc32 = getBunRuntime()?.hash?.crc32
  if (typeof nativeCrc32 === "function") {
    return nativeCrc32(bytes) >>> 0
  }
  let c = 0xffffffff
  for (let i = 0; i < bytes.byteLength; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Synchronous SHA-256 lowercase hex digest over raw bytes.
 */
export function sha256HexBytes(bytes: Uint8Array): string {
  const CryptoHasher = getBunRuntime()?.CryptoHasher
  if (typeof CryptoHasher === "function") {
    const hasher = new CryptoHasher("sha256")
    hasher.update(bytes)
    return hasher.digest("hex")
  }
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Concatenates byte chunks using native `Bun.concatArrayBuffers` when available,
 * falling back to a single-allocation `Uint8Array` copy on Node.js.
 */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0)
  if (parts.length === 1) return parts[0]!
  const nativeConcat = getBunRuntime()?.concatArrayBuffers
  if (typeof nativeConcat === "function") {
    return new Uint8Array(nativeConcat([...parts]))
  }
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/**
 * Normalizes any `BinaryInput` (`Uint8Array`, `Buffer`, `ArrayBuffer`, `ArrayBufferView`,
 * `Blob`/`BunFile`, `Response`, or UTF-8 `string`) into a `Uint8Array`.
 */
export async function toBytes(input: BinaryInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    return input
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input)
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  if (typeof input === "string") {
    return textEncoder.encode(input)
  }
  if (input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer())
  }
  if (input instanceof Response) {
    return new Uint8Array(await input.arrayBuffer())
  }
  throw new TypeError("ERR_BINARY_UNSUPPORTED_INPUT: Expected Uint8Array, ArrayBuffer, ArrayBufferView, Blob, Response, or string")
}

/**
 * Reads at most `maxBytes` from the head of a `BinaryInput` without materializing
 * full `Blob`/`BunFile` or streaming `Response` bodies when a prefix suffices (e.g. magic-byte sniffing).
 */
export async function peekBytes(input: BinaryInput, maxBytes: number): Promise<Uint8Array> {
  const limit = Math.max(0, Math.floor(maxBytes))
  if (limit === 0) return new Uint8Array(0)

  if (input instanceof Uint8Array) {
    return input.subarray(0, limit)
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input, 0, Math.min(limit, input.byteLength))
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, Math.min(limit, input.byteLength))
  }
  if (typeof input === "string") {
    return textEncoder.encode(input).subarray(0, limit)
  }
  if (input instanceof Blob) {
    return new Uint8Array(await input.slice(0, limit).arrayBuffer())
  }
  if (input instanceof Response) {
    if (input.body) {
      const reader = input.body.getReader()
      const chunks: Uint8Array[] = []
      let collected = 0
      try {
        while (collected < limit) {
          const { done, value } = await reader.read()
          if (done || !value) break
          const remaining = limit - collected
          const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value
          chunks.push(slice)
          collected += slice.byteLength
        }
      } finally {
        try {
          await reader.cancel()
        } catch {
          // Ignore cancel errors on already-closed streams.
        }
        reader.releaseLock()
      }
      return concatBytes(chunks)
    }
    return new Uint8Array(await input.arrayBuffer()).subarray(0, limit)
  }
  throw new TypeError("ERR_BINARY_UNSUPPORTED_INPUT: Expected Uint8Array, ArrayBuffer, ArrayBufferView, Blob, Response, or string")
}

/**
 * Computes the lowercase SHA-256 hex digest of any `BinaryInput`.
 */
export async function sha256Hex(input: BinaryInput): Promise<string> {
  return sha256HexBytes(await toBytes(input))
}

/**
 * Computes the unsigned IEEE 802.3 CRC-32 checksum (`0..0xffffffff`) of any `BinaryInput`.
 */
export async function crc32Of(input: BinaryInput): Promise<number> {
  return crc32Bytes(await toBytes(input))
}
