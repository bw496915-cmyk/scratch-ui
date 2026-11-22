/**
 * @file scripts/check_registry_parity.ts
 * @description Workspace manifest, Bun version pin, `.npmrc`, `bunfig.toml`,
 * and `NPM_CONFIG_USERCONFIG` registry parity audit & CI gate.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { parseBunLockFile } from "../packages/contracts/src/bun_lockfile.ts"
import { eq, isValidSemver, safeSatisfies } from "../packages/contracts/src/bun_semver.ts"
import {
  DEFAULT_NPM_REGISTRY,
  parseBunfigInstallToml,
  type ParsedBunfigInstallConfig,
  type ParsedNpmrcFile,
  parseNpmrc,
  resolveNpmrcPath,
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
  if (!existsSync(filePath)) {
    return null
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T
  } catch {
    return null
  }
}

export function normalizeRegistryEndpoint(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ""
  }
  try {
    const parsed = new URL(trimmed)
    const cleanPath = parsed.pathname.replace(/\/+$/, "") || "/"
    const suffix = cleanPath === "/" ? "/" : `${cleanPath}/`
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${suffix}`
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

function extractBunPackageManagerVersion(packageManager: string | undefined): string | null {
  if (!packageManager) {
    return null
  }
  const match = /^bun@(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/i.exec(packageManager.trim())
  return match?.[1] ?? packageManager.trim()
}

function normalizeScopeMap(
  scopes: Readonly<Record<string, string | { readonly url?: string }>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (!scopes) {
    return out
  }
  for (const [rawScope, value] of Object.entries(scopes)) {
    const key = rawScope.startsWith("@") ? rawScope : `@${rawScope}`
    const url = typeof value === "string" ? value : value.url
    if (url) {
      out[key] = url
    }
  }
  return out
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

  const bunVersionPath = resolve(rootDir, ".bun-version")
  const dotBunVersion = existsSync(bunVersionPath)
    ? readFileSync(bunVersionPath, "utf8").trim()
    : null
  const validDotBun = Boolean(dotBunVersion && isValidSemver(dotBunVersion))
  if (!dotBunVersion) {
    violations.push("Missing `.bun-version` file in repository root")
  } else if (!validDotBun) {
    violations.push(`Invalid semver in .bun-version: '${dotBunVersion}'`)
  }

  const rootPkg = readJsonSafe<PackageManifestJson>(resolve(rootDir, "package.json"))
  if (!rootPkg) {
    violations.push("Missing or unreadable root `package.json`")
  }

  const rootPackageManager = extractBunPackageManagerVersion(rootPkg?.packageManager)
  const rootEnginesBun = rootPkg?.engines?.bun?.trim() ?? null
  const typesBun = rootPkg?.devDependencies?.["@types/bun"]?.trim() ?? null

  const toolsRegistryPkg = readJsonSafe<PackageManifestJson>(
    resolve(rootDir, "tools/registry/package.json"),
  )
  const toolsRegistryPackageManager = extractBunPackageManagerVersion(
    toolsRegistryPkg?.packageManager,
  )
  const toolsRegistryEnginesBun = toolsRegistryPkg?.engines?.bun?.trim() ?? null

  if (validDotBun && dotBunVersion) {
    const versionTargets: ReadonlyArray<
      readonly [string, string | null, string | null, string | null]
    > = [
      ["package.json", rootPackageManager, rootEnginesBun, typesBun],
      ["tools/registry/package.json", toolsRegistryPackageManager, toolsRegistryEnginesBun, null],
    ]
    for (const [label, pmVer, enginesVer, typesVer] of versionTargets) {
      if (pmVer && !eq(pmVer, dotBunVersion)) {
        violations.push(
          `${label} packageManager 'bun@${pmVer}' diverges from .bun-version '${dotBunVersion}'`,
        )
      }
      if (enginesVer && !safeSatisfies(dotBunVersion, enginesVer)) {
        violations.push(
          `${label} engines.bun '${enginesVer}' diverges from .bun-version '${dotBunVersion}'`,
        )
      }
      if (typesVer && !safeSatisfies(dotBunVersion, typesVer)) {
        violations.push(
          `${label} devDependencies.@types/bun '${typesVer}' diverges from .bun-version '${dotBunVersion}'`,
        )
      }
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
      if (dotBunVersion && (!validDotBun || !eq(m[1]!, dotBunVersion))) {
        violations.push(
          `.github/workflows/ci.yml pins bun-version '${m[1]}' instead of .bun-version '${dotBunVersion}'`,
        )
      }
    }
  }

  const declaredGlobs = Array.isArray(rootPkg?.workspaces) ? [...rootPkg.workspaces] : []
  if (declaredGlobs.length === 0) {
    violations.push("Root `package.json` must declare non-empty `workspaces`")
  }

  const resolvedSet = new Set<string>()
  for (const pattern of declaredGlobs) {
    const clean = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "")
    if (!clean) {
      continue
    }
    if (!clean.endsWith("/*")) {
      const absPath = resolve(rootDir, clean)
      if (existsSync(absPath) && statSync(absPath).isDirectory()) {
        resolvedSet.add(clean)
      }
      continue
    }
    const parentRel = clean.slice(0, -2)
    const parentAbs = resolve(rootDir, parentRel)
    if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) {
      continue
    }
    for (const entry of readdirSync(parentAbs).sort()) {
      if (entry.startsWith(".") || entry === "node_modules") {
        continue
      }
      const relPath = `${parentRel}/${entry}`
      if (statSync(resolve(rootDir, relPath)).isDirectory()) {
        resolvedSet.add(relPath)
      }
    }
  }
  const resolvedPaths = [...resolvedSet].sort()

  const packageNames: Record<string, string> = {}
  const nestedOverrideFiles: string[] = []
  const workspacePackagesByName = new Map<string, { path: string; pkg: PackageManifestJson }>()

  for (const relPath of resolvedPaths) {
    const pkg = readJsonSafe<PackageManifestJson>(resolve(rootDir, relPath, "package.json"))
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

  const packagesRoot = resolve(rootDir, "packages")
  if (existsSync(packagesRoot) && statSync(packagesRoot).isDirectory()) {
    for (const entry of readdirSync(packagesRoot)) {
      if (entry.startsWith(".") || entry === "node_modules") {
        continue
      }
      const rel = `packages/${entry}`
      if (statSync(resolve(rootDir, rel)).isDirectory() && !resolvedPaths.includes(rel)) {
        violations.push(
          `Directory '${rel}' exists under packages/ but is not covered by workspaces`,
        )
      }
    }
  }

  let internalDependenciesValid = true
  for (const [pkgName, { path: wsPath, pkg }] of workspacePackagesByName) {
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    for (const [depName, spec] of Object.entries(allDeps)) {
      const isInternalRef =
        spec.startsWith("workspace:") || (depName.startsWith("@sportsdesk-ops/") && spec === "*")
      if (isInternalRef && !workspacePackagesByName.has(depName)) {
        internalDependenciesValid = false
        violations.push(
          `Workspace '${pkgName}' (${wsPath}) references missing internal workspace '${depName}' (${spec})`,
        )
      }
    }
  }

  const lockfilePath = resolve(rootDir, "bun.lock")
  let lockfilePaths: string[] = []
  if (!existsSync(lockfilePath)) {
    violations.push("Missing `bun.lock` for workspace parity check")
  } else {
    try {
      const lockWorkspaces = parseBunLockFile(readFileSync(lockfilePath, "utf8")).workspaces ?? {}
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
  }

  const rootPublishConfigRegistry = rootPkg?.publishConfig?.registry?.trim() ?? null
  const rootBunfigPath = resolve(rootDir, "bunfig.toml")
  let projectBunfig: ParsedBunfigInstallConfig | null = null
  if (!existsSync(rootBunfigPath)) {
    violations.push("Missing root `bunfig.toml`")
  } else {
    projectBunfig = parseBunfigInstallToml(
      readFileSync(rootBunfigPath, "utf8"),
      "project-bunfig",
      env,
      rootBunfigPath,
    )
  }

  const bunfigReg = projectBunfig?.registry
  const bunfigDefaultRegistry = typeof bunfigReg === "string" ? bunfigReg : (bunfigReg?.url ?? null)
  const bunfigScopes = normalizeScopeMap(projectBunfig?.scopes)

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
  const projectNpmrcScopes = normalizeScopeMap(projectNpmrc?.scopes)
  const projectNpmrcAuthPrefixes = projectNpmrc ? Object.keys(projectNpmrc.registryAuth).sort() : []

  if (projectNpmrc) {
    for (const [prefix, entry] of Object.entries(projectNpmrc.registryAuth)) {
      const token = entry.authToken?.trim()
      if (!token || /^\$\{[A-Za-z0-9_]+\??\}$/.test(token)) {
        continue
      }
      const isLocalLoopback =
        prefix.startsWith("//127.0.0.1:") ||
        prefix.startsWith("//localhost:") ||
        prefix.startsWith("//[::1]:")
      const isKnownPlaceholder = token === "local-development" || token === "placeholder"
      if (isLocalLoopback && isKnownPlaceholder) {
        continue
      }
      if (/^(?:ghp_|github_pat_|gho_|ghu_|npm_[A-Za-z0-9]{10,})/.test(token) || !isLocalLoopback) {
        violations.push(
          `Tracked .npmrc contains non-placeholder literal token for '${prefix}' (use \${ENV_VAR} instead)`,
        )
        break
      }
    }

    for (const [scope, scopeUrl] of Object.entries(projectNpmrcScopes)) {
      if (!isLoopbackHost(scopeUrl)) {
        if (!scopeUrl.toLowerCase().startsWith("https://")) {
          violations.push(`.npmrc scope '${scope}' uses non-HTTPS remote registry '${scopeUrl}'`)
        }
        continue
      }
      let expectedPrefix: string | null = null
      try {
        const parsed = new URL(scopeUrl)
        expectedPrefix = `//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}/`
      } catch {
        expectedPrefix = null
      }
      const hasCredential =
        expectedPrefix !== null &&
        Object.entries(projectNpmrc.registryAuth).some(([key, auth]) => {
          const lower = key.toLowerCase()
          const normalizedKey = lower.endsWith("/") ? lower : `${lower}/`
          return (
            normalizedKey === expectedPrefix &&
            Boolean(
              auth.authToken ||
              auth.authTokenEnvRef ||
              auth.rawAuth ||
              auth.rawAuthEnvRef ||
              auth.username ||
              auth.passwordBase64 ||
              auth.passwordEnvRef,
            )
          )
        })
      if (!hasCredential) {
        violations.push(
          `.npmrc configures local scope '${scope}=${scopeUrl}' without matching loopback credential prefix (Bun requires a placeholder _authToken for local publishing)`,
        )
      }
    }
  }

  const defaultRegistryPairs: ReadonlyArray<
    readonly [string, string | null, string, string | null, string]
  > = [
    ["bunfig.toml", bunfigDefaultRegistry, ".npmrc", projectNpmrcRegistry, "while .npmrc sets"],
    [
      "package.json publishConfig.registry",
      rootPublishConfigRegistry,
      "bunfig.toml",
      bunfigDefaultRegistry,
      "diverges from bunfig.toml",
    ],
    [
      "package.json publishConfig.registry",
      rootPublishConfigRegistry,
      ".npmrc",
      projectNpmrcRegistry,
      "diverges from .npmrc",
    ],
  ]
  for (const [lhsLabel, lhsUrl, _rhsLabel, rhsUrl, connector] of defaultRegistryPairs) {
    if (
      lhsUrl &&
      rhsUrl &&
      normalizeRegistryEndpoint(lhsUrl) !== normalizeRegistryEndpoint(rhsUrl)
    ) {
      const lhsPrefix = lhsLabel.includes("publishConfig") ? `${lhsLabel} '` : `${lhsLabel} sets '`
      violations.push(`Default registry mismatch: ${lhsPrefix}${lhsUrl}' ${connector} '${rhsUrl}'`)
    }
  }

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

  const rawUserConfig =
    env.NPM_CONFIG_USERCONFIG?.trim() || env.npm_config_userconfig?.trim() || null
  let userNpmrcPath: string | null = null
  let userNpmrcDetected = false
  let userNpmrcRegistry: string | null = null
  let userNpmrcScopes: Record<string, string> = {}

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
      userNpmrcScopes = normalizeScopeMap(userNpmrc.scopes)
      for (const [scope, url] of Object.entries(userNpmrcScopes)) {
        const expectedUrl = bunfigScopes[scope] ?? projectNpmrcScopes[scope]
        if (
          expectedUrl &&
          normalizeRegistryEndpoint(url) !== normalizeRegistryEndpoint(expectedUrl)
        ) {
          violations.push(
            `NPM_CONFIG_USERCONFIG scope '${scope}' ('${url}') diverges from project config ('${expectedUrl}')`,
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

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]).endsWith(join("scripts", "check_registry_parity.ts"))

if (isMain) {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Check workspace manifest, Bun version pin, .npmrc, and bunfig.toml parity.

Usage:
  bun scripts/check_registry_parity.ts [--json]
  bun run check:registry-parity`)
    process.exit(0)
  }

  const report = auditWorkspaceRegistryParity()
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) {
      process.exit(1)
    }
    process.exit(0)
  }

  for (const w of report.warnings) {
    console.warn(`WARN: ${w}`)
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
