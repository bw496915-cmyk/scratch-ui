import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import { transformBunImageAsset } from "../../server/bun_image_engine.ts"

const WORKSPACE_ROOT = resolve(import.meta.dir, "../..")
const TEST_ASSET = "public/assets/branding/sportsdesk-emblem.webp"

describe("Bun.Image.prototype.png() — Native PNG & Indexed Palette Encoder", () => {
  test("encodes truecolor PNG (color-type 6) with zlib compressionLevel", async () => {
    const res = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: TEST_ASSET,
      format: "png",
      compressionLevel: 6,
    })

    expect(res.ok).toBe(true)
    expect(res.outputFormat).toBe("png")
    expect(res.mimeType).toBe("image/png")
    expect(res.pngPalette).toBe(false)
    expect(res.pngColorType).toBe(6)
    expect(res.pngColorTypeLabel).toBe("Truecolor RGBA (type 6)")
    expect(res.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
    expect(res.outputBytes).toBeGreaterThan(0)
  })

  test("encodes indexed PNG (color-type 3) with palette, colors, and Floyd-Steinberg dither at 3x+ smaller size", async () => {
    const truecolor = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: TEST_ASSET,
      format: "png",
      compressionLevel: 9,
      palette: false,
    })

    const indexedDither = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: TEST_ASSET,
      format: "png",
      compressionLevel: 9,
      palette: true,
      colors: 64,
      dither: true,
    })

    const indexedNoDither = await transformBunImageAsset(WORKSPACE_ROOT, {
      source: TEST_ASSET,
      format: "png",
      compressionLevel: 9,
      palette: true,
      colors: 64,
      dither: false,
    })

    expect(indexedDither.ok).toBe(true)
    expect(indexedDither.pngPalette).toBe(true)
    expect(indexedDither.pngColors).toBe(64)
    expect(indexedDither.pngDither).toBe(true)
    expect(indexedDither.pngColorType).toBe(3)
    expect(indexedDither.pngColorTypeLabel).toBe("Indexed Palette (type 3)")
    expect(indexedDither.outputBytes).toBeLessThan(truecolor.outputBytes / 3)

    expect(indexedNoDither.ok).toBe(true)
    expect(indexedNoDither.pngPalette).toBe(true)
    expect(indexedNoDither.pngDither).toBe(false)
    expect(indexedNoDither.pngColorType).toBe(3)
    expect(indexedNoDither.outputBytes).toBeLessThan(truecolor.outputBytes / 3)
  })
})
