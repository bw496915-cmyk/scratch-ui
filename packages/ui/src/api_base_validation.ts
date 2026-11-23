/**
 * @file packages/ui/src/api_base_validation.ts
 * @description Strict `URLPattern`-backed allowlist validator and cross-runtime
 * `URLSearchParams` sanitizer for `?apiBase=` overrides and external API base origins.
 *
 * Production policy:
 *   - `https://<sub >.bookdeskops.com[/optional/path]` only
 *   - No credentials, no non-default ports, no query string, no hash fragment,
 *     no backslashes, bounded input length (`MAX_API_BASE_INPUT = 2048`)
 *   - Single DNS label `<sub >` enforcing RFC 1123 (1–63 chars, alnum ends,
 *     no punycode `xn--`, and not in `DENIED_SUBS` such as `staging`)
 *
 * Local development policy (`isLocalDev === true`):
 *   - Also permits `http://localhost[:port]`, `http://127.0.0.1[:port]`,
 *     and `http://[::1][:port]` with valid ports `1..65535`
 *
 * Cross-runtime hardening (Bun / WebKit / V8 / Gecko / polyfills):
 *   - Never uses `instanceof URLSearchParams` (Web global vs `node:url`)
 *   - Never reads `URLSearchParams.prototype.size` (omitted in polyfills)
 *   - Always reads `getAll("apiBase")` to block duplicate-key query smuggling
 *   - Asserts `hasRegExpGroups === true` at `URLPattern` construction time
 *   - Rejects backslashes and collapses repeated path slashes before emitting
 *     normalized URLs to close `URL` vs `fetch` parser differentials
 */

export const MAX_API_BASE_INPUT = 2048

export type ApiBaseValidationCode =
  | "ERR_API_BASE_INVALID_URL"
  | "ERR_API_BASE_ORIGIN_UNTRUSTED"
  | "ERR_API_BASE_PATTERN_UNAVAILABLE"
  | "ERR_API_BASE_INVALID_PORT"
  | "ERR_API_BASE_QUERY_OR_HASH_FORBIDDEN"
  | "ERR_API_BASE_DUPLICATE_PARAM"

export type ApiBaseValidation =
  | { readonly ok: true; readonly normalized: string; readonly sub?: string }
  | { readonly ok: false; readonly code: ApiBaseValidationCode }

export type ApiBaseParamExtraction =
  | { readonly present: false }
  | { readonly present: true; readonly ok: true; readonly raw: string }
  | { readonly present: true; readonly ok: false; readonly code: "ERR_API_BASE_DUPLICATE_PARAM" }

const DENIED_SUBS = new Set(["staging"])

// Enforces 1–63 chars, alnum at both ends, no leading/trailing hyphen.
// Escaped `\-` inside the character class compiles cleanly under Bun/WebKit's
// Unicode-sets (`v`) URLPattern RegExp compiler as well as V8 and Gecko.
const SUB_LABEL_PATTERN = "[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?"
const SUB_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

type URLPatternConstructor = typeof URLPattern

let prodPattern: URLPattern | undefined
let devPattern: URLPattern | undefined

function createPatterns(
  PatternCtor: URLPatternConstructor | undefined,
): { prod?: URLPattern; dev?: URLPattern } {
  if (typeof PatternCtor !== "function") {
    return {}
  }

  try {
    const prod = new PatternCtor(
      {
        protocol: "https",
        username: "",
        password: "",
        hostname: `:sub(${SUB_LABEL_PATTERN}).bookdeskops.com`,
        port: "",
        pathname: "{/*}?",
        search: "",
        hash: "",
      },
      { ignoreCase: true },
    )

    // Escaped dots and bracketed IPv6 literal inside a single regex alternation
    // avoids JSC/WebKit `:name` collisions on `::1` and rejects non-dot chars.
    const dev = new PatternCtor(
      {
        protocol: "http",
        username: "",
        password: "",
        hostname: "(localhost|127\\.0\\.0\\.1|\\[::1\\])",
        port: ":port([0-9]{1,5})?",
        pathname: "{/*}?",
        search: "",
        hash: "",
      },
      { ignoreCase: true },
    )

    // Startup invariant: fail closed if custom regex groups failed to compile.
    if (!prod.hasRegExpGroups || !dev.hasRegExpGroups) {
      return {}
    }

    return { prod, dev }
  } catch {
    // Older runtime without URLPattern, or an engine-specific pattern failure.
    return {}
  }
}

function getPatterns(
  patternCtorOverride?: URLPatternConstructor | null,
): { prod?: URLPattern; dev?: URLPattern } {
  if (patternCtorOverride !== undefined) {
    return createPatterns(patternCtorOverride ?? undefined)
  }

  if (prodPattern && devPattern) {
    return { prod: prodPattern, dev: devPattern }
  }

  const globalCtor = (globalThis as unknown as { URLPattern?: URLPatternConstructor }).URLPattern
  const built = createPatterns(globalCtor)
  prodPattern = built.prod
  devPattern = built.dev
  return built
}

/**
 * Returns `true` when the active runtime's `URLPattern` compiled both the
 * production and dev allowlist patterns with active custom regex groups.
 */
export function hasCompiledApiBasePatterns(
  patternCtorOverride?: URLPatternConstructor | null,
): boolean {
  const { prod, dev } = getPatterns(patternCtorOverride)
  return Boolean(prod?.hasRegExpGroups && dev?.hasRegExpGroups)
}

/**
 * Duck-typed `URLSearchParams` guard that works identically across Web globals,
 * `node:url`, Bun, browsers, and polyfills without relying on `instanceof`.
 */
export function isURLSearchParams(value: unknown): value is URLSearchParams {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as URLSearchParams).getAll === "function" &&
    typeof (value as URLSearchParams).delete === "function" &&
    typeof (value as URLSearchParams).toString === "function"
  )
}

/**
 * Polyfill-safe emptiness check for `URLSearchParams` (avoids `.size`).
 */
export function hasEmptySearchParams(params: URLSearchParams): boolean {
  return [...params].length === 0
}

/**
 * Extracts `?apiBase=` using `getAll("apiBase")` so duplicate-key smuggling
 * (e.g. `?apiBase=https://good.bookdeskops.com&apiBase=https://evil.example`)
 * is rejected fail-closed instead of silently trusting the first occurrence.
 */
export function extractSingleApiBaseParam(
  searchOrParams: string | URLSearchParams,
): ApiBaseParamExtraction {
  const params = isURLSearchParams(searchOrParams)
    ? searchOrParams
    : new URLSearchParams(
        searchOrParams.startsWith("?") ? searchOrParams.slice(1) : searchOrParams,
      )
  const values = params.getAll("apiBase")
  if (values.length === 0) {
    return { present: false }
  }
  if (values.length !== 1) {
    return { present: true, ok: false, code: "ERR_API_BASE_DUPLICATE_PARAM" }
  }
  return { present: true, ok: true, raw: values[0]! }
}

/**
 * Deletes every occurrence of `apiBase` from a `URLSearchParams` instance
 * (`delete` removes all matching keys per the WHATWG URL spec).
 */
export function stripApiBaseParam(params: URLSearchParams): void {
  params.delete("apiBase")
}

/**
 * Validates and canonicalizes `?apiBase=` in place on a `URLSearchParams` object.
 * - Duplicate `?apiBase=` keys are purged and rejected with `ERR_API_BASE_DUPLICATE_PARAM`.
 * - Untrusted or malformed values are deleted completely.
 * - Single valid values are replaced with their canonical normalized URL.
 */
export function sanitizeApiBaseParam(
  params: URLSearchParams,
  isLocalDev: boolean,
): ApiBaseValidation | null {
  const extracted = extractSingleApiBaseParam(params)
  if (!extracted.present) {
    return null
  }
  // Always delete all occurrences first so no duplicate key can survive re-serialization.
  stripApiBaseParam(params)
  if (!extracted.ok) {
    return { ok: false, code: extracted.code }
  }
  const validated = validateApiBase(extracted.raw, isLocalDev)
  if (validated.ok) {
    params.set("apiBase", validated.normalized)
  }
  return validated
}

function isValidSub(rawSub: string): boolean {
  const sub = rawSub.toLowerCase()
  return (
    sub.length > 0 &&
    sub.length <= 63 &&
    SUB_LABEL_RE.test(sub) &&
    !sub.startsWith("xn--") &&
    !DENIED_SUBS.has(sub)
  )
}

function normalize(url: URL): string {
  const path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "")
  return `${url.protocol}//${url.host}${path}`
}

function isValidOptionalPort(port: string): boolean {
  if (port === "") return true
  if (!/^[0-9]{1,5}$/.test(port)) return false
  const num = Number(port)
  return Number.isInteger(num) && num >= 1 && num <= 65535
}

function hasForbiddenQueryOrHash(trimmed: string, url: URL): boolean {
  return (
    trimmed.includes("?") ||
    trimmed.includes("#") ||
    url.search !== "" ||
    !hasEmptySearchParams(url.searchParams) ||
    url.hash !== ""
  )
}

/**
 * Validates an untrusted `apiBase` string strictly via WHATWG `URLPattern`.
 * Fails closed with `ERR_API_BASE_PATTERN_UNAVAILABLE` if `URLPattern` is not
 * available or did not compile custom regex groups in the current runtime.
 */
export function validateApiBaseWithPattern(
  raw: string | null | undefined,
  isLocalDev: boolean,
  patternCtorOverride?: URLPatternConstructor | null,
): ApiBaseValidation {
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (trimmed.length === 0 || trimmed.length > MAX_API_BASE_INPUT || trimmed.includes("\\")) {
    return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
  }

  const { prod, dev } = getPatterns(patternCtorOverride)
  if (!prod || !dev) {
    return { ok: false, code: "ERR_API_BASE_PATTERN_UNAVAILABLE" }
  }

  try {
    // Parse with WHATWG URL first so relative/protocol-relative/malformed inputs
    // consistently produce ERR_API_BASE_INVALID_URL across engines.
    const url = new URL(trimmed)

    if (hasForbiddenQueryOrHash(trimmed, url)) {
      return { ok: false, code: "ERR_API_BASE_QUERY_OR_HASH_FORBIDDEN" }
    }

    const prodMatch = prod.exec(trimmed)
    if (prodMatch) {
      if (
        url.hostname !== prodMatch.hostname.input.toLowerCase() ||
        url.username !== "" ||
        url.password !== ""
      ) {
        return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
      }
      const sub = (prodMatch.hostname.groups.sub ?? "").toLowerCase()
      if (!isValidSub(sub)) {
        return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
      }
      return { ok: true, normalized: normalize(url), sub }
    }

    if (isLocalDev) {
      const devMatch = dev.exec(trimmed)
      if (devMatch) {
        if (
          url.hostname !== devMatch.hostname.input.toLowerCase() ||
          url.username !== "" ||
          url.password !== ""
        ) {
          return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
        }
        const matchedPort = devMatch.port.groups.port ?? url.port
        if (!isValidOptionalPort(matchedPort) || !isValidOptionalPort(url.port)) {
          return { ok: false, code: "ERR_API_BASE_INVALID_PORT" }
        }
        return { ok: true, normalized: normalize(url) }
      }
    }

    return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
  } catch {
    // URLPattern TypeError (relative input, bad syntax) or URL TypeError
    // (bad port, unparseable URL). Both are rejections, not crashes.
    return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
  }
}

/**
 * Equivalent pure-`URL` validator used ONLY as a browser fallback when
 * `URLPattern` is unavailable (`ERR_API_BASE_PATTERN_UNAVAILABLE`).
 */
export function validateApiBaseFallback(
  raw: string | null | undefined,
  isLocalDev: boolean,
): ApiBaseValidation {
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (trimmed.length === 0 || trimmed.length > MAX_API_BASE_INPUT || trimmed.includes("\\")) {
    return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
  }

  if (hasForbiddenQueryOrHash(trimmed, url)) {
    return { ok: false, code: "ERR_API_BASE_QUERY_OR_HASH_FORBIDDEN" }
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
  }

  const hostname = url.hostname.toLowerCase()

  if (url.protocol === "https:" && url.port === "") {
    const suffix = ".bookdeskops.com"
    if (hostname.endsWith(suffix)) {
      const sub = hostname.slice(0, -suffix.length)
      if (!sub.includes(".") && isValidSub(sub)) {
        return { ok: true, normalized: normalize(url), sub }
      }
    }
  }

  if (isLocalDev && url.protocol === "http:" && LOCAL_DEV_HOSTS.has(hostname)) {
    if (!isValidOptionalPort(url.port)) {
      return { ok: false, code: "ERR_API_BASE_INVALID_PORT" }
    }
    return { ok: true, normalized: normalize(url) }
  }

  return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
}

/**
 * Validates an `apiBase` URL using `validateApiBaseWithPattern`, falling back
 * to `validateApiBaseFallback` only when the browser lacks `URLPattern`.
 */
export function validateApiBase(
  raw: string | null | undefined,
  isLocalDev: boolean,
): ApiBaseValidation {
  const result = validateApiBaseWithPattern(raw, isLocalDev)
  if (!result.ok && result.code === "ERR_API_BASE_PATTERN_UNAVAILABLE") {
    return validateApiBaseFallback(raw, isLocalDev)
  }
  return result
}

export interface LocationOriginLike {
  readonly location?: {
    readonly origin?: string
    readonly href?: string
  }
}

/**
 * Determines whether the current runtime context permits loopback local-dev
 * `?apiBase=` targets (loopback browser origin, Vite dev mode, or non-production runtime).
 */
export function isLocalDevLocation(win?: LocationOriginLike | null): boolean {
  const originOrHref = win?.location?.origin || win?.location?.href
  if (originOrHref && originOrHref !== "null") {
    try {
      const parsed = new URL(originOrHref)
      if (LOCAL_DEV_HOSTS.has(parsed.hostname.toLowerCase())) {
        return true
      }
    } catch {
      // fall through
    }
  }

  const importMetaEnv = (import.meta as unknown as { env?: { DEV?: boolean; PROD?: boolean } }).env
  if (importMetaEnv?.DEV === true) return true
  if (importMetaEnv?.PROD === true) return false

  const nodeEnv = (
    globalThis as unknown as { process?: { readonly env?: { readonly NODE_ENV?: string } } }
  ).process?.env?.NODE_ENV
  return nodeEnv !== "production"
}
