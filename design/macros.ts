/**
 * @file design/macros.ts
 * @description Bun compile-time macros (`import { ... } from "./macros.ts" with { type: "macro" }`).
 * Runs `validateDesignSystemParity()` once at build time and bakes normalized
 * palette values + SHA-256 digests into the bundle with zero runtime TOML parsing.
 */
import { dirname, resolve } from "node:path"

import { sha256FileHexSync } from "../lib/brand.ts"
import { bunFileURLToPath } from "../lib/bun_url_gzip.ts"
import {
    normalizeColorHex,
    normalizeColorHsl,
    normalizeColorNumber,
    normalizeColorRgb,
} from "./color.ts"
import {
    loadDesignBrandingToml,
    loadDesignTokensToml,
    validateDesignSystemParity,
} from "./index.ts"

export interface BakedColorEntry {
    readonly hex: string
    readonly number: number
    readonly rgb: { readonly r: number; readonly g: number; readonly b: number }
    readonly hsl: string
}

export interface BakedDesignSystemSnapshot {
    readonly version: string
    readonly checksRun: number
    readonly tokenCount: number
    readonly brandingAssetCount: number
    readonly tokensSha256: string
    readonly brandingSha256: string
    readonly palette: Readonly<Record<string, BakedColorEntry>>
}

const DESIGN_DIR = dirname(bunFileURLToPath(import.meta.url))

export function bakeDesignSystemSnapshot(): BakedDesignSystemSnapshot {
    const report = validateDesignSystemParity()
    if (!report.ok) {
        const details = report.issues.map((i) => `[${i.scope}] ${i.message}`).join("; ")
        throw new Error(`Design system compile-time parity gate failed: ${details}`)
    }

    const tokensDoc = loadDesignTokensToml()
    const brandingDoc = loadDesignBrandingToml()
    const tokenMap = tokensDoc.tokens as Record<string, string>
    const brandingPalette = brandingDoc.palette as Record<string, string>
    const assets = (brandingDoc.assets as readonly unknown[] | undefined) ?? []

    const palette: Record<string, BakedColorEntry> = {}
    for (const [key, rawHex] of Object.entries(brandingPalette)) {
        palette[key] = {
            hex: normalizeColorHex(rawHex),
            number: normalizeColorNumber(rawHex),
            rgb: normalizeColorRgb(rawHex),
            hsl: normalizeColorHsl(rawHex),
        }
    }

    return {
        version: report.version,
        checksRun: report.checksRun,
        tokenCount: Object.keys(tokenMap).length,
        brandingAssetCount: assets.length,
        tokensSha256: sha256FileHexSync(resolve(DESIGN_DIR, "tokens.toml")),
        brandingSha256: sha256FileHexSync(resolve(DESIGN_DIR, "branding.toml")),
        palette,
    }
}

export function bakeCanonicalColorHex(tokenKey: string): string {
    const tokensDoc = loadDesignTokensToml()
    const tokenMap = tokensDoc.tokens as Record<string, string>
    const raw = tokenMap[tokenKey]
    if (!raw) {
        throw new RangeError(`Unknown design token key for macro bake: '${tokenKey}'`)
    }
    return normalizeColorHex(raw)
}
