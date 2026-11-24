import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  compressResponsePayload,
  deepMatchNative,
  gzipCompressBytes,
  gzipDecompressBytes,
  hasNativeZstd,
  indexOfLineNative,
  negotiateResponseEncoding,
  peekFulfilledValue,
  peekPromiseStatus,
  randomUuidV5,
  sliceAnsiNative,
  splitByteLines,
  SPORTSDESK_UUID_NAMESPACE,
  streamToArray,
  streamToArrayBuffer,
  streamToBlob,
  streamToBytes,
  streamToJSON,
  streamToText,
  stringWidthNative,
  stripAnsiNative,
  wrapAnsiNative,
  zstdCompressAsync,
  zstdCompressBytes,
  zstdDecompressAsync,
  zstdDecompressBytes,
} from "../../packages/api/src/bun_runtime_utils.ts"
import { createDashboardApi } from "../../packages/api/src/router.ts"
import { createCachedJsonReader } from "../../packages/backend/src/cache.ts"
import {
  BUN_RUNTIME_UTILS_EXTENDED,
  BUN_UTILITIES_CATALOG,
  compressZstdText,
  deepMatchSafe,
  generateUuidV5,
  parseXmlSafe,
  sliceAnsiSafe,
  stringifyXmlSafe,
  stripAnsiSafe,
} from "../../packages/ui/src/bun_utilities.ts"
import { ANSI, stripAnsi, truncateVisible, visibleLength } from "../../server/desk_inspect.ts"

describe("Bun 1.4.4 runtime utils.md wiring", () => {
  test("zstd sync & async round-trip and Accept-Encoding negotiation", async () => {
    expect(hasNativeZstd()).toBe(true)
    const sample = "sportsdesk-ops live wager surveillance telemetry ".repeat(48)
    const raw = new TextEncoder().encode(sample)

    const zst = zstdCompressBytes(raw)
    expect(zst).not.toBeNull()
    expect(zst!.byteLength).toBeLessThan(raw.byteLength)
    const back = zstdDecompressBytes(zst!)
    expect(new TextDecoder().decode(back!)).toBe(sample)

    const zstAsync = await zstdCompressAsync(sample)
    expect(zstAsync).not.toBeNull()
    const backAsync = await zstdDecompressAsync(zstAsync!)
    expect(new TextDecoder().decode(backAsync!)).toBe(sample)

    const gz = gzipCompressBytes(raw)
    expect(new TextDecoder().decode(gzipDecompressBytes(gz))).toBe(sample)

    expect(negotiateResponseEncoding("gzip, deflate, zstd")).toBe("zstd")
    expect(negotiateResponseEncoding("gzip;q=1.0, zstd;q=0.5")).toBe("gzip")
    expect(negotiateResponseEncoding("gzip")).toBe("gzip")
    expect(negotiateResponseEncoding(null)).toBe("identity")

    const small = new TextEncoder().encode("tiny")
    expect(compressResponsePayload(small, "zstd, gzip").encoding).toBe("identity")
    const largeZstd = compressResponsePayload(raw, "zstd, gzip")
    expect(largeZstd.encoding).toBe("zstd")
    expect(largeZstd.body.byteLength).toBeLessThan(raw.byteLength)
    const largeGzip = compressResponsePayload(raw, "gzip")
    expect(largeGzip.encoding).toBe("gzip")
  })

  test("router defaultEncodeResponse negotiates Content-Encoding: zstd and gzip on >=1KB payloads", async () => {
    const markdown = `# SportsDesk Surveillance Brief\n\n${Array.from(
      { length: 40 },
      (_, i) => `- Wager W-${i}: sportsdesk-surveillance-wager-row stake=${500 + i}`,
    ).join("\n")}`
    const html = `<h1>SportsDesk Surveillance Brief</h1><ul>${Array.from(
      { length: 40 },
      (_, i) => `<li>Wager W-${i}: sportsdesk-surveillance-wager-row stake=${500 + i}</li>`,
    ).join("")}</ul>`

    const api = createDashboardApi({
      loadDashboardMarkdown: async () => ({
        stamp: "test-stamp-1",
        markdown,
        html,
        renderDurationMs: 0.4,
        markdownBytes: markdown.length,
        htmlBytes: html.length,
        nonAsciiChars: 0,
      }),
      enforceAuth: () => null,
    } as unknown as Parameters<typeof createDashboardApi>[0])

    // 1. No Accept-Encoding -> identity (uncompressed, backwards-compatible)
    const resIdentity = await api.fetch(new Request("http://localhost/api/dashboard"))
    expect(resIdentity.status).toBe(200)
    expect(resIdentity.headers.get("content-encoding")).toBeNull()
    const rawJson = (await resIdentity.json()) as { markdown: string; html: string }
    expect(rawJson.markdown).toBe(markdown)
    const rawByteLen = new TextEncoder().encode(JSON.stringify(rawJson)).byteLength

    // 2. Accept-Encoding: zstd, gzip -> zstd compressed bytes
    const resZstd = await api.fetch(
      new Request("http://localhost/api/dashboard", {
        headers: { "accept-encoding": "gzip, zstd" },
      }),
    )
    expect(resZstd.status).toBe(200)
    expect(resZstd.headers.get("content-encoding")).toBe("zstd")
    const zstdBytes = new Uint8Array(await resZstd.arrayBuffer())
    expect(zstdBytes.byteLength).toBeLessThan(rawByteLen)
    const decodedZstd = JSON.parse(new TextDecoder().decode(zstdDecompressBytes(zstdBytes)!)) as {
      markdown: string
    }
    expect(decodedZstd.markdown).toBe(markdown)

    // 3. Accept-Encoding: gzip -> gzip compressed bytes
    const resGzip = await api.fetch(
      new Request("http://localhost/api/dashboard", {
        headers: { "accept-encoding": "gzip" },
      }),
    )
    expect(resGzip.status).toBe(200)
    expect(resGzip.headers.get("content-encoding")).toBe("gzip")
    const gzipBytes = new Uint8Array(await resGzip.arrayBuffer())
    const decodedGzip = JSON.parse(new TextDecoder().decode(gzipDecompressBytes(gzipBytes))) as {
      markdown: string
    }
    expect(decodedGzip.markdown).toBe(markdown)
  })

  test("SIMD ANSI utilities (stripANSI, sliceAnsi, stringWidth, wrapAnsi) and desk_inspect integration", () => {
    const styled = `${ANSI.boldCyan}SPORTSDESK${ANSI.reset} ${ANSI.yellow}OPS-LIVE${ANSI.reset}`
    expect(stripAnsiNative(styled)).toBe("SPORTSDESK OPS-LIVE")
    expect(stripAnsi(styled)).toBe("SPORTSDESK OPS-LIVE")
    expect(stringWidthNative(styled)).toBe(19)
    expect(visibleLength(styled)).toBe(19)

    const sliced = sliceAnsiNative(styled, 0, 10)
    expect(stripAnsiNative(sliced)).toBe("SPORTSDESK")

    const clipped = truncateVisible(styled, 12)
    expect(stripAnsi(clipped)).toBe("SPORTSDESK …")
    expect(visibleLength(clipped)).toBe(12)

    const wrapped = wrapAnsiNative(`${ANSI.green}alpha beta gamma delta${ANSI.reset}`, 10)
    expect(stripAnsiNative(wrapped).split("\n").length).toBeGreaterThanOrEqual(2)
  })

  test("SIMD indexOfLineNative & splitByteLines scan NDJSON/CRLF byte slabs cleanly", () => {
    const bytes = new TextEncoder().encode('{"a":1}\n{"b":2}\r\n{"c":3}')
    expect(indexOfLineNative(bytes, 0)).toBe(7)
    expect(indexOfLineNative(bytes, 8)).toBe(16)
    expect(indexOfLineNative(bytes, 17)).toBe(-1)

    const lines = splitByteLines(bytes)
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
  })

  test("Bun.peek / peekPromiseStatus and createCachedJsonReader in-flight dedup & peekCachedJson", async () => {
    const settled = Promise.resolve({ id: "desk-1", ok: true })
    expect(peekPromiseStatus(settled)).toBe("fulfilled")
    expect(peekFulfilledValue(settled)).toEqual({
      settled: true,
      value: { id: "desk-1", ok: true },
    })

    let release!: () => void
    const pending = new Promise<string>((resolve) => {
      release = () => resolve("done")
    })
    expect(peekPromiseStatus(pending)).toBe("pending")
    expect(peekFulfilledValue(pending)).toEqual({ settled: false })
    release()
    await pending

    const dir = mkdtempSync(join(tmpdir(), "sd-cache-peek-"))
    try {
      const file = join(dir, "snapshot.json")
      writeFileSync(file, JSON.stringify({ version: 7, active: true }))

      const reader = createCachedJsonReader(8)
      expect(reader.peekCachedJson(file)).toBeNull()

      // Concurrent reads dedupe cleanly and populate cache
      const [r1, r2] = await Promise.all([
        reader.readCachedJson<{ version: number; active: boolean }>(file),
        reader.readCachedJson<{ version: number; active: boolean }>(file),
      ])
      expect(r1?.value).toEqual({ version: 7, active: true })
      expect(r2?.value).toEqual({ version: 7, active: true })

      // Zero-microtask synchronous peek hit
      const peeked = reader.peekCachedJson<{ version: number; active: boolean }>(file)
      expect(peeked?.value).toEqual({ version: 7, active: true })
      expect(peeked?.stamp).toBe(r1?.stamp)

      reader.clear()
      expect(reader.peekCachedJson(file)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("deepMatchNative and deterministic RFC 4122 randomUuidV5", () => {
    const target = {
      route: "/api/wagers",
      meta: { sport: "NBA", live: true, region: "us-east" },
      tags: ["sharp", "syndicate"],
    }
    expect(deepMatchNative({ route: "/api/wagers", meta: { sport: "NBA" } }, target)).toBe(true)
    expect(deepMatchNative({ meta: { sport: "NFL" } }, target)).toBe(false)

    const idA = randomUuidV5("https://api.bookdeskops.com/v2", SPORTSDESK_UUID_NAMESPACE)
    const idB = randomUuidV5("https://api.bookdeskops.com/v2", SPORTSDESK_UUID_NAMESPACE)
    const idOther = randomUuidV5("https://api.bookdeskops.com/v3", SPORTSDESK_UUID_NAMESPACE)
    expect(idA).toBe(idB)
    expect(idA).not.toBe(idOther)
    expect(idA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test("readableStreamTo* helpers consume streams across all 6 output formats", async () => {
    const makeStream = (chunks: readonly string[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          for (const c of chunks) controller.enqueue(enc.encode(c))
          controller.close()
        },
      })

    expect(await streamToText(makeStream(["hello ", "bun"]))).toBe("hello bun")
    expect(await streamToJSON(makeStream(['{"k":', "42}"]))).toEqual({ k: 42 })

    const bytes = await streamToBytes(makeStream(["abc"]))
    expect(Array.from(bytes)).toEqual([97, 98, 99])

    const ab = await streamToArrayBuffer(makeStream(["xy"]))
    expect(ab.byteLength).toBe(2)

    const blob = await streamToBlob(makeStream(["blob-body"]))
    expect(await blob.text()).toBe("blob-body")

    const arr = await streamToArray(
      new ReadableStream<number>({
        start(controller) {
          controller.enqueue(10)
          controller.enqueue(20)
          controller.close()
        },
      }),
    )
    expect(arr).toEqual([10, 20])
  })

  test("UI extended utils.md helpers & catalog preserve the 19-entry BUN_UTILITIES_CATALOG", async () => {
    expect(BUN_UTILITIES_CATALOG.length).toBe(19)
    expect(BUN_RUNTIME_UTILS_EXTENDED.length).toBe(11)

    const xml = stringifyXmlSafe("sportsdesk", { brand: "SD", version: "v1.01.23-next" }, "Ops")
    const parsedXml = parseXmlSafe(xml)
    expect(parsedXml.ok).toBe(true)
    expect(parsedXml.engine).toBe("bun-xml")
    expect(parsedXml.roundTrip).toContain("<sportsdesk")

    const zstdProbe = await compressZstdText("sportsdesk-ops ui zstd probe ".repeat(16))
    expect(zstdProbe.algorithm).toBe("zstd")
    expect(zstdProbe.engine).toBe("bun-native")
    expect(zstdProbe.outputBytes).toBeGreaterThan(0)
    expect(zstdProbe.outputBytes).toBeLessThan(zstdProbe.inputBytes)

    expect(stripAnsiSafe("\x1b[32mLIVE\x1b[0m")).toBe("LIVE")
    expect(stripAnsiSafe(sliceAnsiSafe("\x1b[36mSPORTSDESK\x1b[0m", 0, 6))).toBe("SPORTS")
    expect(deepMatchSafe({ port: 4022 }, { port: 4022, decoupled: true })).toBe(true)
    expect(deepMatchSafe({ port: 4021 }, { port: 4022, decoupled: true })).toBe(false)

    const v5a = await generateUuidV5("https://api.bookdeskops.com")
    const v5b = await generateUuidV5("https://api.bookdeskops.com")
    expect(v5a).toBe(v5b)
    expect(v5a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
