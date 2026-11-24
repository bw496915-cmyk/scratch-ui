/**
 * Verifies the deterministic artifact generator (`scripts/gen_artifacts.ts`), zero-drift design tokens & pipeline
 * hashes, Markdown link/staleness hygiene, and the unified Bun CLI (`scripts/sportsdesk_cli.ts`).
 *
 * @file Tests/unit/bun_cli_and_artifacts.test.ts
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  auditMarkdownDocs,
  auditPipelineArtifactsMetadata,
  emitTokensGeneratedCss,
  emitTokensRegistryTs,
  parseDesignTokensToml,
  runArtifactPipeline,
} from "../../scripts/gen_artifacts.ts"

const ROOT_DIR = resolve(import.meta.dir, "../..")

function runCli(args: readonly string[]): {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
} {
  const proc = Bun.spawnSync(["bun", "scripts/sportsdesk_cli.ts", ...args], {
    cwd: ROOT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  }
}

describe("deterministic artifact generator (scripts/gen_artifacts.ts)", () => {
  test("compiles design/tokens.toml with zero drift against generated TS and CSS files", () => {
    const parsed = parseDesignTokensToml(ROOT_DIR)
    expect(parsed.version).toBe("1.5.0")
    expect(parsed.canonicalTokens.length).toBeGreaterThanOrEqual(41)
    expect(parsed.aliases.length).toBeGreaterThanOrEqual(25)
    expect(parsed.casStates.length).toBe(4)

    const onDiskTs = readFileSync(resolve(ROOT_DIR, "packages/ui/src/tokens.registry.generated.ts"), "utf8")
    const onDiskCss = readFileSync(resolve(ROOT_DIR, "src/dashboard/tokens.generated.css"), "utf8")

    expect(emitTokensRegistryTs(parsed)).toBe(onDiskTs)
    expect(emitTokensGeneratedCss(parsed)).toBe(onDiskCss)
  })

  test("verifies all pipeline diagram assets in docs/assets/pipeline-artifacts-metadata.json", () => {
    const audit = auditPipelineArtifactsMetadata(ROOT_DIR)
    expect(audit.totalArtifacts).toBe(4)
    expect(audit.verifiedFiles).toBe(12)
    expect(audit.issues).toEqual([])
    expect(audit.results.every((r) => r.ok)).toBe(true)
  })

  test("audits all tracked Markdown documents with zero broken local links and zero stale references", () => {
    const audit = auditMarkdownDocs(ROOT_DIR)
    expect(audit.docs.length).toBeGreaterThanOrEqual(10)
    expect(audit.issues).toEqual([])

    const paths = new Set(audit.docs.map((d) => d.path))
    expect(paths.has("README.md")).toBe(true)
    expect(paths.has("dashboard.md")).toBe(true)
    expect(paths.has("design/README.md")).toBe(true)
    expect(paths.has("docs/generated/ARTIFACTS_AND_CLI.md")).toBe(true)
    expect(paths.has("docs/live-customer-sources.md")).toBe(true)
  })

  test("runArtifactPipeline({ check: true }) reports zero drift across all generated artifacts", () => {
    const result = runArtifactPipeline({ rootDir: ROOT_DIR, check: true })
    expect(result.ok).toBe(true)
    expect(result.driftedFiles).toEqual([])
    expect(result.pipelineIssues).toEqual([])
    expect(result.markdownIssues).toEqual([])
    expect(result.manifest?.tokensVersion).toBe("1.5.0")
    expect(result.manifest?.cliEntrypoint).toBe("bun run cli")

    const onDiskManifest = JSON.parse(
      readFileSync(resolve(ROOT_DIR, "docs/generated/artifacts-manifest.json"), "utf8"),
    ) as { readonly tokensVersion: string; readonly generatedArtifacts: readonly unknown[] }
    expect(onDiskManifest.tokensVersion).toBe("1.5.0")
    expect(onDiskManifest.generatedArtifacts.length).toBe(3)
  })
})

describe("unified Bun CLI (scripts/sportsdesk_cli.ts)", () => {
  test("help lists all top-level command groups", () => {
    const res = runCli(["help"])
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain("bun run cli artifacts")
    expect(res.stdout).toContain("bun run cli docs")
    expect(res.stdout).toContain("bun run cli surface")
    expect(res.stdout).toContain("bun run cli check")
    expect(res.stdout).toContain("bun run cli scripts")
  })

  test("artifacts check and docs check pass with exit code 0", () => {
    const artifacts = runCli(["artifacts", "check"])
    expect(artifacts.exitCode).toBe(0)
    expect(artifacts.stdout).toContain("PASS:")

    const docs = runCli(["docs", "check"])
    expect(docs.exitCode).toBe(0)
    expect(docs.stdout).toContain("PASS:")
  })

  test("surface --json exposes deep Bun runtime introspection with secrets redacted", () => {
    const res = runCli(["surface", "--json"])
    expect(res.exitCode).toBe(0)
    const payload = JSON.parse(res.stdout) as {
      readonly bunDetected: boolean
      readonly exportCount: number
      readonly deepInspections: readonly { readonly category: string }[]
      readonly kindCounts: Readonly<Record<string, number>>
    }
    expect(payload.bunDetected).toBe(true)
    expect(payload.exportCount).toBeGreaterThan(80)
    expect(payload.deepInspections.some((d) => d.category === "builtin-module")).toBe(true)
    expect(payload.deepInspections.some((d) => d.category === "bun-namespace")).toBe(true)
    expect(payload.deepInspections.some((d) => d.category === "bun-class")).toBe(true)
    expect(payload.kindCounts.function).toBeGreaterThan(20)
    expect(payload.kindCounts.class).toBeGreaterThan(10)
    // Never leak environment secret values in JSON payload
    expect(res.stdout).not.toContain("PRIVATE_KEY")
  })

  test("docs render formats Markdown with Bun.markdown.ansi and Bun.markdown.render", () => {
    const ansiRes = runCli(["docs", "render", "design/README.md", "--mode", "ansi", "--columns", "80"])
    expect(ansiRes.exitCode).toBe(0)
    expect(ansiRes.stdout.length).toBeGreaterThan(100)
    expect(ansiRes.stdout).toContain("Design Token SSOT")

    const renderRes = runCli(["docs", "render", "design/README.md", "--mode", "render", "--columns", "80"])
    expect(renderRes.exitCode).toBe(0)
    expect(renderRes.stdout.length).toBeGreaterThan(100)
    expect(renderRes.stdout).toContain("Design Token SSOT")

    const profileRenderRes = runCli([
      "docs",
      "render",
      "SD-DOC-DESIGN-TOKENS",
      "--mode",
      "ansi",
      "--profile",
      "pipe_ascii",
      "--ids",
    ])
    expect(profileRenderRes.exitCode).toBe(0)
    expect(profileRenderRes.stdout).toContain("Design Token SSOT")
    expect(profileRenderRes.stdout).toContain("#design-token-ssot")
    expect(profileRenderRes.stdout).toContain("+---")
  })

  test("docs list, docs ids, and help --ansi/--md expose SD-DOC-* meta IDs and GFM tables", () => {
    const audit = auditMarkdownDocs(ROOT_DIR)
    const designDoc = audit.docs.find((d) => d.path === "design/README.md")
    expect(designDoc?.metaId).toBe("SD-DOC-DESIGN-TOKENS")
    expect(designDoc?.tableCount).toBeGreaterThanOrEqual(2)
    expect(designDoc?.headingIds.some((h) => h.id === "design-token-ssot")).toBe(true)

    const listJson = runCli(["docs", "list", "--json", "--ids"])
    expect(listJson.exitCode).toBe(0)
    const listPayload = JSON.parse(listJson.stdout) as {
      readonly metaId: string
      readonly path: string
      readonly tableCount: number
      readonly headingIds: readonly { readonly id: string }[]
    }[]
    expect(listPayload.some((d) => d.metaId === "SD-DOC-ROOT-README")).toBe(true)
    expect(listPayload.find((d) => d.metaId === "SD-DOC-DESIGN-TOKENS")?.headingIds.length).toBeGreaterThanOrEqual(5)

    const idsJson = runCli(["docs", "ids", "SD-DOC-DESIGN-TOKENS", "--json"])
    expect(idsJson.exitCode).toBe(0)
    const idsPayload = JSON.parse(idsJson.stdout) as {
      readonly metaId: string
      readonly headingIds: readonly { readonly level: number; readonly id: string }[]
    }[]
    expect(idsPayload[0]?.metaId).toBe("SD-DOC-DESIGN-TOKENS")
    expect(idsPayload[0]?.headingIds.some((h) => h.id === "design-token-ssot")).toBe(true)

    const helpMd = runCli(["help", "--md"])
    expect(helpMd.exitCode).toBe(0)
    expect(helpMd.stdout).toContain("| Command")
    expect(helpMd.stdout).toContain("| :---")

    const helpAnsi = runCli(["help", "--ansi", "--profile", "tty_narrow"])
    expect(helpAnsi.exitCode).toBe(0)
    expect(helpAnsi.stdout).toContain("┌")
    expect(helpAnsi.stdout).toContain("bun run cli docs ids")
  })
})
