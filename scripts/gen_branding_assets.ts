#!/usr/bin/env bun
/**
 * @file scripts/gen_branding_assets.ts
 * @description Deterministic SportsDesk Ops branding & contextual metadata asset generator.
 *
 * Reads `design/branding.toml` via native `Bun.TOML` (`lib/bun_toml.ts`), renders all
 * emblem/favicon/PWA/OpenGraph derivatives with native `Bun.Image`, stamps PNG/WebP
 * outputs with rich Dublin Core + XMP Core + `sportsdesk:*` operational context metadata,
 * verifies every binary with `inspectImageProvenance`, and emits:
 *   - `public/assets/branding/branding-metadata.json`
 *   - `public/manifest.webmanifest`
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { sha256HexBytes } from "../lib/binary.ts"
import { parseToml } from "../lib/bun_toml.ts"
import {
  buildSportsdeskProvenanceXmp,
  type ImageProvenanceContextInput,
  inspectImageProvenance,
} from "../lib/image_provenance.ts"
import { injectXmp } from "../lib/xmp_container.ts"

export interface BrandingAssetSpec {
  readonly id: string
  readonly slug: string
  readonly source_key: string
  readonly output_path: string
  readonly public_url: string
  readonly format: "webp" | "png" | "jpeg"
  readonly width: number
  readonly height: number
  readonly fit: "fill" | "inside"
  readonly quality?: number
  readonly lossless?: boolean
  readonly compression_level?: number
  readonly embed_xmp: boolean
  readonly asset_role: string
  readonly surface_context: string
  readonly stream_id: string
  readonly title: string
  readonly description: string
  readonly subjects: readonly string[]
}

export interface BrandingTomlSpec {
  readonly meta: {
    readonly schema: string
    readonly version: string
    readonly tokens_spec: string
    readonly tokens_version: string
    readonly updated_at: string
    readonly generation: number
  }
  readonly brand: {
    readonly app_name: string
    readonly short_name: string
    readonly monogram: string
    readonly version: string
    readonly organization: string
    readonly tagline: string
    readonly description: string
    readonly rights: string
    readonly creator_tool: string
    readonly emblem_alt: string
    readonly og_image_alt: string
  }
  readonly context: {
    readonly domain: string
    readonly audience: string
    readonly classification: string
    readonly surfaces: readonly string[]
    readonly keywords: readonly string[]
  }
  readonly palette: Readonly<Record<string, string>>
  readonly sources: Readonly<Record<string, string>>
  readonly assets: readonly BrandingAssetSpec[]
}

export interface BrandingCatalogAssetEntry {
  readonly id: string
  readonly slug: string
  readonly title: string
  readonly description: string
  readonly assetRole: string
  readonly surfaceContext: string
  readonly subjects: readonly string[]
  readonly repoPath: string
  readonly publicUrl: string
  readonly sourceMasterPath: string
  readonly sourceMasterSha256: string
  readonly format: "webp" | "png" | "jpeg"
  readonly mimeType: string
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly sha256: string
  readonly metadataBearing: boolean
  readonly xmpChannels: readonly string[]
  readonly provenance: {
    readonly streamId: string
    readonly genU32: number
    readonly merkleRoot: string
  }
  readonly embeddedContext: {
    readonly brand: string
    readonly domainContext: string
    readonly tokensVersion: string
    readonly sourceSpec: string
    readonly creator: string
    readonly rights: string
    readonly creatorTool: string
  }
}

export interface BrandingMetadataCatalog {
  readonly schema: string
  readonly version: string
  readonly tokensSpec: string
  readonly tokensVersion: string
  readonly updatedAt: string
  readonly generation: number
  readonly brand: {
    readonly appName: string
    readonly shortName: string
    readonly monogram: string
    readonly version: string
    readonly organization: string
    readonly tagline: string
    readonly description: string
    readonly rights: string
    readonly creatorTool: string
    readonly emblemAlt: string
    readonly ogImageAlt: string
  }
  readonly context: {
    readonly domain: string
    readonly audience: string
    readonly classification: string
    readonly surfaces: readonly string[]
    readonly keywords: readonly string[]
  }
  readonly palette: Readonly<Record<string, string>>
  readonly totalAssets: number
  readonly metadataBearingCount: number
  readonly embeddedMetadataStandards: readonly string[]
  readonly assets: readonly BrandingCatalogAssetEntry[]
}

export interface BrandingAuditEntry {
  readonly id: string
  readonly slug: string
  readonly repoPath: string
  readonly format: string
  readonly bytes: number
  readonly sha256: string
  readonly metadataBearing: boolean
  readonly xmpVerified: boolean
  readonly ok: boolean
  readonly issues: readonly string[]
}

export interface BrandingAuditResult {
  readonly specPath: string
  readonly catalogPath: string
  readonly manifestPath: string
  readonly totalAssets: number
  readonly verifiedFiles: number
  readonly xmpVerifiedFiles: number
  readonly entries: readonly BrandingAuditEntry[]
  readonly issues: readonly string[]
}

const SPEC_REL_PATH = "design/branding.toml"
const CATALOG_REL_PATH = "public/assets/branding/branding-metadata.json"
const WEB_MANIFEST_REL_PATH = "public/manifest.webmanifest"

function mimeForFormat(format: "webp" | "png" | "jpeg"): string {
  if (format === "webp") return "image/webp"
  if (format === "png") return "image/png"
  return "image/jpeg"
}

export function loadBrandingSpec(rootDir: string): BrandingTomlSpec {
  const fullPath = resolve(rootDir, SPEC_REL_PATH)
  const raw = readFileSync(fullPath, "utf8")
  return parseToml(raw) as unknown as BrandingTomlSpec
}

function buildPaletteSignature(palette: Readonly<Record<string, string>>): string {
  const keys = ["canvas_bg", "surface_elevated", "accent_primary", "accent_emerald"]
  const parts: string[] = []
  for (const key of keys) {
    const val = palette[key]
    if (val) parts.push(`${key}=${val}`)
  }
  return parts.join(";")
}

export function buildBrandingAssetXmpContext(
  spec: BrandingTomlSpec,
  asset: BrandingAssetSpec,
): ImageProvenanceContextInput {
  return {
    title: asset.title,
    description: asset.description,
    creator: spec.brand.organization,
    rights: spec.brand.rights,
    creatorTool: spec.brand.creator_tool,
    createDate: spec.meta.updated_at,
    brand: spec.brand.short_name,
    assetRole: asset.asset_role,
    surfaceContext: asset.surface_context,
    domainContext: spec.context.domain,
    tokensVersion: spec.meta.tokens_version,
    sourceSpec: SPEC_REL_PATH,
    palette: buildPaletteSignature(spec.palette),
    subjects: asset.subjects,
  }
}

export function emitWebAppManifest(spec: BrandingTomlSpec): string {
  const manifest = {
    name: spec.brand.app_name,
    short_name: spec.brand.short_name,
    description: spec.brand.description,
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: spec.palette.canvas_bg ?? "#070b14",
    theme_color: spec.palette.canvas_bg ?? "#070b14",
    categories: ["finance", "analytics", "utilities"],
    icons: [
      {
        src: "/assets/branding/sportsdesk-emblem-64.png",
        sizes: "64x64",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/assets/branding/sportsdesk-emblem-180.png",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/assets/branding/sportsdesk-emblem.webp",
        sizes: "256x256",
        type: "image/webp",
        purpose: "any",
      },
      {
        src: "/assets/branding/sportsdesk-emblem-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
  }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

async function encodeBrandDerivative(
  masterBytes: Uint8Array,
  asset: BrandingAssetSpec,
): Promise<Uint8Array> {
  const resized = new Bun.Image(masterBytes).resize(asset.width, asset.height, {
    fit: asset.fit,
    withoutEnlargement: false,
    filter: "lanczos3",
  })

  if (asset.format === "webp") {
    const buf = await resized
      .webp({
        lossless: Boolean(asset.lossless),
        quality: asset.quality ?? 88,
      })
      .toBuffer()
    return new Uint8Array(buf)
  }

  if (asset.format === "png") {
    const buf = await resized
      .png({
        compressionLevel: asset.compression_level ?? 9,
      })
      .toBuffer()
    return new Uint8Array(buf)
  }

  const buf = await resized.jpeg({ quality: asset.quality ?? 88 }).toBuffer()
  return new Uint8Array(buf)
}

/**
 * Generates all branding assets from `design/branding.toml`, stamps PNG/WebP derivatives
 * with rich contextual XMP metadata, and writes `branding-metadata.json` + `manifest.webmanifest`.
 */
export async function generateBrandingAssets(rootDir: string): Promise<{
  readonly catalog: BrandingMetadataCatalog
  readonly writtenFiles: readonly string[]
}> {
  const spec = loadBrandingSpec(rootDir)
  const writtenFiles: string[] = []
  const masterCache = new Map<string, { readonly bytes: Uint8Array; readonly sha256: string }>()
  const entries: BrandingCatalogAssetEntry[] = []

  for (const asset of spec.assets) {
    const masterRelPath = spec.sources[asset.source_key]
    if (!masterRelPath) {
      throw new Error(`Branding asset ${asset.id} references unknown source_key=${asset.source_key}`)
    }
    let cached = masterCache.get(masterRelPath)
    if (!cached) {
      const masterFull = resolve(rootDir, masterRelPath)
      const bytes = new Uint8Array(readFileSync(masterFull))
      cached = { bytes, sha256: sha256HexBytes(bytes) }
      masterCache.set(masterRelPath, cached)
    }

    let outBytes = await encodeBrandDerivative(cached.bytes, asset)
    const contextInput = buildBrandingAssetXmpContext(spec, asset)

    let xmpChannels: readonly string[] = []
    let metadataBearing = false

    if (asset.embed_xmp && (asset.format === "webp" || asset.format === "png")) {
      const xmpXml = buildSportsdeskProvenanceXmp(
        {
          streamId: asset.stream_id,
          genU32: spec.meta.generation,
          merkleRoot: cached.sha256,
        },
        contextInput,
      )
      outBytes = injectXmp(outBytes, xmpXml)
      const verified = await inspectImageProvenance(outBytes)
      if (!verified.available || verified.fields.streamId !== asset.stream_id) {
        throw new Error(`XMP verification failed for generated branding asset ${asset.output_path}`)
      }
      xmpChannels = verified.channels
      metadataBearing = verified.channels.length > 0
    }

    const outFull = resolve(rootDir, asset.output_path)
    mkdirSync(dirname(outFull), { recursive: true })
    writeFileSync(outFull, outBytes)
    writtenFiles.push(asset.output_path)

    const outSha256 = sha256HexBytes(outBytes)
    entries.push({
      id: asset.id,
      slug: asset.slug,
      title: asset.title,
      description: asset.description,
      assetRole: asset.asset_role,
      surfaceContext: asset.surface_context,
      subjects: [...asset.subjects],
      repoPath: asset.output_path,
      publicUrl: asset.public_url,
      sourceMasterPath: masterRelPath,
      sourceMasterSha256: cached.sha256,
      format: asset.format,
      mimeType: mimeForFormat(asset.format),
      width: asset.width,
      height: asset.height,
      bytes: outBytes.byteLength,
      sha256: outSha256,
      metadataBearing,
      xmpChannels,
      provenance: {
        streamId: asset.stream_id,
        genU32: spec.meta.generation,
        merkleRoot: cached.sha256,
      },
      embeddedContext: {
        brand: spec.brand.short_name,
        domainContext: spec.context.domain,
        tokensVersion: spec.meta.tokens_version,
        sourceSpec: SPEC_REL_PATH,
        creator: spec.brand.organization,
        rights: spec.brand.rights,
        creatorTool: spec.brand.creator_tool,
      },
    })
  }

  const catalog: BrandingMetadataCatalog = {
    schema: spec.meta.schema,
    version: spec.meta.version,
    tokensSpec: spec.meta.tokens_spec,
    tokensVersion: spec.meta.tokens_version,
    updatedAt: spec.meta.updated_at,
    generation: spec.meta.generation,
    brand: {
      appName: spec.brand.app_name,
      shortName: spec.brand.short_name,
      monogram: spec.brand.monogram,
      version: spec.brand.version,
      organization: spec.brand.organization,
      tagline: spec.brand.tagline,
      description: spec.brand.description,
      rights: spec.brand.rights,
      creatorTool: spec.brand.creator_tool,
      emblemAlt: spec.brand.emblem_alt,
      ogImageAlt: spec.brand.og_image_alt,
    },
    context: {
      domain: spec.context.domain,
      audience: spec.context.audience,
      classification: spec.context.classification,
      surfaces: [...spec.context.surfaces],
      keywords: [...spec.context.keywords],
    },
    palette: { ...spec.palette },
    totalAssets: entries.length,
    metadataBearingCount: entries.filter((e) => e.metadataBearing).length,
    embeddedMetadataStandards: [
      "Adobe XMP Packet (WebP RIFF XMP chunk with VP8X flag & PNG iTXt XML:com.adobe.xmp)",
      "Dublin Core Metadata Element Set (dc:title, dc:description, dc:creator, dc:rights, dc:subject)",
      "XMP Basic Schema (xmp:CreatorTool, xmp:CreateDate)",
      "SportsDesk Provenance & Brand Context Namespace (sportsdesk:streamId, genU32, merkleRoot, brand, assetRole, surfaceContext, domainContext, tokensVersion, sourceSpec, palette)",
      "W3C Web App Manifest (public/manifest.webmanifest) & Schema.org WebApplication JSON-LD",
    ],
    assets: entries,
  }

  const catalogFull = resolve(rootDir, CATALOG_REL_PATH)
  mkdirSync(dirname(catalogFull), { recursive: true })
  writeFileSync(catalogFull, `${JSON.stringify(catalog, null, 2)}\n`, "utf8")
  writtenFiles.push(CATALOG_REL_PATH)

  const webManifestFull = resolve(rootDir, WEB_MANIFEST_REL_PATH)
  mkdirSync(dirname(webManifestFull), { recursive: true })
  writeFileSync(webManifestFull, emitWebAppManifest(spec), "utf8")
  writtenFiles.push(WEB_MANIFEST_REL_PATH)

  return { catalog, writtenFiles }
}

/**
 * Verifies every branding asset in `public/assets/branding/branding-metadata.json`
 * matches on-disk byte size, SHA-256 hash, and embedded XMP provenance metadata.
 */
export async function auditBrandingAssetsMetadata(rootDir: string): Promise<BrandingAuditResult> {
  const fullCatalog = resolve(rootDir, CATALOG_REL_PATH)
  const issues: string[] = []
  const entries: BrandingAuditEntry[] = []

  if (!existsSync(resolve(rootDir, SPEC_REL_PATH))) {
    issues.push(`Missing branding spec: ${SPEC_REL_PATH}`)
  }
  if (!existsSync(resolve(rootDir, WEB_MANIFEST_REL_PATH))) {
    issues.push(`Missing web app manifest: ${WEB_MANIFEST_REL_PATH}`)
  }
  if (!existsSync(fullCatalog)) {
    issues.push(`Missing branding metadata catalog: ${CATALOG_REL_PATH}`)
    return {
      specPath: SPEC_REL_PATH,
      catalogPath: CATALOG_REL_PATH,
      manifestPath: WEB_MANIFEST_REL_PATH,
      totalAssets: 0,
      verifiedFiles: 0,
      xmpVerifiedFiles: 0,
      entries,
      issues,
    }
  }

  const catalog = JSON.parse(readFileSync(fullCatalog, "utf8")) as BrandingMetadataCatalog
  let verifiedFiles = 0
  let xmpVerifiedFiles = 0

  for (const asset of catalog.assets) {
    const itemIssues: string[] = []
    const fullPath = resolve(rootDir, asset.repoPath)
    if (!existsSync(fullPath)) {
      const msg = `${asset.slug}: missing branding asset at ${asset.repoPath}`
      itemIssues.push(msg)
      issues.push(msg)
      entries.push({
        id: asset.id,
        slug: asset.slug,
        repoPath: asset.repoPath,
        format: asset.format,
        bytes: 0,
        sha256: "",
        metadataBearing: asset.metadataBearing,
        xmpVerified: false,
        ok: false,
        issues: itemIssues,
      })
      continue
    }

    const bytes = new Uint8Array(readFileSync(fullPath))
    const actualSha = sha256HexBytes(bytes)
    if (bytes.byteLength !== asset.bytes) {
      const msg = `${asset.repoPath}: byte size drift (actual=${bytes.byteLength}, catalog=${asset.bytes})`
      itemIssues.push(msg)
      issues.push(msg)
    }
    if (actualSha !== asset.sha256) {
      const msg = `${asset.repoPath}: SHA-256 drift (actual=${actualSha.slice(0, 12)}, catalog=${asset.sha256.slice(0, 12)})`
      itemIssues.push(msg)
      issues.push(msg)
    }

    let xmpVerified = false
    if (asset.metadataBearing) {
      const report = await inspectImageProvenance(bytes)
      if (!report.available || report.channels.length === 0) {
        const msg = `${asset.repoPath}: missing embedded XMP provenance metadata`
        itemIssues.push(msg)
        issues.push(msg)
      } else if (report.fields.streamId !== asset.provenance.streamId) {
        const msg = `${asset.repoPath}: XMP streamId mismatch (actual=${report.fields.streamId}, expected=${asset.provenance.streamId})`
        itemIssues.push(msg)
        issues.push(msg)
      } else if (!report.context?.brand || !report.context?.assetRole) {
        const msg = `${asset.repoPath}: XMP missing sportsdesk brand/assetRole context`
        itemIssues.push(msg)
        issues.push(msg)
      } else {
        xmpVerified = true
        xmpVerifiedFiles += 1
      }
    }

    if (itemIssues.length === 0) {
      verifiedFiles += 1
    }

    entries.push({
      id: asset.id,
      slug: asset.slug,
      repoPath: asset.repoPath,
      format: asset.format,
      bytes: bytes.byteLength,
      sha256: actualSha,
      metadataBearing: asset.metadataBearing,
      xmpVerified,
      ok: itemIssues.length === 0,
      issues: itemIssues,
    })
  }

  return {
    specPath: SPEC_REL_PATH,
    catalogPath: CATALOG_REL_PATH,
    manifestPath: WEB_MANIFEST_REL_PATH,
    totalAssets: catalog.assets.length,
    verifiedFiles,
    xmpVerifiedFiles,
    entries,
    issues,
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]).endsWith("gen_branding_assets.ts")

if (isMain) {
  const args = new Set(process.argv.slice(2))
  const rootDir = process.cwd()

  if (args.has("--check")) {
    const audit = await auditBrandingAssetsMetadata(rootDir)
    if (audit.issues.length > 0) {
      console.error("FAIL: Branding asset integrity & metadata check failed:")
      for (const issue of audit.issues) {
        console.error(`  - ${issue}`)
      }
      process.exit(1)
    }
    console.log(
      `PASS: Verified ${audit.verifiedFiles}/${audit.totalAssets} branding assets (${audit.xmpVerifiedFiles} XMP-stamped) from ${audit.specPath}.`,
    )
  } else {
    const { catalog, writtenFiles } = await generateBrandingAssets(rootDir)
    console.log(
      `PASS: Generated ${catalog.totalAssets} branding assets (${catalog.metadataBearingCount} with embedded XMP + Dublin Core context) -> ${writtenFiles.length} files synced.`,
    )
  }
}
