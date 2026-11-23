/**
 * @file packages/ui/src/bun_utilities.ts
 * @description Browser-safe + Bun-native Utilities engine and SPA origin
 * decoupling resolver for the SportsDesk Operations shell.
 *
 * Resolves the architectural tension on `● Local :4022 SPA` by decoupling the
 * frontend SPA origin from hardcoded port assumptions, inspecting live
 * `URLPattern`-validated `?apiBase=` overrides, and exposing all 19 Bun Runtime
 * Utilities with zero bare `Bun` / `process` type references (compiles cleanly
 * under `packages/ui/tsconfig.json`'s `types: ["vite/client"]`).
 */

import {
  type ApiBaseValidation,
  hasCompiledApiBasePatterns,
  isLocalDevLocation,
  MAX_API_BASE_INPUT,
} from "./api_base_validation.ts"
import {
  type BunGlobalSnapshot,
  type DashboardWindowLocationLike,
  inspectApiBaseOverride,
  isBunRuntime,
  readBunGlobals,
  resolveDashboardBaseUrl,
} from "./config/dashboard.ts"

export type BunUtilityCategory =
  | "runtime"
  | "crypto-encoding"
  | "compression"
  | "strings-equality"
  | "paths-shell"
  | "module-meta"

export type BunUtilityId =
  | "upgrade-bun"
  | "detect-bun"
  | "get-bun-version"
  | "hash-password"
  | "generate-uuid"
  | "base64-encoding"
  | "gzip-compression"
  | "deflate-compression"
  | "escape-html"
  | "deep-equality"
  | "sleep"
  | "file-url-to-path"
  | "path-to-file-url"
  | "find-executable-path"
  | "import-meta-dir"
  | "import-meta-file"
  | "import-meta-path"
  | "check-entrypoint"
  | "get-entrypoint-path"

export interface BunUtilityDescriptor {
  readonly id: BunUtilityId
  readonly title: string
  readonly category: BunUtilityCategory
  readonly bunApi: string
  readonly browserFallback: string
  readonly snippet: string
  readonly summary: string
  readonly interactive: boolean
}

export const BUN_UTILITIES_CATALOG: readonly BunUtilityDescriptor[] = Object.freeze([
  {
    id: "upgrade-bun",
    title: "Upgrade Bun",
    category: "runtime",
    bunApi: "bun upgrade [--canary]",
    browserFallback: "CLI command (pinned to .bun-version 1.4.4)",
    snippet: "bun upgrade",
    summary: "Upgrades the installed Bun runtime to the latest stable or canary release.",
    interactive: false,
  },
  {
    id: "detect-bun",
    title: "Detect Bun",
    category: "runtime",
    bunApi: "process.versions.bun / typeof Bun !== 'undefined'",
    browserFallback: "isBunRuntime() via globalThis (zero extra TS types)",
    snippet: "if (process.versions.bun) { /* Bun runtime */ }",
    summary: "Detects Bun execution via process.versions.bun first, falling back to globalThis.Bun.",
    interactive: true,
  },
  {
    id: "get-bun-version",
    title: "Get Bun version",
    category: "runtime",
    bunApi: "Bun.version / Bun.revision / process.versions.bun",
    browserFallback: "X-Runtime-Engine response header + readBunGlobals()",
    snippet: "console.log(Bun.version, Bun.revision);",
    summary: "Reads the active Bun semver string and commit SHA revision.",
    interactive: true,
  },
  {
    id: "hash-password",
    title: "Hash password",
    category: "crypto-encoding",
    bunApi: "await Bun.password.hash(pw, { algorithm: 'argon2id' })",
    browserFallback: "Web Crypto PBKDF2-SHA-256 demo digest (server hashes in prod)",
    snippet: "const hash = await Bun.password.hash(password);",
    summary: "Hashes and verifies passwords with Argon2id/bcrypt natively under Bun.",
    interactive: true,
  },
  {
    id: "generate-uuid",
    title: "Generate UUID",
    category: "crypto-encoding",
    bunApi: "Bun.randomUUIDv7()",
    browserFallback: "RFC 9562 monotonic UUIDv7 via crypto.getRandomValues()",
    snippet: "const id = Bun.randomUUIDv7();",
    summary: "Generates time-ordered monotonic UUIDv7 identifiers for request/event tracing.",
    interactive: true,
  },
  {
    id: "base64-encoding",
    title: "Base64 encoding",
    category: "crypto-encoding",
    bunApi: "Buffer.from(text).toString('base64') / atob / btoa",
    browserFallback: "UTF-8 TextEncoder/TextDecoder + btoa/atob",
    snippet: "const b64 = Buffer.from(text, 'utf8').toString('base64');",
    summary: "UTF-8 safe Base64 encode and decode across browser and Bun runtimes.",
    interactive: true,
  },
  {
    id: "gzip-compression",
    title: "Gzip compression",
    category: "compression",
    bunApi: "Bun.gzipSync(bytes) / Bun.gunzipSync(bytes)",
    browserFallback: "Web CompressionStream('gzip')",
    snippet: "const gz = Bun.gzipSync(new TextEncoder().encode(payload));",
    summary: "Compresses byte payloads with GZIP framing and measures ratio.",
    interactive: true,
  },
  {
    id: "deflate-compression",
    title: "DEFLATE compression",
    category: "compression",
    bunApi: "Bun.deflateSync(bytes) / Bun.inflateSync(bytes)",
    browserFallback: "Web CompressionStream('deflate-raw')",
    snippet: "const raw = Bun.deflateSync(new TextEncoder().encode(payload));",
    summary: "Compresses byte payloads with raw DEFLATE (zero zlib/gzip header overhead).",
    interactive: true,
  },
  {
    id: "escape-html",
    title: "Escape HTML",
    category: "strings-equality",
    bunApi: "Bun.escapeHTML(input)",
    browserFallback: "Pure HTML entity escaper (&, <, >, \", ')",
    snippet: "const safe = Bun.escapeHTML('<script>alert(1)</script>');",
    summary: "SIMD-accelerated HTML entity escaping for safe text rendering.",
    interactive: true,
  },
  {
    id: "deep-equality",
    title: "Deep equality",
    category: "strings-equality",
    bunApi: "Bun.deepEquals(a, b, strict)",
    browserFallback: "Structural deep comparator (strict & non-strict modes)",
    snippet: "Bun.deepEquals({ a: 1 }, { a: 1, b: undefined }, true);",
    summary: "Compares nested objects/arrays structurally with optional strict undefined checks.",
    interactive: true,
  },
  {
    id: "sleep",
    title: "Sleep",
    category: "runtime",
    bunApi: "await Bun.sleep(ms) / Bun.sleepSync(ms)",
    browserFallback: "Promise setTimeout(resolve, ms)",
    snippet: "await Bun.sleep(150);",
    summary: "Suspends async execution for a bounded millisecond duration.",
    interactive: true,
  },
  {
    id: "file-url-to-path",
    title: "File URL to path",
    category: "paths-shell",
    bunApi: "Bun.fileURLToPath('file:///app/server.ts')",
    browserFallback: "Cross-runtime RFC 8089 file:// URI decoder",
    snippet: "const path = Bun.fileURLToPath('file:///app/server.ts');",
    summary: "Converts a file:// URL into a decoded local filesystem path.",
    interactive: true,
  },
  {
    id: "path-to-file-url",
    title: "Path to file URL",
    category: "paths-shell",
    bunApi: "Bun.pathToFileURL('/app/server.ts')",
    browserFallback: "Cross-runtime POSIX/Windows path-to-file:// encoder",
    snippet: "const url = Bun.pathToFileURL('/app/server.ts');",
    summary: "Converts an absolute filesystem path into a canonical file:// URL.",
    interactive: true,
  },
  {
    id: "find-executable-path",
    title: "Find executable path",
    category: "paths-shell",
    bunApi: "Bun.which('bun')",
    browserFallback: "Unavailable in browser sandbox (allowlisted binaries on Bun)",
    snippet: "const bin = Bun.which('bun');",
    summary: "Resolves an allowlisted executable's absolute PATH location natively under Bun.",
    interactive: true,
  },
  {
    id: "import-meta-dir",
    title: "import.meta.dir",
    category: "module-meta",
    bunApi: "import.meta.dir",
    browserFallback: "Derived directory from import.meta.url",
    snippet: "console.log(import.meta.dir);",
    summary: "Directory path containing the current ES module.",
    interactive: true,
  },
  {
    id: "import-meta-file",
    title: "import.meta.file",
    category: "module-meta",
    bunApi: "import.meta.file",
    browserFallback: "Derived filename from import.meta.url",
    snippet: "console.log(import.meta.file);",
    summary: "File name of the current ES module.",
    interactive: true,
  },
  {
    id: "import-meta-path",
    title: "import.meta.path",
    category: "module-meta",
    bunApi: "import.meta.path",
    browserFallback: "Derived pathname from import.meta.url",
    snippet: "console.log(import.meta.path);",
    summary: "Full absolute path (or bundled URL path) of the current module.",
    interactive: true,
  },
  {
    id: "check-entrypoint",
    title: "Check entrypoint",
    category: "module-meta",
    bunApi: "import.meta.main",
    browserFallback: "false in browser SPA modules",
    snippet: "if (import.meta.main) { startServer(); }",
    summary: "Reports whether the current module was invoked directly as the entrypoint.",
    interactive: true,
  },
  {
    id: "get-entrypoint-path",
    title: "Get entrypoint path",
    category: "module-meta",
    bunApi: "Bun.main",
    browserFallback: "window.location.pathname in browser SPA",
    snippet: "console.log(Bun.main);",
    summary: "Absolute path to the program's main entrypoint script under Bun.",
    interactive: true,
  },
])

export type SpaDecoupleMode =
  | "local-4022-spa"
  | "decoupled-origin"
  | "query-override"
  | "override-rejected"

export interface SpaDecoupleStatus {
  readonly mode: SpaDecoupleMode
  readonly spaOrigin: string
  readonly spaPort: string
  readonly apiBaseUrl: string
  readonly apiSource: "explicit" | "query-override" | "config" | "window-origin" | "fallback"
  readonly isDecoupled: boolean
  readonly isLocalDev: boolean
  readonly patternsCompiled: boolean
  readonly maxInputLength: number
  readonly overrideInspection: ApiBaseValidation | null
  readonly bun: BunGlobalSnapshot
  readonly badgeSuffix: string | null
  readonly summary: string
}

interface BunUtilitiesRuntimeGlobal {
  readonly Bun?: {
    readonly version?: string
    readonly revision?: string
    readonly main?: string
    readonly randomUUIDv7?: (encoding?: "hex", timestamp?: number) => string
    readonly gzipSync?: (data: Uint8Array) => Uint8Array
    readonly deflateSync?: (data: Uint8Array) => Uint8Array
    readonly escapeHTML?: (value: string) => string
    readonly deepEquals?: (a: unknown, b: unknown, strict?: boolean) => boolean
    readonly sleep?: (ms: number) => Promise<void>
    readonly fileURLToPath?: (url: string | URL) => string
    readonly pathToFileURL?: (path: string) => URL
    readonly which?: (bin: string) => string | null
    readonly password?: {
      readonly hash?: (password: string, options?: { readonly algorithm?: string }) => Promise<string>
    }
  }
}

function getBunRuntimeObj(): BunUtilitiesRuntimeGlobal["Bun"] {
  return (globalThis as unknown as BunUtilitiesRuntimeGlobal).Bun
}

/**
 * Resolves the decoupling relationship between the browser SPA origin (historically
 * assumed to be `:4022`) and the active validated API base URL, alongside live
 * `URLPattern` startup compilation and Bun runtime detection state.
 */
export function resolveSpaDecoupleStatus(
  win?: DashboardWindowLocationLike | null,
): SpaDecoupleStatus {
  const effectiveWin =
    win === undefined
      ? ((globalThis as unknown as { window?: DashboardWindowLocationLike }).window ?? null)
      : win
  const isLocalDev = isLocalDevLocation(effectiveWin)
  const overrideInspection = inspectApiBaseOverride(effectiveWin, isLocalDev)
  const { baseUrl, source } = resolveDashboardBaseUrl(null, effectiveWin)
  const spaOrigin =
    effectiveWin?.location?.origin && effectiveWin.location.origin !== "null"
      ? effectiveWin.location.origin
      : baseUrl.origin

  let spaPort = ""
  try {
    const parsedSpa = new URL(spaOrigin)
    spaPort = parsedSpa.port || (parsedSpa.protocol === "https:" ? "443" : "80")
  } catch {
    spaPort = ""
  }

  const normalizedApiBase = `${baseUrl.protocol}//${baseUrl.host}${baseUrl.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "")}`
  const isDecoupled = baseUrl.origin !== spaOrigin || spaPort !== "4022"
  const bun = readBunGlobals()
  const patternsCompiled = hasCompiledApiBasePatterns()

  let mode: SpaDecoupleMode = "local-4022-spa"
  let badgeSuffix: string | null = null
  let summary = `SPA bound on ${spaOrigin} -> API ${normalizedApiBase} (${source})`

  if (overrideInspection && !overrideInspection.ok) {
    mode = "override-rejected"
    badgeSuffix = `apiBase blocked (${overrideInspection.code})`
    summary = `Rejected untrusted ?apiBase= override (${overrideInspection.code}); fell back to ${normalizedApiBase}.`
  } else if (source === "query-override") {
    mode = "query-override"
    badgeSuffix = `API ${baseUrl.host}`
    summary = `Decoupled via validated ?apiBase= -> ${normalizedApiBase}`
  } else if (isDecoupled) {
    mode = "decoupled-origin"
    badgeSuffix = spaPort ? `:${spaPort} decoupled` : baseUrl.host
    summary = `Decoupled SPA (${spaOrigin}) talking to ${normalizedApiBase} (${source})`
  }

  return {
    mode,
    spaOrigin,
    spaPort,
    apiBaseUrl: normalizedApiBase,
    apiSource: source,
    isDecoupled,
    isLocalDev,
    patternsCompiled,
    maxInputLength: MAX_API_BASE_INPUT,
    overrideInspection,
    bun,
    badgeSuffix,
    summary,
  }
}

/** Generate a time-ordered UUIDv7 via `Bun.randomUUIDv7()` or RFC 9562 Web Crypto fallback. */
export function generateUuidV7(timestampMs: number = Date.now()): string {
  const bun = getBunRuntimeObj()
  if (typeof bun?.randomUUIDv7 === "function") {
    try {
      return bun.randomUUIDv7("hex", timestampMs)
    } catch {
      // fall through
    }
  }

  const bytes = new Uint8Array(16)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }

  const ts = BigInt(Math.max(0, Math.trunc(timestampMs)))
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70 // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC 4122 variant

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** UTF-8 safe Base64 encode across Bun and browsers. */
export function encodeBase64Utf8(input: string): string {
  const bytes = new TextEncoder().encode(input)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/** UTF-8 safe Base64 decode across Bun and browsers. */
export function decodeBase64Utf8(encoded: string): string {
  const binary = atob(encoded.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

export interface CompressionProbeResult {
  readonly algorithm: "gzip" | "deflate-raw"
  readonly engine: "bun-native" | "web-compression-stream" | "unavailable"
  readonly inputBytes: number
  readonly outputBytes: number
  readonly ratioPct: number
  readonly previewBase64: string
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

async function compressWithStream(
  bytes: Uint8Array,
  format: "gzip" | "deflate-raw",
): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== "function") return null
  try {
    const cs = new CompressionStream(format)
    const writer = cs.writable.getWriter()
    await writer.write(bytes as unknown as BufferSource)
    await writer.close()
    const outBuf = await new Response(cs.readable).arrayBuffer()
    return new Uint8Array(outBuf)
  } catch {
    return null
  }
}

/** Compress UTF-8 text via `Bun.gzipSync` or Web `CompressionStream('gzip')`. */
export async function compressGzipText(input: string): Promise<CompressionProbeResult> {
  const raw = new TextEncoder().encode(input)
  const bun = getBunRuntimeObj()
  if (typeof bun?.gzipSync === "function") {
    const out = bun.gzipSync(raw)
    return {
      algorithm: "gzip",
      engine: "bun-native",
      inputBytes: raw.byteLength,
      outputBytes: out.byteLength,
      ratioPct: raw.byteLength > 0 ? Math.round((out.byteLength / raw.byteLength) * 1000) / 10 : 0,
      previewBase64: bytesToBase64(out).slice(0, 64),
    }
  }
  const streamed = await compressWithStream(raw, "gzip")
  if (streamed) {
    return {
      algorithm: "gzip",
      engine: "web-compression-stream",
      inputBytes: raw.byteLength,
      outputBytes: streamed.byteLength,
      ratioPct:
        raw.byteLength > 0 ? Math.round((streamed.byteLength / raw.byteLength) * 1000) / 10 : 0,
      previewBase64: bytesToBase64(streamed).slice(0, 64),
    }
  }
  return {
    algorithm: "gzip",
    engine: "unavailable",
    inputBytes: raw.byteLength,
    outputBytes: 0,
    ratioPct: 0,
    previewBase64: "",
  }
}

/** Compress UTF-8 text via `Bun.deflateSync` or Web `CompressionStream('deflate-raw')`. */
export async function compressDeflateText(input: string): Promise<CompressionProbeResult> {
  const raw = new TextEncoder().encode(input)
  const bun = getBunRuntimeObj()
  if (typeof bun?.deflateSync === "function") {
    const out = bun.deflateSync(raw)
    return {
      algorithm: "deflate-raw",
      engine: "bun-native",
      inputBytes: raw.byteLength,
      outputBytes: out.byteLength,
      ratioPct: raw.byteLength > 0 ? Math.round((out.byteLength / raw.byteLength) * 1000) / 10 : 0,
      previewBase64: bytesToBase64(out).slice(0, 64),
    }
  }
  const streamed = await compressWithStream(raw, "deflate-raw")
  if (streamed) {
    return {
      algorithm: "deflate-raw",
      engine: "web-compression-stream",
      inputBytes: raw.byteLength,
      outputBytes: streamed.byteLength,
      ratioPct:
        raw.byteLength > 0 ? Math.round((streamed.byteLength / raw.byteLength) * 1000) / 10 : 0,
      previewBase64: bytesToBase64(streamed).slice(0, 64),
    }
  }
  return {
    algorithm: "deflate-raw",
    engine: "unavailable",
    inputBytes: raw.byteLength,
    outputBytes: 0,
    ratioPct: 0,
    previewBase64: "",
  }
}

/** Escape HTML entities via `Bun.escapeHTML()` or pure RFC fallback. */
export function escapeHtmlSafe(input: string): string {
  const bun = getBunRuntimeObj()
  if (typeof bun?.escapeHTML === "function") {
    try {
      return bun.escapeHTML(input)
    } catch {
      // fall through
    }
  }
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
}

/** Deep structural equality matching `Bun.deepEquals(a, b, strict)`. */
export function deepEqualsSafe(a: unknown, b: unknown, strict = false): boolean {
  const bun = getBunRuntimeObj()
  if (typeof bun?.deepEquals === "function") {
    try {
      return bun.deepEquals(a, b, strict)
    } catch {
      // fall through
    }
  }
  if (Object.is(a, b)) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualsSafe(a[i], b[i], strict)) return false
    }
    return true
  }
  const recA = a as Record<string, unknown>
  const recB = b as Record<string, unknown>
  const keysA = Object.keys(recA).filter((k) => strict || recA[k] !== undefined)
  const keysB = Object.keys(recB).filter((k) => strict || recB[k] !== undefined)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (strict && !Object.prototype.hasOwnProperty.call(recB, k)) return false
    if (!deepEqualsSafe(recA[k], recB[k], strict)) return false
  }
  return true
}

/** Bounded async sleep via `Bun.sleep(ms)` or `setTimeout`, clamped to `0..2000ms`. */
export async function sleepMs(rawMs: number): Promise<number> {
  const ms = Math.max(0, Math.min(2000, Math.trunc(Number.isFinite(rawMs) ? rawMs : 0)))
  const start = performance.now()
  const bun = getBunRuntimeObj()
  if (typeof bun?.sleep === "function") {
    await bun.sleep(ms)
  } else {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms)
    })
  }
  return Math.round((performance.now() - start) * 10) / 10
}

/** Convert a `file://` URL to a local filesystem path via `Bun.fileURLToPath` or pure decoder. */
export function fileUrlToPathSafe(input: string): string {
  const trimmed = input.trim()
  const bun = getBunRuntimeObj()
  if (typeof bun?.fileURLToPath === "function") {
    return bun.fileURLToPath(trimmed)
  }
  const parsed = new URL(trimmed)
  if (parsed.protocol !== "file:") {
    throw new TypeError("URL must use file: protocol")
  }
  const decoded = decodeURIComponent(parsed.pathname)
  if (/^\/[A-Za-z]:\//.test(decoded)) {
    return decoded.slice(1)
  }
  return decoded
}

/** Convert an absolute path to a `file://` URL via `Bun.pathToFileURL` or pure encoder. */
export function pathToFileUrlSafe(input: string): string {
  const trimmed = input.trim()
  if (trimmed === "") {
    throw new TypeError("Path cannot be empty")
  }
  const bun = getBunRuntimeObj()
  if (typeof bun?.pathToFileURL === "function") {
    return bun.pathToFileURL(trimmed).href
  }
  const normalized = trimmed.replace(/\\/g, "/")
  const withLeading = normalized.startsWith("/") ? normalized : `/${normalized}`
  const encodedSegments = withLeading
    .split("/")
    .map((seg, idx) => (idx === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join("/")
  return `file://${encodedSegments}`
}

const ALLOWED_WHICH_BINS = new Set(["bun", "node", "git", "sh", "tsc"])

/**
 * Safely probes `Bun.which(bin)` for a fixed allowlist of read-only developer
 * tool names (never passes arbitrary strings to PATH lookups).
 */
export function findAllowlistedExecutable(bin: string): {
  readonly bin: string
  readonly allowed: boolean
  readonly resolvedPath: string | null
  readonly runtime: "bun" | "browser-sandbox"
} {
  const clean = bin.trim().toLowerCase()
  if (!ALLOWED_WHICH_BINS.has(clean)) {
    return {
      bin: clean,
      allowed: false,
      resolvedPath: null,
      runtime: isBunRuntime() ? "bun" : "browser-sandbox",
    }
  }
  const bun = getBunRuntimeObj()
  if (typeof bun?.which === "function") {
    return {
      bin: clean,
      allowed: true,
      resolvedPath: bun.which(clean) ?? null,
      runtime: "bun",
    }
  }
  return {
    bin: clean,
    allowed: true,
    resolvedPath: null,
    runtime: "browser-sandbox",
  }
}

export interface ModuleMetaSnapshot {
  readonly importMetaUrl: string
  readonly importMetaDir: string
  readonly importMetaFile: string
  readonly importMetaPath: string
  readonly importMetaMain: boolean
  readonly bunMain: string | null
}

/**
 * Inspects `import.meta.dir`, `import.meta.file`, `import.meta.path`,
 * `import.meta.main`, and `Bun.main` with graceful browser-URL derivation.
 */
export function inspectModuleMetaSnapshot(): ModuleMetaSnapshot {
  const meta = import.meta as unknown as {
    readonly url?: string
    readonly dir?: string
    readonly file?: string
    readonly path?: string
    readonly main?: boolean
  }
  const urlStr = typeof meta.url === "string" ? meta.url : ""
  let derivedPath = ""
  try {
    derivedPath = urlStr ? new URL(urlStr).pathname : ""
  } catch {
    derivedPath = urlStr
  }
  const lastSlash = derivedPath.lastIndexOf("/")
  const derivedDir = lastSlash > 0 ? derivedPath.slice(0, lastSlash) : "/"
  const derivedFile = lastSlash >= 0 ? derivedPath.slice(lastSlash + 1) : derivedPath

  const bun = getBunRuntimeObj()
  return {
    importMetaUrl: urlStr,
    importMetaDir: typeof meta.dir === "string" ? meta.dir : derivedDir,
    importMetaFile: typeof meta.file === "string" ? meta.file : derivedFile,
    importMetaPath: typeof meta.path === "string" ? meta.path : derivedPath,
    importMetaMain: typeof meta.main === "boolean" ? meta.main : false,
    bunMain: typeof bun?.main === "string" ? bun.main : null,
  }
}

/**
 * Demonstrates password hashing using `Bun.password.hash` (Argon2id) under Bun,
 * or a browser-only Web Crypto PBKDF2-SHA-256 preview (production password
 * hashing always executes server-side).
 */
export async function hashPasswordPreview(sampleInput: string): Promise<{
  readonly algorithm: string
  readonly hash: string
  readonly serverSideNote: string
}> {
  const bun = getBunRuntimeObj()
  if (typeof bun?.password?.hash === "function") {
    const hash = await bun.password.hash(sampleInput, { algorithm: "argon2id" })
    return {
      algorithm: "argon2id (Bun.password.hash)",
      hash,
      serverSideNote: "Native Bun.password.hash executed in runtime.",
    }
  }

  if (typeof crypto !== "undefined" && crypto.subtle) {
    const enc = new TextEncoder()
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(sampleInput),
      "PBKDF2",
      false,
      ["deriveBits"],
    )
    const derived = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      keyMaterial,
      256,
    )
    const saltHex = Array.from(salt, (b) => b.toString(16).padStart(2, "0")).join("")
    const hashHex = Array.from(new Uint8Array(derived), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    )
    return {
      algorithm: "PBKDF2-SHA256 (Web Crypto preview)",
      hash: `$pbkdf2-sha256$i=100000$${saltHex}$${hashHex}`,
      serverSideNote: "Browser preview only — real password hashing runs server-side with Bun.password.hash.",
    }
  }

  return {
    algorithm: "unavailable",
    hash: "",
    serverSideNote: "Web Crypto unavailable; use Bun.password.hash() on the server.",
  }
}

export interface BunRuntimeReleaseEnhancement {
  readonly id: string
  readonly area: "Bundler" | "bun test" | "Runtime" | "Security" | "Types"
  readonly title: string
  readonly detail: string
}

/**
 * Curated Bun runtime release guarantees relevant to SportsDesk Ops
 * compiled builds, isolated tests, streaming I/O, and S3/R2 endpoint hardening.
 */
export const BUN_RUNTIME_RELEASE_ENHANCEMENTS: readonly BunRuntimeReleaseEnhancement[] =
  Object.freeze([
    {
      id: "pre-encoded-text-imports",
      area: "Bundler",
      title: 'Zero-copy with { type: "text" } imports',
      detail:
        "Compiled executables embed text imports once in pre-encoded form—no startup module parse or heap copy (3 MB ASCII: ~3 MB binary, ~1 MB RAM).",
    },
    {
      id: "esm-node-addon-fix",
      area: "Bundler",
      title: "ESM .node addon bundling fix",
      detail: 'import addon from "./x.node" no longer throws __require is not defined in ESM bundles.',
    },
    {
      id: "test-isolate-no-leak",
      area: "bun test",
      title: "bun test --isolate flat memory & env isolation",
      detail:
        "Mocks, spyOn, mock.module, Bun.plugin, process.env.TZ, proxy, TLS settings, and monitorEventLoopDelay() no longer leak across files.",
    },
    {
      id: "s3-endpoint-new-url",
      area: "Security",
      title: "Hardened Bun.S3Client endpoint parsing",
      detail:
        "Bun.S3Client endpoint parsing matches new URL(), paired with SealedR2Handle's strict HTTPS/backslash/length checks.",
    },
    {
      id: "oom-error-code",
      area: "Runtime",
      title: "ERR_MEMORY_ALLOCATION_FAILED on text reads",
      detail:
        "Blob.text(), Response.text(), and TextDecoder.decode() throw ERR_MEMORY_ALLOCATION_FAILED on OOM, matching Node.",
    },
    {
      id: "compile-cache-isolation",
      area: "Security",
      title: "Compiled binaries ignore NODE_COMPILE_CACHE",
      detail:
        "bun build --compile executables ignore NODE_COMPILE_CACHE from the environment; permessage-deflate WS uses ~12 KB less RAM/conn.",
    },
    {
      id: "text-decoder-labels",
      area: "Types",
      title: 'Full TextDecoder labels (e.g. "windows-1251")',
      detail:
        "@types/bun accepts every WHATWG TextDecoder encoding label the runtime supports, plus faster ReadableStream.from() & async-iterable Response bodies.",
    },
  ])

export function isMemoryAllocationError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = (error as { readonly code?: unknown }).code
  return code === "ERR_MEMORY_ALLOCATION_FAILED"
}

export type SafeTextDecodeResult =
  | { readonly ok: true; readonly encoding: string; readonly text: string }
  | { readonly ok: false; readonly code: "ERR_MEMORY_ALLOCATION_FAILED" | "ERR_TEXT_DECODE_FAILED"; readonly error: string }

/**
 * Decodes raw bytes using any runtime-supported `TextDecoder` label (e.g.
 * `"utf-8"`, `"windows-1251"`, `"iso-8859-1"`) and surfaces
 * `ERR_MEMORY_ALLOCATION_FAILED` explicitly when allocation fails.
 */
export function safeDecodeTextBytes(
  bytes: Uint8Array,
  encoding: string = "utf-8",
): SafeTextDecodeResult {
  try {
    const decoder = new TextDecoder(encoding)
    return {
      ok: true,
      encoding: decoder.encoding,
      text: decoder.decode(bytes),
    }
  } catch (err) {
    return {
      ok: false,
      code: isMemoryAllocationError(err) ? "ERR_MEMORY_ALLOCATION_FAILED" : "ERR_TEXT_DECODE_FAILED",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Reads a `Blob` or `Response` body as UTF-8 text while classifying
 * `ERR_MEMORY_ALLOCATION_FAILED` explicitly.
 */
export async function safeReadBlobText(
  source: Pick<Blob, "text">,
): Promise<
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: "ERR_MEMORY_ALLOCATION_FAILED" | "ERR_TEXT_READ_FAILED"; readonly error: string }
> {
  try {
    const text = await source.text()
    return { ok: true, text }
  } catch (err) {
    return {
      ok: false,
      code: isMemoryAllocationError(err) ? "ERR_MEMORY_ALLOCATION_FAILED" : "ERR_TEXT_READ_FAILED",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

