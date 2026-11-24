/**
 * Server-side filesystem discovery and loading for Bun `.npmrc` and `bunfig.toml` configuration
 * layers. Load order (later overrides earlier):
 *
 * 1. User `.npmrc`: `NPM_CONFIG_USERCONFIG` (relative to cwd, supports `~/`), else
 *    `$XDG_CONFIG_HOME/.npmrc` if it exists, else `$HOME/.npmrc`.
 * 2. Project `.npmrc` next to root `package.json`.
 * 3. Global `bunfig.toml` (`$XDG_CONFIG_HOME/.bunfig.toml` or `$HOME/.bunfig.toml`).
 * 4. Project `./bunfig.toml`.
 * 5. Environment variables (`BUN_CONFIG_REGISTRY`/`NPM_CONFIG_REGISTRY`,
 *    `BUN_CONFIG_TOKEN`/`NPM_CONFIG_TOKEN`, `NPM_CONFIG_IGNORE_SCRIPTS`).
 * 6. CLI flags (optional override). Security invariants:
 *
 * - Unreadable or missing files are skipped silently (matching Bun/npm).
 * - Public `loadRedactedNpmrcStatusSummary()` strictly strips all secret values before returning
 *   telemetry to `/api/config/status`.
 *
 * @file Packages/api/src/npmrc_loader.ts
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve } from "node:path"

import { type BunLockFile, parseBunLockFile } from "../../contracts/src/bun_lockfile.ts"
import {
  type BunCliInstallFlags,
  type NpmrcLayerStatus,
  parseBunfigInstallToml,
  type ParsedBunfigInstallConfig,
  type ParsedNpmrcFile,
  parseNpmrc,
  type RedactedNpmrcStatusSummary,
  redactResolvedBunPackageConfig,
  resolveBunPackageConfig,
  type ResolvedBunPackageConfig,
  resolveNpmrcPath,
} from "../../contracts/src/npmrc.ts"

export interface LoadBunNpmrcFromDiskOptions {
  readonly cwd?: string | undefined
  readonly projectRoot?: string | undefined
  readonly homeDir?: string | undefined
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly cli?: BunCliInstallFlags | null | undefined
}

export interface LoadedBunNpmrcDiskResult {
  readonly resolved: ResolvedBunPackageConfig
  readonly layers: readonly NpmrcLayerStatus[]
  readonly bunLockfilePath: string | null
  readonly userNpmrcPath: string | null
  readonly projectNpmrcPath: string | null
  readonly globalBunfigPath: string | null
  readonly projectBunfigPath: string | null
}

function tryReadTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8")
  } catch {
    return null
  }
}

/**
 * Resolve the user-level `.npmrc` path using Bun's exact rules:
 *
 * 1. `NPM_CONFIG_USERCONFIG` (relative to `cwd`, expanding leading `~/`)
 * 2. `$XDG_CONFIG_HOME/.npmrc` if it exists
 * 3. `$HOME/.npmrc`
 */
export function resolveUserNpmrcPath(options: {
  readonly cwd: string
  readonly homeDir: string
  readonly env: Readonly<Record<string, string | undefined>>
}): string {
  const userConfigEnv =
    options.env.NPM_CONFIG_USERCONFIG?.trim() || options.env.npm_config_userconfig?.trim()
  if (userConfigEnv) {
    return resolveNpmrcPath(userConfigEnv, options.cwd, options.homeDir)
  }
  const xdgConfigHome = options.env.XDG_CONFIG_HOME?.trim()
  if (xdgConfigHome) {
    const xdgCandidate = resolve(xdgConfigHome, ".npmrc")
    if (existsSync(xdgCandidate)) {
      return xdgCandidate
    }
  }
  return resolve(options.homeDir, ".npmrc")
}

/** Resolve the global `bunfig.toml` path (`$XDG_CONFIG_HOME/.bunfig.toml` or `$HOME/.bunfig.toml`). */
export function resolveGlobalBunfigPath(options: {
  readonly homeDir: string
  readonly env: Readonly<Record<string, string | undefined>>
}): string {
  const xdgConfigHome = options.env.XDG_CONFIG_HOME?.trim()
  if (xdgConfigHome) {
    const xdgCandidate = resolve(xdgConfigHome, ".bunfig.toml")
    if (existsSync(xdgCandidate)) {
      return xdgCandidate
    }
  }
  return resolve(options.homeDir, ".bunfig.toml")
}

function summarizeNpmrcActiveKeys(parsed: ParsedNpmrcFile): readonly string[] {
  const keys: string[] = []
  if (parsed.registry !== undefined) keys.push("registry")
  for (const scope of Object.keys(parsed.scopes)) {
    keys.push(`@${scope}:registry`)
  }
  for (const prefix of Object.keys(parsed.registryAuth)) {
    keys.push(`${prefix}:*`)
  }
  if (parsed.linkWorkspacePackages !== undefined) keys.push("link-workspace-packages")
  if (parsed.saveExact !== undefined) keys.push("save-exact")
  if (parsed.ignoreScripts !== undefined) keys.push("ignore-scripts")
  if (parsed.dryRun !== undefined) keys.push("dry-run")
  if (parsed.cache !== undefined) keys.push("cache")
  if (parsed.cafile) keys.push("cafile")
  else if (parsed.ca && parsed.ca.length > 0) keys.push("ca")
  if (parsed.omit.length > 0) keys.push("omit")
  if (parsed.include.length > 0) keys.push("include")
  if (parsed.installStrategy) keys.push("install-strategy")
  if (parsed.nodeLinker) keys.push("node-linker")
  if (parsed.publicHoistPattern) keys.push("public-hoist-pattern")
  if (parsed.hoistPattern) keys.push("hoist-pattern")
  if (parsed.hoist !== undefined) keys.push("hoist")
  return keys
}

function summarizeBunfigActiveKeys(parsed: ParsedBunfigInstallConfig): readonly string[] {
  const keys: string[] = []
  if (parsed.registry !== undefined) keys.push("install.registry")
  if (parsed.scopes) {
    for (const s of Object.keys(parsed.scopes)) {
      keys.push(`install.scopes.${s}`)
    }
  }
  if (parsed.optional !== undefined) keys.push("install.optional")
  if (parsed.dev !== undefined) keys.push("install.dev")
  if (parsed.peer !== undefined) keys.push("install.peer")
  if (parsed.production !== undefined) keys.push("install.production")
  if (parsed.linkWorkspacePackages !== undefined) {
    keys.push("install.linkWorkspacePackages")
  }
  if (parsed.exact !== undefined) keys.push("install.exact")
  if (parsed.frozenLockfile !== undefined) keys.push("install.frozenLockfile")
  if (parsed.saveTextLockfile !== undefined) {
    keys.push("install.saveTextLockfile")
  }
  if (parsed.auto !== undefined) keys.push("install.auto")
  if (parsed.ignoreScripts !== undefined) keys.push("install.ignoreScripts")
  if (parsed.dryRun !== undefined) keys.push("install.dryRun")
  if (parsed.globalStore !== undefined) keys.push("install.globalStore")
  if (parsed.globalDir !== undefined) keys.push("install.globalDir")
  if (parsed.globalBinDir !== undefined) keys.push("install.globalBinDir")
  if (parsed.minimumReleaseAge !== undefined) {
    keys.push("install.minimumReleaseAge")
  }
  if (parsed.minimumReleaseAgeExcludes !== undefined) {
    keys.push("install.minimumReleaseAgeExcludes")
  }
  if (parsed.publicHoistPattern !== undefined) {
    keys.push("install.publicHoistPattern")
  }
  if (parsed.hoistPattern !== undefined) keys.push("install.hoistPattern")
  if (parsed.lockfile?.save !== undefined) keys.push("install.lockfile.save")
  if (parsed.lockfile?.print !== undefined) keys.push("install.lockfile.print")
  if (parsed.cache?.dir) keys.push("install.cache.dir")
  if (parsed.cache?.disable !== undefined) keys.push("install.cache.disable")
  if (parsed.cache?.disableManifest !== undefined) {
    keys.push("install.cache.disableManifest")
  }
  if (parsed.security?.scanner) keys.push("install.security.scanner")
  if (parsed.cafile) keys.push("install.cafile")
  else if (parsed.ca && parsed.ca.length > 0) keys.push("install.ca")
  if (parsed.linker) keys.push("install.linker")
  if (parsed.run?.shell !== undefined) keys.push("run.shell")
  if (parsed.run?.bun !== undefined) keys.push("run.bun")
  if (parsed.run?.silent !== undefined) keys.push("run.silent")
  if (parsed.run?.noOrphans !== undefined) keys.push("run.noOrphans")
  return keys
}

/** Discover, parse, and merge `.npmrc`, `bunfig.toml`, env, and CLI layers. */
export function loadBunNpmrcFromDisk(
  options: LoadBunNpmrcFromDiskOptions = {},
): LoadedBunNpmrcDiskResult {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const projectRoot = options.projectRoot ?? cwd
  const homeDir = options.homeDir ?? env.HOME?.trim() ?? homedir()

  const bunLockfileCandidate = resolve(projectRoot, "bun.lock")
  const userNpmrcCandidate = resolveUserNpmrcPath({ cwd, homeDir, env })
  const projectNpmrcCandidate = resolve(projectRoot, ".npmrc")
  const globalBunfigCandidate = resolveGlobalBunfigPath({ homeDir, env })
  const projectBunfigCandidate = resolve(projectRoot, "bunfig.toml")

  let bunLockfile: BunLockFile | null = null
  const rawBunLockfile = tryReadTextFile(bunLockfileCandidate)
  if (rawBunLockfile !== null) {
    try {
      bunLockfile = parseBunLockFile(rawBunLockfile)
    } catch {
      bunLockfile = null
    }
  }

  let userNpmrc: ParsedNpmrcFile | null = null
  const rawUserNpmrc = tryReadTextFile(userNpmrcCandidate)
  if (rawUserNpmrc !== null) {
    userNpmrc = parseNpmrc(rawUserNpmrc, {
      source: "user-npmrc",
      filePath: userNpmrcCandidate,
      baseDir: dirname(userNpmrcCandidate),
      homeDir,
      env,
    })
  }

  let projectNpmrc: ParsedNpmrcFile | null = null
  const rawProjectNpmrc =
    projectNpmrcCandidate !== userNpmrcCandidate ? tryReadTextFile(projectNpmrcCandidate) : null
  if (rawProjectNpmrc !== null) {
    projectNpmrc = parseNpmrc(rawProjectNpmrc, {
      source: "project-npmrc",
      filePath: projectNpmrcCandidate,
      baseDir: dirname(projectNpmrcCandidate),
      homeDir,
      env,
    })
  }

  let globalBunfig: ParsedBunfigInstallConfig | null = null
  const rawGlobalBunfig = tryReadTextFile(globalBunfigCandidate)
  if (rawGlobalBunfig !== null) {
    globalBunfig = parseBunfigInstallToml(
      rawGlobalBunfig,
      "global-bunfig",
      env,
      globalBunfigCandidate,
    )
  }

  let projectBunfig: ParsedBunfigInstallConfig | null = null
  const rawProjectBunfig =
    projectBunfigCandidate !== globalBunfigCandidate
      ? tryReadTextFile(projectBunfigCandidate)
      : null
  if (rawProjectBunfig !== null) {
    projectBunfig = parseBunfigInstallToml(
      rawProjectBunfig,
      "project-bunfig",
      env,
      projectBunfigCandidate,
    )
  }

  const resolved = resolveBunPackageConfig({
    bunLockfile,
    userNpmrc,
    projectNpmrc,
    globalBunfig,
    projectBunfig,
    env,
    cli: options.cli,
  })

  const envActiveKeys: string[] = []
  if (env.NPM_CONFIG_USERCONFIG) envActiveKeys.push("NPM_CONFIG_USERCONFIG")
  if (env.BUN_CONFIG_REGISTRY) envActiveKeys.push("BUN_CONFIG_REGISTRY")
  if (env.NPM_CONFIG_REGISTRY) envActiveKeys.push("NPM_CONFIG_REGISTRY")
  if (env.BUN_CONFIG_TOKEN) envActiveKeys.push("BUN_CONFIG_TOKEN (redacted)")
  if (env.NPM_CONFIG_TOKEN) envActiveKeys.push("NPM_CONFIG_TOKEN (redacted)")
  if (env.NPM_CONFIG_IGNORE_SCRIPTS !== undefined || env.npm_config_ignore_scripts !== undefined) {
    envActiveKeys.push("NPM_CONFIG_IGNORE_SCRIPTS")
  }
  if (env.BUN_INSTALL_GLOBAL_DIR) envActiveKeys.push("BUN_INSTALL_GLOBAL_DIR")
  if (env.BUN_INSTALL_BIN) envActiveKeys.push("BUN_INSTALL_BIN")

  const cliActiveKeys: string[] = []
  if (options.cli?.registry) cliActiveKeys.push("--registry")
  if (options.cli?.cafile) cliActiveKeys.push("--cafile")
  if (options.cli?.ca && options.cli.ca.length > 0) cliActiveKeys.push("--ca")
  if (options.cli?.ignoreScripts !== undefined) cliActiveKeys.push("--ignore-scripts")
  if (options.cli?.dryRun !== undefined) cliActiveKeys.push("--dry-run")
  if (options.cli?.exact !== undefined) cliActiveKeys.push("--exact")
  if (options.cli?.linker !== undefined) cliActiveKeys.push("--linker")

  const displayHomePath = (absPath: string): string => {
    const cleanHome = homeDir.replace(/\/+$/, "")
    if (cleanHome && absPath.startsWith(`${cleanHome}/`)) {
      return `~/${absPath.slice(cleanHome.length + 1)}`
    }
    return absPath
  }

  const lockfileSummary = resolved.lockfileSummary ?? null
  const lockfileActiveKeys: string[] = lockfileSummary
    ? [
        `lockfileVersion=${lockfileSummary.lockfileVersion}`,
        `configVersion=${lockfileSummary.configVersion ?? "unset"}`,
        `${lockfileSummary.workspaceCount} workspace${lockfileSummary.workspaceCount === 1 ? "" : "s"}`,
        `defaultLinker=${lockfileSummary.defaultLinkerStrategy}`,
      ]
    : []

  const layers: NpmrcLayerStatus[] = [
    {
      layer: "bun-lockfile",
      label: "0. Project ./bun.lock (BunLockFile)",
      path: bunLockfile ? "./bun.lock" : null,
      detected: Boolean(bunLockfile),
      activeKeys: lockfileActiveKeys,
    },
    {
      layer: "user-npmrc",
      label: "1. User .npmrc",
      path: userNpmrc ? displayHomePath(userNpmrcCandidate) : null,
      detected: Boolean(userNpmrc),
      activeKeys: userNpmrc ? summarizeNpmrcActiveKeys(userNpmrc) : [],
    },
    {
      layer: "project-npmrc",
      label: "2. Project ./.npmrc",
      path: projectNpmrc ? "./.npmrc" : null,
      detected: Boolean(projectNpmrc),
      activeKeys: projectNpmrc ? summarizeNpmrcActiveKeys(projectNpmrc) : [],
    },
    {
      layer: "global-bunfig",
      label: "3a. Global bunfig.toml",
      path: globalBunfig ? displayHomePath(globalBunfigCandidate) : null,
      detected: Boolean(globalBunfig),
      activeKeys: globalBunfig ? summarizeBunfigActiveKeys(globalBunfig) : [],
    },
    {
      layer: "project-bunfig",
      label: "3b. Project ./bunfig.toml",
      path: projectBunfig ? "./bunfig.toml" : null,
      detected: Boolean(projectBunfig),
      activeKeys: projectBunfig ? summarizeBunfigActiveKeys(projectBunfig) : [],
    },
    {
      layer: "env",
      label: "4. BUN_CONFIG_* / NPM_CONFIG_* Env",
      path: null,
      detected: envActiveKeys.length > 0,
      activeKeys: envActiveKeys,
    },
    {
      layer: "cli",
      label: "5. CLI Flags (--registry, --linker, etc.)",
      path: null,
      detected: cliActiveKeys.length > 0,
      activeKeys: cliActiveKeys,
    },
  ]

  return {
    resolved,
    layers,
    bunLockfilePath: bunLockfile ? bunLockfileCandidate : null,
    userNpmrcPath: userNpmrc ? userNpmrcCandidate : null,
    projectNpmrcPath: projectNpmrc ? projectNpmrcCandidate : null,
    globalBunfigPath: globalBunfig ? globalBunfigCandidate : null,
    projectBunfigPath: projectBunfig ? projectBunfigCandidate : null,
  }
}

/**
 * Return a strictly redacted `.npmrc` & `bunfig.toml` status summary safe for HTTP responses
 * (`/api/config/status`) and browser rendering.
 */
export function loadRedactedNpmrcStatusSummary(
  options: LoadBunNpmrcFromDiskOptions = {},
): RedactedNpmrcStatusSummary {
  const loaded = loadBunNpmrcFromDisk(options)
  return redactResolvedBunPackageConfig(loaded.resolved, loaded.layers)
}
