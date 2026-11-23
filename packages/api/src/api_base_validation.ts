/**
 * @file packages/api/src/api_base_validation.ts
 * @description Hardened Bun-runtime API base & HTTP origin validation for `packages/api`.
 *
 * Security invariants:
 * - Startup `URLPattern` regex-group compilation assertion (`hasRegExpGroups === true`)
 *   for both production (`https://<sub >.bookdeskops.com`) and local dev loopback patterns
 *   — fails closed with `ERR_API_BASE_PATTERN_UNAVAILABLE` if regex groups fail to compile.
 * - Strict `MAX_API_BASE_INPUT` (2048 chars) length cap before invoking `URLPattern.exec()`
 *   to prevent polynomial-time regex backtracking.
 * - Rejects backslashes (`\`), query strings (`?`), hash fragments (`#`), embedded
 *   credentials, punycode labels (`xn--`), denied subdomains (`staging`), and invalid ports.
 * - Collapses repetitive path slashes (`//` -> `/`) and strips trailing slashes via
 *   `normalizeApiBaseUrl()` to close `URL` vs `fetch` parser differentials.
 * - Cross-runtime `URLSearchParams` helpers avoid `instanceof` and `.size`, and inspect
 *   `getAll("apiBase")` to block duplicate-key query smuggling.
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
 * Duck-typed `URLSearchParams` guard avoiding `instanceof` mismatches between
 * Web globals, `node:url`, and polyfills.
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

/** Polyfill-safe emptiness check for `URLSearchParams` (avoids `.size`). */
export function hasEmptySearchParams(params: URLSearchParams): boolean {
  return [...params].length === 0
}

/**
 * Extracts `?apiBase=` via `getAll("apiBase")`, failing closed on duplicate keys
 * (`ERR_API_BASE_DUPLICATE_PARAM`).
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

/** Deletes all occurrences of `apiBase` from a `URLSearchParams` instance. */
export function stripApiBaseParam(params: URLSearchParams): void {
  params.delete("apiBase")
}

/**
 * Collapses repetitive path slashes (`//` -> `/`) and strips trailing slashes.
 */
export function normalizeUrlPathSlashes(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "")
}

/**
 * Canonicalizes a validated `URL` into `${protocol}//${host}${normalizedPath}`
 * with repetitive and trailing slashes removed.
 */
export function normalizeApiBaseUrl(url: URL): string {
  const path = normalizeUrlPathSlashes(url.pathname)
  return `${url.protocol}//${url.host}${path}`
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
 * Validates an untrusted `apiBase` string strictly via WHATWG `URLPattern`
 * with startup `hasRegExpGroups` verification, `MAX_API_BASE_INPUT` cap,
 * backslash rejection, host agreement check, and repetitive-slash normalization.
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
      return { ok: true, normalized: normalizeApiBaseUrl(url), sub }
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
        return { ok: true, normalized: normalizeApiBaseUrl(url) }
      }
    }

    return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
  } catch {
    return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
  }
}

/**
 * Pure-`URL` fallback validator used only when `URLPattern` is unavailable.
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
        return { ok: true, normalized: normalizeApiBaseUrl(url), sub }
      }
    }
  }

  if (isLocalDev && url.protocol === "http:" && LOCAL_DEV_HOSTS.has(hostname)) {
    if (!isValidOptionalPort(url.port)) {
      return { ok: false, code: "ERR_API_BASE_INVALID_PORT" }
    }
    return { ok: true, normalized: normalizeApiBaseUrl(url) }
  }

  return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
}

/**
 * Validates an `apiBase` URL via `validateApiBaseWithPattern`, falling back to
 * `validateApiBaseFallback` only when the runtime lacks `URLPattern`.
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

export interface ValidateConfigHttpUrlOptions {
  /** Disallow non-empty path segments (origin-only validation, e.g. CORS origins). */
  readonly originOnly?: boolean | undefined
  /** Allow query parameters (disabled by default for config base URLs). */
  readonly allowQuery?: boolean | undefined
}

/**
 * Hardened HTTP(S) configuration URL validator for server config overrides
 * (`SPORTSDESK_API_ORIGIN`, `R2_ENDPOINT`, `TELEGRAM_WEBHOOK_URL`, `SPORTSDESK_ALLOWED_ORIGINS`).
 *
 * Enforces `MAX_API_BASE_INPUT`, rejects backslashes, credentials, invalid ports,
 * and query/hash smuggling, and collapses repetitive slashes in paths.
 */
export function validateConfigHttpUrl(
  raw: string | null | undefined,
  options: ValidateConfigHttpUrlOptions = {},
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

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
  }

  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
  }

  if (!isValidOptionalPort(url.port)) {
    return { ok: false, code: "ERR_API_BASE_INVALID_PORT" }
  }

  if (!options.allowQuery && hasForbiddenQueryOrHash(trimmed, url)) {
    return { ok: false, code: "ERR_API_BASE_QUERY_OR_HASH_FORBIDDEN" }
  }

  if (url.hash !== "" || trimmed.includes("#")) {
    return { ok: false, code: "ERR_API_BASE_QUERY_OR_HASH_FORBIDDEN" }
  }

  const normalizedPath = normalizeUrlPathSlashes(url.pathname)
  if (options.originOnly && normalizedPath !== "") {
    return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
  }

  const normalized = options.originOnly
    ? `${url.protocol}//${url.host}`
    : `${url.protocol}//${url.host}${normalizedPath}${options.allowQuery ? url.search : ""}`

  return { ok: true, normalized }
}

/**
 * Validates an optional `?apiBase=` query parameter on an incoming HTTP `Request`.
 * Returns `null` if no `apiBase` query parameter is present; otherwise validates
 * via `extractSingleApiBaseParam` + `validateApiBase`.
 */
export function validateRequestApiBaseParam(
  req: Request,
  isLocalDev: boolean,
): ApiBaseValidation | null {
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    return null
  }
  const extracted = extractSingleApiBaseParam(url.searchParams)
  if (!extracted.present) return null
  if (!extracted.ok) return { ok: false, code: extracted.code }
  return validateApiBase(extracted.raw, isLocalDev)
}
