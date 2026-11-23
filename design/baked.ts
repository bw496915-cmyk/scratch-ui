/**
 * @file design/baked.ts
 * @description Zero-runtime-TOML baked design system entrypoint compiled via
 * Bun's `with { type: "macro" }` import attribute.
 */
import { bakeCanonicalColorHex, bakeDesignSystemSnapshot } from "./macros.ts" with { type: "macro" }

export const BAKED_DESIGN_SYSTEM = bakeDesignSystemSnapshot()
export const BAKED_SURFACE_BG_HEX = bakeCanonicalColorHex("sd-surface-bg")
export const BAKED_ACCENT_HEX = bakeCanonicalColorHex("sd-focus-ring")
