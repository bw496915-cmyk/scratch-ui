/**
 * @file packages/contracts/src/bun_syntax_highlight.ts
 * @description Cross-runtime syntax highlighting engine powered by Bun Utilities API
 * (`Bun.color`, `Bun.stringWidth`, `Bun.stripANSI`, `Bun.escapeHTML`, `Bun.inspect`),
 * `Bun.YAML` (`parseBunYaml` / `stringifyBunYaml`), and `Bun.Terminal`-ready 24-bit
 * TrueColor ANSI SGR output.
 *
 * Works identically under Bun (invoking native Rust/Zig `Bun.*` APIs) and in
 * browser/Node bundles (via deterministic zero-dependency TypeScript fallbacks).
 */

import { parseBunYamlWithMeta, stringifyBunYaml, type BunYamlEngine } from "./bun_yaml.ts"
import { hexToSgr } from "./wager_tokens.ts"

export type SyntaxFormat = "json" | "yaml" | "toml" | "env" | "markdown"

export type SyntaxTokenType =
  "key" | "string" | "number" | "boolean" | "null" | "comment" | "section" | "punctuation" | "plain"

export interface SyntaxToken {
  readonly type: SyntaxTokenType
  readonly value: string
}

export interface SyntaxTokenThemeSpec {
  readonly hex: string
  readonly label: string
  readonly bold?: boolean | undefined
  readonly italic?: boolean | undefined
  readonly tabularNums?: boolean | undefined
}

export interface BunUtilitiesCapabilities {
  readonly runtime: "bun" | "browser-or-node"
  readonly bunVersion: string | null
  readonly hasBunColor: boolean
  readonly hasBunStringWidth: boolean
  readonly hasBunStripAnsi: boolean
  readonly hasBunEscapeHtml: boolean
  readonly hasBunInspect: boolean
  readonly hasBunYaml: boolean
  readonly hasBunTerminal: boolean
}

export interface HighlightedBlockMetrics {
  readonly format: SyntaxFormat
  readonly lineCount: number
  readonly maxColumnWidth: number
  readonly tokenCounts: Readonly<Record<SyntaxTokenType, number>>
  readonly bunCapabilities: BunUtilitiesCapabilities
}

/**
 * High-contrast dark-console syntax palette calibrated for WCAG AA+ readability
 * on `#0a101d` / `#0d1527` surfaces.
 */
export const SYNTAX_TOKEN_PALETTE: Readonly<Record<SyntaxTokenType, SyntaxTokenThemeSpec>> = {
  key: {
    hex: "#7dd3fc",
    label: "Keys",
    bold: true,
  },
  string: {
    hex: "#86efac",
    label: "Strings",
  },
  number: {
    hex: "#fbbf24",
    label: "Numbers",
    tabularNums: true,
  },
  boolean: {
    hex: "#f472b6",
    label: "Booleans",
    bold: true,
  },
  null: {
    hex: "#c084fc",
    label: "Null",
    italic: true,
  },
  comment: {
    hex: "#64748b",
    label: "Comments",
    italic: true,
  },
  section: {
    hex: "#c084fc",
    label: "Sections",
    bold: true,
  },
  punctuation: {
    hex: "#94a3b8",
    label: "Punctuation",
  },
  plain: {
    hex: "#e2e8f0",
    label: "Plain",
  },
}

// ── Bun Utilities API Runtime Bridge ────────────────────────────────────────

interface BunGlobalShape {
  readonly version?: string
  readonly color?: (
    input: string,
    format?: "css" | "hex" | "HEX" | "ansi-16m" | "ansi" | "rgb",
  ) => string | null
  readonly stringWidth?: (text: string) => number
  readonly stripANSI?: (text: string) => string
  readonly escapeHTML?: (text: string) => string
  readonly inspect?: (
    value: unknown,
    options?: { readonly colors?: boolean; readonly depth?: number },
  ) => string
  readonly YAML?: {
    readonly parse?: (input: string) => unknown
    readonly stringify?: (value: unknown, replacer?: unknown, space?: number) => string
  }
  readonly Terminal?: unknown
}

function getBunGlobal(): BunGlobalShape | null {
  const g = globalThis as unknown as { readonly Bun?: BunGlobalShape }
  return g.Bun ?? null
}

export function detectBunUtilitiesCapabilities(): BunUtilitiesCapabilities {
  const bun = getBunGlobal()
  return {
    runtime: bun ? "bun" : "browser-or-node",
    bunVersion: typeof bun?.version === "string" ? bun.version : null,
    hasBunColor: typeof bun?.color === "function",
    hasBunStringWidth: typeof bun?.stringWidth === "function",
    hasBunStripAnsi: typeof bun?.stripANSI === "function",
    hasBunEscapeHtml: typeof bun?.escapeHTML === "function",
    hasBunInspect: typeof bun?.inspect === "function",
    hasBunYaml:
      typeof bun?.YAML?.parse === "function" && typeof bun?.YAML?.stringify === "function",
    hasBunTerminal: typeof bun?.Terminal === "function",
  }
}

/**
 * Resolve a CSS hex color via `Bun.color(input, "hex")` when running on Bun,
 * with a deterministic browser/Node fallback.
 */
export function bunColorCss(input: string): string {
  const bun = getBunGlobal()
  if (typeof bun?.color === "function") {
    try {
      const resolved = bun.color(input, "hex")
      if (typeof resolved === "string" && resolved.length > 0) {
        return resolved
      }
    } catch {
      // fall through to deterministic input
    }
  }
  return input
}

/**
 * Resolve a 24-bit TrueColor ANSI SGR foreground sequence via
 * `Bun.color(input, "ansi-16m")` for `Bun.Terminal` PTY output.
 */
export function bunColorAnsi16m(input: string): string {
  const bun = getBunGlobal()
  if (typeof bun?.color === "function") {
    try {
      const sgr = bun.color(input, "ansi-16m")
      if (typeof sgr === "string" && sgr.length > 0) {
        return sgr
      }
    } catch {
      // fall through to pure-TS hexToSgr
    }
  }
  return hexToSgr(input, false)
}

/* eslint-disable no-control-regex */
const ANSI_STRIP_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g
/* eslint-enable no-control-regex */

/**
 * Strip ANSI escape sequences via `Bun.stripANSI()` when running under Bun.
 */
export function bunStripAnsi(text: string): string {
  const bun = getBunGlobal()
  if (typeof bun?.stripANSI === "function") {
    try {
      return bun.stripANSI(text)
    } catch {
      // fall through
    }
  }
  return text.replace(ANSI_STRIP_RE, "")
}

/**
 * Measure terminal column display width via `Bun.stringWidth()` when running under Bun.
 */
export function bunStringWidth(text: string): number {
  const bun = getBunGlobal()
  if (typeof bun?.stringWidth === "function") {
    try {
      return bun.stringWidth(text)
    } catch {
      // fall through
    }
  }
  const stripped = bunStripAnsi(text)
  let width = 0
  for (const ch of stripped) {
    const code = ch.codePointAt(0) ?? 0
    // Basic wide-glyph approximation for CJK / emoji in browser fallback
    width += code >= 0x1100 && (code >= 0x1f300 || code <= 0x9fff) ? 2 : 1
  }
  return width
}

/**
 * Escape HTML entities via `Bun.escapeHTML()` when running under Bun.
 */
export function bunEscapeHtml(text: string): string {
  const bun = getBunGlobal()
  if (typeof bun?.escapeHTML === "function") {
    try {
      return bun.escapeHTML(text)
    } catch {
      // fall through
    }
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
}

// ── Value Classifier Helpers ────────────────────────────────────────────────

const STRICT_NUMBER_RE =
  /^[+-]?(?:0x[0-9a-fA-F_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)$/
const BOOLEAN_RE = /^(?:true|false)$/i
const NULL_RE = /^(?:null|~)$/i

function pushToken(out: SyntaxToken[], type: SyntaxTokenType, value: string): void {
  if (!value) return
  const prev = out[out.length - 1]
  if (prev && prev.type === type) {
    out[out.length - 1] = { type, value: prev.value + value }
  } else {
    out.push({ type, value })
  }
}

function classifyScalarValue(raw: string): SyntaxTokenType {
  const trimmed = raw.trim()
  if (!trimmed) return "plain"
  if (BOOLEAN_RE.test(trimmed)) return "boolean"
  if (NULL_RE.test(trimmed)) return "null"
  if (STRICT_NUMBER_RE.test(trimmed)) return "number"
  return "string"
}

function emitTrimmedScalar(out: SyntaxToken[], raw: string): void {
  const leading = raw.match(/^\s*/)?.[0] ?? ""
  const trailing = raw.match(/\s*$/)?.[0] ?? ""
  const core = raw.slice(leading.length, raw.length - trailing.length)
  if (leading) pushToken(out, "plain", leading)
  if (core) {
    pushToken(out, classifyScalarValue(core), core)
  }
  if (trailing) pushToken(out, "plain", trailing)
}

// ── JSON Tokenizer ──────────────────────────────────────────────────────────

export function tokenizeJson(text: string): readonly SyntaxToken[] {
  const out: SyntaxToken[] = []
  let i = 0
  const len = text.length

  while (i < len) {
    const ch = text[i]!

    // Whitespace
    if (/\s/.test(ch)) {
      let end = i + 1
      while (end < len && /\s/.test(text[end]!)) end += 1
      pushToken(out, "plain", text.slice(i, end))
      i = end
      continue
    }

    // String or object key
    if (ch === '"') {
      let end = i + 1
      while (end < len) {
        const cur = text[end]!
        if (cur === "\\") {
          end += 2
          continue
        }
        if (cur === '"') {
          end += 1
          break
        }
        end += 1
      }
      // Look ahead past whitespace to see if followed by ':' -> JSON key
      let look = end
      while (look < len && (text[look] === " " || text[look] === "\t")) {
        look += 1
      }
      const isKey = text[look] === ":"
      pushToken(out, isKey ? "key" : "string", text.slice(i, end))
      i = end
      continue
    }

    // Structural punctuation
    if ("{}[]:,".includes(ch)) {
      pushToken(out, "punctuation", ch)
      i += 1
      continue
    }

    // Number
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const numMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))
      if (numMatch) {
        pushToken(out, "number", numMatch[0])
        i += numMatch[0].length
        continue
      }
    }

    // Booleans / null
    const wordMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))
    if (wordMatch) {
      const word = wordMatch[0]
      if (word === "true" || word === "false") {
        pushToken(out, "boolean", word)
      } else if (word === "null") {
        pushToken(out, "null", word)
      } else {
        pushToken(out, "plain", word)
      }
      i += word.length
      continue
    }

    pushToken(out, "plain", ch)
    i += 1
  }

  return out
}

// ── Inline Flow Value Tokenizer (shared by YAML & TOML inline arrays/objects) ─

function splitCommentOutsideQuotes(line: string): {
  readonly code: string
  readonly comment: string
} {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quote) {
      if (ch === "\\" && quote === '"') {
        i += 1
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) {
      return { code: line.slice(0, i), comment: line.slice(i) }
    }
  }
  return { code: line, comment: "" }
}

function tokenizeInlineValue(out: SyntaxToken[], raw: string, assignmentChar: ":" | "="): void {
  let i = 0
  const len = raw.length
  while (i < len) {
    const ch = raw[i]!
    if (/\s/.test(ch)) {
      let end = i + 1
      while (end < len && /\s/.test(raw[end]!)) end += 1
      pushToken(out, "plain", raw.slice(i, end))
      i = end
      continue
    }
    if (ch === '"' || ch === "'") {
      let end = i + 1
      while (end < len) {
        if (ch === '"' && raw[end] === "\\") {
          end += 2
          continue
        }
        if (raw[end] === ch) {
          end += 1
          break
        }
        end += 1
      }
      pushToken(out, "string", raw.slice(i, end))
      i = end
      continue
    }
    if ("{}[],".includes(ch) || ch === assignmentChar) {
      pushToken(out, "punctuation", ch)
      i += 1
      continue
    }
    // Check for inline key= / key:
    const keyMatch =
      assignmentChar === "="
        ? /^([A-Za-z0-9_.-]+)(\s*=)/.exec(raw.slice(i))
        : /^([A-Za-z0-9_.-]+)(\s*:)(?=\s|$|,|\})/.exec(raw.slice(i))
    if (keyMatch) {
      pushToken(out, "key", keyMatch[1]!)
      pushToken(out, "punctuation", keyMatch[2]!)
      i += keyMatch[0].length
      continue
    }
    // Read until next delimiter
    let end = i + 1
    while (end < len && !"{}[],\"'".includes(raw[end]!) && raw[end] !== assignmentChar) {
      end += 1
    }
    emitTrimmedScalar(out, raw.slice(i, end))
    i = end
  }
}

// ── YAML 1.2 Tokenizer ──────────────────────────────────────────────────────

export function tokenizeYaml(text: string): readonly SyntaxToken[] {
  const out: SyntaxToken[] = []
  const lines = text.split("\n")

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    if (lineIdx > 0) pushToken(out, "plain", "\n")
    const line = lines[lineIdx]!

    // Document separators
    if (/^\s*(?:---|\.\.\.)\s*$/.test(line)) {
      pushToken(out, "section", line)
      continue
    }

    const { code, comment } = splitCommentOutsideQuotes(line)

    if (code.length > 0) {
      // Match optional indent + optional list dash + mapping key + ':'
      const mapMatch =
        /^(\s*)(-\s+)?("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[A-Za-z0-9_./@-][A-Za-z0-9_./@\s-]*?)(\s*:)(\s*.*)$/.exec(
          code,
        )
      if (mapMatch) {
        const [, indent, dash, keyPart, colon, rest] = mapMatch
        if (indent) pushToken(out, "plain", indent)
        if (dash) pushToken(out, "punctuation", dash)
        pushToken(out, "key", keyPart!)
        pushToken(out, "punctuation", colon!)

        if (rest && rest.trim().length > 0) {
          const restTrim = rest.trim()
          // YAML anchor/alias or block scalar indicator
          if (/^[|>]/.test(restTrim)) {
            pushToken(out, "punctuation", rest)
          } else if (
            restTrim.startsWith("{") ||
            restTrim.startsWith("[") ||
            restTrim.startsWith('"') ||
            restTrim.startsWith("'")
          ) {
            tokenizeInlineValue(out, rest, ":")
          } else if (/^[&*][A-Za-z0-9_-]+$/.test(restTrim)) {
            pushToken(out, "section", rest)
          } else {
            emitTrimmedScalar(out, rest)
          }
        } else if (rest) {
          pushToken(out, "plain", rest)
        }
      } else {
        // List scalar item: `- value`
        const listMatch = /^(\s*)(-\s+)(.*)$/.exec(code)
        if (listMatch) {
          const [, indent, dash, val] = listMatch
          if (indent) pushToken(out, "plain", indent)
          pushToken(out, "punctuation", dash!)
          const trimmed = val!.trim()
          if (
            trimmed.startsWith("{") ||
            trimmed.startsWith("[") ||
            trimmed.startsWith('"') ||
            trimmed.startsWith("'")
          ) {
            tokenizeInlineValue(out, val!, ":")
          } else {
            emitTrimmedScalar(out, val!)
          }
        } else {
          emitTrimmedScalar(out, code)
        }
      }
    }

    if (comment) {
      pushToken(out, "comment", comment)
    }
  }

  return out
}

// ── TOML Tokenizer (`bunfig.toml`) ──────────────────────────────────────────

export function tokenizeToml(text: string): readonly SyntaxToken[] {
  const out: SyntaxToken[] = []
  const lines = text.split("\n")

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    if (lineIdx > 0) pushToken(out, "plain", "\n")
    const line = lines[lineIdx]!
    const { code, comment } = splitCommentOutsideQuotes(line)

    if (code.length > 0) {
      // [section] or [[array_table]]
      if (/^\s*\[{1,2}[^\]]+\]{1,2}\s*$/.test(code)) {
        pushToken(out, "section", code)
      } else {
        const assignMatch =
          /^(\s*)("(?:\\.|[^"\\])*"|'(?:[^']*)'|[A-Za-z0-9_.-]+)(\s*=\s*)(.*)$/.exec(code)
        if (assignMatch) {
          const [, indent, keyPart, eqPart, valuePart] = assignMatch
          if (indent) pushToken(out, "plain", indent)
          pushToken(out, "key", keyPart!)
          pushToken(out, "punctuation", eqPart!)
          tokenizeInlineValue(out, valuePart!, "=")
        } else {
          pushToken(out, "plain", code)
        }
      }
    }

    if (comment) {
      pushToken(out, "comment", comment)
    }
  }

  return out
}

// ── .env Tokenizer (`.env.example`) ─────────────────────────────────────────

export function tokenizeEnv(text: string): readonly SyntaxToken[] {
  const out: SyntaxToken[] = []
  const lines = text.split("\n")

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    if (lineIdx > 0) pushToken(out, "plain", "\n")
    const line = lines[lineIdx]!

    if (/^\s*#/.test(line)) {
      pushToken(out, "comment", line)
      continue
    }

    const envMatch = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/.exec(line)
    if (envMatch) {
      const [, indent, exp, keyPart, eqPart, rawVal] = envMatch
      if (indent) pushToken(out, "plain", indent)
      if (exp) pushToken(out, "section", exp)
      pushToken(out, "key", keyPart!)
      pushToken(out, "punctuation", eqPart!)

      const { code: valCode, comment } = splitCommentOutsideQuotes(rawVal ?? "")
      if (valCode.length > 0) {
        const trimmed = valCode.trim()
        if (
          (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
          (trimmed.startsWith("'") && trimmed.endsWith("'"))
        ) {
          pushToken(out, "string", valCode)
        } else {
          emitTrimmedScalar(out, valCode)
        }
      }
      if (comment) {
        pushToken(out, "comment", comment)
      }
      continue
    }

    pushToken(out, "plain", line)
  }

  return out
}

// ── Markdown / Status Brief Tokenizer (with Fenced Block & YAML Frontmatter) ─

function tokenizeMarkdownInlineLine(out: SyntaxToken[], line: string): void {
  // Highlight inline key: value / key=value pairs, quoted strings, booleans, numbers
  const tokenRe =
    /("(?:\\.|[^"\\])*"|`[^`]+`|\b(?:true|false)\b|\bnull\b|\b[A-Za-z][A-Za-z0-9_.-]{1,36}(?=\s*[:=]\s*)|\b-?(?:\$)?\d[\d,]*(?:\.\d+)?(?:%|ms|s|KB|MB|GB|K|M|B)?\b)/g

  let last = 0
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(line)) !== null) {
    if (match.index > last) {
      pushToken(out, "plain", line.slice(last, match.index))
    }
    const raw = match[0]
    const after = line.slice(match.index + raw.length)
    if (raw.startsWith('"') || raw.startsWith("`")) {
      pushToken(out, "string", raw)
    } else if (raw === "true" || raw === "false") {
      pushToken(out, "boolean", raw)
    } else if (raw === "null") {
      pushToken(out, "null", raw)
    } else if (/^[:=]/.test(after.trimStart()) && !/^\$?\d/.test(raw)) {
      pushToken(out, "key", raw)
    } else if (/^-?\$?\d/.test(raw)) {
      pushToken(out, "number", raw)
    } else {
      pushToken(out, "plain", raw)
    }
    last = match.index + raw.length
  }

  if (last < line.length) {
    pushToken(out, "plain", line.slice(last))
  }
}

export function tokenizeMarkdownBrief(text: string): readonly SyntaxToken[] {
  const out: SyntaxToken[] = []
  const lines = text.split("\n")
  let inFrontmatter = false
  let fenceLang: SyntaxFormat | "other" | null = null
  let fenceBuffer: string[] = []

  const flushFence = () => {
    if (fenceBuffer.length === 0) return
    const body = fenceBuffer.join("\n")
    const inner =
      fenceLang === "json"
        ? tokenizeJson(body)
        : fenceLang === "yaml"
          ? tokenizeYaml(body)
          : fenceLang === "toml"
            ? tokenizeToml(body)
            : fenceLang === "env"
              ? tokenizeEnv(body)
              : [{ type: "plain" as const, value: body }]
    for (const tok of inner) {
      pushToken(out, tok.type, tok.value)
    }
    fenceBuffer = []
  }

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!

    // YAML Frontmatter (`---` on line 0)
    if (idx === 0 && line.trim() === "---") {
      inFrontmatter = true
      pushToken(out, "section", line)
      continue
    }
    if (inFrontmatter) {
      pushToken(out, "plain", "\n")
      if (line.trim() === "---" || line.trim() === "...") {
        inFrontmatter = false
        pushToken(out, "section", line)
      } else {
        for (const tok of tokenizeYaml(line)) {
          pushToken(out, tok.type, tok.value)
        }
      }
      continue
    }

    // Fenced code blocks
    const fenceOpen = /^\s*```([A-Za-z0-9_-]*)\s*$/.exec(line)
    if (fenceOpen) {
      if (fenceLang === null) {
        if (idx > 0) pushToken(out, "plain", "\n")
        const lang = (fenceOpen[1] ?? "").toLowerCase()
        fenceLang =
          lang === "json" || lang === "jsonc"
            ? "json"
            : lang === "yaml" || lang === "yml"
              ? "yaml"
              : lang === "toml"
                ? "toml"
                : lang === "env" || lang === "ini" || lang === "dotenv"
                  ? "env"
                  : "other"
        pushToken(out, "section", line)
      } else {
        if (fenceBuffer.length > 0) {
          pushToken(out, "plain", "\n")
          flushFence()
        }
        pushToken(out, "plain", "\n")
        pushToken(out, "section", line)
        fenceLang = null
      }
      continue
    }

    if (fenceLang !== null) {
      fenceBuffer.push(line)
      continue
    }

    if (idx > 0) pushToken(out, "plain", "\n")

    // Headings
    if (/^\s*#{1,6}\s+/.test(line)) {
      pushToken(out, "section", line)
      continue
    }

    // Horizontal rules / table borders
    if (/^\s*(?:---+|===+|\|[\s:|-]+\|)\s*$/.test(line)) {
      pushToken(out, "punctuation", line)
      continue
    }

    // Key: value list or status lines (`- **Key**: value` or `Key: value`)
    const kvLine =
      /^(\s*(?:[-*]\s+)?)(?:\*\*)?([A-Za-z][A-Za-z0-9_\s./-]{0,36})(?:\*\*)?(\s*:\s*)(.+)$/.exec(
        line,
      )
    if (kvLine && !line.trimStart().startsWith("|")) {
      const [, prefix, keyPart, colon, rest] = kvLine
      if (prefix) pushToken(out, "punctuation", prefix)
      pushToken(out, "key", keyPart!)
      pushToken(out, "punctuation", colon!)
      tokenizeMarkdownInlineLine(out, rest!)
      continue
    }

    // Table rows or general prose with metrics/booleans/strings
    tokenizeMarkdownInlineLine(out, line)
  }

  if (fenceLang !== null && fenceBuffer.length > 0) {
    pushToken(out, "plain", "\n")
    flushFence()
  }

  return out
}

// ── Public Unified Dispatcher & Bun.Terminal ANSI / Bun.YAML Bridges ────────

export function tokenizeSyntax(text: string, format: SyntaxFormat): readonly SyntaxToken[] {
  switch (format) {
    case "json":
      return tokenizeJson(text)
    case "yaml":
      return tokenizeYaml(text)
    case "toml":
      return tokenizeToml(text)
    case "env":
      return tokenizeEnv(text)
    case "markdown":
      return tokenizeMarkdownBrief(text)
  }
}

/**
 * Render syntax-highlighted text as 24-bit TrueColor ANSI escape sequences
 * via `Bun.color(hex, "ansi-16m")` for direct `Bun.Terminal` PTY output.
 */
export function formatSyntaxAsBunTerminalAnsi(text: string, format: SyntaxFormat): string {
  const tokens = tokenizeSyntax(text, format)
  let out = ""
  for (const token of tokens) {
    if (token.type === "plain" && /^\s+$/.test(token.value)) {
      out += token.value
      continue
    }
    const spec = SYNTAX_TOKEN_PALETTE[token.type]
    const sgrColor = bunColorAnsi16m(spec.hex)
    const prefix = `${spec.bold ? "\x1b[1m" : ""}${spec.italic ? "\x1b[3m" : ""}${sgrColor}`
    out += `${prefix}${token.value}\x1b[0m`
  }
  return out
}

/**
 * Parse a `.env` block into a structured key/value object and serialize it
 * cleanly via `Bun.YAML.stringify` (with `parseBunYaml` verification) so
 * Status Dashboard `.env.example` output can be viewed natively as YAML.
 */
export function convertEnvTemplateToBunYaml(envText: string): {
  readonly yaml: string
  readonly entryCount: number
  readonly engine: BunYamlEngine
} {
  const record: Record<string, string | number | boolean | null> = {}
  const lines = envText.split("\n")
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!
    const rawVal = (m[2] ?? "").trim()
    if (rawVal === "") {
      record[key] = null
    } else if (/^true$/i.test(rawVal)) {
      record[key] = true
    } else if (/^false$/i.test(rawVal)) {
      record[key] = false
    } else if (/^-?\d+(?:\.\d+)?$/.test(rawVal)) {
      record[key] = Number(rawVal)
    } else if (
      (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
      (rawVal.startsWith("'") && rawVal.endsWith("'"))
    ) {
      record[key] = rawVal.slice(1, -1)
    } else {
      record[key] = rawVal
    }
  }
  const yaml = stringifyBunYaml(record, { space: 2 })
  // Validate round-trip through Bun.YAML.parse
  const verified = parseBunYamlWithMeta(yaml)
  return {
    yaml,
    entryCount: Object.keys(record).length,
    engine: verified.engine,
  }
}

/**
 * Compute token statistics and `Bun.stringWidth` column dimensions for any
 * preformatted output block.
 */
export function computeHighlightedBlockMetrics(
  text: string,
  format: SyntaxFormat,
): HighlightedBlockMetrics {
  const tokens = tokenizeSyntax(text, format)
  const counts: Record<SyntaxTokenType, number> = {
    key: 0,
    string: 0,
    number: 0,
    boolean: 0,
    null: 0,
    comment: 0,
    section: 0,
    punctuation: 0,
    plain: 0,
  }
  for (const token of tokens) {
    counts[token.type] += 1
  }
  const lines = text.length === 0 ? [] : text.split("\n")
  let maxColumnWidth = 0
  for (const line of lines) {
    const w = bunStringWidth(line)
    if (w > maxColumnWidth) maxColumnWidth = w
  }
  return {
    format,
    lineCount: lines.length,
    maxColumnWidth,
    tokenCounts: counts,
    bunCapabilities: detectBunUtilitiesCapabilities(),
  }
}
