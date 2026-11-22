/**
 * @file scripts/check_registry_parity.ts
 * @description Workspace manifest, Bun version pin, `.npmrc`, `bunfig.toml`,
 * and `NPM_CONFIG_USERCONFIG` registry parity audit & CI gate.
 *
 * Verifies parity across:
 *  1. `.bun-version` vs `package.json` (`packageManager`, `engines.bun`, `@types/bun`),
 *     `tools/registry/package.json`, and `.github/workflows/ci.yml`.
 *  2. Root `package.json` `workspaces` globs vs actual `packages/*` manifests,
 *     internal workspace dependency targets, and `bun.lock` workspace entries.
 *  3. Absence of nested `.npmrc`, `bunfig.toml`, or `publishConfig.registry`
 *     overrides inside workspace packages.
 *  4. Root `bunfig.toml`, project `.npmrc`, `package.json` `publishConfig.registry`,
 *     `NPM_CONFIG_USERCONFIG` (when configured), and `tools/registry/bunfig.toml`
 *     registry/scope/auth parity with secret-leak protection.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseBunLockFile } from "../packages/contracts/src/bun_lockfile.ts"
import {
  DEFAULT_NPM_REGISTRY,
  parseBunfigInstallToml,
  parseNpmrc,
  resolveNpmrcPath,
  type ParsedBunfigInstallConfig,
  type ParsedNpmrcFile,
} from "../packages/contracts/src/npmrc.ts"

export interface RegistryParityBunVersionReport {
  readonly dotBunVersion: string | null
  readonly rootPackageManager: string | null
  readonly rootEnginesBun: string | null
  readonly typesBun: string | null
  readonly toolsRegistryPackageManager: string | null
  readonly toolsRegistryEnginesBun: string | null
  readonly ciUsesVersionFile: boolean
}

export interface RegistryParityWorkspacesReport {
  readonly declaredGlobs: readonly string[]
  readonly resolvedPaths: readonly string[]
  readonly lockfilePaths: readonly string[]
  readonly packageNames: Readonly<Record<string, string>>
  readonly internalDependenciesValid: boolean
}

export interface RegistryParitySourcesReport {
  readonly rootPublishConfigRegistry: string | null
  readonly bunfigDefaultRegistry: string | null
  readonly bunfigScopes: Readonly<Record<string, string>>
  readonly projectNpmrcRegistry: string | null
  readonly projectNpmrcScopes: Readonly<Record<string, string>>
  readonly projectNpmrcAuthPrefixes: readonly string[]
  readonly userNpmrcPath: string | null
  readonly userNpmrcDetected: boolean
  readonly userNpmrcRegistry: string | null
  readonly userNpmrcScopes: Readonly<Record<string, string>>
  readonly nestedOverrideFiles: readonly string[]
}

export interface RegistryParityReport {
  readonly ok: boolean
  readonly bunVersion: RegistryParityBunVersionReport
  readonly workspaces: RegistryParityWorkspacesReport
  readonly registrySources: RegistryParitySourcesReport
  readonly violations: readonly string[]
  readonly warnings: readonly string[]
}

export interface AuditRegistryParityOptions {
  readonly rootDir?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly homeDir?: string | undefined
}

interface PackageManifestJson {
  readonly name?: string
  readonly version?: string
  readonly private?: boolean
  readonly packageManager?: string
  readonly engines?: Readonly<Record<string, string>>
  readonly publishConfig?: {
    readonly tag?: string
    readonly registry?: string
  }
  readonly workspaces?: readonly string[]
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

function readJsonSafe<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T
  } catch {
    return null
  }
}

export function normalizeRegistryEndpoint(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  try {
    const parsed = new URL(trimmed)
    const cleanPath = parsed.pathname.replace(/\/+$/, "") || "/"
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${cleanPath === "/" ? "/" : `${cleanPath}/`}`
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase()
  }
}

function isLoopbackHost(registryUrl: string): boolean {
  try {
    const host = new URL(registryUrl).hostname.toLowerCase()
    return host === "127.0.0.1" || host === "localhost" || host === "::1"
  } catch {
    return false
  }
}

function authPrefixForRegistry(registryUrl: string): string | null {
  try {
    const parsed = new URL(registryUrl)
    const cleanPath = parsed.pathname.replace(/\/+$/, "")
    return `//${parsed.host.toLowerCase()}${cleanPath}/`
  } catch {
    return null
  }
}

function hasCredentialForRegistry(npmrc: ParsedNpmrcFile, registryUrl: string): boolean {
  const prefix = authPrefixForRegistry(registryUrl)
  if (!prefix) return false
  for (const [key, entry] of Object.entries(npmrc.registryAuth)) {
    const normalizedKey = key.toLowerCase().endsWith("/")
      ? key.toLowerCase()
      : `${key.toLowerCase()}/`
    if (normalizedKey === prefix) {
      return Boolean(
        entry.authToken ||
        entry.authTokenEnvRef ||
        entry.rawAuth ||
        entry.rawAuthEnvRef ||
        entry.username ||
        entry.passwordBase64 ||
        entry.passwordEnvRef,
      )
    }
  }
  return false
}

function extractBunPackageManagerVersion(packageManager: string | undefined): string | null {
  if (!packageManager) return null
  const match = /^bun@(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/i.exec(packageManager.trim())
  return match?.[1] ?? packageManager.trim()
}

function extractRegistryUrlFromBunfig(reg: ParsedBunfigInstallConfig["registry"]): string | null {
  if (!reg) return null
  if (typeof reg === "string") return reg
  return reg.url
}

function extractScopesFromBunfig(
  scopes: ParsedBunfigInstallConfig["scopes"],
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!scopes) return out
  for (const [rawScope, value] of Object.entries(scopes)) {
    const normalizedScope = rawScope.startsWith("@") ? rawScope : `@${rawScope}`
    const url = typeof value === "string" ? value : value.url
    if (url) out[normalizedScope] = url
  }
  return out
}

function expandWorkspaceGlobs(rootDir: string, globs: readonly string[]): string[] {
  const matched: string[] = []
  const seen = new Set<string>()

  for (const pattern of globs) {
    const clean = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "")
    if (!clean) continue
    if (clean.endsWith("/*")) {
      const parentRel = clean.slice(0, -2)
      const parentAbs = resolve(rootDir, parentRel)
      if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) continue
      for (const entry of readdirSync(parentAbs).sort()) {
        if (entry.startsWith(".") || entry === "node_modules") continue
        const relPath = `${parentRel}/${entry}`
        const absPath = resolve(rootDir, relPath)
        if (statSync(absPath).isDirectory() && !seen.has(relPath)) {
          seen.add(relPath)
          matched.push(relPath)
        }
      }
    } else {
      const absPath = resolve(rootDir, clean)
      if (existsSync(absPath) && statSync(absPath).isDirectory() && !seen.has(clean)) {
        seen.add(clean)
        matched.push(clean)
      }
    }
  }

  return matched.sort()
}

function findRealSecretTokenInTrackedNpmrc(npmrc: ParsedNpmrcFile): string | null {
  for (const [prefix, entry] of Object.entries(npmrc.registryAuth)) {
    const token = entry.authToken?.trim()
    if (!token) continue
    const isEnvPlaceholder = /^\$\{[A-Za-z0-9_]+\??\}$/.test(token)
    if (isEnvPlaceholder) continue
    const isLocalLoopback =
      prefix.startsWith("//127.0.0.1:") ||
      prefix.startsWith("//localhost:") ||
      prefix.startsWith("//[::1]:")
    const isKnownPlaceholder = token === "local-development" || token === "placeholder"
    if (isLocalLoopback && isKnownPlaceholder) continue
    if (/^(?:ghp_|github_pat_|gho_|ghu_|npm_[A-Za-z0-9]{10,})/.test(token) || !isLocalLoopback) {
      return `Tracked .npmrc contains non-placeholder literal token for '${prefix}' (use \${ENV_VAR} instead)`
    }
  }
  return null
}

/**
 * Audit workspace manifests, Bun version pins, `bunfig.toml`, project `.npmrc`,
 * and optional `NPM_CONFIG_USERCONFIG` for configuration parity.
 */
export function auditWorkspaceRegistryParity(
  options: AuditRegistryParityOptions = {},
): RegistryParityReport {
  const rootDir = resolve(options.rootDir ?? process.cwd())
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? env.HOME?.trim() ?? homedir()

  const violations: string[] = []
  const warnings: string[] = []

  // -------------------------------------------------------------------------
  // 1. Bun version parity (.bun-version, root package.json, tools/registry, ci.yml)
  // -------------------------------------------------------------------------
  const bunVersionPath = resolve(rootDir, ".bun-version")
  const dotBunVersion = existsSync(bunVersionPath)
    ? readFileSync(bunVersionPath, "utf8").trim()
    : null
  if (!dotBunVersion) {
    violations.push("Missing `.bun-version` file in repository root")
  } else if (!/^\d+\.\d+\.\d+/.test(dotBunVersion)) {
    violations.push(`Invalid semver in .bun-version: '${dotBunVersion}'`)
  }

  const rootPkg = readJsonSafe<PackageManifestJson>(resolve(rootDir, "package.json"))
  if (!rootPkg) {
    violations.push("Missing or unreadable root `package.json`")
  }

  const rootPackageManager = extractBunPackageManagerVersion(rootPkg?.packageManager)
  const rootEnginesBun = rootPkg?.engines?.bun?.trim() ?? null
  const typesBun = rootPkg?.devDependencies?.["@types/bun"]?.trim() ?? null

  if (dotBunVersion) {
    if (rootPackageManager && rootPackageManager !== dotBunVersion) {
      violations.push(
        `package.json packageManager 'bun@${rootPackageManager}' diverges from .bun-version '${dotBunVersion}'`,
      )
    }
    if (rootEnginesBun && rootEnginesBun !== dotBunVersion) {
      violations.push(
        `package.json engines.bun '${rootEnginesBun}' diverges from .bun-version '${dotBunVersion}'`,
      )
    }
    if (typesBun && typesBun.replace(/^[~^]/, "") !== dotBunVersion) {
      violations.push(
        `package.json devDependencies.@types/bun '${typesBun}' diverges from .bun-version '${dotBunVersion}'`,
      )
    }
  }

  const toolsRegistryPkg = readJsonSafe<PackageManifestJson>(
    resolve(rootDir, "tools/registry/package.json"),
  )
  const toolsRegistryPackageManager = extractBunPackageManagerVersion(
    toolsRegistryPkg?.packageManager,
  )
  const toolsRegistryEnginesBun = toolsRegistryPkg?.engines?.bun?.trim() ?? null
  if (dotBunVersion && toolsRegistryPkg) {
    if (toolsRegistryPackageManager && toolsRegistryPackageManager !== dotBunVersion) {
      violations.push(
        `tools/registry/package.json packageManager 'bun@${toolsRegistryPackageManager}' diverges from .bun-version '${dotBunVersion}'`,
      )
    }
    if (toolsRegistryEnginesBun && toolsRegistryEnginesBun !== dotBunVersion) {
      violations.push(
        `tools/registry/package.json engines.bun '${toolsRegistryEnginesBun}' diverges from .bun-version '${dotBunVersion}'`,
      )
    }
  }

  const ciPath = resolve(rootDir, ".github/workflows/ci.yml")
  let ciUsesVersionFile = false
  if (existsSync(ciPath)) {
    const ciText = readFileSync(ciPath, "utf8")
    ciUsesVersionFile = /bun-version-file:\s*\.bun-version/.test(ciText)
    if (!ciUsesVersionFile) {
      violations.push(
        ".github/workflows/ci.yml must use `bun-version-file: .bun-version` for CI/local Bun parity",
      )
    }
    for (const m of ciText.matchAll(/bun-version:\s*["']?([^\s"']+)["']?/g)) {
      if (dotBunVersion && m[1] !== dotBunVersion) {
        violations.push(
          `.github/workflows/ci.yml pins bun-version '${m[1]}' instead of .bun-version '${dotBunVersion}'`,
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Workspace manifest parity (package.json <-> packages/* <-> bun.lock)
  // -------------------------------------------------------------------------
  const declaredGlobs = Array.isArray(rootPkg?.workspaces) ? [...rootPkg.workspaces] : []
  if (declaredGlobs.length === 0) {
    violations.push("Root `package.json` must declare non-empty `workspaces`")
  }

  const resolvedPaths = expandWorkspaceGlobs(rootDir, declaredGlobs)
  const packageNames: Record<string, string> = {}
  const nestedOverrideFiles: string[] = []
  const workspacePackagesByName = new Map<string, { path: string; pkg: PackageManifestJson }>()

  for (const relPath of resolvedPaths) {
    const pkgFile = resolve(rootDir, relPath, "package.json")
    const pkg = readJsonSafe<PackageManifestJson>(pkgFile)
    if (!pkg) {
      violations.push(`Workspace '${relPath}' is missing readable package.json`)
      continue
    }
    if (!pkg.name) {
      violations.push(`Workspace '${relPath}/package.json' is missing required 'name'`)
      continue
    }
    if (workspacePackagesByName.has(pkg.name)) {
      violations.push(`Duplicate workspace package name '${pkg.name}' in '${relPath}'`)
    }
    packageNames[relPath] = pkg.name
    workspacePackagesByName.set(pkg.name, { path: relPath, pkg })

    if (pkg.private !== true) {
      warnings.push(`Workspace '${pkg.name}' (${relPath}) is not marked private: true`)
    }
    if (pkg.publishConfig?.registry) {
      nestedOverrideFiles.push(`${relPath}/package.json#publishConfig.registry`)
      violations.push(
        `Nested workspace '${relPath}/package.json' must not redeclare publishConfig.registry ('${pkg.publishConfig.registry}')`,
      )
    }
    if (existsSync(resolve(rootDir, relPath, ".npmrc"))) {
      nestedOverrideFiles.push(`${relPath}/.npmrc`)
      violations.push(`Nested workspace '${relPath}/.npmrc' overrides root registry configuration`)
    }
    if (existsSync(resolve(rootDir, relPath, "bunfig.toml"))) {
      nestedOverrideFiles.push(`${relPath}/bunfig.toml`)
      violations.push(
        `Nested workspace '${relPath}/bunfig.toml' overrides root Bun install configuration`,
      )
    }
  }

  // Check for un-declared folders under packages/ if packages/* is used
  const packagesRoot = resolve(rootDir, "packages")
  if (existsSync(packagesRoot) && statSync(packagesRoot).isDirectory()) {
    for (const entry of readdirSync(packagesRoot)) {
      if (entry.startsWith(".") || entry === "node_modules") continue
      const rel = `packages/${entry}`
      const abs = resolve(rootDir, rel)
      if (statSync(abs).isDirectory() && !resolvedPaths.includes(rel)) {
        violations.push(
          `Directory '${rel}' exists under packages/ but is not covered by workspaces`,
        )
      }
    }
  }

  // Validate internal workspace "*" / "workspace:*" references
  let internalDependenciesValid = true
  for (const [pkgName, { path: wsPath, pkg }] of workspacePackagesByName) {
    for (const [depName, spec] of Object.entries({
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    })) {
      if (
        spec.startsWith("workspace:") ||
        (depName.startsWith("@sportsdesk-ops/") && spec === "*")
      ) {
        if (!workspacePackagesByName.has(depName)) {
          internalDependenciesValid = false
          violations.push(
            `Workspace '${pkgName}' (${wsPath}) references missing internal workspace '${depName}' (${spec})`,
          )
        }
      }
    }
  }

  // Compare declared workspaces against bun.lock
  const lockfilePath = resolve(rootDir, "bun.lock")
  let lockfilePaths: string[] = []
  if (existsSync(lockfilePath)) {
    try {
      const parsedLock = parseBunLockFile(readFileSync(lockfilePath, "utf8"))
      const lockWorkspaces = parsedLock.workspaces ?? {}
      lockfilePaths = Object.keys(lockWorkspaces)
        .filter((k) => k !== "")
        .sort()

      for (const relPath of resolvedPaths) {
        const lockEntry = lockWorkspaces[relPath]
        if (!lockEntry) {
          violations.push(
            `Workspace '${relPath}' declared in package.json is missing from bun.lock workspaces`,
          )
        } else if (packageNames[relPath] && lockEntry.name !== packageNames[relPath]) {
          violations.push(
            `bun.lock workspace '${relPath}' name '${lockEntry.name ?? "unset"}' disagrees with package.json '${packageNames[relPath]}'`,
          )
        }
      }
      for (const lockRel of lockfilePaths) {
        if (!resolvedPaths.includes(lockRel)) {
          violations.push(
            `bun.lock contains stale workspace '${lockRel}' not declared in package.json workspaces`,
          )
        }
      }
    } catch (err) {
      violations.push(
        `Unable to parse bun.lock for workspace parity: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  } else {
    violations.push("Missing `bun.lock` for workspace parity check")
  }

  // -------------------------------------------------------------------------
  // 3. Registry parity: package.json <-> bunfig.toml <-> .npmrc <-> NPM_CONFIG_USERCONFIG
  // -------------------------------------------------------------------------
  const rootPublishConfigRegistry = rootPkg?.publishConfig?.registry?.trim() ?? null

  const rootBunfigPath = resolve(rootDir, "bunfig.toml")
  let projectBunfig: ParsedBunfigInstallConfig | null = null
  if (existsSync(rootBunfigPath)) {
    projectBunfig = parseBunfigInstallToml(
      readFileSync(rootBunfigPath, "utf8"),
      "project-bunfig",
      env,
      rootBunfigPath,
    )
  } else {
    violations.push("Missing root `bunfig.toml`")
  }

  const bunfigDefaultRegistry = projectBunfig
    ? extractRegistryUrlFromBunfig(projectBunfig.registry)
    : null
  const bunfigScopes = projectBunfig ? extractScopesFromBunfig(projectBunfig.scopes) : {}

  const projectNpmrcPath = resolve(rootDir, ".npmrc")
  let projectNpmrc: ParsedNpmrcFile | null = null
  if (existsSync(projectNpmrcPath)) {
    projectNpmrc = parseNpmrc(readFileSync(projectNpmrcPath, "utf8"), {
      source: "project-npmrc",
      filePath: projectNpmrcPath,
      baseDir: dirname(projectNpmrcPath),
      homeDir,
      env,
    })
  }

  const projectNpmrcRegistry = projectNpmrc?.registry ?? null
  const projectNpmrcScopes: Record<string, string> = {}
  if (projectNpmrc) {
    for (const [rawScope, url] of Object.entries(projectNpmrc.scopes)) {
      const normalizedScope = rawScope.startsWith("@") ? rawScope : `@${rawScope}`
      projectNpmrcScopes[normalizedScope] = url
    }
  }
  const projectNpmrcAuthPrefixes = projectNpmrc ? Object.keys(projectNpmrc.registryAuth).sort() : []

  // Secret hygiene & auth prefix parity on project .npmrc
  if (projectNpmrc) {
    const tokenIssue = findRealSecretTokenInTrackedNpmrc(projectNpmrc)
    if (tokenIssue) violations.push(tokenIssue)

    for (const [scope, scopeUrl] of Object.entries(projectNpmrcScopes)) {
      if (isLoopbackHost(scopeUrl)) {
        if (!hasCredentialForRegistry(projectNpmrc, scopeUrl)) {
          violations.push(
            `.npmrc configures local scope '${scope}=${scopeUrl}' without matching loopback credential prefix (Bun requires a placeholder _authToken for local publishing)`,
          )
        }
      } else if (!scopeUrl.toLowerCase().startsWith("https://")) {
        violations.push(`.npmrc scope '${scope}' uses non-HTTPS remote registry '${scopeUrl}'`)
      }
    }
  }

  // Cross-check default registry parity between publishConfig, bunfig.toml, and .npmrc
  if (bunfigDefaultRegistry && projectNpmrcRegistry) {
    if (
      normalizeRegistryEndpoint(bunfigDefaultRegistry) !==
      normalizeRegistryEndpoint(projectNpmrcRegistry)
    ) {
      violations.push(
        `Default registry mismatch: bunfig.toml sets '${bunfigDefaultRegistry}' while .npmrc sets '${projectNpmrcRegistry}'`,
      )
    }
  }

  if (rootPublishConfigRegistry && bunfigDefaultRegistry) {
    if (
      normalizeRegistryEndpoint(rootPublishConfigRegistry) !==
      normalizeRegistryEndpoint(bunfigDefaultRegistry)
    ) {
      violations.push(
        `Default registry mismatch: package.json publishConfig.registry '${rootPublishConfigRegistry}' diverges from bunfig.toml '${bunfigDefaultRegistry}'`,
      )
    }
  }

  if (rootPublishConfigRegistry && projectNpmrcRegistry) {
    if (
      normalizeRegistryEndpoint(rootPublishConfigRegistry) !==
      normalizeRegistryEndpoint(projectNpmrcRegistry)
    ) {
      violations.push(
        `Default registry mismatch: package.json publishConfig.registry '${rootPublishConfigRegistry}' diverges from .npmrc '${projectNpmrcRegistry}'`,
      )
    }
  }

  // Cross-check scoped registry parity between bunfig.toml [install.scopes] and .npmrc
  const allScopes = new Set([...Object.keys(bunfigScopes), ...Object.keys(projectNpmrcScopes)])
  for (const scope of allScopes) {
    const bunfigUrl = bunfigScopes[scope]
    const npmrcUrl = projectNpmrcScopes[scope]
    if (bunfigUrl && npmrcUrl) {
      if (normalizeRegistryEndpoint(bunfigUrl) !== normalizeRegistryEndpoint(npmrcUrl)) {
        violations.push(
          `Scope '${scope}' registry mismatch: bunfig.toml declares '${bunfigUrl}' while .npmrc declares '${npmrcUrl}'`,
        )
      }
    } else if (bunfigUrl && !npmrcUrl && !isLoopbackHost(bunfigUrl)) {
      const scopeEntry = projectBunfig?.scopes?.[scope.replace(/^@/, "")]
      const hasInlineToken = typeof scopeEntry === "object" && Boolean(scopeEntry?.token)
      if (!hasInlineToken && !env.NPM_CONFIG_USERCONFIG?.trim()) {
        warnings.push(
          `Scope '${scope}' declared in bunfig.toml ('${bunfigUrl}') has no matching entry in project .npmrc or NPM_CONFIG_USERCONFIG`,
        )
      }
    }
  }

  // Validate NPM_CONFIG_USERCONFIG parity when set (e.g. CI private-registry env)
  const rawUserConfig =
    env.NPM_CONFIG_USERCONFIG?.trim() || env.npm_config_userconfig?.trim() || null
  let userNpmrcPath: string | null = null
  let userNpmrcDetected = false
  let userNpmrcRegistry: string | null = null
  const userNpmrcScopes: Record<string, string> = {}

  if (rawUserConfig) {
    userNpmrcPath = resolveNpmrcPath(rawUserConfig, rootDir, homeDir)
    if (!existsSync(userNpmrcPath)) {
      violations.push(
        `NPM_CONFIG_USERCONFIG points to missing file '${rawUserConfig}' (resolved: ${userNpmrcPath})`,
      )
    } else {
      userNpmrcDetected = true
      const userNpmrc = parseNpmrc(readFileSync(userNpmrcPath, "utf8"), {
        source: "user-npmrc",
        filePath: userNpmrcPath,
        baseDir: dirname(userNpmrcPath),
        homeDir,
        env,
      })
      userNpmrcRegistry = userNpmrc.registry ?? null
      for (const [rawScope, url] of Object.entries(userNpmrc.scopes)) {
        const normalizedScope = rawScope.startsWith("@") ? rawScope : `@${rawScope}`
        userNpmrcScopes[normalizedScope] = url

        const expectedUrl = bunfigScopes[normalizedScope] ?? projectNpmrcScopes[normalizedScope]
        if (
          expectedUrl &&
          normalizeRegistryEndpoint(url) !== normalizeRegistryEndpoint(expectedUrl)
        ) {
          violations.push(
            `NPM_CONFIG_USERCONFIG scope '${normalizedScope}' ('${url}') diverges from project config ('${expectedUrl}')`,
          )
        }
      }

      if (userNpmrcRegistry) {
        const expectedDefault =
          bunfigDefaultRegistry ??
          projectNpmrcRegistry ??
          rootPublishConfigRegistry ??
          DEFAULT_NPM_REGISTRY
        if (
          normalizeRegistryEndpoint(userNpmrcRegistry) !==
          normalizeRegistryEndpoint(expectedDefault)
        ) {
          violations.push(
            `NPM_CONFIG_USERCONFIG registry '${userNpmrcRegistry}' diverges from expected default '${expectedDefault}'`,
          )
        }
      }
    }
  }

  // Check standalone tools/registry/bunfig.toml preserves security settings without overriding registries
  const toolsRegistryBunfigPath = resolve(rootDir, "tools/registry/bunfig.toml")
  if (existsSync(toolsRegistryBunfigPath)) {
    const toolsBunfigRaw = readFileSync(toolsRegistryBunfigPath, "utf8")
    const toolsBunfig = parseBunfigInstallToml(
      toolsBunfigRaw,
      "project-bunfig",
      env,
      toolsRegistryBunfigPath,
    )
    if (!/(?:^|\n)env\s*=\s*false(?:\s|$|#)/.test(toolsBunfigRaw)) {
      violations.push("tools/registry/bunfig.toml must retain `env = false`")
    }
    if (toolsBunfig.ignoreScripts !== true) {
      violations.push("tools/registry/bunfig.toml must retain `ignoreScripts = true`")
    }
    if (!toolsBunfig.minimumReleaseAge) {
      violations.push("tools/registry/bunfig.toml must retain `minimumReleaseAge`")
    }
    if (
      toolsBunfig.registry ||
      (toolsBunfig.scopes && Object.keys(toolsBunfig.scopes).length > 0)
    ) {
      violations.push("tools/registry/bunfig.toml must not redeclare registry or scope overrides")
    }
  }

  return {
    ok: violations.length === 0,
    bunVersion: {
      dotBunVersion,
      rootPackageManager,
      rootEnginesBun,
      typesBun,
      toolsRegistryPackageManager,
      toolsRegistryEnginesBun,
      ciUsesVersionFile,
    },
    workspaces: {
      declaredGlobs,
      resolvedPaths,
      lockfilePaths,
      packageNames,
      internalDependenciesValid,
    },
    registrySources: {
      rootPublishConfigRegistry,
      bunfigDefaultRegistry,
      bunfigScopes,
      projectNpmrcRegistry,
      projectNpmrcScopes,
      projectNpmrcAuthPrefixes,
      userNpmrcPath,
      userNpmrcDetected,
      userNpmrcRegistry,
      userNpmrcScopes,
      nestedOverrideFiles,
    },
    violations,
    warnings,
  }
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Check workspace manifest, Bun version pin, .npmrc, and bunfig.toml parity.

Usage:
  bun scripts/check_registry_parity.ts [--json]
  bun run check:registry-parity`)
    return
  }

  const report = auditWorkspaceRegistryParity()
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exit(1)
    return
  }

  if (report.warnings.length > 0) {
    for (const w of report.warnings) {
      console.warn(`WARN: ${w}`)
    }
  }

  if (!report.ok) {
    console.error("FAIL: Workspace manifest & registry parity violations:")
    for (const v of report.violations) {
      console.error(`  - ${v}`)
    }
    process.exit(1)
  }

  const wsCount = report.workspaces.resolvedPaths.length
  const scopeList = Object.entries(report.registrySources.projectNpmrcScopes)
    .map(([scope, url]) => `${scope} -> ${url}`)
    .join(", ")
  console.log(
    `PASS: Registry & workspace parity verified (Bun ${report.bunVersion.dotBunVersion}, ${wsCount} workspaces synced with bun.lock, zero nested overrides${scopeList ? `, scopes: ${scopeList}` : ""}).`,
  )
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]).endsWith(join("scripts", "check_registry_parity.ts"))

if (isMain) {
  main()
}
