import { stripVTControlCharacters } from "node:util"
import {
  ANSI_SGR,
  hasControlChars,
  isColorEnabled,
  normalizeTerminalColumns,
  resolveAnsiPalette,
  resolveAnsiTheme,
  stripControls,
  type SemanticAnsiPalette,
} from "./ansi_tokens.ts"

declare const Bun: Pick<typeof import("bun"), "markdown" | "stringWidth" | "wrapAnsi">

const SIGNED_S3_QUERY = new Set(["x-amz-credential", "x-amz-signature", "x-amz-security-token"])

export interface RenderMarkdownOptions {
  readonly colors?: boolean | undefined
  readonly columns?: number | undefined
  readonly hyperlinks?: boolean | undefined
  readonly palette?: SemanticAnsiPalette | undefined
}

export function padGrapheme(text: string, width: number): string {
  const clean = stripControls(text).replace(/[\t\n]/g, " ")
  const length =
    typeof Bun === "undefined"
      ? Array.from(clean).length
      : Bun.stringWidth(clean, { ambiguousIsNarrow: true, countAnsiEscapeCodes: false })
  return clean + " ".repeat(Math.max(0, normalizeTerminalColumns(width) - length))
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
  const palette = resolveAnsiPalette(theme.colors === true, options.palette)
  const { reset, bold, dim } = theme.colors ? ANSI_SGR : { reset: "", bold: "", dim: "" }
  const columns = theme.columns ?? 76
  const wrap = (text: string) => (columns > 0 ? Bun.wrapAnsi(text, columns) : text)

  // Use the same safe leaf callbacks in plain and color output. Parsed
  // entities can introduce controls even when the source has none.
  return Bun.markdown.render(markdown, {
    text: stripControls,
    code: stripControls,
    html: stripControls,
    heading: (children) => `${bold}${palette.heading}${wrap(children)}${reset}\n`,
    paragraph: (children) => `${wrap(children)}\n\n`,
    hr: () => `${dim}${"-".repeat(Math.min(columns > 0 ? columns : 60, 60))}${reset}\n\n`,
    listItem: (children, { ordered, index, start }) =>
      `  ${ordered ? `${(start ?? 1) + index}.` : "*"} ${children}\n`,
    strong: (children) => `${bold}${palette.key}${children}${reset}`,
    codespan: (children) => {
      const clean = stripControls(children)
      const color = clean.startsWith("[REDACTED") ? palette.redacted : palette.code
      return `${color}${clean}${reset}`
    },
    link: (label, { href }) => osc8Link(label, href, theme.hyperlinks === true),
    image: (alt) => stripControls(alt),
  })
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
