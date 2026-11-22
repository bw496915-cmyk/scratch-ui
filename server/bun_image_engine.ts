/**
 * @file server/bun_image_engine.ts
 * @description Server-side bridge invoking native Bun 1.4.4 `Bun.Image` for asset diagnostics,
 * raw preview serving with strict path containment, and live format/resize transformations.
 */
import { spawn } from "node:child_process"
import { realpathSync, statSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { extname, isAbsolute, relative, resolve } from "node:path"

import { getImageAssetsDiagnostics } from "./adapters.ts"

export const ALLOWED_ASSET_ROOTS = [
  "public",
  "src/assets/images",
  "docs/assets",
  "packages/ui/src",
] as const

export type AllowedAssetRoot = (typeof ALLOWED_ASSET_ROOTS)[number]

export type BunImageOutputFormat = "webp" | "jpeg" | "png" | "avif" | "heic"
export type BunImageResampleFilter =
  "lanczos3" | "lanczos2" | "mitchell" | "cubic" | "bilinear" | "box" | "nearest"

export interface BunImageCodecSupport {
  readonly format: BunImageOutputFormat
  readonly supported: boolean
  readonly note: string
}

export interface BunImageAssetRow {
  readonly type: "BunImageAssetDiagnostic" | "BunImageAssetScanFailure"
  readonly source: string
  readonly root?: string | undefined
  readonly format?: string | undefined
  readonly declaredFormat?: string | undefined
  readonly formatMismatch?: boolean | undefined
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly aspectRatio?: string | undefined
  readonly megapixels?: number | undefined
  readonly bytesPerPixel?: number | undefined
  readonly bytes?: number | null | undefined
  readonly backend?: string | null | undefined
  readonly sha256?: string | undefined
  readonly lastModified?: string | undefined
  readonly placeholderDataUrl?: string | undefined
  readonly vectorElementCount?: number | undefined
  readonly canTransform?: boolean | undefined
  readonly mimeType?: string | undefined
  readonly code?: string | undefined
}

export interface BunAssetsDiagnosticPayload {
  readonly ok: boolean
  readonly generatedAt: string
  readonly root: string
  readonly roots?: readonly string[] | undefined
  readonly visibility: string
  readonly runtime?: string | undefined
  readonly bunVersion?: string | undefined
  readonly bunImageBackend?: string | undefined
  readonly scanMs?: number | undefined
  readonly totalBytes?: number | undefined
  readonly mismatchCount?: number | undefined
  readonly formatBreakdown?: Readonly<Record<string, number>> | undefined
  readonly codecs?: readonly BunImageCodecSupport[] | undefined
  readonly count: number
  readonly total?: number | undefined
  readonly truncated?: boolean | undefined
  readonly cached?: boolean | undefined
  readonly assets: readonly BunImageAssetRow[]
}

export interface BunImageTransformRequest {
  readonly source: string
  readonly format: BunImageOutputFormat
  readonly width?: number | undefined
  readonly height?: number | undefined
  readonly fit?: "inside" | "fill" | undefined
  readonly withoutEnlargement?: boolean | undefined
  readonly filter?: BunImageResampleFilter | undefined
  readonly quality?: number | undefined
  readonly lossless?: boolean | undefined
  readonly compressionLevel?: number | undefined
  readonly palette?: boolean | undefined
  readonly colors?: number | undefined
  readonly dither?: boolean | undefined
  readonly xmpXml?: string | undefined
  readonly rotate?: 0 | 90 | 180 | 270 | undefined
  readonly flip?: boolean | undefined
  readonly flop?: boolean | undefined
  readonly brightness?: number | undefined
  readonly saturation?: number | undefined
}

export interface BunImageTransformResult {
  readonly ok: boolean
  readonly source: string
  readonly backend: string
  readonly bunVersion: string
  readonly originalFormat: string
  readonly originalWidth?: number | undefined
  readonly originalHeight?: number | undefined
  readonly originalBytes: number
  readonly outputFormat: string
  readonly outputWidth?: number | undefined
  readonly outputHeight?: number | undefined
  readonly outputBytes: number
  readonly savedBytes: number
  readonly savedPct: number
  readonly durationMs: number
  readonly sha256: string
  readonly mimeType: string
  readonly dataUrl: string
  readonly pngColorType?: number | undefined
  readonly pngColorTypeLabel?: string | undefined
  readonly pngPalette?: boolean | undefined
  readonly pngColors?: number | undefined
  readonly pngDither?: boolean | undefined
  readonly webpLossless?: boolean | undefined
  readonly webpBitstream?: string | undefined
  readonly xmpInjected?: boolean | undefined
  readonly xmpBytes?: number | undefined
}

let cachedScan: {
  readonly key: string
  readonly expiresAt: number
  readonly payload: BunAssetsDiagnosticPayload
} | null = null

const SCAN_CACHE_TTL_MS = 30_000

function runBunWorker<T>(cwd: string, mode: "scan" | "transform", input: unknown): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const workerPath = resolve(cwd, "server/bun_image_worker.ts")
    const child = spawn("bun", ["run", workerPath, mode], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    child.on("error", (err) => rejectPromise(err))
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8")
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
      if (code !== 0) {
        rejectPromise(new Error(stderr || `bun_image_worker exited with code ${code}`))
        return
      }
      try {
        resolvePromise(JSON.parse(stdout) as T)
      } catch (err) {
        rejectPromise(
          new Error(`Invalid worker JSON: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
    })

    child.stdin.write(JSON.stringify(input))
    child.stdin.end()
  })
}

export function resolveSafeAssetPath(
  cwd: string,
  source: string,
): { readonly fullPath: string; readonly normalizedSource: string } | null {
  const cleaned = source.trim().replace(/^\/+/, "").replace(/\\/g, "/")
  if (!cleaned || cleaned.includes("..") || cleaned.includes("\0")) {
    return null
  }
  const sourcePath = resolve(cwd, cleaned)
  let fullPath: string
  try {
    fullPath = realpathSync(sourcePath)
    if (!statSync(fullPath).isFile()) return null
  } catch {
    return null
  }
  for (const root of ALLOWED_ASSET_ROOTS) {
    let rootAbs: string
    try {
      rootAbs = realpathSync(resolve(cwd, root))
    } catch {
      continue
    }
    const rel = relative(rootAbs, fullPath)
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      return {
        fullPath,
        normalizedSource: relative(cwd, sourcePath).replace(/\\/g, "/"),
      }
    }
  }
  return null
}

function sniffMimeFromBytes(buf: Buffer, ext: string): string {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png"
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp"
  }
  if (buf.length >= 6 && buf.toString("ascii", 0, 6).startsWith("GIF8")) {
    return "image/gif"
  }
  if (ext.toLowerCase() === ".svg") {
    return "image/svg+xml"
  }
  if (ext.toLowerCase() === ".ico") {
    return "image/x-icon"
  }
  return "application/octet-stream"
}

export async function readRawAssetFile(
  cwd: string,
  source: string,
): Promise<{ readonly bytes: Buffer; readonly mimeType: string } | null> {
  const resolved = resolveSafeAssetPath(cwd, source)
  if (!resolved) return null
  const bytes = await readFile(resolved.fullPath)
  const mimeType = sniffMimeFromBytes(bytes, extname(resolved.fullPath))
  return { bytes, mimeType }
}

export async function scanBunImageAssets(
  cwd: string,
  options?: { readonly refresh?: boolean; readonly root?: string },
): Promise<BunAssetsDiagnosticPayload> {
  const requestedRoot = options?.root?.trim()
  const roots: readonly string[] =
    requestedRoot &&
    requestedRoot !== "all" &&
    (ALLOWED_ASSET_ROOTS as readonly string[]).includes(requestedRoot)
      ? [requestedRoot]
      : ALLOWED_ASSET_ROOTS

  const cacheKey = roots.join("|")
  if (
    !options?.refresh &&
    cachedScan &&
    cachedScan.key === cacheKey &&
    cachedScan.expiresAt > Date.now()
  ) {
    return {
      ...cachedScan.payload,
      cached: true,
    }
  }

  try {
    const payload = await runBunWorker<BunAssetsDiagnosticPayload>(cwd, "scan", { cwd, roots })
    cachedScan = {
      key: cacheKey,
      expiresAt: Date.now() + SCAN_CACHE_TTL_MS,
      payload,
    }
    return payload
  } catch {
    const fallback = await getImageAssetsDiagnostics(cwd)
    return {
      ...fallback,
      roots: ["docs/assets"],
      runtime: `Node.js ${process.version} (fallback)`,
      bunImageBackend: "node-header-inspector",
      mismatchCount: 0,
      codecs: [],
    }
  }
}

const VALID_FORMATS = new Set<BunImageOutputFormat>(["webp", "jpeg", "png", "avif", "heic"])

const VALID_FILTERS = new Set<BunImageResampleFilter>([
  "lanczos3",
  "lanczos2",
  "mitchell",
  "cubic",
  "bilinear",
  "box",
  "nearest",
])

export async function transformBunImageAsset(
  cwd: string,
  req: BunImageTransformRequest,
): Promise<BunImageTransformResult> {
  const safe = resolveSafeAssetPath(cwd, req.source)
  if (!safe) {
    throw new Error(`Asset not found or outside allowed roots: ${req.source}`)
  }
  if (extname(safe.fullPath).toLowerCase() === ".svg") {
    throw new Error("SVG assets are vector graphics; select a raster asset for Bun.Image encoding.")
  }
  if (!VALID_FORMATS.has(req.format)) {
    throw new Error(`Unsupported output format: ${String(req.format)}`)
  }

  const width =
    typeof req.width === "number" && Number.isFinite(req.width) && req.width > 0
      ? Math.min(4096, Math.max(16, Math.round(req.width)))
      : undefined
  const height =
    typeof req.height === "number" && Number.isFinite(req.height) && req.height > 0
      ? Math.min(4096, Math.max(16, Math.round(req.height)))
      : undefined
  const filter = req.filter && VALID_FILTERS.has(req.filter) ? req.filter : "lanczos3"
  const rotate = req.rotate === 90 || req.rotate === 180 || req.rotate === 270 ? req.rotate : 0

  return await runBunWorker<BunImageTransformResult>(cwd, "transform", {
    fullPath: safe.fullPath,
    source: safe.normalizedSource,
    format: req.format,
    width,
    height,
    fit: req.fit === "fill" ? "fill" : "inside",
    withoutEnlargement: req.withoutEnlargement ?? true,
    filter,
    quality:
      typeof req.quality === "number" && Number.isFinite(req.quality)
        ? Math.min(100, Math.max(1, Math.round(req.quality)))
        : 80,
    lossless: Boolean(req.lossless),
    compressionLevel:
      typeof req.compressionLevel === "number" && Number.isFinite(req.compressionLevel)
        ? Math.min(9, Math.max(0, Math.round(req.compressionLevel)))
        : 6,
    palette: Boolean(req.palette),
    colors:
      typeof req.colors === "number" && Number.isFinite(req.colors)
        ? Math.min(256, Math.max(2, Math.round(req.colors)))
        : 256,
    dither: req.dither ?? true,
    xmpXml:
      typeof req.xmpXml === "string" && req.xmpXml.trim().length > 0
        ? req.xmpXml.slice(0, 65_536)
        : undefined,
    rotate,
    flip: Boolean(req.flip),
    flop: Boolean(req.flop),
    brightness:
      typeof req.brightness === "number" && Number.isFinite(req.brightness)
        ? Math.min(2.5, Math.max(0.2, req.brightness))
        : 1,
    saturation:
      typeof req.saturation === "number" && Number.isFinite(req.saturation)
        ? Math.min(2.5, Math.max(0, req.saturation))
        : 1,
  })
}
