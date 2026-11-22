/**
 * @file src/profile/render.ts
 * @description Bridges `ProfileTheme` to Bun terminal surfaces (`Bun.markdown.ansi`,
 * `Bun.inspect`, `Bun.color`) with deterministic Node.js fallbacks so both
 * Bun (`bun test` / `Bun.serve`) and Node.js (`tsx server.ts`) work seamlessly.
 */

import { inspect as nodeInspect } from "node:util"

import { type AnsiTheme, stripControls } from "../theme/ansi_tokens.ts"
import { osc8Link, safeHref } from "../theme/markdown_ansi.ts"
import type { ProfileTheme } from "./types.ts"

interface BunRuntimeLike {
  readonly markdown?: {
    readonly ansi?: (text: string, theme?: AnsiTheme) => string
  }
  readonly inspect?: (
    value: unknown,
    options?: {
      colors?: boolean
      compact?: boolean
      depth?: number
      sorted?: boolean
    },
  ) => string
  readonly color?: (
    input: string,
    format: "ansi" | "ansi-16" | "ansi-256" | "ansi-16m",
  ) => string | null
}

function getBunRuntime(): BunRuntimeLike | undefined {
  const g = globalThis as unknown as { Bun?: BunRuntimeLike }
  return g.Bun
}

/**
 * Build an `AnsiTheme`, omitting `light` when `"auto"` so `COLORFGBG` probing kicks in.
 */
export function ansiThemeFor(p: ProfileTheme): AnsiTheme {
  const theme: AnsiTheme = {
    colors: p.terminal.colors,
    hyperlinks: p.terminal.hyperlinks,
    columns: p.terminal.columns,
    kittyGraphics: p.terminal.kittyGraphics,
  }
  if (p.terminal.light !== "auto") {
    theme.light = p.terminal.light === "light"
  }
  return theme
}

function wrapPlainLine(line: string, columns: number): string {
  if (columns <= 0 || line.length <= columns) return line
  const words = line.split(" ")
  const out: string[] = []
  let cur = ""
  for (const w of words) {
    if (!cur) {
      cur = w
    } else if (cur.length + 1 + w.length <= columns) {
      cur += ` ${w}`
    } else {
      out.push(cur)
      cur = w
    }
  }
  if (cur) out.push(cur)
  return out.join("\n")
}

function fallbackRenderMarkdownAnsi(md: string, theme: AnsiTheme): string {
  const useColor = theme.colors !== false
  const isLight = theme.light === true
  const cols = theme.columns ?? 80
  const hColor = useColor ? (isLight ? "\x1b[1;34m" : "\x1b[1;35m") : ""
  const boldOn = useColor ? "\x1b[1m" : ""
  const boldOff = useColor ? "\x1b[22m" : ""
  const italicOn = useColor ? "\x1b[3m" : ""
  const italicOff = useColor ? "\x1b[23m" : ""
  const codeOn = useColor ? (isLight ? "\x1b[38;5;124m" : "\x1b[48;5;236m\x1b[38;5;215m") : ""
  const reset = useColor ? "\x1b[0m" : ""

  let inFence = false
  const renderedLines: string[] = []
  for (const rawLine of md.split("\n")) {
    if (/^```/.test(rawLine.trim())) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      renderedLines.push(useColor ? `\x1b[2m${rawLine}${reset}` : rawLine)
      continue
    }
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(rawLine)
    if (headingMatch) {
      const text = wrapPlainLine(headingMatch[2] ?? "", cols)
      renderedLines.push(`${hColor}${text}${reset}`)
      continue
    }
    const wrapped = wrapPlainLine(rawLine, cols)
    let line = wrapped
      .replace(/\*\*([^*]+)\*\*/g, `${boldOn}$1${boldOff}`)
      .replace(/\*([^*]+)\*/g, `${italicOn}$1${italicOff}`)
      .replace(/`([^`]+)`/g, `${codeOn}$1${reset}`)
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label: string, href: string) =>
      osc8Link(label, href, useColor && theme.hyperlinks === true),
    )
    renderedLines.push(line)
  }
  return renderedLines.join("\n") + "\n"
}

export function renderMarkdownForTerminal(md: string, p: ProfileTheme): string {
  const theme = ansiThemeFor(p)
  const source = stripControls(md.replace(/\r\n?/g, "\n"))
  const bunMarkdownAnsi = getBunRuntime()?.markdown?.ansi
  if (typeof bunMarkdownAnsi === "function") {
    const output = bunMarkdownAnsi(source, theme)
    return output.replace(/\x1b\]8;;([^\x1b]*)\x1b\\/g, (sequence, href: string) =>
      href === "" || safeHref(href) !== null ? sequence : "",
    )
  }
  return fallbackRenderMarkdownAnsi(source, theme)
}

export function inspectFor(value: unknown, p: ProfileTheme): string {
  const opts = {
    colors: p.inspect.colors,
    compact: p.inspect.compact,
    depth: p.inspect.depth,
    sorted: p.inspect.sorted,
  }
  const bunInspect = getBunRuntime()?.inspect
  if (typeof bunInspect === "function") {
    return bunInspect(value, opts)
  }
  return nodeInspect(value, opts)
}

const NAMED_RGB: Record<string, readonly [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  gray: [128, 128, 128],
  orange: [255, 165, 0],
}

function parseCssRgb(cssColor: string): readonly [number, number, number] | null {
  const s = cssColor.trim().toLowerCase()
  if (NAMED_RGB[s]) return NAMED_RGB[s]!
  const hex6 = /^#([0-9a-f]{6})$/.exec(s)
  if (hex6) {
    const n = Number.parseInt(hex6[1]!, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const hex3 = /^#([0-9a-f]{3})$/.exec(s)
  if (hex3) {
    const h = hex3[1]!
    return [
      Number.parseInt(h[0]! + h[0]!, 16),
      Number.parseInt(h[1]! + h[1]!, 16),
      Number.parseInt(h[2]! + h[2]!, 16),
    ]
  }
  const rgbMatch = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(s)
  if (rgbMatch) {
    const r = Number(rgbMatch[1])
    const g = Number(rgbMatch[2])
    const b = Number(rgbMatch[3])
    if (r <= 255 && g <= 255 && b <= 255) return [r, g, b]
  }
  return null
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  const r6 = Math.round((r / 255) * 5)
  const g6 = Math.round((g / 255) * 5)
  const b6 = Math.round((b / 255) * 5)
  return 16 + 36 * r6 + 6 * g6 + b6
}

function rgbToAnsi16(r: number, g: number, b: number): number {
  const bright = Math.max(r, g, b) > 170
  const code = (r > 127 ? 1 : 0) | (g > 127 ? 2 : 0) | (b > 127 ? 4 : 0)
  return (bright ? 90 : 30) + code
}

/** Explicit escape generation at the profile's depth, bypassing auto-detect when pinned. */
export function colorize(cssColor: string, p: ProfileTheme): string {
  if (!p.terminal.colors) return ""
  const format = p.colorDepth === "auto" ? "ansi" : p.colorDepth
  const bunColor = getBunRuntime()?.color
  if (typeof bunColor === "function") {
    return bunColor(cssColor, format) ?? ""
  }
  const rgb = parseCssRgb(cssColor)
  if (!rgb) return ""
  const [r, g, b] = rgb
  if (format === "ansi-16") return `\x1b[${rgbToAnsi16(r, g, b)}m`
  if (format === "ansi-256") return `\x1b[38;5;${rgbToAnsi256(r, g, b)}m`
  return `\x1b[38;2;${r};${g};${b}m`
}
