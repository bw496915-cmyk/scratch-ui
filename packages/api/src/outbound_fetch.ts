/**
 * Single outbound egress wrapper for Lanes E (internal services), F (external fixed-host
 * templates), and G (read-only public R2 fallback). Security & Bun 1.4.4 runtime invariants:
 *
 * - Exact hostname allowlist (`policy.allow`) checked after WHATWG URL parsing; never interpolates
 *   user input into the host component.
 * - `redirect: "manual"` + immediate body cancel & throw on any `3xx` response so an upstream 302 can
 *   never pivot into loopback `:4020` or internal metadata.
 * - `AbortSignal.any([AbortSignal.timeout(timeoutMs), init.signal])` bounded timeouts.
 * - Proxy hop TLS (`proxy.tls`) is kept strictly separate from target origin TLS (`tls`) so a
 *   corporate proxy CA never widens trust for external origins and origin client certs never leak
 *   to the proxy.
 * - Practical note: `http://` proxy + `CONNECT` is the stable tunnel path; `https://` proxy URLs can
 *   stall TLS-in-TLS handshakes and are flagged accordingly.
 * - Lane G (`allowCredentials: false`) strips `Authorization` and `Cookie` headers and disables proxy
 *   forwarding so signed credentials never reach public R2.
 *
 * @file Packages/api/src/outbound_fetch.ts
 */

import { readFileSync } from "node:fs"

import { resolveUnder } from "./api_base_validation.ts"
import {
  DEFAULT_R2_PUBLIC_ORIGIN,
  FANTASY402_ORIGIN,
  POLYGONSCAN_ORIGIN,
  POLYMARKET_DATA_API_ORIGIN,
} from "./egress_config.ts"

export interface EgressTlsConfig {
  readonly ca?: string | readonly string[] | undefined
  readonly cert?: string | undefined
  readonly key?: string | undefined
  readonly rejectUnauthorized?: boolean | undefined
  readonly serverName?: string | undefined
}

export interface EgressProxyConfig {
  readonly url: string
  readonly headers?: Record<string, string> | undefined
  readonly tls?: EgressTlsConfig | undefined
}

export interface EgressPolicy {
  /** Exact lowercase hostnames permitted for this call (e.g. `["fantasy402.com"]`). */
  readonly allow: readonly string[]
  /** Hard timeout in milliseconds (default 5_000). */
  readonly timeoutMs?: number | undefined
  /** Optional proxy override (`null` explicitly disables proxy for this lane). */
  readonly proxy?: EgressProxyConfig | null | undefined
  /** Target-only TLS settings (kept isolated from `proxy.tls`). */
  readonly tls?: EgressTlsConfig | undefined
  /**
   * When `false` (Lane G public read-only tier), strips `Authorization` and `Cookie` headers before
   * sending and enforces `credentials: "omit"`.
   */
  readonly allowCredentials?: boolean | undefined
  /** Optional fetch implementation override for unit tests. */
  readonly fetchImpl?: ((input: URL | string, init?: RequestInit) => Promise<Response>) | undefined
}

export class EgressPolicyError extends Error {
  readonly code:
    | "EGRESS_HOST_DENIED"
    | "EGRESS_PROTOCOL_DENIED"
    | "EGRESS_REDIRECT_REFUSED"
    | "EGRESS_INVALID_PROXY"

  constructor(
    code:
      | "EGRESS_HOST_DENIED"
      | "EGRESS_PROTOCOL_DENIED"
      | "EGRESS_REDIRECT_REFUSED"
      | "EGRESS_INVALID_PROXY",
    message: string,
  ) {
    super(message)
    this.name = "EgressPolicyError"
    this.code = code
  }
}

export interface LoadedEgressTransport {
  readonly proxy: EgressProxyConfig | undefined
  readonly targetTls: EgressTlsConfig | undefined
  readonly usesHttpsProxyScheme: boolean
}

/**
 * Load proxy and target TLS configuration from env with strict CA separation:
 *
 * - `PROXY_CA` only configures `proxy.tls.ca`
 * - `ORIGIN_CA` only configures `targetTls.ca`
 * - Prefers `http://` proxy URLs (CONNECT tunnel) over `https://` proxy URLs.
 */
export function loadEgressTransportFromEnv(
  env: Record<string, string | undefined> = process.env,
  readTextFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): LoadedEgressTransport {
  const rawProxy = env.HTTPS_PROXY?.trim() || env.HTTP_PROXY?.trim() || ""
  let proxy: EgressProxyConfig | undefined
  let usesHttpsProxyScheme = false

  if (rawProxy) {
    let parsedProxy: URL
    try {
      parsedProxy = new URL(rawProxy)
    } catch {
      throw new EgressPolicyError("EGRESS_INVALID_PROXY", `Invalid proxy URL: ${rawProxy}`)
    }
    if (parsedProxy.protocol !== "http:" && parsedProxy.protocol !== "https:") {
      throw new EgressPolicyError(
        "EGRESS_INVALID_PROXY",
        `Unsupported proxy protocol: ${parsedProxy.protocol}`,
      )
    }
    usesHttpsProxyScheme = parsedProxy.protocol === "https:"
    const proxyAuth = env.PROXY_AUTH?.trim()
    const proxyCaPath = env.PROXY_CA?.trim()
    proxy = {
      url: parsedProxy.toString(),
      ...(proxyAuth ? { headers: { "Proxy-Authorization": proxyAuth } } : {}),
      ...(proxyCaPath ? { tls: { ca: readTextFile(proxyCaPath) } } : {}),
    }
  }

  const originCaPath = env.ORIGIN_CA?.trim()
  const targetTls: EgressTlsConfig | undefined = originCaPath
    ? { ca: readTextFile(originCaPath) }
    : undefined

  return {
    proxy,
    targetTls,
    usesHttpsProxyScheme,
  }
}

function buildTimeoutSignal(timeoutMs: number, callerSignal?: AbortSignal | null): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return timeoutSignal
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeoutSignal, callerSignal])
  }
  const controller = new AbortController()
  const abort = () => controller.abort(callerSignal.reason ?? timeoutSignal.reason)
  if (callerSignal.aborted || timeoutSignal.aborted) {
    abort()
  } else {
    callerSignal.addEventListener("abort", abort, { once: true })
    timeoutSignal.addEventListener("abort", abort, { once: true })
  }
  return controller.signal
}

function sanitizeHeadersForPolicy(
  headersInit: HeadersInit | undefined,
  allowCredentials: boolean,
): Headers {
  const headers = new Headers(headersInit)
  if (!allowCredentials) {
    headers.delete("authorization")
    headers.delete("proxy-authorization")
    headers.delete("cookie")
    headers.delete("x-api-key")
  }
  return headers
}

/**
 * Copy response headers via `Object.fromEntries(headers)` (fast-path in Bun 1.4.4) while stripping
 * hop-by-hop `transfer-encoding`.
 */
export function proxyResponseHeaders(headers: Headers): Record<string, string> {
  const entries = Object.fromEntries(headers as unknown as Iterable<[string, string]>)
  delete entries["transfer-encoding"]
  delete entries["Transfer-Encoding"]
  return entries
}

/**
 * Unified egress fetch enforcing exact-host allowlist, manual redirects, bounded `AbortSignal.any`
 * timeouts, credential isolation, and separate proxy vs. target TLS configuration.
 */
export async function outboundFetch(
  target: URL,
  init: RequestInit = {},
  policy: EgressPolicy,
): Promise<Response> {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new EgressPolicyError(
      "EGRESS_PROTOCOL_DENIED",
      `egress denied protocol: ${target.protocol}`,
    )
  }

  const allowedHosts = new Set(policy.allow.map((h) => h.trim().toLowerCase()))
  const targetHost = target.hostname.toLowerCase()
  if (!allowedHosts.has(targetHost)) {
    throw new EgressPolicyError("EGRESS_HOST_DENIED", `egress denied: ${target.hostname}`)
  }

  const allowCredentials = policy.allowCredentials !== false
  const headers = sanitizeHeadersForPolicy(init.headers, allowCredentials)
  const signal = buildTimeoutSignal(policy.timeoutMs ?? 5_000, init.signal)

  const reqInit: RequestInit & {
    proxy?: EgressProxyConfig | undefined
    tls?: EgressTlsConfig | undefined
  } = {
    ...init,
    headers,
    signal,
    redirect: "manual",
    ...(!allowCredentials ? { credentials: "omit" } : {}),
  }

  if (policy.proxy !== null && policy.proxy !== undefined) {
    reqInit.proxy = policy.proxy
  }
  if (policy.tls !== undefined) {
    reqInit.tls = policy.tls
  }

  const fetcher = policy.fetchImpl ?? fetch
  const res = await fetcher(target, reqInit)

  if (res.status >= 300 && res.status < 400) {
    try {
      await res.body?.cancel()
    } catch {
      // ignore stream cancellation errors
    }
    throw new EgressPolicyError(
      "EGRESS_REDIRECT_REFUSED",
      `redirect refused: ${res.headers.get("location") ?? "(no location)"}`,
    )
  }

  return res
}

// ---------------------------------------------------------------------------
// Lane E: Internal services (exact-origin only, no user host templating)
// ---------------------------------------------------------------------------

export function fetchDaemonHealth(
  apiOrigin: URL,
  options: {
    readonly timeoutMs?: number | undefined
    readonly fetchImpl?: EgressPolicy["fetchImpl"] | undefined
  } = {},
): Promise<Response> {
  return outboundFetch(
    resolveUnder(apiOrigin, "health"),
    { method: "GET" },
    {
      allow: [apiOrigin.hostname],
      timeoutMs: options.timeoutMs ?? 1_500,
      proxy: null,
      fetchImpl: options.fetchImpl,
    },
  )
}

export function fetchServeLocalTokens(
  serveLocalOrigin: URL,
  options: {
    readonly timeoutMs?: number | undefined
    readonly fetchImpl?: EgressPolicy["fetchImpl"] | undefined
  } = {},
): Promise<Response> {
  return outboundFetch(
    resolveUnder(serveLocalOrigin, "_dev/serve-local/tokens"),
    { method: "GET" },
    {
      allow: [serveLocalOrigin.hostname],
      timeoutMs: options.timeoutMs ?? 2_000,
      proxy: null,
      fetchImpl: options.fetchImpl,
    },
  )
}

// ---------------------------------------------------------------------------
// Lane F: External fixed-host templates (never interpolate host from input)
// ---------------------------------------------------------------------------

export function fetchFantasy402(
  path = "/",
  options: {
    readonly timeoutMs?: number | undefined
    readonly proxy?: EgressProxyConfig | null | undefined
    readonly tls?: EgressTlsConfig | undefined
    readonly fetchImpl?: EgressPolicy["fetchImpl"] | undefined
  } = {},
): Promise<Response> {
  const base = new URL(FANTASY402_ORIGIN)
  const target = resolveUnder(base, path.replace(/^\/+/, ""))
  return outboundFetch(
    target,
    { headers: { accept: "application/json" } },
    {
      allow: [base.hostname],
      timeoutMs: options.timeoutMs ?? 5_000,
      proxy: options.proxy,
      tls: options.tls,
      fetchImpl: options.fetchImpl,
    },
  )
}

export function fetchPolymarketPositions(
  wallet: string,
  options: {
    readonly timeoutMs?: number | undefined
    readonly proxy?: EgressProxyConfig | null | undefined
    readonly tls?: EgressTlsConfig | undefined
    readonly fetchImpl?: EgressPolicy["fetchImpl"] | undefined
  } = {},
): Promise<Response> {
  const base = new URL(POLYMARKET_DATA_API_ORIGIN)
  const target = new URL(`/v2/positions?user=${encodeURIComponent(wallet.trim())}`, base)
  return outboundFetch(
    target,
    { headers: { accept: "application/json" } },
    {
      allow: [base.hostname],
      timeoutMs: options.timeoutMs ?? 5_000,
      proxy: options.proxy,
      tls: options.tls,
      fetchImpl: options.fetchImpl,
    },
  )
}

export function fetchPolygonscanAddress(
  wallet: string,
  options: {
    readonly timeoutMs?: number | undefined
    readonly proxy?: EgressProxyConfig | null | undefined
    readonly tls?: EgressTlsConfig | undefined
    readonly fetchImpl?: EgressPolicy["fetchImpl"] | undefined
  } = {},
): Promise<Response> {
  const base = new URL(POLYGONSCAN_ORIGIN)
  const target = resolveUnder(base, `address/${encodeURIComponent(wallet.trim())}`)
  return outboundFetch(
    target,
    {},
    {
      allow: [base.hostname],
      timeoutMs: options.timeoutMs ?? 5_000,
      proxy: options.proxy,
      tls: options.tls,
      fetchImpl: options.fetchImpl,
    },
  )
}

// ---------------------------------------------------------------------------
// Lane G: Read-only public R2 fallback (no proxy, no credentials, path-contained)
// ---------------------------------------------------------------------------

export function fetchR2PublicObject(
  key: string,
  r2PublicOrigin: URL = new URL(DEFAULT_R2_PUBLIC_ORIGIN),
  options: {
    readonly method?: "GET" | "HEAD" | undefined
    readonly timeoutMs?: number | undefined
    readonly fetchImpl?: EgressPolicy["fetchImpl"] | undefined
  } = {},
): Promise<Response> {
  const cleanKey = key.trim().replace(/^\/+/, "")
  const target = resolveUnder(r2PublicOrigin, cleanKey)
  return outboundFetch(
    target,
    { method: options.method ?? "GET", headers: {} },
    {
      allow: [r2PublicOrigin.hostname],
      timeoutMs: options.timeoutMs ?? 10_000,
      proxy: null,
      allowCredentials: false,
      fetchImpl: options.fetchImpl,
    },
  )
}
