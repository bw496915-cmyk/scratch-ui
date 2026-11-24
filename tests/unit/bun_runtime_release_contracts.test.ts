import { describe, expect, test } from "bun:test"

import {
  BUN_RUNTIME_RELEASE_ENHANCEMENTS,
  isMemoryAllocationError,
  safeDecodeTextBytes,
  safeReadBlobText,
} from "../../packages/ui/src/bun_utilities.ts"
import readmeText from "../../README.md" with { type: "text" }
import { parseHardenedS3Endpoint } from "../../src/s3/sealed_r2_handle.ts"

describe("Bun Runtime Release Contracts (Text Imports, S3 Endpoint, TextDecoder, Streams, --isolate)", () => {
  test('supports pre-encoded with { type: "text" } module imports natively in Bun', () => {
    expect(typeof readmeText).toBe("string")
    expect(readmeText.length).toBeGreaterThan(50)
  })

  test("parseHardenedS3Endpoint matches hardened Bun.S3Client new URL() semantics and rejects unsafe endpoints", () => {
    const valid = parseHardenedS3Endpoint("https://account-123.r2.cloudflarestorage.com")
    expect(valid.origin).toBe("https://account-123.r2.cloudflarestorage.com")

    const validWithPort = parseHardenedS3Endpoint("https://r2.bookdeskops.com:8443/")
    expect(validWithPort.origin).toBe("https://r2.bookdeskops.com:8443")

    const invalidCases = [
      "",
      "http://r2.bookdeskops.com",
      "https://r2.bookdeskops.com/bucket-prefix",
      "https://r2.bookdeskops.com\\evil",
      "https://r2.bookdeskops.com?",
      "https://r2.bookdeskops.com#frag",
      "https://user:pass@r2.bookdeskops.com",
      `https://${"a".repeat(2050)}.r2.cloudflarestorage.com`,
      "https://r2.bookdeskops.com:0",
      "not-a-url",
    ]
    for (const bad of invalidCases) {
      expect(() => parseHardenedS3Endpoint(bad)).toThrow("Invalid explicit R2 client configuration")
    }
  })

  test('decodes runtime TextDecoder labels including "windows-1251" and classifies ERR_MEMORY_ALLOCATION_FAILED', async () => {
    // "Привет" in windows-1251 bytes
    const win1251Bytes = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
    const decoded = safeDecodeTextBytes(win1251Bytes, "windows-1251")
    expect(decoded).toEqual({
      ok: true,
      encoding: "windows-1251",
      text: "Привет",
    })

    // Also verify native @types/bun typing accepts "windows-1251" directly
    const direct = new TextDecoder("windows-1251").decode(win1251Bytes)
    expect(direct).toBe("Привет")

    const blobRes = await safeReadBlobText(new Blob(["SportsDesk Ops"]))
    expect(blobRes).toEqual({ ok: true, text: "SportsDesk Ops" })

    const oomErr = Object.assign(new Error("Out of memory"), {
      code: "ERR_MEMORY_ALLOCATION_FAILED",
    })
    expect(isMemoryAllocationError(oomErr)).toBe(true)
    const oomBlobRes = await safeReadBlobText({
      text: async () => {
        throw oomErr
      },
    })
    expect(oomBlobRes).toEqual({
      ok: false,
      code: "ERR_MEMORY_ALLOCATION_FAILED",
      error: "Out of memory",
    })
  })

  test("supports ReadableStream.from() and async-iterable Response bodies", async () => {
    async function* chunks() {
      yield "sportsdesk-"
      yield "ops-"
      yield "stream"
    }
    const stream = ReadableStream.from(chunks())
    const text = await new Response(stream).text()
    expect(text).toBe("sportsdesk-ops-stream")
    expect(BUN_RUNTIME_RELEASE_ENHANCEMENTS.length).toBe(7)
  })
})
