/**
 * @file server/xmp_injector.ts
 * @description Zero-dependency UTF-8 XMP injector for WebP (RIFF) & PNG (iTXt).
 */

const encoder = new TextEncoder()

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const XMP_PNG_PREFIX = encoder.encode("XML:com.adobe.xmp\0\0\0\0\0")
const XMP_PNG_KEYWORD = encoder.encode("XML:com.adobe.xmp\0")

const VP8X_FLAG_XMP = 0x04
const VP8X_FLAG_ALPHA = 0x10

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

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function readFourCC(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(
    buf[offset]!,
    buf[offset + 1]!,
    buf[offset + 2]!,
    buf[offset + 3]!,
  )
}

function writeFourCC(buf: Uint8Array, offset: number, fourCC: string): void {
  buf[offset] = fourCC.charCodeAt(0)
  buf[offset + 1] = fourCC.charCodeAt(1)
  buf[offset + 2] = fourCC.charCodeAt(2)
  buf[offset + 3] = fourCC.charCodeAt(3)
}

function startsWith(buf: Uint8Array, offset: number, prefix: Uint8Array): boolean {
  if (offset + prefix.length > buf.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (buf[offset + i] !== prefix[i]) return false
  }
  return true
}

function writeUint24LE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff
  buf[offset + 1] = (value >>> 8) & 0xff
  buf[offset + 2] = (value >>> 16) & 0xff
}

/**
 * Injects or replaces a UTF-8 XMP packet in a WebP RIFF container.
 * Automatically promotes simple VP8 / VP8L containers to VP8X.
 */
export function injectWebpXmp(webp: Uint8Array, xmpXml: string): Uint8Array {
  if (
    webp.byteLength < 12 ||
    readFourCC(webp, 0) !== "RIFF" ||
    readFourCC(webp, 8) !== "WEBP"
  ) {
    throw new Error("ERR_XMP_INVALID_WEBP: Missing RIFF/WEBP header")
  }

  const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength)
  const xmpBytes = encoder.encode(xmpXml)
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

  return new Uint8Array(Bun.concatArrayBuffers(parts))
}

/**
 * Injects or replaces a UTF-8 XMP packet in a PNG iTXt chunk immediately before IEND.
 */
export function injectPngXmp(png: Uint8Array, xmpXml: string): Uint8Array {
  if (!startsWith(png, 0, PNG_SIG)) {
    throw new Error("ERR_XMP_INVALID_PNG: Missing 8-byte PNG signature")
  }

  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const xmpBytes = encoder.encode(xmpXml)

  const payloadLen = XMP_PNG_PREFIX.byteLength + xmpBytes.byteLength
  const itxtChunk = new Uint8Array(12 + payloadLen)
  const itxtView = new DataView(itxtChunk.buffer)
  itxtView.setUint32(0, payloadLen, false)
  writeFourCC(itxtChunk, 4, "iTXt")
  itxtChunk.set(XMP_PNG_PREFIX, 8)
  itxtChunk.set(xmpBytes, 8 + XMP_PNG_PREFIX.byteLength)
  itxtView.setUint32(8 + payloadLen, crc32(itxtChunk.subarray(4, 8 + payloadLen)), false)

  const parts: Uint8Array[] = [PNG_SIG]
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

  return new Uint8Array(Bun.concatArrayBuffers(parts))
}

/** Auto-detects WebP or PNG by magic bytes and injects UTF-8 XMP. */
export function injectXmp(imageBytes: Uint8Array, xmpXml: string): Uint8Array {
  if (startsWith(imageBytes, 0, PNG_SIG)) {
    return injectPngXmp(imageBytes, xmpXml)
  }
  if (
    imageBytes.byteLength >= 12 &&
    readFourCC(imageBytes, 0) === "RIFF" &&
    readFourCC(imageBytes, 8) === "WEBP"
  ) {
    return injectWebpXmp(imageBytes, xmpXml)
  }
  throw new Error("ERR_XMP_UNSUPPORTED_FORMAT: Expected WebP (RIFF/WEBP) or PNG")
}
