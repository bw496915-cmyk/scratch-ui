/**
 * @file tests/unit/bun_bundler_env.test.ts
 * @description Verifies Bun bundler `env: "PUBLIC_*"` and `[serve.static]` `bunfig.toml`
 * prefix inlining contract, secret isolation, and static-analysis limits on Bun 1.4.4.
 */

import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../..")

const SAMPLE_ENTRY_SOURCE = `export const publicUrl = process.env.PUBLIC_API_URL
export const secretToken = process.env.SPORTSDESK_ADMIN_TOKEN
export const viaImportMeta = import.meta.env.PUBLIC_API_URL
const envAlias = process.env
export const viaAlias = envAlias.PUBLIC_API_URL
`

describe("Bun bundler PUBLIC_* env inlining & [serve.static] bunfig contract", () => {
  test("bunfig.toml keeps top-level env = false and sets [serve.static] env = PUBLIC_*", () => {
    const bunfigText = readFileSync(resolve(REPO_ROOT, "bunfig.toml"), "utf8")
    expect(/(?:^|\n)env\s*=\s*false(?:\s|$|#)/.test(bunfigText)).toBe(true)
    expect(/\[serve\.static\][\s\S]*?env\s*=\s*"PUBLIC_\*"/.test(bunfigText)).toBe(true)
    expect(bunfigText).not.toContain("PUBLIC_ENV_*")
  })

  test("Bun.build({ env: 'PUBLIC_*' }) inlines only literal process.env.PUBLIC_* references", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-env-api-"))
    try {
      const entryPath = join(dir, "entry.ts")
      writeFileSync(entryPath, SAMPLE_ENTRY_SOURCE)

      const buildScript = `
        const result = await Bun.build({
          entrypoints: [${JSON.stringify(entryPath)}],
          env: "PUBLIC_*",
          target: "browser",
        })
        if (!result.success) {
          process.exit(1)
        }
        process.stdout.write(await result.outputs[0].text())
      `
      const output = execFileSync("bun", ["-e", buildScript], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          PUBLIC_API_URL: "https://api.example.com",
          SPORTSDESK_ADMIN_TOKEN: "secret-admin-token-never-inline",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })

      expect(output).toContain('publicUrl = "https://api.example.com"')
      expect(output).not.toContain("secret-admin-token-never-inline")
      expect(output).toContain("process.env.SPORTSDESK_ADMIN_TOKEN")
      expect(output).toContain("import.meta.env.PUBLIC_API_URL")
      expect(output).toContain("envAlias.PUBLIC_API_URL")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("bun build --env PUBLIC_* CLI matches Bun.build and blocks non-PUBLIC_* secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-env-cli-"))
    try {
      const entryPath = join(dir, "entry.ts")
      const outDir = join(dir, "out")
      writeFileSync(entryPath, SAMPLE_ENTRY_SOURCE)

      execFileSync("bun", ["build", entryPath, "--outdir", outDir, "--env", "PUBLIC_*"], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          PUBLIC_API_URL: "https://api.example.com",
          SPORTSDESK_ADMIN_TOKEN: "cli-secret-never-inline",
        },
        stdio: ["ignore", "pipe", "pipe"],
      })

      const output = readFileSync(join(outDir, "entry.js"), "utf8")
      expect(output).toContain('publicUrl = "https://api.example.com"')
      expect(output).not.toContain("cli-secret-never-inline")
      expect(output).toContain("process.env.SPORTSDESK_ADMIN_TOKEN")
      expect(output).toContain("import.meta.env.PUBLIC_API_URL")
      expect(output).toContain("envAlias.PUBLIC_API_URL")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
