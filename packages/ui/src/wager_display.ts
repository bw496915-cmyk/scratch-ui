/**
 * @file packages/ui/src/wager_display.ts
 * @description One way to render a wager's selection, line and price.
 *
 * Hydrated F402 rows can carry the whole short description in both `selection`
 * and `lineDisplay` (ticket 769158444: both are `Steelers (Live) +27½ +100`).
 * Concatenating them prints the pick twice, so every renderer goes through this
 * formatter instead of composing the strings itself.
 */

/** The three fields needed to render a pick; structural so any wager row fits. */
import { sanitizeCaptureText } from "./capture_text.ts"

export interface WagerSelectionParts {
  readonly selection: string
  readonly lineDisplay: string
  readonly oddsAmerican: string
}

export interface WagerSelectionOptions {
  /** Append `(odds)`; defaults to true. */
  readonly includeOdds?: boolean | undefined
}

function collapse(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

const PLACEHOLDER_TOKENS = new Set(["", "—", "–", "-", "n/a", "null", "undefined"])

/** Returns cleaned American odds string, or `null` for empty/placeholder tokens like `—`. */
export function normalizeAmericanOdds(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = collapse(sanitizeCaptureText(raw))
  if (PLACEHOLDER_TOKENS.has(cleaned.toLowerCase())) return null
  return cleaned
}

/**
 * Extracts a trailing American odds token (`-110`, `+145`, `EV`/`EVEN` → `+100`)
 * from a pick or line string. Requires `|n| >= 100` so spreads like `-4.5` or `-3`
 * are never mistaken for American odds.
 */
export function extractAmericanOddsFromText(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = collapse(sanitizeCaptureText(raw))
  if (!cleaned) return null
  const match = /(?:^|\s)([+-]\d{3,5})$/.exec(cleaned)
  if (match?.[1]) {
    const parsed = Number.parseInt(match[1], 10)
    if (Number.isFinite(parsed) && Math.abs(parsed) >= 100) {
      return match[1]
    }
  }
  if (/(?:^|\s)(?:EV|EVEN)$/i.test(cleaned)) {
    return "+100"
  }
  return null
}

/**
 * Resolves valid American odds from explicit `oddsAmerican`, falling back to
 * trailing odds embedded in `lineDisplay` / `selection` for non-parlay tickets.
 */
export function resolveWagerOddsAmerican(wager: {
  readonly oddsAmerican?: string | null | undefined
  readonly lineDisplay?: string | null | undefined
  readonly selection?: string | null | undefined
  readonly betType?: string | null | undefined
}): string | null {
  const explicit = normalizeAmericanOdds(wager.oddsAmerican)
  if (explicit !== null) return explicit
  if (/\bparlay\b/i.test(wager.betType ?? "")) return null
  return (
    extractAmericanOddsFromText(wager.lineDisplay) ??
    extractAmericanOddsFromText(wager.selection)
  )
}

/**
 * True when `odds` already appears inside `text` at whole-token boundaries
 * (plain or wrapped in parentheses), preventing `Alpha -110 (-110)`.
 */
export function selectionIncludesOdds(text: string, odds: string): boolean {
  const cleanOdds = normalizeAmericanOdds(odds)
  if (!cleanOdds) return true
  const haystack = collapse(sanitizeCaptureText(text)).toLowerCase()
  if (!haystack) return false
  const needle = cleanOdds.toLowerCase()
  if (haystack === needle || haystack === `(${needle})`) return true
  return (
    haystack.endsWith(` ${needle}`) ||
    haystack.includes(` ${needle} `) ||
    haystack.includes(`(${needle})`)
  )
}

/**
 * True when `lineDisplay` is already visible inside `selection`, compared on
 * collapsed lower-case text at whole-token boundaries — so `Over 47.5` does not
 * swallow a numeric line of `7`.
 */
export function selectionIncludesLine(selection: string, lineDisplay: string): boolean {
  const line = collapse(lineDisplay).toLowerCase()
  if (line.length === 0) return true
  const pick = collapse(selection).toLowerCase()
  if (pick.length === 0) return false
  if (pick === line) return true
  return pick.startsWith(`${line} `) || pick.endsWith(` ${line}`)
}

/**
 * `selection [line] (odds)` with the line and odds printed only once and no
 * dangling separators or `(—)` placeholders. Empty input degrades to `—`.
 */
export function formatWagerSelection(
  wager: WagerSelectionParts,
  options: WagerSelectionOptions = {},
): string {
  const rawSelection = collapse(sanitizeCaptureText(wager.selection))
  const rawLine = collapse(sanitizeCaptureText(wager.lineDisplay))
  const selection = PLACEHOLDER_TOKENS.has(rawSelection.toLowerCase()) ? "" : rawSelection
  const line = PLACEHOLDER_TOKENS.has(rawLine.toLowerCase()) ? "" : rawLine
  const odds = normalizeAmericanOdds(wager.oddsAmerican)

  const parts: string[] = []
  if (selection.length > 0) parts.push(selection)
  if (line.length > 0 && !selectionIncludesLine(selection, line)) {
    parts.push(line)
  }

  const base = parts.length > 0 ? parts.join(" ") : "—"
  if (options.includeOdds === false || odds === null) return base
  if (base === "—") return odds
  if (selectionIncludesOdds(base, odds)) return base
  return `${base} (${odds})`
}
