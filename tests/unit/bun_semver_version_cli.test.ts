/**
 * Verifies unified Bun.semver versioning under the SportsDesk Bun CLI:
 *
 * - `Bun.semver.satisfies` & `Bun.semver.order` reference cases
 * - `sortSemver`, `maxSatisfying`, `minSatisfying`, `bumpSemver`, `normalizeSemver`
 * - `auditUnifiedVersions` across the live repo and isolated drift fixtures
 * - `bumpWorkspaceVersions` lockstep bumping (dry-run and real temp workspace writes)
 * - `runSportsdeskCli(["version", ...])` subcommands
 *
 * @file Tests/unit/bun_semver_version_cli.test.ts
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { semver } from "bun"

import {
  bumpSemver,
  bunSemverAvailable,
  maxSatisfying,
  minSatisfying,
  normalizeSemver,
  safeSatisfies,
  safeSemverOrder,
  sortSemver,
} from "../../packages/contracts/src/bun_semver.ts"
import { runSportsdeskCli } from "../../scripts/sportsdesk_cli.ts"
import { auditUnifiedVersions, bumpWorkspaceVersions } from "../../scripts/version_manager.ts"

const ROOT_DIR = resolve(import.meta.dir, "../..")

function makeTempWorkspaceFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "sd-version-cli-"))
  mkdirSync(join(dir, "packages/api"), { recursive: true })
  mkdirSync(join(dir, "packages/ui"), { recursive: true })
  mkdirSync(join(dir, "tools/registry"), { recursive: true })
  mkdirSync(join(dir, "design"), { recursive: true })

  writeFileSync(join(dir, ".bun-version"), "1.4.4\n")
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "fixture-root",
        version: "1.2.3",
        packageManager: "bun@1.4.4",
        engines: { bun: "1.4.4" },
        workspaces: ["packages/*"],
        devDependencies: { "@types/bun": "1.4.4" },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(dir, "packages/api/package.json"),
    `${JSON.stringify({ name: "@fixture/api", version: "1.2.3", private: true }, null, 2)}\n`,
  )
  writeFileSync(
    join(dir, "packages/ui/package.json"),
    `${JSON.stringify({ name: "@fixture/ui", version: "1.2.3", private: true }, null, 2)}\n`,
  )
  writeFileSync(
    join(dir, "tools/registry/package.json"),
    `${JSON.stringify(
      {
        name: "fixture-registry",
        version: "1.2.3",
        packageManager: "bun@1.4.4",
        engines: { bun: "1.4.4" },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(dir, "design/tokens.toml"), '[meta]\nversion = "1.5.0"\n')
  writeFileSync(
    join(dir, "design/branding.toml"),
    '[meta]\nversion = "1.5.0"\ntokens_version = "1.5.0"\n[brand]\nversion = "v1.01.23-next"\n',
  )
  writeFileSync(join(dir, "design/index.ts"), 'export const DESIGN_SYSTEM_VERSION = "1.5.0"\n')

  return dir
}

describe("Bun.semver primitives & unified Bun CLI versioning", () => {
  test("matches Bun.semver.satisfies and Bun.semver.order specification examples", () => {
    expect(bunSemverAvailable()).toBe(true)

    expect(semver.satisfies("1.0.0", "^1.0.0")).toBe(true)
    expect(semver.satisfies("1.0.0", "^1.0.1")).toBe(false)
    expect(semver.satisfies("1.0.0", "~1.0.0")).toBe(true)
    expect(semver.satisfies("1.0.0", "~1.0.1")).toBe(false)
    expect(semver.satisfies("1.0.0", "1.0.0")).toBe(true)
    expect(semver.satisfies("1.0.0", "1.0.1")).toBe(false)
    expect(semver.satisfies("1.0.1", "1.0.0")).toBe(false)
    expect(semver.satisfies("1.0.0", "1.0.x")).toBe(true)
    expect(semver.satisfies("1.0.0", "1.x.x")).toBe(true)
    expect(semver.satisfies("1.0.0", "x.x.x")).toBe(true)
    expect(semver.satisfies("1.0.0", "1.0.0 - 2.0.0")).toBe(true)
    expect(semver.satisfies("1.0.0", "1.0.0 - 1.0.1")).toBe(true)

    expect(safeSatisfies("1.0.0", "^1.0.0")).toBe(true)
    expect(safeSatisfies("1.0.0", "1.0.0 - 2.0.0")).toBe(true)
    expect(safeSemverOrder("1.0.0", "1.0.0")).toBe(0)
    expect(safeSemverOrder("1.0.0", "1.0.1")).toBe(-1)
    expect(safeSemverOrder("1.0.1", "1.0.0")).toBe(1)

    const unsorted = ["1.0.0", "1.0.1", "1.0.0-alpha", "1.0.0-beta", "1.0.0-rc"]
    expect(sortSemver(unsorted)).toEqual(["1.0.0-alpha", "1.0.0-beta", "1.0.0-rc", "1.0.0", "1.0.1"])
    expect(sortSemver(unsorted, "desc")[0]).toBe("1.0.1")
    expect(maxSatisfying(unsorted, "^1.0.0")).toBe("1.0.1")
    expect(minSatisfying(unsorted, "^1.0.0")).toBe("1.0.0")
  })

  test("computes monotonic release bumps and normalizes display version strings", () => {
    expect(bumpSemver("0.1.0", "patch")).toBe("0.1.1")
    expect(bumpSemver("0.1.0", "minor")).toBe("0.2.0")
    expect(bumpSemver("0.1.0", "major")).toBe("1.0.0")
    expect(bumpSemver("0.1.0", "preminor", "next")).toBe("0.2.0-next.0")
    expect(bumpSemver("0.2.0-next.0", "prerelease", "next")).toBe("0.2.0-next.1")
    expect(bumpSemver("0.2.0-next.1", "minor")).toBe("0.2.0")
    expect(bumpSemver("not-a-version", "patch")).toBeNull()

    expect(normalizeSemver("v1.01.23-next")).toBe("1.1.23-next")
    expect(normalizeSemver("1.5.0")).toBe("1.5.0")
    expect(normalizeSemver("invalid")).toBeNull()
  })

  test("live repository passes auditUnifiedVersions with zero drift across workspace, design, and Bun tracks", () => {
    const report = auditUnifiedVersions({ rootDir: ROOT_DIR })
    expect(report.ok).toBe(true)
    expect(report.engine).toBe("Bun.semver")
    expect(report.workspaceVersion).toBe("0.1.0")
    expect(report.designVersion).toBe("1.5.0")
    expect(report.bunVersionPin).toBe("1.4.4")
    expect(report.violations).toEqual([])
    expect(report.records.some((r) => r.track === "workspace")).toBe(true)
    expect(report.records.some((r) => r.track === "design")).toBe(true)
    expect(report.records.some((r) => r.track === "bun")).toBe(true)
  })

  test("detects workspace and design drift and atomically bumps versions in lockstep", () => {
    const dir = makeTempWorkspaceFixture()
    try {
      const clean = auditUnifiedVersions({ rootDir: dir, activeBunVersion: "1.4.4" })
      expect(clean.ok).toBe(true)
      expect(clean.workspaceVersion).toBe("1.2.3")

      // Dry-run bump leaves files untouched
      const dry = bumpWorkspaceVersions({ rootDir: dir, target: "minor", dryRun: true })
      expect(dry.ok).toBe(true)
      expect(dry.previousVersion).toBe("1.2.3")
      expect(dry.nextVersion).toBe("1.3.0")
      expect(dry.changes.every((c) => !c.written)).toBe(true)
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.2.3")

      // Real bump updates root, packages/*, and tools/registry atomically
      const real = bumpWorkspaceVersions({ rootDir: dir, target: "minor", dryRun: false })
      expect(real.ok).toBe(true)
      expect(real.nextVersion).toBe("1.3.0")
      expect(real.changes.every((c) => c.written)).toBe(true)
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version).toBe("1.3.0")
      expect(JSON.parse(readFileSync(join(dir, "packages/api/package.json"), "utf8")).version).toBe("1.3.0")
      expect(JSON.parse(readFileSync(join(dir, "packages/ui/package.json"), "utf8")).version).toBe("1.3.0")
      expect(JSON.parse(readFileSync(join(dir, "tools/registry/package.json"), "utf8")).version).toBe("1.3.0")
      expect(auditUnifiedVersions({ rootDir: dir, activeBunVersion: "1.4.4" }).ok).toBe(true)

      // Reject downgrade without explicit flag
      const downgrade = bumpWorkspaceVersions({ rootDir: dir, target: "1.2.0" })
      expect(downgrade.ok).toBe(false)

      // Inject drift into one package and verify auditor catches it
      writeFileSync(
        join(dir, "packages/ui/package.json"),
        `${JSON.stringify({ name: "@fixture/ui", version: "1.2.9", private: true }, null, 2)}\n`,
      )
      const drifted = auditUnifiedVersions({ rootDir: dir, activeBunVersion: "1.4.4" })
      expect(drifted.ok).toBe(false)
      expect(drifted.violations.some((v) => v.includes("packages/ui/package.json"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("runSportsdeskCli exposes unified version check, satisfies, order, sort, max, and bump --dry-run", () => {
    expect(runSportsdeskCli(["version", "check"])).toBe(0)
    expect(runSportsdeskCli(["version", "status", "--json"])).toBe(0)
    expect(runSportsdeskCli(["version", "satisfies", "1.0.0", "^1.0.0"])).toBe(0)
    expect(runSportsdeskCli(["version", "satisfies", "1.0.0", "^1.0.1"])).toBe(1)
    expect(runSportsdeskCli(["version", "order", "1.0.0", "1.0.1"])).toBe(0)
    expect(runSportsdeskCli(["version", "sort", "1.0.1", "1.0.0-alpha", "1.0.0"])).toBe(0)
    expect(runSportsdeskCli(["version", "max", "^1.0.0", "1.0.0", "1.0.1", "2.0.0"])).toBe(0)
    expect(runSportsdeskCli(["version", "bump", "patch", "--dry-run"])).toBe(0)
    expect(runSportsdeskCli(["check", "versions"])).toBe(0)
  })
})
