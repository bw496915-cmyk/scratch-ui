/**
 * @file packages/api/src/egress_config.ts
 * @description Boot-time validated origin constants for Lanes D, E, F, and G.
 *
 * Every env-controlled origin is parsed and validated once at module / server
 * startup rather than per request, failing fast with an explicit Error on bad
 * URLs, unsupported schemes, embedded credentials, queries, or hash fragments.
 *
 * Invariant: signed R2 S3 requests (`R2_S3_ENDPOINT` / `R2_ENDPOINT`) stay on
 * a dedicated policy and origin constant — never shared with the read-only
 * public fallback bucket (`R2_PUBLIC_ORIGIN`).
 */

export const DEFAULT_API_ORIGIN = "http://127.0.0.1:4020" as const
export const DEFAULT_SERVE_LOCAL_ORIGIN = "http://127.0.0.1:8787" as const
export const DEFAULT_R2_PUBLIC_ORIGIN =
  "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev" as const
export const FANTASY402_ORIGIN = "https://fantasy402.com" as const
export const POLYMARKET_DATA_API_ORIGIN = "https://data-api.polymarket.com" as const
export const POLYMARKET_PROFILE_ORIGIN = "https://polymarket.com" as const
export const POLYGONSCAN_ORIGIN = "https://polygonscan.com" as const

function canParseUrl(raw: string): boolean {
  if (typeof URL.canParse === "function") {
    return URL.canParse(raw)
  }
  try {
    new URL(raw)
    return true
  } catch {
    return false
  }
}

/**
 * Validate an env-controlled origin at startup. Throws immediately on malformed
 * URLs, non-HTTP(S) protocols, embedded credentials, query strings, hashes, or
 * backslashes.
 */
export function validatedOrigin(
  name: string,
  fallback: string,
  env: Record<string, string | undefined> = process.env,
): URL {
  const candidate = env[name]?.trim()
  const raw = candidate && candidate.length > 0 ? candidate : fallback
  if (raw.includes("\\") || !canParseUrl(raw)) {
    throw new Error(`${name} is not a valid URL: ${raw}`)
  }
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name}: bad protocol ${url.protocol}`)
  }
  if (url.username || url.password) {
    throw new Error(`${name}: embedded credentials are forbidden`)
  }
  if (url.search || url.hash) {
    throw new Error(`${name}: query string and hash fragment are forbidden`)
  }
  return url
}

/**
 * Validate an optional env-controlled origin (returns `null` when unset/blank,
 * throws immediately when configured with an invalid URL).
 */
export function validatedOptionalOrigin(
  name: string,
  env: Record<string, string | undefined> = process.env,
): URL | null {
  const candidate = env[name]?.trim()
  if (!candidate) return null
  return validatedOrigin(name, candidate, { [name]: candidate })
}

export interface ValidatedEgressOrigins {
  /** Lane E — Companion SportsDesk daemon (:4020). */
  readonly API_ORIGIN: URL
  /** Lane E — Local BookDeskOps serve-local origin (:8787). */
  readonly SERVE_LOCAL: URL
  /** Lane F — Signed R2 S3 endpoint (`R2_S3_ENDPOINT` or `R2_ENDPOINT`), null if unconfigured. */
  readonly R2_S3_ORIGIN: URL | null
  /** Lane G — Read-only public R2 fallback origin (never used with credentials). */
  readonly R2_PUBLIC_ORIGIN: URL
  /** Lane F — Fixed Fantasy402 origin (never interpolated from user input). */
  readonly FANTASY402: URL
  /** Lane F — Fixed Polymarket positions data API origin. */
  readonly POLYMARKET_DATA_API: URL
  /** Lane F — Fixed Polygonscan origin. */
  readonly POLYGONSCAN: URL
}

/**
 * Validate and freeze all egress origins once at server startup.
 */
export function loadValidatedEgressOrigins(
  env: Record<string, string | undefined> = process.env,
): ValidatedEgressOrigins {
  const r2S3RawName = env.R2_S3_ENDPOINT?.trim() ? "R2_S3_ENDPOINT" : "R2_ENDPOINT"
  return Object.freeze({
    API_ORIGIN: validatedOrigin("SPORTSDESK_API_ORIGIN", DEFAULT_API_ORIGIN, env),
    SERVE_LOCAL: validatedOrigin("BOOKDESKOPS_SERVE_LOCAL", DEFAULT_SERVE_LOCAL_ORIGIN, env),
    R2_S3_ORIGIN: validatedOptionalOrigin(r2S3RawName, env),
    R2_PUBLIC_ORIGIN: validatedOrigin("R2_PUBLIC_URL", DEFAULT_R2_PUBLIC_ORIGIN, env),
    FANTASY402: new URL(FANTASY402_ORIGIN),
    POLYMARKET_DATA_API: new URL(POLYMARKET_DATA_API_ORIGIN),
    POLYGONSCAN: new URL(POLYGONSCAN_ORIGIN),
  })
}

/**
 * Lane D helper: derive `ws://` or `wss://` automatically from an HTTP(S) base URL
 * (`server.url` or `window.location.href`) so TLS deployments never emit mixed-content `ws://`.
 */
export function deriveWebSocketUrl(
  baseHref: string | URL,
  wsPath = "/ws",
  query?: Record<string, string | undefined>,
): string {
  const base = baseHref instanceof URL ? baseHref : new URL(baseHref)
  const resolved = new URL(wsPath, base)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") {
        resolved.searchParams.set(k, v)
      }
    }
  }
  return resolved.href.replace(/^http/i, "ws")
}
