/**
 * @file tests/unit/branding_metadata_and_assets.test.ts
 * @description End-to-end verification of SportsDesk Ops branding assets,
 * declarative `design/branding.toml` SSOT, enhanced Dublin Core + XMP Core +
 * `sportsdesk:*` provenance metadata, Bun.Image Format Studio contextual stamping,
 * and index.html SEO/OpenGraph/JSON-LD + Web App Manifest integrity.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  buildSportsdeskProvenanceXmp,
  inspectImageProvenance,
} from "../../lib/image_provenance.ts"
import { injectPngXmp, injectWebpXmp } from "../../lib/xmp_container.ts"
import { auditBrandingAssetsSync } from "../../scripts/gen_artifacts.ts"
import {
  auditBrandingAssetsMetadata,
  loadBrandingSpec,
} from "../../scripts/gen_branding_assets.ts"
import {
  scanBunImageAssets,
  transformBunImageAsset,
} from "../../server/bun_image_engine.ts"

const WORKSPACE_ROOT = resolve(import.meta.dir, "../..")

describe("Enhanced Branding & Contextual XMP Provenance Metadata", () => {
  test("round-trips Dublin Core, XMP Core, and extended sportsdesk:* context across WebP and PNG", async () => {
    const xmp = buildSportsdeskProvenanceXmp(
      {
        streamId: "brand:test-banner:webp",
        genU32: 10123,
        merkleRoot: "0xdeadbeefcafebabe12345678",
      },
      {
        title: "SportsDesk Test Banner & Context",
        description: "Contextual surveillance banner <v1.5> with escaped entities.",
        creator: "SportsDesk & Fantasy402 Quantitative Risk Operations",
        rights: "Copyright (c) 2026 SportsDesk Operations",
        creatorTool: "SportsDesk Bun.Image Branding Pipeline (Bun 1.4.4)",
        createDate: "2026-11-22T00:00:00Z",
        brand: "SportsDesk & Fantasy402 Operations",
        assetRole: "opengraph-social-banner-webp",
        surfaceContext: "social-share-preview",
        domainContext: "sportsbook-risk-surveillance",
        tokensVersion: "1.5.0",
        sourceSpec: "design/branding.toml",
        palette: "canvas_bg=#070b14;accent_primary=#38bdf8",
        subjects: ["sportsdesk-ops", "opengraph", "surveillance"],
      },
    )

    const samplePng = new Uint8Array(
      readFileSync(resolve(WORKSPACE_ROOT, "public/assets/branding/sportsdesk-emblem-64.png")),
    )
    const stampedPng = injectPngXmp(samplePng, xmp)
    const pngReport = await inspectImageProvenance(stampedPng)

    expect(pngReport.available).toBe(true)
    expect(pngReport.format).toBe("png")
    expect(pngReport.channels).toContain("png-xmp")
    expect(pngReport.fields).toEqual({
      streamId: "brand:test-banner:webp",
      genU32: 10123,
      merkleRoot: "deadbeefcafebabe12345678",
    })
    expect(pngReport.context).toEqual({
      title: "SportsDesk Test Banner & Context",
      description: "Contextual surveillance banner <v1.5> with escaped entities.",
      creator: "SportsDesk & Fantasy402 Quantitative Risk Operations",
      rights: "Copyright (c) 2026 SportsDesk Operations",
      creatorTool: "SportsDesk Bun.Image Branding Pipeline (Bun 1.4.4)",
      createDate: "2026-11-22T00:00:00Z",
      brand: "SportsDesk & Fantasy402 Operations",
      assetRole: "opengraph-social-banner-webp",
      surfaceContext: "social-share-preview",
      domainContext: "sportsbook-risk-surveillance",
      tokensVersion: "1.5.0",
      sourceSpec: "design/branding.toml",
      palette: "canvas_bg=#070b14;accent_primary=#38bdf8",
      subjects: ["sportsdesk-ops", "opengraph", "surveillance"],
    })

    const sampleWebp = new Uint8Array(
      readFileSync(resolve(WORKSPACE_ROOT, "public/assets/branding/sportsdesk-emblem.webp")),
    )
    const stampedWebp = injectWebpXmp(sampleWebp, xmp)
    const webpReport = await inspectImageProvenance(stampedWebp)

    expect(webpReport.available).toBe(true)
    expect(webpReport.format).toBe("webp")
    expect(webpReport.channels).toEqual(["webp-xmp"])
    expect(webpReport.context?.brand).toBe("SportsDesk & Fantasy402 Operations")
    expect(webpReport.context?.assetRole).toBe("opengraph-social-banner-webp")
    expect(webpReport.context?.subjects).toEqual(["sportsdesk-ops", "opengraph", "surveillance"])
  })

  test("design/branding.toml and all generated branding assets pass async and sync integrity audits", async () => {
    const spec = loadBrandingSpec(WORKSPACE_ROOT)
    expect(spec.meta.schema).toBe("sportsdesk-branding/v1")
    expect(spec.meta.tokens_version).toBe("1.5.0")
    expect(spec.assets.length).toBe(6)

    const asyncAudit = await auditBrandingAssetsMetadata(WORKSPACE_ROOT)
    expect(asyncAudit.issues).toEqual([])
    expect(asyncAudit.totalAssets).toBe(6)
    expect(asyncAudit.verifiedFiles).toBe(6)
    expect(asyncAudit.xmpVerifiedFiles).toBe(5)

    const syncAudit = auditBrandingAssetsSync(WORKSPACE_ROOT)
    expect(syncAudit.issues).toEqual([])
    expect(syncAudit.verifiedFiles).toBe(6)
    expect(syncAudit.xmpVerifiedFiles).toBe(5)
  })

  test("scanBunImageAssets surfaces embedded XMP context and transformBunImageAsset stamps metadataContext", async () => {
    const scan = await scanBunImageAssets(WORKSPACE_ROOT, {
      refresh: true,
      root: "public",
    })
    expect(scan.ok).toBe(true)
    expect(scan.xmpAssetCount).toBeGreaterThanOrEqual(5)

    const emblemRow = scan.assets.find(
      (a) => a.source === "public/assets/branding/sportsdesk-emblem.webp",
    )
    expect(emblemRow?.hasXmpMetadata).toBe(true)
    expect(emblemRow?.provenance?.streamId).toBe("brand:sportsdesk-emblem:webp")
    expect(emblemRow?.provenance?.assetRole).toBe("app-emblem")
    expect(emblemRow?.provenance?.surfaceContext).toBe("dashboard-header-nav")
    expect(emblemRow?.provenance?.tokensVersion).toBe("1.5.0")

    const transformed = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: "public/assets/branding/sportsdesk-og-card.webp",
      format: "webp",
      width: 600,
      height: 315,
      fit: "fill",
      quality: 82,
      metadataContext: {
        streamId: "studio:og-preview:600x315",
        title: "SportsDesk Compact OG Preview",
        assetRole: "opengraph-compact",
        surfaceContext: "slack-unfurl",
        subjects: ["sportsdesk-ops", "opengraph"],
      },
    })

    expect(transformed.ok).toBe(true)
    expect(transformed.outputWidth).toBe(600)
    expect(transformed.outputHeight).toBe(315)
    expect(transformed.xmpInjected).toBe(true)
    expect(transformed.xmpBytes).toBeGreaterThan(400)
    expect(transformed.provenance?.streamId).toBe("studio:og-preview:600x315")
    expect(transformed.provenance?.title).toBe("SportsDesk Compact OG Preview")
    expect(transformed.provenance?.assetRole).toBe("opengraph-compact")
    expect(transformed.provenance?.surfaceContext).toBe("slack-unfurl")
    expect(transformed.provenance?.brand).toBe("SportsDesk & Fantasy402 Operations")
    expect(transformed.provenance?.merkleRoot).toMatch(/^[0-9a-f]{64}$/)
  })

  test("index.html, metadata.json, and public/manifest.webmanifest carry complete SEO, OpenGraph, and JSON-LD metadata", () => {
    const html = readFileSync(resolve(WORKSPACE_ROOT, "index.html"), "utf8")
    const appMeta = JSON.parse(readFileSync(resolve(WORKSPACE_ROOT, "metadata.json"), "utf8")) as {
      readonly name: string
      readonly description: string
    }
    const webManifest = JSON.parse(
      readFileSync(resolve(WORKSPACE_ROOT, "public/manifest.webmanifest"), "utf8"),
    ) as {
      readonly name: string
      readonly short_name: string
      readonly theme_color: string
      readonly icons: readonly { readonly sizes: string; readonly src: string }[]
    }

    expect(appMeta.name).toBe("Remix SportsDesk Ops Surveillance Dashboard-v1.01.23-next")
    expect(appMeta.description.length).toBeGreaterThanOrEqual(110)
    expect(appMeta.description.length).toBeLessThanOrEqual(165)

    expect(html).toContain('property="og:site_name"')
    expect(html).toContain('property="og:image:width" content="1200"')
    expect(html).toContain('property="og:image:height" content="630"')
    expect(html).toContain('name="twitter:card" content="summary_large_image"')
    expect(html).toContain('name="twitter:image:alt"')
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"')
    expect(html).toContain('type="application/ld+json"')
    expect(html).toContain('"@type": "WebApplication"')

    expect(webManifest.theme_color).toBe("#070b14")
    expect(webManifest.icons.some((i) => i.sizes === "512x512")).toBe(true)
    expect(webManifest.icons.some((i) => i.src === "/assets/branding/sportsdesk-emblem.webp")).toBe(
      true,
    )
  })
})
