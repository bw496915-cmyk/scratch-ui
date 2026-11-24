/**
 * Single-source image container sniffer, metadata reader, and zero-dependency UTF-8 XMP injector
 * for WebP (RIFF VP8/VP8L -> VP8X with 0x04 | 0x10, even-padded `XMP `), PNG (`tEXt` + `iTXt`
 * before `IEND`), and explicit AVIF (`image/avif` ISOBMFF) handling.
 *
 * @file Lib/xmp_container.ts
 */
import { type BinaryInput, concatBytes, crc32Bytes, toBytes } from "./binary.ts"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const XMP_PNG_PREFIX = textEncoder.encode("XML:com.adobe.xmp\0\0\0\0\0")
export const XMP_PNG_KEYWORD = textEncoder.encode("XML:com.adobe.xmp\0")

export const VP8X_FLAG_XMP = 0x04
export const VP8X_FLAG_ALPHA = 0x10

// Standard Adobe XMP UUID box identifier inside ISO-BMFF containers (AVIF/HEIF)
const XMP_ISOBMFF_UUID = new Uint8Array([
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91, 0xe3, 0xaf, 0xac,
])

const AVIF_BRANDS = new Set(["avif", "avis"])

export type SniffedImageFormat = "webp" | "png" | "avif" | "jpeg" | "gif" | "unknown"

export interface XmpContainerHandlingRow {
  readonly format: "webp" | "png" | "avif"
  readonly mimeType: "image/webp" | "image/png" | "image/avif"
  readonly container: "RIFF/VP8X" | "PNG/iTXt" | "ISOBMFF/ftyp"
  readonly canReadXmp: boolean
  readonly canInjectXmp: boolean
  readonly xmpChannel: "webp-xmp" | "png-xmp" | null
  readonly notes: string
}

/** Explicit container handling matrix covering WebP, PNG, and AVIF (`image/avif`). */
export const XMP_CONTAINER_MATRIX: readonly XmpContainerHandlingRow[] = [
  {
    format: "webp",
    mimeType: "image/webp",
    container: "RIFF/VP8X",
    canReadXmp: true,
    canInjectXmp: true,
    xmpChannel: "webp-xmp",
    notes:
      "Promotes VP8/VP8L to VP8X (flags 0x04 | 0x10 when alpha present), writes even-padded XMP  chunk, updates RIFF size = total - 8",
  },
  {
    format: "png",
    mimeType: "image/png",
    container: "PNG/iTXt",
    canReadXmp: true,
    canInjectXmp: true,
    xmpChannel: "png-xmp",
    notes:
      "Reads IHDR/tEXt/iTXt and injects uncompressed UTF-8 XML:com.adobe.xmp iTXt chunk with CRC-32 immediately before IEND",
  },
  {
    format: "avif",
    mimeType: "image/avif",
    container: "ISOBMFF/ftyp",
    canReadXmp: true,
    canInjectXmp: false,
    xmpChannel: null,
    notes:
      "Sniffs image/avif via ISOBMFF ftyp avif/avis brands and inspects read-only UUID XMP boxes; direct XMP injection is explicitly rejected in favor of AVIF -> WebP fallback",
  },
] as const

export interface SniffedImageInfo {
  readonly format: SniffedImageFormat
  readonly mimeType: string
  readonly supportsXmpInjection: boolean
  readonly xmpChannel: "webp-xmp" | "png-xmp" | null
}

function readFourCC(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(buf[offset]!, buf[offset + 1]!, buf[offset + 2]!, buf[offset + 3]!)
}

function writeFourCC(buf: Uint8Array, offset: number, fourCC: string): void {
  buf[offset] = fourCC.charCodeAt(0)
  buf[offset + 1] = fourCC.charCodeAt(1)
  buf[offset + 2] = fourCC.charCodeAt(2)
  buf[offset + 3] = fourCC.charCodeAt(3)
}

function startsWith(buf: Uint8Array, offset: number, prefix: Uint8Array): boolean {
  if (offset < 0 || offset + prefix.byteLength > buf.byteLength) return false
  for (let i = 0; i < prefix.byteLength; i++) {
    if (buf[offset + i] !== prefix[i]) return false
  }
  return true
}

function writeUint24LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
}

function readUint24LE(buf: Uint8Array, offset: number): number {
  return buf[offset]! | (buf[offset + 1]! << 8) | (buf[offset + 2]! << 16)
}

function readAvifFtypBrands(bytes: Uint8Array): readonly string[] {
  if (bytes.byteLength < 12 || readFourCC(bytes, 4) !== "ftyp") return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rawBoxSize = view.getUint32(0, false)
  const boxSize = rawBoxSize === 0 ? bytes.byteLength : Math.min(rawBoxSize, bytes.byteLength)
  if (boxSize < 12) return []

  const brands: string[] = [readFourCC(bytes, 8)]
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    brands.push(readFourCC(bytes, offset))
  }
  return brands
}

/** Magic-byte format sniffer for WebP, PNG, AVIF (`image/avif`), JPEG, and GIF. */
export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat {
  if (startsWith(bytes, 0, PNG_SIGNATURE)) return "png"
  if (
    bytes.byteLength >= 12 &&
    readFourCC(bytes, 0) === "RIFF" &&
    readFourCC(bytes, 8) === "WEBP"
  ) {
    return "webp"
  }
  if (bytes.byteLength >= 12 && readFourCC(bytes, 4) === "ftyp") {
    const brands = readAvifFtypBrands(bytes)
    if (brands.some((b) => AVIF_BRANDS.has(b))) {
      return "avif"
    }
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg"
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "gif"
  }
  return "unknown"
}

export function sniffImageInfo(bytes: Uint8Array): SniffedImageInfo {
  const format = sniffImageFormat(bytes)
  switch (format) {
    case "webp":
      return {
        format: "webp",
        mimeType: "image/webp",
        supportsXmpInjection: true,
        xmpChannel: "webp-xmp",
      }
    case "png":
      return {
        format: "png",
        mimeType: "image/png",
        supportsXmpInjection: true,
        xmpChannel: "png-xmp",
      }
    case "avif":
      return {
        format: "avif",
        mimeType: "image/avif",
        supportsXmpInjection: false,
        xmpChannel: null,
      }
    case "jpeg":
      return {
        format: "jpeg",
        mimeType: "image/jpeg",
        supportsXmpInjection: false,
        xmpChannel: null,
      }
    case "gif":
      return {
        format: "gif",
        mimeType: "image/gif",
        supportsXmpInjection: false,
        xmpChannel: null,
      }
    default:
      return {
        format: "unknown",
        mimeType: "application/octet-stream",
        supportsXmpInjection: false,
        xmpChannel: null,
      }
  }
}

/**
 * Injects or replaces a UTF-8 XMP packet in a WebP RIFF container. Promotes simple `VP8 ` / `VP8L`
 * containers to `VP8X` (`0x04 | 0x10` when alpha present), writes an even-padded `XMP ` chunk, and
 * sets RIFF size = `totalBytes - 8`.
 */
export function injectWebpXmp(webp: Uint8Array, xmpXml: string): Uint8Array {
  if (webp.byteLength < 12 || readFourCC(webp, 0) !== "RIFF" || readFourCC(webp, 8) !== "WEBP") {
    throw new Error("ERR_XMP_INVALID_WEBP: Missing RIFF/WEBP header")
  }

  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength)
  const xmpBytes = textEncoder.encode(xmpXml)
  const xmpPaddedLen = xmpBytes.byteLength + (xmpBytes.byteLength & 1)

  const keptChunks: Uint8Array[] = []
  let hasVp8x = false
  let canvasWidthMinus1 = 0
  let canvasHeightMinus1 = 0
  let vp8xFlags = VP8X_FLAG_XMP

  let offset = 12
  while (offset + 8 <= webp.byteLength) {
    const fourCC = readFourCC(webp, offset)
    const size = view.getUint32(offset + 4, true)
    const paddedSize = size + (size & 1)
    const chunkEnd = offset + 8 + paddedSize

    if (chunkEnd > webp.byteLength) {
      throw new Error(`ERR_XMP_TRUNCATED_CHUNK: Chunk "${fourCC}" exceeds buffer`)
    }

    if (fourCC === "XMP ") {
      offset = chunkEnd
      continue
    }

    const chunkSlice = webp.subarray(offset, chunkEnd)

    if (fourCC === "VP8X") {
      if (size < 10) throw new Error("ERR_XMP_INVALID_VP8X: Payload shorter than 10 bytes")
      hasVp8x = true
      const patched = new Uint8Array(chunkSlice)
      patched[8] = patched[8]! | VP8X_FLAG_XMP
      keptChunks.push(patched)
    } else {
      if (!hasVp8x && fourCC === "VP8 ") {
        const p = offset + 8
        if (size < 10 || webp[p + 3] !== 0x9d || webp[p + 4] !== 0x01 || webp[p + 5] !== 0x2a) {
          throw new Error("ERR_XMP_INVALID_VP8: Missing VP8 keyframe start code")
        }
        canvasWidthMinus1 = (view.getUint16(p + 6, true) & 0x3fff) - 1
        canvasHeightMinus1 = (view.getUint16(p + 8, true) & 0x3fff) - 1
      } else if (!hasVp8x && fourCC === "VP8L") {
        const p = offset + 8
        if (size < 5 || webp[p] !== 0x2f) {
          throw new Error("ERR_XMP_INVALID_VP8L: Missing VP8L signature byte")
        }
        const bits = view.getUint32(p + 1, true)
        canvasWidthMinus1 = bits & 0x3fff
        canvasHeightMinus1 = (bits >>> 14) & 0x3fff
        if (((bits >>> 28) & 1) === 1) {
          vp8xFlags |= VP8X_FLAG_ALPHA
        }
      }
      keptChunks.push(chunkSlice)
    }

    offset = chunkEnd
  }

  let vp8xChunk: Uint8Array | null = null
  if (!hasVp8x) {
    vp8xChunk = new Uint8Array(18)
    const vp8xView = new DataView(vp8xChunk.buffer)
    writeFourCC(vp8xChunk, 0, "VP8X")
    vp8xView.setUint32(4, 10, true)
    vp8xChunk[8] = vp8xFlags
    writeUint24LE(vp8xChunk, 12, canvasWidthMinus1)
    writeUint24LE(vp8xChunk, 15, canvasHeightMinus1)
  }

  const xmpChunk = new Uint8Array(8 + xmpPaddedLen)
  const xmpView = new DataView(xmpChunk.buffer)
  writeFourCC(xmpChunk, 0, "XMP ")
  xmpView.setUint32(4, xmpBytes.byteLength, true)
  xmpChunk.set(xmpBytes, 8)

  let riffPayloadSize = 4 + (vp8xChunk?.byteLength ?? 0) + xmpChunk.byteLength
  for (const chunk of keptChunks) riffPayloadSize += chunk.byteLength

  const riffHeader = new Uint8Array(12)
  writeFourCC(riffHeader, 0, "RIFF")
  new DataView(riffHeader.buffer).setUint32(4, riffPayloadSize, true)
  writeFourCC(riffHeader, 8, "WEBP")

  const parts: Uint8Array[] = [riffHeader]
  if (vp8xChunk) parts.push(vp8xChunk)
  parts.push(...keptChunks, xmpChunk)

  return concatBytes(parts)
}

export interface ExtractedWebpXmp {
  readonly xmp: string | null
  readonly vp8xFlags: number | null
  readonly riffSizeMatches: boolean
  readonly chunkTypes: readonly string[]
  readonly width: number | null
  readonly height: number | null
  readonly truncated: boolean
}

/**
 * Walks a WebP RIFF container to extract dimensions, `VP8X` flags, chunk sequence, RIFF length
 * integrity (`riffSize === total - 8`), and UTF-8 `XMP ` payload.
 */
export function extractWebpXmp(webp: Uint8Array): ExtractedWebpXmp {
  if (webp.byteLength < 12 || readFourCC(webp, 0) !== "RIFF" || readFourCC(webp, 8) !== "WEBP") {
    return {
      xmp: null,
      vp8xFlags: null,
      riffSizeMatches: false,
      chunkTypes: [],
      width: null,
      height: null,
      truncated: true,
    }
  }

  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength)
  const riffSize = view.getUint32(4, true)
  let vp8xFlags: number | null = null
  let xmp: string | null = null
  let width: number | null = null
  let height: number | null = null
  let truncated = false
  const chunkTypes: string[] = []

  let offset = 12
  while (offset + 8 <= webp.byteLength) {
    const fourCC = readFourCC(webp, offset)
    const size = view.getUint32(offset + 4, true)
    const paddedSize = size + (size & 1)
    const chunkEnd = offset + 8 + paddedSize
    if (chunkEnd > webp.byteLength) {
      truncated = true
      break
    }
    chunkTypes.push(fourCC)

    if (fourCC === "VP8X" && size >= 10) {
      vp8xFlags = webp[offset + 8]!
      width = readUint24LE(webp, offset + 12) + 1
      height = readUint24LE(webp, offset + 15) + 1
    } else if (fourCC === "VP8 " && width === null && size >= 10) {
      const p = offset + 8
      if (webp[p + 3] === 0x9d && webp[p + 4] === 0x01 && webp[p + 5] === 0x2a) {
        width = view.getUint16(p + 6, true) & 0x3fff
        height = view.getUint16(p + 8, true) & 0x3fff
      }
    } else if (fourCC === "VP8L" && width === null && size >= 5 && webp[offset + 8] === 0x2f) {
      const bits = view.getUint32(offset + 9, true)
      width = (bits & 0x3fff) + 1
      height = ((bits >>> 14) & 0x3fff) + 1
    } else if (fourCC === "XMP ") {
      xmp = textDecoder.decode(webp.subarray(offset + 8, offset + 8 + size))
    }
    offset = chunkEnd
  }

  return {
    xmp,
    vp8xFlags,
    riffSizeMatches: riffSize === webp.byteLength - 8,
    chunkTypes,
    width,
    height,
    truncated,
  }
}

/**
 * Injects or replaces a UTF-8 XMP packet in a PNG `iTXt` chunk immediately before `IEND`, computing
 * the chunk CRC-32 via `crc32Bytes` from `lib/binary.ts`.
 */
export function injectPngXmp(png: Uint8Array, xmpXml: string): Uint8Array {
  if (!startsWith(png, 0, PNG_SIGNATURE)) {
    throw new Error("ERR_XMP_INVALID_PNG: Missing 8-byte PNG signature")
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const xmpBytes = textEncoder.encode(xmpXml)

  const payloadLen = XMP_PNG_PREFIX.byteLength + xmpBytes.byteLength
  const itxtChunk = new Uint8Array(12 + payloadLen)
  const itxtView = new DataView(itxtChunk.buffer)
  itxtView.setUint32(0, payloadLen, false)
  writeFourCC(itxtChunk, 4, "iTXt")
  itxtChunk.set(XMP_PNG_PREFIX, 8)
  itxtChunk.set(xmpBytes, 8 + XMP_PNG_PREFIX.byteLength)
  itxtView.setUint32(8 + payloadLen, crc32Bytes(itxtChunk.subarray(4, 8 + payloadLen)), false)

  const parts: Uint8Array[] = [PNG_SIGNATURE]
  let inserted = false
  let offset = 8

  while (offset + 12 <= png.byteLength) {
    const length = view.getUint32(offset, false)
    const type = readFourCC(png, offset + 4)
    const chunkEnd = offset + 12 + length

    if (chunkEnd > png.byteLength) {
      throw new Error(`ERR_XMP_TRUNCATED_CHUNK: PNG chunk "${type}" exceeds buffer`)
    }

    if (type === "iTXt" && startsWith(png, offset + 8, XMP_PNG_KEYWORD)) {
      offset = chunkEnd
      continue
    }

    if (type === "IEND" && !inserted) {
      parts.push(itxtChunk)
      inserted = true
    }

    parts.push(png.subarray(offset, chunkEnd))
    offset = chunkEnd
  }

  if (!inserted) {
    throw new Error("ERR_XMP_MISSING_IEND: PNG stream has no IEND chunk")
  }

  return concatBytes(parts)
}

export interface ExtractedPngMetadata {
  readonly xmp: string | null
  readonly xmpCount: number
  readonly textEntries: Readonly<Record<string, string>>
  readonly chunkTypes: readonly string[]
  readonly width: number | null
  readonly height: number | null
  readonly colorType: number | null
  readonly truncated: boolean
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.byteLength; i++) {
    out += String.fromCharCode(bytes[i]!)
  }
  return out
}

/**
 * Walks a PNG stream once to read `IHDR` geometry/color-type, `tEXt` key/value pairs, and
 * uncompressed UTF-8 `iTXt` chunks (both `XML:com.adobe.xmp` and key/value text entries).
 */
export function extractPngMetadata(png: Uint8Array): ExtractedPngMetadata {
  if (!startsWith(png, 0, PNG_SIGNATURE)) {
    return {
      xmp: null,
      xmpCount: 0,
      textEntries: {},
      chunkTypes: [],
      width: null,
      height: null,
      colorType: null,
      truncated: true,
    }
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const chunkTypes: string[] = []
  const textEntries: Record<string, string> = {}
  let xmp: string | null = null
  let xmpCount = 0
  let width: number | null = null
  let height: number | null = null
  let colorType: number | null = null
  let truncated = false

  let offset = 8
  while (offset + 12 <= png.byteLength) {
    const length = view.getUint32(offset, false)
    const type = readFourCC(png, offset + 4)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > png.byteLength) {
      truncated = true
      break
    }

    chunkTypes.push(type)
    const payload = png.subarray(offset + 8, offset + 8 + length)

    if (type === "IHDR" && payload.byteLength >= 13) {
      const ihdrView = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      width = ihdrView.getUint32(0, false)
      height = ihdrView.getUint32(4, false)
      colorType = payload[9]!
    } else if (type === "tEXt") {
      const nul = payload.indexOf(0)
      if (nul > 0) {
        const key = decodeLatin1(payload.subarray(0, nul))
        const val = decodeLatin1(payload.subarray(nul + 1))
        textEntries[key] = val
      }
    } else if (type === "iTXt") {
      const nul = payload.indexOf(0)
      if (nul > 0 && nul + 2 < payload.byteLength) {
        const keyword = decodeLatin1(payload.subarray(0, nul))
        const compressionFlag = payload[nul + 1]!
        // Skip compression method byte (nul + 2), then languageTag\0 and translatedKeyword\0
        const langEnd = payload.indexOf(0, nul + 3)
        const transEnd = langEnd >= 0 ? payload.indexOf(0, langEnd + 1) : -1
        if (compressionFlag === 0 && transEnd >= 0) {
          const text = textDecoder.decode(payload.subarray(transEnd + 1))
          if (keyword === "XML:com.adobe.xmp") {
            xmp = text
            xmpCount += 1
          } else {
            textEntries[keyword] = text
          }
        }
      }
    }

    offset = chunkEnd
    if (type === "IEND") break
  }

  return {
    xmp,
    xmpCount,
    textEntries,
    chunkTypes,
    width,
    height,
    colorType,
    truncated,
  }
}

export function extractPngXmp(png: Uint8Array): {
  readonly xmp: string | null
  readonly count: number
  readonly chunkTypes: readonly string[]
} {
  const meta = extractPngMetadata(png)
  return {
    xmp: meta.xmp,
    count: meta.xmpCount,
    chunkTypes: meta.chunkTypes,
  }
}

export interface ExtractedAvifInfo {
  readonly isAvif: boolean
  readonly mimeType: "image/avif"
  readonly brands: readonly string[]
  readonly xmp: string | null
  readonly width: number | null
  readonly height: number | null
}

/**
 * Explicit read-only ISOBMFF handler for `image/avif`: inspects `ftyp` brands, optional `ispe`
 * spatial extent dimensions, and Adobe XMP UUID boxes if present.
 */
export function extractAvifMetadata(avif: Uint8Array): ExtractedAvifInfo {
  const brands = readAvifFtypBrands(avif)
  const isAvif = brands.some((b) => AVIF_BRANDS.has(b))
  if (!isAvif) {
    return {
      isAvif: false,
      mimeType: "image/avif",
      brands,
      xmp: null,
      width: null,
      height: null,
    }
  }

  const view = new DataView(avif.buffer, avif.byteOffset, avif.byteLength)
  let xmp: string | null = null
  let width: number | null = null
  let height: number | null = null

  // Walk top-level ISOBMFF boxes for `uuid` XMP box (standard Adobe XMP UUID)
  let offset = 0
  while (offset + 8 <= avif.byteLength) {
    const rawSize = view.getUint32(offset, false)
    const boxType = readFourCC(avif, offset + 4)
    const boxSize = rawSize === 0 ? avif.byteLength - offset : rawSize
    if (boxSize < 8 || offset + boxSize > avif.byteLength) break

    if (boxType === "uuid" && boxSize >= 24 && startsWith(avif, offset + 8, XMP_ISOBMFF_UUID)) {
      xmp = textDecoder.decode(avif.subarray(offset + 24, offset + boxSize))
    } else if (boxType === "meta") {
      // Scan inside meta box for `ispe` (ImageSpatialExtentsProperty: 12-byte fullbox header + u32 w + u32 h)
      const metaEnd = offset + boxSize
      for (let i = offset + 12; i + 20 <= metaEnd; i++) {
        if (
          avif[i + 4] === 0x69 && // 'i'
          avif[i + 5] === 0x73 && // 's'
          avif[i + 6] === 0x70 && // 'p'
          avif[i + 7] === 0x65 // 'e'
        ) {
          const ispeSize = view.getUint32(i, false)
          if (ispeSize === 20 && i + 20 <= metaEnd) {
            width = view.getUint32(i + 12, false)
            height = view.getUint32(i + 16, false)
            break
          }
        }
      }
    }

    offset += boxSize
  }

  return {
    isAvif: true,
    mimeType: "image/avif",
    brands,
    xmp,
    width,
    height,
  }
}

/**
 * Auto-detects WebP, PNG, or AVIF by magic bytes and injects UTF-8 XMP. AVIF (`image/avif`) is
 * explicitly rejected with `ERR_XMP_AVIF_UNSUPPORTED` so callers route through the AVIF -> WebP
 * fallback rather than corrupting ISOBMFF boxes.
 */
export function injectXmp(imageBytes: Uint8Array, xmpXml: string): Uint8Array {
  const format = sniffImageFormat(imageBytes)
  if (format === "png") {
    return injectPngXmp(imageBytes, xmpXml)
  }
  if (format === "webp") {
    return injectWebpXmp(imageBytes, xmpXml)
  }
  if (format === "avif") {
    throw new Error(
      "ERR_XMP_AVIF_UNSUPPORTED: Direct XMP injection into image/avif ISOBMFF containers is not supported; use AVIF -> WebP fallback",
    )
  }
  throw new Error("ERR_XMP_UNSUPPORTED_FORMAT: Expected WebP (RIFF/WEBP) or PNG")
}

/**
 * Accepts any `BinaryInput`, injects UTF-8 XMP for WebP or PNG, and returns a typed `Blob`
 * preserving the container's true MIME type (`image/webp` or `image/png`).
 */
export async function injectXmpIntoBlob(input: BinaryInput, xmpXml: string): Promise<Blob> {
  const bytes = await toBytes(input)
  const info = sniffImageInfo(bytes)
  const stamped = injectXmp(bytes, xmpXml)
  const copy = new Uint8Array(stamped.byteLength)
  copy.set(stamped)
  return new Blob([copy], { type: info.mimeType })
}

export interface ContainerMetadataSnapshot {
  readonly format: SniffedImageFormat
  readonly mimeType: string
  readonly byteLength: number
  readonly width: number | null
  readonly height: number | null
  readonly xmp: string | null
  readonly pngTextEntries: Readonly<Record<string, string>>
  readonly webpVp8xFlags: number | null
  readonly webpRiffSizeMatches: boolean | null
  readonly avifBrands: readonly string[]
  readonly issues: readonly string[]
}

/**
 * Single delegated container metadata inspector used by `lib/image_provenance.ts`. Avoids
 * duplicating RIFF/PNG/ISOBMFF walkers across consumers.
 */
export async function extractContainerMetadata(
  input: BinaryInput,
): Promise<ContainerMetadataSnapshot> {
  const bytes = await toBytes(input)
  const info = sniffImageInfo(bytes)
  const issues: string[] = []

  if (info.format === "webp") {
    const webp = extractWebpXmp(bytes)
    if (webp.truncated) issues.push("truncated_webp_container")
    if (!webp.riffSizeMatches) issues.push("webp_riff_size_mismatch")
    return {
      format: "webp",
      mimeType: info.mimeType,
      byteLength: bytes.byteLength,
      width: webp.width,
      height: webp.height,
      xmp: webp.xmp,
      pngTextEntries: {},
      webpVp8xFlags: webp.vp8xFlags,
      webpRiffSizeMatches: webp.riffSizeMatches,
      avifBrands: [],
      issues,
    }
  }

  if (info.format === "png") {
    const png = extractPngMetadata(bytes)
    if (png.truncated) issues.push("truncated_png_container")
    return {
      format: "png",
      mimeType: info.mimeType,
      byteLength: bytes.byteLength,
      width: png.width,
      height: png.height,
      xmp: png.xmp,
      pngTextEntries: png.textEntries,
      webpVp8xFlags: null,
      webpRiffSizeMatches: null,
      avifBrands: [],
      issues,
    }
  }

  if (info.format === "avif") {
    const avif = extractAvifMetadata(bytes)
    if (!avif.xmp) issues.push("avif_xmp_injection_unsupported")
    return {
      format: "avif",
      mimeType: "image/avif",
      byteLength: bytes.byteLength,
      width: avif.width,
      height: avif.height,
      xmp: avif.xmp,
      pngTextEntries: {},
      webpVp8xFlags: null,
      webpRiffSizeMatches: null,
      avifBrands: avif.brands,
      issues,
    }
  }

  if (info.format === "unknown") {
    issues.push("unsupported_image_container")
  }
  return {
    format: info.format,
    mimeType: info.mimeType,
    byteLength: bytes.byteLength,
    width: null,
    height: null,
    xmp: null,
    pngTextEntries: {},
    webpVp8xFlags: null,
    webpRiffSizeMatches: null,
    avifBrands: [],
    issues,
  }
}
