/**
 * @file scripts/gen_artifacts.ts
 * @description Deterministic Bun artifact generator & drift gate for SportsDesk Ops Dashboard:
 *  1. Compiles `design/tokens.toml` -> `packages/ui/src/tokens.registry.generated.ts`
 *     and `src/dashboard/tokens.generated.css` (zero drift).
 *  2. Verifies SHA-256 & byte-size integrity of all pipeline diagram artifacts in
 *     `docs/assets/pipeline-artifacts-metadata.json`.
 *  3. Audits all repository Markdown files for broken local links and stale legacy references.
 *  4. Emits deterministic generated artifacts:
 *     - `docs/generated/artifacts-manifest.json`
 *     - `docs/generated/ARTIFACTS_AND_CLI.md`
 *
 * Usage:
 *   bun scripts/gen_artifacts.ts                 # regenerate all artifacts
 *   bun scripts/gen_artifacts.ts --check         # fail non-zero on drift or broken links
 *   bun scripts/gen_artifacts.ts --tokens-only   # regenerate token artifacts only
 *   bun scripts/gen_artifacts.ts --tokens-only --check
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { parse as parseTomlFallback } from "smol-toml"

export interface CanonicalTokenEntry {
  readonly token: string
  readonly hex: string
  readonly group: "surfaces" | "ui" | "sla" | "ingestion" | "routes"
}

export interface TokenAliasEntry {
  readonly alias: string
  readonly target: string
  readonly scope: "legacy" | "dashboard"
}

export interface CasStateEntry {
  readonly tokenName: string
  readonly fgHex: string
  readonly bgHex: string
  readonly borderHex: string
  readonly glyph: string
}

export interface ParsedDesignTokens {
  readonly version: string
  readonly canonicalTokens: readonly CanonicalTokenEntry[]
  readonly aliases: readonly TokenAliasEntry[]
  readonly accessibilityAliases: Readonly<Record<string, string>>
  readonly layout: Readonly<Record<string, number>>
  readonly motion: Readonly<Record<string, number>>
  readonly casStates: readonly CasStateEntry[]
  readonly rootOptionDeclarations: readonly string[]
}

export interface PipelineArtifactVerification {
  readonly id: string
  readonly slug: string
  readonly filesChecked: number
  readonly ok: boolean
  readonly issues: readonly string[]
  readonly sha256ByExt: Readonly<Record<string, string>>
}

export interface MarkdownDocAuditEntry {
  readonly path: string
  readonly title: string
  readonly lines: number
  readonly bytes: number
  readonly sha256: string
  readonly localLinksChecked: number
  readonly brokenLinks: readonly string[]
  readonly staleReferences: readonly string[]
}

export interface GeneratedArtifactRecord {
  readonly path: string
  readonly role: string
  readonly source: string
  readonly bytes: number
  readonly sha256: string
}

export interface ArtifactsManifest {
  readonly schemaVersion: "1.0.0"
  readonly bunVersionPin: string
  readonly tokensVersion: string
  readonly cliEntrypoint: "bun run cli"
  readonly tokenSummary: {
    readonly canonicalCount: number
    readonly aliasCount: number
    readonly casStateCount: number
  }
  readonly generatedArtifacts: readonly GeneratedArtifactRecord[]
  readonly pipelineDiagrams: {
    readonly catalogPath: string
    readonly totalArtifacts: number
    readonly verifiedFiles: number
    readonly entries: readonly {
      readonly id: string
      readonly slug: string
      readonly svgSha256: string
      readonly pngSha256: string
      readonly webpSha256: string
    }[]
  }
  readonly markdownDocs: readonly {
    readonly path: string
    readonly title: string
    readonly lines: number
    readonly bytes: number
    readonly sha256: string
    readonly localLinksChecked: number
  }[]
  readonly cliCommands: readonly {
    readonly command: string
    readonly description: string
  }[]
  readonly packageScripts: Readonly<Record<string, string>>
}

export interface ArtifactPipelineResult {
  readonly ok: boolean
  readonly mode: "generate" | "check"
  readonly tokensOnly: boolean
  readonly writtenFiles: readonly string[]
  readonly driftedFiles: readonly string[]
  readonly pipelineIssues: readonly string[]
  readonly markdownIssues: readonly string[]
  readonly manifest?: ArtifactsManifest | undefined
}

export const UNIFIED_CLI_COMMANDS: readonly {
  readonly command: string
  readonly description: string
}[] = [
  {
    command: "bun run cli help",
    description: "Display unified Bun CLI command reference and pinned runtime version",
  },
  {
    command: "bun run cli artifacts generate",
    description:
      "Compile design/tokens.toml and regenerate docs/generated/artifacts-manifest.json + ARTIFACTS_AND_CLI.md",
  },
  {
    command: "bun run cli artifacts check",
    description:
      "Fail-closed drift gate for generated token outputs, pipeline asset hashes, and generated artifact docs",
  },
  {
    command: "bun run cli docs check",
    description:
      "Verify zero broken local links and zero stale legacy references across all .md files",
  },
  {
    command: "bun run cli docs list",
    description: "List all tracked repository Markdown documents with line counts and link status",
  },
  {
    command: "bun run cli docs render <file>",
    description:
      "Render a Markdown file via Bun.markdown.render() / Bun.markdown.ansi(AnsiTheme) in the terminal",
  },
  {
    command: "bun run cli surface [--kinds|--deep|--json]",
    description:
      "Run read-only live Bun Runtime Surface audit (Bun.* kinds, bun:* modules, namespaces, classes)",
  },
  {
    command: "bun run cli check [gate|all]",
    description:
      "Execute repository integrity gates under Bun (lockfile, route-surface, bundle-hygiene, shell-boundary, snapshots, artifacts, docs)",
  },
  {
    command: "bun run cli scripts [filter]",
    description: "Inspect grouped package.json scripts using Bun.inspect.table",
  },
]

const STALE_DOC_RULES: readonly { readonly label: string; readonly regex: RegExp }[] = [
  { label: "removed collector entrypoint `./bin/dx`", regex: /\.\/bin\/dx\b/ },
  { label: "nonexistent `AGENTS.md` reference", regex: /\bAGENTS\.md\b/ },
  { label: "nonexistent `ROOT_LAYOUT.md` reference", regex: /\bROOT_LAYOUT\.md\b/ },
  { label: "nonexistent `docs/runbooks/` path", regex: /docs\/runbooks\// },
  { label: "nonexistent `docs/architecture/` path", regex: /docs\/architecture\// },
  {
    label: "nonexistent `sportsdesk_webview_server.ts` daemon reference",
    regex: /\bsportsdesk_webview_server\.ts\b/,
  },
  {
    label: "nonexistent `cli/sportsdesk_cli.ts` path (moved to `scripts/sportsdesk_cli.ts`)",
    regex: /\bcli\/sportsdesk_cli\.ts\b/,
  },
  {
    label: "nonexistent `lib/gen_tokens/emission_targets.ts` path",
    regex: /lib\/gen_tokens\/emission_targets\.ts/,
  },
  {
    label: "non-Bun `node --input-type=module` one-liner",
    regex: /node --input-type=module/,
  },
]

function sha256Hex(content: string | Uint8Array): string {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    | {
        readonly CryptoHasher?: new (alg: string) => {
          update(data: string | Uint8Array): unknown
          digest(enc: "hex"): string
        }
      }
    | undefined
  if (typeof bunObj?.CryptoHasher === "function") {
    const h = new bunObj.CryptoHasher("sha256")
    h.update(content)
    return h.digest("hex")
  }
  return createHash("sha256").update(content).digest("hex")
}

function parseTomlDocument(raw: string): Record<string, unknown> {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    { readonly TOML?: { readonly parse?: (input: string) => unknown } } | undefined
  if (typeof bunObj?.TOML?.parse === "function") {
    return bunObj.TOML.parse(raw) as Record<string, unknown>
  }
  return parseTomlFallback(raw) as Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/**
 * Parses `design/tokens.toml` and validates canonical tokens, aliases, layout/motion
 * constants, and CAS state slots.
 */
export function parseDesignTokensToml(rootDir: string): ParsedDesignTokens {
  const tomlPath = resolve(rootDir, "design/tokens.toml")
  const raw = readFileSync(tomlPath, "utf8")
  const doc = parseTomlDocument(raw)

  const meta = asRecord(doc.meta)
  const version = asString(meta.version) || "1.5.0"

  const canonicalTokens: CanonicalTokenEntry[] = []
  const canonicalNames = new Set<string>()
  const pushToken = (token: string, hex: string, group: CanonicalTokenEntry["group"]): void => {
    if (!token || !hex) {
      throw new Error(`Invalid token definition in design/tokens.toml (${group}): ${token}`)
    }
    if (canonicalNames.has(token)) {
      throw new Error(`Duplicate canonical token in design/tokens.toml: ${token}`)
    }
    canonicalNames.add(token)
    canonicalTokens.push({ token, hex, group })
  }

  for (const entry of Object.values(asRecord(doc.surfaces))) {
    const rec = asRecord(entry)
    pushToken(asString(rec.token_name), asString(rec.hex), "surfaces")
  }
  for (const entry of Object.values(asRecord(doc.ui))) {
    const rec = asRecord(entry)
    pushToken(asString(rec.token_name), asString(rec.hex), "ui")
  }
  for (const entry of Object.values(asRecord(doc.sla))) {
    const rec = asRecord(entry)
    const base = asString(rec.token_name)
    pushToken(base, asString(rec.fg_hex), "sla")
    pushToken(`${base}-bg`, asString(rec.bg_hex), "sla")
    pushToken(`${base}-border`, asString(rec.border_hex), "sla")
  }

  const requiredLegacyAliases: { readonly alias: string; readonly target: string }[] = []
  for (const entry of Object.values(asRecord(doc.ingestion))) {
    const rec = asRecord(entry)
    const tokenName = asString(rec.token_name)
    pushToken(tokenName, asString(rec.hex), "ingestion")
    const legacyName = asString(rec.legacy_token_name)
    if (legacyName) {
      requiredLegacyAliases.push({ alias: legacyName, target: tokenName })
    }
  }
  for (const entry of Object.values(asRecord(doc.routes))) {
    const rec = asRecord(entry)
    pushToken(asString(rec.token_name), asString(rec.hex), "routes")
  }

  const aliasesSec = asRecord(doc.aliases)
  const legacyMap = asRecord(aliasesSec.legacy)
  const dashboardMap = asRecord(aliasesSec.dashboard)
  const accessibilityMap = asRecord(aliasesSec.accessibility)

  const aliases: TokenAliasEntry[] = []
  const seenAliases = new Set<string>()
  const addAlias = (alias: string, target: string, scope: TokenAliasEntry["scope"]): void => {
    if (!canonicalNames.has(target)) {
      throw new Error(`Alias ${alias} targets unknown canonical token ${target}`)
    }
    if (canonicalNames.has(alias)) {
      throw new Error(`Alias ${alias} shadows a canonical token`)
    }
    if (seenAliases.has(alias)) {
      throw new Error(`Duplicate alias ${alias} in design/tokens.toml`)
    }
    seenAliases.add(alias)
    aliases.push({ alias, target, scope })
  }

  for (const [alias, target] of Object.entries(legacyMap)) {
    addAlias(alias, asString(target), "legacy")
  }
  for (const req of requiredLegacyAliases) {
    if (asString(legacyMap[req.alias]) !== req.target) {
      throw new Error(
        `Missing or mismatched [aliases.legacy] entry for ${req.alias} -> ${req.target}`,
      )
    }
  }
  for (const [alias, target] of Object.entries(dashboardMap)) {
    addAlias(alias, asString(target), "dashboard")
  }

  const accessibilityAliases: Record<string, string> = {}
  for (const [alias, target] of Object.entries(accessibilityMap)) {
    const targetStr = asString(target)
    if (!canonicalNames.has(targetStr)) {
      throw new Error(`Accessibility alias ${alias} targets unknown canonical token ${targetStr}`)
    }
    accessibilityAliases[alias] = targetStr
  }

  const layoutRaw = asRecord(doc.layout)
  const layout: Record<string, number> = {}
  for (const [k, v] of Object.entries(layoutRaw)) {
    layout[k] = asNumber(v)
  }

  const motionRaw = asRecord(doc.motion)
  const motion: Record<string, number> = {}
  for (const [k, v] of Object.entries(motionRaw)) {
    motion[k] = asNumber(v)
  }

  const casStates: CasStateEntry[] = []
  for (const entry of Object.values(asRecord(doc.cas_states))) {
    const rec = asRecord(entry)
    casStates.push({
      tokenName: asString(rec.token_name),
      fgHex: asString(rec.fg_hex),
      bgHex: asString(rec.bg_hex),
      borderHex: asString(rec.border_hex),
      glyph: asString(rec.glyph),
    })
  }

  const rootOptionDeclarations: string[] = [
    `  --sd-layout-grid-unit: ${layout.grid_unit_px ?? 4}px;`,
    `  --sd-layout-card-padding: ${layout.card_padding_px ?? 12}px;`,
    `  --sd-layout-row-height-compact: ${layout.row_height_compact_px ?? 28}px;`,
    `  --sd-layout-row-height-comfortable: ${layout.row_height_comfortable_px ?? 36}px;`,
    `  --sd-layout-border-hairline-width: ${layout.border_hairline_px ?? 1}px;`,
    `  --sd-layout-border-interactive-width: ${layout.border_interactive_px ?? 1}px;`,
    `  --sd-layout-focus-ring-width: ${layout.focus_ring_width_px ?? 2}px;`,
    `  --sd-layout-focus-ring-offset: ${layout.focus_ring_offset_px ?? 2}px;`,
    `  --sd-layout-radius-badge: ${layout.radius_badge_px ?? 4}px;`,
    `  --sd-layout-radius-card: ${layout.radius_card_px ?? 6}px;`,
    `  --sd-layout-radius-modal: ${layout.radius_modal_px ?? 8}px;`,
    `  --sd-motion-aria-live-coalesce: ${motion.aria_live_coalesce_ms ?? 500}ms;`,
    `  --sd-motion-tooltip-delay: ${motion.tooltip_delay_ms ?? 250}ms;`,
    `  --sd-motion-drawer-transition: ${motion.drawer_transition_ms ?? 140}ms;`,
    `  --sd-motion-pulse-critical-period: ${motion.pulse_critical_period_ms ?? 1600}ms;`,
  ]
  for (const cas of casStates) {
    rootOptionDeclarations.push(`  ${cas.tokenName}: ${cas.fgHex};`)
    rootOptionDeclarations.push(`  ${cas.tokenName}-bg: ${cas.bgHex};`)
    rootOptionDeclarations.push(`  ${cas.tokenName}-border: ${cas.borderHex};`)
    rootOptionDeclarations.push(`  ${cas.tokenName}-glyph: "${cas.glyph}";`)
  }

  return {
    version,
    canonicalTokens,
    aliases,
    accessibilityAliases,
    layout,
    motion,
    casStates,
    rootOptionDeclarations,
  }
}

function formatAliasObjectLine(entry: TokenAliasEntry): string {
  const oneLine = `  { alias: "${entry.alias}", target: "${entry.target}", scope: "${entry.scope}" },`
  if (oneLine.length <= 100) return oneLine
  return [
    "  {",
    `    alias: "${entry.alias}",`,
    `    target: "${entry.target}",`,
    `    scope: "${entry.scope}",`,
    "  },",
  ].join("\n")
}

function formatDeclarationLiteral(decl: string): string {
  return decl.includes('"') ? `  '${decl}',` : `  "${decl}",`
}

/**
 * Emits `packages/ui/src/tokens.registry.generated.ts` matching `bun fmt` (printWidth=100, semi=false).
 */
export function emitTokensRegistryTs(parsed: ParsedDesignTokens): string {
  const canonicalLines = parsed.canonicalTokens.map(
    (t) => `  { token: "${t.token}", hex: "${t.hex}", group: "${t.group}" },`,
  )
  const aliasLines = parsed.aliases.map(formatAliasObjectLine)
  const optionLines = parsed.rootOptionDeclarations.map(formatDeclarationLiteral)

  return `/**
 * @file packages/ui/src/tokens.registry.generated.ts
 * @description Generated from design/tokens.toml (v${parsed.version}) via \`bun run gen:tokens\`.
 * DO NOT EDIT BY HAND — enforced by \`bun run gen:tokens:gate\`.
 */

/** tokens.toml SSOT version this module was generated from. */
export const TOKENS_TOML_VERSION = "${parsed.version}" as const

export type GeneratedTokenGroup = "surfaces" | "ui" | "sla" | "ingestion" | "routes"

export interface GeneratedToken {
  /** \`--sd-*\` custom property name. */
  readonly token: string
  /** Canonical value emitted into both \`@property\` and \`:root\`. */
  readonly hex: string
  /** Emitting section; the palette groups by this. */
  readonly group: GeneratedTokenGroup
}

export interface GeneratedAlias {
  /** Alias emitted into \`:root\` as \`<alias>: var(<target>)\`. */
  readonly alias: string
  /** Canonical token the alias resolves to. */
  readonly target: string
  /** \`legacy\` ships in every stylesheet; \`dashboard\` only in the dashboard CSS. */
  readonly scope: "legacy" | "dashboard"
}

/** Canonical tokens in \`:root\` emission order. */
export const CANONICAL_TOKENS: readonly GeneratedToken[] = [
${canonicalLines.join("\n")}
]

/** \`:root\` aliases in emission order (legacy first, then dashboard). */
export const TOKEN_ALIASES: readonly GeneratedAlias[] = [
${aliasLines.join("\n")}
]

/** Untyped \`:root\` declarations for [layout], [motion] and [cas_states]. */
export const ROOT_OPTION_DECLARATIONS: readonly string[] = [
${optionLines.join("\n")}
]
`
}

/**
 * Emits `src/dashboard/tokens.generated.css` matching the exact Houdini `@property`
 * and `:root` emission order.
 */
export function emitTokensGeneratedCss(parsed: ParsedDesignTokens): string {
  const canonicalProps = parsed.canonicalTokens
    .map(
      (t) =>
        `@property ${t.token} {\n  syntax: "<color>";\n  inherits: true;\n  initial-value: ${t.hex};\n}`,
    )
    .join("\n\n")

  const casProps = parsed.casStates
    .flatMap((cas) => [
      `@property ${cas.tokenName} {\n  syntax: "<color>";\n  inherits: true;\n  initial-value: ${cas.fgHex};\n}`,
      `@property ${cas.tokenName}-bg {\n  syntax: "<color>";\n  inherits: true;\n  initial-value: ${cas.bgHex};\n}`,
      `@property ${cas.tokenName}-border {\n  syntax: "<color>";\n  inherits: true;\n  initial-value: ${cas.borderHex};\n}`,
    ])
    .join("\n")

  const canonicalRoot = parsed.canonicalTokens.map((t) => `  ${t.token}: ${t.hex};`).join("\n")
  const legacyRoot = parsed.aliases
    .filter((a) => a.scope === "legacy")
    .map((a) => `  ${a.alias}: var(${a.target});`)
    .join("\n")
  const dashboardRoot = parsed.aliases
    .filter((a) => a.scope === "dashboard")
    .map((a) => `  ${a.alias}: var(${a.target});`)
    .join("\n")
  const optionsRoot = parsed.rootOptionDeclarations.join("\n")
  const a11yRoot = Object.entries(parsed.accessibilityAliases)
    .map(([alias, target]) => `    ${alias}: var(${target});`)
    .join("\n")

  return `/**
 * @file src/dashboard/tokens.generated.css
 * @description Generated from design/tokens.toml (v${parsed.version}) via \`bun run gen:tokens\`.
 * DO NOT EDIT BY HAND — enforced by \`bun run gen:tokens:gate\`.
 */

/* ==========================================================================
   1. CSS Houdini @property Declarations (Generated from tokens.toml)
   Enforces specification-grade design tokens and prevents silent property drop.
   ========================================================================== */
${canonicalProps}

${casProps}

/* ==========================================================================
   2. Canonical :root Custom Properties & Semantic Surface Aliases
   ========================================================================== */
:root {
  color-scheme: dark;
  /* Generated from tokens.toml (v${parsed.version}) */
${canonicalRoot}
${legacyRoot}

  /* Semantic dashboard aliases mapped to canonical tokens.toml variables */
${dashboardRoot}
${optionsRoot}
}

/* Accessibility: prefers-contrast alias overrides (aliases.accessibility) */
@media (prefers-contrast: more) {
  :root {
${a11yRoot}
  }
}
`
}

/**
 * Verifies every `.svg`/`.png`/`.webp` listed in `docs/assets/pipeline-artifacts-metadata.json`
 * matches on-disk byte size and SHA-256 hash.
 */
export function auditPipelineArtifactsMetadata(rootDir: string): {
  readonly catalogPath: string
  readonly totalArtifacts: number
  readonly verifiedFiles: number
  readonly results: readonly PipelineArtifactVerification[]
  readonly issues: readonly string[]
} {
  const catalogPath = "docs/assets/pipeline-artifacts-metadata.json"
  const fullCatalog = resolve(rootDir, catalogPath)
  if (!existsSync(fullCatalog)) {
    return {
      catalogPath,
      totalArtifacts: 0,
      verifiedFiles: 0,
      results: [],
      issues: [`Missing pipeline artifact metadata catalog: ${catalogPath}`],
    }
  }

  const parsed = JSON.parse(readFileSync(fullCatalog, "utf8")) as {
    readonly artifacts?: readonly {
      readonly id: string
      readonly slug: string
      readonly files: Record<string, unknown>
    }[]
  }
  const artifacts = parsed.artifacts ?? []
  const results: PipelineArtifactVerification[] = []
  const issues: string[] = []
  let verifiedFiles = 0

  for (const artifact of artifacts) {
    const itemIssues: string[] = []
    const sha256ByExt: Record<string, string> = {}
    let checked = 0

    for (const ext of ["svg", "png", "webp"] as const) {
      const repoPath = asString(artifact.files[`${ext}RepoPath`])
      const expectedBytes = asNumber(artifact.files[`${ext}Bytes`])
      const expectedSha = asString(artifact.files[`${ext}Sha256`])
      const fullPath = resolve(rootDir, repoPath)
      checked += 1

      if (!repoPath || !existsSync(fullPath)) {
        const msg = `${artifact.slug}: missing ${ext} file at ${repoPath || "<empty>"}`
        itemIssues.push(msg)
        issues.push(msg)
        continue
      }

      const bytes = readFileSync(fullPath)
      const actualSha = sha256Hex(bytes)
      sha256ByExt[ext] = actualSha

      if (bytes.byteLength !== expectedBytes) {
        const msg = `${repoPath}: byte size drift (actual=${bytes.byteLength}, catalog=${expectedBytes})`
        itemIssues.push(msg)
        issues.push(msg)
      }
      if (actualSha !== expectedSha) {
        const msg = `${repoPath}: SHA-256 drift (actual=${actualSha.slice(0, 12)}, catalog=${expectedSha.slice(0, 12)})`
        itemIssues.push(msg)
        issues.push(msg)
      }
      if (bytes.byteLength === expectedBytes && actualSha === expectedSha) {
        verifiedFiles += 1
      }
    }

    results.push({
      id: artifact.id,
      slug: artifact.slug,
      filesChecked: checked,
      ok: itemIssues.length === 0,
      issues: itemIssues,
      sha256ByExt,
    })
  }

  return {
    catalogPath,
    totalArtifacts: artifacts.length,
    verifiedFiles,
    results,
    issues,
  }
}

function discoverMarkdownFiles(rootDir: string): string[] {
  const out: string[] = []
  const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    ".aistudio",
    ".wrangler",
    ".local",
    ".ci",
    "tools",
  ])

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      const st = statSync(full)
      if (st.isDirectory()) {
        walk(full)
      } else if (entry.toLowerCase().endsWith(".md")) {
        out.push(relative(rootDir, full).replace(/\\/g, "/"))
      }
    }
  }

  walk(rootDir)
  return out.sort((a, b) => a.localeCompare(b))
}

function extractFirstHeading(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown)
  return match ? match[1]!.trim() : fallback
}

/**
 * Audits all repository Markdown files for broken local links and stale collector-only references.
 */
export function auditMarkdownDocs(
  rootDir: string,
  options?: { readonly excludePaths?: readonly string[] | undefined },
): {
  readonly docs: readonly MarkdownDocAuditEntry[]
  readonly issues: readonly string[]
} {
  const excluded = new Set(options?.excludePaths ?? [])
  const mdFiles = discoverMarkdownFiles(rootDir).filter((p) => !excluded.has(p))
  const docs: MarkdownDocAuditEntry[] = []
  const issues: string[] = []

  for (const relPath of mdFiles) {
    const fullPath = resolve(rootDir, relPath)
    const content = readFileSync(fullPath, "utf8")
    const lines = content.split(/\r?\n/).length
    const bytes = Buffer.byteLength(content, "utf8")
    const sha256 = sha256Hex(content)
    const title = extractFirstHeading(content, relPath)

    // Strip fenced code blocks when checking markdown links
    const withoutFences = content.replace(/```[\s\S]*?```/g, "")
    const linkMatches = [...withoutFences.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)]
    let localLinksChecked = 0
    const brokenLinks: string[] = []

    for (const m of linkMatches) {
      const rawTarget = (m[1] ?? "").trim().replace(/^<|>$/g, "")
      if (
        !rawTarget ||
        rawTarget.startsWith("http://") ||
        rawTarget.startsWith("https://") ||
        rawTarget.startsWith("mailto:") ||
        rawTarget.startsWith("#") ||
        rawTarget.startsWith("/agent/") ||
        rawTarget.startsWith("/api/")
      ) {
        continue
      }
      const cleanPath = rawTarget.split("#")[0]?.split("?")[0] ?? ""
      if (!cleanPath) continue
      localLinksChecked += 1

      const baseDir = dirname(fullPath)
      const candidates = cleanPath.startsWith("/")
        ? [resolve(rootDir, cleanPath.slice(1))]
        : [resolve(baseDir, cleanPath), resolve(rootDir, cleanPath)]

      if (!candidates.some((c) => existsSync(c))) {
        brokenLinks.push(rawTarget)
        issues.push(`${relPath}: broken local link -> ${rawTarget}`)
      }
    }

    const staleReferences: string[] = []
    for (const rule of STALE_DOC_RULES) {
      if (rule.regex.test(content)) {
        staleReferences.push(rule.label)
        issues.push(`${relPath}: stale reference (${rule.label})`)
      }
    }

    docs.push({
      path: relPath,
      title,
      lines,
      bytes,
      sha256,
      localLinksChecked,
      brokenLinks,
      staleReferences,
    })
  }

  return { docs, issues }
}

/**
 * Renders deterministic `docs/generated/ARTIFACTS_AND_CLI.md` from the manifest.
 */
export function emitArtifactsAndCliMarkdown(manifest: ArtifactsManifest): string {
  const artifactRows = manifest.generatedArtifacts
    .map(
      (a) =>
        `| \`${a.path}\` | ${a.role} | \`${a.source}\` | ${a.bytes.toLocaleString("en-US")} B | \`${a.sha256.slice(0, 12)}\` |`,
    )
    .join("\n")

  const diagramRows = manifest.pipelineDiagrams.entries
    .map(
      (d) =>
        `| \`${d.id}\` | \`${d.slug}\` | \`${d.svgSha256.slice(0, 12)}\` | \`${d.pngSha256.slice(0, 12)}\` | \`${d.webpSha256.slice(0, 12)}\` |`,
    )
    .join("\n")

  const docRows = manifest.markdownDocs
    .map(
      (d) =>
        `| [\`${d.path}\`](../../${d.path}) | ${d.title.replace(/\|/g, "\\|")} | ${d.lines} | ${d.localLinksChecked} | \`${d.sha256.slice(0, 12)}\` |`,
    )
    .join("\n")

  const cliRows = manifest.cliCommands
    .map((c) => `| \`${c.command}\` | ${c.description} |`)
    .join("\n")

  const scriptRows = Object.entries(manifest.packageScripts)
    .map(([name, cmd]) => `| \`bun run ${name}\` | \`${cmd.replace(/\|/g, "\\|")}\` |`)
    .join("\n")

  return `# SportsDesk Ops — Generated Artifacts & Unified Bun CLI

> **Generated file — do not edit by hand.**
> Regenerate with \`bun run artifacts:generate\` · Verify zero drift with \`bun run artifacts:check\`
> Pinned runtime: **Bun ${manifest.bunVersionPin}** · Design tokens SSOT: **\`design/tokens.toml\` v${manifest.tokensVersion}** (${manifest.tokenSummary.canonicalCount} canonical tokens, ${manifest.tokenSummary.aliasCount} aliases, ${manifest.tokenSummary.casStateCount} CAS states)

## Unified Bun CLI (\`${manifest.cliEntrypoint}\`)

| Command | Purpose |
| :------ | :------ |
${cliRows}

## Generated & Managed Artifacts

| Artifact Path | Role | Source | Size | SHA-256 (12) |
| :------------ | :--- | :----- | ---: | :----------- |
${artifactRows}

## Pipeline Diagram Integrity (\`${manifest.pipelineDiagrams.catalogPath}\`)

Verified **${manifest.pipelineDiagrams.verifiedFiles}** raster/vector assets across **${manifest.pipelineDiagrams.totalArtifacts}** pipeline diagrams:

| Artifact ID | Slug | SVG SHA-256 | PNG SHA-256 | WebP SHA-256 |
| :---------- | :--- | :---------- | :---------- | :----------- |
${diagramRows}

## Verified Markdown Documentation Inventory

Every local link across all **${manifest.markdownDocs.length}** tracked Markdown documents is checked by \`bun run docs:check\`:

| Document | Title | Lines | Local Links | SHA-256 (12) |
| :------- | :---- | ----: | ----------: | :----------- |
${docRows}

## Unified \`package.json\` Scripts

| Script | Command |
| :----- | :------ |
${scriptRows}
`
}

function syncFile(
  rootDir: string,
  relPath: string,
  expectedContent: string,
  checkOnly: boolean,
  writtenFiles: string[],
  driftedFiles: string[],
): void {
  const fullPath = resolve(rootDir, relPath)
  const existing = existsSync(fullPath) ? readFileSync(fullPath, "utf8") : null
  if (existing === expectedContent) return

  if (checkOnly) {
    driftedFiles.push(relPath)
    return
  }

  mkdirSync(dirname(fullPath), { recursive: true })
  writeFileSync(fullPath, expectedContent, "utf8")
  writtenFiles.push(relPath)
}

/**
 * Runs the unified artifact generator or drift-check gate.
 */
export function runArtifactPipeline(options: {
  readonly rootDir?: string | undefined
  readonly check?: boolean | undefined
  readonly tokensOnly?: boolean | undefined
}): ArtifactPipelineResult {
  const rootDir = options.rootDir ?? process.cwd()
  const check = Boolean(options.check)
  const tokensOnly = Boolean(options.tokensOnly)

  const writtenFiles: string[] = []
  const driftedFiles: string[] = []

  // 1. Compile design/tokens.toml -> TS registry & CSS Houdini stylesheet
  const parsedTokens = parseDesignTokensToml(rootDir)
  const tokensTsPath = "packages/ui/src/tokens.registry.generated.ts"
  const tokensCssPath = "src/dashboard/tokens.generated.css"
  const tokensTsContent = emitTokensRegistryTs(parsedTokens)
  const tokensCssContent = emitTokensGeneratedCss(parsedTokens)

  syncFile(rootDir, tokensTsPath, tokensTsContent, check, writtenFiles, driftedFiles)
  syncFile(rootDir, tokensCssPath, tokensCssContent, check, writtenFiles, driftedFiles)

  if (tokensOnly) {
    return {
      ok: driftedFiles.length === 0,
      mode: check ? "check" : "generate",
      tokensOnly: true,
      writtenFiles,
      driftedFiles,
      pipelineIssues: [],
      markdownIssues: [],
    }
  }

  // 2. Verify pipeline diagram hashes
  const pipelineAudit = auditPipelineArtifactsMetadata(rootDir)

  // 3. Audit all non-generated Markdown docs first (so manifest hashes reflect authoritative docs)
  const generatedDocPath = "docs/generated/ARTIFACTS_AND_CLI.md"
  const generatedManifestPath = "docs/generated/artifacts-manifest.json"
  const mdAudit = auditMarkdownDocs(rootDir, { excludePaths: [generatedDocPath] })

  const bunVersionPin = existsSync(resolve(rootDir, ".bun-version"))
    ? readFileSync(resolve(rootDir, ".bun-version"), "utf8").trim()
    : "1.4.4"
  const pkgJson = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")) as {
    readonly scripts?: Record<string, string>
  }

  const brandedTypesPath = "design/domain-branded-types.ts"
  const brandedTypesContent = existsSync(resolve(rootDir, brandedTypesPath))
    ? readFileSync(resolve(rootDir, brandedTypesPath), "utf8")
    : ""

  const generatedArtifacts: GeneratedArtifactRecord[] = [
    {
      path: tokensTsPath,
      role: "Generated TypeScript design token registry & aliases",
      source: "design/tokens.toml",
      bytes: Buffer.byteLength(tokensTsContent, "utf8"),
      sha256: sha256Hex(tokensTsContent),
    },
    {
      path: tokensCssPath,
      role: "Generated CSS Houdini @property + :root token stylesheet",
      source: "design/tokens.toml",
      bytes: Buffer.byteLength(tokensCssContent, "utf8"),
      sha256: sha256Hex(tokensCssContent),
    },
    {
      path: brandedTypesPath,
      role: "Nominal branded primitives & neuron registry contracts",
      source: "design/tokens.toml",
      bytes: Buffer.byteLength(brandedTypesContent, "utf8"),
      sha256: sha256Hex(brandedTypesContent),
    },
  ]

  const manifest: ArtifactsManifest = {
    schemaVersion: "1.0.0",
    bunVersionPin,
    tokensVersion: parsedTokens.version,
    cliEntrypoint: "bun run cli",
    tokenSummary: {
      canonicalCount: parsedTokens.canonicalTokens.length,
      aliasCount: parsedTokens.aliases.length,
      casStateCount: parsedTokens.casStates.length,
    },
    generatedArtifacts,
    pipelineDiagrams: {
      catalogPath: pipelineAudit.catalogPath,
      totalArtifacts: pipelineAudit.totalArtifacts,
      verifiedFiles: pipelineAudit.verifiedFiles,
      entries: pipelineAudit.results.map((r) => ({
        id: r.id,
        slug: r.slug,
        svgSha256: r.sha256ByExt.svg ?? "",
        pngSha256: r.sha256ByExt.png ?? "",
        webpSha256: r.sha256ByExt.webp ?? "",
      })),
    },
    markdownDocs: mdAudit.docs.map((d) => ({
      path: d.path,
      title: d.title,
      lines: d.lines,
      bytes: d.bytes,
      sha256: d.sha256,
      localLinksChecked: d.localLinksChecked,
    })),
    cliCommands: UNIFIED_CLI_COMMANDS,
    packageScripts: pkgJson.scripts ?? {},
  }

  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`
  const generatedDocContent = emitArtifactsAndCliMarkdown(manifest)

  syncFile(rootDir, generatedManifestPath, manifestContent, check, writtenFiles, driftedFiles)
  syncFile(rootDir, generatedDocPath, generatedDocContent, check, writtenFiles, driftedFiles)

  // Audit all Markdown docs (including freshly generated docs/generated/ARTIFACTS_AND_CLI.md)
  // against actual on-disk files now that generated artifacts have been synced.
  const finalMdAudit = auditMarkdownDocs(rootDir)
  const allMarkdownIssues = finalMdAudit.issues

  return {
    ok:
      driftedFiles.length === 0 &&
      pipelineAudit.issues.length === 0 &&
      allMarkdownIssues.length === 0,
    mode: check ? "check" : "generate",
    tokensOnly: false,
    writtenFiles,
    driftedFiles,
    pipelineIssues: pipelineAudit.issues,
    markdownIssues: allMarkdownIssues,
    manifest,
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]).endsWith("gen_artifacts.ts")

if (isMain) {
  const args = new Set(process.argv.slice(2))
  const check = args.has("--check") || args.has("--gate")
  const tokensOnly = args.has("--tokens-only")
  const result = runArtifactPipeline({ check, tokensOnly })

  if (!result.ok) {
    console.error(`FAIL: Artifact ${result.mode} detected issues:`)
    for (const f of result.driftedFiles) {
      console.error(`  - [DRIFT] ${f} is out of date — run \`bun run artifacts:generate\``)
    }
    for (const p of result.pipelineIssues) {
      console.error(`  - [PIPELINE] ${p}`)
    }
    for (const m of result.markdownIssues) {
      console.error(`  - [DOCS] ${m}`)
    }
    process.exit(1)
  }

  if (result.mode === "generate") {
    const label = result.writtenFiles.length > 0 ? result.writtenFiles.join(", ") : "up-to-date"
    console.log(
      `PASS: Generated artifacts synced (${result.tokensOnly ? "tokens-only" : "full"}): ${label}`,
    )
  } else {
    console.log(
      `PASS: All generated artifacts, design/tokens.toml outputs, pipeline hashes, and Markdown docs verified with zero drift.`,
    )
  }
}
