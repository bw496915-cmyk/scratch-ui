/**
 * Verifies workspace manifest, Bun version pin, `bunfig.toml`, `.npmrc`, and `NPM_CONFIG_USERCONFIG` parity across the
 * live repository and synthetic drift fixtures.
 *
 * @file Tests/unit/registry_parity.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { auditWorkspaceRegistryParity, normalizeRegistryEndpoint } from "../../scripts/check_registry_parity.ts"

const ROOT_DIR = resolve(import.meta.dir, "../..")
const tempDirs: string[] = []

function createTempRepo(overrides?: {
  readonly bunVersion?: string
  readonly rootPkg?: Record<string, unknown>
  readonly bunfigToml?: string
  readonly npmrc?: string
  readonly lockfileWorkspaces?: Record<string, unknown>
  readonly extraFiles?: Readonly<Record<string, string>>
}): string {
  const dir = mkdtempSync(join(tmpdir(), "sportsdesk-parity-"))
  tempDirs.push(dir)

  mkdirSync(join(dir, "packages/core"), { recursive: true })
  mkdirSync(join(dir, ".github/workflows"), { recursive: true })

  writeFileSync(join(dir, ".bun-version"), `${overrides?.bunVersion ?? "1.4.4"}\n`)
  writeFileSync(
    join(dir, ".github/workflows/ci.yml"),
    "jobs:\n  verify:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version-file: .bun-version\n",
  )

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "fixture-root",
        private: true,
        packageManager: "bun@1.4.4",
        engines: { bun: "1.4.4" },
        publishConfig: { tag: "next", registry: "https://registry.npmjs.org/" },
        workspaces: ["packages/*"],
        devDependencies: { "@types/bun": "1.4.4" },
        ...(overrides?.rootPkg ?? {}),
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(dir, "packages/core/package.json"),
    JSON.stringify(
      {
        name: "@fixture/core",
        version: "0.1.0",
        private: true,
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(dir, "bun.lock"),
    JSON.stringify(
      {
        lockfileVersion: 2,
        configVersion: 1,
        workspaces: overrides?.lockfileWorkspaces ?? {
          "": { name: "fixture-root" },
          "packages/core": { name: "@fixture/core", version: "0.1.0" },
        },
        packages: {},
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(dir, "bunfig.toml"),
    overrides?.bunfigToml ?? 'env = false\n[install]\nignoreScripts = true\nminimumReleaseAge = "3d"\n',
  )

  if (overrides?.npmrc !== undefined) {
    writeFileSync(join(dir, ".npmrc"), overrides.npmrc)
  } else {
    writeFileSync(
      join(dir, ".npmrc"),
      "@sportsdesk-local:registry=http://127.0.0.1:4873/\n//127.0.0.1:4873/:_authToken=local-development\n",
    )
  }

  for (const [relPath, content] of Object.entries(overrides?.extraFiles ?? {})) {
    const abs = join(dir, relPath)
    mkdirSync(resolve(abs, ".."), { recursive: true })
    writeFileSync(abs, content)
  }

  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("check_registry_parity: workspace & registry parity gate", () => {
  test("passes on live repository with zero violations and zero nested overrides", () => {
    const report = auditWorkspaceRegistryParity({ rootDir: ROOT_DIR, env: {} })
    expect(report.violations).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.bunVersion.dotBunVersion).toBe("1.4.4")
    expect(report.bunVersion.ciUsesVersionFile).toBe(true)
    expect(report.workspaces.resolvedPaths).toEqual([
      "packages/api",
      "packages/backend",
      "packages/contracts",
      "packages/ui",
    ])
    expect(report.workspaces.lockfilePaths).toEqual(report.workspaces.resolvedPaths)
    expect(report.workspaces.internalDependenciesValid).toBe(true)
    expect(report.registrySources.nestedOverrideFiles).toEqual([])
    expect(report.registrySources.projectNpmrcScopes["@sportsdesk-local"]).toBe("http://127.0.0.1:4873/")
  })

  test("normalizes trailing slashes and host casing on registry URLs", () => {
    expect(normalizeRegistryEndpoint("HTTPS://NPM.PKG.GITHUB.COM/")).toBe("https://npm.pkg.github.com/")
    expect(normalizeRegistryEndpoint("http://127.0.0.1:4873")).toBe("http://127.0.0.1:4873/")
  })

  test("flags Bun version pin drift, nested workspace overrides, and bun.lock workspace mismatch", () => {
    const dir = createTempRepo({
      bunVersion: "1.4.5",
      lockfileWorkspaces: {
        "": { name: "fixture-root" },
        "packages/core": { name: "@fixture/wrong-name" },
        "packages/stale": { name: "@fixture/stale" },
      },
      extraFiles: {
        "packages/core/.npmrc": "registry=https://other.example.com/\n",
        "packages/orphan/README.md": "unlisted package dir\n",
      },
    })

    const report = auditWorkspaceRegistryParity({ rootDir: dir, env: {} })
    expect(report.ok).toBe(false)
    expect(report.violations.some((v) => v.includes("packageManager 'bun@1.4.4' diverges"))).toBe(true)
    expect(report.violations.some((v) => v.includes("packages/core/.npmrc"))).toBe(true)
    expect(report.violations.some((v) => v.includes("disagrees with package.json"))).toBe(true)
    expect(report.violations.some((v) => v.includes("packages/stale"))).toBe(true)
    expect(report.violations.some((v) => v.includes("packages/orphan"))).toBe(true)
  })

  test("flags bunfig.toml vs .npmrc vs NPM_CONFIG_USERCONFIG scope parity conflicts and token leaks", () => {
    const dir = createTempRepo({
      bunfigToml: [
        "env = false",
        "[install]",
        "ignoreScripts = true",
        'minimumReleaseAge = "3d"',
        "[install.scopes]",
        '"@private" = "https://npm.pkg.github.com/"',
      ].join("\n"),
      npmrc: [
        "@private:registry=https://registry.npmjs.org/",
        "//npm.pkg.github.com/:_authToken=ghp_notARealTokenButWrong",
      ].join("\n"),
    })

    const report = auditWorkspaceRegistryParity({ rootDir: dir, env: {} })
    expect(report.ok).toBe(false)
    expect(report.violations.some((v) => v.includes("Scope '@private' registry mismatch"))).toBe(true)
    expect(report.violations.some((v) => v.includes("non-placeholder literal token"))).toBe(true)

    const ciDir = createTempRepo({
      bunfigToml: [
        "env = false",
        "[install]",
        "ignoreScripts = true",
        'minimumReleaseAge = "3d"',
        "[install.scopes]",
        '"@private" = "https://npm.pkg.github.com/"',
      ].join("\n"),
      npmrc: "@private:registry=https://npm.pkg.github.com/\n",
      extraFiles: {
        "ci-user.npmrc": "@private:registry=https://evil-mirror.example.com/\n",
      },
    })

    const ciDivergeReport = auditWorkspaceRegistryParity({
      rootDir: ciDir,
      env: { NPM_CONFIG_USERCONFIG: join(ciDir, "ci-user.npmrc") },
    })
    expect(ciDivergeReport.ok).toBe(false)
    expect(ciDivergeReport.violations.some((v) => v.includes("NPM_CONFIG_USERCONFIG scope '@private'"))).toBe(true)

    const missingUserConfigReport = auditWorkspaceRegistryParity({
      rootDir: ciDir,
      env: { NPM_CONFIG_USERCONFIG: join(ciDir, "missing.npmrc") },
    })
    expect(missingUserConfigReport.ok).toBe(false)
    expect(
      missingUserConfigReport.violations.some((v) => v.includes("NPM_CONFIG_USERCONFIG points to missing file")),
    ).toBe(true)
  })
})
