/**
 * @file server/desk_inspect.ts
 * @description Bun.inspect.custom / util.inspect.custom formatted desk views,
 * full Bun.inspect options formatting & CLI `--options` parser, and
 * Bun.inspect.table()-compatible renderer for Node.js 22 & Bun 1.4.4 parity.
 */

import { inspect } from "node:util"

/** Well-known symbol recognized by Bun.inspect and Bun's console.* */
export const BUN_INSPECT_CUSTOM = Symbol.for("Bun.inspect.custom")

/** Well-known symbol recognized by Node's util.inspect and Node's console.* */
export const NODE_INSPECT_CUSTOM = inspect.custom

export interface BunInspectOptions {
  colors?: boolean
  compact?: boolean | number
  depth?: number
  sorted?: boolean
  showHidden?: boolean
  maxArrayLength?: number
  maxStringLength?: number
  breakLength?: number
  numericSeparator?: boolean
  getters?: boolean
}

export interface ResolvedBunInspectOptions {
  readonly colors: boolean
  readonly compact: boolean
  readonly depth: number
  readonly sorted: boolean
  readonly showHidden: boolean
  readonly maxArrayLength: number
  readonly maxStringLength: number
  readonly breakLength: number
  readonly numericSeparator: boolean
  readonly getters: boolean
}

export const DEFAULT_BUN_INSPECT_OPTIONS: ResolvedBunInspectOptions = {
  colors: true,
  compact: false,
  depth: 2,
  sorted: false,
  showHidden: false,
  maxArrayLength: 22,
  maxStringLength: 42,
  breakLength: 96,
  numericSeparator: false,
  getters: false,
}

export const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  boldCyan: "\x1b[1;36m",
  boldYellow: "\x1b[1;33m",
  boldGreen: "\x1b[1;32m",
  boldRed: "\x1b[1;31m",
  boldMagenta: "\x1b[1;35m",
  boldWhite: "\x1b[1;37m",
} as const

const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g

export function stripAnsi(input: string): string {
  return input.replace(ANSI_STRIP_RE, "")
}

export function visibleLength(input: string): number {
  return stripAnsi(input).length
}

export function padVisibleEnd(input: string, width: number): string {
  const diff = width - visibleLength(input)
  return diff > 0 ? input + " ".repeat(diff) : input
}

export function padVisibleStart(input: string, width: number): string {
  const diff = width - visibleLength(input)
  return diff > 0 ? " ".repeat(diff) + input : input
}

/**
 * Truncates a string to `maxLen` visible characters while preserving ANSI escape
 * sequences cleanly and closing active styles with reset when clipped.
 */
export function truncateVisible(input: string, maxLen: number): string {
  if (maxLen <= 0) return ""
  const plain = stripAnsi(input)
  if (plain.length <= maxLen) return input
  if (maxLen === 1) return "…"

  const target = maxLen - 1
  let visible = 0
  let out = ""
  let hasAnsi = false
  let i = 0

  while (i < input.length && visible < target) {
    if (input[i] === "\x1b" && input[i + 1] === "[") {
      const mIdx = input.indexOf("m", i + 2)
      if (mIdx !== -1) {
        out += input.slice(i, mIdx + 1)
        hasAnsi = true
        i = mIdx + 1
        continue
      }
    }
    out += input[i]!
    visible += 1
    i += 1
  }

  return hasAnsi ? `${out}…${ANSI.reset}` : `${out}…`
}

export function paint(text: string, code: string, colors: boolean): string {
  return colors ? `${code}${text}${ANSI.reset}` : text
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(min, Math.min(max, Math.round(value)))
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) {
      return Math.max(min, Math.min(max, Math.round(parsed)))
    }
  }
  return fallback
}

function parseBoolOption(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase()
    if (lower === "true" || lower === "1" || lower === "yes" || lower === "on") {
      return true
    }
    if (lower === "false" || lower === "0" || lower === "no" || lower === "off") {
      return false
    }
  }
  return fallback
}

export function resolveInspectOptions(options: BunInspectOptions = {}): ResolvedBunInspectOptions {
  const compact =
    typeof options.compact === "number"
      ? options.compact > 0
      : parseBoolOption(options.compact, DEFAULT_BUN_INSPECT_OPTIONS.compact)
  const defaultBreak = compact ? 74 : DEFAULT_BUN_INSPECT_OPTIONS.breakLength
  const defaultMaxString = compact ? 24 : DEFAULT_BUN_INSPECT_OPTIONS.maxStringLength

  return {
    colors: parseBoolOption(options.colors, DEFAULT_BUN_INSPECT_OPTIONS.colors),
    compact,
    depth: clampInt(options.depth, DEFAULT_BUN_INSPECT_OPTIONS.depth, 0, 6),
    sorted: parseBoolOption(options.sorted, DEFAULT_BUN_INSPECT_OPTIONS.sorted),
    showHidden: parseBoolOption(options.showHidden, DEFAULT_BUN_INSPECT_OPTIONS.showHidden),
    maxArrayLength: clampInt(
      options.maxArrayLength,
      DEFAULT_BUN_INSPECT_OPTIONS.maxArrayLength,
      1,
      200,
    ),
    maxStringLength: clampInt(options.maxStringLength, defaultMaxString, 8, 160),
    breakLength: clampInt(options.breakLength, defaultBreak, 56, 160),
    numericSeparator: parseBoolOption(
      options.numericSeparator,
      DEFAULT_BUN_INSPECT_OPTIONS.numericSeparator,
    ),
    getters: parseBoolOption(options.getters, DEFAULT_BUN_INSPECT_OPTIONS.getters),
  }
}

export function formatInspectNumber(
  value: number,
  options: { numericSeparator?: boolean | undefined; decimals?: number | undefined } = {},
): string {
  if (!Number.isFinite(value)) return String(value)
  const sep = options.numericSeparator ? "_" : ","
  const fixed =
    options.decimals !== undefined
      ? value.toFixed(options.decimals)
      : Number.isInteger(value)
        ? String(value)
        : value.toFixed(2)
  const [intPart = "0", fracPart] = fixed.split(".")
  const sign = intPart.startsWith("-") ? "-" : ""
  const digits = sign ? intPart.slice(1) : intPart
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep)
  return fracPart !== undefined ? `${sign}${grouped}.${fracPart}` : `${sign}${grouped}`
}

export function formatInspectCurrency(
  value: number,
  options: { numericSeparator?: boolean; signed?: boolean } = {},
): string {
  const absFormatted = formatInspectNumber(Math.abs(Math.round(value)), {
    numericSeparator: options.numericSeparator,
    decimals: 0,
  })
  if (value < 0) return `-$${absFormatted}`
  if (options.signed && value > 0) return `+$${absFormatted}`
  return `$${absFormatted}`
}

export function formatInspectOptionsObject(options: BunInspectOptions = {}): string {
  const fields = Object.entries(resolveInspectOptions(options))
  return `{ ${fields.map(([key, value]) => `${key}: ${value}`).join(", ")} }`
}

export function formatInspectCliFlags(
  options: BunInspectOptions = {},
  extras: { showOptions?: boolean } = {},
): string {
  const resolved = resolveInspectOptions(options)
  const flags: string[] = []
  if (!resolved.colors) flags.push("--no-color")
  if (resolved.compact) flags.push("--compact")
  if (resolved.sorted) flags.push("--sorted")
  if (resolved.depth !== DEFAULT_BUN_INSPECT_OPTIONS.depth) {
    flags.push(`--depth=${resolved.depth}`)
  }
  if (resolved.showHidden) flags.push("--show-hidden")
  if (resolved.numericSeparator) flags.push("--numeric-separator")
  if (resolved.getters) flags.push("--getters")
  if (resolved.maxArrayLength !== DEFAULT_BUN_INSPECT_OPTIONS.maxArrayLength) {
    flags.push(`--max-array=${resolved.maxArrayLength}`)
  }
  if (
    resolved.maxStringLength !==
    (resolved.compact ? 24 : DEFAULT_BUN_INSPECT_OPTIONS.maxStringLength)
  ) {
    flags.push(`--max-string=${resolved.maxStringLength}`)
  }
  if (resolved.breakLength !== (resolved.compact ? 74 : DEFAULT_BUN_INSPECT_OPTIONS.breakLength)) {
    flags.push(`--break-length=${resolved.breakLength}`)
  }
  if (extras.showOptions) {
    flags.push("--options")
  }
  return flags.join(" ")
}

/**
 * Parses an inline `--options=...` bundle in either JSON (`{"depth":3,"compact":true}`)
 * or comma-separated `key=val` syntax (`depth=3,compact=true,showHidden,numericSeparator`).
 */
export function parseInlineOptionsBundle(raw: string): BunInspectOptions {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, "")
  if (!trimmed) return {}
  const out: BunInspectOptions = {}

  const applyPair = (rawKey: string, rawVal: unknown) => {
    const key = rawKey.trim().toLowerCase().replace(/[-_]/g, "")
    switch (key) {
      case "color":
      case "colors":
        out.colors = parseBoolOption(rawVal, true)
        break
      case "nocolor":
      case "nocolors":
      case "plain":
        out.colors = !parseBoolOption(rawVal, true)
        break
      case "compact":
        out.compact = parseBoolOption(rawVal, true)
        break
      case "sorted":
        out.sorted = parseBoolOption(rawVal, true)
        break
      case "depth":
      case "d":
        out.depth = clampInt(rawVal, DEFAULT_BUN_INSPECT_OPTIONS.depth, 0, 6)
        break
      case "showhidden":
      case "hidden":
        out.showHidden = parseBoolOption(rawVal, true)
        break
      case "maxarray":
      case "maxarraylength":
      case "limit":
        out.maxArrayLength = clampInt(rawVal, DEFAULT_BUN_INSPECT_OPTIONS.maxArrayLength, 1, 200)
        break
      case "maxstring":
      case "maxstringlength":
        out.maxStringLength = clampInt(rawVal, DEFAULT_BUN_INSPECT_OPTIONS.maxStringLength, 8, 160)
        break
      case "breaklength":
      case "width":
      case "columns":
        out.breakLength = clampInt(rawVal, DEFAULT_BUN_INSPECT_OPTIONS.breakLength, 56, 160)
        break
      case "numericseparator":
      case "numericsep":
      case "sep":
        out.numericSeparator = parseBoolOption(rawVal, true)
        break
      case "getters":
        out.getters = parseBoolOption(rawVal, true)
        break
    }
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      for (const [k, v] of Object.entries(parsed)) {
        applyPair(k, v)
      }
      return out
    } catch {
      // Fall through to key=val parsing
    }
  }

  for (const token of trimmed.split(/[;,]/)) {
    const part = token.trim()
    if (!part) continue
    const eqIdx = part.indexOf("=")
    if (eqIdx === -1) {
      applyPair(part, true)
    } else {
      applyPair(part.slice(0, eqIdx), part.slice(eqIdx + 1))
    }
  }
  return out
}

export function parseInspectOptionsFromQuery(query: Record<string, unknown>): {
  options: BunInspectOptions
  showOptions: boolean
} {
  const fromBundle =
    typeof query.options === "string" ? parseInlineOptionsBundle(query.options) : {}
  const opts: BunInspectOptions = { ...fromBundle }

  if (query.colors !== undefined) {
    opts.colors = parseBoolOption(query.colors, true)
  }
  if (query.compact !== undefined) {
    opts.compact = parseBoolOption(query.compact, false)
  }
  if (query.sorted !== undefined) {
    opts.sorted = parseBoolOption(query.sorted, false)
  }
  if (query.depth !== undefined) {
    opts.depth = clampInt(query.depth, DEFAULT_BUN_INSPECT_OPTIONS.depth, 0, 6)
  }
  if (query.showHidden !== undefined || query.show_hidden !== undefined) {
    opts.showHidden = parseBoolOption(query.showHidden ?? query.show_hidden, false)
  }
  if (
    query.maxArrayLength !== undefined ||
    query.maxArray !== undefined ||
    query.max_array !== undefined
  ) {
    opts.maxArrayLength = clampInt(
      query.maxArrayLength ?? query.maxArray ?? query.max_array,
      DEFAULT_BUN_INSPECT_OPTIONS.maxArrayLength,
      1,
      200,
    )
  }
  if (
    query.maxStringLength !== undefined ||
    query.maxString !== undefined ||
    query.max_string !== undefined
  ) {
    opts.maxStringLength = clampInt(
      query.maxStringLength ?? query.maxString ?? query.max_string,
      DEFAULT_BUN_INSPECT_OPTIONS.maxStringLength,
      8,
      160,
    )
  }
  if (
    query.breakLength !== undefined ||
    query.width !== undefined ||
    query.break_length !== undefined
  ) {
    opts.breakLength = clampInt(
      query.breakLength ?? query.width ?? query.break_length,
      DEFAULT_BUN_INSPECT_OPTIONS.breakLength,
      56,
      160,
    )
  }
  if (query.numericSeparator !== undefined || query.numeric_separator !== undefined) {
    opts.numericSeparator = parseBoolOption(
      query.numericSeparator ?? query.numeric_separator,
      false,
    )
  }
  if (query.getters !== undefined) {
    opts.getters = parseBoolOption(query.getters, false)
  }

  const showOptions =
    query.showOptions === "true" ||
    query.showOptions === true ||
    query.show_options === "true" ||
    query.options === "" ||
    query.options === "true"

  return { options: opts, showOptions }
}

export interface ParsedInspectCliArgs {
  readonly inspectOpts: BunInspectOptions
  readonly resolvedOpts: ResolvedBunInspectOptions
  readonly flags: ReadonlySet<string>
  readonly flagValues: ReadonlyMap<string, string>
  readonly positionalArgs: readonly string[]
  readonly showOptions: boolean
}

const VALUE_TAKING_FLAGS = new Set([
  "--depth",
  "-d",
  "--max-array",
  "--max-array-length",
  "--limit",
  "--max-string",
  "--max-string-length",
  "--break-length",
  "--width",
  "--columns",
  "--sort",
  "--dir",
  "--ip",
  "--kind",
  "--market",
  "--account",
  "--tier",
  "--type",
  "--tag",
  "--q",
  "--theme",
  "-t",
  "-s",
  "-a",
])

/**
 * Splits a terminal command line into tokens respecting single/double quotes.
 */
export function tokenizeCliCommand(raw: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

/**
 * Parses CLI `--options` and standard `Bun.inspect` flags in both `--flag=val`
 * and `--flag val` forms alongside domain flags & positional arguments.
 */
export function parseInspectCliArgs(
  tokens: readonly string[],
  defaults: BunInspectOptions = {},
): ParsedInspectCliArgs {
  const flags = new Set<string>()
  const flagValues = new Map<string, string>()
  const positionalArgs: string[] = []
  const inspectOpts = { ...defaults }
  let showOptions = false

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (!tok.startsWith("-") || tok === "-") {
      positionalArgs.push(tok)
      continue
    }

    const eqIdx = tok.indexOf("=")
    if (eqIdx !== -1) {
      const key = tok.slice(0, eqIdx).toLowerCase()
      const val = tok.slice(eqIdx + 1)
      flags.add(key)
      flagValues.set(key, val)

      if (key === "--options" || key === "--inspect-options") {
        Object.assign(inspectOpts, parseInlineOptionsBundle(val))
        showOptions = true
      } else if (key === "--colors" || key === "--color") {
        inspectOpts.colors = parseBoolOption(val, true)
      } else if (key === "--compact") {
        inspectOpts.compact = parseBoolOption(val, true)
      } else if (key === "--sorted") {
        inspectOpts.sorted = parseBoolOption(val, true)
      } else if (key === "--depth" || key === "-d") {
        inspectOpts.depth = clampInt(val, DEFAULT_BUN_INSPECT_OPTIONS.depth, 0, 6)
      } else if (key === "--show-hidden" || key === "--hidden") {
        inspectOpts.showHidden = parseBoolOption(val, true)
      } else if (key === "--max-array" || key === "--max-array-length" || key === "--limit") {
        inspectOpts.maxArrayLength = clampInt(
          val,
          DEFAULT_BUN_INSPECT_OPTIONS.maxArrayLength,
          1,
          200,
        )
      } else if (key === "--max-string" || key === "--max-string-length") {
        inspectOpts.maxStringLength = clampInt(
          val,
          DEFAULT_BUN_INSPECT_OPTIONS.maxStringLength,
          8,
          160,
        )
      } else if (key === "--break-length" || key === "--width" || key === "--columns") {
        inspectOpts.breakLength = clampInt(val, DEFAULT_BUN_INSPECT_OPTIONS.breakLength, 56, 160)
      } else if (key === "--numeric-separator" || key === "--numeric-sep") {
        inspectOpts.numericSeparator = parseBoolOption(val, true)
      } else if (key === "--getters") {
        inspectOpts.getters = parseBoolOption(val, true)
      }
      continue
    }

    const key = tok.toLowerCase()
    flags.add(key)

    if (key === "--options" || key === "--inspect-options") {
      showOptions = true
      const next = tokens[i + 1]
      if (next && !next.startsWith("-") && (next.includes("=") || next.startsWith("{"))) {
        Object.assign(inspectOpts, parseInlineOptionsBundle(next))
        flagValues.set(key, next)
        i += 1
      }
      continue
    }

    if (key === "--no-color" || key === "--no-colors" || key === "--plain") {
      inspectOpts.colors = false
      continue
    }
    if (key === "--colors" || key === "--color") {
      inspectOpts.colors = true
      continue
    }
    if (key === "--compact") {
      inspectOpts.compact = true
      continue
    }
    if (key === "--no-compact") {
      inspectOpts.compact = false
      continue
    }
    if (key === "--sorted") {
      inspectOpts.sorted = true
      continue
    }
    if (key === "--no-sorted") {
      inspectOpts.sorted = false
      continue
    }
    if (key === "--show-hidden" || key === "--hidden") {
      inspectOpts.showHidden = true
      continue
    }
    if (key === "--no-show-hidden") {
      inspectOpts.showHidden = false
      continue
    }
    if (key === "--numeric-separator" || key === "--numeric-sep") {
      inspectOpts.numericSeparator = true
      continue
    }
    if (key === "--no-numeric-separator") {
      inspectOpts.numericSeparator = false
      continue
    }
    if (key === "--getters") {
      inspectOpts.getters = true
      continue
    }
    if (key === "--no-getters") {
      inspectOpts.getters = false
      continue
    }

    if (VALUE_TAKING_FLAGS.has(key)) {
      const next = tokens[i + 1]
      if (next !== undefined && !next.startsWith("-")) {
        flagValues.set(key, next)
        i += 1
        if (key === "--depth" || key === "-d") {
          inspectOpts.depth = clampInt(next, DEFAULT_BUN_INSPECT_OPTIONS.depth, 0, 6)
        } else if (key === "--max-array" || key === "--max-array-length" || key === "--limit") {
          inspectOpts.maxArrayLength = clampInt(
            next,
            DEFAULT_BUN_INSPECT_OPTIONS.maxArrayLength,
            1,
            200,
          )
        } else if (key === "--max-string" || key === "--max-string-length") {
          inspectOpts.maxStringLength = clampInt(
            next,
            DEFAULT_BUN_INSPECT_OPTIONS.maxStringLength,
            8,
            160,
          )
        } else if (key === "--break-length" || key === "--width" || key === "--columns") {
          inspectOpts.breakLength = clampInt(next, DEFAULT_BUN_INSPECT_OPTIONS.breakLength, 56, 160)
        }
      }
    }
  }

  return {
    inspectOpts,
    resolvedOpts: resolveInspectOptions(inspectOpts),
    flags,
    flagValues,
    positionalArgs,
    showOptions,
  }
}

/**
 * Renders a crisp, aligned diagnostic block documenting the active
 * `Bun.inspect(value, options)` parameters and equivalent `--options` CLI flags.
 */
export function renderInspectOptionsBanner(
  options: BunInspectOptions = {},
  contextLabel = "Bun.inspect.options",
  extras: { readonly showOptions?: boolean } = {},
): string {
  const resolved = resolveInspectOptions(options)
  const colors = resolved.colors
  const width = resolved.breakLength
  const label = truncateVisible(contextLabel, width - 8)
  const top = paint(`┌─ ${label} ${"─".repeat(width - label.length - 5)}┐`, ANSI.cyan, colors)
  const bot = paint(`└${"─".repeat(width - 2)}┘`, ANSI.cyan, colors)
  const line = (content: string, color: string) =>
    paint("│ ", ANSI.cyan, colors) +
    padVisibleEnd(paint(content, color, colors), width - 4) +
    paint(" │", ANSI.cyan, colors)

  const fields = formatInspectOptionsObject(resolved).slice(2, -2).split(", ")
  const lines = [top]
  for (const { tokens, color } of [
    {
      tokens: [
        "JS: {",
        ...fields.map((field, index) => (index === fields.length - 1 ? field : field + ",")),
        "}",
      ],
      color: ANSI.cyan,
    },
    {
      tokens: [
        "CLI:",
        ...(
          formatInspectCliFlags(resolved, { showOptions: extras.showOptions }) || "(defaults)"
        ).split(" "),
      ],
      color: ANSI.yellow,
    },
  ]) {
    let current = ""
    for (const token of tokens) {
      if (current && current.length + token.length + 1 > width - 4) {
        lines.push(line(current, color))
        current = " "
      }
      current += (current ? " " : "") + token
    }
    lines.push(line(current, color))
  }
  return [...lines, bot].join("\n")
}

/**
 * Shared base class for custom-formatted desk views.
 * Bun and Node use the same inspect symbol. Use inspectDeskValue when callers
 * need the full option set. Bun 1.4.4 only forwards depth, colors and stylize
 * to a native custom inspect callback.
 */
export abstract class DeskView<T> {
  public readonly rows: readonly T[]
  constructor(rows: readonly T[]) {
    this.rows = rows
  }

  abstract render(options?: BunInspectOptions): string

  [BUN_INSPECT_CUSTOM](_depth?: number, options?: BunInspectOptions): string {
    return this.render(options)
  }

  [NODE_INSPECT_CUSTOM](_depth?: number, options?: BunInspectOptions): string {
    return this.render(options)
  }

  toAnsi(options?: BunInspectOptions): string {
    return this.render({ ...options, colors: true })
  }

  toPlain(options?: BunInspectOptions): string {
    return this.render({ ...options, colors: false })
  }

  toString(): string {
    return this.render({ colors: false })
  }
}

/**
 * Invokes a value's custom Bun/Node inspect hook if present (short-circuiting
 * recursion when a string is returned), otherwise delegates to util.inspect
 * with the full normalized BunInspectOptions contract.
 */
export function inspectDeskValue(
  value: unknown,
  options: BunInspectOptions = { colors: true },
): string {
  const opts = resolveInspectOptions(options)

  if (value !== null && typeof value === "object") {
    const rec = value as Record<symbol, unknown>
    const customFn =
      typeof rec[BUN_INSPECT_CUSTOM] === "function"
        ? (rec[BUN_INSPECT_CUSTOM] as (depth?: number, options?: BunInspectOptions) => unknown)
        : typeof rec[NODE_INSPECT_CUSTOM] === "function"
          ? (rec[NODE_INSPECT_CUSTOM] as (depth?: number, options?: BunInspectOptions) => unknown)
          : null

    if (customFn) {
      const rendered = customFn.call(value, opts.depth, opts)
      if (typeof rendered === "string") {
        return rendered
      }
      return inspectDeskValue(rendered, opts)
    }
  }

  return inspect(value, {
    colors: opts.colors,
    compact: opts.compact,
    depth: opts.depth,
    sorted: opts.sorted,
    showHidden: opts.showHidden,
    maxArrayLength: opts.maxArrayLength,
    maxStringLength: opts.maxStringLength,
    breakLength: opts.breakLength,
    numericSeparator: opts.numericSeparator,
    getters: opts.getters,
  })
}

function formatTableCellValue(
  value: unknown,
  colors: boolean,
  numericSeparator: boolean,
): { text: string; isNumeric: boolean } {
  if (value === null || value === undefined) {
    return { text: paint("—", ANSI.gray, colors), isNumeric: false }
  }
  if (typeof value === "number") {
    const formatted = formatInspectNumber(value, { numericSeparator })
    return { text: paint(formatted, ANSI.yellow, colors), isNumeric: true }
  }
  if (typeof value === "boolean") {
    return {
      text: paint(String(value), value ? ANSI.green : ANSI.red, colors),
      isNumeric: false,
    }
  }
  const str = String(value)
  return { text: str, isNumeric: false }
}

/**
 * Bun.inspect.table(data, properties?, options)-compatible formatter.
 * Returns a formatted Unicode box-drawing table string honoring colors, compact,
 * sorted, maxArrayLength, maxStringLength, and numericSeparator.
 */
export function inspectTable<T extends Record<string, unknown>>(
  data: readonly T[],
  properties?: readonly string[],
  options: BunInspectOptions & { maxColWidth?: number } = {},
): string {
  const resolved = resolveInspectOptions(options)
  const colors = resolved.colors
  const maxColWidth =
    options.maxColWidth ?? Math.min(resolved.maxStringLength, resolved.compact ? 24 : 38)

  if (data.length === 0) {
    return paint("(empty table)", ANSI.gray, colors)
  }

  let cols: string[] =
    properties && properties.length > 0
      ? [...properties]
      : Array.from(new Set(data.flatMap((row) => Object.keys(row))))

  if (resolved.sorted && (!properties || properties.length === 0)) {
    cols = [...cols].sort((a, b) => a.localeCompare(b))
  }

  const slicedData = data.slice(0, resolved.maxArrayLength)
  const hiddenRowCount = Math.max(0, data.length - slicedData.length)

  const headers = ["#", ...cols]
  const bodyRows = slicedData.map((row, idx) => {
    const cells = cols.map((col) =>
      formatTableCellValue(row[col], colors, resolved.numericSeparator),
    )
    return {
      indexCell: {
        text: paint(String(idx), ANSI.gray, colors),
        isNumeric: true,
      },
      cells,
    }
  })

  const widths = headers.map((h, colIdx) => {
    let maxW = Math.min(maxColWidth, visibleLength(h))
    for (const r of bodyRows) {
      const cell = colIdx === 0 ? r.indexCell : r.cells[colIdx - 1]!
      const len = Math.min(maxColWidth, visibleLength(cell.text))
      if (len > maxW) maxW = len
    }
    return maxW
  })

  const padUnit = resolved.compact ? "" : " "
  const padExtra = resolved.compact ? 0 : 2

  const border = (left: string, mid: string, right: string) =>
    paint(
      `${left}${widths.map((w) => "─".repeat(w + padExtra)).join(mid)}${right}`,
      ANSI.gray,
      colors,
    )

  const sep = paint("│", ANSI.gray, colors)

  const headerLine =
    sep +
    headers
      .map((h, i) => {
        const label = paint(truncateVisible(h, widths[i]!), ANSI.boldCyan, colors)
        return `${padUnit}${padVisibleEnd(label, widths[i]!)}${padUnit}`
      })
      .join(sep) +
    sep

  const renderedRows = bodyRows.map((r) => {
    const allCells = [r.indexCell, ...r.cells]
    return (
      sep +
      allCells
        .map((cell, i) => {
          const clipped = truncateVisible(cell.text, widths[i]!)
          const padded = cell.isNumeric
            ? padVisibleStart(clipped, widths[i]!)
            : padVisibleEnd(clipped, widths[i]!)
          return `${padUnit}${padded}${padUnit}`
        })
        .join(sep) +
      sep
    )
  })

  const lines = [
    border("┌", "┬", "┐"),
    headerLine,
    border("├", "┼", "┤"),
    ...renderedRows,
    border("└", "┴", "┘"),
  ]

  if (hiddenRowCount > 0) {
    lines.push(
      paint(
        `  … +${formatInspectNumber(hiddenRowCount, { numericSeparator: resolved.numericSeparator })} more row(s) (maxArrayLength=${resolved.maxArrayLength})`,
        ANSI.gray,
        colors,
      ),
    )
  }

  return lines.join("\n")
}

// ── 1. BlockLogView (`block-log-viewer.ts` pattern) ──────────────────────────

export interface BlockLogRow {
  readonly type: string
  readonly count: number
  readonly code: string
  readonly severity: "CRITICAL" | "WARN" | "INFO"
  readonly detail: string
}

export class BlockLogView extends DeskView<BlockLogRow> {
  private readonly title: string
  constructor(rows: readonly BlockLogRow[], title = "BLOCK LOG VIEWER (Bun.inspect.custom)") {
    super(rows)
    this.title = title
  }

  render(options: BunInspectOptions = {}): string {
    const opts = resolveInspectOptions(options)
    const colors = opts.colors
    const totalCount = this.rows.reduce((sum, r) => sum + r.count, 0)
    const header = paint(`◆ ${this.title}`, ANSI.boldCyan, colors)
    const meta = paint(
      `  ${this.rows.length} categories · ${formatInspectNumber(totalCount, { numericSeparator: opts.numericSeparator })} events · depth=${opts.depth} · ${opts.compact ? "compact" : "full"} · invariant: autoExecute=false`,
      ANSI.gray,
      colors,
    )

    if (this.rows.length === 0) {
      return [
        header,
        meta,
        paint("  No block log entries observed in current window.", ANSI.gray, colors),
      ].join("\n")
    }

    const sortedRows = opts.sorted
      ? [...this.rows].sort((a, b) => a.type.localeCompare(b.type))
      : [...this.rows].sort((a, b) => b.count - a.count)

    const formatted = sortedRows.map((row) => {
      const sharePct = totalCount > 0 ? `${((row.count / totalCount) * 100).toFixed(1)}%` : "0.0%"
      const typeColor =
        row.severity === "CRITICAL"
          ? ANSI.boldRed
          : row.severity === "WARN"
            ? ANSI.boldYellow
            : ANSI.cyan
      const codeColor =
        row.severity === "CRITICAL" ? ANSI.red : row.severity === "WARN" ? ANSI.yellow : ANSI.green

      return {
        TYPE: paint(row.type, typeColor, colors),
        COUNT: row.count,
        CODE: paint(row.code, codeColor, colors),
        SHARE: paint(sharePct, ANSI.white, colors),
        DETAIL: truncateVisible(row.detail, Math.min(opts.maxStringLength, opts.compact ? 24 : 44)),
      }
    })

    const table = inspectTable(formatted, ["TYPE", "COUNT", "CODE", "SHARE", "DETAIL"], {
      ...opts,
      maxColWidth: Math.min(opts.maxStringLength, opts.compact ? 26 : 44),
    })

    return [header, meta, table].join("\n")
  }
}

// ── 2. F402EventView (`f402-event-viewer.ts` pattern) ────────────────────────

export interface F402EventRow {
  readonly time: string
  readonly login: string
  readonly category: "WAGER" | "ALERT" | "STEAM" | "LIMIT" | "SYSTEM"
  readonly action: string
}

export class F402EventView extends DeskView<F402EventRow> {
  private readonly title: string
  constructor(
    rows: readonly F402EventRow[],
    title = "F402 EVENT VIEWER (TIME / LOGIN / CATEGORY / ACTION)",
  ) {
    super(rows)
    this.title = title
  }

  render(options: BunInspectOptions = {}): string {
    const opts = resolveInspectOptions(options)
    const colors = opts.colors
    const header = paint(`◆ ${this.title}`, ANSI.boldCyan, colors)
    const meta = paint(
      `  Showing ${this.rows.length} live desk events · depth=${opts.depth} · maxArray=${opts.maxArrayLength} · format: DeskView<F402EventRow>[Bun.inspect.custom]`,
      ANSI.gray,
      colors,
    )

    if (this.rows.length === 0) {
      return [header, meta, paint("  No F402 events recorded yet.", ANSI.gray, colors)].join("\n")
    }

    const orderedRows = opts.sorted
      ? [...this.rows].sort(
          (a, b) => a.login.localeCompare(b.login) || a.time.localeCompare(b.time),
        )
      : this.rows

    const formatted = orderedRows.map((row) => {
      const catColor =
        row.category === "ALERT"
          ? ANSI.boldRed
          : row.category === "STEAM"
            ? ANSI.boldYellow
            : row.category === "LIMIT"
              ? ANSI.magenta
              : row.category === "WAGER"
                ? ANSI.green
                : ANSI.cyan
      return {
        TIME: paint(row.time, ANSI.gray, colors),
        LOGIN: paint(row.login, ANSI.boldWhite, colors),
        CATEGORY: paint(row.category, catColor, colors),
        ACTION: truncateVisible(row.action, Math.min(opts.maxStringLength, opts.compact ? 30 : 52)),
      }
    })

    const table = inspectTable(formatted, ["TIME", "LOGIN", "CATEGORY", "ACTION"], {
      ...opts,
      maxColWidth: Math.min(opts.maxStringLength, opts.compact ? 32 : 52),
    })

    return [header, meta, table].join("\n")
  }
}

// ── 3. F402OverviewView (`f402-overview.ts` pattern) ─────────────────────────

export interface F402OverviewBarItem {
  readonly label: string
  readonly value: number
  readonly max: number
  readonly displayValue: string
  readonly tone?: "cyan" | "green" | "yellow" | "red"
}

export interface F402OverviewSection {
  readonly heading: string
  readonly subtitle?: string
  readonly bars?: readonly F402OverviewBarItem[]
  readonly metrics?: readonly {
    readonly key: string
    readonly value: string
    readonly tone?: "cyan" | "green" | "yellow" | "red"
  }[]
}

function toneAnsi(tone: "cyan" | "green" | "yellow" | "red" | undefined): string {
  switch (tone) {
    case "red":
      return ANSI.red
    case "yellow":
      return ANSI.yellow
    case "green":
      return ANSI.green
    case "cyan":
    default:
      return ANSI.cyan
  }
}

export function renderProgressBar(
  value: number,
  max: number,
  width: number,
  tone: "cyan" | "green" | "yellow" | "red" | undefined,
  colors: boolean,
): string {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  const filled = Math.round(ratio * width)
  const empty = Math.max(0, width - filled)
  const filledPart = paint("█".repeat(filled), toneAnsi(tone), colors)
  const emptyPart = paint("░".repeat(empty), ANSI.gray, colors)
  return `${filledPart}${emptyPart}`
}

export class F402OverviewView extends DeskView<F402OverviewSection> {
  private readonly banner: string
  constructor(
    sections: readonly F402OverviewSection[],
    banner = "FANTASY402 & SPORTSDESK OVERVIEW CARD",
  ) {
    super(sections)
    this.banner = banner
  }

  render(options: BunInspectOptions = {}): string {
    const opts = resolveInspectOptions(options)
    const colors = opts.colors
    const cardWidth = Math.max(58, Math.min(112, opts.breakLength - 2))
    const barWidth = opts.compact ? 14 : Math.min(26, Math.max(16, Math.round(cardWidth * 0.28)))

    const topBorder = paint(`╔${"═".repeat(cardWidth)}╗`, ANSI.boldCyan, colors)
    const titleLine =
      paint("║ ", ANSI.boldCyan, colors) +
      padVisibleEnd(
        truncateVisible(paint(`◆ ${this.banner}`, ANSI.boldWhite, colors), cardWidth - 2),
        cardWidth - 2,
      ) +
      paint(" ║", ANSI.boldCyan, colors)
    const divider = paint(`╠${"═".repeat(cardWidth)}╣`, ANSI.boldCyan, colors)
    const bottomBorder = paint(`╚${"═".repeat(cardWidth)}╝`, ANSI.boldCyan, colors)

    const lines: string[] = [topBorder, titleLine]

    for (const section of this.rows) {
      lines.push(divider)
      const headingText = section.subtitle
        ? `${paint(section.heading.toUpperCase(), ANSI.boldYellow, colors)} ${paint(`· ${section.subtitle}`, ANSI.gray, colors)}`
        : paint(section.heading.toUpperCase(), ANSI.boldYellow, colors)
      lines.push(
        paint("║ ", ANSI.boldCyan, colors) +
          padVisibleEnd(truncateVisible(headingText, cardWidth - 2), cardWidth - 2) +
          paint(" ║", ANSI.boldCyan, colors),
      )

      if (section.metrics && section.metrics.length > 0) {
        const metricsList = opts.sorted
          ? [...section.metrics].sort((a, b) => a.key.localeCompare(b.key))
          : section.metrics
        for (const m of metricsList) {
          const rowText = `  ${paint(m.key.padEnd(20), ANSI.gray, colors)} ${paint(m.value, toneAnsi(m.tone), colors)}`
          lines.push(
            paint("║ ", ANSI.boldCyan, colors) +
              padVisibleEnd(truncateVisible(rowText, cardWidth - 2), cardWidth - 2) +
              paint(" ║", ANSI.boldCyan, colors),
          )
        }
      }

      if (section.bars && section.bars.length > 0) {
        const barList = opts.sorted
          ? [...section.bars].sort((a, b) => a.label.localeCompare(b.label))
          : section.bars
        for (const bar of barList.slice(0, opts.maxArrayLength)) {
          const label = padVisibleEnd(truncateVisible(bar.label, 18), 18)
          const gauge = renderProgressBar(bar.value, bar.max, barWidth, bar.tone, colors)
          const val = paint(bar.displayValue, ANSI.boldWhite, colors)
          const rowText = `  ${label} ${gauge} ${val}`
          lines.push(
            paint("║ ", ANSI.boldCyan, colors) +
              padVisibleEnd(truncateVisible(rowText, cardWidth - 2), cardWidth - 2) +
              paint(" ║", ANSI.boldCyan, colors),
          )
        }
      }
    }

    lines.push(bottomBorder)
    return lines.join("\n")
  }
}
