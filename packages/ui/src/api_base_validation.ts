/**
 * @file packages/ui/src/api_base_validation.ts
 * @description Strict `URLPattern`-backed allowlist validator for `?apiBase=`
 * overrides and external API base origins.
 *
 * Production policy:
 *   - `https://<sub >.bookdeskops.com[/optional/path]` only
 *   - No credentials, no non-default ports, no query string, no hash fragment
 *   - Single DNS label `<sub >` enforcing RFC 1123 (1–63 chars, alnum ends,
 *     no punycode `xn--`, and not in `DENIED_SUBS` such as `staging`)
 *
 * Local development policy (`isLocalDev === true`):
 *   - Also permits `http://localhost[:port]`, `http://127.0.0.1[:port]`,
 *     and `http://[::1][:port]` with valid ports `1..65535`
 */

export type ApiBaseValidationCode =
  | "ERR_API_BASE_INVALID_URL"
  | "ERR_API_BASE_ORIGIN_UNTRUSTED"
  | "ERR_API_BASE_PATTERN_UNAVAILABLE"

export type ApiBaseValidation =
  | { readonly ok: true; readonly normalized: string; readonly sub?: string }
  | { readonly ok: false; readonly code: ApiBaseValidationCode }

const DENIED_SUBS = new Set(["staging"])

// Enforces 1–63 chars, alnum at both ends, no leading/trailing hyphen.
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
    // Note: `:sub.bookdeskops.com` matches strictly a single DNS label (dots are
    // hostname delimiters in WHATWG URLPattern) across Bun/JSC, V8, and Gecko,
    // while `isValidSub()` enforces the exact RFC 1123 label, punycode, and denylist rules.
    const prod = new PatternCtor(
      {
        protocol: "https",
        username: "",
        password: "",
        hostname: ":sub.bookdeskops.com",
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
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

function isValidOptionalPort(port: string): boolean {
  if (port === "") return true
  if (!/^[0-9]{1,5}$/.test(port)) return false
  const num = Number(port)
  return Number.isInteger(num) && num >= 1 && num <= 65535
}

/**
 * Validates an untrusted `apiBase` string strictly via WHATWG `URLPattern`.
 * Fails closed with `ERR_API_BASE_PATTERN_UNAVAILABLE` if `URLPattern` is not
 * available in the current runtime.
 */
export function validateApiBaseWithPattern(
  raw: string | null | undefined,
  isLocalDev: boolean,
  patternCtorOverride?: URLPatternConstructor | null,
): ApiBaseValidation {
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (trimmed.length === 0) {
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

    const prodMatch = prod.exec(trimmed)
    if (prodMatch) {
      const sub = (prodMatch.hostname.groups.sub ?? "").toLowerCase()
      if (!isValidSub(sub)) {
        return { ok: false, code: "ERR_API_BASE_ORIGIN_UNTRUSTED" }
      }
      return { ok: true, normalized: normalize(url), sub }
    }

    if (isLocalDev && dev.test(trimmed)) {
      if (!isValidOptionalPort(url.port)) {
        return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
      }
      return { ok: true, normalized: normalize(url) }
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
  if (trimmed.length === 0) {
    return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
  }

  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
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
      return { ok: false, code: "ERR_API_BASE_INVALID_URL" }
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
