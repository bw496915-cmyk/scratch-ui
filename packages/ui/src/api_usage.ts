/**
 * Session-scoped API usage & header-alignment meter for the dashboard. Every dashboard request goes
 * through `trackedFetch`, which injects aligned request headers (`Accept`, `X-SportsDesk-Client`,
 * `X-SportsDesk-Tab`, `X-Request-Id`), records normalized endpoint metrics, and captures response
 * header alignment telemetry (`Cache-Control`, `X-SportsDesk-Endpoint`, `X-Runtime-Engine`,
 * `X-Response-Time-Ms`).
 *
 * @file Packages/ui/src/api_usage.ts
 */

import { useSyncExternalStore } from "react"

import { type DashboardWindowLocationLike, resolveDashboardBaseUrl } from "./config/dashboard.ts"

export type ApiBaseUrlSource =
  "explicit" | "query-override" | "config" | "window-origin" | "fallback"

export interface ApiBaseUrlProperties {
  readonly href: string
  readonly origin: string
  readonly protocol: string
  readonly host: string
  readonly hostname: string
  readonly port: string
  readonly effectivePort: string
  readonly pathname: string
  readonly source: ApiBaseUrlSource
  readonly sameOrigin: boolean
  readonly secure: boolean
}

export interface ApiHeaderTelemetry {
  readonly requestId: string | null
  readonly endpointHeader: string | null
  readonly tabHeader: string | null
  readonly cacheControl: string | null
  readonly runtimeEngine: string | null
  readonly responseTimeMs: string | null
  readonly contentType: string | null
  readonly aligned: boolean
}

export interface ApiUsageRow {
  readonly key: string
  readonly method: string
  readonly normalizedPath: string
  readonly baseUrl: ApiBaseUrlProperties
  readonly calls: number
  readonly ok: number
  readonly failed: number
  readonly pending: number
  readonly coalesced: number
  readonly avgMs: number | null
  readonly minMs: number | null
  readonly maxMs: number | null
  readonly lastMs: number | null
  readonly lastStatus: number | null
  readonly lastAtMs: number | null
  readonly lastHeaders: ApiHeaderTelemetry | null
}

export interface ApiUsageSnapshot {
  readonly baseUrl: ApiBaseUrlProperties
  readonly origins: readonly string[]
  readonly rows: readonly ApiUsageRow[]
  readonly calls: number
  readonly ok: number
  readonly failed: number
  readonly pending: number
  readonly coalesced: number
  readonly avgMs: number | null
  readonly alignedResponses: number
}

interface MutableRow {
  method: string
  normalizedPath: string
  baseUrl: ApiBaseUrlProperties
  calls: number
  ok: number
  failed: number
  pending: number
  coalesced: number
  completed: number
  totalMs: number
  minMs: number | null
  maxMs: number | null
  lastMs: number | null
  lastStatus: number | null
  lastAtMs: number | null
  lastHeaders: ApiHeaderTelemetry | null
}

/** Same shapes `fetch` accepts, without relying on the DOM-only `RequestInfo` alias. */
export type ApiUsageInput = string | URL | Request

export interface ApiCallToken {
  readonly key: string
  readonly startedAtMs: number
  readonly coalesced: boolean
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === "https:" || protocol === "wss:") return "443"
  if (protocol === "http:" || protocol === "ws:") return "80"
  return ""
}

function resolveWindowOrigin(win?: DashboardWindowLocationLike | null): string | null {
  if (win?.location?.origin && win.location.origin !== "null") {
    return win.location.origin
  }
  const g = globalThis as unknown as {
    window?: { location?: { origin?: string } }
    location?: { origin?: string }
  }
  const winOrigin = g.window?.location?.origin ?? g.location?.origin
  if (winOrigin && winOrigin !== "null") return winOrigin
  return null
}

function resolveBaseOrigin(): string {
  return resolveWindowOrigin() ?? resolveDashboardBaseUrl().baseUrl.origin
}

/**
 * Extract structured `URL` base properties (origin, protocol, host, hostname, port, effectivePort,
 * pathname, href, source, sameOrigin, secure) without exposing query values, customer IDs, or
 * credentials.
 */
export function extractBaseUrlProperties(
  input?: ApiUsageInput | null,
  win?: DashboardWindowLocationLike | null,
): ApiBaseUrlProperties {
  const { baseUrl, source } = resolveDashboardBaseUrl(null, win)
  const windowOrigin = resolveWindowOrigin(win) ?? baseUrl.origin

  let resolved = new URL(baseUrl.origin)
  let effectiveSource: ApiBaseUrlSource = source

  if (input !== undefined && input !== null) {
    let rawUrl: string
    if (typeof input === "string") {
      rawUrl = input
    } else if (input instanceof URL) {
      rawUrl = input.href
    } else {
      rawUrl = input.url
    }
    try {
      const parsed = new URL(rawUrl, baseUrl)
      resolved = new URL(parsed.origin)
      if (parsed.origin !== baseUrl.origin) {
        effectiveSource = "explicit"
      }
    } catch {
      // Keep resolved baseUrl fallback for malformed inputs.
    }
  }

  const effectivePort = resolved.port || defaultPortForProtocol(resolved.protocol)
  return {
    href: resolved.href,
    origin: resolved.origin,
    protocol: resolved.protocol,
    host: resolved.host,
    hostname: resolved.hostname,
    port: resolved.port,
    effectivePort,
    pathname: resolved.pathname || "/",
    source: effectiveSource,
    sameOrigin: resolved.origin === windowOrigin,
    secure: resolved.protocol === "https:",
  }
}

const rows = new Map<string, MutableRow>()
const listeners = new Set<() => void>()
let version = 0
let cachedVersion = -1
let cachedSnapshot: ApiUsageSnapshot | null = null

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOGIN_RE = /^[A-Z]{2,10}\d{2,}$/i
const LONG_ID_RE = /^[A-Za-z0-9_-]{20,}$/

function resolveWindowTabHeader(): string {
  try {
    const g = globalThis as unknown as {
      window?: { location?: { href?: string } }
      location?: { href?: string }
    }
    const href = g.window?.location?.href ?? g.location?.href
    if (!href) return "dashboard"
    const url = new URL(href, resolveBaseOrigin())
    const tab = url.searchParams.get("tab")?.trim()
    if (tab) return tab
    const segment = url.pathname.split("/").filter(Boolean).pop()
    return segment || "customers"
  } catch {
    return "dashboard"
  }
}

/** Collapse a path segment that is an id, login or opaque token. */
function normalizeSegment(segment: string): string {
  if (segment === "") return segment
  if (/^\d+$/.test(segment)) return ":id"
  if (UUID_RE.test(segment)) return ":id"
  if (LOGIN_RE.test(segment)) return ":id"
  if (LONG_ID_RE.test(segment)) return ":id"
  return segment
}

/** `GET /api/agent/:id` — query strings and identifiers are intentionally omitted. */
export function apiUsageKey(input: ApiUsageInput, method?: string | null): string {
  let rawUrl: string
  let requestMethod = method ?? "GET"
  if (typeof input === "string") {
    rawUrl = input
  } else if (input instanceof URL) {
    rawUrl = input.href
  } else {
    rawUrl = input.url
    requestMethod = method ?? input.method ?? "GET"
  }

  let pathname = rawUrl
  try {
    pathname = new URL(rawUrl, resolveBaseOrigin()).pathname
  } catch {
    // Keep the raw value; a malformed URL is still useful as a usage key.
  }
  const normalized = pathname.split("/").map(normalizeSegment).join("/").replace(/\/+$/, "")
  return `${requestMethod.toUpperCase()} ${normalized === "" ? "/" : normalized}`
}

function splitUsageKey(key: string): { method: string; normalizedPath: string } {
  const spaceIdx = key.indexOf(" ")
  if (spaceIdx <= 0) {
    return { method: "GET", normalizedPath: key || "/" }
  }
  return {
    method: key.slice(0, spaceIdx).toUpperCase(),
    normalizedPath: key.slice(spaceIdx + 1) || "/",
  }
}

export function extractResponseHeaderTelemetry(
  headers: Headers | null | undefined,
): ApiHeaderTelemetry | null {
  if (!headers || typeof headers.get !== "function") return null
  const requestId = headers.get("x-request-id")?.trim() || null
  const endpointHeader = headers.get("x-sportsdesk-endpoint")?.trim() || null
  const tabHeader = headers.get("x-sportsdesk-tab")?.trim() || null
  const cacheControl = headers.get("cache-control")?.trim() || null
  const runtimeEngine = headers.get("x-runtime-engine")?.trim() || null
  const responseTimeMs = headers.get("x-response-time-ms")?.trim() || null
  const contentType = headers.get("content-type")?.trim() || null
  const aligned = Boolean(
    cacheControl?.toLowerCase().includes("no-store") &&
    (endpointHeader !== null || requestId !== null),
  )
  return {
    requestId,
    endpointHeader,
    tabHeader,
    cacheControl,
    runtimeEngine,
    responseTimeMs,
    contentType,
    aligned,
  }
}

function mutableRow(key: string, baseUrl?: ApiBaseUrlProperties | null): MutableRow {
  let row = rows.get(key)
  if (row === undefined) {
    const parsed = splitUsageKey(key)
    row = {
      method: parsed.method,
      normalizedPath: parsed.normalizedPath,
      baseUrl: baseUrl ?? extractBaseUrlProperties(),
      calls: 0,
      ok: 0,
      failed: 0,
      pending: 0,
      coalesced: 0,
      completed: 0,
      totalMs: 0,
      minMs: null,
      maxMs: null,
      lastMs: null,
      lastStatus: null,
      lastAtMs: null,
      lastHeaders: null,
    }
    rows.set(key, row)
  } else if (baseUrl) {
    row.baseUrl = baseUrl
  }
  return row
}

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

/** Begin one API call; pair with {@link endApiCall}. Exported for tests. */
export function beginApiCall(
  key: string,
  coalesced = false,
  baseUrl?: ApiBaseUrlProperties | null,
): ApiCallToken {
  const row = mutableRow(key, baseUrl)
  row.calls += 1
  row.pending += 1
  if (coalesced) row.coalesced += 1
  notify()
  return { key, startedAtMs: performance.now(), coalesced }
}

/** Finish one API call; `status === null` records a transport failure. */
export function endApiCall(
  token: ApiCallToken,
  status: number | null,
  headers?: Headers | null,
): void {
  const row = mutableRow(token.key)
  const elapsed = Math.max(0, performance.now() - token.startedAtMs)
  const roundedMs = Math.round(elapsed)
  row.pending = Math.max(0, row.pending - 1)
  row.completed += 1
  row.totalMs += elapsed
  row.minMs = row.minMs === null ? roundedMs : Math.min(row.minMs, roundedMs)
  row.maxMs = row.maxMs === null ? roundedMs : Math.max(row.maxMs, roundedMs)
  row.lastMs = roundedMs
  row.lastStatus = status
  row.lastAtMs = Date.now()
  const capturedHeaders = extractResponseHeaderTelemetry(headers)
  if (capturedHeaders !== null) {
    row.lastHeaders = capturedHeaders
  }
  if (status !== null && status >= 200 && status < 400) row.ok += 1
  else row.failed += 1
  notify()
}

function buildSnapshot(): ApiUsageSnapshot {
  const sessionBaseUrl = extractBaseUrlProperties()
  const originSet = new Set<string>([sessionBaseUrl.origin])
  let calls = 0
  let ok = 0
  let failed = 0
  let pending = 0
  let coalesced = 0
  let totalMs = 0
  let completed = 0
  let alignedResponses = 0
  const snapshotRows: ApiUsageRow[] = []
  for (const [key, row] of rows) {
    calls += row.calls
    ok += row.ok
    failed += row.failed
    pending += row.pending
    coalesced += row.coalesced
    totalMs += row.totalMs
    completed += row.completed
    originSet.add(row.baseUrl.origin)
    if (row.lastHeaders?.aligned) {
      alignedResponses += 1
    }
    snapshotRows.push({
      key,
      method: row.method,
      normalizedPath: row.normalizedPath,
      baseUrl: row.baseUrl,
      calls: row.calls,
      ok: row.ok,
      failed: row.failed,
      pending: row.pending,
      coalesced: row.coalesced,
      avgMs: row.completed > 0 ? Math.round(row.totalMs / row.completed) : null,
      minMs: row.minMs,
      maxMs: row.maxMs,
      lastMs: row.lastMs,
      lastStatus: row.lastStatus,
      lastAtMs: row.lastAtMs,
      lastHeaders: row.lastHeaders,
    })
  }
  snapshotRows.sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key))
  return {
    baseUrl: sessionBaseUrl,
    origins: [...originSet].sort(),
    rows: snapshotRows,
    calls,
    ok,
    failed,
    pending,
    coalesced,
    avgMs: completed > 0 ? Math.round(totalMs / completed) : null,
    alignedResponses,
  }
}

/** Cached so `useSyncExternalStore` sees a stable value between records. */
export function getApiUsageSnapshot(): ApiUsageSnapshot {
  if (cachedSnapshot === null || cachedVersion !== version) {
    cachedSnapshot = buildSnapshot()
    cachedVersion = version
  }
  return cachedSnapshot
}

export function subscribeApiUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** React hook used by the Telemetry API Usage card. */
export function useApiUsage(): ApiUsageSnapshot {
  return useSyncExternalStore(subscribeApiUsage, getApiUsageSnapshot, getApiUsageSnapshot)
}

/** Clear the session meter (never touches server state). */
export function resetApiUsage(): void {
  rows.clear()
  notify()
}

/** In-flight plain GETs, keyed by absolute URL; StrictMode mounts overlap. */
const inFlightGet = new Map<
  string,
  Promise<{
    readonly template: Response
    readonly status: number
    readonly headers: Headers
  }>
>()

/** Coalesce only plain, signal-free GETs; options/headers keep their own request. */
function coalescableGet(input: ApiUsageInput, init?: RequestInit): boolean {
  if (typeof input !== "string" && !(input instanceof URL)) return false
  if (init === undefined) return true
  for (const key of Object.keys(init)) {
    if (key !== "method") return false
  }
  return (init.method ?? "GET").toUpperCase() === "GET"
}

function absoluteUrl(input: ApiUsageInput): string {
  if (typeof input === "string") return new URL(input, resolveBaseOrigin()).href
  if (input instanceof URL) return input.href
  return input.url
}

const unauthorizedListeners = new Set<() => void>()

/** Subscribe to 401 Unauthorized responses observed by `trackedFetch`. */
export function registerUnauthorizedListener(listener: () => void): () => void {
  unauthorizedListeners.add(listener)
  return () => {
    unauthorizedListeners.delete(listener)
  }
}

function notifyIfUnauthorized(input: ApiUsageInput, status: number): void {
  if (status !== 401) return
  const href = absoluteUrl(input)
  if (href.includes("/api/auth/")) return
  for (const listener of unauthorizedListeners) {
    try {
      listener()
    } catch {
      // ignore listener errors
    }
  }
}

const DEV_SESSION_STORAGE_KEY = "sportsdesk_dev_session_token"
const DEV_CSRF_STORAGE_KEY = "sportsdesk_dev_csrf_token"

export function getDevSessionToken(): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null
    const val = sessionStorage.getItem(DEV_SESSION_STORAGE_KEY)
    return val && val.trim().length > 0 ? val.trim() : null
  } catch {
    return null
  }
}

export function setDevSessionToken(token: string | null): void {
  try {
    if (typeof sessionStorage === "undefined") return
    if (token && token.trim().length > 0) {
      sessionStorage.setItem(DEV_SESSION_STORAGE_KEY, token.trim())
    } else {
      sessionStorage.removeItem(DEV_SESSION_STORAGE_KEY)
    }
  } catch {
    // ignore storage errors in restricted iframes
  }
}

export function getDevCsrfToken(): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null
    const val = sessionStorage.getItem(DEV_CSRF_STORAGE_KEY)
    return val && val.trim().length > 0 ? val.trim() : null
  } catch {
    return null
  }
}

export function setDevCsrfToken(token: string | null): void {
  try {
    if (typeof sessionStorage === "undefined") return
    if (token && token.trim().length > 0) {
      sessionStorage.setItem(DEV_CSRF_STORAGE_KEY, token.trim())
    } else {
      sessionStorage.removeItem(DEV_CSRF_STORAGE_KEY)
    }
  } catch {
    // ignore storage errors in restricted iframes
  }
}

function buildAuthenticatedInit(init?: RequestInit): RequestInit {
  const effective: RequestInit =
    init?.credentials !== undefined ? { ...init } : { ...(init ?? {}), credentials: "include" }

  const headers = new Headers(effective.headers)
  if (!headers.has("accept")) {
    headers.set("Accept", "application/json")
  }
  if (!headers.has("x-sportsdesk-client")) {
    headers.set("X-SportsDesk-Client", "dashboard-ui")
  }
  if (!headers.has("x-sportsdesk-tab")) {
    headers.set("X-SportsDesk-Tab", resolveWindowTabHeader())
  }
  if (
    !headers.has("x-request-id") &&
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    headers.set("X-Request-Id", crypto.randomUUID())
  }

  const devToken = getDevSessionToken()
  const devCsrf = getDevCsrfToken()

  if (devToken && !headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${devToken}`)
  }
  const method = (effective.method ?? "GET").toUpperCase()
  if (
    devCsrf &&
    method !== "GET" &&
    method !== "HEAD" &&
    method !== "OPTIONS" &&
    !headers.has("x-csrf-token")
  ) {
    headers.set("x-csrf-token", devCsrf)
  }
  effective.headers = headers
  return effective
}

/**
 * Drop-in `fetch` that records endpoint usage & aligned header telemetry without changing the
 * response. Concurrent identical plain GETs share one network request and each caller gets its own
 * `Response` clone.
 */
export async function trackedFetch(input: ApiUsageInput, init?: RequestInit): Promise<Response> {
  const usageKey = apiUsageKey(input, init?.method)
  const rowBaseUrl = extractBaseUrlProperties(input)
  const coalescable = coalescableGet(input, init)
  const requestKey = coalescable ? `GET ${absoluteUrl(input)}` : null
  const shared = requestKey === null ? undefined : inFlightGet.get(requestKey)
  const token = beginApiCall(usageKey, shared !== undefined, rowBaseUrl)

  if (shared !== undefined) {
    try {
      const { template, status, headers } = await shared
      endApiCall(token, status, headers)
      notifyIfUnauthorized(input, status)
      return template.clone() as unknown as Response
    } catch (error) {
      endApiCall(token, null)
      throw error
    }
  }

  const effectiveInit = buildAuthenticatedInit(init)
  const fetchInput = input instanceof URL ? input.toString() : input

  const own = (async () => {
    // Bun's global `Response` and the undici fetch typings disagree about the
    // Headers shape; the runtime returns the same class.
    const response = (await fetch(
      fetchInput as RequestInfo | URL,
      effectiveInit,
    )) as unknown as Response
    return {
      template: response,
      status: response.status,
      headers: response.headers,
    }
  })()

  if (requestKey !== null) {
    inFlightGet.set(requestKey, own)
    void own
      .finally(() => {
        if (inFlightGet.get(requestKey) === own) inFlightGet.delete(requestKey)
      })
      .catch(() => {})
  }

  try {
    const { template, status, headers } = await own
    endApiCall(token, status, headers)
    notifyIfUnauthorized(input, status)
    // The template stays unread, so every caller (including late joiners) can
    // clone it; nobody may consume the shared body.
    return (coalescable ? template.clone() : template) as unknown as Response
  } catch (error) {
    endApiCall(token, null)
    throw error
  }
}
