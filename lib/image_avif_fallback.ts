/**
 * @file lib/image_avif_fallback.ts
 * @description Capability-cached AVIF -> WebP encoder fallback (`ERR_IMAGE_FORMAT_UNSUPPORTED`)
 * that preserves `outBlob.type` for R2 (`s3.file(key, { type })`) and `string | Blob` RPC payloads.
 */
import { type BinaryInput, toBytes } from "./binary.ts"
import { injectXmp } from "./xmp_container.ts"

export type TranscodeFormat = "webp" | "jpeg" | "png" | "avif" | "heic"

export interface ImageEncodeRequest {
  readonly format: TranscodeFormat
  readonly quality?: number | undefined
  readonly lossless?: boolean | undefined
  readonly compressionLevel?: number | undefined
  readonly palette?: boolean | undefined
  readonly colors?: number | undefined
  readonly dither?: boolean | undefined
  readonly xmpXml?: string | undefined
}

export interface ImageEncodeOutput {
  readonly requestedFormat: TranscodeFormat
  readonly outputFormat: TranscodeFormat
  readonly mimeType: string
  readonly bytes: Uint8Array
  readonly blob: Blob
  readonly fallbackApplied: boolean
  readonly fallbackReason?: "ERR_IMAGE_FORMAT_UNSUPPORTED" | undefined
  readonly xmpInjected: boolean
  readonly xmpBytes?: number | undefined
}

export interface ImageEncoderPipeline {
  webp(options?: { lossless: boolean; quality: number }): { bytes(): Promise<Uint8Array> }
  jpeg(options?: { quality?: number }): { bytes(): Promise<Uint8Array> }
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
    dither?: boolean
  }): { bytes(): Promise<Uint8Array> }
  avif(options?: { quality?: number }): { bytes(): Promise<Uint8Array> }
  heic(options?: { quality?: number }): { bytes(): Promise<Uint8Array> }
}

/**
 * Minimal S3/R2 client contract supporting `s3.file(key, { type })` so `outBlob.type`
 * flows cleanly into R2 `Content-Type` headers without ambient globals.
 */
export interface R2FileClientLike {
  file(
    key: string,
    options?: { readonly type?: string | undefined },
  ): {
    write(data: Blob | Uint8Array | string): Promise<number | void>
  }
}

export type ImageRpcPayload = string | Blob

let cachedAvifEncodeSupported: boolean | null = null

export function getCachedAvifEncodeCapability(): boolean | null {
  return cachedAvifEncodeSupported
}

export function resetAvifEncodeCapabilityCache(): void {
  cachedAvifEncodeSupported = null
}

export function isAvifFormatUnsupportedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : ""
  if (code === "ERR_IMAGE_FORMAT_UNSUPPORTED") return true
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes("ERR_IMAGE_FORMAT_UNSUPPORTED") ||
    message.includes("format not supported on this machine")
  )
}

export function mimeTypeForFormat(format: TranscodeFormat): string {
  switch (format) {
    case "webp":
      return "image/webp"
    case "jpeg":
      return "image/jpeg"
    case "png":
      return "image/png"
    case "avif":
      return "image/avif"
    case "heic":
      return "image/heic"
  }
}

function toTypedBlob(bytes: Uint8Array, mimeType: string): Blob {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return new Blob([copy], { type: mimeType })
}

/**
 * Encodes an image pipeline with capability-cached AVIF -> WebP fallback:
 * - On the first `ERR_IMAGE_FORMAT_UNSUPPORTED` from `pipeline.avif(...)`, caches
 *   `cachedAvifEncodeSupported = false` and immediately re-encodes via a fresh WebP pipeline
 *   with strict `{ lossless: false, quality }`.
 * - Subsequent `"avif"` requests skip the failing native call immediately and go straight to WebP.
 * - Preserves the true output MIME type on `outBlob.type` (`"image/avif"` or `"image/webp"`),
 *   and stamps optional UTF-8 XMP whenever the resolved output format is `"webp"` or `"png"`.
 */
export async function encodeImageWithAvifFallback(
  createPipeline: () => ImageEncoderPipeline,
  req: ImageEncodeRequest,
): Promise<ImageEncodeOutput> {
  const quality = Math.min(100, Math.max(1, Math.round(req.quality ?? 80)))
  const webpLossless = Boolean(req.lossless)
  const compressionLevel = Math.min(9, Math.max(0, Math.round(req.compressionLevel ?? 6)))
  const pngPalette = Boolean(req.palette)
  const pngColors = Math.min(256, Math.max(2, Math.round(req.colors ?? 256)))
  const pngDither = req.dither ?? true
  const pngOptions = pngPalette
    ? { compressionLevel, palette: true, colors: pngColors, dither: pngDither }
    : { compressionLevel }

  let outputFormat: TranscodeFormat = req.format
  let fallbackApplied = false
  let fallbackReason: "ERR_IMAGE_FORMAT_UNSUPPORTED" | undefined
  let outBytes: Uint8Array

  if (req.format === "avif") {
    if (cachedAvifEncodeSupported === false) {
      outBytes = await createPipeline().webp({ lossless: false, quality }).bytes()
      outputFormat = "webp"
      fallbackApplied = true
      fallbackReason = "ERR_IMAGE_FORMAT_UNSUPPORTED"
    } else {
      try {
        outBytes = await createPipeline().avif({ quality }).bytes()
        cachedAvifEncodeSupported = true
        outputFormat = "avif"
      } catch (err) {
        if (!isAvifFormatUnsupportedError(err)) throw err
        cachedAvifEncodeSupported = false
        outBytes = await createPipeline().webp({ lossless: false, quality }).bytes()
        outputFormat = "webp"
        fallbackApplied = true
        fallbackReason = "ERR_IMAGE_FORMAT_UNSUPPORTED"
      }
    }
  } else {
    const pipeline = createPipeline()
    const chain =
      req.format === "webp"
        ? pipeline.webp({ lossless: webpLossless, quality })
        : req.format === "jpeg"
          ? pipeline.jpeg({ quality })
          : req.format === "png"
            ? pipeline.png(pngOptions)
            : pipeline.heic({ quality })
    outBytes = await chain.bytes()
  }

  let xmpInjected = false
  let xmpBytes: number | undefined
  if (
    typeof req.xmpXml === "string" &&
    req.xmpXml.trim().length > 0 &&
    (outputFormat === "png" || outputFormat === "webp")
  ) {
    outBytes = injectXmp(outBytes, req.xmpXml)
    xmpInjected = true
    xmpBytes = new TextEncoder().encode(req.xmpXml).byteLength
  }

  const mimeType = mimeTypeForFormat(outputFormat)
  const blob = toTypedBlob(outBytes, mimeType)

  return {
    requestedFormat: req.format,
    outputFormat,
    mimeType,
    bytes: outBytes,
    blob,
    fallbackApplied,
    ...(fallbackReason ? { fallbackReason } : {}),
    xmpInjected,
    ...(xmpBytes !== undefined ? { xmpBytes } : {}),
  }
}

/**
 * Writes an encoded image `Blob` to R2 using `s3.file(key, { type: outBlob.type })`
 * so the stored R2 `Content-Type` always reflects the resolved output format
 * (e.g. `image/webp` after an AVIF -> WebP fallback rather than a stale `image/avif`).
 */
export async function writeImageBlobToR2(
  s3: R2FileClientLike,
  key: string,
  outBlob: Blob,
): Promise<{ readonly key: string; readonly type: string; readonly bytesWritten: number }> {
  const type = outBlob.type || "application/octet-stream"
  const file = s3.file(key, { type })
  const written = await file.write(outBlob)
  return {
    key,
    type,
    bytesWritten: typeof written === "number" ? written : outBlob.size,
  }
}

/**
 * Formats an encoded image `Blob` for `string | Blob` RPC boundaries:
 * - `"blob"` returns the `Blob` directly with `outBlob.type` intact.
 * - `"data-url"` encodes as `data:${outBlob.type};base64,...` preserving the resolved MIME type.
 */
export async function toImageRpcPayload(
  outBlob: Blob,
  transport: "blob" | "data-url" = "blob",
): Promise<ImageRpcPayload> {
  if (transport === "blob") {
    return outBlob
  }
  const bytes = await toBytes(outBlob)
  const mime = outBlob.type || "application/octet-stream"
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`
}
