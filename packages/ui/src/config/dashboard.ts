/**
 * @file packages/ui/src/config/dashboard.ts
 * @description Sole TypeScript entrypoint for `dashboard.toml`.
 *
 * Bun parses and tree-shakes static TOML named exports at bundle time.
 * Never import `churn` here — `scripts/validate_dashboard_config.ts` asserts that
 * unimported top-level tables (`[churn]`) are eliminated from `dist/dashboard/*.js`
 * while active keys (`thresholds.sharp`) are inlined.
 */

import {
  type ApiBaseValidation,
  isLocalDevLocation,
  validateApiBase,
} from "../api_base_validation.ts"
import { type DashboardTabId, resolveDashboardTabId } from "../types.ts"
import { api, freshness, leagues, meta, panels, thresholds } from "./dashboard.toml"

export interface DashboardMeta {
  readonly schema: string
  readonly version: string
  /** ISO-8601 string: unquoted TOML dates parse to Temporal.* and fail validation. */
  readonly generated_at: string
  readonly auto_execute: false
}

export interface DashboardThresholds {
  readonly sharp: number
  readonly elite_sharp_score: number
  readonly sharp_score: number
  readonly steam: number
  readonly clv_alert_bps: number
  readonly conduit_concentration_pct: number
  readonly high_risk_wager_usd: number
}

export interface DashboardLeagues {
  readonly names: readonly string[]
  readonly primary: readonly string[]
  readonly inplay_priority: readonly string[]
}

export interface DashboardApi {
  /** Empty for same-origin; otherwise an origin (`scheme://host[:port]`) without a path. */
  readonly base: string
  readonly dashboard: string
  readonly surveillance_brief: string
  readonly tiers: string
  readonly customers: string
  readonly wagers: string
  readonly bet_ticker: string
  readonly r2_pipeline: string
  readonly dns: string
  readonly surveillance_dns: string
  readonly surveillance_dns_benchmark: string
  readonly surveillance_dns_reverse: string
  readonly health: string
  readonly build_matrix: string
}

export interface DashboardFreshness {
  readonly stale_after_minutes: number
  readonly critical_after_minutes: number
  readonly poll_dashboard_seconds: number
  readonly poll_wagers_seconds: number
  readonly poll_ticker_seconds: number
  readonly poll_dns_seconds: number
}

export interface DashboardPanelsConfig {
  readonly default_tab: string
  readonly customers_page_size: number
  readonly live_wagers_limit: number
  readonly ticker_max_rows: number
  readonly dns_cache_capacity: number
  readonly dns_warm_hit_rate_pct: number
  readonly dns_active_hit_rate_pct: number
}

export const DASHBOARD_META = meta as DashboardMeta
export const DASHBOARD_THRESHOLDS = thresholds as DashboardThresholds
export const DASHBOARD_LEAGUES = leagues as DashboardLeagues
export const DASHBOARD_API = api as DashboardApi
export const DASHBOARD_FRESHNESS = freshness as DashboardFreshness
export const DASHBOARD_PANELS = panels as DashboardPanelsConfig

/** Validated default tab resolved from `dashboard.toml` `[panels].default_tab`. */
export const DASHBOARD_DEFAULT_TAB: DashboardTabId = resolveDashboardTabId(
  DASHBOARD_PANELS.default_tab,
)

const DEFAULT_BASE_ORIGIN = "http://localhost:3000"

export interface DashboardWindowLocationLike {
  readonly location?: {
    readonly origin?: string
    readonly href?: string
    readonly search?: string
  }
}

export interface BunGlobalSnapshot {
  readonly available: boolean
  readonly version: string | null
  readonly revision: string | null
  readonly hasDns: boolean
  readonly hasNanoseconds: boolean
}

/**
 * Safely inspect `globalThis.Bun` globals without breaking Vite browser bundles
 * or Node.js runtimes.
 */
export function readBunGlobals(): BunGlobalSnapshot {
  const candidate = (
    globalThis as unknown as {
      Bun?: {
        readonly version?: unknown
        readonly revision?: unknown
        readonly dns?: unknown
        readonly nanoseconds?: unknown
      }
    }
  ).Bun
  if (!candidate || typeof candidate !== "object") {
    return {
      available: false,
      version: null,
      revision: null,
      hasDns: false,
      hasNanoseconds: false,
    }
  }
  return {
    available: true,
    version: typeof candidate.version === "string" ? candidate.version : null,
    revision: typeof candidate.revision === "string" ? candidate.revision : null,
    hasDns: Boolean(candidate.dns && typeof candidate.dns === "object"),
    hasNanoseconds: typeof candidate.nanoseconds === "function",
  }
}

function defaultWindowLike(): DashboardWindowLocationLike | null {
  const g = globalThis as unknown as {
    window?: DashboardWindowLocationLike
    location?: DashboardWindowLocationLike["location"]
  }
  if (g.window?.location) return g.window
  if (g.location) return { location: g.location }
  return null
}

/**
 * Validates `?apiBase=` against the URLPattern allowlist:
 *   - Production: `https://<sub >.bookdeskops.com[/path]` (excluding denied/punycode labels)
 *   - Local dev: also permits `http://localhost|127.0.0.1|[::1][:port][/path]`
 */
export function inspectApiBaseOverride(
  win: DashboardWindowLocationLike | null = defaultWindowLike(),
  isLocalDev: boolean = isLocalDevLocation(win),
): ApiBaseValidation | null {
  const search = win?.location?.search
  if (typeof search !== "string" || search === "") return null
  const raw = new URLSearchParams(search).get("apiBase")
  if (raw === null) return null
  return validateApiBase(raw, isLocalDev)
}

/**
 * `?apiBase=...` overrides `[api].base` at runtime when validated against trusted
 * `https://<sub >.bookdeskops.com` origins or loopback dev servers (`isLocalDev`).
 * Untrusted or malformed overrides are rejected fail-closed.
 */
export function devApiBaseOverride(
  win: DashboardWindowLocationLike | null = defaultWindowLike(),
  isLocalDev: boolean = isLocalDevLocation(win),
): string | null {
  const result = inspectApiBaseOverride(win, isLocalDev)
  return result?.ok ? result.normalized : null
}

/**
 * Resolve the effective Base URL as a separate `URL` object.
 * Priority: explicit `base` -> `?apiBase=` loopback override -> `DASHBOARD_API.base`
 * -> `Window.location.origin` -> fallback `http://localhost:3000`.
 */
export function resolveDashboardBaseUrl(
  base: string | null = null,
  win: DashboardWindowLocationLike | null = defaultWindowLike(),
): {
  readonly baseUrl: URL
  readonly source: "explicit" | "query-override" | "config" | "window-origin" | "fallback"
} {
  if (base && base.trim() !== "") {
    return { baseUrl: new URL(base.trim()), source: "explicit" }
  }
  const override = devApiBaseOverride(win)
  if (override) {
    return { baseUrl: new URL(override), source: "query-override" }
  }
  if (DASHBOARD_API.base && DASHBOARD_API.base.trim() !== "") {
    return { baseUrl: new URL(DASHBOARD_API.base.trim()), source: "config" }
  }
  const winOrigin = win?.location?.origin
  if (winOrigin && winOrigin !== "null") {
    try {
      return { baseUrl: new URL(winOrigin), source: "window-origin" }
    } catch {
      // fall through
    }
  }
  const winHref = win?.location?.href
  if (winHref) {
    try {
      const parsed = new URL(winHref)
      if (parsed.origin && parsed.origin !== "null") {
        return { baseUrl: new URL(parsed.origin), source: "window-origin" }
      }
    } catch {
      // fall through
    }
  }
  return { baseUrl: new URL(DEFAULT_BASE_ORIGIN), source: "fallback" }
}

/**
 * Construct a separate, immutable-intent `URL` instance for a dashboard API
 * endpoint with typed query parameters (never mutating `window.location`).
 */
export function buildDashboardApiUrlObject(
  path: string,
  searchParams?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  base: string | null = null,
  win: DashboardWindowLocationLike | null = defaultWindowLike(),
): URL {
  const { baseUrl } = resolveDashboardBaseUrl(base, win)
  const basePrefix = baseUrl.pathname.replace(/\/+$/, "")
  const joinedPath =
    basePrefix !== "" && path.startsWith("/") && !path.startsWith(`${basePrefix}/`)
      ? `${basePrefix}${path}`
      : path
  const url = new URL(joinedPath, baseUrl)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value === undefined || value === null) continue
      const text = String(value).trim()
      if (text !== "") {
        url.searchParams.set(key, text)
      }
    }
  }
  return url
}

/**
 * Resolve a feed path against `[api].base` (origin only; `checkSchema` rejects paths).
 * Uses a separate `URL` object internally and returns a relative path+query when
 * operating on same-origin without an explicit/override base, or a full origin
 * URL when an explicit or loopback `?apiBase=` target is configured.
 */
export function dashboardApiUrl(
  path: string,
  base: string | null = null,
  searchParams?: Readonly<Record<string, string | number | boolean | null | undefined>>,
  win: DashboardWindowLocationLike | null = defaultWindowLike(),
): string {
  const resolvedOverride = base ?? devApiBaseOverride(win) ?? DASHBOARD_API.base
  const url = buildDashboardApiUrlObject(path, searchParams, base, win)
  if (!resolvedOverride) {
    return `${url.pathname}${url.search}`
  }
  return url.toString()
}
