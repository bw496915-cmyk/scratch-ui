/**
 * Reusable Origin allowlist + session-bound `x-csrf-token` guard for cookie-authenticated POST
 * routes (e.g., `/api/profile/theme`).
 *
 * @file Src/http/csrf_origin_guard.ts
 */

const NO_STORE = { "Cache-Control": "no-store", Vary: "Cookie" } as const

export interface CsrfOriginGuardConfig {
  /** Allowed browser `Origin` strings (e.g. `https://desk.bookdeskops.com`). */
  readonly allowedOrigins: ReadonlySet<string> | readonly string[]
  /** Verify the submitted CSRF token against the authenticated session. */
  readonly verifyCsrfToken: (sessionId: string, token: string) => boolean
  /** When true, also accept the request URL's origin for direct preview URLs. */
  readonly allowSameOrigin?: boolean | undefined
}

export type CsrfGuardResult =
  { readonly ok: true } | { readonly ok: false; readonly response: Response }

function normalizeOrigin(raw: string): string | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null
    }
    return parsed.origin
  } catch {
    return null
  }
}

function isOriginAllowed(
  req: Request,
  originHeader: string,
  config: CsrfOriginGuardConfig,
): boolean {
  const normalized = normalizeOrigin(originHeader)
  if (!normalized) return false

  const allowedSet =
    config.allowedOrigins instanceof Set ? config.allowedOrigins : new Set(config.allowedOrigins)
  if (allowedSet.has(normalized)) return true

  return config.allowSameOrigin === true && normalized === new URL(req.url).origin
}

export function verifyPostOriginAndCsrf(
  req: Request,
  sessionId: string,
  config: CsrfOriginGuardConfig,
): CsrfGuardResult {
  const origin = req.headers.get("origin")?.trim() ?? ""
  if (!origin || !isOriginAllowed(req, origin, config)) {
    return {
      ok: false,
      response: Response.json({ error: "ERR_CSRF_ORIGIN" }, { status: 403, headers: NO_STORE }),
    }
  }

  const providedToken = req.headers.get("x-csrf-token")?.trim() ?? ""
  if (!providedToken || !config.verifyCsrfToken(sessionId, providedToken)) {
    return {
      ok: false,
      response: Response.json({ error: "ERR_CSRF_TOKEN" }, { status: 403, headers: NO_STORE }),
    }
  }

  return { ok: true }
}
