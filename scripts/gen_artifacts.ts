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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { sha256Hex } from "../lib/brand.ts"
import { extractPngMetadata, extractWebpXmp } from "../lib/xmp_container.ts"

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
  readonly brandingAssets?: {
    readonly specPath: string
    readonly catalogPath: string
    readonly manifestPath: string
    readonly brandVersion: string
    readonly totalAssets: number
    readonly verifiedFiles: number
    readonly xmpVerifiedFiles: number
    readonly entries: readonly {
      readonly id: string
      readonly slug: string
      readonly repoPath: string
      readonly format: string
      readonly width: number
      readonly height: number
      readonly bytes: number
      readonly sha256: string
      readonly metadataBearing: boolean
      readonly assetRole: string
      readonly surfaceContext: string
      readonly streamId: string
    }[]
  } | undefined
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
  readonly brandingIssues?: readonly string[] | undefined
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

function parseTomlDocument(raw: string): Record<string, unknown> {
  return Bun.TOML.parse(raw) as Record<string, unknown>
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

export interface BrandingAssetSyncEntry {
  readonly id: string
  readonly slug: string
  readonly repoPath: string
  readonly format: string
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly sha256: string
  readonly metadataBearing: boolean
  readonly assetRole: string
  readonly surfaceContext: string
  readonly streamId: string
}

/**
 * Synchronously verifies every branding asset declared in
 * `public/assets/branding/branding-metadata.json` against on-disk byte sizes,
 * SHA-256 digests, `design/branding.toml`, `public/manifest.webmanifest`, and
 * embedded XMP `sportsdesk:*` + `dc:*` context packets.
 */
export function auditBrandingAssetsSync(rootDir: string): {
  readonly specPath: string
  readonly catalogPath: string
  readonly manifestPath: string
  readonly brandVersion: string
  readonly totalAssets: number
  readonly verifiedFiles: number
  readonly xmpVerifiedFiles: number
  readonly entries: readonly BrandingAssetSyncEntry[]
  readonly issues: readonly string[]
} {
  const specPath = "design/branding.toml"
  const catalogPath = "public/assets/branding/branding-metadata.json"
  const manifestPath = "public/manifest.webmanifest"
  const issues: string[] = []
  const entries: BrandingAssetSyncEntry[] = []

  if (!existsSync(resolve(rootDir, specPath))) {
    issues.push(`Missing branding spec: ${specPath}`)
  }
  if (!existsSync(resolve(rootDir, manifestPath))) {
    issues.push(`Missing web app manifest: ${manifestPath}`)
  }

  const fullCatalog = resolve(rootDir, catalogPath)
  if (!existsSync(fullCatalog)) {
    issues.push(`Missing branding metadata catalog: ${catalogPath}`)
    return {
      specPath,
      catalogPath,
      manifestPath,
      brandVersion: "unknown",
      totalAssets: 0,
      verifiedFiles: 0,
      xmpVerifiedFiles: 0,
      entries,
      issues,
    }
  }

  const parsed = JSON.parse(readFileSync(fullCatalog, "utf8")) as {
    readonly brand?: { readonly version?: string }
    readonly assets?: readonly {
      readonly id: string
      readonly slug: string
      readonly repoPath: string
      readonly format: string
      readonly width: number
      readonly height: number
      readonly bytes: number
      readonly sha256: string
      readonly metadataBearing: boolean
      readonly assetRole: string
      readonly surfaceContext: string
      readonly provenance?: { readonly streamId?: string }
    }[]
  }

  const assets = parsed.assets ?? []
  let verifiedFiles = 0
  let xmpVerifiedFiles = 0

  for (const asset of assets) {
    const fullPath = resolve(rootDir, asset.repoPath)
    const streamId = asset.provenance?.streamId ?? ""
    if (!existsSync(fullPath)) {
      issues.push(`${asset.slug}: missing branding asset at ${asset.repoPath}`)
      continue
    }

    const buf = readFileSync(fullPath)
    const actualSha = sha256Hex(buf)
    let ok = true

    if (buf.byteLength !== asset.bytes) {
      issues.push(
        `${asset.repoPath}: byte size drift (actual=${buf.byteLength}, catalog=${asset.bytes})`,
      )
      ok = false
    }
    if (actualSha !== asset.sha256) {
      issues.push(
        `${asset.repoPath}: SHA-256 drift (actual=${actualSha.slice(0, 12)}, catalog=${asset.sha256.slice(0, 12)})`,
      )
      ok = false
    }

    if (asset.metadataBearing) {
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
      const xmp =
        asset.format === "webp"
          ? extractWebpXmp(u8).xmp
          : asset.format === "png"
            ? extractPngMetadata(u8).xmp
            : null
      if (
        !xmp ||
        !xmp.includes(`<sportsdesk:streamId>${streamId}</sportsdesk:streamId>`) ||
        !xmp.includes("<sportsdesk:brand>") ||
        !xmp.includes("<dc:title>")
      ) {
        issues.push(`${asset.repoPath}: missing or incomplete embedded XMP/Dublin Core metadata`)
        ok = false
      } else {
        xmpVerifiedFiles += 1
      }
    }

    if (ok) verifiedFiles += 1

    entries.push({
      id: asset.id,
      slug: asset.slug,
      repoPath: asset.repoPath,
      format: asset.format,
      width: asset.width,
      height: asset.height,
      bytes: buf.byteLength,
      sha256: actualSha,
      metadataBearing: asset.metadataBearing,
      assetRole: asset.assetRole,
      surfaceContext: asset.surfaceContext,
      streamId,
    })
  }

  return {
    specPath,
    catalogPath,
    manifestPath,
    brandVersion: parsed.brand?.version ?? "unknown",
    totalAssets: assets.length,
    verifiedFiles,
    xmpVerifiedFiles,
    entries,
    issues,
  }
}

const SKIP_MARKDOWN_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".aistudio",
  ".wrangler",
  ".local",
  ".ci",
  "tools",
])

function isSkippedMarkdownPath(relPath: string): boolean {
  const parts = relPath.split("/")
  return parts.some((segment) => SKIP_MARKDOWN_DIRS.has(segment))
}

function discoverMarkdownFiles(rootDir: string): string[] {
  const glob = new Bun.Glob("**/*.md")
  const out: string[] = []
  for (const rel of glob.scanSync({ cwd: rootDir, dot: false })) {
    const normalized = rel.replace(/\\/g, "/")
    if (!isSkippedMarkdownPath(normalized)) {
      out.push(normalized)
    }
  }
  return out.sort((a, b) => a.localeCompare(b))
}

function extractFirstHeading(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown)
  return match ? match[1]!.trim() : fallback
}

function extractMarkdownLinksWithHtmlRewriter(markdown: string): readonly string[] {
  const html = Bun.markdown.html(markdown)
  const hrefs: string[] = []
  const rewriter = new HTMLRewriter().on("a[href]", {
    element(el) {
      const href = el.getAttribute("href")
      if (href) {
        hrefs.push(href.trim())
      }
    },
  })
  rewriter.transform(html)
  return hrefs
}

function isExternalOrVirtualHref(href: string): boolean {
  return (
    !href ||
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("mailto:") ||
    href.startsWith("#") ||
    href.startsWith("/agent/") ||
    href.startsWith("/api/")
  )
}

function resolveCandidatePaths(rootDir: string, fullDocPath: string, cleanPath: string): string[] {
  const baseDir = dirname(fullDocPath)
  return cleanPath.startsWith("/")
    ? [resolve(rootDir, cleanPath.slice(1))]
    : [resolve(baseDir, cleanPath), resolve(rootDir, cleanPath)]
}

/**
 * Audits all repository Markdown files for broken local links (via `Bun.Glob` + `HTMLRewriter`)
 * and stale collector-only references.
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

    const hrefs = extractMarkdownLinksWithHtmlRewriter(content)
    let localLinksChecked = 0
    const brokenLinks: string[] = []

    for (const rawTarget of hrefs) {
      if (isExternalOrVirtualHref(rawTarget)) {
        continue
      }
      const cleanPath = rawTarget.split("#")[0]?.split("?")[0] ?? ""
      if (!cleanPath) continue
      localLinksChecked += 1

      const candidates = resolveCandidatePaths(rootDir, fullPath, cleanPath)
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
 * Async Markdown link auditor using `Bun.Glob.scan()`, `HTMLRewriter` over `Response`,
 * and `Bun.file().exists()` for every local link target.
 */
export async function auditMarkdownDocsAsync(
  rootDir: string,
  options?: { readonly excludePaths?: readonly string[] | undefined },
): Promise<{
  readonly docs: readonly MarkdownDocAuditEntry[]
  readonly issues: readonly string[]
}> {
  const excluded = new Set(options?.excludePaths ?? [])
  const glob = new Bun.Glob("**/*.md")
  const mdFiles: string[] = []
  for await (const rel of glob.scan({ cwd: rootDir, dot: false })) {
    const normalized = rel.replace(/\\/g, "/")
    if (!isSkippedMarkdownPath(normalized) && !excluded.has(normalized)) {
      mdFiles.push(normalized)
    }
  }
  mdFiles.sort((a, b) => a.localeCompare(b))

  const docs: MarkdownDocAuditEntry[] = []
  const issues: string[] = []

  for (const relPath of mdFiles) {
    const fullPath = resolve(rootDir, relPath)
    const content = await Bun.file(fullPath).text()
    const lines = content.split(/\r?\n/).length
    const bytes = Buffer.byteLength(content, "utf8")
    const sha256 = sha256Hex(content)
    const title = extractFirstHeading(content, relPath)

    const html = Bun.markdown.html(content)
    const hrefs: string[] = []
    const rewriter = new HTMLRewriter().on("a[href]", {
      element(el) {
        const href = el.getAttribute("href")
        if (href) {
          hrefs.push(href.trim())
        }
      },
    })
    await rewriter.transform(new Response(html)).text()

    let localLinksChecked = 0
    const brokenLinks: string[] = []
    for (const rawTarget of hrefs) {
      if (isExternalOrVirtualHref(rawTarget)) {
        continue
      }
      const cleanPath = rawTarget.split("#")[0]?.split("?")[0] ?? ""
      if (!cleanPath) continue
      localLinksChecked += 1

      const candidates = resolveCandidatePaths(rootDir, fullPath, cleanPath)
      let found = false
      for (const candidate of candidates) {
        if ((await Bun.file(candidate).exists()) || existsSync(candidate)) {
          found = true
          break
        }
      }
      if (!found) {
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

function formatAlignedMarkdownTable(
  headers: readonly string[],
  alignments: readonly ("left" | "right")[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, alignments[i] === "right" ? 4 : 3, ...rows.map((r) => (r[i] ?? "").length)),
  )
  const formatRow = (cells: readonly string[], rowAligns?: readonly ("left" | "right")[]) =>
    `| ${cells
      .map((cell, i) => {
        const w = widths[i]!
        return rowAligns?.[i] === "right" ? cell.padStart(w, " ") : cell.padEnd(w, " ")
      })
      .join(" | ")} |`
  const sepRow = `| ${alignments
    .map((align, i) => {
      const w = widths[i]!
      return align === "right" ? `${"-".repeat(w - 1)}:` : `:${"-".repeat(w - 1)}`
    })
    .join(" | ")} |`
  return [
    formatRow(headers, alignments),
    sepRow,
    ...rows.map((r) => formatRow(r, alignments)),
  ].join("\n")
}

/**
 * Renders deterministic `docs/generated/ARTIFACTS_AND_CLI.md` from the manifest.
 */
export function emitArtifactsAndCliMarkdown(manifest: ArtifactsManifest): string {
  const cliTable = formatAlignedMarkdownTable(
    ["Command", "Purpose"],
    ["left", "left"],
    manifest.cliCommands.map((c) => [`\`${c.command.replace(/\|/g, "\\|")}\``, c.description]),
  )

  const artifactTable = formatAlignedMarkdownTable(
    ["Artifact Path", "Role", "Source", "Size", "SHA-256 (12)"],
    ["left", "left", "left", "right", "left"],
    manifest.generatedArtifacts.map((a) => [
      `\`${a.path}\``,
      a.role,
      `\`${a.source}\``,
      `${a.bytes.toLocaleString("en-US")} B`,
      `\`${a.sha256.slice(0, 12)}\``,
    ]),
  )

  const diagramTable = formatAlignedMarkdownTable(
    ["Artifact ID", "Slug", "SVG SHA-256", "PNG SHA-256", "WebP SHA-256"],
    ["left", "left", "left", "left", "left"],
    manifest.pipelineDiagrams.entries.map((d) => [
      `\`${d.id}\``,
      `\`${d.slug}\``,
      `\`${d.svgSha256.slice(0, 12)}\``,
      `\`${d.pngSha256.slice(0, 12)}\``,
      `\`${d.webpSha256.slice(0, 12)}\``,
    ]),
  )

  const docTable = formatAlignedMarkdownTable(
    ["Document", "Title", "Lines", "Local Links", "SHA-256 (12)"],
    ["left", "left", "right", "right", "left"],
    manifest.markdownDocs.map((d) => [
      `[\`${d.path}\`](../../${d.path})`,
      d.title.replace(/\|/g, "\\|"),
      String(d.lines),
      String(d.localLinksChecked),
      `\`${d.sha256.slice(0, 12)}\``,
    ]),
  )

  const scriptTable = formatAlignedMarkdownTable(
    ["Script", "Command"],
    ["left", "left"],
    Object.entries(manifest.packageScripts).map(([name, cmd]) => [
      `\`bun run ${name}\``,
      `\`${cmd.replace(/\|/g, "\\|")}\``,
    ]),
  )

  const brandingTable = manifest.brandingAssets
    ? formatAlignedMarkdownTable(
        ["Asset ID", "Path", "Dimensions", "Role", "XMP Context", "SHA-256 (12)"],
        ["left", "left", "right", "left", "left", "left"],
        manifest.brandingAssets.entries.map((b) => [
          `\`${b.id}\``,
          `\`${b.repoPath}\``,
          `${b.width}×${b.height} ${b.format.toUpperCase()}`,
          `\`${b.assetRole}\``,
          b.metadataBearing ? `\`${b.streamId}\`` : "crawler JPEG",
          `\`${b.sha256.slice(0, 12)}\``,
        ]),
      )
    : ""

  const brandingSection = manifest.brandingAssets
    ? `\n## Brand Identity & Metadata-Bearing Assets (\`${manifest.brandingAssets.specPath}\`)\n\nVerified **${manifest.brandingAssets.verifiedFiles}/${manifest.brandingAssets.totalAssets}** branding assets (**${manifest.brandingAssets.xmpVerifiedFiles}** stamped with Dublin Core + XMP Core + \`sportsdesk:*\` context) and \`${manifest.brandingAssets.manifestPath}\`:\n\n${brandingTable}\n`
    : ""

  return `# SportsDesk Ops — Generated Artifacts & Unified Bun CLI

> **Generated file — do not edit by hand.**
> Regenerate with \`bun run artifacts:generate\` · Verify zero drift with \`bun run artifacts:check\`
> Pinned runtime: **Bun ${manifest.bunVersionPin}** · Design tokens SSOT: **\`design/tokens.toml\` v${manifest.tokensVersion}** (${manifest.tokenSummary.canonicalCount} canonical tokens, ${manifest.tokenSummary.aliasCount} aliases, ${manifest.tokenSummary.casStateCount} CAS states)

## Unified Bun CLI (\`${manifest.cliEntrypoint}\`)

${cliTable}

## Generated & Managed Artifacts

${artifactTable}

## Pipeline Diagram Integrity (\`${manifest.pipelineDiagrams.catalogPath}\`)

Verified **${manifest.pipelineDiagrams.verifiedFiles}** raster/vector assets across **${manifest.pipelineDiagrams.totalArtifacts}** pipeline diagrams:

${diagramTable}
${brandingSection}
## Verified Markdown Documentation Inventory

Every local link across all **${manifest.markdownDocs.length}** tracked Markdown documents is checked by \`bun run docs:check\`:

${docTable}

## Unified \`package.json\` Scripts

${scriptTable}
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
  const expectedHash = sha256Hex(expectedContent)
  const existingHash = existsSync(fullPath) ? sha256Hex(readFileSync(fullPath)) : null
  if (existingHash === expectedHash) return

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

  // 2. Verify pipeline diagram hashes & branding asset metadata
  const pipelineAudit = auditPipelineArtifactsMetadata(rootDir)
  const brandingAudit = auditBrandingAssetsSync(rootDir)

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
    brandingAssets: {
      specPath: brandingAudit.specPath,
      catalogPath: brandingAudit.catalogPath,
      manifestPath: brandingAudit.manifestPath,
      brandVersion: brandingAudit.brandVersion,
      totalAssets: brandingAudit.totalAssets,
      verifiedFiles: brandingAudit.verifiedFiles,
      xmpVerifiedFiles: brandingAudit.xmpVerifiedFiles,
      entries: brandingAudit.entries,
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
      brandingAudit.issues.length === 0 &&
      allMarkdownIssues.length === 0,
    mode: check ? "check" : "generate",
    tokensOnly: false,
    writtenFiles,
    driftedFiles,
    pipelineIssues: pipelineAudit.issues,
    brandingIssues: brandingAudit.issues,
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
    for (const b of result.brandingIssues ?? []) {
      console.error(`  - [BRANDING] ${b}`)
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
