import { beforeEach, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { deflateSync } from "node:zlib"

import {
  concatBytes,
  crc32Bytes,
  crc32Of,
  peekBytes,
  sha256Hex,
  toBytes,
} from "../../lib/binary.ts"
import {
  encodeImageWithAvifFallback,
  getCachedAvifEncodeCapability,
  type ImageEncoderPipeline,
  resetAvifEncodeCapabilityCache,
  toImageRpcPayload,
  writeImageBlobToR2,
} from "../../lib/image_avif_fallback.ts"
import {
  buildSportsdeskProvenanceXmp,
  inspectImageProvenance,
  probeR2ImageProvenance,
} from "../../lib/image_provenance.ts"
import {
  extractAvifMetadata,
  extractPngMetadata,
  extractWebpXmp,
  injectPngXmp,
  injectWebpXmp,
  injectXmp,
  PNG_SIGNATURE,
  sniffImageFormat,
  sniffImageInfo,
  VP8X_FLAG_ALPHA,
  VP8X_FLAG_XMP,
  XMP_CONTAINER_MATRIX,
} from "../../lib/xmp_container.ts"
import { transformBunImageAsset } from "../../server/bun_image_engine.ts"

const WORKSPACE_ROOT = resolve(import.meta.dir, "../..")
const textEncoder = new TextEncoder()

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.byteLength, false)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32Bytes(out.subarray(4, 8 + data.byteLength)), false)
  return out
}

function makeRgbaPngFixture(
  width = 16,
  height = 16,
  extraChunks: readonly Uint8Array[] = [],
): Uint8Array {
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width, false)
  ihdrView.setUint32(4, height, false)
  ihdr[8] = 8
  ihdr[9] = 6

  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4
      raw[i] = (x * 16) & 0xff
      raw[i + 1] = (y * 16) & 0xff
      raw[i + 2] = 0x80
      raw[i + 3] = x < width / 2 ? 0xff : 0x80
    }
  }
  const idat = new Uint8Array(deflateSync(raw))
  return concatBytes([
    PNG_SIGNATURE,
    makePngChunk("IHDR", ihdr),
    ...extraChunks,
    makePngChunk("IDAT", idat),
    makePngChunk("IEND", new Uint8Array(0)),
  ])
}

function makeMinimalAvifFixture(options?: {
  readonly width?: number
  readonly height?: number
  readonly xmpXml?: string
}): Uint8Array {
  const width = options?.width ?? 64
  const height = options?.height ?? 32
  // ftyp box: size(24) + "ftyp" + "avif" + minor(0) + "mif1" + "miaf"
  const ftyp = new Uint8Array(24)
  const ftypView = new DataView(ftyp.buffer)
  ftypView.setUint32(0, 24, false)
  ftyp.set(textEncoder.encode("ftypavif"), 4)
  ftypView.setUint32(12, 0, false)
  ftyp.set(textEncoder.encode("mif1miaf"), 16)

  // meta fullbox (12 bytes header) wrapping ispe box (20 bytes)
  const meta = new Uint8Array(32)
  const metaView = new DataView(meta.buffer)
  metaView.setUint32(0, 32, false)
  meta.set(textEncoder.encode("meta"), 4)
  metaView.setUint32(12, 20, false)
  meta.set(textEncoder.encode("ispe"), 16)
  metaView.setUint32(24, width, false)
  metaView.setUint32(28, height, false)

  const parts: Uint8Array[] = [ftyp, meta]
  if (options?.xmpXml) {
    const xmpBytes = textEncoder.encode(options.xmpXml)
    const uuid = new Uint8Array([
      0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8,
      0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
    ])
    const uuidBox = new Uint8Array(24 + xmpBytes.byteLength)
    const uView = new DataView(uuidBox.buffer)
    uView.setUint32(0, uuidBox.byteLength, false)
    uuidBox.set(textEncoder.encode("uuid"), 4)
    uuidBox.set(uuid, 8)
    uuidBox.set(xmpBytes, 24)
    parts.push(uuidBox)
  }
  return concatBytes(parts)
}

describe("lib/binary.ts — BinaryInput utilities", () => {
  test("toBytes normalizes Uint8Array, ArrayBuffer, DataView, Blob, Response, and string", async () => {
    const expected = textEncoder.encode("sportsdesk-bin")
    const ab = expected.buffer.slice(expected.byteOffset, expected.byteOffset + expected.byteLength)

    expect(await toBytes(expected)).toEqual(expected)
    expect(await toBytes(ab)).toEqual(expected)
    expect(await toBytes(new DataView(ab))).toEqual(expected)
    expect(await toBytes(new Blob([expected], { type: "application/octet-stream" }))).toEqual(
      expected,
    )
    expect(await toBytes(new Response(expected))).toEqual(expected)
    expect(await toBytes("sportsdesk-bin")).toEqual(expected)
  })

  test("peekBytes reads bounded prefix from Blob and streaming Response without full consumption", async () => {
    const payload = new Uint8Array(4096)
    for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff

    const blobPeek = await peekBytes(new Blob([payload]), 16)
    expect(blobPeek.byteLength).toBe(16)
    expect(blobPeek).toEqual(payload.subarray(0, 16))

    let chunksEmitted = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksEmitted += 1
        controller.enqueue(payload.subarray(0, 64))
        if (chunksEmitted >= 20) controller.close()
      },
    })
    const resPeek = await peekBytes(new Response(stream), 12)
    expect(resPeek.byteLength).toBe(12)
    expect(resPeek).toEqual(payload.subarray(0, 12))
    expect(chunksEmitted).toBeLessThanOrEqual(2)
  })

  test("sha256Hex, crc32Of, and sync crc32Bytes match standard test vectors", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    expect(crc32Bytes(textEncoder.encode("123456789"))).toBe(0xcbf43926)
    expect(await crc32Of(new Blob(["123456789"]))).toBe(0xcbf43926)
  })
})

describe("lib/xmp_container.ts — Sniffing, WebP/PNG XMP, and explicit AVIF row", () => {
  const rgbaPng = makeRgbaPngFixture(16, 16)

  test("sniffImageFormat & XMP_CONTAINER_MATRIX cover WebP, PNG, and explicit AVIF (image/avif)", async () => {
    const webp = new Uint8Array(
      await new Bun.Image(rgbaPng).webp({ lossless: true, quality: 100 }).toBuffer(),
    )
    const avif = makeMinimalAvifFixture({ width: 120, height: 80 })

    expect(sniffImageFormat(rgbaPng)).toBe("png")
    expect(sniffImageInfo(rgbaPng)).toMatchObject({
      format: "png",
      mimeType: "image/png",
      supportsXmpInjection: true,
      xmpChannel: "png-xmp",
    })

    expect(sniffImageFormat(webp)).toBe("webp")
    expect(sniffImageInfo(webp)).toMatchObject({
      format: "webp",
      mimeType: "image/webp",
      supportsXmpInjection: true,
      xmpChannel: "webp-xmp",
    })

    expect(sniffImageFormat(avif)).toBe("avif")
    expect(sniffImageInfo(avif)).toMatchObject({
      format: "avif",
      mimeType: "image/avif",
      supportsXmpInjection: false,
      xmpChannel: null,
    })

    const avifRow = XMP_CONTAINER_MATRIX.find((row) => row.format === "avif")
    expect(avifRow).toMatchObject({
      format: "avif",
      mimeType: "image/avif",
      container: "ISOBMFF/ftyp",
      canReadXmp: true,
      canInjectXmp: false,
    })

    const avifMeta = extractAvifMetadata(avif)
    expect(avifMeta.isAvif).toBe(true)
    expect(avifMeta.brands).toContain("avif")
    expect(avifMeta.width).toBe(120)
    expect(avifMeta.height).toBe(80)

    expect(() => injectXmp(avif, "<x:xmpmeta/>")).toThrow("ERR_XMP_AVIF_UNSUPPORTED")
  })

  test("WebP even-pads odd-length XMP chunks, sets VP8X 0x04 | 0x10, and keeps RIFF size = total - 8", async () => {
    const losslessWebp = new Uint8Array(
      await new Bun.Image(rgbaPng).webp({ lossless: true, quality: 100 }).toBuffer(),
    )
    // Intentionally odd UTF-8 byte length (13 bytes)
    const oddXmp = "<x:xmpmeta>1</x:xmpmeta>".slice(0, 13)
    expect(textEncoder.encode(oddXmp).byteLength % 2).toBe(1)

    const stamped = injectWebpXmp(losslessWebp, oddXmp)
    const parsed = extractWebpXmp(stamped)

    expect(parsed.riffSizeMatches).toBe(true)
    expect(new DataView(stamped.buffer, stamped.byteOffset, stamped.byteLength).getUint32(4, true)).toBe(
      stamped.byteLength - 8,
    )
    expect(parsed.vp8xFlags).toBe(VP8X_FLAG_XMP | VP8X_FLAG_ALPHA)
    expect(parsed.xmp).toBe(oddXmp)
    expect(stamped.byteLength % 2).toBe(0)
  })
})

describe("AVIF -> WebP capability-cached fallback & R2/RPC MIME preservation", () => {
  beforeEach(() => {
    resetAvifEncodeCapabilityCache()
  })

  test("caches ERR_IMAGE_FORMAT_UNSUPPORTED, skips repeat native AVIF calls, and preserves outBlob.type for R2 & RPC", async () => {
    const rgbaPng = makeRgbaPngFixture(16, 16)
    let avifCalls = 0
    let webpCalls = 0

    const makeMockPipeline = (): ImageEncoderPipeline => {
      const real = new Bun.Image(rgbaPng)
      return {
        webp(opts) {
          webpCalls += 1
          return real.webp(opts ?? { lossless: false, quality: 80 })
        },
        jpeg(opts) {
          return real.jpeg(opts)
        },
        png(opts) {
          return real.png(opts)
        },
        heic(opts) {
          return real.heic(opts)
        },
        avif() {
          avifCalls += 1
          return {
            async bytes() {
              const err = new Error("Image: format not supported on this machine") as Error & {
                code: string
              }
              err.code = "ERR_IMAGE_FORMAT_UNSUPPORTED"
              throw err
            },
          }
        },
      }
    }

    const xmp = buildSportsdeskProvenanceXmp({
      streamId: "desk-emblem-v1",
      genU32: 42,
      merkleRoot: "deadbeefcafebabe",
    })

    // First call probes AVIF, catches ERR_IMAGE_FORMAT_UNSUPPORTED, caches false, falls back to WebP
    const first = await encodeImageWithAvifFallback(makeMockPipeline, {
      format: "avif",
      quality: 75,
      xmpXml: xmp,
    })
    expect(avifCalls).toBe(1)
    expect(webpCalls).toBe(1)
    expect(getCachedAvifEncodeCapability()).toBe(false)
    expect(first.requestedFormat).toBe("avif")
    expect(first.outputFormat).toBe("webp")
    expect(first.fallbackApplied).toBe(true)
    expect(first.fallbackReason).toBe("ERR_IMAGE_FORMAT_UNSUPPORTED")
    expect(first.blob.type).toBe("image/webp")
    expect(first.mimeType).toBe("image/webp")
    expect(first.xmpInjected).toBe(true)

    // Second call uses cached capability (avifCalls stays 1!)
    const second = await encodeImageWithAvifFallback(makeMockPipeline, {
      format: "avif",
      quality: 75,
    })
    expect(avifCalls).toBe(1)
    expect(webpCalls).toBe(2)
    expect(second.outputFormat).toBe("webp")
    expect(second.blob.type).toBe("image/webp")

    // R2 write preserves outBlob.type via s3.file(key, { type })
    const recordedWrites: Array<{ key: string; type?: string; size: number }> = []
    const mockS3 = {
      file(key: string, options?: { readonly type?: string | undefined }) {
        return {
          async write(data: Blob | Uint8Array | string) {
            const size = data instanceof Blob ? data.size : typeof data === "string" ? data.length : data.byteLength
            recordedWrites.push({ key, type: options?.type, size })
            return size
          },
        }
      },
    }

    const r2Write = await writeImageBlobToR2(mockS3, "assets/hero.webp", first.blob)
    expect(r2Write.type).toBe("image/webp")
    expect(recordedWrites).toEqual([
      { key: "assets/hero.webp", type: "image/webp", size: first.blob.size },
    ])

    // string | Blob RPC preserves outBlob.type in both modes
    const rpcBlob = await toImageRpcPayload(first.blob, "blob")
    expect(rpcBlob instanceof Blob).toBe(true)
    expect((rpcBlob as Blob).type).toBe("image/webp")

    const rpcDataUrl = await toImageRpcPayload(first.blob, "data-url")
    expect(typeof rpcDataUrl).toBe("string")
    expect((rpcDataUrl as string).startsWith("data:image/webp;base64,")).toBe(true)
  })

  test("transformBunImageAsset handles format='avif' gracefully via AVIF -> WebP fallback", async () => {
    const xmp = buildSportsdeskProvenanceXmp({
      streamId: "sportsdesk-emblem",
      genU32: 7,
      merkleRoot: "0123456789abcdef",
    })
    const res = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: "public/assets/branding/sportsdesk-emblem.webp",
      format: "avif",
      quality: 75,
      xmpXml: xmp,
    })

    expect(res.ok).toBe(true)
    expect(res.requestedFormat).toBe("avif")
    // On hosts without AV1 encoder this falls back to WebP; on AV1-capable hosts it emits AVIF.
    if (res.fallbackApplied) {
      expect(res.outputFormat).toBe("webp")
      expect(res.mimeType).toBe("image/webp")
      expect(res.fallbackReason).toBe("ERR_IMAGE_FORMAT_UNSUPPORTED")
      expect(res.dataUrl.startsWith("data:image/webp;base64,")).toBe(true)
      expect(res.xmpInjected).toBe(true)
    } else {
      expect(res.outputFormat).toBe("avif")
      expect(res.mimeType).toBe("image/avif")
      expect(res.dataUrl.startsWith("data:image/avif;base64,")).toBe(true)
    }
  })
})

describe("lib/image_provenance.ts — Delegated to lib/xmp_container.ts", () => {
  test("extracts sportsdesk:* fields from WebP XMP, PNG iTXt + tEXt, and AVIF UUID boxes", async () => {
    const xmp = buildSportsdeskProvenanceXmp({
      streamId: "bet-ticker-live",
      genU32: 1024,
      merkleRoot: "0xAABBCCDD11223344",
    })

    // 1. WebP provenance via webp-xmp channel
    const basePng = makeRgbaPngFixture(16, 16)
    const webp = new Uint8Array(
      await new Bun.Image(basePng).webp({ lossless: true, quality: 100 }).toBuffer(),
    )
    const webpStamped = injectWebpXmp(webp, xmp)
    const webpReport = await inspectImageProvenance(webpStamped)
    expect(webpReport.available).toBe(true)
    expect(webpReport.format).toBe("webp")
    expect(webpReport.width).toBe(16)
    expect(webpReport.height).toBe(16)
    expect(webpReport.channels).toEqual(["webp-xmp"])
    expect(webpReport.fields).toEqual({
      streamId: "bet-ticker-live",
      genU32: 1024,
      merkleRoot: "aabbccdd11223344",
    })
    expect(webpReport.issues).toEqual([])

    // 2. PNG provenance via both png-text (tEXt) and png-xmp (iTXt)
    const textChunk = makePngChunk("tEXt", textEncoder.encode("sportsdesk:streamId\0legacy-stream"))
    const pngWithText = makeRgbaPngFixture(24, 12, [textChunk])
    const pngStamped = injectPngXmp(pngWithText, xmp)
    const pngMeta = extractPngMetadata(pngStamped)
    expect(pngMeta.textEntries["sportsdesk:streamId"]).toBe("legacy-stream")
    const pngReport = await inspectImageProvenance(pngStamped)
    expect(pngReport.available).toBe(true)
    expect(pngReport.format).toBe("png")
    expect(pngReport.width).toBe(24)
    expect(pngReport.height).toBe(12)
    expect(pngReport.channels).toEqual(["png-text", "png-xmp"])
    expect(pngReport.fields.streamId).toBe("bet-ticker-live")
    expect(pngReport.fields.genU32).toBe(1024)
    expect(pngReport.fields.merkleRoot).toBe("aabbccdd11223344")

    // 3. Explicit AVIF provenance inspection
    const avifWithXmp = makeMinimalAvifFixture({ width: 40, height: 20, xmpXml: xmp })
    const avifReport = await inspectImageProvenance(avifWithXmp)
    expect(avifReport.available).toBe(true)
    expect(avifReport.format).toBe("avif")
    expect(avifReport.width).toBe(40)
    expect(avifReport.height).toBe(20)
    expect(avifReport.fields.streamId).toBe("bet-ticker-live")

    // 4. probeR2ImageProvenance via mocked fetch
    const r2Resp = await probeR2ImageProvenance({
      key: "reports/card.webp",
      bucketPublicBase: "https://r2.example.dev/",
      fetchImpl: async () =>
        new Response(webpStamped, {
          status: 206,
          headers: { "content-type": "image/webp" },
        }),
    })
    expect(r2Resp.publicUrl).toBe("https://r2.example.dev/reports/card.webp")
    expect(r2Resp.fetchedBytes).toBe(webpStamped.byteLength)
    expect(r2Resp.report.fields.streamId).toBe("bet-ticker-live")
    expect(r2Resp.report.channels).toEqual(["webp-xmp"])
  })

  test("lib/image_provenance.ts delegates container walking to lib/xmp_container.ts with zero private walkers", async () => {
    const rawSource = await Bun.file(resolve(WORKSPACE_ROOT, "lib/image_provenance.ts")).text()
    const codeOnly = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(codeOnly).toContain('from "./xmp_container.ts"')
    expect(codeOnly).not.toContain("DataView")
    expect(codeOnly).not.toContain("RIFF")
    expect(codeOnly).not.toContain("VP8X")
    expect(codeOnly).not.toContain("IHDR")
    expect(codeOnly).not.toContain("iTXt")
  })
})
