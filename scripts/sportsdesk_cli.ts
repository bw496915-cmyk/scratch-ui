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
import {
  formatInspectTable,
  renderBunMarkdownStudio,
  type BunMarkdownRenderMode,
  type BunMarkdownRenderPresetId,
} from "../packages/contracts/src/bun_runtime_surface.ts"
import { loadBunRuntimeSurfaceAudit } from "../packages/api/src/bun_runtime_surface_loader.ts"
import { assertSafeExecArgv } from "../src/cli/preflight_guard.ts"
import {
  UNIFIED_CLI_COMMANDS,
  auditMarkdownDocs,
  auditPipelineArtifactsMetadata,
  runArtifactPipeline,
} from "./gen_artifacts.ts"

const ROOT_DIR = process.cwd()

const CHECK_GATE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  lockfile: ["scripts/check_lockfile_integrity.ts"],
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

function handleCheck(subArgs: readonly string[]): number {
  const target = subArgs[0] ?? "all"

  if (target === "docs") {
    return handleDocs(["check"])
  }
  if (target !== "all") {
    const script = CHECK_GATE_SCRIPTS[target]
    if (!script) {
      console.error(
        `Unknown check gate: ${target} (expected all|${Object.keys(CHECK_GATE_SCRIPTS).join("|")}|docs)`,
      )
      return 2
    }
    return runBunScript(script)
  }

  const order = [
    "lockfile",
    "snapshots",
    "route-surface",
    "shell-boundary",
    "artifacts",
    "docs",
  ] as const
  for (const gate of order) {
    console.log(`\n▶ [cli check] ${gate}`)
    const code = gate === "docs" ? handleDocs(["check"]) : runBunScript(CHECK_GATE_SCRIPTS[gate]!)
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
