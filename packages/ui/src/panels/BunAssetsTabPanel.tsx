/**
 * @file packages/ui/src/panels/BunAssetsTabPanel.tsx
 * @description Native Bun 1.4.4 `Bun.Image` Asset Diagnostics & Format Studio.
 *
 * Consumes `GET /api/diagnostics/image-assets`, `GET /api/diagnostics/image-assets/raw`,
 * and `POST /api/diagnostics/image-assets/transform` to inspect real workspace assets,
 * surface byte-level format vs extension mismatches, preview ThumbHash placeholders,
 * and execute live chained `Bun.Image` resize/modulate/transcode pipelines.
 */
import type React from "react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { getDevCsrfToken, trackedFetch } from "../api_usage.ts"
import { styles } from "../dashboard_styles.ts"
import { formatBytes } from "../format_bytes.ts"
import { apiPostHeaders } from "../session_headers.ts"
import { SkeletonTableRows } from "./PanelSkeleton.tsx"

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

export interface BunAssetsPayload {
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

export interface BunAssetsTabPanelProps {
  readonly initialPayload?: BunAssetsPayload | null
  readonly loadAssets?: (options?: { readonly refresh?: boolean }) => Promise<BunAssetsPayload>
}

type SortField = "source" | "format" | "pixels" | "bytes" | "backend"
type SortDir = "asc" | "desc"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

const CHECKERBOARD_BG: React.CSSProperties = {
  backgroundColor: "#0a101d",
  backgroundImage:
    "linear-gradient(45deg, rgba(148, 163, 184, 0.08) 25%, transparent 25%), linear-gradient(-45deg, rgba(148, 163, 184, 0.08) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.08) 75%), linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.08) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
}

async function defaultLoadAssets(options?: {
  readonly refresh?: boolean
}): Promise<BunAssetsPayload> {
  const qs = options?.refresh ? "?refresh=1" : ""
  const response = await trackedFetch(`/api/diagnostics/image-assets${qs}`, {
    headers: { accept: "application/json" },
  })
  if (!response.ok) {
    throw new Error(`image-assets HTTP ${response.status}`)
  }
  return (await response.json()) as BunAssetsPayload
}

function rawAssetUrl(source: string): string {
  return `/api/diagnostics/image-assets/raw?source=${encodeURIComponent(source)}`
}

function fileBasename(source: string): string {
  const parts = source.split("/")
  return parts[parts.length - 1] ?? source
}

function formatShortTimestamp(iso?: string): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC"
}

function triggerDataUrlDownload(dataUrl: string, source: string, ext: string): void {
  const base = fileBasename(source).replace(/\.[^.]+$/, "")
  const link = document.createElement("a")
  link.href = dataUrl
  link.download = `${base}.bun.${ext}`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

interface ThumbnailProps {
  readonly asset: BunImageAssetRow
}

function AssetThumbnail({ asset }: ThumbnailProps): React.ReactElement {
  const [imgFailed, setImgFailed] = useState(false)
  const bgStyle: React.CSSProperties = asset.placeholderDataUrl
    ? {
        backgroundImage: `url("${asset.placeholderDataUrl}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }
    : CHECKERBOARD_BG

  return (
    <div
      style={{
        width: "40px",
        height: "30px",
        borderRadius: "4px",
        overflow: "hidden",
        flexShrink: 0,
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: asset.formatMismatch ? "#d97706" : "#1e293b",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...bgStyle,
      }}
    >
      {imgFailed || asset.type === "BunImageAssetScanFailure" ? (
        <span
          style={{
            fontSize: "9px",
            fontFamily: MONO_FONT,
            color: "#94a3b8",
            textTransform: "uppercase",
          }}
        >
          {(asset.format ?? asset.declaredFormat ?? "?").slice(0, 4)}
        </span>
      ) : (
        <img
          src={rawAssetUrl(asset.source)}
          alt={asset.source}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImgFailed(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      )}
    </div>
  )
}

export function BunAssetsTabPanel({
  initialPayload = null,
  loadAssets = defaultLoadAssets,
}: BunAssetsTabPanelProps): React.ReactElement {
  const [payload, setPayload] = useState<BunAssetsPayload | null>(initialPayload)
  const [loading, setLoading] = useState<boolean>(initialPayload === null)
  const [error, setError] = useState<string | null>(null)

  // Filter & sort state
  const [searchQuery, setSearchQuery] = useState("")
  const [rootFilter, setRootFilter] = useState<string>("all")
  const [formatFilter, setFormatFilter] = useState<string>("all")
  const [mismatchOnly, setMismatchOnly] = useState(false)
  const [sortField, setSortField] = useState<SortField>("bytes")
  const [sortDir, setSortDir] = useState<SortDir>("desc")

  // Inspector & Transform Studio state
  const [selectedSource, setSelectedSource] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState<"original" | "placeholder">("original")
  const [previewError, setPreviewError] = useState(false)

  const [targetFormat, setTargetFormat] = useState<BunImageOutputFormat>("webp")
  const [widthInput, setWidthInput] = useState<string>("")
  const [heightInput, setHeightInput] = useState<string>("")
  const [fit, setFit] = useState<"inside" | "fill">("inside")
  const [resampleFilter, setResampleFilter] = useState<BunImageResampleFilter>("lanczos3")
  const [quality, setQuality] = useState<number>(80)
  const [webpLossless, setWebpLossless] = useState<boolean>(false)
  const [compressionLevel, setCompressionLevel] = useState<number>(6)
  const [pngPalette, setPngPalette] = useState<boolean>(false)
  const [pngColors, setPngColors] = useState<number>(64)
  const [pngDither, setPngDither] = useState<boolean>(true)
  const [rotate, setRotate] = useState<0 | 90 | 180 | 270>(0)
  const [flip, setFlip] = useState<boolean>(false)
  const [flop, setFlop] = useState<boolean>(false)
  const [brightness, setBrightness] = useState<number>(1)
  const [saturation, setSaturation] = useState<number>(1)

  const [transforming, setTransforming] = useState<boolean>(false)
  const [transformError, setTransformError] = useState<string | null>(null)
  const [transformResult, setTransformResult] = useState<BunImageTransformResult | null>(null)
  const [copiedDataUrl, setCopiedDataUrl] = useState<boolean>(false)

  const refresh = useCallback(
    async (forceRefresh = false): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const next = await loadAssets({ refresh: forceRefresh })
        setPayload(next)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught))
      } finally {
        setLoading(false)
      }
    },
    [loadAssets],
  )

  useEffect(() => {
    if (initialPayload === null) void refresh(false)
  }, [initialPayload, refresh])

  const assets = useMemo(() => payload?.assets ?? [], [payload])

  const availableRoots = useMemo(() => {
    const set = new Set<string>()
    if (payload?.roots) {
      for (const r of payload.roots) set.add(r)
    }
    for (const a of assets) {
      if (a.root) set.add(a.root)
    }
    return Array.from(set)
  }, [payload?.roots, assets])

  const availableFormats = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of assets) {
      const fmt = (a.format ?? a.declaredFormat ?? "unknown").toLowerCase()
      counts.set(fmt, (counts.get(fmt) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [assets])

  const filteredAssets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const list = assets.filter((a) => {
      if (rootFilter !== "all" && a.root !== rootFilter) return false
      const fmt = (a.format ?? a.declaredFormat ?? "unknown").toLowerCase()
      if (formatFilter !== "all" && fmt !== formatFilter) return false
      if (mismatchOnly && !a.formatMismatch) return false
      if (q) {
        const haystack =
          `${a.source} ${fmt} ${a.declaredFormat ?? ""} ${a.sha256 ?? ""} ${a.backend ?? ""}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })

    const dir = sortDir === "asc" ? 1 : -1
    return [...list].sort((a, b) => {
      if (sortField === "source") {
        return a.source.localeCompare(b.source) * dir
      }
      if (sortField === "format") {
        const fa = (a.format ?? a.declaredFormat ?? "").toLowerCase()
        const fb = (b.format ?? b.declaredFormat ?? "").toLowerCase()
        return fa.localeCompare(fb) * dir
      }
      if (sortField === "pixels") {
        const pa = (a.width ?? 0) * (a.height ?? 0)
        const pb = (b.width ?? 0) * (b.height ?? 0)
        return (pa - pb) * dir
      }
      if (sortField === "backend") {
        return (a.backend ?? "").localeCompare(b.backend ?? "") * dir
      }
      return ((a.bytes ?? 0) - (b.bytes ?? 0)) * dir
    })
  }, [assets, searchQuery, rootFilter, formatFilter, mismatchOnly, sortField, sortDir])

  // Keep a valid selected asset whenever payload loads
  useEffect(() => {
    if (assets.length === 0) {
      setSelectedSource(null)
      return
    }
    if (selectedSource && assets.some((a) => a.source === selectedSource)) {
      return
    }
    const preferred =
      assets.find((a) => a.formatMismatch) ??
      assets.find((a) => a.canTransform !== false) ??
      assets[0]
    setSelectedSource(preferred?.source ?? null)
  }, [assets, selectedSource])

  const selectedAsset = useMemo(
    () => assets.find((a) => a.source === selectedSource) ?? null,
    [assets, selectedSource],
  )

  // Reset per-asset preview/transform output when switching selection
  useEffect(() => {
    setPreviewMode("original")
    setPreviewError(false)
    setTransformResult(null)
    setTransformError(null)
    setCopiedDataUrl(false)
  }, [selectedSource])

  const codecs = useMemo<readonly BunImageCodecSupport[]>(() => {
    if (payload?.codecs && payload.codecs.length > 0) return payload.codecs
    return [
      { format: "webp", supported: true, note: "Native WebP encoder" },
      { format: "jpeg", supported: true, note: "Native JPEG encoder" },
      { format: "png", supported: true, note: "Native PNG encoder" },
      {
        format: "avif",
        supported: false,
        note: "Requires OS codec (macOS/Windows AV1)",
      },
      {
        format: "heic",
        supported: false,
        note: "Requires OS codec (macOS/Windows HEVC)",
      },
    ]
  }, [payload?.codecs])

  const totalBytes = useMemo(
    () => payload?.totalBytes ?? assets.reduce((acc, row) => acc + (row.bytes ?? 0), 0),
    [payload?.totalBytes, assets],
  )

  const mismatchCount = useMemo(
    () => payload?.mismatchCount ?? assets.filter((a) => a.formatMismatch).length,
    [payload?.mismatchCount, assets],
  )

  const toggleSort = (field: SortField): void => {
    if (sortField === field) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"))
    } else {
      setSortField(field)
      setSortDir(field === "source" || field === "format" ? "asc" : "desc")
    }
  }

  const applyPreset = (preset: "webp80" | "thumb320" | "jpeg85" | "png6"): void => {
    setRotate(0)
    setFlip(false)
    setFlop(false)
    setBrightness(1)
    setSaturation(1)
    setFit("inside")
    setResampleFilter("lanczos3")
    if (preset === "webp80") {
      setTargetFormat("webp")
      setQuality(80)
      setWidthInput("")
      setHeightInput("")
    } else if (preset === "thumb320") {
      setTargetFormat("webp")
      setQuality(76)
      setWidthInput("320")
      setHeightInput("")
    } else if (preset === "jpeg85") {
      setTargetFormat("jpeg")
      setQuality(85)
      setWidthInput("")
      setHeightInput("")
    } else {
      setTargetFormat("png")
      setCompressionLevel(7)
      setWidthInput("")
      setHeightInput("")
    }
  }

  const runTransform = useCallback(async (): Promise<void> => {
    if (!selectedAsset || selectedAsset.canTransform === false) return
    setTransforming(true)
    setTransformError(null)
    setCopiedDataUrl(false)

    const parsedW = widthInput.trim() ? Number(widthInput.trim()) : undefined
    const parsedH = heightInput.trim() ? Number(heightInput.trim()) : undefined

    try {
      const cookieCsrf =
        typeof document !== "undefined"
          ? document.cookie.match(/(?:^|;\s*)sd_csrf=([^;]+)/)?.[1]
          : undefined
      const csrfToken = cookieCsrf ? decodeURIComponent(cookieCsrf) : getDevCsrfToken()
      const response = await trackedFetch("/api/diagnostics/image-assets/transform", {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify({
          source: selectedAsset.source,
          format: targetFormat,
          width:
            parsedW !== undefined && Number.isFinite(parsedW) && parsedW > 0 ? parsedW : undefined,
          height:
            parsedH !== undefined && Number.isFinite(parsedH) && parsedH > 0 ? parsedH : undefined,
          fit,
          withoutEnlargement: true,
          filter: resampleFilter,
          quality,
          lossless: targetFormat === "webp" ? webpLossless : undefined,
          compressionLevel,
          palette: targetFormat === "png" ? pngPalette : undefined,
          colors: targetFormat === "png" && pngPalette ? pngColors : undefined,
          dither: targetFormat === "png" && pngPalette ? pngDither : undefined,
          rotate,
          flip,
          flop,
          brightness,
          saturation,
        }),
      })
      const json = (await response.json()) as BunImageTransformResult & {
        readonly error?: string
      }
      if (!response.ok || !json.ok) {
        throw new Error(json.error ?? `Transform HTTP ${response.status}`)
      }
      setTransformResult(json)
    } catch (caught) {
      setTransformError(caught instanceof Error ? caught.message : String(caught))
      setTransformResult(null)
    } finally {
      setTransforming(false)
    }
  }, [
    selectedAsset,
    targetFormat,
    widthInput,
    heightInput,
    fit,
    resampleFilter,
    quality,
    webpLossless,
    compressionLevel,
    pngPalette,
    pngColors,
    pngDither,
    rotate,
    flip,
    flop,
    brightness,
    saturation,
  ])

  const handleCopyDataUrl = useCallback(async (): Promise<void> => {
    if (!transformResult?.dataUrl) return
    try {
      await navigator.clipboard.writeText(transformResult.dataUrl)
      setCopiedDataUrl(true)
      setTimeout(() => setCopiedDataUrl(false), 1800)
    } catch {
      setCopiedDataUrl(false)
    }
  }, [transformResult?.dataUrl])

  const sortIndicator = (field: SortField): string => {
    if (sortField !== field) return ""
    return sortDir === "asc" ? " ▲" : " ▼"
  }

  return (
    <section
      data-testid="bun-assets-panel"
      style={{
        ...styles.tableCard,
        padding: "20px",
      }}
    >
      {/* Header Row */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "12px",
          paddingBottom: "14px",
          borderBottomWidth: "1px",
          borderBottomStyle: "solid",
          borderBottomColor: "#1e293b",
        }}
      >
        <div>
          <h2
            style={{
              ...styles.tableTitle,
              fontSize: "17px",
              margin: 0,
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span>🖼️ Bun.Image Assets</span>
            <span
              style={{
                color: "#94a3b8",
                fontWeight: 500,
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
                fontSize: "13px",
              }}
            >
              ({filteredAssets.length}
              {filteredAssets.length !== assets.length ? ` / ${assets.length}` : ""})
            </span>
          </h2>
          {/* Quiet unboxed telemetry summary line */}
          <div
            style={{
              marginTop: "6px",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "6px",
              fontSize: "12px",
              color: "#94a3b8",
              fontFamily: MONO_FONT,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span style={{ color: "#e2e8f0" }}>{payload?.runtime ?? "Bun Native"}</span>
            <span aria-hidden="true">·</span>
            <span>
              backend{" "}
              <strong style={{ color: "#38bdf8", fontWeight: 600 }}>
                {payload?.bunImageBackend ?? "bun"}
              </strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>{formatBytes(totalBytes)} total</span>
            {payload?.scanMs !== undefined ? (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  {payload.scanMs}ms{payload.cached ? " (cached)" : ""}
                </span>
              </>
            ) : null}
            {mismatchCount > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span style={{ color: "#fbbf24", fontWeight: 600 }}>
                  {mismatchCount} ext mismatch{mismatchCount === 1 ? "" : "es"}
                </span>
              </>
            ) : null}
            {payload?.generatedAt ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatShortTimestamp(payload.generatedAt)}</span>
              </>
            ) : null}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            onClick={() => void refresh(true)}
            disabled={loading}
            style={{
              padding: "7px 14px",
              borderRadius: "6px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              backgroundColor: loading ? "#111a2e" : "#0f172a",
              color: "#e2e8f0",
              fontSize: "12px",
              fontWeight: 600,
              whiteSpace: "nowrap",
              cursor: loading ? "wait" : "pointer",
            }}
          >
            {loading ? "Scanning…" : "Rescan Native"}
          </button>
        </div>
      </div>

      {/* Live Native Codec Matrix Strip (clean unboxed metadata) */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px 18px",
          padding: "10px 0",
          borderBottomWidth: "1px",
          borderBottomStyle: "solid",
          borderBottomColor: "#1e293b",
          fontSize: "12px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <span style={{ color: "#94a3b8", fontWeight: 600 }}>Native Encoders</span>
          {codecs.map((codec) => (
            <span
              key={codec.format}
              title={codec.note}
              style={{
                fontFamily: MONO_FONT,
                fontSize: "11px",
                color: codec.supported ? "#4ade80" : "#64748b",
              }}
            >
              {codec.format.toUpperCase()} {codec.supported ? "ready" : "os-only"}
            </span>
          ))}
        </div>

        <div
          style={{
            fontFamily: MONO_FONT,
            fontSize: "11px",
            color: "#94a3b8",
          }}
        >
          roots: <span style={{ color: "#cbd5e1" }}>{payload?.root ?? "docs/assets"}</span>
          {" · "}visibility:{" "}
          <span style={{ color: "#cbd5e1" }}>{payload?.visibility ?? "RISK_MANAGER"}</span>
        </div>
      </div>

      {error !== null ? (
        <div
          role="alert"
          style={{
            marginTop: "12px",
            padding: "10px 12px",
            borderRadius: "6px",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "rgba(248, 113, 113, 0.35)",
            backgroundColor: "rgba(127, 29, 29, 0.25)",
            color: "#fca5a5",
            fontSize: "12px",
          }}
        >
          Asset scan failed: {error}
        </div>
      ) : null}

      {/* Main Split Grid: Asset Registry (Left) + Native Bun.Image Format Studio (Right) */}
      <div
        style={{
          marginTop: "16px",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
          gap: "20px",
          alignItems: "start",
        }}
      >
        {/* LEFT COLUMN: Filter Controls + Asset Table */}
        <div style={{ minWidth: 0 }}>
          {/* Interactive Filter Toolbar */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
              marginBottom: "12px",
            }}
          >
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter path, format, or SHA-256…"
              aria-label="Filter image assets"
              style={{
                flex: "1 1 180px",
                minWidth: "160px",
                padding: "7px 10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
                backgroundColor: "#0a101d",
                color: "#f1f5f9",
                fontSize: "12px",
                fontFamily: MONO_FONT,
              }}
            />

            {/* Root Segmented Control */}
            <div
              role="group"
              aria-label="Filter by root directory"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                padding: "2px",
                borderRadius: "6px",
                backgroundColor: "#0a101d",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#1e293b",
              }}
            >
              {["all", ...availableRoots].map((r) => {
                const active = rootFilter === r
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRootFilter(r)}
                    style={{
                      padding: "4px 8px",
                      borderRadius: "4px",
                      borderWidth: 0,
                      backgroundColor: active ? "#1e293b" : "transparent",
                      color: active ? "#f8fafc" : "#94a3b8",
                      fontSize: "11px",
                      fontWeight: active ? 600 : 500,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                    }}
                  >
                    {r === "all" ? "All Roots" : r}
                  </button>
                )
              })}
            </div>

            {mismatchCount > 0 ? (
              <button
                type="button"
                onClick={() => setMismatchOnly((prev) => !prev)}
                style={{
                  padding: "6px 10px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: mismatchOnly ? "#f59e0b" : "#334155",
                  backgroundColor: mismatchOnly ? "rgba(245, 158, 11, 0.16)" : "#0a101d",
                  color: mismatchOnly ? "#fbbf24" : "#cbd5e1",
                  fontSize: "11px",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                Mismatches ({mismatchCount})
              </button>
            ) : null}
          </div>

          {/* Format Filter Row */}
          {availableFormats.length > 0 ? (
            <div
              role="group"
              aria-label="Filter by sniffed format"
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "6px",
                marginBottom: "12px",
              }}
            >
              <button
                type="button"
                onClick={() => setFormatFilter("all")}
                style={{
                  padding: "4px 9px",
                  borderRadius: "5px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: formatFilter === "all" ? "#38bdf8" : "#1e293b",
                  backgroundColor:
                    formatFilter === "all" ? "rgba(56, 189, 248, 0.14)" : "transparent",
                  color: formatFilter === "all" ? "#38bdf8" : "#94a3b8",
                  fontSize: "11px",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                All ({assets.length})
              </button>
              {availableFormats.map(([fmt, count]) => {
                const active = formatFilter === fmt
                return (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setFormatFilter(fmt)}
                    style={{
                      padding: "4px 9px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: active ? "#38bdf8" : "#1e293b",
                      backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                      color: active ? "#38bdf8" : "#94a3b8",
                      fontSize: "11px",
                      fontWeight: 600,
                      fontFamily: MONO_FONT,
                      whiteSpace: "nowrap",
                      cursor: "pointer",
                    }}
                  >
                    {fmt.toUpperCase()} ({count})
                  </button>
                )
              })}
            </div>
          ) : null}

          {/* High-Density Sortable Asset Table */}
          <div
            style={{
              ...styles.tableScroll,
              maxHeight: "620px",
              overflowY: "auto",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#1e293b",
              borderRadius: "8px",
            }}
          >
            <table style={{ ...styles.table, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th scope="col" style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("source")}
                      style={{
                        background: "none",
                        borderWidth: 0,
                        padding: 0,
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      Asset{sortIndicator("source")}
                    </button>
                  </th>
                  <th scope="col" style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("format")}
                      style={{
                        background: "none",
                        borderWidth: 0,
                        padding: 0,
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      Format{sortIndicator("format")}
                    </button>
                  </th>
                  <th scope="col" style={{ ...styles.th, textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={() => toggleSort("pixels")}
                      style={{
                        background: "none",
                        borderWidth: 0,
                        padding: 0,
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      Dimensions{sortIndicator("pixels")}
                    </button>
                  </th>
                  <th scope="col" style={{ ...styles.th, textAlign: "right" }}>
                    <button
                      type="button"
                      onClick={() => toggleSort("bytes")}
                      style={{
                        background: "none",
                        borderWidth: 0,
                        padding: 0,
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      Size{sortIndicator("bytes")}
                    </button>
                  </th>
                  <th scope="col" style={styles.th}>
                    <button
                      type="button"
                      onClick={() => toggleSort("backend")}
                      style={{
                        background: "none",
                        borderWidth: 0,
                        padding: 0,
                        color: "inherit",
                        font: "inherit",
                        cursor: "pointer",
                      }}
                    >
                      Engine{sortIndicator("backend")}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading && assets.length === 0 ? (
                  <SkeletonTableRows
                    columnWidths={["78%", "52%", "64%", "56%", "62%"]}
                    rowCount={6}
                    rowHeight={44}
                    skeletonId="bun-assets-rows"
                  />
                ) : filteredAssets.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      style={{
                        ...styles.td,
                        padding: "24px 14px",
                        color: "#94a3b8",
                        textAlign: "center",
                      }}
                    >
                      No matching assets found.{" "}
                      {searchQuery ||
                      rootFilter !== "all" ||
                      formatFilter !== "all" ||
                      mismatchOnly ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSearchQuery("")
                            setRootFilter("all")
                            setFormatFilter("all")
                            setMismatchOnly(false)
                          }}
                          style={{
                            marginLeft: "8px",
                            background: "none",
                            borderWidth: 0,
                            color: "#38bdf8",
                            cursor: "pointer",
                            textDecoration: "underline",
                            fontSize: "12px",
                          }}
                        >
                          Clear filters
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ) : (
                  filteredAssets.map((asset) => {
                    const failed = asset.type === "BunImageAssetScanFailure"
                    const selected = asset.source === selectedSource
                    const sniffed = (asset.format ?? "—").toUpperCase()
                    const declared = (asset.declaredFormat ?? "").toUpperCase()

                    return (
                      <tr
                        key={asset.source}
                        data-image-asset-row="true"
                        onClick={() => setSelectedSource(asset.source)}
                        style={{
                          cursor: "pointer",
                          backgroundColor: selected ? "rgba(56, 189, 248, 0.1)" : "transparent",
                          transition: "background-color 140ms ease",
                        }}
                      >
                        <td style={{ ...styles.td, padding: "8px 10px" }}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "10px",
                              minWidth: 0,
                            }}
                          >
                            <AssetThumbnail asset={asset} />
                            <div style={{ minWidth: 0 }}>
                              <div
                                style={{
                                  fontFamily: MONO_FONT,
                                  fontSize: "11.5px",
                                  color: selected ? "#f8fafc" : "#e2e8f0",
                                  fontWeight: selected ? 600 : 500,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  maxWidth: "280px",
                                }}
                                title={asset.source}
                              >
                                {asset.source}
                              </div>
                              <div
                                style={{
                                  marginTop: "2px",
                                  fontFamily: MONO_FONT,
                                  fontSize: "10.5px",
                                  color: "#64748b",
                                }}
                              >
                                {asset.sha256 ? `#${asset.sha256}` : "no-hash"}
                                {asset.aspectRatio ? ` · ${asset.aspectRatio}` : ""}
                                {asset.vectorElementCount !== undefined
                                  ? ` · ${asset.vectorElementCount} nodes`
                                  : ""}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td
                          style={{
                            ...styles.td,
                            fontFamily: MONO_FONT,
                            fontSize: "11.5px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <span
                            style={{
                              color: asset.formatMismatch ? "#fbbf24" : "#e2e8f0",
                              fontWeight: 600,
                            }}
                          >
                            {sniffed}
                          </span>
                          {asset.formatMismatch ? (
                            <div
                              style={{
                                fontSize: "10px",
                                color: "#f59e0b",
                                marginTop: "2px",
                              }}
                              title={`Raw magic bytes decode as ${sniffed}, but filename uses .${declared.toLowerCase()}`}
                            >
                              ≠ .{declared.toLowerCase()}
                            </div>
                          ) : null}
                        </td>
                        <td
                          style={{
                            ...styles.td,
                            textAlign: "right",
                            fontFamily: MONO_FONT,
                            fontVariantNumeric: "tabular-nums",
                            fontSize: "11.5px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {asset.width === undefined || asset.height === undefined
                            ? "—"
                            : `${asset.width}×${asset.height}`}
                          {asset.megapixels !== undefined ? (
                            <div style={{ fontSize: "10px", color: "#64748b" }}>
                              {asset.megapixels} MP
                            </div>
                          ) : null}
                        </td>
                        <td
                          style={{
                            ...styles.td,
                            textAlign: "right",
                            fontFamily: MONO_FONT,
                            fontVariantNumeric: "tabular-nums",
                            fontSize: "11.5px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatBytes(asset.bytes)}
                          {asset.bytesPerPixel !== undefined ? (
                            <div style={{ fontSize: "10px", color: "#64748b" }}>
                              {asset.bytesPerPixel} B/px
                            </div>
                          ) : null}
                        </td>
                        <td
                          style={{
                            ...styles.td,
                            fontFamily: MONO_FONT,
                            fontSize: "11px",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {failed ? (
                            <span style={{ color: "#f87171" }}>{asset.code ?? "failed"}</span>
                          ) : (
                            <span
                              style={{
                                color: asset.backend === "bun" ? "#4ade80" : "#94a3b8",
                              }}
                            >
                              {asset.backend ?? "—"}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* RIGHT COLUMN: Native Bun.Image Inspector & Live Format Studio */}
        <div
          style={{
            minWidth: 0,
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#1e293b",
            borderRadius: "8px",
            backgroundColor: "#0a101d",
            padding: "16px",
          }}
        >
          {selectedAsset === null ? (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                color: "#94a3b8",
                fontSize: "13px",
              }}
            >
              Select an asset from the table to inspect native Bun.Image metadata and run format
              conversions.
            </div>
          ) : (
            <div>
              {/* Inspector Header */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: "12px",
                  paddingBottom: "12px",
                  borderBottomWidth: "1px",
                  borderBottomStyle: "solid",
                  borderBottomColor: "#1e293b",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: "14px",
                      fontWeight: 600,
                      color: "#f8fafc",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                    title={selectedAsset.source}
                  >
                    {fileBasename(selectedAsset.source)}
                  </div>
                  <div
                    style={{
                      marginTop: "3px",
                      fontFamily: MONO_FONT,
                      fontSize: "11px",
                      color: "#94a3b8",
                      wordBreak: "break-all",
                    }}
                  >
                    {selectedAsset.source}
                  </div>
                </div>

                {/* Preview Mode Switcher + Raw Download */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    flexShrink: 0,
                  }}
                >
                  {selectedAsset.placeholderDataUrl ? (
                    <div
                      role="group"
                      aria-label="Preview mode"
                      style={{
                        display: "inline-flex",
                        padding: "2px",
                        borderRadius: "6px",
                        backgroundColor: "#0f172a",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor: "#1e293b",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setPreviewMode("original")}
                        style={{
                          padding: "3px 8px",
                          borderRadius: "4px",
                          borderWidth: 0,
                          backgroundColor: previewMode === "original" ? "#1e293b" : "transparent",
                          color: previewMode === "original" ? "#f8fafc" : "#94a3b8",
                          fontSize: "11px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Original
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewMode("placeholder")}
                        style={{
                          padding: "3px 8px",
                          borderRadius: "4px",
                          borderWidth: 0,
                          backgroundColor:
                            previewMode === "placeholder" ? "#1e293b" : "transparent",
                          color: previewMode === "placeholder" ? "#38bdf8" : "#94a3b8",
                          fontSize: "11px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        ThumbHash
                      </button>
                    </div>
                  ) : null}

                  <a
                    href={rawAssetUrl(selectedAsset.source)}
                    download={fileBasename(selectedAsset.source)}
                    style={{
                      padding: "5px 9px",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "#334155",
                      color: "#cbd5e1",
                      fontSize: "11px",
                      fontWeight: 600,
                      textDecoration: "none",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Raw
                  </a>
                </div>
              </div>

              {/* Format Mismatch Warning Banner */}
              {selectedAsset.formatMismatch ? (
                <div
                  style={{
                    marginTop: "12px",
                    padding: "9px 11px",
                    borderRadius: "6px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "rgba(245, 158, 11, 0.4)",
                    backgroundColor: "rgba(120, 53, 15, 0.22)",
                    color: "#fde68a",
                    fontSize: "12px",
                    lineHeight: 1.45,
                  }}
                >
                  <strong>Format mismatch detected:</strong> filename uses{" "}
                  <code style={{ fontFamily: MONO_FONT }}>.{selectedAsset.declaredFormat}</code>,
                  but native <code style={{ fontFamily: MONO_FONT }}>Bun.Image</code> decoded raw
                  magic bytes as{" "}
                  <strong style={{ fontFamily: MONO_FONT }}>
                    {(selectedAsset.format ?? "unknown").toUpperCase()}
                  </strong>
                  . Served with sniffed{" "}
                  <code style={{ fontFamily: MONO_FONT }}>{selectedAsset.mimeType}</code>.
                </div>
              ) : null}

              {/* Preview Frame */}
              <div
                style={{
                  marginTop: "12px",
                  height: "196px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "#1e293b",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  overflow: "hidden",
                  position: "relative",
                  ...CHECKERBOARD_BG,
                }}
              >
                {previewMode === "placeholder" && selectedAsset.placeholderDataUrl ? (
                  <img
                    src={selectedAsset.placeholderDataUrl}
                    alt={`${selectedAsset.source} ThumbHash placeholder`}
                    referrerPolicy="no-referrer"
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      imageRendering: "auto",
                    }}
                  />
                ) : previewError ? (
                  <div
                    style={{
                      color: "#94a3b8",
                      fontSize: "12px",
                      fontFamily: MONO_FONT,
                    }}
                  >
                    Preview unavailable ({selectedAsset.mimeType ?? "binary"})
                  </div>
                ) : (
                  <img
                    src={rawAssetUrl(selectedAsset.source)}
                    alt={selectedAsset.source}
                    referrerPolicy="no-referrer"
                    onError={() => setPreviewError(true)}
                    style={{
                      maxWidth: "100%",
                      maxHeight: "100%",
                      objectFit: "contain",
                      display: "block",
                    }}
                  />
                )}
              </div>

              {/* Clean Key-Value Metadata Grid */}
              <div
                style={{
                  marginTop: "12px",
                  display: "grid",
                  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                  gap: "10px 12px",
                  padding: "10px 0",
                  borderTopWidth: "1px",
                  borderTopStyle: "solid",
                  borderTopColor: "#1e293b",
                  borderBottomWidth: "1px",
                  borderBottomStyle: "solid",
                  borderBottomColor: "#1e293b",
                  fontSize: "11.5px",
                }}
              >
                <div>
                  <div style={{ color: "#64748b", fontSize: "10.5px" }}>Sniffed Format</div>
                  <div
                    style={{
                      marginTop: "2px",
                      fontFamily: MONO_FONT,
                      color: selectedAsset.formatMismatch ? "#fbbf24" : "#f1f5f9",
                      fontWeight: 600,
                    }}
                  >
                    {(selectedAsset.format ?? "—").toUpperCase()}
                    {selectedAsset.declaredFormat ? ` (.${selectedAsset.declaredFormat})` : ""}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748b", fontSize: "10.5px" }}>Dimensions</div>
                  <div
                    style={{
                      marginTop: "2px",
                      fontFamily: MONO_FONT,
                      fontVariantNumeric: "tabular-nums",
                      color: "#f1f5f9",
                    }}
                  >
                    {selectedAsset.width && selectedAsset.height
                      ? `${selectedAsset.width}×${selectedAsset.height}`
                      : "—"}
                    {selectedAsset.aspectRatio ? ` (${selectedAsset.aspectRatio})` : ""}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748b", fontSize: "10.5px" }}>Footprint</div>
                  <div
                    style={{
                      marginTop: "2px",
                      fontFamily: MONO_FONT,
                      fontVariantNumeric: "tabular-nums",
                      color: "#f1f5f9",
                    }}
                  >
                    {formatBytes(selectedAsset.bytes)}
                    {selectedAsset.bytesPerPixel !== undefined
                      ? ` · ${selectedAsset.bytesPerPixel} B/px`
                      : ""}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748b", fontSize: "10.5px" }}>SHA-256</div>
                  <div
                    style={{
                      marginTop: "2px",
                      fontFamily: MONO_FONT,
                      color: "#cbd5e1",
                    }}
                  >
                    {selectedAsset.sha256 ?? "—"}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748b", fontSize: "10.5px" }}>Backend</div>
                  <div
                    style={{
                      marginTop: "2px",
                      fontFamily: MONO_FONT,
                      color: selectedAsset.backend === "bun" ? "#4ade80" : "#cbd5e1",
                    }}
                  >
                    {selectedAsset.backend ?? "—"}
                  </div>
                </div>
                <div>
                  <div style={{ color: "#64748b", fontSize: "10.5px" }}>
                    {selectedAsset.vectorElementCount !== undefined
                      ? "SVG Primitives"
                      : "ThumbHash"}
                  </div>
                  <div
                    style={{
                      marginTop: "2px",
                      fontFamily: MONO_FONT,
                      color: "#cbd5e1",
                    }}
                  >
                    {selectedAsset.vectorElementCount !== undefined
                      ? `${selectedAsset.vectorElementCount} elements`
                      : selectedAsset.placeholderDataUrl
                        ? `${selectedAsset.placeholderDataUrl.length} chars`
                        : "—"}
                  </div>
                </div>
              </div>

              {/* Transform Studio (Raster Assets) or Vector Summary (SVG) */}
              {selectedAsset.canTransform === false ? (
                <div
                  style={{
                    marginTop: "14px",
                    fontSize: "12px",
                    color: "#94a3b8",
                    lineHeight: 1.5,
                  }}
                >
                  This asset is a vector graphic (
                  <code style={{ fontFamily: MONO_FONT }}>image/svg+xml</code>) inspected with
                  Bun&apos;s native file reader &amp; SHA-256 hasher. Select any PNG, JPEG, WebP, or
                  mis-labeled raster asset to run live{" "}
                  <code style={{ fontFamily: MONO_FONT }}>Bun.Image</code> transcoding and resizing.
                </div>
              ) : (
                <div style={{ marginTop: "14px" }}>
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "10px",
                    }}
                  >
                    <h3
                      style={{
                        margin: 0,
                        fontSize: "13px",
                        fontWeight: 600,
                        color: "#f1f5f9",
                      }}
                    >
                      Bun.Image Format &amp; Resize Pipeline
                    </h3>
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: "4px",
                      }}
                    >
                      {(
                        [
                          ["webp80", "WebP 80%"],
                          ["thumb320", "320px WebP"],
                          ["jpeg85", "JPEG 85%"],
                          ["png6", "PNG Opt"],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => applyPreset(id)}
                          style={{
                            padding: "3px 7px",
                            borderRadius: "4px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: "#334155",
                            backgroundColor: "#0f172a",
                            color: "#cbd5e1",
                            fontSize: "10.5px",
                            fontWeight: 500,
                            whiteSpace: "nowrap",
                            cursor: "pointer",
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Format Selector */}
                  <div
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "6px",
                      marginBottom: "12px",
                    }}
                  >
                    {codecs.map((codec) => {
                      const active = targetFormat === codec.format
                      return (
                        <button
                          key={codec.format}
                          type="button"
                          disabled={!codec.supported}
                          title={codec.note}
                          onClick={() => setTargetFormat(codec.format)}
                          style={{
                            padding: "5px 10px",
                            borderRadius: "5px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: active
                              ? "#38bdf8"
                              : codec.supported
                                ? "#334155"
                                : "#1e293b",
                            backgroundColor: active ? "rgba(56, 189, 248, 0.16)" : "#0f172a",
                            color: !codec.supported ? "#475569" : active ? "#38bdf8" : "#e2e8f0",
                            fontFamily: MONO_FONT,
                            fontSize: "11px",
                            fontWeight: 600,
                            cursor: codec.supported ? "pointer" : "not-allowed",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {codec.format.toUpperCase()}
                          {!codec.supported ? " (OS)" : ""}
                        </button>
                      )
                    })}
                  </div>

                  {/* Controls Grid */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                      gap: "10px",
                      fontSize: "11.5px",
                    }}
                  >
                    <label style={{ display: "block", color: "#94a3b8" }}>
                      Max Width (px)
                      <input
                        type="number"
                        min={16}
                        max={4096}
                        placeholder={String(selectedAsset.width ?? "auto")}
                        value={widthInput}
                        onChange={(e) => setWidthInput(e.target.value)}
                        style={{
                          marginTop: "4px",
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "6px 8px",
                          borderRadius: "5px",
                          borderWidth: "1px",
                          borderStyle: "solid",
                          borderColor: "#334155",
                          backgroundColor: "#0f172a",
                          color: "#f1f5f9",
                          fontFamily: MONO_FONT,
                          fontSize: "12px",
                        }}
                      />
                    </label>

                    <label style={{ display: "block", color: "#94a3b8" }}>
                      Max Height (px)
                      <input
                        type="number"
                        min={16}
                        max={4096}
                        placeholder={String(selectedAsset.height ?? "auto")}
                        value={heightInput}
                        onChange={(e) => setHeightInput(e.target.value)}
                        style={{
                          marginTop: "4px",
                          width: "100%",
                          boxSizing: "border-box",
                          padding: "6px 8px",
                          borderRadius: "5px",
                          borderWidth: "1px",
                          borderStyle: "solid",
                          borderColor: "#334155",
                          backgroundColor: "#0f172a",
                          color: "#f1f5f9",
                          fontFamily: MONO_FONT,
                          fontSize: "12px",
                        }}
                      />
                    </label>

                    <label style={{ display: "block", color: "#94a3b8" }}>
                      Resample Filter
                      <select
                        value={resampleFilter}
                        onChange={(e) =>
                          setResampleFilter(e.target.value as BunImageResampleFilter)
                        }
                        style={{
                          marginTop: "4px",
                          width: "100%",
                          padding: "6px 8px",
                          borderRadius: "5px",
                          borderWidth: "1px",
                          borderStyle: "solid",
                          borderColor: "#334155",
                          backgroundColor: "#0f172a",
                          color: "#f1f5f9",
                          fontFamily: MONO_FONT,
                          fontSize: "12px",
                        }}
                      >
                        <option value="lanczos3">lanczos3 (sharp)</option>
                        <option value="mitchell">mitchell (balanced)</option>
                        <option value="cubic">cubic</option>
                        <option value="bilinear">bilinear (fast)</option>
                        <option value="nearest">nearest (pixel)</option>
                      </select>
                    </label>

                    <label style={{ display: "block", color: "#94a3b8" }}>
                      Fit &amp; Rotate
                      <div
                        style={{
                          marginTop: "4px",
                          display: "flex",
                          gap: "6px",
                        }}
                      >
                        <select
                          aria-label="Resize fit mode"
                          value={fit}
                          onChange={(e) => setFit(e.target.value as "inside" | "fill")}
                          style={{
                            flex: 1,
                            padding: "6px 6px",
                            borderRadius: "5px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: "#334155",
                            backgroundColor: "#0f172a",
                            color: "#f1f5f9",
                            fontFamily: MONO_FONT,
                            fontSize: "11.5px",
                          }}
                        >
                          <option value="inside">inside</option>
                          <option value="fill">fill</option>
                        </select>
                        <select
                          aria-label="Rotation angle"
                          value={rotate}
                          onChange={(e) => setRotate(Number(e.target.value) as 0 | 90 | 180 | 270)}
                          style={{
                            flex: 1,
                            padding: "6px 6px",
                            borderRadius: "5px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: "#334155",
                            backgroundColor: "#0f172a",
                            color: "#f1f5f9",
                            fontFamily: MONO_FONT,
                            fontSize: "11.5px",
                          }}
                        >
                          <option value={0}>0°</option>
                          <option value={90}>90°</option>
                          <option value={180}>180°</option>
                          <option value={270}>270°</option>
                        </select>
                      </div>
                    </label>

                    {targetFormat === "png" ? (
                      <div
                        data-png-options-panel="true"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "8px",
                        }}
                      >
                        <label style={{ display: "block", color: "#94a3b8" }}>
                          PNG Compression (zlib 0–9):{" "}
                          <strong
                            style={{
                              color: "#f1f5f9",
                              fontFamily: MONO_FONT,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {compressionLevel}
                          </strong>
                          <input
                            type="range"
                            min={0}
                            max={9}
                            step={1}
                            value={compressionLevel}
                            onChange={(e) => setCompressionLevel(Number(e.target.value))}
                            style={{ width: "100%", marginTop: "6px" }}
                          />
                        </label>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "center",
                            gap: "10px",
                            color: "#cbd5e1",
                          }}
                        >
                          <label
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "5px",
                              cursor: "pointer",
                            }}
                            title="Quantize to <= 256 colors and emit an indexed PNG (color-type 3, typically 3-5x smaller)"
                          >
                            <input
                              type="checkbox"
                              data-png-palette-toggle="true"
                              checked={pngPalette}
                              onChange={(e) => setPngPalette(e.target.checked)}
                            />
                            <span>Indexed Palette (type 3)</span>
                          </label>
                          {pngPalette ? (
                            <label
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "5px",
                                cursor: "pointer",
                              }}
                              title="Apply Floyd-Steinberg dithering during palette quantization"
                            >
                              <input
                                type="checkbox"
                                data-png-dither-toggle="true"
                                checked={pngDither}
                                onChange={(e) => setPngDither(e.target.checked)}
                              />
                              <span>Dither</span>
                            </label>
                          ) : null}
                        </div>
                        {pngPalette ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "6px",
                              }}
                            >
                              <span style={{ color: "#94a3b8" }}>
                                Palette Colors:{" "}
                                <strong
                                  style={{
                                    color: "#f1f5f9",
                                    fontFamily: MONO_FONT,
                                    fontVariantNumeric: "tabular-nums",
                                  }}
                                >
                                  {pngColors}
                                </strong>
                              </span>
                              <div style={{ display: "inline-flex", gap: "4px" }}>
                                {[16, 64, 128, 256].map((preset) => (
                                  <button
                                    key={preset}
                                    type="button"
                                    onClick={() => setPngColors(preset)}
                                    style={{
                                      padding: "1px 5px",
                                      borderRadius: "4px",
                                      borderWidth: "1px",
                                      borderStyle: "solid",
                                      borderColor:
                                        pngColors === preset ? "#38bdf8" : "#334155",
                                      backgroundColor:
                                        pngColors === preset
                                          ? "rgba(56, 189, 248, 0.16)"
                                          : "#0f172a",
                                      color: pngColors === preset ? "#38bdf8" : "#94a3b8",
                                      fontFamily: MONO_FONT,
                                      fontSize: "10px",
                                      cursor: "pointer",
                                    }}
                                  >
                                    {preset}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <input
                              type="range"
                              data-png-colors-slider="true"
                              min={2}
                              max={256}
                              step={1}
                              value={pngColors}
                              onChange={(e) => setPngColors(Number(e.target.value))}
                              style={{ width: "100%" }}
                            />
                          </div>
                        ) : null}
                        <code
                          data-png-call-preview="true"
                          style={{
                            display: "block",
                            padding: "4px 6px",
                            borderRadius: "4px",
                            backgroundColor: "#0f172a",
                            border: "1px solid #1e293b",
                            color: "#7dd3fc",
                            fontFamily: MONO_FONT,
                            fontSize: "10.5px",
                            overflowX: "auto",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {pngPalette
                            ? `img.png({ compressionLevel: ${compressionLevel}, palette: true, colors: ${pngColors}, dither: ${pngDither} })`
                            : `img.png({ compressionLevel: ${compressionLevel} })`}
                        </code>
                      </div>
                    ) : targetFormat === "webp" ? (
                      <div
                        data-webp-options-panel="true"
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "8px",
                        }}
                      >
                        <label style={{ display: "block", color: "#94a3b8" }}>
                          Quality:{" "}
                          <strong
                            style={{
                              color: "#f1f5f9",
                              fontFamily: MONO_FONT,
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {quality}%
                          </strong>
                          <input
                            type="range"
                            min={10}
                            max={100}
                            step={1}
                            value={quality}
                            onChange={(e) => setQuality(Number(e.target.value))}
                            style={{ width: "100%", marginTop: "6px" }}
                          />
                        </label>
                        <label
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "5px",
                            color: "#cbd5e1",
                            cursor: "pointer",
                          }}
                          title="Emit lossless VP8L bitstream instead of lossy VP8"
                        >
                          <input
                            type="checkbox"
                            data-webp-lossless-toggle="true"
                            checked={webpLossless}
                            onChange={(e) => setWebpLossless(e.target.checked)}
                          />
                          <span>Lossless (VP8L)</span>
                        </label>
                        <code
                          data-webp-call-preview="true"
                          style={{
                            display: "block",
                            padding: "4px 6px",
                            borderRadius: "4px",
                            backgroundColor: "#0f172a",
                            border: "1px solid #1e293b",
                            color: "#7dd3fc",
                            fontFamily: MONO_FONT,
                            fontSize: "10.5px",
                            overflowX: "auto",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {`img.webp({ lossless: ${webpLossless}, quality: ${quality} })`}
                        </code>
                      </div>
                    ) : (
                      <label style={{ display: "block", color: "#94a3b8" }}>
                        Quality:{" "}
                        <strong
                          style={{
                            color: "#f1f5f9",
                            fontFamily: MONO_FONT,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {quality}%
                        </strong>
                        <input
                          type="range"
                          min={10}
                          max={100}
                          step={1}
                          value={quality}
                          onChange={(e) => setQuality(Number(e.target.value))}
                          style={{ width: "100%", marginTop: "6px" }}
                        />
                      </label>
                    )}

                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        paddingTop: "14px",
                        color: "#cbd5e1",
                      }}
                    >
                      <label
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={flip}
                          onChange={(e) => setFlip(e.target.checked)}
                        />
                        Flip V
                      </label>
                      <label
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "5px",
                          cursor: "pointer",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={flop}
                          onChange={(e) => setFlop(e.target.checked)}
                        />
                        Flop H
                      </label>
                    </div>

                    <label style={{ display: "block", color: "#94a3b8" }}>
                      Brightness:{" "}
                      <strong
                        style={{
                          color: "#f1f5f9",
                          fontFamily: MONO_FONT,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {brightness.toFixed(2)}×
                      </strong>
                      <input
                        type="range"
                        min={0.4}
                        max={1.8}
                        step={0.05}
                        value={brightness}
                        onChange={(e) => setBrightness(Number(e.target.value))}
                        style={{ width: "100%", marginTop: "6px" }}
                      />
                    </label>

                    <label style={{ display: "block", color: "#94a3b8" }}>
                      Saturation:{" "}
                      <strong
                        style={{
                          color: "#f1f5f9",
                          fontFamily: MONO_FONT,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {saturation.toFixed(2)}×
                      </strong>
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.05}
                        value={saturation}
                        onChange={(e) => setSaturation(Number(e.target.value))}
                        style={{ width: "100%", marginTop: "6px" }}
                      />
                    </label>
                  </div>

                  {/* Primary Transform Action */}
                  <div
                    style={{
                      marginTop: "14px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "10px",
                    }}
                  >
                    <button
                      type="button"
                      disabled={transforming}
                      onClick={() => void runTransform()}
                      style={{
                        flex: 1,
                        padding: "9px 16px",
                        borderRadius: "6px",
                        borderWidth: 0,
                        backgroundColor: transforming ? "#1e293b" : "#38bdf8",
                        color: transforming ? "#94a3b8" : "#070b14",
                        fontSize: "12.5px",
                        fontWeight: 700,
                        cursor: transforming ? "wait" : "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {transforming
                        ? "Encoding via Bun.Image…"
                        : `Convert to ${targetFormat.toUpperCase()} with Bun.Image`}
                    </button>
                  </div>

                  {transformError ? (
                    <div
                      role="alert"
                      style={{
                        marginTop: "10px",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor: "rgba(248, 113, 113, 0.35)",
                        backgroundColor: "rgba(127, 29, 29, 0.25)",
                        color: "#fca5a5",
                        fontSize: "11.5px",
                      }}
                    >
                      {transformError}
                    </div>
                  ) : null}

                  {/* Transform Output Comparison */}
                  {transformResult ? (
                    <div
                      style={{
                        marginTop: "14px",
                        paddingTop: "14px",
                        borderTopWidth: "1px",
                        borderTopStyle: "solid",
                        borderTopColor: "#1e293b",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          justifyContent: "space-between",
                          alignItems: "baseline",
                          gap: "8px",
                          marginBottom: "8px",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "12px",
                            fontWeight: 600,
                            color: "#f1f5f9",
                          }}
                        >
                          Native Output ({transformResult.outputFormat.toUpperCase()})
                        </div>
                        <div
                          style={{
                            fontFamily: MONO_FONT,
                            fontVariantNumeric: "tabular-nums",
                            fontSize: "11.5px",
                            color: transformResult.savedBytes >= 0 ? "#4ade80" : "#fbbf24",
                            fontWeight: 600,
                          }}
                        >
                          {formatBytes(transformResult.originalBytes)} →{" "}
                          {formatBytes(transformResult.outputBytes)} (
                          {transformResult.savedBytes >= 0
                            ? `-${transformResult.savedPct}%`
                            : `+${Math.abs(transformResult.savedPct)}%`}
                          )
                        </div>
                      </div>

                      <div
                        style={{
                          height: "156px",
                          borderRadius: "6px",
                          borderWidth: "1px",
                          borderStyle: "solid",
                          borderColor: "#1e293b",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          overflow: "hidden",
                          ...CHECKERBOARD_BG,
                        }}
                      >
                        <img
                          src={transformResult.dataUrl}
                          alt={`Transformed ${transformResult.source}`}
                          referrerPolicy="no-referrer"
                          style={{
                            maxWidth: "100%",
                            maxHeight: "100%",
                            objectFit: "contain",
                            display: "block",
                          }}
                        />
                      </div>

                      <div
                        style={{
                          marginTop: "8px",
                          display: "flex",
                          flexWrap: "wrap",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: "8px",
                        }}
                      >
                        <span
                          style={{
                            fontFamily: MONO_FONT,
                            fontVariantNumeric: "tabular-nums",
                            fontSize: "11px",
                            color: "#94a3b8",
                          }}
                        >
                          {transformResult.outputWidth}×{transformResult.outputHeight}
                          {transformResult.pngColorTypeLabel
                            ? ` · ${transformResult.pngColorTypeLabel}`
                            : transformResult.webpBitstream
                              ? ` · ${transformResult.webpBitstream}`
                              : ""}{" "}
                          · {transformResult.durationMs}ms · {transformResult.backend} · #
                          {transformResult.sha256}
                        </span>
                        <div style={{ display: "flex", gap: "6px" }}>
                          <button
                            type="button"
                            onClick={() => void handleCopyDataUrl()}
                            style={{
                              padding: "5px 9px",
                              borderRadius: "5px",
                              borderWidth: "1px",
                              borderStyle: "solid",
                              borderColor: "#334155",
                              backgroundColor: "#0f172a",
                              color: copiedDataUrl ? "#4ade80" : "#cbd5e1",
                              fontSize: "11px",
                              fontWeight: 600,
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {copiedDataUrl ? "Copied Data URL" : "Copy Data URL"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              triggerDataUrlDownload(
                                transformResult.dataUrl,
                                transformResult.source,
                                transformResult.outputFormat === "jpeg"
                                  ? "jpg"
                                  : transformResult.outputFormat,
                              )
                            }
                            style={{
                              padding: "5px 10px",
                              borderRadius: "5px",
                              borderWidth: "1px",
                              borderStyle: "solid",
                              borderColor: "#38bdf8",
                              backgroundColor: "rgba(56, 189, 248, 0.14)",
                              color: "#38bdf8",
                              fontSize: "11px",
                              fontWeight: 600,
                              cursor: "pointer",
                              whiteSpace: "nowrap",
                            }}
                          >
                            Download Output
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
