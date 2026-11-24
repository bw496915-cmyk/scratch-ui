/**
 * Lane C destructive-endpoint CSRF guard bound to `sessionId` via native `Bun.CSRF` (`expiresIn` +
 * `maxAge`) with a Node.js HMAC-SHA256 fallback. Security invariants:
 *
 * - Always binds tokens to an explicit `sessionId` on both `generate` and `verify` so tokens never
 *   validate across different user sessions.
 * - Enforces an explicit `maxAge` (default 15 minutes) at verification time independently of
 *   token-embedded expiry.
 * - Requires a stable `CSRF_SECRET` at boot when `requireCsrfSecret()` or `createCsrfGuard()` is
 *   constructed with strict secret validation.
 *
 * @file Packages/api/src/csrf_guard.ts
 */

import { createHmac, timingSafeEqual } from "node:crypto"

export const DEFAULT_CSRF_MAX_AGE_MS = 15 * 60_000
export const DEFAULT_CSRF_HEADER = "x-csrf-token"
export const DEFAULT_SESSION_COOKIES = ["sd_session", "session"] as const

const NODE_FALLBACK_PREFIX = "sdcsrf1."

interface BunCsrfRuntime {
  readonly generate: (
    secret: string,
    options: { readonly sessionId: string; readonly expiresIn?: number },
  ) => string
  readonly verify: (
    token: string,
    options: { readonly secret: string; readonly sessionId: string; readonly maxAge?: number },
  ) => boolean
}

export interface CookieMapLike {
  get(name: string): string | null | undefined
}

export type CsrfRequestLike = Request & {
  readonly cookies?: CookieMapLike | undefined
}

export interface CsrfGuardOptions {
  readonly secret: string
  readonly maxAgeMs?: number | undefined
  readonly headerName?: string | undefined
  readonly sessionCookieNames?: readonly string[] | undefined
  /**
   * Optional custom session extractor (for example, resolving a session ID from `httpAuth` or
   * `BunRequest.cookies`). Falls back to `req.cookies` then the raw `Cookie` header.
   */
  readonly resolveSessionId?: ((req: CsrfRequestLike) => string | null) | undefined
}

function getBunCsrf(): BunCsrfRuntime | undefined {
  const csrf = (globalThis as unknown as { Bun?: { CSRF?: Partial<BunCsrfRuntime> } }).Bun?.CSRF
  if (csrf && typeof csrf.generate === "function" && typeof csrf.verify === "function") {
    return csrf as BunCsrfRuntime
  }
  return undefined
}

/**
 * Require a non-empty `CSRF_SECRET` from the supplied environment map at boot. Fails closed by
 * throwing so multi-worker deployments never fall back to an ephemeral per-thread random key
 * silently.
 */
export function requireCsrfSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.CSRF_SECRET?.trim()
  if (!secret) {
    throw new Error("CSRF_SECRET required")
  }
  return secret
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const out = new Map<string, string>()
  if (!header) return out
  for (const part of header.split(";")) {
    const idx = part.indexOf("=")
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (key && !out.has(key)) {
      try {
        out.set(key, decodeURIComponent(val))
      } catch {
        out.set(key, val)
      }
    }
  }
  return out
}

function extractSessionIdFromRequest(
  req: CsrfRequestLike,
  cookieNames: readonly string[],
): string | null {
  if (req.cookies && typeof req.cookies.get === "function") {
    for (const name of cookieNames) {
      const val = req.cookies.get(name)?.trim()
      if (val) return val
    }
  }
  const parsed = parseCookieHeader(req.headers.get("cookie"))
  for (const name of cookieNames) {
    const val = parsed.get(name)?.trim()
    if (val) return val
  }
  return null
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8")
  const bBuf = Buffer.from(b, "utf8")
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

function generateNodeFallbackToken(
  secret: string,
  sessionId: string,
  expiresInMs: number,
  nowMs = Date.now(),
): string {
  const issuedAt = Math.floor(nowMs)
  const expiresAt = issuedAt + Math.max(1_000, Math.floor(expiresInMs))
  const payload = `${issuedAt}.${expiresAt}`
  const sig = createHmac("sha256", secret)
    .update(`${sessionId}\u0000${payload}`)
    .digest("base64url")
  return `${NODE_FALLBACK_PREFIX}${payload}.${sig}`
}

function verifyNodeFallbackToken(
  token: string,
  secret: string,
  sessionId: string,
  maxAgeMs: number,
  nowMs = Date.now(),
): boolean {
  if (!token.startsWith(NODE_FALLBACK_PREFIX)) return false
  const body = token.slice(NODE_FALLBACK_PREFIX.length)
  const parts = body.split(".")
  if (parts.length !== 3) return false
  const [issuedRaw, expiresRaw, sig] = parts as [string, string, string]
  const issuedAt = Number(issuedRaw)
  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return false
  if (nowMs > expiresAt) return false
  if (nowMs - issuedAt > maxAgeMs) return false
  const expected = createHmac("sha256", secret)
    .update(`${sessionId}\u0000${issuedRaw}.${expiresRaw}`)
    .digest("base64url")
  return constantTimeStringEqual(sig, expected)
}

/**
 * Issue a session-bound CSRF token via native `Bun.CSRF.generate(secret, { sessionId, expiresIn })`
 * (or HMAC-SHA256 fallback under Node.js).
 */
export function issueCsrf(
  sessionId: string,
  options: {
    readonly secret: string
    readonly expiresInMs?: number | undefined
  },
): string {
  const secret = options.secret.trim()
  if (!secret) throw new Error("CSRF_SECRET required")
  const sid = sessionId.trim()
  if (!sid) throw new Error("sessionId required for CSRF token generation")

  const expiresInMs = options.expiresInMs ?? DEFAULT_CSRF_MAX_AGE_MS
  const bunCsrf = getBunCsrf()
  if (bunCsrf) {
    return bunCsrf.generate(secret, { sessionId: sid, expiresIn: expiresInMs })
  }
  return generateNodeFallbackToken(secret, sid, expiresInMs)
}

/**
 * Verify a session-bound CSRF token via native `Bun.CSRF.verify(token, { secret, sessionId, maxAge
 * })` (or HMAC-SHA256 fallback under Node.js).
 */
export function verifyCsrfToken(
  token: string,
  sessionId: string,
  options: {
    readonly secret: string
    readonly maxAgeMs?: number | undefined
  },
): boolean {
  const secret = options.secret.trim()
  const sid = sessionId.trim()
  const rawToken = token.trim()
  if (!secret || !sid || !rawToken) return false

  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CSRF_MAX_AGE_MS

  if (rawToken.startsWith(NODE_FALLBACK_PREFIX)) {
    return verifyNodeFallbackToken(rawToken, secret, sid, maxAgeMs)
  }

  const bunCsrf = getBunCsrf()
  if (bunCsrf) {
    try {
      return bunCsrf.verify(rawToken, {
        secret,
        sessionId: sid,
        maxAge: maxAgeMs,
      })
    } catch {
      return false
    }
  }
  return false
}

function forbiddenCsrfResponse(reason: string): Response {
  return Response.json(
    {
      error: "Forbidden: invalid or missing CSRF token",
      code: "CSRF_INVALID",
      reason,
    },
    {
      status: 403,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

/**
 * Wrap a Lane C destructive route handler with `Bun.CSRF` verification bound to the caller's
 * session cookie (`BunRequest.cookies` or `Cookie` header).
 */
export function withCsrf<TReq extends CsrfRequestLike, TRest extends readonly unknown[]>(
  handler: (req: TReq, ...rest: TRest) => Response | Promise<Response>,
  options: CsrfGuardOptions,
): (req: TReq, ...rest: TRest) => Promise<Response> {
  const secret = options.secret.trim()
  if (!secret) {
    throw new Error("CSRF_SECRET required")
  }
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CSRF_MAX_AGE_MS
  const headerName = (options.headerName ?? DEFAULT_CSRF_HEADER).toLowerCase()
  const cookieNames = options.sessionCookieNames ?? DEFAULT_SESSION_COOKIES

  return async (req: TReq, ...rest: TRest): Promise<Response> => {
    const sessionId = options.resolveSessionId
      ? options.resolveSessionId(req)
      : extractSessionIdFromRequest(req, cookieNames)
    const token = req.headers.get(headerName)?.trim() ?? ""

    if (!sessionId || !token) {
      return forbiddenCsrfResponse("missing_session_or_token")
    }

    const ok = verifyCsrfToken(token, sessionId, { secret, maxAgeMs })
    if (!ok) {
      return forbiddenCsrfResponse("verification_failed")
    }

    return handler(req, ...rest)
  }
}

/**
 * Factory creating a reusable CSRF issuer/verifier/middleware bound to one boot-validated
 * `CSRF_SECRET`.
 */
export function createCsrfGuard(options: CsrfGuardOptions) {
  const secret = options.secret.trim()
  if (!secret) {
    throw new Error("CSRF_SECRET required")
  }
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CSRF_MAX_AGE_MS

  return {
    issueCsrf: (sessionId: string, expiresInMs = maxAgeMs): string =>
      issueCsrf(sessionId, { secret, expiresInMs }),
    verifyCsrf: (token: string, sessionId: string, overrideMaxAgeMs = maxAgeMs): boolean =>
      verifyCsrfToken(token, sessionId, { secret, maxAgeMs: overrideMaxAgeMs }),
    withCsrf: <TReq extends CsrfRequestLike, TRest extends readonly unknown[]>(
      handler: (req: TReq, ...rest: TRest) => Response | Promise<Response>,
    ) => withCsrf(handler, { ...options, secret, maxAgeMs }),
  }
}
