import { stripVTControlCharacters } from "node:util"

import {
  ANSI_SGR,
  hasControlChars,
  isColorEnabled,
  normalizeTerminalColumns,
  resolveAnsiPalette,
  resolveAnsiTheme,
  type SemanticAnsiPalette,
  stripControls,
} from "./ansi_tokens.ts"

declare const Bun: Pick<
  typeof import("bun"),
  "markdown" | "stringWidth" | "wrapAnsi" | "stripANSI" | "sliceAnsi"
>

function stripAnsiFast(text: string): string {
  if (typeof Bun !== "undefined" && typeof Bun.stripANSI === "function") {
    return Bun.stripANSI(text)
  }
  return stripVTControlCharacters(text)
}

const SIGNED_S3_QUERY = new Set(["x-amz-credential", "x-amz-signature", "x-amz-security-token"])

export interface ThemedMarkdownHeadingMeta {
  readonly level: number
  readonly id: string
  readonly text: string
}

export interface ThemedMarkdownMetadata {
  readonly headingIds: readonly ThemedMarkdownHeadingMeta[]
  readonly tableCount: number
  readonly taskSummary: {
    readonly total: number
    readonly checked: number
    readonly unchecked: number
  }
}

export interface RenderMarkdownOptions {
  readonly colors?: boolean | undefined
  readonly columns?: number | undefined
  readonly hyperlinks?: boolean | undefined
  readonly palette?: SemanticAnsiPalette | undefined
  readonly showHeadingIds?: boolean | undefined
  readonly onMetadata?: ((metadata: ThemedMarkdownMetadata) => void) | undefined
}

export function padGrapheme(text: string, width: number): string {
  const clean = stripControls(text).replace(/[\t\n]/g, " ")
  const length =
    typeof Bun === "undefined"
      ? Array.from(clean).length
      : Bun.stringWidth(clean, { ambiguousIsNarrow: true, countAnsiEscapeCodes: false })
  return clean + " ".repeat(Math.max(0, normalizeTerminalColumns(width) - length))
}

function measureDisplayWidth(text: string): number {
  if (typeof Bun !== "undefined" && typeof Bun.stringWidth === "function") {
    return Bun.stringWidth(text, { ambiguousIsNarrow: true, countAnsiEscapeCodes: false })
  }
  return Array.from(stripVTControlCharacters(text)).length
}

function padAlignedCell(
  text: string,
  width: number,
  align: "left" | "center" | "right" | undefined,
): string {
  const clean = text.replace(/[\r\n]+/g, " ").trim()
  const visual = measureDisplayWidth(clean)
  const gap = Math.max(0, width - visual)
  if (align === "right") return `${" ".repeat(gap)}${clean}`
  if (align === "center") {
    const left = Math.floor(gap / 2)
    return `${" ".repeat(left)}${clean}${" ".repeat(gap - left)}`
  }
  return `${clean}${" ".repeat(gap)}`
}

export function safeHref(href: string): string | null {
  if (hasControlChars(href) || /[\t\n]/.test(href)) return null
  try {
    const decoded = decodeURIComponent(href)
    if (hasControlChars(decoded) || /[\t\n]/.test(decoded)) return null
  } catch {
    return null
  }
  for (const [, hex, decimal, named] of href.matchAll(
    /&#(?:x([0-9a-f]+)|([0-9]+));|&(Tab|NewLine);/gi,
  )) {
    const code = hex ? Number.parseInt(hex, 16) : Number(decimal)
    if (named || code <= 31 || (code >= 127 && code <= 159)) return null
  }
  const url = URL.parse(href.replace(/&amp;|&#0*38;|&#x0*26;/gi, "&"))
  if (!url || url.username || url.password) return null
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "mailto:")
    return null
  for (const name of url.searchParams.keys()) {
    if (SIGNED_S3_QUERY.has(name.toLowerCase())) return null
  }
  return url.href
}

/** Preserve the renderer's inline SGR styles and validate the destination at emission. */
export function osc8Link(label: string, href: string, enabled: boolean): string {
  const cleanLabel = label
    .split(/(\x1b\[(?:0|1|2|22|39|38;2;\d{1,3};\d{1,3};\d{1,3})m)/g)
    .map((part, index) => (index % 2 ? part : stripControls(stripVTControlCharacters(part))))
    .join("")
    .replace(/[\t\n]/g, " ")
  const url = safeHref(href)
  if (!url) return cleanLabel
  return enabled ? `\x1b]8;;${url}\x07${cleanLabel}\x1b]8;;\x07` : `${cleanLabel} (${url})`
}

export function renderThemedMarkdown(
  markdown: string,
  options: RenderMarkdownOptions = {},
): string {
  if (typeof Bun === "undefined") return stripControls(markdown)
  const theme = resolveAnsiTheme(options)
  const colors = theme.colors === true
  const palette = resolveAnsiPalette(colors, options.palette)
  const { reset, bold, dim } = colors ? ANSI_SGR : { reset: "", bold: "", dim: "" }
  const italicOn = colors ? "\x1b[3m" : ""
  const italicOff = colors ? "\x1b[23m" : ""
  const strikeOn = colors ? "\x1b[9m" : ""
  const strikeOff = colors ? "\x1b[29m" : ""
  const columns = theme.columns ?? 76
  const wrap = (text: string) => (columns > 0 ? Bun.wrapAnsi(text, columns) : text)

  const headingIds: ThemedMarkdownHeadingMeta[] = []
  let tableCount = 0
  let taskChecked = 0
  let taskUnchecked = 0

  interface TableCell {
    readonly text: string
    readonly align?: "left" | "center" | "right" | undefined
  }
  let currentCells: TableCell[] = []
  let sectionRows: TableCell[][] = []
  let headRows: TableCell[][] = []
  let bodyRows: TableCell[][] = []

  const formatBoxTable = (): string => {
    const allRows = [...headRows, ...bodyRows]
    if (allRows.length === 0) return ""
    const colCount = Math.max(...allRows.map((r) => r.length), 0)
    if (colCount === 0) return ""
    const aligns: ("left" | "center" | "right" | undefined)[] = Array.from(
      { length: colCount },
      () => undefined,
    )
    const widths: number[] = Array.from({ length: colCount }, () => 3)
    for (const row of allRows) {
      for (let c = 0; c < colCount; c += 1) {
        const cell = row[c]
        if (!cell) continue
        if (cell.align && !aligns[c]) aligns[c] = cell.align
        const w = measureDisplayWidth(cell.text.replace(/[\r\n]+/g, " ").trim())
        if (w > widths[c]!) widths[c] = w
      }
    }
    const border = (l: string, m: string, r: string, fill: string) =>
      `${dim}${l}${widths.map((w) => fill.repeat(w + 2)).join(m)}${r}${reset}`
    const top = colors ? border("┌", "┬", "┐", "─") : border("+", "+", "+", "-")
    const mid = colors ? border("├", "┼", "┤", "─") : border("+", "+", "+", "-")
    const bot = colors ? border("└", "┴", "┘", "─") : border("+", "+", "+", "-")
    const bar = colors ? `${dim}│${reset}` : "|"
    const fmtRow = (row: readonly TableCell[], isHead: boolean) => {
      const cells = Array.from({ length: colCount }, (_u, c) => {
        const cell = row[c]
        const padded = padAlignedCell(cell?.text ?? "", widths[c]!, cell?.align ?? aligns[c])
        return isHead && colors ? ` ${bold}${palette.key}${padded}${reset} ` : ` ${padded} `
      })
      return `${bar}${cells.join(bar)}${bar}`
    }
    const lines = [top, ...headRows.map((r) => fmtRow(r, true))]
    if (headRows.length > 0 && bodyRows.length > 0) lines.push(mid)
    lines.push(...bodyRows.map((r) => fmtRow(r, false)), bot)
    return `${lines.join("\n")}\n\n`
  }

  // Use the same safe leaf callbacks in plain and color output. Parsed
  // entities can introduce controls even when the source has none.
  const rendered = Bun.markdown.render(
    markdown,
    {
      text: stripControls,
      code: stripControls,
      html: stripControls,
      heading: (children, meta) => {
        const level = meta?.level ?? 1
        const id = typeof meta?.id === "string" ? meta.id : ""
        const plain = stripAnsiFast(stripControls(children)).trim()
        headingIds.push({ level, id, text: plain })
        const idTag =
          options.showHeadingIds && id ? (colors ? ` ${dim}[#${id}]${reset}` : ` [#${id}]`) : ""
        return `${bold}${palette.heading}${wrap(children)}${reset}${idTag}\n`
      },
      paragraph: (children) => `${wrap(children)}\n\n`,
      blockquote: (children) => {
        const prefix = colors ? `${dim}| ${reset}` : "| "
        return `${String(children)
          .trimEnd()
          .split("\n")
          .map((l) => `${prefix}${l}`)
          .join("\n")}\n\n`
      },
      hr: () => `${dim}${"-".repeat(Math.min(columns > 0 ? columns : 60, 60))}${reset}\n\n`,
      list: (children) => `${children}\n`,
      listItem: (children, meta) => {
        const indent = "  ".repeat((meta.depth ?? 0) + 1)
        let bullet: string
        if (typeof meta.checked === "boolean") {
          if (meta.checked) taskChecked += 1
          else taskUnchecked += 1
          bullet = colors
            ? meta.checked
              ? `${palette.ok}☑${reset}`
              : `${dim}☐${reset}`
            : meta.checked
              ? "[x]"
              : "[ ]"
        } else {
          bullet = meta.ordered ? `${(meta.start ?? 1) + meta.index}.` : "*"
        }
        return `${indent}${bullet} ${String(children).trimEnd()}\n`
      },
      th: (children, meta) => {
        currentCells.push({ text: stripControls(String(children)).trim(), align: meta?.align })
        return ""
      },
      td: (children, meta) => {
        currentCells.push({ text: stripControls(String(children)).trim(), align: meta?.align })
        return ""
      },
      tr: () => {
        if (currentCells.length > 0) {
          sectionRows.push(currentCells)
          currentCells = []
        }
        return ""
      },
      thead: () => {
        headRows = sectionRows
        sectionRows = []
        return ""
      },
      tbody: () => {
        bodyRows = sectionRows
        sectionRows = []
        return ""
      },
      table: () => {
        tableCount += 1
        if (sectionRows.length > 0 && bodyRows.length === 0) {
          bodyRows = sectionRows
          sectionRows = []
        }
        const out = formatBoxTable()
        currentCells = []
        sectionRows = []
        headRows = []
        bodyRows = []
        return out
      },
      strong: (children) => `${bold}${palette.key}${children}${reset}`,
      emphasis: (children) => `${italicOn}${children}${italicOff}`,
      strikethrough: (children) => `${strikeOn}${children}${strikeOff}`,
      codespan: (children) => {
        const clean = stripControls(children)
        const color = clean.startsWith("[REDACTED") ? palette.redacted : palette.code
        return `${color}${clean}${reset}`
      },
      link: (label, { href }) => osc8Link(label, href, theme.hyperlinks === true),
      image: (alt) => stripControls(alt),
    },
    {
      tables: true,
      strikethrough: true,
      tasklists: true,
      autolinks: true,
      headings: { ids: true },
    },
  )

  if (options.onMetadata) {
    options.onMetadata({
      headingIds,
      tableCount,
      taskSummary: {
        total: taskChecked + taskUnchecked,
        checked: taskChecked,
        unchecked: taskUnchecked,
      },
    })
  }
  return rendered
}

export function formatKeyValueRows(
  rows: readonly (readonly [string, string])[],
  options: { colors?: boolean | undefined; keyWidth?: number | undefined } = {},
): string {
  const colors = isColorEnabled(options.colors)
  const palette = resolveAnsiPalette(colors)
  const { reset, dim } = colors ? ANSI_SGR : { reset: "", dim: "" }
  return rows
    .map(([key, value]) => {
      const label = padGrapheme(key, options.keyWidth ?? 15)
      const clean = stripControls(value).replace(/[\t\n]/g, " ")
      const color = clean.startsWith("[REDACTED")
        ? palette.redacted
        : clean === "UNSEALED"
          ? palette.warn
          : palette.ok
      return `${dim}${palette.key}${label}${reset} ${color}${clean}${reset}`
    })
    .join("\n")
}
