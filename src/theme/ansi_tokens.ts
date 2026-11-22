declare const Bun: Pick<typeof import("bun"), "color">

export type AnsiTheme = import("bun").markdown.AnsiTheme

const TERMINAL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const TERMINAL_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

export function hasControlChars(text: string): boolean {
  return TERMINAL_CONTROL.test(text)
}

/** Preserve Markdown's tabs and newlines while removing terminal controls. */
export function stripControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS, "")
}

export const ANSI_SGR = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
})

export interface SemanticAnsiPalette {
  readonly heading: string
  readonly key: string
  readonly code: string
  readonly ok: string
  readonly warn: string
  readonly redacted: string
}

export const PLAIN_PALETTE: SemanticAnsiPalette = Object.freeze({
  heading: "",
  key: "",
  code: "",
  ok: "",
  warn: "",
  redacted: "",
})

export const TRUECOLOR_PALETTE: SemanticAnsiPalette =
  typeof Bun === "undefined"
    ? PLAIN_PALETTE
    : Object.freeze({
        heading: Bun.color("#38bdf8", "ansi-16m") ?? "",
        key: Bun.color("#94a3b8", "ansi-16m") ?? "",
        code: Bun.color("#f59e0b", "ansi-16m") ?? "",
        ok: Bun.color("#22c55e", "ansi-16m") ?? "",
        warn: Bun.color("#eab308", "ansi-16m") ?? "",
        redacted: Bun.color("#ef4444", "ansi-16m") ?? "",
      })

const TRUECOLOR_FOREGROUND = /^\x1b\[38;2;(\d{1,3});(\d{1,3});(\d{1,3})m$/

function resolveForeground(candidate: string, fallback: string): string {
  if (candidate === "") return candidate
  const match = TRUECOLOR_FOREGROUND.exec(candidate)
  return match?.[0] === candidate && match.slice(1).every((channel) => Number(channel) <= 255)
    ? candidate
    : fallback
}

export function resolveAnsiPalette(
  colors: boolean,
  custom?: SemanticAnsiPalette | undefined,
): SemanticAnsiPalette {
  if (!colors) return PLAIN_PALETTE
  if (!custom) return TRUECOLOR_PALETTE
  return {
    heading: resolveForeground(custom.heading, TRUECOLOR_PALETTE.heading),
    key: resolveForeground(custom.key, TRUECOLOR_PALETTE.key),
    code: resolveForeground(custom.code, TRUECOLOR_PALETTE.code),
    ok: resolveForeground(custom.ok, TRUECOLOR_PALETTE.ok),
    warn: resolveForeground(custom.warn, TRUECOLOR_PALETTE.warn),
    redacted: resolveForeground(custom.redacted, TRUECOLOR_PALETTE.redacted),
  }
}

export function isColorEnabled(requested?: boolean | undefined): boolean {
  if (typeof Bun === "undefined" || !requested) return false
  const force = process.env.FORCE_COLOR
  if (force !== undefined && force !== "0") return true
  return process.env.NO_COLOR === undefined
}

interface AnsiThemeOptions {
  readonly colors?: boolean | undefined
  readonly columns?: number | undefined
  readonly hyperlinks?: boolean | undefined
}

export function normalizeTerminalColumns(columns: number): number {
  if (!Number.isFinite(columns) || columns <= 0) return 0
  // Terminal window sizes represent columns as an unsigned 16-bit value.
  return Math.min(Math.max(1, Math.floor(columns)), 65_535)
}

export function resolveAnsiTheme(options: AnsiThemeOptions = {}): AnsiTheme {
  const colors = isColorEnabled(options.colors)
  return {
    colors,
    columns: normalizeTerminalColumns(options.columns ?? 76),
    hyperlinks: colors && Boolean(options.hyperlinks),
    kittyGraphics: false,
  }
}
