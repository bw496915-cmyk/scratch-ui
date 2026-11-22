/**
 * @file packages/api/src/bun_routes.ts
 * @description Canonical route constants, `ExtractRouteParams` / `TypedRouteRequest`
 * helpers matching Bun's native `BunRequest<TPath>`, safe single-pass URL param
 * decoding, and typed `buildApiUrl` builders.
 */

/**
 * Canonical route path registry (`as const`) shared across Bun's radix-tree
 * `routes` map, typed request handlers, and URL builders.
 */
export const DASHBOARD_ROUTES = {
  root: "/",
  health: "/health",
  apiHealth: "/api/health",
  authLogin: "/api/auth/login",
  authLogout: "/api/auth/logout",
  authMe: "/api/auth/me",
  alerts: "/api/alerts",
  alertsSweep: "/api/alerts/sweep",
  alertAck: "/api/alerts/:id/ack",
  alertRetry: "/api/alerts/:id/retry",
  agentById: "/api/agent/:id",
  agentsById: "/api/agents/:id",
  shiftSummary: "/api/shift/summary",
  shiftLogs: "/api/shift/logs",
  configStatus: "/api/config/status",
  rankings: "/api/rankings",
  customers: "/api/customers",
  liveWagers: "/api/live-wagers",
  apiWildcard: "/api/*",
} as const

export type DashboardRouteKey = keyof typeof DASHBOARD_ROUTES
export type DashboardRoutePath = (typeof DASHBOARD_ROUTES)[DashboardRouteKey]

/**
 * Compile-time route parameter extractor matching Bun's `ExtractRouteParams<TPath>`.
 *
 * Examples:
 * - `ExtractRouteParams<"/api/agents/:id">` -> `{ readonly id: string }`
 * - `ExtractRouteParams<"/api/alerts/:id/ack">` -> `{ readonly id: string }`
 * - `ExtractRouteParams<"/api/shift/logs">` -> `Record<never, never>`
 */
export type ExtractRouteParams<TPath extends string> =
  TPath extends `${string}:${infer Param}/${infer Rest}`
    ? { readonly [K in Param]: string } & ExtractRouteParams<`/${Rest}`>
    : TPath extends `${string}:${infer Param}`
      ? { readonly [K in Param]: string }
      : Record<never, never>

/**
 * Typed Request carrying zero-copy radix-tree `params` extracted from `TPath`.
 * Structurally compatible with Bun's native `BunRequest<TPath>`.
 */
export type TypedRouteRequest<TPath extends string> = Request & {
  readonly params: ExtractRouteParams<TPath>
}

export type DecodedRouteParamResult =
  { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string }

/**
 * Single-pass URL segment decoder for `req.params.*`.
 *
 * Bun's radix-tree router slices `req.params` directly from the raw URL segment
 * without auto-decoding. Handlers should decode exactly once at the boundary and
 * reject malformed percent sequences or control characters with HTTP 400.
 */
export function safeDecodeRouteParam(
  raw: string,
  options: { readonly maxLength?: number | undefined } = {},
): DecodedRouteParamResult {
  const maxLength = options.maxLength ?? 128
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return {
      ok: false,
      error: "Malformed URL-encoded route parameter",
    }
  }

  if (decoded.trim().length === 0) {
    return {
      ok: false,
      error: "Route parameter cannot be empty",
    }
  }

  if (/[\u0000-\u001f\u007f]/.test(decoded)) {
    return {
      ok: false,
      error: "Route parameter contains invalid control characters",
    }
  }

  if (decoded.length > maxLength) {
    return {
      ok: false,
      error: `Route parameter exceeds maximum length (${maxLength})`,
    }
  }

  return { ok: true, value: decoded }
}

/**
 * Extract the raw (undecoded) URL path segment for a matched route pattern,
 * falling back to `fallbackParam` when `req.url` does not match.
 *
 * Guarantees identical single-pass `decodeURIComponent` behavior and strict
 * rejection of malformed percent-encoding across both Bun versions that
 * auto-decode `req.params` and versions that pass zero-copy raw slices.
 */
export function extractRawRouteParam(
  req: Request,
  pattern: RegExp,
  fallbackParam: string,
  groupIndex = 1,
): string {
  try {
    const pathname = new URL(req.url).pathname
    const match = pattern.exec(pathname)
    if (match && typeof match[groupIndex] === "string") {
      return match[groupIndex]
    }
  } catch {
    // Fallback to req.params if req.url is non-standard
  }
  return fallbackParam
}

export type ApiQueryValue = string | number | boolean | null | undefined

/**
 * Build a normalized API URL from a `string | URL` base (such as `server.url`),
 * substituting `:param` placeholders with `encodeURIComponent` and appending
 * optional query parameters.
 */
export function buildApiUrl<TPath extends string>(
  baseUrl: string | URL,
  route: TPath,
  params?: Partial<Record<keyof ExtractRouteParams<TPath>, string | number>>,
  query?: Record<string, ApiQueryValue>,
): string {
  const base = String(baseUrl).replace(/\/+$/, "")
  const resolvedPath = route.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const rawValue = (params as Record<string, string | number | undefined> | undefined)?.[key]
    if (rawValue === undefined || rawValue === null) {
      throw new Error(`Missing required route parameter "${key}" for "${route}"`)
    }
    return encodeURIComponent(String(rawValue))
  })

  const normalizedPath = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`

  if (!query) {
    return `${base}${normalizedPath}`
  }

  const searchParams = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    searchParams.set(k, String(v))
  }
  const qs = searchParams.toString()
  return qs ? `${base}${normalizedPath}?${qs}` : `${base}${normalizedPath}`
}

export function buildAgentDetailUrl(
  baseUrl: string | URL,
  agentId: string | number,
  plural = false,
): string {
  return buildApiUrl(baseUrl, plural ? DASHBOARD_ROUTES.agentsById : DASHBOARD_ROUTES.agentById, {
    id: agentId,
  })
}

export function buildAlertAckUrl(baseUrl: string | URL, deliveryId: string | number): string {
  return buildApiUrl(baseUrl, DASHBOARD_ROUTES.alertAck, { id: deliveryId })
}

export function buildAlertRetryUrl(baseUrl: string | URL, deliveryId: string | number): string {
  return buildApiUrl(baseUrl, DASHBOARD_ROUTES.alertRetry, { id: deliveryId })
}

export function buildShiftLogsUrl(
  baseUrl: string | URL,
  query?: {
    readonly since?: number | string | undefined
    readonly operatorId?: string | undefined
    readonly action?: string | undefined
    readonly limit?: number | undefined
  },
): string {
  return buildApiUrl(baseUrl, DASHBOARD_ROUTES.shiftLogs, undefined, query)
}

export function buildConfigStatusUrl(baseUrl: string | URL): string {
  return buildApiUrl(baseUrl, DASHBOARD_ROUTES.configStatus)
}
