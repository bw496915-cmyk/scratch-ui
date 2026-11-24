/**
 * Pure TypeScript implementation of Bun's `.npmrc` configuration parser, multi-layer precedence
 * resolver, npm/Bun credential matcher, and `bunfig.toml` migration generator. Zero Node.js runtime
 * dependencies so it executes identically on the server (Bun/Node) and in the browser (Status &
 * Config Dashboard). Security invariants:
 *
 * - Rejects any credential containing CR (`\r`), LF (`\n`), or NUL (`\0`).
 * - Rejects non-`http:` / non-`https:` registry URLs before any request.
 * - Never sends a registry's credentials to a different origin; cross-origin tarballs and
 *   `publishConfig.registry` receive `.npmrc` credentials ONLY over `https:` and ONLY when
 *   project-named (never for transitive tarballs).
 * - Public redaction helpers (`redactResolvedBunPackageConfig`, `auditRegistryCredentialMatch`) strip
 *   all secret values before returning snapshots to HTTP responses or UI state.
 *
 * @file Packages/contracts/src/npmrc.ts
 */

import { type BunLockFile, type BunLockFileSummary, summarizeBunLockFile } from "./bun_lockfile.ts"

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/" as const

export const ERR_NPMRC_INVALID_SCHEME = "ERR_NPMRC_INVALID_SCHEME" as const
export const ERR_NPMRC_INVALID_CREDENTIAL = "ERR_NPMRC_INVALID_CREDENTIAL" as const

export type DependencyOmitKind = "dev" | "peer" | "optional"
export type NpmrcInstallStrategy = "hoisted" | "linked"
export type NpmrcNodeLinker = "isolated" | "hoisted" | "pnpm" | "node-modules"
export type NormalizedNodeLinker = "hoisted" | "isolated"
export type BunInstallAutoMode = "auto" | "force" | "disable" | "fallback"
export type BunLockfilePrintFormat = "yarn"
export type BunRunShellMode = "system" | "bun"

export type ConfigLayerSource =
  | "default"
  | "bun-lockfile"
  | "user-npmrc"
  | "project-npmrc"
  | "global-bunfig"
  | "project-bunfig"
  | "env"
  | "cli"

export interface NpmrcRegistryAuthEntry {
  readonly prefix: string
  readonly authToken?: string | undefined
  readonly authTokenEnvRef?: string | undefined
  readonly username?: string | undefined
  readonly passwordBase64?: string | undefined
  readonly passwordEnvRef?: string | undefined
  readonly rawAuth?: string | undefined
  readonly rawAuthEnvRef?: string | undefined
  /** Accepted and ignored as npm does. */
  readonly email?: string | undefined
  readonly source: ConfigLayerSource
}

export interface NpmrcParseWarning {
  readonly line: number
  readonly key: string
  readonly message: string
}

export interface ParsedNpmrcFile {
  readonly source: ConfigLayerSource
  readonly filePath?: string | undefined
  readonly baseDir?: string | undefined
  readonly registry?: string | undefined
  readonly registryFromNpmrc?: boolean | undefined
  readonly scopes: Readonly<Record<string, string>>
  readonly registryAuth: Readonly<Record<string, NpmrcRegistryAuthEntry>>
  readonly linkWorkspacePackages?: boolean | undefined
  readonly saveExact?: boolean | undefined
  readonly ignoreScripts?: boolean | undefined
  readonly dryRun?: boolean | undefined
  readonly cache?:
    | {
        readonly disable: boolean
        readonly dir: string | null
        readonly rawValue: string
      }
    | undefined
  readonly ca?: readonly string[] | undefined
  readonly cafile?: string | undefined
  readonly hasCaDirective: boolean
  readonly omit: readonly DependencyOmitKind[]
  readonly include: readonly DependencyOmitKind[]
  readonly installStrategy?: NpmrcInstallStrategy | undefined
  readonly nodeLinker?: NpmrcNodeLinker | undefined
  readonly publicHoistPattern?: readonly string[] | undefined
  readonly hoistPattern?: readonly string[] | undefined
  readonly hoist?: boolean | undefined
  readonly warnings: readonly NpmrcParseWarning[]
}

export interface ParsedBunfigScopeEntry {
  readonly url: string
  readonly token?: string | undefined
  readonly username?: string | undefined
  readonly password?: string | undefined
}

export interface ParsedBunfigInstallConfig {
  readonly source: "global-bunfig" | "project-bunfig"
  readonly filePath?: string | undefined
  readonly registry?:
    | string
    | {
        readonly url: string
        readonly token?: string | undefined
        readonly username?: string | undefined
        readonly password?: string | undefined
      }
    | undefined
  readonly scopes?: Readonly<Record<string, string | ParsedBunfigScopeEntry>> | undefined
  readonly optional?: boolean | undefined
  readonly dev?: boolean | undefined
  readonly peer?: boolean | undefined
  readonly production?: boolean | undefined
  readonly linkWorkspacePackages?: boolean | undefined
  readonly exact?: boolean | undefined
  readonly frozenLockfile?: boolean | undefined
  readonly saveTextLockfile?: boolean | undefined
  readonly auto?: BunInstallAutoMode | undefined
  readonly ignoreScripts?: boolean | undefined
  readonly dryRun?: boolean | undefined
  readonly cache?:
    | {
        readonly dir?: string | undefined
        readonly disable?: boolean | undefined
        readonly disableManifest?: boolean | undefined
      }
    | undefined
  readonly lockfile?:
    | {
        readonly save?: boolean | undefined
        readonly print?: BunLockfilePrintFormat | undefined
      }
    | undefined
  readonly security?:
    | {
        readonly scanner?: string | undefined
      }
    | undefined
  readonly ca?: readonly string[] | undefined
  readonly cafile?: string | undefined
  readonly linker?: NormalizedNodeLinker | undefined
  readonly globalStore?: boolean | undefined
  readonly globalDir?: string | undefined
  readonly globalBinDir?: string | undefined
  readonly minimumReleaseAge?: string | number | undefined
  readonly minimumReleaseAgeExcludes?: readonly string[] | undefined
  readonly publicHoistPattern?: readonly string[] | undefined
  readonly hoistPattern?: readonly string[] | undefined
  readonly run?:
    | {
        readonly shell?: BunRunShellMode | undefined
        readonly bun?: boolean | undefined
        readonly silent?: boolean | undefined
        readonly noOrphans?: boolean | undefined
      }
    | undefined
}

export interface BunCliInstallFlags {
  readonly registry?: string | undefined
  readonly ca?: readonly string[] | undefined
  readonly cafile?: string | undefined
  readonly ignoreScripts?: boolean | undefined
  readonly dryRun?: boolean | undefined
  readonly exact?: boolean | undefined
  readonly linker?: NormalizedNodeLinker | undefined
}

export interface ResolveBunPackageConfigInput {
  readonly bunLockfile?: BunLockFile | null | undefined
  readonly userNpmrc?: ParsedNpmrcFile | null | undefined
  readonly projectNpmrc?: ParsedNpmrcFile | null | undefined
  readonly globalBunfig?: ParsedBunfigInstallConfig | null | undefined
  readonly projectBunfig?: ParsedBunfigInstallConfig | null | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly cli?: BunCliInstallFlags | null | undefined
}

export interface ResolvedInlineCredential {
  readonly token?: string | undefined
  readonly username?: string | undefined
  /** Plaintext password (from bunfig or URL user:pass@). */
  readonly password?: string | undefined
  readonly originSource: "npmrc-registry-url" | "bunfig" | "url" | "env-token"
}

export interface ResolvedRegistryTarget {
  readonly url: string
  readonly source: ConfigLayerSource
  readonly inlineCredential?: ResolvedInlineCredential | undefined
}

export interface ResolvedBunPackageConfig {
  readonly defaultRegistry: ResolvedRegistryTarget
  readonly scopes: Readonly<Record<string, ResolvedRegistryTarget>>
  readonly registryAuth: Readonly<Record<string, NpmrcRegistryAuthEntry>>
  readonly linkWorkspacePackages: boolean
  readonly saveExact: boolean
  readonly ignoreScripts: boolean
  readonly dryRun: boolean
  readonly installDeps: {
    readonly optional: boolean
    readonly dev: boolean
    readonly peer: boolean
    readonly production: boolean
  }
  readonly autoInstall: BunInstallAutoMode
  readonly lockfile: {
    readonly save: boolean
    readonly saveTextLockfile: boolean
    readonly frozenLockfile: boolean
    readonly print: BunLockfilePrintFormat | null
  }
  readonly cache: {
    readonly disabled: boolean
    readonly disableManifest: boolean
    readonly dir: string | null
    readonly source: ConfigLayerSource
  }
  readonly security: {
    readonly minimumReleaseAge: string | number | null
    readonly minimumReleaseAgeExcludes: readonly string[]
    readonly scanner: string | null
  }
  readonly globalInstall: {
    readonly globalStore: boolean
    readonly globalDir: string | null
    readonly globalBinDir: string | null
  }
  readonly run: {
    readonly shell: BunRunShellMode
    readonly bun: boolean
    readonly silent: boolean
    readonly noOrphans: boolean
  }
  readonly tls: {
    readonly cafile: string | null
    readonly ca: readonly string[]
    readonly source: ConfigLayerSource
  }
  readonly omittedDependencies: readonly DependencyOmitKind[]
  readonly linker: NormalizedNodeLinker
  readonly linkerSource: ConfigLayerSource
  readonly lockfileSummary?: BunLockFileSummary | null | undefined
  readonly publicHoistPattern: readonly string[]
  readonly hoistPattern: readonly string[]
  readonly hoist: boolean
  readonly envToken?: string | undefined
  readonly layersApplied: readonly ConfigLayerSource[]
  readonly warnings: readonly NpmrcParseWarning[]
}

export interface MatchedCredentialResult {
  readonly matched: boolean
  readonly scheme: "Bearer" | "Basic" | null
  /** Authorization header value (`Bearer ...` or `Basic ...`), or null. */
  readonly authorizationHeader: string | null
  readonly source: "bunfig" | "url" | "env-token" | "npmrc-prefix" | "npmrc-registry-url" | "none"
  readonly matchedPrefix: string | null
  readonly reason: string
}

export interface RedactedCredentialMatchAudit {
  readonly matched: boolean
  readonly scheme: "Bearer" | "Basic" | null
  readonly source: MatchedCredentialResult["source"]
  readonly matchedPrefix: string | null
  readonly reason: string
  readonly error?: string | undefined
}

export interface NpmrcLayerStatus {
  readonly layer: ConfigLayerSource
  readonly label: string
  readonly path: string | null
  readonly detected: boolean
  readonly activeKeys: readonly string[]
}

export interface RedactedNpmrcStatusSummary {
  readonly defaultRegistryUrl: string
  readonly defaultRegistrySource: ConfigLayerSource
  readonly defaultRegistryHasAuth: boolean
  readonly defaultRegistryAuthScheme: "Bearer" | "Basic" | null
  readonly scopes: readonly {
    readonly scope: string
    readonly registryUrl: string
    readonly source: ConfigLayerSource
    readonly hasAuth: boolean
    readonly authScheme: "Bearer" | "Basic" | null
    readonly matchedPrefix: string | null
  }[]
  readonly credentialPrefixes: readonly {
    readonly prefix: string
    readonly source: ConfigLayerSource
    readonly authKind: "bearer-token" | "basic-auth" | "username-password" | "none"
    readonly hasEmailIgnored: boolean
  }[]
  readonly options: {
    readonly linkWorkspacePackages: boolean
    readonly saveExact: boolean
    readonly ignoreScripts: boolean
    readonly dryRun: boolean
    readonly optional: boolean
    readonly dev: boolean
    readonly peer: boolean
    readonly production: boolean
    readonly autoInstall: BunInstallAutoMode
    readonly lockfileSave: boolean
    readonly saveTextLockfile: boolean
    readonly frozenLockfile: boolean
    readonly lockfilePrint: BunLockfilePrintFormat | null
    readonly cacheDisabled: boolean
    readonly cacheDisableManifest: boolean
    readonly cacheDir: string | null
    readonly minimumReleaseAge: string | number | null
    readonly minimumReleaseAgeExcludes: readonly string[]
    readonly securityScanner: string | null
    readonly globalStore: boolean
    readonly globalDir: string | null
    readonly globalBinDir: string | null
    readonly runShell: BunRunShellMode
    readonly runBun: boolean
    readonly runSilent: boolean
    readonly runNoOrphans: boolean
    readonly cafile: string | null
    readonly caCertCount: number
    readonly omittedDependencies: readonly DependencyOmitKind[]
    readonly linker: NormalizedNodeLinker
    readonly linkerSource: ConfigLayerSource
    readonly publicHoistPattern: readonly string[]
    readonly hoistPattern: readonly string[]
    readonly hoist: boolean
  }
  readonly lockfileSummary?: BunLockFileSummary | null | undefined
  readonly layers: readonly NpmrcLayerStatus[]
  readonly bunfigMigrationPreview: string
  readonly warnings: readonly NpmrcParseWarning[]
}

// ── Pure Path Helpers (zero node:path dependency) ─────────────────────────────

function normalizePosixPath(input: string): string {
  const isAbs = input.startsWith("/")
  const parts = input.split("/")
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop()
      } else if (!isAbs) {
        stack.push("..")
      }
    } else {
      stack.push(part)
    }
  }
  const joined = stack.join("/")
  if (isAbs) return `/${joined}`
  return joined || "."
}

/**
 * Resolve a path from `.npmrc` (`cache`, `cafile`) or `NPM_CONFIG_USERCONFIG`.
 *
 * - Expands leading `~/` (or `~`) to `homeDir`.
 * - Resolves relative paths against `baseDir`.
 */
export function resolveNpmrcPath(rawPath: string, baseDir?: string, homeDir?: string): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return ""
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    const home = (homeDir ?? "").replace(/\/+$/, "")
    const rest = trimmed === "~" ? "" : trimmed.slice(2)
    if (!home) return trimmed
    return rest ? normalizePosixPath(`${home}/${rest}`) : home
  }
  if (trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return trimmed.startsWith("/") ? normalizePosixPath(trimmed) : trimmed
  }
  if (!baseDir) {
    return normalizePosixPath(trimmed)
  }
  return normalizePosixPath(`${baseDir.replace(/\/+$/, "")}/${trimmed}`)
}

// ── Validation & Encoding Helpers ─────────────────────────────────────────────

/**
 * Throws `ERR_NPMRC_INVALID_CREDENTIAL` if a credential contains `\r`, `\n`, or `\0` (NUL byte) —
 * matching Bun's fail-closed header-injection guard.
 */
export function assertSafeCredentialValue(value: string, label = "credential"): void {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(
      `${ERR_NPMRC_INVALID_CREDENTIAL}: ${label} must not contain newline or NUL characters`,
    )
  }
}

/**
 * Validates that a registry URL uses `http:` or `https:`. Rejects other schemes or schemeless URLs
 * before any request.
 */
export function parseValidatedHttpUrl(rawUrl: string, label = "registry URL"): URL {
  const trimmed = rawUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(
      `${ERR_NPMRC_INVALID_SCHEME}: ${label} '${trimmed}' is missing a valid http/https scheme`,
    )
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `${ERR_NPMRC_INVALID_SCHEME}: ${label} '${trimmed}' uses unsupported scheme '${parsed.protocol}' (only http and https are allowed)`,
    )
  }
  return parsed
}

function encodeBase64Utf8(input: string): string {
  if (typeof btoa === "function") {
    const bytes = new TextEncoder().encode(input)
    let binary = ""
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]!)
    }
    return btoa(binary)
  }
  throw new Error("Base64 encoding unavailable in runtime")
}

function decodeBase64Utf8(input: string): string {
  if (typeof atob === "function") {
    const binary = atob(input)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder().decode(bytes)
  }
  return input
}

/** Strip embedded `user:pass@` from a URL so safe display URLs never leak creds. */
export function stripUrlCredentials(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    u.username = ""
    u.password = ""
    return u.toString()
  } catch {
    return rawUrl.replace(/\/\/[^/@]+@/, "//")
  }
}

/**
 * Normalize an `.npmrc` `//host/path/` credential prefix for lookup. Ensures leading `//` and
 * trailing `/`, lowercases host, and strips default ports only when a scheme is supplied for
 * lookup.
 */
export function normalizeNpmrcRegistryPrefix(rawPrefix: string): string {
  let clean = rawPrefix.trim()
  if (clean.startsWith("//")) {
    clean = clean.slice(2)
  }
  const slashIdx = clean.indexOf("/")
  const hostPort = (slashIdx === -1 ? clean : clean.slice(0, slashIdx)).toLowerCase()
  let pathPart = slashIdx === -1 ? "/" : clean.slice(slashIdx)
  if (!pathPart.endsWith("/")) {
    pathPart = `${pathPart}/`
  }
  return `//${hostPort}${pathPart}`
}

/**
 * Return candidate `.npmrc` prefixes for a validated `http:`/`https:` URL in exact npm/Bun matching
 * order: https://npm.example.com/team/a/ -> //npm.example.com/team/a/ //npm.example.com/team/
 * //npm.example.com/ Treats `:443` on `https:` and `:80` on `http:` identically to no port.
 */
export function buildRegistryCredentialLookupKeys(url: URL): readonly string[] {
  const host = url.hostname.toLowerCase()
  const isDefaultPort =
    url.port === "" ||
    (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80")

  const defaultPortNum = url.protocol === "https:" ? "443" : "80"
  const hostVariants: string[] = isDefaultPort
    ? [host, `${host}:${defaultPortNum}`]
    : [`${host}:${url.port}`]

  // Extract normalized path segments (dropping empty segments)
  const rawSegments = url.pathname.split("/").filter((seg) => seg.length > 0)

  const candidates: string[] = []
  for (let len = rawSegments.length; len >= 0; len -= 1) {
    const pathPart = len === 0 ? "/" : `/${rawSegments.slice(0, len).join("/")}/`
    for (const hv of hostVariants) {
      candidates.push(`//${hv}${pathPart}`)
    }
  }
  return candidates
}

// ── Syntax Helpers ────────────────────────────────────────────────────────────

/**
 * Bun/npm boolean semantics: `false`, `null`, `undefined`, and `0` turn an option off. Every other
 * value turns it on, including an empty string `""`, `1`, and `True`.
 */
export function parseNpmrcBoolean(rawValue: string): boolean {
  const lower = rawValue.trim().toLowerCase()
  if (lower === "false" || lower === "null" || lower === "undefined" || lower === "0") {
    return false
  }
  return true
}

/**
 * Expand `${NAME}` and `${NAME?}` environment variable placeholders.
 *
 * - `${NAME}`: replaced with `env[NAME]` when defined, otherwise left as-is.
 * - `${NAME?}`: replaced with `env[NAME]` when defined, otherwise `""`.
 */
export function expandNpmrcEnvVars(
  rawValue: string,
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  return rawValue.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(\?)?\}/g,
    (fullMatch, name: string, optionalMark?: string) => {
      const val = env[name]
      if (val !== undefined) {
        return val
      }
      return optionalMark === "?" ? "" : fullMatch
    },
  )
}

/**
 * Extract the `${ENV_NAME}` reference if the raw unexpanded value is a single env placeholder (used
 * safely for `bunfig.toml` migration templates).
 */
function extractEnvPlaceholderName(rawUnexpanded: string): string | undefined {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\??\}$/.exec(rawUnexpanded.trim())
  return match?.[1]
}

/**
 * Parse the raw value slice after `=` in an `.npmrc` line:
 *
 * - Quoted values (`"..."` or `'...'`) preserve `#` and `;` inside quotes and unescape `\n`, `\r`,
 *   `\t`, `\\`, `\"`, `\'`.
 * - Unquoted values end at the first unescaped `;` or `#`; `\;` and `\#` keep literal characters;
 *   surrounding whitespace is stripped.
 */
function parseNpmrcRawValue(rawAfterEq: string): string {
  const trimmedLeft = rawAfterEq.trimStart()
  if (trimmedLeft === "") return ""

  const firstChar = trimmedLeft[0]
  if (firstChar === '"' || firstChar === "'") {
    let out = ""
    let i = 1
    let closed = false
    while (i < trimmedLeft.length) {
      const ch = trimmedLeft[i]!
      if (ch === "\\" && i + 1 < trimmedLeft.length) {
        const next = trimmedLeft[i + 1]!
        if (next === "n") out += "\n"
        else if (next === "r") out += "\r"
        else if (next === "t") out += "\t"
        else if (next === "\\" || next === firstChar || next === ";" || next === "#") {
          out += next
        } else {
          out += `\\${next}`
        }
        i += 2
        continue
      }
      if (ch === firstChar) {
        closed = true
        break
      }
      out += ch
      i += 1
    }
    if (closed) {
      return out
    }
  }

  let out = ""
  let i = 0
  while (i < trimmedLeft.length) {
    const ch = trimmedLeft[i]!
    if (ch === "\\" && i + 1 < trimmedLeft.length) {
      const next = trimmedLeft[i + 1]!
      if (next === ";" || next === "#") {
        out += next
        i += 2
        continue
      }
    }
    if (ch === ";" || ch === "#") {
      break
    }
    out += ch
    i += 1
  }
  return out.trim()
}

function isDependencyOmitKind(val: string): val is DependencyOmitKind {
  return val === "dev" || val === "peer" || val === "optional"
}

function normalizeNodeLinkerValue(
  installStrategy?: NpmrcInstallStrategy,
  nodeLinker?: NpmrcNodeLinker,
): NormalizedNodeLinker | undefined {
  if (nodeLinker) {
    if (nodeLinker === "isolated" || nodeLinker === "pnpm") return "isolated"
    if (nodeLinker === "hoisted" || nodeLinker === "node-modules") {
      return "hoisted"
    }
  }
  if (installStrategy) {
    return installStrategy === "linked" ? "isolated" : "hoisted"
  }
  return undefined
}

// ── Main .npmrc Parser ────────────────────────────────────────────────────────

export interface ParseNpmrcOptions {
  readonly source?: ConfigLayerSource | undefined
  readonly filePath?: string | undefined
  readonly baseDir?: string | undefined
  readonly homeDir?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

export function parseNpmrc(rawText: string, options: ParseNpmrcOptions = {}): ParsedNpmrcFile {
  const source = options.source ?? "project-npmrc"
  const env = options.env ?? {}
  const scopes: Record<string, string> = {}
  const registryAuth: Record<string, NpmrcRegistryAuthEntry> = {}
  const warnings: NpmrcParseWarning[] = []

  let registry: string | undefined
  let linkWorkspacePackages: boolean | undefined
  let saveExact: boolean | undefined
  let ignoreScripts: boolean | undefined
  let dryRun: boolean | undefined
  let cache:
    | { readonly disable: boolean; readonly dir: string | null; readonly rawValue: string }
    | undefined
  const caList: string[] = []
  let cafile: string | undefined
  let hasCaDirective = false
  const omitSet = new Set<DependencyOmitKind>()
  const includeSet = new Set<DependencyOmitKind>()
  let installStrategy: NpmrcInstallStrategy | undefined
  let nodeLinker: NpmrcNodeLinker | undefined
  let publicHoistPatterns: string[] | undefined
  let hoistPatterns: string[] | undefined
  let hoist: boolean | undefined

  const lines = rawText.split(/\r?\n/)

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNum = idx + 1
    const trimmed = lines[idx]!.trim()
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue
    }

    const eqIdx = trimmed.indexOf("=")
    if (eqIdx <= 0) {
      warnings.push({
        line: lineNum,
        key: trimmed,
        message: "Ignored line without '=' assignment",
      })
      continue
    }

    const rawKey = trimmed.slice(0, eqIdx).trim()
    const rawValueBeforeEnv = parseNpmrcRawValue(trimmed.slice(eqIdx + 1))
    const value = expandNpmrcEnvVars(rawValueBeforeEnv, env)

    // 1. Registry-scoped options: //<registry_url>/:<key>=<value>
    if (rawKey.startsWith("//")) {
      const colonIdx = rawKey.lastIndexOf(":")
      if (colonIdx <= 2) {
        warnings.push({
          line: lineNum,
          key: rawKey,
          message: "Malformed registry option key (missing ':key')",
        })
        continue
      }
      const prefix = normalizeNpmrcRegistryPrefix(rawKey.slice(0, colonIdx))
      const credKey = rawKey.slice(colonIdx + 1).trim()
      const existing: NpmrcRegistryAuthEntry = registryAuth[prefix] ?? {
        prefix,
        source,
      }
      const envRef = extractEnvPlaceholderName(rawValueBeforeEnv)

      if (credKey === "_authToken") {
        assertSafeCredentialValue(value, `${prefix}:_authToken`)
        registryAuth[prefix] = {
          ...existing,
          authToken: value,
          ...(envRef ? { authTokenEnvRef: envRef } : {}),
          source,
        }
      } else if (credKey === "username") {
        assertSafeCredentialValue(value, `${prefix}:username`)
        registryAuth[prefix] = {
          ...existing,
          username: value,
          source,
        }
      } else if (credKey === "_password") {
        assertSafeCredentialValue(value, `${prefix}:_password`)
        registryAuth[prefix] = {
          ...existing,
          passwordBase64: value,
          ...(envRef ? { passwordEnvRef: envRef } : {}),
          source,
        }
      } else if (credKey === "_auth") {
        assertSafeCredentialValue(value, `${prefix}:_auth`)
        registryAuth[prefix] = {
          ...existing,
          rawAuth: value,
          ...(envRef ? { rawAuthEnvRef: envRef } : {}),
          source,
        }
      } else if (credKey === "email") {
        // Accepted and ignored as npm does
        registryAuth[prefix] = {
          ...existing,
          email: value,
          source,
        }
      } else {
        warnings.push({
          line: lineNum,
          key: rawKey,
          message: `Unsupported registry option '${credKey}'`,
        })
      }
      continue
    }

    // 2. Scoped registry: @<scope>:registry=<url>
    if (rawKey.startsWith("@") && rawKey.endsWith(":registry")) {
      const scopeName = rawKey
        .slice(1, rawKey.length - ":registry".length)
        .trim()
        .toLowerCase()
      if (!scopeName) {
        warnings.push({
          line: lineNum,
          key: rawKey,
          message: "Empty scope name in @scope:registry",
        })
        continue
      }
      // Empty scope registry falls back to default registry
      if (value !== "") {
        parseValidatedHttpUrl(value, `@${scopeName}:registry`)
      }
      scopes[scopeName] = value
      continue
    }

    // 3. Standard options
    const keyLower = rawKey.toLowerCase()
    switch (keyLower) {
      case "registry": {
        if (value !== "") {
          parseValidatedHttpUrl(value, "registry")
        }
        registry = value
        break
      }
      case "link-workspace-packages": {
        linkWorkspacePackages = parseNpmrcBoolean(value)
        break
      }
      case "save-exact": {
        saveExact = parseNpmrcBoolean(value)
        break
      }
      case "ignore-scripts": {
        ignoreScripts = parseNpmrcBoolean(value)
        break
      }
      case "dry-run": {
        dryRun = parseNpmrcBoolean(value)
        break
      }
      case "cache": {
        const lower = value.trim().toLowerCase()
        if (lower === "false" || lower === "0" || lower === "null" || lower === "undefined") {
          cache = { disable: true, dir: null, rawValue: value }
        } else if (value.trim() !== "") {
          cache = {
            disable: false,
            dir: resolveNpmrcPath(value, options.baseDir, options.homeDir),
            rawValue: value,
          }
        }
        break
      }
      case "ca": {
        hasCaDirective = true
        caList.length = 0
        if (value) caList.push(value)
        break
      }
      case "ca[]": {
        hasCaDirective = true
        if (value) caList.push(value)
        break
      }
      case "cafile": {
        hasCaDirective = true
        cafile = value ? resolveNpmrcPath(value, options.baseDir, options.homeDir) : undefined
        break
      }
      case "omit":
      case "omit[]": {
        const norm = value.toLowerCase()
        if (isDependencyOmitKind(norm)) {
          omitSet.add(norm)
        } else if (norm) {
          warnings.push({
            line: lineNum,
            key: rawKey,
            message: `Invalid omit value '${value}' (expected dev, peer, or optional)`,
          })
        }
        break
      }
      case "include":
      case "include[]": {
        const norm = value.toLowerCase()
        if (isDependencyOmitKind(norm)) {
          includeSet.add(norm)
        } else if (norm) {
          warnings.push({
            line: lineNum,
            key: rawKey,
            message: `Invalid include value '${value}' (expected dev, peer, or optional)`,
          })
        }
        break
      }
      case "install-strategy": {
        const norm = value.toLowerCase()
        if (norm === "hoisted" || norm === "linked") {
          installStrategy = norm
        } else {
          warnings.push({
            line: lineNum,
            key: rawKey,
            message: `Unsupported install-strategy '${value}' (expected hoisted or linked)`,
          })
        }
        break
      }
      case "node-linker": {
        const norm = value.toLowerCase()
        if (
          norm === "isolated" ||
          norm === "hoisted" ||
          norm === "pnpm" ||
          norm === "node-modules"
        ) {
          nodeLinker = norm
        } else {
          warnings.push({
            line: lineNum,
            key: rawKey,
            message: `Unsupported node-linker '${value}' (expected isolated, hoisted, pnpm, or node-modules)`,
          })
        }
        break
      }
      case "public-hoist-pattern": {
        publicHoistPatterns = value ? [value] : []
        break
      }
      case "public-hoist-pattern[]": {
        if (!publicHoistPatterns) publicHoistPatterns = []
        if (value) publicHoistPatterns.push(value)
        break
      }
      case "hoist-pattern": {
        hoistPatterns = value ? [value] : []
        break
      }
      case "hoist-pattern[]": {
        if (!hoistPatterns) hoistPatterns = []
        if (value) hoistPatterns.push(value)
        break
      }
      case "hoist": {
        hoist = parseNpmrcBoolean(value)
        break
      }
      default: {
        warnings.push({
          line: lineNum,
          key: rawKey,
          message: `Unrecognized .npmrc option '${rawKey}'`,
        })
      }
    }
  }

  return {
    source,
    ...(options.filePath !== undefined ? { filePath: options.filePath } : {}),
    ...(options.baseDir !== undefined ? { baseDir: options.baseDir } : {}),
    ...(registry !== undefined ? { registry, registryFromNpmrc: true } : {}),
    scopes,
    registryAuth,
    ...(linkWorkspacePackages !== undefined ? { linkWorkspacePackages } : {}),
    ...(saveExact !== undefined ? { saveExact } : {}),
    ...(ignoreScripts !== undefined ? { ignoreScripts } : {}),
    ...(dryRun !== undefined ? { dryRun } : {}),
    ...(cache !== undefined ? { cache } : {}),
    // If both ca and cafile are set in the same file, only cafile is used
    ...(cafile ? { cafile } : caList.length > 0 ? { ca: caList } : {}),
    hasCaDirective,
    omit: Array.from(omitSet),
    include: Array.from(includeSet),
    ...(installStrategy !== undefined ? { installStrategy } : {}),
    ...(nodeLinker !== undefined ? { nodeLinker } : {}),
    ...(publicHoistPatterns !== undefined ? { publicHoistPattern: publicHoistPatterns } : {}),
    ...(hoistPatterns !== undefined ? { hoistPattern: hoistPatterns } : {}),
    ...(hoist !== undefined ? { hoist } : {}),
    warnings,
  }
}

// ── Minimal Pure bunfig.toml [install] Parser ─────────────────────────────────

function unquoteTomlString(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n")
  }
  return trimmed
}

function stripTomlInlineComment(raw: string): string {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (ch === "\\" && inDouble) {
      i += 1
      continue
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === "#" && !inSingle && !inDouble) {
      return raw.slice(0, i).trim()
    }
  }
  return raw.trim()
}

function parseTomlInlineObject(raw: string): Record<string, string> | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return {}
  const result: Record<string, string> = {}
  // Split on commas outside quotes
  const parts: string[] = []
  let current = ""
  let inQuote: '"' | "'" | null = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!
    if (inQuote) {
      current += ch
      if (ch === "\\" && inQuote === '"' && i + 1 < inner.length) {
        current += inner[i + 1]!
        i += 1
        continue
      }
      if (ch === inQuote) inQuote = null
    } else if (ch === '"' || ch === "'") {
      inQuote = ch
      current += ch
    } else if (ch === ",") {
      parts.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)

  for (const part of parts) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const k = part
      .slice(0, eq)
      .trim()
      .replace(/^["']|["']$/g, "")
    const v = unquoteTomlString(part.slice(eq + 1))
    result[k] = v
  }
  return result
}

/**
 * Parse relevant `[install]`, `[install.scopes]`, and `[install.cache]` keys from a `bunfig.toml`
 * file (pure TypeScript so it runs in browser & server).
 */
export function parseBunfigInstallToml(
  rawToml: string,
  source: "global-bunfig" | "project-bunfig" = "project-bunfig",
  env: Readonly<Record<string, string | undefined>> = {},
  filePath?: string,
): ParsedBunfigInstallConfig {
  let section = ""
  let registry: ParsedBunfigInstallConfig["registry"]
  const scopes: Record<string, string | ParsedBunfigScopeEntry> = {}
  let optional: boolean | undefined
  let dev: boolean | undefined
  let peer: boolean | undefined
  let production: boolean | undefined
  let linkWorkspacePackages: boolean | undefined
  let exact: boolean | undefined
  let frozenLockfile: boolean | undefined
  let saveTextLockfile: boolean | undefined
  let auto: BunInstallAutoMode | undefined
  let ignoreScripts: boolean | undefined
  let dryRun: boolean | undefined
  let cacheDir: string | undefined
  let cacheDisable: boolean | undefined
  let cacheDisableManifest: boolean | undefined
  let lockfileSave: boolean | undefined
  let lockfilePrint: BunLockfilePrintFormat | undefined
  let securityScanner: string | undefined
  let ca: string[] | undefined
  let cafile: string | undefined
  let linker: NormalizedNodeLinker | undefined
  let globalStore: boolean | undefined
  let globalDir: string | undefined
  let globalBinDir: string | undefined
  let minimumReleaseAge: string | number | undefined
  let minimumReleaseAgeExcludes: string[] | undefined
  let publicHoistPattern: string[] | undefined
  let hoistPattern: string[] | undefined
  let runShell: BunRunShellMode | undefined
  let runBun: boolean | undefined
  let runSilent: boolean | undefined
  let runNoOrphans: boolean | undefined

  const parseTomlStringOrArray = (raw: string): string[] => {
    const trimmed = raw.trim()
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const inner = trimmed.slice(1, -1).trim()
      if (!inner) return []
      return inner
        .split(",")
        .map((s) => unquoteTomlString(s))
        .filter((s) => s.length > 0)
    }
    const v = unquoteTomlString(trimmed)
    return v ? [v] : []
  }

  const expandBunfigVar = (val: string): string => {
    // Support $VAR or ${VAR} in bunfig.toml credentials
    const afterBraces = expandNpmrcEnvVars(val, env)
    return afterBraces.replace(
      /\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (full, name: string) => env[name] ?? full,
    )
  }

  for (const rawLine of rawToml.split(/\r?\n/)) {
    const cleaned = stripTomlInlineComment(rawLine).trim()
    if (!cleaned) continue

    if (cleaned.startsWith("[") && cleaned.endsWith("]")) {
      section = cleaned.slice(1, -1).trim()
      continue
    }

    const eqIdx = cleaned.indexOf("=")
    if (eqIdx <= 0) continue
    const rawKey = cleaned
      .slice(0, eqIdx)
      .trim()
      .replace(/^["']|["']$/g, "")
    const rawVal = cleaned.slice(eqIdx + 1).trim()

    const fullKey = section ? `${section}.${rawKey}` : rawKey

    if (fullKey === "install.registry") {
      const obj = parseTomlInlineObject(rawVal)
      if (obj && obj.url) {
        registry = {
          url: obj.url,
          ...(obj.token ? { token: expandBunfigVar(obj.token) } : {}),
          ...(obj.username ? { username: expandBunfigVar(obj.username) } : {}),
          ...(obj.password ? { password: expandBunfigVar(obj.password) } : {}),
        }
      } else {
        registry = unquoteTomlString(rawVal)
      }
    } else if (section === "install.scopes") {
      const scopeName = rawKey.replace(/^@/, "").toLowerCase()
      const obj = parseTomlInlineObject(rawVal)
      if (obj && obj.url) {
        scopes[scopeName] = {
          url: obj.url,
          ...(obj.token ? { token: expandBunfigVar(obj.token) } : {}),
          ...(obj.username ? { username: expandBunfigVar(obj.username) } : {}),
          ...(obj.password ? { password: expandBunfigVar(obj.password) } : {}),
        }
      } else {
        scopes[scopeName] = unquoteTomlString(rawVal)
      }
    } else if (fullKey === "install.optional") {
      optional = rawVal === "true"
    } else if (fullKey === "install.dev") {
      dev = rawVal === "true"
    } else if (fullKey === "install.peer") {
      peer = rawVal === "true"
    } else if (fullKey === "install.production") {
      production = rawVal === "true"
    } else if (fullKey === "install.linkWorkspacePackages") {
      linkWorkspacePackages = rawVal === "true"
    } else if (fullKey === "install.exact") {
      exact = rawVal === "true"
    } else if (fullKey === "install.frozenLockfile") {
      frozenLockfile = rawVal === "true"
    } else if (fullKey === "install.saveTextLockfile") {
      saveTextLockfile = rawVal === "true"
    } else if (fullKey === "install.auto") {
      const v = unquoteTomlString(rawVal)
      if (v === "auto" || v === "force" || v === "disable" || v === "fallback") {
        auto = v
      }
    } else if (fullKey === "install.ignoreScripts") {
      ignoreScripts = rawVal === "true"
    } else if (fullKey === "install.dryRun") {
      dryRun = rawVal === "true"
    } else if (fullKey === "install.globalStore") {
      globalStore = rawVal === "true"
    } else if (fullKey === "install.globalDir") {
      globalDir = unquoteTomlString(rawVal)
    } else if (fullKey === "install.globalBinDir") {
      globalBinDir = unquoteTomlString(rawVal)
    } else if (fullKey === "install.minimumReleaseAge") {
      if (/^\d+$/.test(rawVal)) {
        minimumReleaseAge = Number(rawVal)
      } else {
        minimumReleaseAge = unquoteTomlString(rawVal)
      }
    } else if (fullKey === "install.minimumReleaseAgeExcludes") {
      minimumReleaseAgeExcludes = parseTomlStringOrArray(rawVal)
    } else if (fullKey === "install.publicHoistPattern") {
      publicHoistPattern = parseTomlStringOrArray(rawVal)
    } else if (fullKey === "install.hoistPattern") {
      hoistPattern = parseTomlStringOrArray(rawVal)
    } else if (fullKey === "install.linker") {
      const v = unquoteTomlString(rawVal)
      if (v === "hoisted" || v === "isolated") linker = v
    } else if (fullKey === "install.cache.dir") {
      cacheDir = unquoteTomlString(rawVal)
    } else if (fullKey === "install.cache.disable") {
      cacheDisable = rawVal === "true"
    } else if (fullKey === "install.cache.disableManifest") {
      cacheDisableManifest = rawVal === "true"
    } else if (fullKey === "install.lockfile.save") {
      lockfileSave = rawVal === "true"
    } else if (fullKey === "install.lockfile.print") {
      const v = unquoteTomlString(rawVal)
      if (v === "yarn") lockfilePrint = "yarn"
    } else if (fullKey === "install.security.scanner") {
      securityScanner = unquoteTomlString(rawVal)
    } else if (fullKey === "install.cafile") {
      cafile = unquoteTomlString(rawVal)
    } else if (fullKey === "install.ca") {
      ca = parseTomlStringOrArray(rawVal)
    } else if (fullKey === "run.shell") {
      const v = unquoteTomlString(rawVal)
      if (v === "system" || v === "bun") runShell = v
    } else if (fullKey === "run.bun") {
      runBun = rawVal === "true"
    } else if (fullKey === "run.silent") {
      runSilent = rawVal === "true"
    } else if (fullKey === "run.noOrphans") {
      runNoOrphans = rawVal === "true"
    }
  }

  return {
    source,
    ...(filePath !== undefined ? { filePath } : {}),
    ...(registry !== undefined ? { registry } : {}),
    ...(Object.keys(scopes).length > 0 ? { scopes } : {}),
    ...(optional !== undefined ? { optional } : {}),
    ...(dev !== undefined ? { dev } : {}),
    ...(peer !== undefined ? { peer } : {}),
    ...(production !== undefined ? { production } : {}),
    ...(linkWorkspacePackages !== undefined ? { linkWorkspacePackages } : {}),
    ...(exact !== undefined ? { exact } : {}),
    ...(frozenLockfile !== undefined ? { frozenLockfile } : {}),
    ...(saveTextLockfile !== undefined ? { saveTextLockfile } : {}),
    ...(auto !== undefined ? { auto } : {}),
    ...(ignoreScripts !== undefined ? { ignoreScripts } : {}),
    ...(dryRun !== undefined ? { dryRun } : {}),
    ...(cacheDir !== undefined || cacheDisable !== undefined || cacheDisableManifest !== undefined
      ? {
          cache: {
            ...(cacheDir !== undefined ? { dir: cacheDir } : {}),
            ...(cacheDisable !== undefined ? { disable: cacheDisable } : {}),
            ...(cacheDisableManifest !== undefined
              ? { disableManifest: cacheDisableManifest }
              : {}),
          },
        }
      : {}),
    ...(lockfileSave !== undefined || lockfilePrint !== undefined
      ? {
          lockfile: {
            ...(lockfileSave !== undefined ? { save: lockfileSave } : {}),
            ...(lockfilePrint !== undefined ? { print: lockfilePrint } : {}),
          },
        }
      : {}),
    ...(securityScanner !== undefined ? { security: { scanner: securityScanner } } : {}),
    ...(ca !== undefined ? { ca } : {}),
    ...(cafile !== undefined ? { cafile } : {}),
    ...(linker !== undefined ? { linker } : {}),
    ...(globalStore !== undefined ? { globalStore } : {}),
    ...(globalDir !== undefined ? { globalDir } : {}),
    ...(globalBinDir !== undefined ? { globalBinDir } : {}),
    ...(minimumReleaseAge !== undefined ? { minimumReleaseAge } : {}),
    ...(minimumReleaseAgeExcludes !== undefined ? { minimumReleaseAgeExcludes } : {}),
    ...(publicHoistPattern !== undefined ? { publicHoistPattern } : {}),
    ...(hoistPattern !== undefined ? { hoistPattern } : {}),
    ...(runShell !== undefined ||
    runBun !== undefined ||
    runSilent !== undefined ||
    runNoOrphans !== undefined
      ? {
          run: {
            ...(runShell !== undefined ? { shell: runShell } : {}),
            ...(runBun !== undefined ? { bun: runBun } : {}),
            ...(runSilent !== undefined ? { silent: runSilent } : {}),
            ...(runNoOrphans !== undefined ? { noOrphans: runNoOrphans } : {}),
          },
        }
      : {}),
  }
}

// ── Precedence Merger ─────────────────────────────────────────────────────────

function extractInlineUrlCred(
  rawUrl: string,
  originSource: "npmrc-registry-url" | "url",
): ResolvedInlineCredential | undefined {
  const parsed = parseValidatedHttpUrl(rawUrl, "registry URL")
  if (!parsed.username && !parsed.password) return undefined
  const username = decodeURIComponent(parsed.username)
  const password = decodeURIComponent(parsed.password)
  assertSafeCredentialValue(username, "registry URL username")
  assertSafeCredentialValue(password, "registry URL password")
  return { username, password, originSource }
}

function hasRegistryAuthEntryForUrl(
  urlStr: string,
  registryAuth: Readonly<Record<string, NpmrcRegistryAuthEntry>>,
): boolean {
  try {
    const parsed = parseValidatedHttpUrl(urlStr)
    const keys = buildRegistryCredentialLookupKeys(parsed)
    for (const k of keys) {
      const entry = registryAuth[k]
      if (
        entry &&
        (entry.authToken !== undefined ||
          entry.rawAuth !== undefined ||
          (entry.username !== undefined && entry.passwordBase64 !== undefined))
      ) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

/**
 * Resolve effective Bun package manager configuration in Bun's exact load order:
 *
 * 1. User `.npmrc` (`NPM_CONFIG_USERCONFIG` / `$XDG_CONFIG_HOME/.npmrc` / `$HOME/.npmrc`)
 * 2. Project `./.npmrc`
 * 3. Global `bunfig.toml`
 * 4. Project `bunfig.toml`
 * 5. Environment variables (`BUN_CONFIG_REGISTRY` / `NPM_CONFIG_REGISTRY`, `BUN_CONFIG_TOKEN` /
 *    `NPM_CONFIG_TOKEN`, `NPM_CONFIG_IGNORE_SCRIPTS`)
 * 6. CLI flags (`--registry`, `--ca`, `--cafile`, `--ignore-scripts`, `--dry-run`, `--exact`)
 */
export function resolveBunPackageConfig(
  input: ResolveBunPackageConfigInput = {},
): ResolvedBunPackageConfig {
  const env = input.env ?? {}
  const layersApplied: ConfigLayerSource[] = ["default"]
  const warnings: NpmrcParseWarning[] = []

  let defaultRegistry: ResolvedRegistryTarget = {
    url: DEFAULT_NPM_REGISTRY,
    source: "default",
  }
  let configFileRegistryHost: string | null = null

  const scopes: Record<string, ResolvedRegistryTarget> = {}
  const registryAuth: Record<string, NpmrcRegistryAuthEntry> = {}

  let linkWorkspacePackages = false
  let saveExact = false
  let ignoreScripts = false
  let dryRun = false
  let installOptional = true
  let installDev = true
  let installPeer = true
  let installProduction = false
  let autoInstall: BunInstallAutoMode = "auto"
  let lockfileSave = true
  let saveTextLockfile = true
  let frozenLockfile = false
  let lockfilePrint: BunLockfilePrintFormat | null = null
  let cache: {
    disabled: boolean
    disableManifest: boolean
    dir: string | null
    source: ConfigLayerSource
  } = { disabled: false, disableManifest: false, dir: null, source: "default" }
  let minimumReleaseAge: string | number | null = null
  let minimumReleaseAgeExcludes: readonly string[] = []
  let securityScanner: string | null = null
  let globalStore = false
  let globalDir: string | null = null
  let globalBinDir: string | null = null
  let runShell: BunRunShellMode = "system"
  let runBun = false
  let runSilent = false
  let runNoOrphans = false
  let tls: {
    cafile: string | null
    ca: readonly string[]
    source: ConfigLayerSource
  } = { cafile: null, ca: [], source: "default" }

  const omitSet = new Set<DependencyOmitKind>()
  const includeSet = new Set<DependencyOmitKind>()

  const lockfileSummary = input.bunLockfile ? summarizeBunLockFile(input.bunLockfile) : null
  if (lockfileSummary) {
    layersApplied.push("bun-lockfile")
  }

  let linker: NormalizedNodeLinker = lockfileSummary
    ? lockfileSummary.defaultLinkerStrategy
    : "hoisted"
  let linkerSource: ConfigLayerSource = lockfileSummary ? "bun-lockfile" : "default"
  let publicHoistPattern: readonly string[] = []
  let hoistPattern: readonly string[] = []
  let hoist = true

  // Apply .npmrc layers (1. user, 2. project)
  const npmrcLayers: readonly (ParsedNpmrcFile | null | undefined)[] = [
    input.userNpmrc,
    input.projectNpmrc,
  ]
  for (const layer of npmrcLayers) {
    if (!layer) continue
    layersApplied.push(layer.source)
    warnings.push(...layer.warnings)

    // All .npmrc files count as one: later key replaces earlier key
    for (const [prefix, entry] of Object.entries(layer.registryAuth)) {
      const prev = registryAuth[prefix]
      registryAuth[prefix] = prev ? { ...prev, ...entry, source: layer.source } : entry
    }

    if (layer.registry !== undefined) {
      if (layer.registry === "") {
        defaultRegistry = { url: DEFAULT_NPM_REGISTRY, source: layer.source }
      } else {
        const parsed = parseValidatedHttpUrl(layer.registry, "registry")
        const inlineCredential = extractInlineUrlCred(layer.registry, "npmrc-registry-url")
        defaultRegistry = {
          url: stripUrlCredentials(parsed.toString()),
          source: layer.source,
          ...(inlineCredential ? { inlineCredential } : {}),
        }
        configFileRegistryHost = parsed.host.toLowerCase()
      }
    }

    for (const [scopeName, scopeUrl] of Object.entries(layer.scopes)) {
      if (scopeUrl === "") {
        // Empty scope registry falls back to default registry
        delete scopes[scopeName]
      } else {
        const parsed = parseValidatedHttpUrl(scopeUrl, `@${scopeName}:registry`)
        const inlineCredential = extractInlineUrlCred(scopeUrl, "npmrc-registry-url")
        scopes[scopeName] = {
          url: stripUrlCredentials(parsed.toString()),
          source: layer.source,
          ...(inlineCredential ? { inlineCredential } : {}),
        }
      }
    }

    if (layer.linkWorkspacePackages !== undefined) {
      linkWorkspacePackages = layer.linkWorkspacePackages
    }
    if (layer.saveExact !== undefined) saveExact = layer.saveExact
    if (layer.ignoreScripts !== undefined) ignoreScripts = layer.ignoreScripts
    if (layer.dryRun !== undefined) dryRun = layer.dryRun

    if (layer.cache !== undefined) {
      cache = {
        disabled: layer.cache.disable,
        disableManifest: cache.disableManifest,
        dir: layer.cache.dir,
        source: layer.source,
      }
    }

    // A ca or cafile in a later .npmrc replaces BOTH previous ca and cafile
    if (layer.hasCaDirective) {
      if (layer.cafile) {
        tls = { cafile: layer.cafile, ca: [], source: layer.source }
      } else {
        tls = { cafile: null, ca: layer.ca ?? [], source: layer.source }
      }
    }

    for (const o of layer.omit) omitSet.add(o)
    for (const inc of layer.include) includeSet.add(inc)

    const layerLinker = normalizeNodeLinkerValue(layer.installStrategy, layer.nodeLinker)
    if (layerLinker) {
      linker = layerLinker
      linkerSource = layer.source
    }
    if (layer.publicHoistPattern !== undefined) {
      publicHoistPattern = layer.publicHoistPattern
    }
    if (layer.hoistPattern !== undefined) {
      hoistPattern = layer.hoistPattern
    }
    if (layer.hoist !== undefined) {
      hoist = layer.hoist
    }
  }

  // Apply .npmrc omit/include into bunfig-compatible dependency booleans
  // (later bunfig.toml layers can still override optional/dev/peer/production)
  const npmrcOmitted = Array.from(omitSet).filter((k) => !includeSet.has(k))
  if (npmrcOmitted.includes("dev")) installDev = false
  if (npmrcOmitted.includes("optional")) installOptional = false
  if (npmrcOmitted.includes("peer")) installPeer = false

  // Apply bunfig.toml layers (3. global, 4. project)
  const bunfigLayers: readonly (ParsedBunfigInstallConfig | null | undefined)[] = [
    input.globalBunfig,
    input.projectBunfig,
  ]
  for (const bf of bunfigLayers) {
    if (!bf) continue
    layersApplied.push(bf.source)

    if (bf.registry !== undefined) {
      if (typeof bf.registry === "string") {
        const parsed = parseValidatedHttpUrl(bf.registry, "bunfig install.registry")
        const urlCred = extractInlineUrlCred(bf.registry, "url")
        defaultRegistry = {
          url: stripUrlCredentials(parsed.toString()),
          source: bf.source,
          ...(urlCred ? { inlineCredential: urlCred } : {}),
        }
        configFileRegistryHost = parsed.host.toLowerCase()
      } else {
        const parsed = parseValidatedHttpUrl(bf.registry.url, "bunfig install.registry")
        if (bf.registry.token !== undefined) {
          assertSafeCredentialValue(bf.registry.token, "bunfig install.registry.token")
        }
        if (bf.registry.username !== undefined) {
          assertSafeCredentialValue(bf.registry.username, "bunfig install.registry.username")
        }
        if (bf.registry.password !== undefined) {
          assertSafeCredentialValue(bf.registry.password, "bunfig install.registry.password")
        }
        const hasCred =
          bf.registry.token !== undefined ||
          (bf.registry.username !== undefined && bf.registry.password !== undefined)
        defaultRegistry = {
          url: stripUrlCredentials(parsed.toString()),
          source: bf.source,
          ...(hasCred
            ? {
                inlineCredential: {
                  ...(bf.registry.token !== undefined ? { token: bf.registry.token } : {}),
                  ...(bf.registry.username !== undefined ? { username: bf.registry.username } : {}),
                  ...(bf.registry.password !== undefined ? { password: bf.registry.password } : {}),
                  originSource: "bunfig",
                },
              }
            : {}),
        }
        configFileRegistryHost = parsed.host.toLowerCase()
      }
    }

    if (bf.scopes) {
      for (const [rawScope, scopeVal] of Object.entries(bf.scopes)) {
        const scopeName = rawScope.replace(/^@/, "").toLowerCase()
        if (typeof scopeVal === "string") {
          if (scopeVal === "") {
            delete scopes[scopeName]
          } else {
            const parsed = parseValidatedHttpUrl(scopeVal, `bunfig install.scopes.${scopeName}`)
            const urlCred = extractInlineUrlCred(scopeVal, "url")
            scopes[scopeName] = {
              url: stripUrlCredentials(parsed.toString()),
              source: bf.source,
              ...(urlCred ? { inlineCredential: urlCred } : {}),
            }
          }
        } else {
          const parsed = parseValidatedHttpUrl(scopeVal.url, `bunfig install.scopes.${scopeName}`)
          if (scopeVal.token !== undefined) {
            assertSafeCredentialValue(scopeVal.token, `bunfig scope ${scopeName} token`)
          }
          if (scopeVal.username !== undefined) {
            assertSafeCredentialValue(scopeVal.username, `bunfig scope ${scopeName} username`)
          }
          if (scopeVal.password !== undefined) {
            assertSafeCredentialValue(scopeVal.password, `bunfig scope ${scopeName} password`)
          }
          const hasCred =
            scopeVal.token !== undefined ||
            (scopeVal.username !== undefined && scopeVal.password !== undefined)
          scopes[scopeName] = {
            url: stripUrlCredentials(parsed.toString()),
            source: bf.source,
            ...(hasCred
              ? {
                  inlineCredential: {
                    ...(scopeVal.token !== undefined ? { token: scopeVal.token } : {}),
                    ...(scopeVal.username !== undefined ? { username: scopeVal.username } : {}),
                    ...(scopeVal.password !== undefined ? { password: scopeVal.password } : {}),
                    originSource: "bunfig",
                  },
                }
              : {}),
          }
        }
      }
    }

    if (bf.optional !== undefined) installOptional = bf.optional
    if (bf.dev !== undefined) installDev = bf.dev
    if (bf.peer !== undefined) installPeer = bf.peer
    if (bf.production !== undefined) {
      installProduction = bf.production
      if (bf.production) {
        // production = true skips devDependencies and implicitly freezes lockfile
        installDev = false
        frozenLockfile = true
      }
    }
    if (bf.linkWorkspacePackages !== undefined) {
      linkWorkspacePackages = bf.linkWorkspacePackages
    }
    if (bf.exact !== undefined) saveExact = bf.exact
    if (bf.frozenLockfile !== undefined) frozenLockfile = bf.frozenLockfile
    if (bf.saveTextLockfile !== undefined) saveTextLockfile = bf.saveTextLockfile
    if (bf.auto !== undefined) autoInstall = bf.auto
    if (bf.ignoreScripts !== undefined) ignoreScripts = bf.ignoreScripts
    if (bf.dryRun !== undefined) dryRun = bf.dryRun
    if (bf.cache !== undefined) {
      cache = {
        disabled: bf.cache.disable ?? cache.disabled,
        disableManifest: bf.cache.disableManifest ?? cache.disableManifest,
        dir: bf.cache.dir ?? cache.dir,
        source: bf.source,
      }
    }
    if (bf.lockfile !== undefined) {
      if (bf.lockfile.save !== undefined) lockfileSave = bf.lockfile.save
      if (bf.lockfile.print !== undefined) lockfilePrint = bf.lockfile.print
    }
    if (bf.security?.scanner !== undefined) {
      securityScanner = bf.security.scanner
    }
    if (bf.globalStore !== undefined) globalStore = bf.globalStore
    if (bf.globalDir !== undefined) {
      if (bf.source === "global-bunfig") {
        globalDir = bf.globalDir
      } else {
        warnings.push({
          line: 0,
          key: "install.globalDir",
          message:
            "Bun ignores install.globalDir in project-local bunfig.toml; set it in global ~/.bunfig.toml or BUN_INSTALL_GLOBAL_DIR.",
        })
      }
    }
    if (bf.globalBinDir !== undefined) {
      if (bf.source === "global-bunfig") {
        globalBinDir = bf.globalBinDir
      } else {
        warnings.push({
          line: 0,
          key: "install.globalBinDir",
          message:
            "Bun ignores install.globalBinDir in project-local bunfig.toml; set it in global ~/.bunfig.toml or BUN_INSTALL_BIN.",
        })
      }
    }
    if (bf.minimumReleaseAge !== undefined) {
      minimumReleaseAge = bf.minimumReleaseAge
    }
    if (bf.minimumReleaseAgeExcludes !== undefined) {
      minimumReleaseAgeExcludes = bf.minimumReleaseAgeExcludes
    }
    if (bf.publicHoistPattern !== undefined) {
      publicHoistPattern = bf.publicHoistPattern
    }
    if (bf.hoistPattern !== undefined) {
      hoistPattern = bf.hoistPattern
    }
    if (bf.cafile !== undefined || bf.ca !== undefined) {
      if (bf.cafile) {
        tls = { cafile: bf.cafile, ca: [], source: bf.source }
      } else {
        tls = { cafile: null, ca: bf.ca ?? [], source: bf.source }
      }
    }
    if (bf.linker !== undefined) {
      linker = bf.linker
      linkerSource = bf.source
    }
    if (bf.run !== undefined) {
      if (bf.run.shell !== undefined) runShell = bf.run.shell
      if (bf.run.bun !== undefined) runBun = bf.run.bun
      if (bf.run.silent !== undefined) runSilent = bf.run.silent
      if (bf.run.noOrphans !== undefined) runNoOrphans = bf.run.noOrphans
    }
  }

  // Layer 5: Environment variables
  const envRegistry = env.BUN_CONFIG_REGISTRY?.trim() || env.NPM_CONFIG_REGISTRY?.trim()
  const envToken = env.BUN_CONFIG_TOKEN ?? env.NPM_CONFIG_TOKEN
  const envIgnoreScripts = env.NPM_CONFIG_IGNORE_SCRIPTS ?? env.npm_config_ignore_scripts
  let envLayerUsed = false

  if (envToken !== undefined && envToken !== "") {
    assertSafeCredentialValue(envToken, "BUN_CONFIG_TOKEN / NPM_CONFIG_TOKEN")
    envLayerUsed = true
  }

  if (envRegistry) {
    const parsed = parseValidatedHttpUrl(envRegistry, "BUN_CONFIG_REGISTRY / NPM_CONFIG_REGISTRY")
    const urlCred = extractInlineUrlCred(envRegistry, "url")
    defaultRegistry = {
      url: stripUrlCredentials(parsed.toString()),
      source: "env",
      ...(urlCred ? { inlineCredential: urlCred } : {}),
    }
    envLayerUsed = true
  }

  if (envIgnoreScripts !== undefined) {
    ignoreScripts = parseNpmrcBoolean(envIgnoreScripts)
    envLayerUsed = true
  }

  if (env.BUN_INSTALL_GLOBAL_DIR?.trim()) {
    globalDir = env.BUN_INSTALL_GLOBAL_DIR.trim()
    envLayerUsed = true
  }
  if (env.BUN_INSTALL_BIN?.trim()) {
    globalBinDir = env.BUN_INSTALL_BIN.trim()
    envLayerUsed = true
  }

  if (envLayerUsed) {
    layersApplied.push("env")
  }

  // Layer 6: CLI flags
  const cli = input.cli
  let cliRegistryOverrideHost: string | null = null
  if (cli) {
    let cliUsed = false
    if (cli.registry) {
      const parsed = parseValidatedHttpUrl(cli.registry, "--registry")
      const urlCred = extractInlineUrlCred(cli.registry, "url")
      defaultRegistry = {
        url: stripUrlCredentials(parsed.toString()),
        source: "cli",
        ...(urlCred ? { inlineCredential: urlCred } : {}),
      }
      cliRegistryOverrideHost = parsed.host.toLowerCase()
      cliUsed = true
    }
    if (cli.cafile !== undefined || cli.ca !== undefined) {
      if (cli.cafile) {
        tls = { cafile: cli.cafile, ca: [], source: "cli" }
      } else {
        tls = { cafile: null, ca: cli.ca ?? [], source: "cli" }
      }
      cliUsed = true
    }
    if (cli.ignoreScripts !== undefined) {
      ignoreScripts = cli.ignoreScripts
      cliUsed = true
    }
    if (cli.dryRun !== undefined) {
      dryRun = cli.dryRun
      cliUsed = true
    }
    if (cli.exact !== undefined) {
      saveExact = cli.exact
      cliUsed = true
    }
    if (cli.linker !== undefined) {
      linker = cli.linker
      linkerSource = "cli"
      cliUsed = true
    }
    if (cliUsed) {
      layersApplied.push("cli")
    }
  }

  // Subtle Bun scope rule:
  // If --registry or an env var points to a different host than the config
  // files, a scope that has its own credentials keeps using its config-file
  // registry; a scope WITHOUT its own credentials inherits the override.
  const overrideHost =
    cliRegistryOverrideHost ??
    (envRegistry ? parseValidatedHttpUrl(envRegistry).host.toLowerCase() : null)

  if (overrideHost && (!configFileRegistryHost || overrideHost !== configFileRegistryHost)) {
    for (const [scopeName, target] of Object.entries(scopes)) {
      const hasOwnCred =
        Boolean(target.inlineCredential) || hasRegistryAuthEntryForUrl(target.url, registryAuth)
      if (!hasOwnCred) {
        scopes[scopeName] = {
          url: defaultRegistry.url,
          source: defaultRegistry.source,
          ...(defaultRegistry.inlineCredential
            ? { inlineCredential: defaultRegistry.inlineCredential }
            : {}),
        }
      }
    }
  }

  // Compute effective omitted dependency types from resolved installDeps
  const omittedDependencies: DependencyOmitKind[] = []
  if (!installDev) omittedDependencies.push("dev")
  if (!installPeer) omittedDependencies.push("peer")
  if (!installOptional) omittedDependencies.push("optional")

  return {
    defaultRegistry,
    scopes,
    registryAuth,
    linkWorkspacePackages,
    saveExact,
    ignoreScripts,
    dryRun,
    installDeps: {
      optional: installOptional,
      dev: installDev,
      peer: installPeer,
      production: installProduction,
    },
    autoInstall,
    lockfile: {
      save: lockfileSave,
      saveTextLockfile,
      frozenLockfile,
      print: lockfilePrint,
    },
    cache,
    security: {
      minimumReleaseAge,
      minimumReleaseAgeExcludes,
      scanner: securityScanner,
    },
    globalInstall: {
      globalStore,
      globalDir,
      globalBinDir,
    },
    run: {
      shell: runShell,
      bun: runBun,
      silent: runSilent,
      noOrphans: runNoOrphans,
    },
    tls,
    omittedDependencies,
    linker,
    linkerSource,
    lockfileSummary,
    publicHoistPattern,
    hoistPattern,
    hoist,
    ...(envToken !== undefined && envToken !== "" ? { envToken } : {}),
    layersApplied,
    warnings,
  }
}

// ── Credential Matching Engine ────────────────────────────────────────────────

function buildAuthHeaderFromNpmrcEntry(
  entry: NpmrcRegistryAuthEntry,
): { readonly scheme: "Bearer" | "Basic"; readonly header: string } | null {
  if (entry.authToken !== undefined && entry.authToken !== "") {
    assertSafeCredentialValue(entry.authToken, `${entry.prefix}:_authToken`)
    return { scheme: "Bearer", header: `Bearer ${entry.authToken}` }
  }
  if (entry.rawAuth !== undefined && entry.rawAuth !== "") {
    assertSafeCredentialValue(entry.rawAuth, `${entry.prefix}:_auth`)
    return { scheme: "Basic", header: `Basic ${entry.rawAuth}` }
  }
  if (entry.username !== undefined && entry.passwordBase64 !== undefined) {
    assertSafeCredentialValue(entry.username, `${entry.prefix}:username`)
    assertSafeCredentialValue(entry.passwordBase64, `${entry.prefix}:_password`)
    const decodedPass = decodeBase64Utf8(entry.passwordBase64)
    assertSafeCredentialValue(decodedPass, `${entry.prefix}:_password (decoded)`)
    const encoded = encodeBase64Utf8(`${entry.username}:${decodedPass}`)
    return { scheme: "Basic", header: `Basic ${encoded}` }
  }
  return null
}

function buildAuthHeaderFromInline(
  cred: ResolvedInlineCredential,
): { readonly scheme: "Bearer" | "Basic"; readonly header: string } | null {
  if (cred.token !== undefined && cred.token !== "") {
    assertSafeCredentialValue(cred.token, `${cred.originSource} token`)
    return { scheme: "Bearer", header: `Bearer ${cred.token}` }
  }
  if (cred.username !== undefined && cred.password !== undefined) {
    assertSafeCredentialValue(cred.username, `${cred.originSource} username`)
    assertSafeCredentialValue(cred.password, `${cred.originSource} password`)
    return {
      scheme: "Basic",
      header: `Basic ${encodeBase64Utf8(`${cred.username}:${cred.password}`)}`,
    }
  }
  return null
}

function lookupNpmrcEntry(
  url: URL,
  registryAuth: Readonly<Record<string, NpmrcRegistryAuthEntry>>,
): { readonly prefix: string; readonly entry: NpmrcRegistryAuthEntry } | null {
  const keys = buildRegistryCredentialLookupKeys(url)
  for (const key of keys) {
    const entry = registryAuth[key]
    if (
      entry &&
      (entry.authToken !== undefined ||
        entry.rawAuth !== undefined ||
        (entry.username !== undefined && entry.passwordBase64 !== undefined))
    ) {
      return { prefix: key, entry }
    }
  }
  return null
}

export interface MatchRegistryCredentialsRequest {
  readonly kind: "registry" | "tarball" | "publishConfig"
  readonly targetUrl: string
  /** Package scope (e.g. "myorg" or "@myorg") when kind === "registry". Ignored for tarballs. */
  readonly scope?: string | undefined
  /** Registry target the tarball originated from (defaults to resolved defaultRegistry). */
  readonly packageRegistryUrl?: string | undefined
  /**
   * For `kind: "tarball"`:
   *
   * - `"project"`: named directly in root, workspace, `file:` dep, `overrides`, catalog, or
   *   `packageExtensions`.
   * - `"transitive"`: named only by another package -> receives NO configured credentials.
   */
  readonly namedBy?: "project" | "transitive" | undefined
}

/**
 * Exact npm/Bun credential resolution for registry requests, tarballs, and
 * `publishConfig.registry`.
 */
export function matchRegistryCredentials(
  config: ResolvedBunPackageConfig,
  request: MatchRegistryCredentialsRequest,
): MatchedCredentialResult {
  // Always validate target URL scheme first (http / https only)
  const parsedTarget = parseValidatedHttpUrl(request.targetUrl, `${request.kind} URL`)

  // 1. Transitive tarball URLs NEVER receive configured credentials
  if (request.kind === "tarball" && request.namedBy === "transitive") {
    return {
      matched: false,
      scheme: null,
      authorizationHeader: null,
      source: "none",
      matchedPrefix: null,
      reason: "Transitive tarball URLs receive no configured credentials in Bun",
    }
  }

  // 2. publishConfig.registry follows the tarball rule (HTTPS-only .npmrc line, no env expansion)
  if (request.kind === "publishConfig") {
    if (parsedTarget.protocol !== "https:") {
      return {
        matched: false,
        scheme: null,
        authorizationHeader: null,
        source: "none",
        matchedPrefix: null,
        reason: "publishConfig.registry only receives .npmrc credentials over https",
      }
    }
    const found = lookupNpmrcEntry(parsedTarget, config.registryAuth)
    if (!found) {
      return {
        matched: false,
        scheme: null,
        authorizationHeader: null,
        source: "none",
        matchedPrefix: null,
        reason: "No matching .npmrc prefix for publishConfig.registry",
      }
    }
    const built = buildAuthHeaderFromNpmrcEntry(found.entry)
    if (!built) {
      return {
        matched: false,
        scheme: null,
        authorizationHeader: null,
        source: "none",
        matchedPrefix: null,
        reason: "Matched .npmrc entry contains no active auth fields",
      }
    }
    return {
      matched: true,
      scheme: built.scheme,
      authorizationHeader: built.header,
      source: "npmrc-prefix",
      matchedPrefix: found.prefix,
      reason: `Matched .npmrc line ${found.prefix} over https`,
    }
  }

  // 3. Tarball rule:
  //    - Same origin as its registry -> inherits registry credentials
  //    - Cross-origin -> gets credential ONLY if .npmrc has a line AND URL is https
  //    - Never picks a scoped registry from the name a tarball URL is listed under
  if (request.kind === "tarball") {
    const registryUrlStr = request.packageRegistryUrl ?? config.defaultRegistry.url
    const parsedRegistry = parseValidatedHttpUrl(registryUrlStr, "package registry URL")

    if (parsedTarget.origin === parsedRegistry.origin) {
      // Find the matching registry target if packageRegistryUrl was explicitly supplied
      let matchedRegistryTarget: ResolvedRegistryTarget | undefined
      if (parsedRegistry.origin === parseValidatedHttpUrl(config.defaultRegistry.url).origin) {
        matchedRegistryTarget = config.defaultRegistry
      } else if (request.packageRegistryUrl) {
        matchedRegistryTarget = Object.values(config.scopes).find((s) => {
          try {
            return parseValidatedHttpUrl(s.url).origin === parsedRegistry.origin
          } catch {
            return false
          }
        })
      }

      if (
        matchedRegistryTarget?.inlineCredential &&
        matchedRegistryTarget.inlineCredential.originSource !== "npmrc-registry-url"
      ) {
        const built = buildAuthHeaderFromInline(matchedRegistryTarget.inlineCredential)
        if (built) {
          return {
            matched: true,
            scheme: built.scheme,
            authorizationHeader: built.header,
            source: matchedRegistryTarget.inlineCredential.originSource,
            matchedPrefix: null,
            reason: `Same-origin tarball inherited ${matchedRegistryTarget.inlineCredential.originSource} credentials from its registry`,
          }
        }
      }

      return matchRegistryCredentials(config, {
        kind: "registry",
        targetUrl: parsedTarget.toString(),
      })
    }

    // Cross-origin tarball: strict HTTPS-only .npmrc lookup
    if (parsedTarget.protocol !== "https:") {
      return {
        matched: false,
        scheme: null,
        authorizationHeader: null,
        source: "none",
        matchedPrefix: null,
        reason:
          "Cross-origin tarball over non-https receives no credentials (Bun never sends registry credentials to another host)",
      }
    }

    const found = lookupNpmrcEntry(parsedTarget, config.registryAuth)
    if (!found) {
      return {
        matched: false,
        scheme: null,
        authorizationHeader: null,
        source: "none",
        matchedPrefix: null,
        reason:
          "Cross-origin tarball has no matching .npmrc prefix; registry credentials are not sent to another host",
      }
    }
    const built = buildAuthHeaderFromNpmrcEntry(found.entry)
    if (!built) {
      return {
        matched: false,
        scheme: null,
        authorizationHeader: null,
        source: "none",
        matchedPrefix: null,
        reason: "Matched cross-origin .npmrc entry has no active auth fields",
      }
    }
    return {
      matched: true,
      scheme: built.scheme,
      authorizationHeader: built.header,
      source: "npmrc-prefix",
      matchedPrefix: found.prefix,
      reason: `Matched cross-origin https tarball via .npmrc prefix ${found.prefix}`,
    }
  }

  // 4. Registry request credential precedence:
  //    (a) Inline credential next to registry URL:
  //        - bunfig.toml token/username+password
  //        - user:password@ in URL (EXCEPT when from .npmrc registry= line)
  //        - BUN_CONFIG_TOKEN / NPM_CONFIG_TOKEN
  //    (b) Matching .npmrc //host/path/:_authToken | _auth | username+_password
  //    (c) Fallback: user:password@ embedded in .npmrc registry= line (replaced by //host/ if present)
  const normScope = request.scope?.replace(/^@/, "").toLowerCase()
  const targetSpec =
    (normScope ? config.scopes[normScope] : undefined) ??
    (parsedTarget.origin === parseValidatedHttpUrl(config.defaultRegistry.url).origin
      ? config.defaultRegistry
      : undefined)

  // Check URL-embedded user:pass@ directly on targetUrl (non-npmrc)
  if (parsedTarget.username || parsedTarget.password) {
    const username = decodeURIComponent(parsedTarget.username)
    const password = decodeURIComponent(parsedTarget.password)
    assertSafeCredentialValue(username, "URL username")
    assertSafeCredentialValue(password, "URL password")
    return {
      matched: true,
      scheme: "Basic",
      authorizationHeader: `Basic ${encodeBase64Utf8(`${username}:${password}`)}`,
      source: "url",
      matchedPrefix: null,
      reason: "Matched inline user:password@ embedded in target URL",
    }
  }

  // Inline bunfig or non-npmrc URL credentials win over .npmrc //host/ lines
  if (
    targetSpec?.inlineCredential &&
    targetSpec.inlineCredential.originSource !== "npmrc-registry-url"
  ) {
    const built = buildAuthHeaderFromInline(targetSpec.inlineCredential)
    if (built) {
      return {
        matched: true,
        scheme: built.scheme,
        authorizationHeader: built.header,
        source: targetSpec.inlineCredential.originSource,
        matchedPrefix: null,
        reason: `Matched inline credential from ${targetSpec.inlineCredential.originSource}`,
      }
    }
  }

  // BUN_CONFIG_TOKEN / NPM_CONFIG_TOKEN wins over .npmrc //host/ lines for default registry
  const defaultOrigin = parseValidatedHttpUrl(config.defaultRegistry.url).origin
  if (config.envToken && parsedTarget.origin === defaultOrigin) {
    assertSafeCredentialValue(config.envToken, "BUN_CONFIG_TOKEN / NPM_CONFIG_TOKEN")
    return {
      matched: true,
      scheme: "Bearer",
      authorizationHeader: `Bearer ${config.envToken}`,
      source: "env-token",
      matchedPrefix: null,
      reason: "Matched BUN_CONFIG_TOKEN / NPM_CONFIG_TOKEN for default registry",
    }
  }

  // Matching .npmrc //host/path/ line (replaces .npmrc registry= inline creds)
  const foundNpmrc = lookupNpmrcEntry(parsedTarget, config.registryAuth)
  if (foundNpmrc) {
    const built = buildAuthHeaderFromNpmrcEntry(foundNpmrc.entry)
    if (built) {
      return {
        matched: true,
        scheme: built.scheme,
        authorizationHeader: built.header,
        source: "npmrc-prefix",
        matchedPrefix: foundNpmrc.prefix,
        reason: `Matched .npmrc credential line ${foundNpmrc.prefix}`,
      }
    }
  }

  // Fallback: inline credential inside .npmrc registry= line when no //host/ line matched
  if (targetSpec?.inlineCredential?.originSource === "npmrc-registry-url") {
    const built = buildAuthHeaderFromInline(targetSpec.inlineCredential)
    if (built) {
      return {
        matched: true,
        scheme: built.scheme,
        authorizationHeader: built.header,
        source: "npmrc-registry-url",
        matchedPrefix: null,
        reason: "Matched fallback credential embedded in .npmrc registry= URL",
      }
    }
  }

  return {
    matched: false,
    scheme: null,
    authorizationHeader: null,
    source: "none",
    matchedPrefix: null,
    reason: "No matching credentials for target URL",
  }
}

/**
 * Safe redacted audit wrapper around `matchRegistryCredentials` for UI/API use. Never returns raw
 * tokens, passwords, or Authorization headers.
 */
export function auditRegistryCredentialMatch(
  config: ResolvedBunPackageConfig,
  request: MatchRegistryCredentialsRequest,
): RedactedCredentialMatchAudit {
  try {
    const res = matchRegistryCredentials(config, request)
    return {
      matched: res.matched,
      scheme: res.scheme,
      source: res.source,
      matchedPrefix: res.matchedPrefix,
      reason: res.reason,
    }
  } catch (err) {
    return {
      matched: false,
      scheme: null,
      source: "none",
      matchedPrefix: null,
      reason: "Validation failed",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── bunfig.toml Migration Generator (Secret-Safe) ─────────────────────────────

/**
 * Convert a resolved `.npmrc` / Bun package config into a clean, secret-safe `bunfig.toml`
 * representation. Never emits literal tokens or decoded passwords.
 */
export function convertNpmrcToBunfigToml(config: ResolvedBunPackageConfig): string {
  const lines: string[] = [
    "# Migrated from .npmrc to bunfig.toml (secrets replaced with $ENV_VAR placeholders)",
    "[install]",
  ]

  if (config.defaultRegistry.url !== DEFAULT_NPM_REGISTRY) {
    lines.push(`registry = ${JSON.stringify(config.defaultRegistry.url)}`)
  }
  if (!config.installDeps.optional) lines.push("optional = false")
  if (!config.installDeps.dev) lines.push("dev = false")
  if (!config.installDeps.peer) lines.push("peer = false")
  if (config.installDeps.production) lines.push("production = true")
  if (config.linkWorkspacePackages) {
    lines.push("linkWorkspacePackages = true")
  }
  if (config.saveExact) {
    lines.push("exact = true")
  }
  if (config.lockfile.frozenLockfile) {
    lines.push("frozenLockfile = true")
  }
  if (!config.lockfile.saveTextLockfile) {
    lines.push("saveTextLockfile = false")
  }
  if (config.autoInstall !== "auto") {
    lines.push(`auto = ${JSON.stringify(config.autoInstall)}`)
  }
  if (config.ignoreScripts) {
    lines.push("ignoreScripts = true")
  }
  if (config.dryRun) {
    lines.push("dryRun = true")
  }
  if (config.linker === "isolated") {
    lines.push('linker = "isolated"')
  }
  if (config.globalInstall.globalStore) {
    lines.push("globalStore = true")
  }
  if (config.security.minimumReleaseAge !== null) {
    const val =
      typeof config.security.minimumReleaseAge === "number"
        ? String(config.security.minimumReleaseAge)
        : JSON.stringify(config.security.minimumReleaseAge)
    lines.push(`minimumReleaseAge = ${val}`)
  }
  if (config.security.minimumReleaseAgeExcludes.length > 0) {
    lines.push(
      `minimumReleaseAgeExcludes = [${config.security.minimumReleaseAgeExcludes.map((x) => JSON.stringify(x)).join(", ")}]`,
    )
  }
  if (config.publicHoistPattern.length > 0) {
    lines.push(
      `publicHoistPattern = [${config.publicHoistPattern.map((x) => JSON.stringify(x)).join(", ")}]`,
    )
  }
  if (config.hoistPattern.length > 0) {
    lines.push(`hoistPattern = [${config.hoistPattern.map((x) => JSON.stringify(x)).join(", ")}]`)
  }
  if (config.tls.cafile) {
    lines.push(`cafile = ${JSON.stringify(config.tls.cafile)}`)
  } else if (config.tls.ca.length === 1) {
    lines.push(`ca = ${JSON.stringify(config.tls.ca[0]!)}`)
  } else if (config.tls.ca.length > 1) {
    lines.push(`ca = [${config.tls.ca.map((c) => JSON.stringify(c)).join(", ")}]`)
  }

  if (!config.lockfile.save || config.lockfile.print) {
    lines.push("")
    lines.push("[install.lockfile]")
    if (!config.lockfile.save) lines.push("save = false")
    if (config.lockfile.print) {
      lines.push(`print = ${JSON.stringify(config.lockfile.print)}`)
    }
  }

  if (config.cache.disabled || config.cache.disableManifest || config.cache.dir) {
    lines.push("")
    lines.push("[install.cache]")
    if (config.cache.dir) {
      lines.push(`dir = ${JSON.stringify(config.cache.dir)}`)
    }
    if (config.cache.disabled) {
      lines.push("disable = true")
    }
    if (config.cache.disableManifest) {
      lines.push("disableManifest = true")
    }
  }

  if (config.security.scanner) {
    lines.push("")
    lines.push("[install.security]")
    lines.push(`scanner = ${JSON.stringify(config.security.scanner)}`)
  }

  const scopeEntries = Object.entries(config.scopes).sort(([a], [b]) => a.localeCompare(b))
  if (scopeEntries.length > 0) {
    lines.push("")
    lines.push("[install.scopes]")
    for (const [scope, target] of scopeEntries) {
      const parsed = parseValidatedHttpUrl(target.url)
      const found = lookupNpmrcEntry(parsed, config.registryAuth)
      const key = /^[a-zA-Z0-9_-]+$/.test(scope) ? scope : JSON.stringify(scope)
      if (found?.entry.authToken !== undefined) {
        const tokenRef = found.entry.authTokenEnvRef
          ? `$${found.entry.authTokenEnvRef}`
          : "$NPM_TOKEN"
        lines.push(
          `${key} = { url = ${JSON.stringify(target.url)}, token = ${JSON.stringify(tokenRef)} }`,
        )
      } else if (found?.entry.username !== undefined && found.entry.passwordBase64 !== undefined) {
        const passRef = found.entry.passwordEnvRef
          ? `$${found.entry.passwordEnvRef}`
          : "$NPM_PASSWORD"
        lines.push(
          `${key} = { url = ${JSON.stringify(target.url)}, username = ${JSON.stringify(found.entry.username)}, password = ${JSON.stringify(passRef)} }`,
        )
      } else {
        lines.push(`${key} = ${JSON.stringify(target.url)}`)
      }
    }
  }

  if (
    config.run.shell !== "system" ||
    config.run.bun ||
    config.run.silent ||
    config.run.noOrphans
  ) {
    lines.push("")
    lines.push("[run]")
    if (config.run.shell !== "system") {
      lines.push(`shell = ${JSON.stringify(config.run.shell)}`)
    }
    if (config.run.bun) lines.push("bun = true")
    if (config.run.silent) lines.push("silent = true")
    if (config.run.noOrphans) lines.push("noOrphans = true")
  }

  return `${lines.join("\n")}\n`
}

// ── Strictly Redacted Snapshot Builder for HTTP / UI ──────────────────────────

export function redactResolvedBunPackageConfig(
  config: ResolvedBunPackageConfig,
  layers: readonly NpmrcLayerStatus[],
): RedactedNpmrcStatusSummary {
  const defaultAudit = auditRegistryCredentialMatch(config, {
    kind: "registry",
    targetUrl: config.defaultRegistry.url,
  })

  const scopes = Object.entries(config.scopes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, target]) => {
      const audit = auditRegistryCredentialMatch(config, {
        kind: "registry",
        targetUrl: target.url,
        scope,
      })
      return {
        scope: `@${scope}`,
        registryUrl: target.url,
        source: target.source,
        hasAuth: audit.matched,
        authScheme: audit.scheme,
        matchedPrefix: audit.matchedPrefix,
      }
    })

  const credentialPrefixes = Object.values(config.registryAuth)
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
    .map((entry) => {
      let authKind: "bearer-token" | "basic-auth" | "username-password" | "none" = "none"
      if (entry.authToken !== undefined && entry.authToken !== "") {
        authKind = "bearer-token"
      } else if (entry.rawAuth !== undefined && entry.rawAuth !== "") {
        authKind = "basic-auth"
      } else if (entry.username !== undefined && entry.passwordBase64 !== undefined) {
        authKind = "username-password"
      }
      return {
        prefix: entry.prefix,
        source: entry.source,
        authKind,
        hasEmailIgnored: entry.email !== undefined,
      }
    })

  return {
    defaultRegistryUrl: config.defaultRegistry.url,
    defaultRegistrySource: config.defaultRegistry.source,
    defaultRegistryHasAuth: defaultAudit.matched,
    defaultRegistryAuthScheme: defaultAudit.scheme,
    scopes,
    credentialPrefixes,
    options: {
      linkWorkspacePackages: config.linkWorkspacePackages,
      saveExact: config.saveExact,
      ignoreScripts: config.ignoreScripts,
      dryRun: config.dryRun,
      optional: config.installDeps.optional,
      dev: config.installDeps.dev,
      peer: config.installDeps.peer,
      production: config.installDeps.production,
      autoInstall: config.autoInstall,
      lockfileSave: config.lockfile.save,
      saveTextLockfile: config.lockfile.saveTextLockfile,
      frozenLockfile: config.lockfile.frozenLockfile,
      lockfilePrint: config.lockfile.print,
      cacheDisabled: config.cache.disabled,
      cacheDisableManifest: config.cache.disableManifest,
      cacheDir: config.cache.dir,
      minimumReleaseAge: config.security.minimumReleaseAge,
      minimumReleaseAgeExcludes: config.security.minimumReleaseAgeExcludes,
      securityScanner: config.security.scanner,
      globalStore: config.globalInstall.globalStore,
      globalDir: config.globalInstall.globalDir,
      globalBinDir: config.globalInstall.globalBinDir,
      runShell: config.run.shell,
      runBun: config.run.bun,
      runSilent: config.run.silent,
      runNoOrphans: config.run.noOrphans,
      cafile: config.tls.cafile,
      caCertCount: config.tls.ca.length,
      omittedDependencies: config.omittedDependencies,
      linker: config.linker,
      linkerSource: config.linkerSource,
      publicHoistPattern: config.publicHoistPattern,
      hoistPattern: config.hoistPattern,
      hoist: config.hoist,
    },
    lockfileSummary: config.lockfileSummary ?? null,
    layers,
    bunfigMigrationPreview: convertNpmrcToBunfigToml(config),
    warnings: config.warnings,
  }
}
