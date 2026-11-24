/**
 * Verifies native Bun.fileURLToPath(), Bun.pathToFileURL(), and Bun.gzipSync() / Bun.gunzipSync() / Bun.deflateSync() /
 * Bun.inflateSync() with full ZlibCompressionOptions coverage and config loader parity.
 *
 * @file Tests/unit/bun_url_gzip.test.ts
 */
import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import {
  bunDeflateSync,
  bunFileURLToPath,
  bunGunzipSync,
  bunGzipSync,
  bunGzipSyncWithMeta,
  bunInflateSync,
  bunPathToFileURL,
  getBunUrlGzipEngine,
  validateZlibOptions,
  ZLIB_STRATEGIES,
  type ZlibCompressionLevel,
  type ZlibMemLevel,
  type ZlibWindowBits,
} from "../../lib/bun_url_gzip.ts"
import { SLAB_SERVER } from "../../lib/slab_config.ts"

const decoder = new TextDecoder()

describe("Bun.fileURLToPath() & Bun.pathToFileURL()", () => {
  test("uses native Bun engine under Bun runtime", () => {
    expect(getBunUrlGzipEngine()).toBe("bun-native")
  })

  test("matches Bun documentation examples for file:// URL and path conversion", () => {
    const path = bunFileURLToPath(new URL("file:///foo/bar.txt"))
    expect(path).toBe("/foo/bar.txt")

    const url = bunPathToFileURL("/foo/bar.txt")
    expect(url instanceof URL).toBe(true)
    expect(url.href).toBe("file:///foo/bar.txt")
    expect(bunFileURLToPath(url)).toBe("/foo/bar.txt")
  })

  test("round-trips percent-encoded paths, spaces, Unicode, and import.meta.url", () => {
    const encoded = bunPathToFileURL("/tmp/sports desk/odds #1/αβγ.toml")
    expect(encoded.protocol).toBe("file:")
    expect(encoded.href).toContain("%20")
    expect(encoded.href).toContain("%23")
    expect(bunFileURLToPath(encoded)).toBe("/tmp/sports desk/odds #1/αβγ.toml")

    const thisFile = bunFileURLToPath(import.meta.url)
    expect(thisFile).toBe(resolve(import.meta.dir, "bun_url_gzip.test.ts"))
    expect(bunPathToFileURL(thisFile).href).toBe(import.meta.url)
  })

  test("migrated TOML/policy config loaders resolve cleanly via bunFileURLToPath", () => {
    expect(SLAB_SERVER.meta.schema).toBe("sportsdesk-slab/v1")
  })
})

describe("Bun.gzipSync() & ZlibCompressionOptions", () => {
  test("compresses Buffer/Uint8Array matching Bun docs example with deterministic zeroed gzip header", () => {
    const buf = Buffer.from("hello".repeat(100))
    expect(buf.byteLength).toBe(500)

    const compressed = bunGzipSync(buf)
    expect(compressed instanceof Uint8Array).toBe(true)
    expect(compressed.byteLength).toBeLessThanOrEqual(40)

    // GZIP magic (1f 8b), deflate method (08), flags (00), zeroed mtime (00 00 00 00)
    expect(Array.from(compressed.subarray(0, 8))).toEqual([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])

    const restored = bunGunzipSync(compressed)
    expect(decoder.decode(restored)).toBe("hello".repeat(100))
  })

  test("supports all compression levels (-1..9) and memLevels (1..9)", () => {
    const payload = JSON.stringify({
      desk: "SportsDesk Ops",
      rows: Array.from({ length: 120 }, (_, i) => ({
        ticket: `T-${1000 + i}`,
        clvCents: i % 15,
        tier: i % 2 === 0 ? "SHARP" : "REC",
      })),
    })

    const levels: readonly ZlibCompressionLevel[] = [-1, 0, 1, 6, 9]
    const sizes = new Map<number, number>()
    for (const level of levels) {
      const out = bunGzipSync(payload, { level })
      sizes.set(level, out.byteLength)
      expect(decoder.decode(bunGunzipSync(out))).toBe(payload)
    }

    // level 0 (stored) is larger than level 1 (fast), which is >= level 9 (best)
    expect(sizes.get(0)!).toBeGreaterThan(sizes.get(1)!)
    expect(sizes.get(1)!).toBeGreaterThanOrEqual(sizes.get(9)!)

    const memLevels: readonly ZlibMemLevel[] = [1, 4, 8, 9]
    for (const memLevel of memLevels) {
      const out = bunGzipSync(payload, { level: 6, memLevel })
      expect(decoder.decode(bunGunzipSync(out))).toBe(payload)
    }
  })

  test("supports all zlib strategies (Z_DEFAULT_STRATEGY..Z_FIXED) and valid windowBits", () => {
    const payload = Buffer.from("AAAABBBBCCCCDDDD".repeat(64))
    const strategies = [
      ZLIB_STRATEGIES.Z_DEFAULT_STRATEGY,
      ZLIB_STRATEGIES.Z_FILTERED,
      ZLIB_STRATEGIES.Z_HUFFMAN_ONLY,
      ZLIB_STRATEGIES.Z_RLE,
      ZLIB_STRATEGIES.Z_FIXED,
    ]

    for (const strategy of strategies) {
      const out = bunGzipSync(payload, { level: 6, strategy })
      expect(decoder.decode(bunGunzipSync(out))).toBe(payload.toString())
    }

    const gzipWindows: readonly ZlibWindowBits[] = [25, 28, 31]
    for (const windowBits of gzipWindows) {
      const out = bunGzipSync(payload, { level: 6, windowBits })
      expect(decoder.decode(bunGunzipSync(out))).toBe(payload.toString())
    }
  })

  test("bunGzipSyncWithMeta reports compression telemetry accurately", () => {
    const text = "sportsdesk-telemetry-row,".repeat(200)
    const meta = bunGzipSyncWithMeta(text, {
      level: 9,
      memLevel: 9,
      windowBits: 31,
      strategy: ZLIB_STRATEGIES.Z_DEFAULT_STRATEGY,
    })

    expect(meta.engine).toBe("bun-native")
    expect(meta.originalBytes).toBe(text.length)
    expect(meta.compressedBytes).toBe(meta.bytes.byteLength)
    expect(meta.savedBytes).toBe(meta.originalBytes - meta.compressedBytes)
    expect(meta.ratioPct).toBeGreaterThan(90)
    expect(meta.durationMs).toBeGreaterThanOrEqual(0)
    expect(decoder.decode(bunGunzipSync(meta.bytes))).toBe(text)
  })

  test("bunDeflateSync & bunInflateSync round-trip raw deflate payloads", () => {
    const input = "raw-deflate-stream-".repeat(80)
    const deflated = bunDeflateSync(input, { level: 6, memLevel: 8 })
    expect(deflated.byteLength).toBeLessThan(input.length / 4)
    expect(decoder.decode(bunInflateSync(deflated))).toBe(input)
  })

  test("validateZlibOptions rejects out-of-range level, memLevel, windowBits, and strategy", () => {
    expect(() => validateZlibOptions({ level: 10 as ZlibCompressionLevel })).toThrow(RangeError)
    expect(() => validateZlibOptions({ level: -2 as ZlibCompressionLevel })).toThrow(RangeError)
    expect(() => validateZlibOptions({ memLevel: 0 as ZlibMemLevel })).toThrow(RangeError)
    expect(() => validateZlibOptions({ memLevel: 10 as ZlibMemLevel })).toThrow(RangeError)
    expect(() => validateZlibOptions({ windowBits: 8 as ZlibWindowBits })).toThrow(RangeError)
    expect(() => validateZlibOptions({ windowBits: 16 as ZlibWindowBits })).toThrow(RangeError)
    expect(() => validateZlibOptions({ windowBits: 32 as ZlibWindowBits })).toThrow(RangeError)
    expect(() => validateZlibOptions({ strategy: 5 })).toThrow(RangeError)
    expect(() => validateZlibOptions({ strategy: -1 })).toThrow(RangeError)
  })
})
