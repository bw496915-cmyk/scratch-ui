import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { deflateSync } from "node:zlib"

import { XML } from "bun"

import { crc32Bytes } from "../../lib/binary.ts"
import { transformBunImageAsset } from "../../server/bun_image_engine.ts"
import { injectPngXmp, injectWebpXmp, injectXmp } from "../../server/xmp_injector.ts"

const decoder = new TextDecoder()
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const XMP_PNG_PREFIX = new TextEncoder().encode("XML:com.adobe.xmp\0\0\0\0\0")
const WORKSPACE_ROOT = resolve(import.meta.dir, "../..")

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.byteLength, false)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32Bytes(out.subarray(4, 8 + data.byteLength)), false)
  return out
}

const CREATOR_VALUE = "SportsDesk Provenance — α"

const SAMPLE_XMP =
  `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
  `<x:xmpmeta xmlns:x="adobe:ns:meta/">` +
  `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
  `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
  `<dc:creator><rdf:Seq><rdf:li>${CREATOR_VALUE}</rdf:li></rdf:Seq></dc:creator>` +
  `</rdf:Description></rdf:RDF></x:xmpmeta>` +
  `<?xpacket end="w"?>`

const REPLACEMENT_XMP =
  `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>` +
  `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>` +
  `</x:xmpmeta><?xpacket end="w"?>`

function makeRgbaPngFixture(width = 16, height = 16): Uint8Array {
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width, false)
  ihdrView.setUint32(4, height, false)
  ihdr[8] = 8 // 8-bit depth
  ihdr[9] = 6 // RGBA truecolor with alpha

  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    raw[row] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4
      raw[i] = (x * 16) & 0xff
      raw[i + 1] = (y * 16) & 0xff
      raw[i + 2] = 0x80
      raw[i + 3] = x < width / 2 ? 0xff : 0x80
    }
  }

  const idat = new Uint8Array(deflateSync(raw))
  return new Uint8Array(
    Bun.concatArrayBuffers([
      PNG_SIG,
      makePngChunk("IHDR", ihdr),
      makePngChunk("IDAT", idat),
      makePngChunk("IEND", new Uint8Array(0)),
    ]),
  )
}

function readFourCC(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!)
}

function extractWebpXmp(webp: Uint8Array): {
  xmp: string | null
  vp8xFlags: number | null
  riffSizeMatches: boolean
  chunkTypes: string[]
} {
  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength)
  const riffSize = view.getUint32(4, true)
  let vp8xFlags: number | null = null
  let xmp: string | null = null
  const chunkTypes: string[] = []

  let offset = 12
  while (offset + 8 <= webp.byteLength) {
    const fourCC = readFourCC(webp, offset)
    const size = view.getUint32(offset + 4, true)
    const paddedSize = size + (size & 1)
    chunkTypes.push(fourCC)

    if (fourCC === "VP8X") {
      vp8xFlags = webp[offset + 8]!
    } else if (fourCC === "XMP ") {
      xmp = decoder.decode(webp.subarray(offset + 8, offset + 8 + size))
    }
    offset += 8 + paddedSize
  }

  return { xmp, vp8xFlags, riffSizeMatches: riffSize === webp.byteLength - 8, chunkTypes }
}

function extractPngXmp(png: Uint8Array): {
  xmp: string | null
  count: number
  chunkTypes: string[]
} {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let offset = 8
  let xmp: string | null = null
  let count = 0
  const chunkTypes: string[] = []

  while (offset + 12 <= png.byteLength) {
    const length = view.getUint32(offset, false)
    const type = readFourCC(png, offset + 4)
    chunkTypes.push(type)
    const payload = png.subarray(offset + 8, offset + 8 + length)

    if (
      type === "iTXt" &&
      payload.byteLength >= XMP_PNG_PREFIX.byteLength &&
      XMP_PNG_PREFIX.every((b, idx) => payload[idx] === b)
    ) {
      xmp = decoder.decode(payload.subarray(XMP_PNG_PREFIX.byteLength))
      count++
    }
    offset += 12 + length
  }

  return { xmp, count, chunkTypes }
}

function assertValidXmpXml(xmp: string | null, expectedCreator?: string): void {
  expect(xmp).not.toBeNull()
  const doc = XML.parse(xmp!) as Record<string, unknown>
  expect(doc).toBeDefined()
  expect(doc["x:xmpmeta"]).toBeDefined()

  if (expectedCreator) {
    const xmpmeta = doc["x:xmpmeta"] as Record<
      string,
      Record<string, Record<string, Record<string, Record<string, Record<string, unknown>>>>>
    >
    const creator = xmpmeta["rdf:RDF"]?.["rdf:Description"]?.["dc:creator"]?.["rdf:Seq"]?.["rdf:li"]
    expect(creator).toBe(expectedCreator)
  }
}

describe("xmp-injector round-trip with Bun.Image + Bun.XML", () => {
  const WIDTH = 16
  const HEIGHT = 16
  const rgbaFixture = makeRgbaPngFixture(WIDTH, HEIGHT)

  test("WebP (lossy alpha VP8X+ALPH+VP8 ): patches VP8X flags in place, injects XMP, validates via Bun.XML, and re-decodes cleanly", async () => {
    const encoded = new Uint8Array(await new Bun.Image(rgbaFixture).webp({ lossless: false, quality: 85 }).toBuffer())
    const before = extractWebpXmp(encoded)
    expect(before.chunkTypes).toEqual(["VP8X", "ALPH", "VP8 "])
    expect(before.vp8xFlags).toBe(0x10)

    const stamped = injectWebpXmp(encoded, SAMPLE_XMP)
    const parsed = extractWebpXmp(stamped)

    expect(parsed.riffSizeMatches).toBe(true)
    expect(parsed.chunkTypes).toEqual(["VP8X", "ALPH", "VP8 ", "XMP "])
    expect(parsed.vp8xFlags).toBe(0x14) // VP8X_FLAG_ALPHA (0x10) | VP8X_FLAG_XMP (0x04)
    expect(parsed.xmp).toBe(SAMPLE_XMP)
    assertValidXmpXml(parsed.xmp, CREATOR_VALUE)

    const meta = await new Bun.Image(stamped).metadata()
    expect(meta.width).toBe(WIDTH)
    expect(meta.height).toBe(HEIGHT)
  })

  test("PNG: encodes via Bun.Image, injects iTXt XMP, validates via Bun.XML, and re-decodes cleanly", async () => {
    const encoded = new Uint8Array(
      await new Bun.Image(rgbaFixture)
        .png({ colors: 256, compressionLevel: 6, dither: false, palette: false })
        .toBuffer(),
    )

    expect(PNG_SIG.every((b, i) => encoded[i] === b)).toBe(true)

    const stamped = injectPngXmp(encoded, SAMPLE_XMP)
    const parsed = extractPngXmp(stamped)

    expect(parsed.count).toBe(1)
    expect(parsed.xmp).toBe(SAMPLE_XMP)
    assertValidXmpXml(parsed.xmp, CREATOR_VALUE)

    const meta = await new Bun.Image(stamped).metadata()
    expect(meta.width).toBe(WIDTH)
    expect(meta.height).toBe(HEIGHT)
  })

  test("Indexed PNG (color-type 3 with PLTE/tRNS): stamps iTXt before IEND and re-decodes cleanly", async () => {
    const indexed = new Uint8Array(
      await new Bun.Image(rgbaFixture).png({ colors: 64, compressionLevel: 9, dither: true, palette: true }).toBuffer(),
    )

    expect(indexed[25]).toBe(3)

    const stamped = injectPngXmp(indexed, SAMPLE_XMP)
    const parsed = extractPngXmp(stamped)

    expect(stamped[25]).toBe(3)
    expect(parsed.chunkTypes).toContain("PLTE")
    expect(parsed.chunkTypes.slice(-2)).toEqual(["iTXt", "IEND"])
    expect(parsed.count).toBe(1)
    expect(parsed.xmp).toBe(SAMPLE_XMP)
    assertValidXmpXml(parsed.xmp, CREATOR_VALUE)

    const meta = await new Bun.Image(stamped).metadata()
    expect(meta.width).toBe(WIDTH)
    expect(meta.height).toBe(HEIGHT)
  })

  test("injectXmp auto-detects lossless WebP (VP8L -> VP8X with alpha bit 28) & PNG and replaces existing XMP idempotently", async () => {
    const webp = new Uint8Array(await new Bun.Image(rgbaFixture).webp({ lossless: true, quality: 100 }).toBuffer())
    const beforeWebp = extractWebpXmp(webp)
    expect(beforeWebp.chunkTypes).toEqual(["VP8L"])

    const png = new Uint8Array(
      await new Bun.Image(rgbaFixture)
        .png({ colors: 256, compressionLevel: 6, dither: false, palette: false })
        .toBuffer(),
    )

    const webpV2 = injectXmp(injectXmp(webp, SAMPLE_XMP), REPLACEMENT_XMP)
    const pngV2 = injectXmp(injectXmp(png, SAMPLE_XMP), REPLACEMENT_XMP)

    const webpParsed = extractWebpXmp(webpV2)
    expect(webpParsed.riffSizeMatches).toBe(true)
    expect(webpParsed.chunkTypes).toEqual(["VP8X", "VP8L", "XMP "])
    expect(webpParsed.vp8xFlags).toBe(0x14) // VP8X_FLAG_ALPHA (copied from VP8L bit 28) | VP8X_FLAG_XMP
    expect(webpParsed.xmp).toBe(REPLACEMENT_XMP)
    assertValidXmpXml(webpParsed.xmp)
    expect((await new Bun.Image(webpV2).metadata()).width).toBe(WIDTH)

    const pngParsed = extractPngXmp(pngV2)
    expect(pngParsed.count).toBe(1)
    expect(pngParsed.xmp).toBe(REPLACEMENT_XMP)
    assertValidXmpXml(pngParsed.xmp)
    expect((await new Bun.Image(pngV2).metadata()).width).toBe(WIDTH)
  })

  test("transformBunImageAsset pipeline stamps optional xmpXml onto indexed PNG and lossy/lossless WebP outputs", async () => {
    const pngResult = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: "public/assets/branding/sportsdesk-emblem.webp",
      format: "png",
      compressionLevel: 9,
      palette: true,
      colors: 64,
      dither: true,
      xmpXml: SAMPLE_XMP,
    })

    expect(pngResult.ok).toBe(true)
    expect(pngResult.pngColorType).toBe(3)
    expect(pngResult.xmpInjected).toBe(true)
    expect(pngResult.xmpBytes).toBeGreaterThan(0)

    const pngBytes = Uint8Array.from(Buffer.from(pngResult.dataUrl.replace("data:image/png;base64,", ""), "base64"))
    const pngParsed = extractPngXmp(pngBytes)
    expect(pngParsed.count).toBe(1)
    assertValidXmpXml(pngParsed.xmp, CREATOR_VALUE)

    const webpLossy = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: "public/assets/branding/sportsdesk-emblem.webp",
      format: "webp",
      lossless: false,
      quality: 85,
      xmpXml: SAMPLE_XMP,
    })

    expect(webpLossy.ok).toBe(true)
    expect(webpLossy.webpLossless).toBe(false)
    expect(webpLossy.xmpInjected).toBe(true)
    const webpLossyBytes = Uint8Array.from(
      Buffer.from(webpLossy.dataUrl.replace("data:image/webp;base64,", ""), "base64"),
    )
    const webpLossyParsed = extractWebpXmp(webpLossyBytes)
    expect(webpLossyParsed.riffSizeMatches).toBe(true)
    assertValidXmpXml(webpLossyParsed.xmp, CREATOR_VALUE)

    const webpLossless = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: "public/assets/branding/sportsdesk-emblem.webp",
      format: "webp",
      lossless: true,
      quality: 100,
      xmpXml: SAMPLE_XMP,
    })

    expect(webpLossless.ok).toBe(true)
    expect(webpLossless.webpLossless).toBe(true)
    expect(webpLossless.xmpInjected).toBe(true)
    const webpLosslessBytes = Uint8Array.from(
      Buffer.from(webpLossless.dataUrl.replace("data:image/webp;base64,", ""), "base64"),
    )
    const webpLosslessParsed = extractWebpXmp(webpLosslessBytes)
    expect(webpLosslessParsed.riffSizeMatches).toBe(true)
    assertValidXmpXml(webpLosslessParsed.xmp, CREATOR_VALUE)
  })
})
