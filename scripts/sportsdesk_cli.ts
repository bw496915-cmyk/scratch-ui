/**
 * @file scripts/sportsdesk_cli.ts
 * @description Unified Bun CLI entrypoint (`bun run cli <command>`) for SportsDesk Ops Dashboard.
 *
 * Unifies:
 *  - Generated artifacts & design token compilation (`cli artifacts generate|check|status`)
 *  - Markdown documentation link/staleness audit & terminal rendering (`cli docs check|list|render`)
 *  - Live Bun Runtime Surface introspection (`cli surface [--kinds|--deep|--json]`)
 *  - Repository integrity gates (`cli check [all|lockfile|route-surface|bundle-hygiene|shell-boundary|snapshots|artifacts|docs]`)
 *  - Grouped package.json scripts catalog (`cli scripts [filter]`)
 *
 * Security:
 *  - Enforces `assertSafeExecArgv()` on startup to block unallowlisted `--env-file` bleed.
 *  - Uses fixed-argv `Bun.spawnSync` / `execFileSync` (zero raw shells).
 *  - Never reads or prints `Bun.env` or `Bun.secrets` values.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { loadBunRuntimeSurfaceAudit } from "../packages/api/src/bun_runtime_surface_loader.ts"
import {
  type BunMarkdownRenderMode,
  type BunMarkdownRenderPresetId,
  formatInspectTable,
  renderBunMarkdownStudio,
} from "../packages/contracts/src/bun_runtime_surface.ts"
import {
  isValidSemver,
  isValidSemverRange,
  maxSatisfying,
  safeSatisfies,
  safeSemverOrder,
  sortSemver,
} from "../packages/contracts/src/bun_semver.ts"
import { assertSafeExecArgv } from "../src/cli/preflight_guard.ts"
import {
  auditMarkdownDocs,
  auditPipelineArtifactsMetadata,
  runArtifactPipeline,
  UNIFIED_CLI_COMMANDS,
} from "./gen_artifacts.ts"
import { auditUnifiedVersions, bumpWorkspaceVersions } from "./version_manager.ts"

const ROOT_DIR = process.cwd()

const CHECK_GATE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  lockfile: ["scripts/check_lockfile_integrity.ts"],
  "registry-parity": ["scripts/check_registry_parity.ts"],
  "route-surface": ["scripts/check_route_surface.ts"],
  "bundle-hygiene": ["scripts/check_bundle_hygiene.ts"],
  "shell-boundary": ["scripts/check_shell_boundary.ts"],
  snapshots: ["scripts/check_snapshot_hygiene.ts"],
  artifacts: ["scripts/gen_artifacts.ts", "--check"],
}

function runBunScript(argv: readonly string[]): number {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    | {
        readonly spawnSync?: (opts: {
          readonly cmd: readonly string[]
          readonly cwd: string
          readonly stdout: "inherit"
          readonly stderr: "inherit"
        }) => { readonly exitCode: number }
      }
    | undefined

  if (typeof bunObj?.spawnSync === "function") {
    const res = bunObj.spawnSync({
      cmd: ["bun", ...argv],
      cwd: ROOT_DIR,
      stdout: "inherit",
      stderr: "inherit",
    })
    return res.exitCode
  }

  try {
    execFileSync("bun", [...argv], { cwd: ROOT_DIR, stdio: "inherit" })
    return 0
  } catch (err) {
    return (err as { readonly status?: number }).status ?? 1
  }
}

function printHelp(): void {
  const bunVersion =
    typeof (globalThis as Record<string, unknown>).Bun === "object"
      ? String(
          ((globalThis as Record<string, unknown>).Bun as { readonly version?: string }).version ??
            "unknown",
        )
      : process.version
  console.log(`SportsDesk Ops Dashboard — Unified Bun CLI (runtime: ${bunVersion})`)
  console.log(formatInspectTable(UNIFIED_CLI_COMMANDS, ["command", "description"]))
}

function handleArtifacts(subArgs: readonly string[]): number {
  const action = subArgs[0] ?? "status"
  const tokensOnly = subArgs.includes("--tokens-only")

  if (action === "generate" || action === "gen") {
    const res = runArtifactPipeline({ rootDir: ROOT_DIR, check: false, tokensOnly })
    if (!res.ok) {
      for (const issue of [...res.pipelineIssues, ...res.markdownIssues]) {
        console.error(`  - ${issue}`)
      }
      return 1
    }
    const summary = res.writtenFiles.length > 0 ? res.writtenFiles.join(", ") : "already up-to-date"
    console.log(`PASS: Artifacts synced (${summary})`)
    return 0
  }

  if (action === "check" || action === "gate") {
    const res = runArtifactPipeline({ rootDir: ROOT_DIR, check: true, tokensOnly })
    if (!res.ok) {
      for (const f of res.driftedFiles) console.error(`  - [DRIFT] ${f}`)
      for (const p of res.pipelineIssues) console.error(`  - [PIPELINE] ${p}`)
      for (const m of res.markdownIssues) console.error(`  - [DOCS] ${m}`)
      return 1
    }
    console.log("PASS: All generated artifacts and pipeline hashes verified with zero drift.")
    return 0
  }

  if (action === "status") {
    const res = runArtifactPipeline({ rootDir: ROOT_DIR, check: true, tokensOnly })
    const pipeline = auditPipelineArtifactsMetadata(ROOT_DIR)
    const rows = (res.manifest?.generatedArtifacts ?? []).map((a) => ({
      path: a.path,
      source: a.source,
      bytes: a.bytes,
      sha256: a.sha256.slice(0, 12),
      status: res.driftedFiles.includes(a.path) ? "DRIFT" : "OK",
    }))
    console.log(formatInspectTable(rows, ["path", "source", "bytes", "sha256", "status"]))
    console.log(
      `Pipeline diagrams: ${pipeline.verifiedFiles}/${pipeline.totalArtifacts * 3} assets verified (${pipeline.issues.length} issues)`,
    )
    return res.ok ? 0 : 1
  }

  console.error(`Unknown artifacts subcommand: ${action} (expected generate|check|status)`)
  return 2
}

function handleDocs(subArgs: readonly string[]): number {
  const action = subArgs[0] ?? "check"

  if (action === "check") {
    const audit = auditMarkdownDocs(ROOT_DIR)
    if (audit.issues.length > 0) {
      console.error(`FAIL: Markdown audit found ${audit.issues.length} issue(s):`)
      for (const issue of audit.issues) {
        console.error(`  - ${issue}`)
      }
      return 1
    }
    const totalLinks = audit.docs.reduce((acc, d) => acc + d.localLinksChecked, 0)
    console.log(
      `PASS: Audited ${audit.docs.length} Markdown files (${totalLinks} local links verified, 0 broken links, 0 stale references).`,
    )
    return 0
  }

  if (action === "list") {
    const audit = auditMarkdownDocs(ROOT_DIR)
    const rows = audit.docs.map((d) => ({
      path: d.path,
      lines: d.lines,
      links: d.localLinksChecked,
      issues: d.brokenLinks.length + d.staleReferences.length,
      sha256: d.sha256.slice(0, 12),
    }))
    console.log(formatInspectTable(rows, ["path", "lines", "links", "issues", "sha256"]))
    return 0
  }

  if (action === "render") {
    const targetArg = subArgs[1] ?? "dashboard.md"
    const fullTarget = resolve(ROOT_DIR, targetArg)
    if (!fullTarget.startsWith(ROOT_DIR) || !existsSync(fullTarget)) {
      console.error(`Markdown file not found inside workspace: ${targetArg}`)
      return 2
    }
    const rawMd = readFileSync(fullTarget, "utf8")
    let mode: BunMarkdownRenderMode = "render-callbacks"
    let presetId: BunMarkdownRenderPresetId = "obsidian-desk"
    let columns = 88
    let colors = true
    let light = false
    let hyperlinks = true

    for (let i = 2; i < subArgs.length; i += 1) {
      const arg = subArgs[i]!
      if (arg === "--mode" && subArgs[i + 1]) {
        const m = subArgs[i + 1]!
        mode = m === "ansi" ? "ansi-theme" : m === "html" ? "html" : "render-callbacks"
        i += 1
      } else if (arg === "--preset" && subArgs[i + 1]) {
        presetId = subArgs[i + 1] as BunMarkdownRenderPresetId
        i += 1
      } else if (arg === "--columns" && subArgs[i + 1]) {
        columns = Number(subArgs[i + 1]) || 88
        i += 1
      } else if (arg === "--light") {
        light = true
      } else if (arg === "--no-color") {
        colors = false
      } else if (arg === "--no-hyperlinks") {
        hyperlinks = false
      }
    }

    const rendered = renderBunMarkdownStudio(rawMd, {
      mode,
      presetId,
      theme: { colors, light, hyperlinks, columns },
    })
    process.stdout.write(mode === "html" ? `${rendered.html}\n` : rendered.ansi)
    return 0
  }

  console.error(`Unknown docs subcommand: ${action} (expected check|list|render)`)
  return 2
}

function handleSurface(subArgs: readonly string[]): number {
  const audit = loadBunRuntimeSurfaceAudit()
  if (subArgs.includes("--json")) {
    console.log(JSON.stringify(audit, null, 2))
    return 0
  }

  if (subArgs.includes("--deep")) {
    const rows = audit.deepInspections.map((d) => ({
      target: d.label,
      category: d.category,
      available: d.available,
      members: d.memberCount,
      classes: d.classCount,
      fns: d.functionCount,
      consts: d.constantCount,
    }))
    console.log(
      formatInspectTable(rows, [
        "target",
        "category",
        "available",
        "members",
        "classes",
        "fns",
        "consts",
      ]),
    )
    return 0
  }

  if (subArgs.includes("--kinds")) {
    const rows = Object.entries(audit.kindCounts).map(([kind, count]) => ({ kind, count }))
    console.log(formatInspectTable(rows, ["kind", "count"]))
    return 0
  }

  console.log(audit.inspectTableText)
  return 0
}

function handleVersion(subArgs: readonly string[]): number {
  const action = subArgs[0] ?? "status"
  const asJson = subArgs.includes("--json")

  if (action === "status" || action === "check") {
    const report = auditUnifiedVersions({ rootDir: ROOT_DIR })
    if (asJson) {
      console.log(JSON.stringify(report, null, 2))
      return action === "check" && !report.ok ? 1 : 0
    }
    const rows = report.records.map((r) => ({
      track: r.track,
      target: r.target,
      version: r.version,
      expected: r.expected,
      status: r.ok ? "OK" : "DRIFT",
      source: r.source,
    }))
    console.log(
      `Unified Versioning Matrix (engine: ${report.engine} · workspace: ${report.workspaceVersion ?? "unset"} · design: ${report.designVersion ?? "unset"} · bun: ${report.bunVersionPin ?? "unset"})`,
    )
    console.log(
      formatInspectTable(rows, ["track", "target", "version", "expected", "status", "source"]),
    )
    if (!report.ok) {
      console.error(`FAIL: Found ${report.violations.length} SemVer parity violation(s):`)
      for (const v of report.violations) {
        console.error(`  - ${v}`)
      }
      return 1
    }
    if (action === "check") {
      console.log(
        `PASS: All ${report.records.length} version pins verified via ${report.engine} (zero drift).`,
      )
    }
    return 0
  }

  if (action === "satisfies") {
    const version = subArgs[1]
    const range = subArgs[2]
    if (!version || !range) {
      console.error("Usage: bun run cli version satisfies <version> <range>")
      return 2
    }
    if (!isValidSemver(version) || !isValidSemverRange(range)) {
      console.error(`Invalid SemVer version or range: version='${version}', range='${range}'`)
      return 2
    }
    const matched = safeSatisfies(version, range)
    console.log(
      asJson
        ? JSON.stringify({ version, range, satisfies: matched })
        : `${version} ${matched ? "satisfies" : "does NOT satisfy"} ${range}`,
    )
    return matched ? 0 : 1
  }

  if (action === "order") {
    const a = subArgs[1]
    const b = subArgs[2]
    if (!a || !b) {
      console.error("Usage: bun run cli version order <versionA> <versionB>")
      return 2
    }
    const ord = safeSemverOrder(a, b)
    if (ord === null) {
      console.error(`Invalid SemVer input(s): '${a}', '${b}'`)
      return 2
    }
    const rel = ord === 0 ? "==" : ord === 1 ? ">" : "<"
    console.log(
      asJson ? JSON.stringify({ a, b, order: ord, relation: rel }) : `${ord} (${a} ${rel} ${b})`,
    )
    return 0
  }

  if (action === "sort") {
    const desc = subArgs.includes("--desc")
    const versions = subArgs.slice(1).filter((arg) => !arg.startsWith("--"))
    if (versions.length === 0) {
      console.error("Usage: bun run cli version sort [--desc] [--json] <v1> <v2> ...")
      return 2
    }
    try {
      const sorted = sortSemver(versions, desc ? "desc" : "asc")
      console.log(asJson ? JSON.stringify(sorted) : sorted.join("\n"))
      return 0
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      return 2
    }
  }

  if (action === "max") {
    const positional = subArgs.slice(1).filter((arg) => !arg.startsWith("--"))
    const [range, ...versions] = positional
    if (!range || versions.length === 0) {
      console.error("Usage: bun run cli version max [--json] <range> <v1> <v2> ...")
      return 2
    }
    if (!isValidSemverRange(range)) {
      console.error(`Invalid SemVer range: '${range}'`)
      return 2
    }
    const best = maxSatisfying(versions, range)
    console.log(asJson ? JSON.stringify({ range, max: best }) : (best ?? "none"))
    return best ? 0 : 1
  }

  if (action === "bump") {
    const target = subArgs[1]
    if (!target) {
      console.error(
        "Usage: bun run cli version bump <major|minor|patch|premajor|preminor|prepatch|prerelease|x.y.z> [--preid <tag>] [--dry-run] [--json]",
      )
      return 2
    }
    const dryRun = subArgs.includes("--dry-run")
    const preidIdx = subArgs.indexOf("--preid")
    const preid = preidIdx >= 0 ? subArgs[preidIdx + 1] : undefined
    const res = bumpWorkspaceVersions({
      rootDir: ROOT_DIR,
      target,
      preid,
      dryRun,
    })
    if (asJson) {
      console.log(JSON.stringify(res, null, 2))
      return res.ok ? 0 : 1
    }
    if (!res.ok) {
      console.error(`FAIL: ${res.error ?? "Version bump failed"}`)
      return 1
    }
    const rows = res.changes.map((c) => ({
      package: c.name,
      file: c.path,
      previous: c.previous,
      next: c.next,
      mode: dryRun ? "DRY-RUN" : c.written ? "UPDATED" : "UNCHANGED",
    }))
    console.log(
      `${dryRun ? "DRY-RUN" : "PASS"}: Workspace version ${res.previousVersion} -> ${res.nextVersion}`,
    )
    console.log(formatInspectTable(rows, ["package", "file", "previous", "next", "mode"]))
    return 0
  }

  console.error(
    `Unknown version subcommand: ${action} (expected status|check|satisfies|order|sort|max|bump)`,
  )
  return 2
}

function handleCheck(subArgs: readonly string[]): number {
  const target = subArgs[0] ?? "all"

  if (target === "docs") {
    return handleDocs(["check"])
  }
  if (target === "versions" || target === "version") {
    return handleVersion(["check"])
  }
  if (target !== "all") {
    const script = CHECK_GATE_SCRIPTS[target]
    if (!script) {
      console.error(
        `Unknown check gate: ${target} (expected all|versions|${Object.keys(CHECK_GATE_SCRIPTS).join("|")}|docs)`,
      )
      return 2
    }
    return runBunScript(script)
  }

  const order = [
    "versions",
    "lockfile",
    "registry-parity",
    "snapshots",
    "route-surface",
    "shell-boundary",
    "artifacts",
    "docs",
  ] as const
  for (const gate of order) {
    console.log(`\n▶ [cli check] ${gate}`)
    const code =
      gate === "docs"
        ? handleDocs(["check"])
        : gate === "versions"
          ? handleVersion(["check"])
          : runBunScript(CHECK_GATE_SCRIPTS[gate]!)
    if (code !== 0) return code
  }
  console.log("\nPASS: All unified Bun CLI gates passed.")
  return 0
}

function handleScripts(subArgs: readonly string[]): number {
  const filter = (subArgs[0] ?? "").trim().toLowerCase()
  const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, "package.json"), "utf8")) as {
    readonly scripts?: Record<string, string>
  }
  const rows = Object.entries(pkg.scripts ?? {})
    .filter(
      ([k, v]) => !filter || k.toLowerCase().includes(filter) || v.toLowerCase().includes(filter),
    )
    .map(([name, command]) => ({ script: `bun run ${name}`, command }))
  console.log(formatInspectTable(rows, ["script", "command"]))
  return 0
}

export function runSportsdeskCli(argv: readonly string[]): number {
  const [command = "help", ...rest] = argv
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp()
      return 0
    case "version":
    case "versions":
    case "semver":
      return handleVersion(rest)
    case "artifacts":
      return handleArtifacts(rest)
    case "docs":
      return handleDocs(rest)
    case "surface":
      return handleSurface(rest)
    case "check":
      return handleCheck(rest)
    case "scripts":
      return handleScripts(rest)
    default:
      console.error(`Unknown CLI command: ${command}`)
      printHelp()
      return 2
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]).endsWith("sportsdesk_cli.ts")

if (isMain) {
  assertSafeExecArgv()
  const exitCode = runSportsdeskCli(process.argv.slice(2))
  if (exitCode !== 0) process.exit(exitCode)
}
