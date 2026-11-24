/**
 * Hidden URL parameter extraction, immediate address-bar scrubbing, and bookmark URL generation for
 * temporary operator Fast Sign-In tokens. Security notes:
 *
 * - Reads `?fast_signin=<token>` once on page load and immediately removes the parameter via
 *   `history.replaceState` so the temporary secret does not linger in the address bar, copy-pasted
 *   links, or Referer headers.
 * - Preserves all other dashboard query parameters (`tab`, `wSport`, `agent`, `customer`, `ticket`,
 *   etc.) and hash fragments so saved bookmarks land on the exact operator view.
 *
 * @file Packages/ui/src/fast_signin.ts
 */

import QRCode from "qrcode/lib/browser.js"

export const FAST_SIGNIN_QUERY_PARAM = "fast_signin"

export interface FastSignInWindowLike {
  readonly location: {
    readonly href: string
    readonly pathname: string
    readonly search: string
    readonly hash: string
  }
  readonly history?: {
    replaceState?(data: unknown, unused: string, url: string): void
  }
}

export interface ExtractedFastSignInToken {
  readonly token: string | null
  readonly hadParam: boolean
  readonly scrubbedUrl: string | null
}

export interface QrMatrixSvgSpec {
  readonly size: number
  readonly pathData: string
}

function defaultWindow(): FastSignInWindowLike | null {
  const candidate = (globalThis as unknown as { window?: FastSignInWindowLike }).window
  return candidate ?? null
}

/**
 * Extract the hidden `?fast_signin=<token>` query parameter and immediately scrub it from browser
 * history while preserving all other query params & hash.
 */
export function extractAndScrubFastSignInToken(
  win: FastSignInWindowLike | null = defaultWindow(),
): ExtractedFastSignInToken {
  if (!win || !win.location) {
    return { token: null, hadParam: false, scrubbedUrl: null }
  }

  const rawSearch = win.location.search ?? ""
  const params = new URLSearchParams(rawSearch.startsWith("?") ? rawSearch.slice(1) : rawSearch)
  if (!params.has(FAST_SIGNIN_QUERY_PARAM)) {
    return { token: null, hadParam: false, scrubbedUrl: null }
  }

  const rawVal = params.get(FAST_SIGNIN_QUERY_PARAM)?.trim() ?? ""
  params.delete(FAST_SIGNIN_QUERY_PARAM)
  const nextSearch = params.toString()
  const pathname = win.location.pathname || "/"
  const hash = win.location.hash || ""
  const scrubbedUrl = `${pathname}${nextSearch ? `?${nextSearch}` : ""}${hash}`

  try {
    win.history?.replaceState?.(null, "", scrubbedUrl)
  } catch {
    // Ignore history restrictions in sandboxed environments
  }

  return {
    token: rawVal.length > 0 ? rawVal : null,
    hadParam: true,
    scrubbedUrl,
  }
}

/** Documented RFC 2606 non-routable, non-mDNS parser base (never fetched). */
const NON_FETCHING_PARSE_BASE = "https://non-fetching.invalid"

/**
 * Build a bookmarkable dashboard URL embedding the temporary `?fast_signin=` token while preserving
 * the current origin, route, safe query params, and hash.
 */
export function buildFastSignInBookmarkUrl(currentHref: string, token: string): string {
  const cleanToken = token.trim()
  const url = new URL(currentHref, NON_FETCHING_PARSE_BASE)
  if (cleanToken.length > 0) {
    url.searchParams.set(FAST_SIGNIN_QUERY_PARAM, cleanToken)
  } else {
    url.searchParams.delete(FAST_SIGNIN_QUERY_PARAM)
  }
  return url.toString()
}

function looksLikeUrlOrQuery(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("/") || value.startsWith("?")
}

/**
 * Extract the `fast_signin` token from either a full/relative bookmark URL or a raw token string.
 * Returns null when empty or when a URL omits `fast_signin`.
 */
export function extractFastSignInTokenFromInput(rawInput: string): string | null {
  const trimmed = rawInput.trim()
  if (!trimmed) return null
  if (looksLikeUrlOrQuery(trimmed)) {
    try {
      const parsed = new URL(trimmed, NON_FETCHING_PARSE_BASE)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null
      }
      const token = parsed.searchParams.get(FAST_SIGNIN_QUERY_PARAM)?.trim() ?? ""
      return token.length > 0 ? token : null
    } catch {
      return null
    }
  }
  return trimmed
}

/**
 * Resolve either a pasted Fast Sign-In bookmark URL or a raw token into a canonical Fast Sign-In
 * bookmark URL bound to the current view when needed.
 */
export function resolveFastSignInBookmarkUrl(currentHref: string, rawInput: string): string | null {
  const trimmed = rawInput.trim()
  if (!trimmed) return null

  if (looksLikeUrlOrQuery(trimmed)) {
    try {
      const parsed = new URL(trimmed, currentHref || NON_FETCHING_PARSE_BASE)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null
      }
      const token = parsed.searchParams.get(FAST_SIGNIN_QUERY_PARAM)?.trim() ?? ""
      if (!token) return null
      return parsed.toString()
    } catch {
      return null
    }
  }

  return buildFastSignInBookmarkUrl(currentHref, trimmed)
}

/**
 * Encode arbitrary text (such as a Fast Sign-In bookmark URL) into a crisp run-length SVG path QR
 * matrix completely client-side without external calls.
 */
export function buildFastSignInQrMatrix(text: string): QrMatrixSvgSpec | null {
  const value = text.trim()
  if (!value) return null

  try {
    const qr = QRCode.create(value, { errorCorrectionLevel: "M" })
    const size = qr.modules.size
    const data = qr.modules.data
    const segments: string[] = []

    for (let row = 0; row < size; row += 1) {
      const rowOffset = row * size
      let col = 0
      while (col < size) {
        if (!data[rowOffset + col]) {
          col += 1
          continue
        }
        const start = col
        while (col < size && data[rowOffset + col]) {
          col += 1
        }
        segments.push(`M${start},${row}h${col - start}v1h-${col - start}z`)
      }
    }

    return {
      size,
      pathData: segments.join(""),
    }
  } catch {
    return null
  }
}
