/**
 * Unified SemVer 2.0 version management & drift auditor for SportsDesk Ops, backed directly by
 * `Bun.semver` (`satisfies` and `order`) via `packages/contracts/src/bun_semver.ts`. Unifies all
 * three version tracks under one Bun CLI authority:
 *
 * 1. `workspace` — root `package.json`, `packages/*\/package.json`, `tools/registry/package.json`
 * 2. `design` — `design/tokens.toml`, `design/branding.toml`, `design/index.ts`,
 *    `packages/ui/src/tokens.registry.generated.ts`
 * 3. `bun` — `.bun-version`, active `Bun.version`, `packageManager`, `engines.bun`, `@types/bun`, and
 *    `.github/workflows/ci.yml`
 *
 * @file Scripts/version_manager.ts
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  bumpSemver,
  bunSemverAvailable,
  eq,
  isValidSemver,
  normalizeSemver,
  safeSatisfies,
  safeSemverOrder,
  type SemverBumpType,
} from "../packages/contracts/src/bun_semver.ts"

export type VersionTrack = "workspace" | "design" | "bun"

export interface VersionRecord {
  readonly track: VersionTrack
  readonly target: string
  readonly source: string
  readonly version: string
  readonly expected: string
  readonly ok: boolean
  readonly detail: string
}

export interface UnifiedVersionReport {
  readonly ok: boolean
  readonly engine: "Bun.semver" | "fallback"
  readonly workspaceVersion: string | null
  readonly designVersion: string | null
  readonly bunVersionPin: string | null
  readonly activeBunVersion: string | null
  readonly records: readonly VersionRecord[]
  readonly violations: readonly string[]
}

export interface AuditUnifiedVersionsOptions {
  readonly rootDir?: string | undefined
  readonly activeBunVersion?: string | null | undefined
}

export interface BumpWorkspaceVersionsOptions {
  readonly rootDir?: string | undefined
  readonly target: SemverBumpType | string
  readonly preid?: string | undefined
  readonly dryRun?: boolean | undefined
  readonly includeTools?: boolean | undefined
  readonly allowDowngrade?: boolean | undefined
}

export interface VersionBumpFileChange {
  readonly path: string
  readonly name: string
  readonly previous: string
  readonly next: string
  readonly written: boolean
}

export interface VersionBumpResult {
  readonly ok: boolean
  readonly dryRun: boolean
  readonly previousVersion: string | null
  readonly nextVersion: string | null
  readonly changes: readonly VersionBumpFileChange[]
  readonly error?: string | undefined
}

interface PackageJsonShape {
  name?: string
  version?: string
  workspaces?: string[]
  packageManager?: string
  engines?: Record<string, string>
  devDependencies?: Record<string, string>
  [key: string]: unknown
}

const BUMP_TYPES: ReadonlySet<string> = new Set<SemverBumpType>([
  "major",
  "minor",
  "patch",
  "premajor",
  "preminor",
  "prepatch",
  "prerelease",
])

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T
  } catch {
    return null
  }
}

function readTomlMetaVersion(filePath: string, key = "version"): string | null {
  if (!existsSync(filePath)) return null
  const text = readFileSync(filePath, "utf8")
  const metaIdx = text.indexOf("[meta]")
  const scope = metaIdx >= 0 ? text.slice(metaIdx) : text
  const nextSection = scope.slice(6).search(/\n\[[^\]]+\]/)
  const metaBlock = nextSection >= 0 ? scope.slice(0, nextSection + 6) : scope
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(metaBlock)
  return match?.[1]?.trim() ?? null
}

function readTomlSectionKey(filePath: string, section: string, key: string): string | null {
  if (!existsSync(filePath)) return null
  const text = readFileSync(filePath, "utf8")
  const marker = `[${section}]`
  const idx = text.indexOf(marker)
  if (idx < 0) return null
  const tail = text.slice(idx + marker.length)
  const nextSection = tail.search(/\n\[[^\]]+\]/)
  const block = nextSection >= 0 ? tail.slice(0, nextSection) : tail
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m").exec(block)
  return match?.[1]?.trim() ?? null
}

function resolveWorkspacePackagePaths(rootDir: string, rootPkg: PackageJsonShape | null): string[] {
  const globs = Array.isArray(rootPkg?.workspaces) ? rootPkg.workspaces : []
  const out = new Set<string>()
  for (const raw of globs) {
    const clean = raw.trim().replace(/^\.\//, "").replace(/\/+$/, "")
    if (!clean) continue
    if (!clean.endsWith("/*")) {
      if (existsSync(resolve(rootDir, clean, "package.json"))) {
        out.add(`${clean}/package.json`)
      }
      continue
    }
    const parentRel = clean.slice(0, -2)
    const parentAbs = resolve(rootDir, parentRel)
    if (!existsSync(parentAbs) || !statSync(parentAbs).isDirectory()) continue
    for (const entry of readdirSync(parentAbs).sort()) {
      if (entry.startsWith(".") || entry === "node_modules") continue
      const pkgRel = `${parentRel}/${entry}/package.json`
      if (existsSync(resolve(rootDir, pkgRel))) {
        out.add(pkgRel)
      }
    }
  }
  return [...out].sort()
}

function extractBunPmVersion(packageManager: string | undefined): string | null {
  if (!packageManager) return null
  const match = /^bun@([^\s]+)$/i.exec(packageManager.trim())
  return match?.[1] ?? packageManager.trim()
}

function getActiveBunVersion(): string | null {
  const b = (globalThis as { readonly Bun?: { readonly version?: string } }).Bun
  return typeof b?.version === "string" && b.version.trim() ? b.version.trim() : null
}

/**
 * Audits all repository version tracks (`workspace`, `design`, `bun`) using `Bun.semver` equality
 * (`order === 0`) and range satisfaction (`satisfies`).
 */
export function auditUnifiedVersions(
  options: AuditUnifiedVersionsOptions = {},
): UnifiedVersionReport {
  const rootDir = resolve(options.rootDir ?? process.cwd())
  const activeBunVersion =
    options.activeBunVersion !== undefined ? options.activeBunVersion : getActiveBunVersion()

  const records: VersionRecord[] = []
  const violations: string[] = []

  // --- Track 1: Workspace Packages ---
  const rootPkgPath = resolve(rootDir, "package.json")
  const rootPkg = readJson<PackageJsonShape>(rootPkgPath)
  const workspaceVersion = rootPkg?.version?.trim() ?? null

  if (!rootPkg || !workspaceVersion) {
    violations.push("Missing root package.json or `version` field")
  } else if (!isValidSemver(workspaceVersion)) {
    violations.push(`Root package.json has invalid SemVer: '${workspaceVersion}'`)
  }

  if (workspaceVersion) {
    const rootValid = isValidSemver(workspaceVersion)
    records.push({
      track: "workspace",
      target: rootPkg?.name ?? "root",
      source: "package.json",
      version: workspaceVersion,
      expected: workspaceVersion,
      ok: rootValid,
      detail: rootValid ? "SSOT workspace version" : "Invalid SemVer",
    })
  }

  const wsPkgPaths = resolveWorkspacePackagePaths(rootDir, rootPkg)
  if (existsSync(resolve(rootDir, "tools/registry/package.json"))) {
    wsPkgPaths.push("tools/registry/package.json")
  }

  for (const relPath of wsPkgPaths) {
    const pkg = readJson<PackageJsonShape>(resolve(rootDir, relPath))
    const ver = pkg?.version?.trim() ?? ""
    const expected = workspaceVersion ?? "missing"
    const matches = Boolean(workspaceVersion && ver && eq(ver, workspaceVersion))
    const detail = !ver
      ? "Missing version field"
      : !isValidSemver(ver)
        ? `Invalid SemVer '${ver}'`
        : matches
          ? "Synced with root via Bun.semver.order === 0"
          : `Drifted from root ${expected}`
    if (!matches) {
      violations.push(`Workspace '${relPath}' version '${ver || "unset"}' !== '${expected}'`)
    }
    records.push({
      track: "workspace",
      target: pkg?.name ?? relPath,
      source: relPath,
      version: ver || "unset",
      expected,
      ok: matches,
      detail,
    })
  }

  // --- Track 2: Design System & Branding ---
  const tokensTomlPath = resolve(rootDir, "design/tokens.toml")
  const designVersion = readTomlMetaVersion(tokensTomlPath, "version")
  if (existsSync(tokensTomlPath)) {
    const valid = Boolean(designVersion && isValidSemver(designVersion))
    if (!valid) {
      violations.push(`design/tokens.toml meta.version is invalid: '${designVersion ?? "unset"}'`)
    }
    records.push({
      track: "design",
      target: "tokens.meta.version",
      source: "design/tokens.toml",
      version: designVersion ?? "unset",
      expected: designVersion ?? "valid semver",
      ok: valid,
      detail: valid ? "SSOT design tokens version" : "Invalid SemVer",
    })
  }

  const brandingTomlPath = resolve(rootDir, "design/branding.toml")
  if (existsSync(brandingTomlPath) && designVersion) {
    const brandMetaVer = readTomlMetaVersion(brandingTomlPath, "version")
    const brandTokensVer = readTomlMetaVersion(brandingTomlPath, "tokens_version")
    const brandDisplayVer = readTomlSectionKey(brandingTomlPath, "brand", "version")

    const metaOk = Boolean(brandMetaVer && eq(brandMetaVer, designVersion))
    if (!metaOk) {
      violations.push(
        `design/branding.toml meta.version '${brandMetaVer ?? "unset"}' !== '${designVersion}'`,
      )
    }
    records.push({
      track: "design",
      target: "branding.meta.version",
      source: "design/branding.toml",
      version: brandMetaVer ?? "unset",
      expected: designVersion,
      ok: metaOk,
      detail: metaOk ? "Matched via Bun.semver.order" : "Drifted from tokens.toml",
    })

    const tokOk = Boolean(brandTokensVer && eq(brandTokensVer, designVersion))
    if (!tokOk) {
      violations.push(
        `design/branding.toml meta.tokens_version '${brandTokensVer ?? "unset"}' !== '${designVersion}'`,
      )
    }
    records.push({
      track: "design",
      target: "branding.meta.tokens_version",
      source: "design/branding.toml",
      version: brandTokensVer ?? "unset",
      expected: designVersion,
      ok: tokOk,
      detail: tokOk ? "Matched via Bun.semver.order" : "Drifted from tokens.toml",
    })

    if (brandDisplayVer) {
      const normalized = normalizeSemver(brandDisplayVer)
      const displayOk = normalized !== null
      if (!displayOk) {
        violations.push(
          `design/branding.toml brand.version '${brandDisplayVer}' is not normalizable to SemVer`,
        )
      }
      records.push({
        track: "design",
        target: "branding.brand.version",
        source: "design/branding.toml",
        version: brandDisplayVer,
        expected: normalized ?? "semver",
        ok: displayOk,
        detail: displayOk ? `Normalized SemVer: ${normalized}` : "Unparseable release tag",
      })
    }
  }

  const designIndexPath = resolve(rootDir, "design/index.ts")
  if (existsSync(designIndexPath) && designVersion) {
    const indexSrc = readFileSync(designIndexPath, "utf8")
    const m = /DESIGN_SYSTEM_VERSION\s*=\s*"([^"]+)"/.exec(indexSrc)
    const idxVer = m?.[1]?.trim() ?? ""
    const ok = Boolean(idxVer && eq(idxVer, designVersion))
    if (!ok) {
      violations.push(
        `design/index.ts DESIGN_SYSTEM_VERSION '${idxVer || "unset"}' !== '${designVersion}'`,
      )
    }
    records.push({
      track: "design",
      target: "DESIGN_SYSTEM_VERSION",
      source: "design/index.ts",
      version: idxVer || "unset",
      expected: designVersion,
      ok,
      detail: ok ? "Matched via Bun.semver.order" : "Drifted from tokens.toml",
    })
  }

  const generatedTokensPath = resolve(rootDir, "packages/ui/src/tokens.registry.generated.ts")
  if (existsSync(generatedTokensPath) && designVersion) {
    const genSrc = readFileSync(generatedTokensPath, "utf8")
    const m = /TOKENS_TOML_VERSION\s*=\s*"([^"]+)"/.exec(genSrc)
    const genVer = m?.[1]?.trim() ?? ""
    const ok = Boolean(genVer && eq(genVer, designVersion))
    if (!ok) {
      violations.push(
        `packages/ui/src/tokens.registry.generated.ts TOKENS_TOML_VERSION '${genVer || "unset"}' !== '${designVersion}'`,
      )
    }
    records.push({
      track: "design",
      target: "TOKENS_TOML_VERSION",
      source: "packages/ui/src/tokens.registry.generated.ts",
      version: genVer || "unset",
      expected: designVersion,
      ok,
      detail: ok ? "Generated token artifact synced" : "Run bun run cli artifacts generate",
    })
  }

  // --- Track 3: Bun Runtime Pin ---
  const dotBunPath = resolve(rootDir, ".bun-version")
  const bunVersionPin = existsSync(dotBunPath) ? readFileSync(dotBunPath, "utf8").trim() : null
  const validPin = Boolean(bunVersionPin && isValidSemver(bunVersionPin))
  if (!bunVersionPin) {
    violations.push("Missing `.bun-version` pin file")
  } else if (!validPin) {
    violations.push(`Invalid SemVer in .bun-version: '${bunVersionPin}'`)
  }
  records.push({
    track: "bun",
    target: ".bun-version",
    source: ".bun-version",
    version: bunVersionPin ?? "missing",
    expected: bunVersionPin ?? "valid semver",
    ok: validPin,
    detail: validPin ? "SSOT Bun runtime pin" : "Missing or invalid SemVer",
  })

  if (validPin && bunVersionPin) {
    if (activeBunVersion) {
      const runtimeOk = eq(activeBunVersion, bunVersionPin)
      if (!runtimeOk) {
        violations.push(
          `Active Bun runtime '${activeBunVersion}' !== .bun-version '${bunVersionPin}'`,
        )
      }
      records.push({
        track: "bun",
        target: "Bun.version",
        source: "runtime",
        version: activeBunVersion,
        expected: bunVersionPin,
        ok: runtimeOk,
        detail: runtimeOk ? "Active runtime matches pin" : "Runtime version drift",
      })
    }

    const rootPm = extractBunPmVersion(rootPkg?.packageManager)
    const rootPmOk = Boolean(rootPm && eq(rootPm, bunVersionPin))
    if (!rootPmOk) {
      violations.push(
        `package.json packageManager '${rootPkg?.packageManager ?? "unset"}' !== 'bun@${bunVersionPin}'`,
      )
    }
    records.push({
      track: "bun",
      target: "packageManager",
      source: "package.json",
      version: rootPm ?? "unset",
      expected: bunVersionPin,
      ok: rootPmOk,
      detail: rootPmOk ? "Exact match via Bun.semver.order" : "packageManager mismatch",
    })

    const rootEngines = rootPkg?.engines?.bun?.trim() ?? null
    const rootEnginesOk = Boolean(rootEngines && safeSatisfies(bunVersionPin, rootEngines))
    if (!rootEnginesOk) {
      violations.push(
        `package.json engines.bun '${rootEngines ?? "unset"}' not satisfied by '${bunVersionPin}'`,
      )
    }
    records.push({
      track: "bun",
      target: "engines.bun",
      source: "package.json",
      version: rootEngines ?? "unset",
      expected: `satisfies(${bunVersionPin})`,
      ok: rootEnginesOk,
      detail: rootEnginesOk ? "Verified via Bun.semver.satisfies" : "Range mismatch",
    })

    const typesBun = rootPkg?.devDependencies?.["@types/bun"]?.trim() ?? null
    const typesOk = Boolean(typesBun && safeSatisfies(bunVersionPin, typesBun))
    if (!typesOk) {
      violations.push(
        `package.json devDependencies.@types/bun '${typesBun ?? "unset"}' not satisfied by '${bunVersionPin}'`,
      )
    }
    records.push({
      track: "bun",
      target: "@types/bun",
      source: "package.json",
      version: typesBun ?? "unset",
      expected: `satisfies(${bunVersionPin})`,
      ok: typesOk,
      detail: typesOk ? "Verified via Bun.semver.satisfies" : "Range mismatch",
    })

    const toolsPkg = readJson<PackageJsonShape>(resolve(rootDir, "tools/registry/package.json"))
    if (toolsPkg) {
      const toolsPm = extractBunPmVersion(toolsPkg.packageManager)
      const toolsPmOk = Boolean(toolsPm && eq(toolsPm, bunVersionPin))
      if (!toolsPmOk) {
        violations.push(
          `tools/registry/package.json packageManager '${toolsPkg.packageManager ?? "unset"}' !== 'bun@${bunVersionPin}'`,
        )
      }
      records.push({
        track: "bun",
        target: "tools/registry packageManager",
        source: "tools/registry/package.json",
        version: toolsPm ?? "unset",
        expected: bunVersionPin,
        ok: toolsPmOk,
        detail: toolsPmOk ? "Exact match via Bun.semver.order" : "packageManager mismatch",
      })

      const toolsEngines = toolsPkg.engines?.bun?.trim() ?? null
      const toolsEnginesOk = Boolean(toolsEngines && safeSatisfies(bunVersionPin, toolsEngines))
      if (!toolsEnginesOk) {
        violations.push(
          `tools/registry/package.json engines.bun '${toolsEngines ?? "unset"}' not satisfied by '${bunVersionPin}'`,
        )
      }
      records.push({
        track: "bun",
        target: "tools/registry engines.bun",
        source: "tools/registry/package.json",
        version: toolsEngines ?? "unset",
        expected: `satisfies(${bunVersionPin})`,
        ok: toolsEnginesOk,
        detail: toolsEnginesOk ? "Verified via Bun.semver.satisfies" : "Range mismatch",
      })
    }
  }

  return {
    ok: violations.length === 0,
    engine: bunSemverAvailable() ? "Bun.semver" : "fallback",
    workspaceVersion,
    designVersion,
    bunVersionPin,
    activeBunVersion,
    records,
    violations,
  }
}

/**
 * Atomically bumps the unified workspace version across root `package.json`, all declared workspace
 * packages (`packages/*\/package.json`), and optionally `tools/registry/package.json`, validating
 * progression with `Bun.semver.order`.
 */
export function bumpWorkspaceVersions(options: BumpWorkspaceVersionsOptions): VersionBumpResult {
  const rootDir = resolve(options.rootDir ?? process.cwd())
  const dryRun = Boolean(options.dryRun)
  const includeTools = options.includeTools !== false

  const rootPkgPath = resolve(rootDir, "package.json")
  const rootPkg = readJson<PackageJsonShape>(rootPkgPath)
  const currentVersion = rootPkg?.version?.trim() ?? null

  if (!rootPkg || !currentVersion || !isValidSemver(currentVersion)) {
    return {
      ok: false,
      dryRun,
      previousVersion: currentVersion,
      nextVersion: null,
      changes: [],
      error: `Root package.json version is missing or invalid SemVer: '${currentVersion ?? "unset"}'`,
    }
  }

  let nextVersion: string | null
  if (BUMP_TYPES.has(options.target)) {
    nextVersion = bumpSemver(currentVersion, options.target as SemverBumpType, options.preid)
  } else {
    const explicit = options.target.trim().replace(/^v/, "")
    if (!isValidSemver(explicit)) {
      return {
        ok: false,
        dryRun,
        previousVersion: currentVersion,
        nextVersion: null,
        changes: [],
        error: `Invalid target version or release type: '${options.target}'`,
      }
    }
    const order = safeSemverOrder(explicit, currentVersion)
    if (!options.allowDowngrade && order !== 1) {
      return {
        ok: false,
        dryRun,
        previousVersion: currentVersion,
        nextVersion: null,
        changes: [],
        error: `Target version '${explicit}' must be greater than current '${currentVersion}' (Bun.semver.order = ${order})`,
      }
    }
    nextVersion = explicit
  }

  if (!nextVersion) {
    return {
      ok: false,
      dryRun,
      previousVersion: currentVersion,
      nextVersion: null,
      changes: [],
      error: `Failed to compute SemVer bump '${options.target}' from '${currentVersion}'`,
    }
  }

  const relPaths = ["package.json", ...resolveWorkspacePackagePaths(rootDir, rootPkg)]
  if (includeTools && existsSync(resolve(rootDir, "tools/registry/package.json"))) {
    relPaths.push("tools/registry/package.json")
  }

  const changes: VersionBumpFileChange[] = []
  for (const relPath of relPaths) {
    const absPath = resolve(rootDir, relPath)
    const raw = readFileSync(absPath, "utf8")
    const parsed = JSON.parse(raw) as PackageJsonShape
    const prev = parsed.version?.trim() ?? "unset"
    const updatedText = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${nextVersion}"`)
    if (!dryRun && updatedText !== raw) {
      writeFileSync(absPath, updatedText, "utf8")
    }
    changes.push({
      path: relPath,
      name: parsed.name ?? relPath,
      previous: prev,
      next: nextVersion,
      written: !dryRun && updatedText !== raw,
    })
  }

  return {
    ok: true,
    dryRun,
    previousVersion: currentVersion,
    nextVersion,
    changes,
  }
}
