/**
 * @file design/color.ts
 * @description Unified color normalization backed by native `Bun.color`
 * (hex, 24-bit number, `{r, g, b}`, and HSL) for cross-artifact palette parity.
 * Contrast and CIEDE2000 math remain independent in the verification modules.
 */

export interface RgbChannels {
    readonly r: number
    readonly g: number
    readonly b: number
}

interface BunColorRuntime {
    readonly color?: {
        (input: string | number, format: "hex"): string | null
        (input: string | number, format: "number"): number | null
        (input: string | number, format: "{rgb}"): RgbChannels | null
        (input: string | number, format: "hsl"): string | null
    }
}

function getBunColor(): BunColorRuntime["color"] {
    return (globalThis as { readonly Bun?: BunColorRuntime }).Bun?.color
}

function parseHexFallback(input: string | number): number {
    if (typeof input === "number") {
        if (!Number.isInteger(input) || input < 0 || input > 0xffffff) {
            throw new RangeError(`Color number out of 24-bit RGB range: ${String(input)}`)
        }
        return input
    }
    const clean = input.trim().replace(/^#/, "")
    if (/^[0-9a-fA-F]{3}$/.test(clean)) {
        const expanded = clean
            .split("")
            .map((ch) => `${ch}${ch}`)
            .join("")
        return Number.parseInt(expanded, 16)
    }
    if (/^[0-9a-fA-F]{6}$/.test(clean)) {
        return Number.parseInt(clean, 16)
    }
    throw new TypeError(`Unsupported color format: '${input}'`)
}

export function normalizeColorNumber(input: string | number): number {
    const bunColor = getBunColor()
    if (bunColor) {
        const parsed = bunColor(input, "number")
        if (parsed === null || !Number.isInteger(parsed)) {
            throw new TypeError(`Bun.color could not parse color: '${String(input)}'`)
        }
        return parsed & 0xffffff
    }
    return parseHexFallback(input)
}

export function normalizeColorHex(input: string | number): string {
    const bunColor = getBunColor()
    if (bunColor) {
        const hex = bunColor(input, "hex")
        if (hex === null) {
            throw new TypeError(`Bun.color could not normalize color to hex: '${String(input)}'`)
        }
        return hex.toLowerCase()
    }
    return `#${parseHexFallback(input).toString(16).padStart(6, "0")}`
}

export function normalizeColorRgb(input: string | number): RgbChannels {
    const bunColor = getBunColor()
    if (bunColor) {
        const rgb = bunColor(input, "{rgb}")
        if (rgb === null) {
            throw new TypeError(`Bun.color could not normalize color to RGB: '${String(input)}'`)
        }
        return { r: rgb.r, g: rgb.g, b: rgb.b }
    }
    const num = parseHexFallback(input)
    return {
        r: (num >> 16) & 0xff,
        g: (num >> 8) & 0xff,
        b: num & 0xff,
    }
}

export function normalizeColorHsl(input: string | number): string {
    const bunColor = getBunColor()
    if (bunColor) {
        const hsl = bunColor(input, "hsl")
        if (hsl === null) {
            throw new TypeError(`Bun.color could not normalize color to HSL: '${String(input)}'`)
        }
        return hsl
    }
    const { r, g, b } = normalizeColorRgb(input)
    const rn = r / 255
    const gn = g / 255
    const bn = b / 255
    const max = Math.max(rn, gn, bn)
    const min = Math.min(rn, gn, bn)
    const l = (max + min) / 2
    let h = 0
    let s = 0
    if (max !== min) {
        const d = max - min
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
        if (max === rn) {
            h = (gn - bn) / d + (gn < bn ? 6 : 0)
        } else if (max === gn) {
            h = (bn - rn) / d + 2
        } else {
            h = (rn - gn) / d + 4
        }
        h *= 60
    }
    return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`
}

export function colorsEqual(a: string | number, b: string | number): boolean {
    try {
        return normalizeColorNumber(a) === normalizeColorNumber(b)
    } catch {
        return false
    }
}
