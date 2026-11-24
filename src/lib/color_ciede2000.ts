/**
 * Perceptual color science utilities: sRGB <-> HSL <-> CIE XYZ (D65) <-> CIE L_a_b*, exact Sharma,
 * Wu, Dalal (2005) CIEDE2000 (\Delta E_{00}), and WCAG 2.1 contrast ratio. Used to validate
 * signal-channel HSL tokens against dark and light surveillance surfaces using perceptual \Delta
 * E_{00} instead of perceptually non-uniform raw HSL distance.
 *
 * @file Src/lib/color_ciede2000.ts
 */

export type RgbTuple = readonly [number, number, number]
export type LabTuple = readonly [number, number, number]

export interface HslColor {
  /** Hue in degrees `[0, 360)`. */
  readonly h: number
  /** Saturation percentage `[0, 100]`. */
  readonly s: number
  /** Lightness percentage `[0, 100]`. */
  readonly l: number
}

const HEX6_RE = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
const DEG_TO_RAD = Math.PI / 180
const RAD_TO_DEG = 180 / Math.PI
const POW25_7 = 25 ** 7

// CIE D65 2-degree reference white (IEC 61966-2-1)
const D65_XN = 0.95047
const D65_YN = 1.0
const D65_ZN = 1.08883
const LAB_EPSILON = 216 / 24389
const LAB_KAPPA = 24389 / 27

export function hexToRgb(hex: string): RgbTuple {
  const match = HEX6_RE.exec(hex.trim())
  if (!match) {
    throw new RangeError(`Invalid 6-digit hex color: ${JSON.stringify(hex)}`)
  }
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)]
}

export function rgbToHex(rgb: RgbTuple): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${clamp(rgb[0]).toString(16).padStart(2, "0")}${clamp(rgb[1]).toString(16).padStart(2, "0")}${clamp(rgb[2]).toString(16).padStart(2, "0")}`
}

export function rgbToHsl(rgb: RgbTuple): HslColor {
  const r = rgb[0] / 255
  const g = rgb[1] / 255
  const b = rgb[2] / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  const l = (max + min) / 2

  let h = 0
  let s = 0
  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
    if (max === r) {
      h = ((g - b) / delta + (g < b ? 6 : 0)) * 60
    } else if (max === g) {
      h = ((b - r) / delta + 2) * 60
    } else {
      h = ((r - g) / delta + 4) * 60
    }
  }

  return {
    h: ((h % 360) + 360) % 360,
    s: s * 100,
    l: l * 100,
  }
}

export function hexToHsl(hex: string): HslColor {
  return rgbToHsl(hexToRgb(hex))
}

export function hslToRgb(hsl: HslColor): RgbTuple {
  const h = (((hsl.h % 360) + 360) % 360) / 360
  const s = Math.max(0, Math.min(100, hsl.s)) / 100
  const l = Math.max(0, Math.min(100, hsl.l)) / 100

  if (s === 0) {
    const v = l * 255
    return [v, v, v]
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hueToChannel = (tInput: number): number => {
    let t = tInput
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }

  return [hueToChannel(h + 1 / 3) * 255, hueToChannel(h) * 255, hueToChannel(h - 1 / 3) * 255]
}

export function hslToHex(hsl: HslColor): string {
  return rgbToHex(hslToRgb(hsl))
}

function srgbChannelToLinear(channel255: number): number {
  const u = Math.max(0, Math.min(255, channel255)) / 255
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4
}

export function rgbToLab(rgb: RgbTuple): LabTuple {
  const r = srgbChannelToLinear(rgb[0])
  const g = srgbChannelToLinear(rgb[1])
  const b = srgbChannelToLinear(rgb[2])

  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65_XN
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / D65_YN
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / D65_ZN

  const f = (t: number) => (t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function hexToLab(hex: string): LabTuple {
  return rgbToLab(hexToRgb(hex))
}

export function hslToLab(hsl: HslColor): LabTuple {
  return rgbToLab(hslToRgb(hsl))
}

/**
 * Exact Sharma, Wu, Dalal (2005) CIEDE2000 perceptual color difference (\Delta E_{00}) with
 * parametric weighting factors kL = kC = kH = 1.
 */
export function ciede2000(first: LabTuple, second: LabTuple): number {
  const [l1, a1, b1] = first
  const [l2, a2, b2] = second

  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cBar = (c1 + c2) / 2
  const cBar7 = cBar ** 7
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + POW25_7)))

  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)

  const hueAngle = (bp: number, ap: number): number => {
    if (bp === 0 && ap === 0) return 0
    const deg = Math.atan2(bp, ap) * RAD_TO_DEG
    return deg < 0 ? deg + 360 : deg
  }

  const h1p = hueAngle(b1, a1p)
  const h2p = hueAngle(b2, a2p)

  const deltaLp = l2 - l1
  const deltaCp = c2p - c1p

  let deltahp = 0
  if (c1p * c2p !== 0) {
    const diff = h2p - h1p
    if (Math.abs(diff) <= 180) {
      deltahp = diff
    } else if (diff > 180) {
      deltahp = diff - 360
    } else {
      deltahp = diff + 360
    }
  }

  const deltaHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((deltahp * DEG_TO_RAD) / 2)

  const lBarp = (l1 + l2) / 2
  const cBarp = (c1p + c2p) / 2

  let hBarp = h1p + h2p
  if (c1p * c2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) {
      hBarp = (h1p + h2p) / 2
    } else if (h1p + h2p < 360) {
      hBarp = (h1p + h2p + 360) / 2
    } else {
      hBarp = (h1p + h2p - 360) / 2
    }
  }

  const t =
    1 -
    0.17 * Math.cos((hBarp - 30) * DEG_TO_RAD) +
    0.24 * Math.cos(2 * hBarp * DEG_TO_RAD) +
    0.32 * Math.cos((3 * hBarp + 6) * DEG_TO_RAD) -
    0.2 * Math.cos((4 * hBarp - 63) * DEG_TO_RAD)

  const deltaTheta = 30 * Math.exp(-(((hBarp - 275) / 25) ** 2))
  const cBarp7 = cBarp ** 7
  const rc = 2 * Math.sqrt(cBarp7 / (cBarp7 + POW25_7))
  const lBarpMinus50Sq = (lBarp - 50) ** 2
  const sl = 1 + (0.015 * lBarpMinus50Sq) / Math.sqrt(20 + lBarpMinus50Sq)
  const sc = 1 + 0.045 * cBarp
  const sh = 1 + 0.015 * cBarp * t
  const rt = -Math.sin(2 * deltaTheta * DEG_TO_RAD) * rc

  const dl = deltaLp / sl
  const dc = deltaCp / sc
  const dh = deltaHp / sh

  return Math.sqrt(Math.max(0, dl * dl + dc * dc + dh * dh + rt * dc * dh))
}

export function ciede2000Hex(firstHex: string, secondHex: string): number {
  return ciede2000(hexToLab(firstHex), hexToLab(secondHex))
}

export function ciede2000Hsl(first: HslColor, second: HslColor): number {
  return ciede2000(hslToLab(first), hslToLab(second))
}

/**
 * Naive Euclidean distance in normalized HSL space (`[0..100]` per axis, shortest hue arc). Exposed
 * strictly for contrast tests proving why raw HSL distance is perceptually broken compared to
 * CIEDE2000 (\Delta E_{00}).
 */
export function rawHslDistance(first: HslColor, second: HslColor): number {
  const rawHueDiff = Math.abs(first.h - second.h)
  const hueArc = Math.min(rawHueDiff, 360 - rawHueDiff)
  const normalizedHue = (hueArc / 180) * 100
  const ds = first.s - second.s
  const dl = first.l - second.l
  return Math.hypot(normalizedHue, ds, dl)
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  )
}

export function wcagContrastRatio(firstHex: string, secondHex: string): number {
  const l1 = relativeLuminance(firstHex)
  const l2 = relativeLuminance(secondHex)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}
