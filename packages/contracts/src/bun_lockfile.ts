/**
 * @file packages/contracts/src/bun_lockfile.ts
 * @description Typed `BunLockFile` schema, pure JSONC parser, install linker
 * strategy resolver (`configVersion`), and lockfile audit summarizer.
 *
 * Matches Bun's `BunLockFile` reference specification:
 * - `lockfileVersion`: lockfile schema version (e.g. `2` for `hasInstallScript` & `libc`).
 * - `configVersion`: governs the default **install linker strategy**:
 *   - `0` or `undefined` (pre-Bun 1.3.2): defaults to `"hoisted"`.
 *   - `1` (Bun 1.3.2+): defaults to `"isolated"` for workspace/monorepo projects
 *     (`Object.keys(workspaces).length > 1`), and `"hoisted"` for single-package projects.
 * - Explicit overrides (`.npmrc` `node-linker`/`install-strategy`, `bunfig.toml`
 *   `install.linker`, or CLI `--linker`) take precedence over `configVersion`.
 */

import type { NormalizedNodeLinker } from "./npmrc.ts"

export interface BunLockFileBasePackageInfo {
  readonly dependencies?: Readonly<Record<string, string>> | undefined
  readonly devDependencies?: Readonly<Record<string, string>> | undefined
  readonly optionalDependencies?: Readonly<Record<string, string>> | undefined
  readonly peerDependencies?: Readonly<Record<string, string>> | undefined
  readonly optionalPeers?: readonly string[] | undefined
  readonly bundledDependencies?: readonly string[] | undefined
  readonly bin?: string | Readonly<Record<string, string>> | undefined
  readonly binDir?: string | undefined
}

export interface BunLockFileWorkspacePackage extends BunLockFileBasePackageInfo {
  readonly name?: string | undefined
  readonly version?: string | undefined
}

export interface BunLockFilePackageInfo extends BunLockFileBasePackageInfo {
  readonly os?: string | readonly string[] | undefined
  readonly cpu?: string | readonly string[] | undefined
  readonly libc?: string | readonly string[] | undefined
  readonly bundled?: boolean | undefined
  readonly hasInstallScript?: boolean | undefined
}

/**
 * Tuple representation inside `bun.lock` `"packages"` map:
 * - Registry / tarball package: `[identifier, registryUrl, info, integrity?]`
 * - Workspace / symlink / minimal entry: `[identifier, ...]`
 */
export type BunLockFilePackageTuple =
  | readonly [string]
  | readonly [string, string]
  | readonly [string, BunLockFilePackageInfo]
  | readonly [string, string, string]
  | readonly [string, string, BunLockFilePackageInfo]
  | readonly [string, string, BunLockFilePackageInfo, string]

export interface BunLockFilePatchedDependency {
  readonly path: string
  readonly hash?: string | undefined
}

/**
 * Typed structure of Bun's text-based JSONC lockfile (`bun.lock`).
 */
export interface BunLockFile {
  readonly lockfileVersion: number
  readonly configVersion?: 0 | 1 | number | undefined
  readonly workspaces: Readonly<Record<string, BunLockFileWorkspacePackage>>
  readonly packages?: Readonly<Record<string, BunLockFilePackageTuple>> | undefined
  readonly overrides?: Readonly<Record<string, string>> | undefined
  readonly trustedDependencies?: readonly string[] | undefined
  readonly patchedDependencies?:
    Readonly<Record<string, string | BunLockFilePatchedDependency>> | undefined
  readonly catalog?: Readonly<Record<string, string>> | undefined
  readonly catalogs?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined
}

export interface BunLockFileLinkerResolution {
  readonly linker: NormalizedNodeLinker
  readonly configVersion: number | null
  readonly isWorkspaceProject: boolean
  readonly reason: string
}

export interface BunLockFileWorkspaceSummary {
  readonly path: string
  readonly name: string
  readonly version: string | null
  readonly dependencyCount: number
  readonly devDependencyCount: number
}

export interface BunLockFileSummary {
  readonly lockfileVersion: number
  readonly configVersion: number | null
  readonly isWorkspaceProject: boolean
  readonly workspaceCount: number
  readonly workspaces: readonly BunLockFileWorkspaceSummary[]
  readonly packageCount: number
  readonly hasInstallScriptCount: number
  readonly hasInstallScriptPackages: readonly string[]
  readonly libcNativePackageCount: number
  readonly overrideCount: number
  readonly trustedDependencyCount: number
  readonly patchedDependencyCount: number
  readonly catalogCount: number
  readonly defaultLinkerStrategy: NormalizedNodeLinker
  readonly defaultLinkerReason: string
}

/**
 * Strip JSONC single-line comments, block comments, and trailing commas outside
 * string literals so `bun.lock` parses cleanly in Bun, Node.js, and browsers.
 */
export function stripJsoncCommentsAndTrailingCommas(raw: string): string {
  let noComments = ""
  let inString = false
  let escaped = false
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]!
    const next = i + 1 < raw.length ? raw[i + 1] : ""

    if (inString) {
      noComments += ch
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      i += 1
      continue
    }

    if (ch === '"') {
      inString = true
      noComments += ch
      i += 1
      continue
    }

    if (ch === "/" && next === "/") {
      i += 2
      while (i < raw.length && raw[i] !== "\n") {
        i += 1
      }
      continue
    }

    if (ch === "/" && next === "*") {
      i += 2
      while (i + 1 < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        i += 1
      }
      i += 2
      continue
    }

    noComments += ch
    i += 1
  }

  // Remove trailing commas before `}` or `]` outside string literals
  let clean = ""
  inString = false
  escaped = false
  for (let idx = 0; idx < noComments.length; idx += 1) {
    const ch = noComments[idx]!
    if (inString) {
      clean += ch
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      clean += ch
      continue
    }

    if (ch === ",") {
      let lookahead = idx + 1
      while (lookahead < noComments.length && /\s/.test(noComments[lookahead]!)) {
        lookahead += 1
      }
      const nextToken = noComments[lookahead]
      if (nextToken === "}" || nextToken === "]") {
        continue
      }
    }

    clean += ch
  }

  return clean
}

/**
 * Parse a `bun.lock` JSONC document into a typed `BunLockFile` object.
 */
export function parseBunLockFile(rawText: string): BunLockFile {
  const normalizedJson = stripJsoncCommentsAndTrailingCommas(rawText)
  const parsed = JSON.parse(normalizedJson) as Partial<BunLockFile> | null
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid bun.lock: expected top-level JSON object")
  }
  if (typeof parsed.lockfileVersion !== "number") {
    throw new Error("Invalid bun.lock: missing numeric lockfileVersion")
  }
  const workspaces =
    parsed.workspaces && typeof parsed.workspaces === "object" ? parsed.workspaces : {}

  return {
    lockfileVersion: parsed.lockfileVersion,
    ...(typeof parsed.configVersion === "number" ? { configVersion: parsed.configVersion } : {}),
    workspaces,
    ...(parsed.packages && typeof parsed.packages === "object"
      ? { packages: parsed.packages }
      : {}),
    ...(parsed.overrides && typeof parsed.overrides === "object"
      ? { overrides: parsed.overrides }
      : {}),
    ...(Array.isArray(parsed.trustedDependencies)
      ? { trustedDependencies: parsed.trustedDependencies }
      : {}),
    ...(parsed.patchedDependencies && typeof parsed.patchedDependencies === "object"
      ? { patchedDependencies: parsed.patchedDependencies }
      : {}),
    ...(parsed.catalog && typeof parsed.catalog === "object" ? { catalog: parsed.catalog } : {}),
    ...(parsed.catalogs && typeof parsed.catalogs === "object"
      ? { catalogs: parsed.catalogs }
      : {}),
  }
}

/**
 * Determine Bun's default install linker strategy from `BunLockFile.configVersion`
 * and workspace topology:
 * - `configVersion >= 1` + multiple workspaces => `"isolated"`
 * - `configVersion >= 1` + single package => `"hoisted"`
 * - `configVersion === 0` or omitted (pre-1.3.2) => `"hoisted"`
 */
export function resolveDefaultInstallLinkerStrategy(
  lockfile: BunLockFile | null | undefined,
): BunLockFileLinkerResolution {
  if (!lockfile) {
    return {
      linker: "hoisted",
      configVersion: null,
      isWorkspaceProject: false,
      reason: "No bun.lock detected; defaulting to hoisted linker",
    }
  }

  const workspaceKeys = Object.keys(lockfile.workspaces ?? {})
  const isWorkspaceProject = workspaceKeys.length > 1
  const configVersion = typeof lockfile.configVersion === "number" ? lockfile.configVersion : null

  if (configVersion === null || configVersion === 0) {
    return {
      linker: "hoisted",
      configVersion,
      isWorkspaceProject,
      reason: "configVersion 0 / unset preserves pre-Bun 1.3.2 hoisted linker default",
    }
  }

  if (isWorkspaceProject) {
    return {
      linker: "isolated",
      configVersion,
      isWorkspaceProject: true,
      reason: `configVersion ${configVersion} with ${workspaceKeys.length} workspaces defaults to isolated linker`,
    }
  }

  return {
    linker: "hoisted",
    configVersion,
    isWorkspaceProject: false,
    reason: `configVersion ${configVersion} single-package project defaults to hoisted linker`,
  }
}

function extractPackageInfoFromTuple(
  tuple: BunLockFilePackageTuple,
): BunLockFilePackageInfo | null {
  for (let i = 1; i < tuple.length; i += 1) {
    const item = tuple[i]
    if (item && typeof item === "object") {
      return item as BunLockFilePackageInfo
    }
  }
  return null
}

/**
 * Produce a compact, read-only summary of a parsed `BunLockFile` suitable for
 * `/api/config/status` and Status Dashboard inspection.
 */
export function summarizeBunLockFile(lockfile: BunLockFile): BunLockFileSummary {
  const linkerRes = resolveDefaultInstallLinkerStrategy(lockfile)
  const workspaces: BunLockFileWorkspaceSummary[] = Object.entries(lockfile.workspaces ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, ws]) => ({
      path: path === "" ? "." : path,
      name: ws.name ?? (path === "" ? "(root)" : path),
      version: ws.version ?? null,
      dependencyCount: Object.keys(ws.dependencies ?? {}).length,
      devDependencyCount: Object.keys(ws.devDependencies ?? {}).length,
    }))

  const packageEntries = Object.entries(lockfile.packages ?? {})
  const hasInstallScriptPackages: string[] = []
  let libcNativePackageCount = 0

  for (const [pkgKey, tuple] of packageEntries) {
    if (!Array.isArray(tuple)) continue
    const info = extractPackageInfoFromTuple(tuple)
    if (!info) continue
    if (info.hasInstallScript === true) {
      hasInstallScriptPackages.push(pkgKey)
    }
    if (info.libc !== undefined) {
      libcNativePackageCount += 1
    }
  }

  hasInstallScriptPackages.sort((a, b) => a.localeCompare(b))

  const catalogCount = (lockfile.catalog ? 1 : 0) + Object.keys(lockfile.catalogs ?? {}).length

  return {
    lockfileVersion: lockfile.lockfileVersion,
    configVersion: linkerRes.configVersion,
    isWorkspaceProject: linkerRes.isWorkspaceProject,
    workspaceCount: workspaces.length,
    workspaces,
    packageCount: packageEntries.length,
    hasInstallScriptCount: hasInstallScriptPackages.length,
    hasInstallScriptPackages,
    libcNativePackageCount,
    overrideCount: Object.keys(lockfile.overrides ?? {}).length,
    trustedDependencyCount: lockfile.trustedDependencies?.length ?? 0,
    patchedDependencyCount: Object.keys(lockfile.patchedDependencies ?? {}).length,
    catalogCount,
    defaultLinkerStrategy: linkerRes.linker,
    defaultLinkerReason: linkerRes.reason,
  }
}
