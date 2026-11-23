/**
 * @file tests/unit/design_system_parity.test.ts
 * @description End-to-end verification of all 7 Bun-native design system upgrades:
 *  1. Built-in `.toml` static imports (`design/index.ts`)
 *  2. Compile-time Bun macros (`with { type: "macro" }` in `design/baked.ts`)
 *  3. `Bun.color` cross-format normalization (`design/color.ts`)
 *  4. `Bun.CryptoHasher("sha256")` backing `Sha256Hex` (`lib/brand.ts`)
 *  5. `Bun.Glob` + `HTMLRewriter` + `Bun.file().exists()` doc link audit (`scripts/gen_artifacts.ts`)
 *  6. Live `bun:sqlite` schema-verified SQL brands (`lib/brand.ts`)
 *  7. `bun:test` `toMatchSnapshot()` pinning generated manifests & XMP-stamped asset digests
 */
import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
    BAKED_ACCENT_HEX,
    BAKED_DESIGN_SYSTEM,
    BAKED_SURFACE_BG_HEX,
} from "../../design/baked.ts"
import {
    ALL_QWEN_TOKENS,
    CHANNEL_META_PACKED32_COL,
    DESIGN_SYSTEM_VERSION,
    INGESTION_CHANNELS,
    KEYMAP_SLOTS,
    OPERATOR_KEYMAP,
    ROUTE_CIRCUITS,
    SLA_STATES,
    TELEMETRY_SURFACES,
    UI_TOKENS,
    centsToDollars,
    colorsEqual,
    computeBayesSharp,
    formatHalfPointLine,
    loadDesignBrandingToml,
    loadDesignTokensToml,
    normalizeColorHex,
    normalizeColorHsl,
    normalizeColorNumber,
    normalizeColorRgb,
    packChannelHandle32,
    padCustomerIdCanonical,
    parseAmericanOdds,
    parseAsCents,
    parseAsColorHexInt,
    validateDesignSystemParity,
} from "../../design/index.ts"
import {
    introspectSqliteSchema,
    isIsoTime,
    isSha256Hex,
    isoTime,
    jsonText,
    sha256FileHex,
    sha256FileHexSync,
    sha256FromDigest,
    sha256Hex,
    sqlCol,
    sqlColFromSchema,
    sqlDomain,
    sqlIndex,
    sqlIndexFromSchema,
    sqlTable,
    sqlTableFromSchema,
} from "../../lib/brand.ts"
import { BRAND_ASSETS } from "../../packages/ui/src/operator_profiles.ts"
import { auditMarkdownDocs, auditMarkdownDocsAsync } from "../../scripts/gen_artifacts.ts"

const WORKSPACE_ROOT = resolve(import.meta.dir, "../..")

describe("1. Bun built-in .toml imports & 3. Bun.color normalization", () => {
    test("loads tokens.toml and branding.toml via native Bun .toml imports", () => {
        const tokens = loadDesignTokensToml()
        const branding = loadDesignBrandingToml()
        expect((tokens.meta as Record<string, unknown>).version).toBe(DESIGN_SYSTEM_VERSION)
        expect((branding.meta as Record<string, unknown>).schema).toBe("sportsdesk-branding/v1")
    })

    test("normalizes palette colors across hex, number, RGB, and HSL via Bun.color", () => {
        expect(normalizeColorHex("#243247")).toBe("#243247")
        expect(normalizeColorNumber("#243247")).toBe(0x243247)
        expect(normalizeColorRgb("#243247")).toEqual({ r: 36, g: 50, b: 71 })
        expect(normalizeColorHsl("#243247")).toMatch(/^hsl\(/)

        expect(colorsEqual("#243247", "rgb(36, 50, 71)")).toBe(true)
        expect(colorsEqual("#243247", 0x243247)).toBe(true)
        expect(colorsEqual("#243247", normalizeColorHsl("#243247"))).toBe(true)
        expect(colorsEqual("#243247", "#ff7878")).toBe(false)
    })
})

describe("2. Bun compile-time macro (with { type: 'macro' })", () => {
    test("bakes validated parity snapshot at build time with zero TOML parsing in bundled output", async () => {
        expect(BAKED_DESIGN_SYSTEM.version).toBe(DESIGN_SYSTEM_VERSION)
        expect(BAKED_DESIGN_SYSTEM.checksRun).toBeGreaterThanOrEqual(190)
        expect(BAKED_DESIGN_SYSTEM.brandingAssetCount).toBe(6)
        expect(BAKED_SURFACE_BG_HEX).toBe("#070b14")
        expect(BAKED_ACCENT_HEX).toBe("#38bdf8")
        expect(BAKED_DESIGN_SYSTEM.palette.border_subtle?.hex).toBe("#243247")
        expect(BAKED_DESIGN_SYSTEM.palette.border_subtle?.rgb).toEqual({ r: 36, g: 50, b: 71 })
        expect(isSha256Hex(BAKED_DESIGN_SYSTEM.tokensSha256)).toBe(true)
        expect(isSha256Hex(BAKED_DESIGN_SYSTEM.brandingSha256)).toBe(true)

        const built = await Bun.build({
            entrypoints: [resolve(WORKSPACE_ROOT, "design/baked.ts")],
            target: "browser",
            minify: false,
        })
        expect(built.success).toBe(true)
        const bundleText = await built.outputs[0]!.text()
        expect(bundleText).toContain("#243247")
        expect(bundleText).toContain(BAKED_DESIGN_SYSTEM.tokensSha256)
        expect(bundleText).not.toContain("Bun.TOML.parse")
        expect(bundleText).not.toContain("validateDesignSystemParity")
    })
})

describe("4. Bun.CryptoHasher('sha256') & 6. live bun:sqlite schema SQL brands", () => {
    test("backs Sha256Hex with Bun.CryptoHasher('sha256') for strings, bytes, and files", async () => {
        const utc = isoTime("2026-11-22T15:30:00Z")
        expect(isIsoTime(utc)).toBe(true)
        expect(isIsoTime("not-a-timestamp")).toBe(false)
        expect(isoTime(0)).toBe("1970-01-01T00:00:00.000Z")

        const bytes = new Uint8Array(32).fill(0xab)
        const digest = sha256FromDigest(bytes)
        expect(isSha256Hex(digest)).toBe(true)
        expect(digest).toBe("ab".repeat(32))
        expect(() => sha256FromDigest("short")).toThrow(TypeError)
        expect(() => sha256FromDigest(new Uint8Array(16))).toThrow(RangeError)

        const helloHash = sha256Hex("hello")
        expect(helloHash).toBe(
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        const tokensPath = resolve(WORKSPACE_ROOT, "design/tokens.toml")
        const syncHash = sha256FileHexSync(tokensPath)
        const asyncHash = await sha256FileHex(tokensPath)
        expect(syncHash).toBe(asyncHash)
        expect(syncHash).toBe(BAKED_DESIGN_SYSTEM.tokensSha256)

        const serialized = jsonText({ version: DESIGN_SYSTEM_VERSION, ok: true })
        expect(JSON.parse(serialized)).toEqual({ version: "1.5.0", ok: true })
        expect(() => jsonText("{broken")).toThrow(TypeError)
    })

    test("validates SqlTableName, SqlColumnName, and SqlIndexName against live bun:sqlite schema", () => {
        expect(sqlTable("wagers_ledger")).toBe("wagers_ledger")
        expect(sqlCol("customer_id")).toBe("customer_id")
        expect(sqlIndex("idx_wagers_ts")).toBe("idx_wagers_ts")
        expect(sqlDomain("sportsdesk.risk_v1")).toBe("sportsdesk.risk_v1")
        expect(() => sqlTable("wagers; DROP TABLE users;--")).toThrow(TypeError)

        const db = new Database(":memory:")
        try {
            db.exec(`
                CREATE TABLE wagers_ledger (
                    ticket_id TEXT PRIMARY KEY,
                    customer_id TEXT NOT NULL,
                    stake_cents INTEGER NOT NULL
                );
                CREATE INDEX idx_wagers_customer ON wagers_ledger(customer_id);
            `)

            const schema = introspectSqliteSchema(db)
            expect(sqlTableFromSchema(schema, "wagers_ledger")).toBe("wagers_ledger")
            expect(sqlColFromSchema(schema, "wagers_ledger", "stake_cents")).toBe("stake_cents")
            expect(sqlIndexFromSchema(schema, "idx_wagers_customer")).toBe("idx_wagers_customer")
            expect(sqlTableFromSchema(db, "wagers_ledger")).toBe("wagers_ledger")

            expect(() => sqlTableFromSchema(schema, "ghost_table")).toThrow(RangeError)
            expect(() => sqlColFromSchema(schema, "wagers_ledger", "ghost_col")).toThrow(
                RangeError,
            )
            expect(() => sqlIndexFromSchema(schema, "idx_nonexistent")).toThrow(RangeError)
            expect(() => sqlTableFromSchema(schema, "wagers_ledger; DROP TABLE wagers_ledger")).toThrow(
                TypeError,
            )
        } finally {
            db.close()
        }
    })
})

describe("5. Bun.Glob + HTMLRewriter + Bun.file().exists() docs audit", () => {
    test("audits Markdown links identically across sync and async HTMLRewriter pipelines", async () => {
        const syncAudit = auditMarkdownDocs(WORKSPACE_ROOT)
        const asyncAudit = await auditMarkdownDocsAsync(WORKSPACE_ROOT)

        expect(syncAudit.issues).toEqual([])
        expect(asyncAudit.issues).toEqual([])
        expect(syncAudit.docs.length).toBeGreaterThanOrEqual(11)
        expect(asyncAudit.docs.map((d) => d.path)).toEqual(syncAudit.docs.map((d) => d.path))
        expect(asyncAudit.docs.map((d) => d.localLinksChecked)).toEqual(
            syncAudit.docs.map((d) => d.localLinksChecked),
        )
    })
})

describe("design/domain-branded-types.ts & cross-artifact parity", () => {
    test("constructs monetary, customer, odds, half-point, Bayes sharp, and packed channel brands", () => {
        const cents = parseAsCents(125.45, false)
        expect(cents).toBe(12545)
        expect(centsToDollars(cents)).toBe(125.45)

        expect(padCustomerIdCanonical("bgd101")).toBe("BGD101     ")
        expect(parseAsColorHexInt("#38bdf8")).toBe(0x38bdf8)
        expect(parseAmericanOdds("-110")).toBe(-110)
        expect(() => parseAmericanOdds(50)).toThrow(RangeError)

        expect(formatHalfPointLine("-3.5")).toBe("-3½")
        expect(computeBayesSharp(100, 0)).toBe(50)
        expect(computeBayesSharp(100, 8)).toBe(62.12)
        expect(computeBayesSharp(100, 25)).toBe(75)

        const packed = packChannelHandle32(8, 75, 42)
        expect((packed >>> 28) & 0xf).toBe(8)
        expect((packed >>> 20) & 0xff).toBe(75)
        expect(packed & 0xfffff).toBe(42)

        expect(CHANNEL_META_PACKED32_COL.length).toBe(INGESTION_CHANNELS.length)
        expect(KEYMAP_SLOTS.length).toBe(OPERATOR_KEYMAP.length)
        expect(ALL_QWEN_TOKENS.length).toBe(
            INGESTION_CHANNELS.length + ROUTE_CIRCUITS.length + TELEMETRY_SURFACES.length,
        )
        expect(UI_TOKENS.length).toBe(12)
        expect(SLA_STATES.length).toBe(4)
    })

    test("validates zero drift across tokens.toml, branding.toml, domain-branded-types.ts, and BRAND_ASSETS", () => {
        const report = validateDesignSystemParity()
        expect(report.issues).toEqual([])
        expect(report.ok).toBe(true)
        expect(report.version).toBe(DESIGN_SYSTEM_VERSION)
        expect(report.checksRun).toBeGreaterThanOrEqual(190)

        const branding = loadDesignBrandingToml()
        const palette = branding.palette as Record<string, string>
        expect(colorsEqual(BRAND_ASSETS.palette.canvasBg, palette.canvas_bg!)).toBe(true)
        expect(colorsEqual(BRAND_ASSETS.palette.surfaceElevated, palette.surface_elevated!)).toBe(
            true,
        )
        expect(colorsEqual(BRAND_ASSETS.palette.borderSubtle, palette.border_subtle!)).toBe(true)
        expect(colorsEqual(BRAND_ASSETS.palette.accentPrimary, palette.accent_primary!)).toBe(true)
        expect(colorsEqual(BRAND_ASSETS.palette.accentEmerald, palette.accent_emerald!)).toBe(true)
        expect(colorsEqual(BRAND_ASSETS.palette.accentAmber, palette.accent_amber!)).toBe(true)
        expect(colorsEqual(BRAND_ASSETS.palette.accentDanger, palette.accent_danger!)).toBe(true)
        expect(colorsEqual(BRAND_ASSETS.palette.textPrimary, palette.text_primary!)).toBe(true)
        expect(colorsEqual(BRAND_ASSETS.palette.textMuted, palette.text_muted!)).toBe(true)
    })
})

describe("7. bun:test snapshots pinning generated manifests & XMP-stamped asset digests", () => {
    test("pins generated branding manifest, XMP-stamped asset hashes, and web app manifest", () => {
        const brandingCatalog = JSON.parse(
            readFileSync(
                resolve(WORKSPACE_ROOT, "public/assets/branding/branding-metadata.json"),
                "utf8",
            ),
        ) as {
            readonly schema: string
            readonly version: string
            readonly palette: Record<string, string>
            readonly assets: readonly {
                readonly id: string
                readonly repoPath: string
                readonly sha256: string
                readonly bytes: number
                readonly metadataBearing: boolean
                readonly xmpChannels: readonly string[]
            }[]
        }

        const brandingPin = {
            schema: brandingCatalog.schema,
            version: brandingCatalog.version,
            palette: brandingCatalog.palette,
            assets: brandingCatalog.assets.map((asset) => ({
                id: asset.id,
                repoPath: asset.repoPath,
                sha256: asset.sha256,
                bytes: asset.bytes,
                metadataBearing: asset.metadataBearing,
                xmpChannels: asset.xmpChannels,
            })),
        }

        const webManifest = JSON.parse(
            readFileSync(resolve(WORKSPACE_ROOT, "public/manifest.webmanifest"), "utf8"),
        )

        const generatedTokenHashes = {
            version: DESIGN_SYSTEM_VERSION,
            registryTsSha256: sha256FileHexSync(
                resolve(WORKSPACE_ROOT, "packages/ui/src/tokens.registry.generated.ts"),
            ),
            tokensCssSha256: sha256FileHexSync(
                resolve(WORKSPACE_ROOT, "src/dashboard/tokens.generated.css"),
            ),
            bakedPaletteHex: Object.fromEntries(
                Object.entries(BAKED_DESIGN_SYSTEM.palette).map(([k, v]) => [k, v.hex]),
            ),
        }

        expect(brandingPin).toMatchSnapshot("branding-assets-and-xmp-digests")
        expect(webManifest).toMatchSnapshot("web-app-manifest")
        expect(generatedTokenHashes).toMatchSnapshot("compiled-design-token-digests")
    })
})
