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
  BUN_CLI_ANSI_PROFILES,
  type BunAnsiThemeConfig,
  type BunCliAnsiProfileId,
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
  type MarkdownDocAuditEntry,
  runArtifactPipeline,
  UNIFIED_CLI_COMMANDS,
} from "./gen_artifacts.ts"
import { auditUnifiedVersions, bumpWorkspaceVersions } from "./version_manager.ts"

const ROOT_DIR = process.cwd()

function writeStdoutSafe(text: string): void {
  try {
    process.stdout.write(text)
  } catch (err) {
    if ((err as { readonly code?: string } | null)?.code === "EPIPE") {
      return
    }
    throw err
  }
}

if (typeof process !== "undefined" && process.stdout && typeof process.stdout.on === "function") {
  process.stdout.on("error", (err: { readonly code?: string }) => {
    if (err?.code === "EPIPE") {
      process.exit(0)
    }
  })
}

const CHECK_GATE_SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  lockfile: ["scripts/check_lockfile_integrity.ts"],
  "registry-parity": ["scripts/check_registry_parity.ts"],
  "route-surface": ["scripts/check_route_surface.ts"],
  "bundle-hygiene": ["scripts/check_bundle_hygiene.ts"],
  "shell-boundary": ["scripts/check_shell_boundary.ts"],
  snapshots: ["scripts/check_snapshot_hygiene.ts"],
  artifacts: ["scripts/gen_artifacts.ts", "--check"],
}

interface ParsedCliOptions {
  readonly positional: readonly string[]
  readonly json: boolean
  readonly md: boolean
  readonly ansi: boolean
  readonly ids: boolean
  readonly light: boolean
  readonly noColor: boolean
  readonly noHyperlinks: boolean
  readonly desc: boolean
  readonly dryRun: boolean
  readonly tokensOnly: boolean
  readonly mode: BunMarkdownRenderMode
  readonly explicitMode: boolean
  readonly preset?: BunMarkdownRenderPresetId
  readonly profile?: BunCliAnsiProfileId
  readonly columns?: number
  readonly preid?: string
}

function loadTomlAnsiThemeProfile(profileName: string): BunAnsiThemeConfig | undefined {
  const builtin = BUN_CLI_ANSI_PROFILES.find(
    (p) => p.id === profileName || p.profileId === profileName,
  )?.ansiTheme
  const tokensPath = resolve(ROOT_DIR, "design/tokens.toml")
  if (!existsSync(tokensPath) || typeof Bun === "undefined" || !Bun.TOML) {
    return builtin
  }
  try {
    const parsed = Bun.TOML.parse(readFileSync(tokensPath, "utf8")) as {
      readonly cli?: {
        readonly markdown_ansi?: Readonly<
          Record<
            string,
            {
              readonly profile_id?: string
              readonly colors?: boolean
              readonly columns?: number
              readonly hyperlinks?: boolean
              readonly kitty_graphics?: boolean
              readonly light?: boolean
            }
          >
        >
      }
    }
    const table = parsed.cli?.markdown_ansi
    if (!table) return builtin
    const matched =
      table[profileName] ?? Object.values(table).find((entry) => entry.profile_id === profileName)
    if (!matched) return builtin
    return {
      colors: typeof matched.colors === "boolean" ? matched.colors : (builtin?.colors ?? true),
      columns: typeof matched.columns === "number" ? matched.columns : (builtin?.columns ?? 88),
      hyperlinks:
        typeof matched.hyperlinks === "boolean"
          ? matched.hyperlinks
          : (builtin?.hyperlinks ?? true),
      light: typeof matched.light === "boolean" ? matched.light : (builtin?.light ?? false),
      kittyGraphics:
        typeof matched.kitty_graphics === "boolean"
          ? matched.kitty_graphics
          : (builtin?.kittyGraphics ?? false),
    }
  } catch {
    return builtin
  }
}

function parseCliFlags(args: readonly string[]): ParsedCliOptions {
  const positional: string[] = []
  let json = false
  let md = false
  let ansi = false
  let ids = false
  let light = false
  let noColor = false
  let noHyperlinks = false
  let desc = false
  let dryRun = false
  let tokensOnly = false
  let mode: BunMarkdownRenderMode = "render-callbacks"
  let explicitMode = false
  let preset: BunMarkdownRenderPresetId | undefined
  let profile: BunCliAnsiProfileId | undefined
  let columns: number | undefined
  let preid: string | undefined

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg === "--json") json = true
    else if (arg === "--md" || arg === "--markdown") md = true
    else if (arg === "--ansi") ansi = true
    else if (arg === "--ids" || arg === "--meta") ids = true
    else if (arg === "--light") light = true
    else if (arg === "--no-color") noColor = true
    else if (arg === "--no-hyperlinks") noHyperlinks = true
    else if (arg === "--desc") desc = true
    else if (arg === "--dry-run") dryRun = true
    else if (arg === "--tokens-only") tokensOnly = true
    else if (arg === "--mode" && args[i + 1]) {
      const m = args[i + 1]!
      mode = m === "ansi" ? "ansi-theme" : m === "html" ? "html" : "render-callbacks"
      explicitMode = true
      i += 1
    } else if (arg === "--preset" && args[i + 1]) {
      preset = args[i + 1] as BunMarkdownRenderPresetId
      i += 1
    } else if (arg === "--profile" && args[i + 1]) {
      profile = args[i + 1] as BunCliAnsiProfileId
      i += 1
    } else if (arg === "--columns" && args[i + 1]) {
      const parsedCols = Number(args[i + 1])
      if (Number.isFinite(parsedCols)) columns = parsedCols
      i += 1
    } else if (arg === "--preid" && args[i + 1]) {
      preid = args[i + 1]!
      i += 1
    } else if (!arg.startsWith("-")) {
      positional.push(arg)
    }
  }

  return {
    positional,
    json,
    md,
    ansi,
    ids,
    light,
    noColor,
    noHyperlinks,
    desc,
    dryRun,
    tokensOnly,
    mode,
    explicitMode,
    preset,
    profile,
    columns,
    preid,
  }
}

function buildGfmTableMarkdown(
  heading: string,
  headers: readonly string[],
  alignments: readonly ("left" | "center" | "right")[],
  rows: readonly (readonly string[])[],
  subtitle?: string,
): string {
  const esc = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
  const widths = headers.map((h, i) =>
    Math.max(h.length, 3, ...rows.map((r) => esc(r[i] ?? "").length)),
  )
  const fmtRow = (cells: readonly string[]) =>
    `| ${cells
      .map((cell, i) => {
        const text = esc(cell)
        const w = widths[i]!
        return alignments[i] === "right" ? text.padStart(w, " ") : text.padEnd(w, " ")
      })
      .join(" | ")} |`
  const sep = `| ${alignments
    .map((align, i) => {
      const w = widths[i]!
      if (align === "right") return `${"-".repeat(w - 1)}:`
      if (align === "center") return `:${"-".repeat(Math.max(1, w - 2))}:`
      return `:${"-".repeat(w - 1)}`
    })
    .join(" | ")} |`

  const table = [fmtRow(headers), sep, ...rows.map((r) => fmtRow(r))].join("\n")
  return [`# ${heading}`, ...(subtitle ? ["", subtitle] : []), "", table, ""].join("\n")
}

function resolveThemeFromFlags(flags: ParsedCliOptions): Partial<BunAnsiThemeConfig> {
  const fromToml = flags.profile ? loadTomlAnsiThemeProfile(flags.profile) : undefined
  return {
    colors: flags.noColor ? false : (fromToml?.colors ?? true),
    columns: flags.columns ?? fromToml?.columns ?? 100,
    hyperlinks: flags.noHyperlinks ? false : (fromToml?.hyperlinks ?? true),
    light: flags.light ? true : (fromToml?.light ?? false),
    kittyGraphics: fromToml?.kittyGraphics ?? false,
  }
}

function printTableView(options: {
  readonly heading: string
  readonly subtitle?: string
  readonly headers: readonly string[]
  readonly alignments: readonly ("left" | "center" | "right")[]
  readonly rows: readonly (readonly string[])[]
  readonly inspectRows: readonly Record<string, unknown>[]
  readonly inspectColumns: readonly string[]
  readonly flags: ParsedCliOptions
}): void {
  if (options.flags.md) {
    writeStdoutSafe(
      buildGfmTableMarkdown(
        options.heading,
        options.headers,
        options.alignments,
        options.rows,
        options.subtitle,
      ),
    )
    return
  }

  if (options.flags.ansi || options.flags.profile) {
    const md = buildGfmTableMarkdown(
      options.heading,
      options.headers,
      options.alignments,
      options.rows,
      options.subtitle,
    )
    const rendered = renderBunMarkdownStudio(md, {
      mode: options.flags.explicitMode ? options.flags.mode : "ansi-theme",
      presetId: options.flags.preset,
      profileId: options.flags.profile,
      showHeadingIds: options.flags.ids,
      theme: resolveThemeFromFlags(options.flags),
    })
    writeStdoutSafe(rendered.ansi)
    return
  }

  if (options.subtitle) console.log(options.subtitle)
  console.log(formatInspectTable(options.inspectRows, options.inspectColumns))
}

function resolveDocByTarget(
  docs: readonly MarkdownDocAuditEntry[],
  targetArg: string,
): MarkdownDocAuditEntry | undefined {
  const normalizedTarget = targetArg.replace(/\\/g, "/").replace(/^\.\//, "")
  return (
    docs.find((d) => d.metaId.toLowerCase() === targetArg.toLowerCase()) ??
    docs.find((d) => d.path === normalizedTarget)
  )
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

function printHelp(subArgs: readonly string[] = []): void {
  const flags = parseCliFlags(subArgs)
  const bunVersion =
    typeof (globalThis as Record<string, unknown>).Bun === "object"
      ? String(
          ((globalThis as Record<string, unknown>).Bun as { readonly version?: string }).version ??
            "unknown",
        )
      : process.version
  const subtitle = `SportsDesk Ops Dashboard — Unified Bun CLI (runtime: ${bunVersion})`
  printTableView({
    heading: "SportsDesk Ops Dashboard — Unified Bun CLI",
    subtitle,
    headers: ["Command", "Purpose"],
    alignments: ["left", "left"],
    rows: UNIFIED_CLI_COMMANDS.map((c) => [`\`${c.command}\``, c.description]),
    inspectRows: UNIFIED_CLI_COMMANDS,
    inspectColumns: ["command", "description"],
    flags,
  })
}

function handleArtifacts(subArgs: readonly string[]): number {
  const flags = parseCliFlags(subArgs)
  const action = flags.positional[0] ?? "status"
  const tokensOnly = flags.tokensOnly

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
    printTableView({
      heading: "Generated & Managed Artifacts Status",
      subtitle: `Pipeline diagrams: ${pipeline.verifiedFiles}/${pipeline.totalArtifacts * 3} assets verified (${pipeline.issues.length} issues)`,
      headers: ["Artifact Path", "Source", "Bytes", "SHA-256 (12)", "Status"],
      alignments: ["left", "left", "right", "left", "center"],
      rows: rows.map((r) => [
        `\`${r.path}\``,
        `\`${r.source}\``,
        `${r.bytes}`,
        `\`${r.sha256}\``,
        r.status,
      ]),
      inspectRows: rows,
      inspectColumns: ["path", "source", "bytes", "sha256", "status"],
      flags,
    })
    return res.ok ? 0 : 1
  }

  console.error(`Unknown artifacts subcommand: ${action} (expected generate|check|status)`)
  return 2
}

function handleDocs(subArgs: readonly string[]): number {
  const flags = parseCliFlags(subArgs)
  const action = flags.positional[0] ?? "check"

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
    const totalHeadings = audit.docs.reduce((acc, d) => acc + d.headingIds.length, 0)
    const totalTables = audit.docs.reduce((acc, d) => acc + d.tableCount, 0)
    console.log(
      `PASS: Audited ${audit.docs.length} Markdown files (${totalLinks} local links verified, ${totalHeadings} GFM heading meta IDs, ${totalTables} tables, 0 broken links, 0 stale references).`,
    )
    return 0
  }

  if (action === "list") {
    const audit = auditMarkdownDocs(ROOT_DIR)
    if (flags.json) {
      console.log(
        JSON.stringify(
          audit.docs.map((d) => ({
            metaId: d.metaId,
            path: d.path,
            title: d.title,
            lines: d.lines,
            links: d.localLinksChecked,
            tableCount: d.tableCount,
            taskSummary: d.taskSummary,
            headingCount: d.headingIds.length,
            headingIds: flags.ids ? d.headingIds : d.headingIds.map((h) => h.id),
            sha256: d.sha256.slice(0, 12),
          })),
          null,
          2,
        ),
      )
      return 0
    }

    const inspectRows = audit.docs.map((d) => ({
      metaId: d.metaId,
      path: d.path,
      headings: d.headingIds.length,
      tables: d.tableCount,
      lines: d.lines,
      links: d.localLinksChecked,
      sha256: d.sha256.slice(0, 12),
      ...(flags.ids
        ? {
            listedIds:
              d.headingIds
                .slice(0, 3)
                .map((h) => `#${h.id}`)
                .join(", ") + (d.headingIds.length > 3 ? ` (+${d.headingIds.length - 3})` : ""),
          }
        : {}),
    }))
    const headers = flags.ids
      ? ["Meta ID", "Document", "Headings", "Tables", "Lines", "Links", "Listed GFM IDs", "SHA-256"]
      : ["Meta ID", "Document", "Headings", "Tables", "Lines", "Links", "SHA-256"]
    const alignments: readonly ("left" | "center" | "right")[] = flags.ids
      ? ["left", "left", "right", "right", "right", "right", "left", "left"]
      : ["left", "left", "right", "right", "right", "right", "left"]
    const mdRows = audit.docs.map((d) => {
      const base = [
        `\`${d.metaId}\``,
        `\`${d.path}\``,
        String(d.headingIds.length),
        String(d.tableCount),
        String(d.lines),
        String(d.localLinksChecked),
      ]
      if (flags.ids) {
        const listed =
          d.headingIds.length === 0
            ? "—"
            : d.headingIds
                .slice(0, 3)
                .map((h) => `\`#${h.id}\``)
                .join(", ") + (d.headingIds.length > 3 ? ` (+${d.headingIds.length - 3})` : "")
        base.push(listed)
      }
      base.push(`\`${d.sha256.slice(0, 12)}\``)
      return base
    })

    printTableView({
      heading: "SportsDesk Tracked Markdown Documentation",
      subtitle: `${audit.docs.length} tracked documents · canonical SD-DOC-* meta IDs & GFM anchor index`,
      headers,
      alignments,
      rows: mdRows,
      inspectRows,
      inspectColumns: flags.ids
        ? ["metaId", "path", "headings", "tables", "lines", "links", "listedIds", "sha256"]
        : ["metaId", "path", "headings", "tables", "lines", "links", "sha256"],
      flags,
    })
    return 0
  }

  if (action === "ids") {
    const audit = auditMarkdownDocs(ROOT_DIR)
    const targetArg = flags.positional[1]
    const matchedDocs = targetArg
      ? audit.docs.filter((d) => {
          const resolved = resolveDocByTarget(audit.docs, targetArg)
          return resolved ? d.path === resolved.path : false
        })
      : audit.docs

    if (targetArg && matchedDocs.length === 0) {
      console.error(`Markdown doc or meta ID not found: ${targetArg}`)
      return 2
    }

    const entries = matchedDocs.flatMap((d) =>
      d.headingIds.map((h) => ({
        metaId: d.metaId,
        path: d.path,
        level: `H${h.level}`,
        gfmId: `#${h.id}`,
        heading: h.text,
      })),
    )

    if (flags.json) {
      console.log(
        JSON.stringify(
          matchedDocs.map((d) => ({
            metaId: d.metaId,
            path: d.path,
            tableCount: d.tableCount,
            taskSummary: d.taskSummary,
            headingIds: d.headingIds,
          })),
          null,
          2,
        ),
      )
      return 0
    }

    printTableView({
      heading: targetArg
        ? `Listed GFM Heading Meta IDs — ${matchedDocs[0]!.metaId}`
        : "Listed GFM Heading Meta IDs Across Documentation",
      subtitle: `${entries.length} GFM heading meta ID(s) extracted via Bun.markdown.render({ headings: { ids: true } })`,
      headers: ["Doc Meta ID", "Level", "GFM Meta ID", "Heading Text", "Document"],
      alignments: ["left", "center", "left", "left", "left"],
      rows: entries.map((e) => [
        `\`${e.metaId}\``,
        e.level,
        `\`${e.gfmId}\``,
        e.heading,
        `\`${e.path}\``,
      ]),
      inspectRows: entries,
      inspectColumns: ["metaId", "level", "gfmId", "heading", "path"],
      flags,
    })
    return 0
  }

  if (action === "render") {
    const audit = auditMarkdownDocs(ROOT_DIR)
    const targetArg = flags.positional[1] ?? "dashboard.md"
    const docEntry = resolveDocByTarget(audit.docs, targetArg)
    const relTarget = docEntry?.path ?? targetArg
    const fullTarget = resolve(ROOT_DIR, relTarget)
    if (!fullTarget.startsWith(ROOT_DIR) || !existsSync(fullTarget)) {
      console.error(`Markdown file or SD-DOC-* meta ID not found inside workspace: ${targetArg}`)
      return 2
    }
    const rawMd = readFileSync(fullTarget, "utf8")
    const mode: BunMarkdownRenderMode = flags.explicitMode
      ? flags.mode
      : flags.profile || flags.ansi
        ? "ansi-theme"
        : "render-callbacks"

    const rendered = renderBunMarkdownStudio(rawMd, {
      mode,
      presetId: flags.preset,
      profileId: flags.profile,
      showHeadingIds: flags.ids,
      theme: resolveThemeFromFlags(flags),
    })

    if (mode === "html") {
      writeStdoutSafe(`${rendered.html}\n`)
      return 0
    }

    writeStdoutSafe(rendered.ansi)

    if (flags.ids && rendered.headingIds.length > 0) {
      const docMetaLabel = docEntry?.metaId ?? "CUSTOM-DOC"
      const idTableMd = buildGfmTableMarkdown(
        `Listed GFM Heading Meta IDs (${docMetaLabel})`,
        ["Level", "GFM Meta ID", "Section Heading"],
        ["center", "left", "left"],
        rendered.headingIds.map((h) => [`H${h.level}`, `\`#${h.id}\``, h.text]),
        `Doc: \`${relTarget}\` · Tables: ${rendered.tableCount} · Tasks: ${rendered.taskSummary.checked}/${rendered.taskSummary.total}`,
      )
      const idRendered = renderBunMarkdownStudio(idTableMd, {
        mode: flags.explicitMode && mode === "render-callbacks" ? "render-callbacks" : "ansi-theme",
        presetId: flags.preset,
        profileId: flags.profile,
        theme: resolveThemeFromFlags(flags),
      })
      writeStdoutSafe(`\n${idRendered.ansi}`)
    }
    return 0
  }

  console.error(`Unknown docs subcommand: ${action} (expected check|list|ids|render)`)
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
  const flags = parseCliFlags(subArgs)
  const action = flags.positional[0] ?? "status"
  const asJson = flags.json

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
    const subtitle = `Unified Versioning Matrix (engine: ${report.engine} · workspace: ${report.workspaceVersion ?? "unset"} · design: ${report.designVersion ?? "unset"} · bun: ${report.bunVersionPin ?? "unset"})`
    printTableView({
      heading: "Unified Versioning Matrix",
      subtitle,
      headers: ["Track", "Target", "Version", "Expected", "Status", "Source"],
      alignments: ["left", "left", "right", "right", "center", "left"],
      rows: rows.map((r) => [
        r.track,
        `\`${r.target}\``,
        `\`${r.version}\``,
        `\`${r.expected}\``,
        r.status,
        `\`${r.source}\``,
      ]),
      inspectRows: rows,
      inspectColumns: ["track", "target", "version", "expected", "status", "source"],
      flags,
    })
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
    const version = flags.positional[1]
    const range = flags.positional[2]
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
    const a = flags.positional[1]
    const b = flags.positional[2]
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
    const versions = flags.positional.slice(1)
    if (versions.length === 0) {
      console.error("Usage: bun run cli version sort [--desc] [--json] <v1> <v2> ...")
      return 2
    }
    try {
      const sorted = sortSemver(versions, flags.desc ? "desc" : "asc")
      console.log(asJson ? JSON.stringify(sorted) : sorted.join("\n"))
      return 0
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      return 2
    }
  }

  if (action === "max") {
    const [range, ...versions] = flags.positional.slice(1)
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
    const target = flags.positional[1]
    if (!target) {
      console.error(
        "Usage: bun run cli version bump <major|minor|patch|premajor|preminor|prepatch|prerelease|x.y.z> [--preid <tag>] [--dry-run] [--json]",
      )
      return 2
    }
    const res = bumpWorkspaceVersions({
      rootDir: ROOT_DIR,
      target,
      preid: flags.preid,
      dryRun: flags.dryRun,
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
      mode: flags.dryRun ? "DRY-RUN" : c.written ? "UPDATED" : "UNCHANGED",
    }))
    console.log(
      `${flags.dryRun ? "DRY-RUN" : "PASS"}: Workspace version ${res.previousVersion} -> ${res.nextVersion}`,
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
  const flags = parseCliFlags(subArgs)
  const filter = (flags.positional[0] ?? "").trim().toLowerCase()
  const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, "package.json"), "utf8")) as {
    readonly scripts?: Record<string, string>
  }
  const rows = Object.entries(pkg.scripts ?? {})
    .filter(
      ([k, v]) => !filter || k.toLowerCase().includes(filter) || v.toLowerCase().includes(filter),
    )
    .map(([name, command]) => ({ script: `bun run ${name}`, command }))
  printTableView({
    heading: "SportsDesk Unified package.json Scripts",
    subtitle: filter ? `Filter: "${filter}" (${rows.length} matches)` : `${rows.length} scripts`,
    headers: ["Script", "Command"],
    alignments: ["left", "left"],
    rows: rows.map((r) => [`\`${r.script}\``, `\`${r.command}\``]),
    inspectRows: rows,
    inspectColumns: ["script", "command"],
    flags,
  })
  return 0
}

export function runSportsdeskCli(argv: readonly string[]): number {
  const [command = "help", ...rest] = argv
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp(rest)
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
