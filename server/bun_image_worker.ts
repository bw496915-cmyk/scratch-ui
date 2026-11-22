/**
 * @file server/bun_image_worker.ts
 * @description Native Bun 1.4.4 worker for `Bun.Image` scanning, byte-level format sniffing,
 * ThumbHash placeholder generation, SHA-256 hashing, and chained image transformations.
 *
 * Executed via `bun run server/bun_image_worker.ts <scan|transform>` with JSON on stdin.
 */
import { readdir, stat } from "node:fs/promises"
import { extname, join, relative, resolve } from "node:path"

import type { Image } from "bun"

const RASTER_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".heic", ".gif", ".ico"])

const VECTOR_EXTS = new Set([".svg"])

type SupportedOutputFormat = "webp" | "jpeg" | "png" | "avif" | "heic"
type ResampleFilter =
  "lanczos3" | "lanczos2" | "mitchell" | "cubic" | "bilinear" | "box" | "nearest"

interface ScanRequest {
  readonly cwd: string
  readonly roots: readonly string[]
}

interface TransformRequest {
  readonly fullPath: string
  readonly source: string
  readonly format: SupportedOutputFormat
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly fit?: "inside" | "fill" | undefined
  readonly withoutEnlargement?: boolean | undefined
  readonly filter?: ResampleFilter | undefined
  readonly quality?: number | undefined
  readonly compressionLevel?: number | undefined
  readonly palette?: boolean | undefined
  readonly colors?: number | undefined
  readonly dither?: boolean | undefined
  readonly rotate?: 0 | 90 | 180 | 270 | undefined
  readonly flip?: boolean | undefined
  readonly flop?: boolean | undefined
  readonly brightness?: number | undefined
  readonly saturation?: number | undefined
}

interface CodecSupportInfo {
  readonly format: SupportedOutputFormat
  readonly supported: boolean
  readonly note: string
}

function normalizeDeclaredFormat(ext: string): string {
  const clean = ext.toLowerCase().replace(/^\./, "")
  if (clean === "jpg") return "jpeg"
  return clean || "unknown"
}

function formatAspectRatio(width?: number, height?: number): string | undefined {
  if (!width || !height || width <= 0 || height <= 0) return undefined
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const d = gcd(width, height)
  const rw = Math.round(width / d)
  const rh = Math.round(height / d)
  if (rw <= 32 && rh <= 32) {
    return `${rw}:${rh}`
  }
  return `${(width / height).toFixed(2)}:1`
}

async function walkFiles(dir: string, out: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      await walkFiles(full, out)
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase()
      if (RASTER_EXTS.has(ext) || VECTOR_EXTS.has(ext)) {
        out.push(full)
      }
    }
  }
}

function hashBytesSha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(bytes)
  return hasher.digest("hex")
}

function parseSvgAttributes(text: string): {
  width?: number
  height?: number
  elementCount: number
} {
  const viewBox = /viewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(text)
  const wAttr = /\bwidth=["']\s*([\d.]+)(?:px)?\s*["']/i.exec(text)
  const hAttr = /\bheight=["']\s*([\d.]+)(?:px)?\s*["']/i.exec(text)
  const width = viewBox
    ? Math.round(Number(viewBox[1]))
    : wAttr
      ? Math.round(Number(wAttr[1]))
      : undefined
  const height = viewBox
    ? Math.round(Number(viewBox[2]))
    : hAttr
      ? Math.round(Number(hAttr[1]))
      : undefined
  const elements = text.match(/<(path|circle|rect|line|polygon|polyline|ellipse|text)\b/gi)
  return {
    width: Number.isFinite(width) && (width ?? 0) > 0 ? width : undefined,
    height: Number.isFinite(height) && (height ?? 0) > 0 ? height : undefined,
    elementCount: elements?.length ?? 0,
  }
}

// 1x1 transparent PNG used to probe live native encoder availability on this host
const PROBE_PNG_BYTES = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    "base64",
  ),
)

async function probeCodecSupport(): Promise<readonly CodecSupportInfo[]> {
  const formats: readonly SupportedOutputFormat[] = ["webp", "jpeg", "png", "avif", "heic"]
  const results: CodecSupportInfo[] = []
  for (const format of formats) {
    try {
      const img = new Bun.Image(PROBE_PNG_BYTES)
      const chain =
        format === "webp"
          ? img.webp({ quality: 80 })
          : format === "jpeg"
            ? img.jpeg({ quality: 80 })
            : format === "png"
              ? img.png({ compressionLevel: 6 })
              : format === "avif"
                ? img.avif({ quality: 65 })
                : img.heic({ quality: 75 })
      await chain.bytes()
      results.push({
        format,
        supported: true,
        note: `Native Bun.Image (${Bun.Image.backend}) encoder ready`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        format,
        supported: false,
        note: msg.includes("OS codec") ? "Requires OS codec (macOS/Windows AV1/HEVC)" : msg,
      })
    }
  }
  return results
}

async function runScan(req: ScanRequest): Promise<unknown> {
  const startedAt = performance.now()
  const discovered: Array<{ fullPath: string; root: string }> = []

  for (const root of req.roots) {
    const absRoot = resolve(req.cwd, root)
    const files: string[] = []
    await walkFiles(absRoot, files)
    files.sort()
    for (const fullPath of files) {
      discovered.push({ fullPath, root })
    }
  }

  const codecs = await probeCodecSupport()
  const assets: Array<Record<string, unknown>> = []
  const formatBreakdown: Record<string, number> = {}
  let totalBytes = 0
  let mismatchCount = 0

  for (const { fullPath, root } of discovered) {
    const relSource = relative(req.cwd, fullPath).replace(/\\/g, "/")
    const ext = extname(fullPath).toLowerCase()
    const declaredFormat = normalizeDeclaredFormat(ext)

    try {
      const st = await stat(fullPath)
      const bunFile = Bun.file(fullPath)
      const rawBytes = new Uint8Array(await bunFile.arrayBuffer())
      const sha256 = hashBytesSha256(rawBytes).slice(0, 12)
      totalBytes += st.size

      if (VECTOR_EXTS.has(ext)) {
        const text = new TextDecoder().decode(rawBytes)
        const svgInfo = parseSvgAttributes(text)
        formatBreakdown.svg = (formatBreakdown.svg ?? 0) + 1
        assets.push({
          type: "BunImageAssetDiagnostic",
          source: relSource,
          root,
          format: "svg",
          declaredFormat: "svg",
          formatMismatch: false,
          width: svgInfo.width,
          height: svgInfo.height,
          aspectRatio: formatAspectRatio(svgInfo.width, svgInfo.height),
          bytes: st.size,
          backend: "bun-svg-inspector",
          sha256,
          lastModified: st.mtime.toISOString(),
          vectorElementCount: svgInfo.elementCount,
          canTransform: false,
          mimeType: "image/svg+xml",
        })
        continue
      }

      const meta = await Bun.file(fullPath).image().metadata()
      const sniffedFormat = (meta.format ?? declaredFormat).toLowerCase()
      const formatMismatch = declaredFormat !== "unknown" && sniffedFormat !== declaredFormat
      if (formatMismatch) mismatchCount += 1

      let placeholderDataUrl: string | undefined
      try {
        placeholderDataUrl = await Bun.file(fullPath).image().placeholder()
      } catch {
        placeholderDataUrl = undefined
      }

      const megapixels =
        meta.width && meta.height
          ? Number(((meta.width * meta.height) / 1_000_000).toFixed(2))
          : undefined
      const bytesPerPixel =
        meta.width && meta.height && meta.width * meta.height > 0
          ? Number((st.size / (meta.width * meta.height)).toFixed(3))
          : undefined

      formatBreakdown[sniffedFormat] = (formatBreakdown[sniffedFormat] ?? 0) + 1

      assets.push({
        type: "BunImageAssetDiagnostic",
        source: relSource,
        root,
        format: sniffedFormat,
        declaredFormat,
        formatMismatch,
        width: meta.width,
        height: meta.height,
        aspectRatio: formatAspectRatio(meta.width, meta.height),
        megapixels,
        bytesPerPixel,
        bytes: st.size,
        backend: Bun.Image.backend ?? "bun",
        sha256,
        lastModified: st.mtime.toISOString(),
        placeholderDataUrl,
        canTransform: true,
        mimeType:
          sniffedFormat === "jpeg"
            ? "image/jpeg"
            : sniffedFormat === "png"
              ? "image/png"
              : sniffedFormat === "webp"
                ? "image/webp"
                : sniffedFormat === "avif"
                  ? "image/avif"
                  : sniffedFormat === "gif"
                    ? "image/gif"
                    : "application/octet-stream",
      })
    } catch (err) {
      assets.push({
        type: "BunImageAssetScanFailure",
        source: relSource,
        root,
        declaredFormat,
        backend: Bun.Image.backend ?? "bun",
        code: err instanceof Error ? err.message.slice(0, 80) : "DECODE_ERROR",
        canTransform: false,
      })
    }
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: req.roots.join(", "),
    roots: req.roots,
    visibility: "RISK_MANAGER",
    runtime: `Bun ${Bun.version}`,
    bunVersion: Bun.version,
    bunImageBackend: Bun.Image.backend ?? "bun",
    scanMs: Math.max(1, Math.round(performance.now() - startedAt)),
    totalBytes,
    mismatchCount,
    formatBreakdown,
    codecs,
    count: assets.length,
    total: assets.length,
    truncated: false,
    cached: false,
    assets,
  }
}

async function runTransform(req: TransformRequest): Promise<unknown> {
  const startedAt = performance.now()
  const bunFile = Bun.file(req.fullPath)
  const originalStat = await stat(req.fullPath)
  const originalMeta = await bunFile.image().metadata()

  let pipeline = Bun.file(req.fullPath).image()

  const width = req.width && req.width > 0 ? req.width : undefined
  const height = req.height && req.height > 0 ? req.height : undefined
  const resizeOpts: Image.ResizeOptions = {
    fit: req.fit ?? "inside",
    withoutEnlargement: req.withoutEnlargement ?? true,
  }
  if (req.filter) resizeOpts.filter = req.filter

  if (width !== undefined) {
    pipeline = pipeline.resize(width, height, resizeOpts)
  } else if (height !== undefined) {
    // Bun requires width. Metadata includes EXIF orientation, matching the resize pipeline.
    const targetHeight = resizeOpts.withoutEnlargement
      ? Math.min(height, originalMeta.height)
      : height
    const targetWidth = Math.max(
      1,
      Math.round((originalMeta.width * targetHeight) / originalMeta.height),
    )
    // Both dimensions encode the one-axis request; an "inside" pass can round the height again.
    pipeline = pipeline.resize(targetWidth, targetHeight, { ...resizeOpts, fit: "fill" })
  }

  if (req.rotate === 90 || req.rotate === 180 || req.rotate === 270) {
    pipeline = pipeline.rotate(req.rotate)
  }
  if (req.flip) {
    pipeline = pipeline.flip()
  }
  if (req.flop) {
    pipeline = pipeline.flop()
  }
  if (
    (req.brightness !== undefined && req.brightness !== 1) ||
    (req.saturation !== undefined && req.saturation !== 1)
  ) {
    pipeline = pipeline.modulate({
      brightness: req.brightness ?? 1,
      saturation: req.saturation ?? 1,
    })
  }

  const quality = Math.min(100, Math.max(1, Math.round(req.quality ?? 80)))
  const compressionLevel = Math.min(9, Math.max(0, Math.round(req.compressionLevel ?? 6)))
  const pngPalette = Boolean(req.palette)
  const pngColors = Math.min(256, Math.max(2, Math.round(req.colors ?? 256)))
  const pngDither = req.dither ?? true
  const pngOptions = pngPalette
    ? { compressionLevel, palette: true, colors: pngColors, dither: pngDither }
    : { compressionLevel }

  const encoded =
    req.format === "webp"
      ? pipeline.webp({ quality })
      : req.format === "jpeg"
        ? pipeline.jpeg({ quality })
        : req.format === "png"
          ? pipeline.png(pngOptions)
          : req.format === "avif"
            ? pipeline.avif({ quality })
            : pipeline.heic({ quality })

  const outBytes = await encoded.bytes()
  const outMeta = await new Bun.Image(outBytes).metadata()
  const durationMs = Math.max(1, Math.round(performance.now() - startedAt))
  const mimeType =
    req.format === "jpeg"
      ? "image/jpeg"
      : req.format === "png"
        ? "image/png"
        : req.format === "webp"
          ? "image/webp"
          : req.format === "avif"
            ? "image/avif"
            : "image/heic"

  const isPngBytes =
    outBytes.byteLength >= 26 &&
    outBytes[0] === 0x89 &&
    outBytes[1] === 0x50 &&
    outBytes[2] === 0x4e &&
    outBytes[3] === 0x47
  const pngColorType = req.format === "png" && isPngBytes ? outBytes[25] : undefined
  const pngColorTypeLabel =
    pngColorType === 3
      ? "Indexed Palette (type 3)"
      : pngColorType === 6
        ? "Truecolor RGBA (type 6)"
        : pngColorType === 2
          ? "Truecolor RGB (type 2)"
          : pngColorType === 0
            ? "Grayscale (type 0)"
            : pngColorType === 4
              ? "Grayscale+Alpha (type 4)"
              : undefined

  const base64 = Buffer.from(outBytes).toString("base64")
  const dataUrl = `data:${mimeType};base64,${base64}`
  const savedBytes = originalStat.size - outBytes.byteLength
  const savedPct =
    originalStat.size > 0 ? Number(((savedBytes / originalStat.size) * 100).toFixed(1)) : 0

  return {
    ok: true,
    source: req.source,
    backend: Bun.Image.backend ?? "bun",
    bunVersion: Bun.version,
    originalFormat: originalMeta.format ?? "unknown",
    originalWidth: originalMeta.width,
    originalHeight: originalMeta.height,
    originalBytes: originalStat.size,
    outputFormat: outMeta.format ?? req.format,
    outputWidth: outMeta.width,
    outputHeight: outMeta.height,
    outputBytes: outBytes.byteLength,
    savedBytes,
    savedPct,
    durationMs,
    sha256: hashBytesSha256(outBytes).slice(0, 12),
    mimeType,
    dataUrl,
    ...(req.format === "png"
      ? {
          pngColorType,
          pngColorTypeLabel,
          pngPalette,
          pngColors: pngPalette ? pngColors : undefined,
          pngDither: pngPalette ? pngDither : undefined,
        }
      : {}),
  }
}

const mode = process.argv[2] ?? "scan"
const rawStdin = await Bun.stdin.text()
const payload = JSON.parse(rawStdin)

if (mode === "scan") {
  const result = await runScan(payload as ScanRequest)
  process.stdout.write(JSON.stringify(result))
} else if (mode === "transform") {
  const result = await runTransform(payload as TransformRequest)
  process.stdout.write(JSON.stringify(result))
} else {
  process.stderr.write(`Unknown worker mode: ${mode}\n`)
  process.exit(1)
}
