import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../..")

function runBun(args: readonly string[]): {
  exitCode: number
  stdout: string
  stderr: string
  combined: string
} {
  const proc = Bun.spawnSync(["bun", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  })
  const stdout = new TextDecoder().decode(proc.stdout)
  const stderr = new TextDecoder().decode(proc.stderr)
  return {
    exitCode: proc.exitCode,
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
  }
}

describe("bun --filter monorepo workspace orchestration", () => {
  test("all four workspace packages expose typecheck, lint, format, and format:check scripts", () => {
    const workspaces = [
      { path: "packages/contracts/package.json", name: "@sportsdesk-ops/contracts" },
      { path: "packages/backend/package.json", name: "@sportsdesk-ops/backend" },
      { path: "packages/api/package.json", name: "@sportsdesk-ops/api" },
      { path: "packages/ui/package.json", name: "@sportsdesk-ops/ui" },
    ]
    for (const ws of workspaces) {
      const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, ws.path), "utf8")) as {
        name?: string
        scripts?: Record<string, string>
      }
      expect(pkg.name).toBe(ws.name)
      expect(pkg.scripts?.typecheck).toBe("tsc --noEmit --project tsconfig.json")
      expect(pkg.scripts?.lint).toBe("tsc --noEmit --project tsconfig.json")
      expect(pkg.scripts?.format).toBe("bun fmt .")
      expect(pkg.scripts?.["format:check"]).toBe("bun fmt --check .")
    }
  })

  test("supports name globs, path globs, directory selectors, and ! exclusions with --parallel prefixed output", () => {
    // 1. Name glob with ! exclusion
    const excludeUi = runBun([
      "run",
      "--parallel",
      "--filter",
      "@sportsdesk-ops/*",
      "--filter",
      "!@sportsdesk-ops/ui",
      "format:check",
    ])
    expect(excludeUi.exitCode).toBe(0)
    expect(excludeUi.combined).toMatch(/@sportsdesk-ops\/contracts:format:check\s+\|/)
    expect(excludeUi.combined).toMatch(/@sportsdesk-ops\/backend:format:check\s+\|/)
    expect(excludeUi.combined).toMatch(/@sportsdesk-ops\/api:format:check\s+\|/)
    expect(excludeUi.combined).not.toContain("@sportsdesk-ops/ui:format:check")

    // 2. Directory selector {./packages}
    const dirSelect = runBun(["run", "--parallel", "--filter", "{./packages}", "format:check"])
    expect(dirSelect.exitCode).toBe(0)
    expect(dirSelect.combined).toMatch(/@sportsdesk-ops\/contracts:format:check\s+\|/)
    expect(dirSelect.combined).toMatch(/@sportsdesk-ops\/backend:format:check\s+\|/)
    expect(dirSelect.combined).toMatch(/@sportsdesk-ops\/api:format:check\s+\|/)
    expect(dirSelect.combined).toMatch(/@sportsdesk-ops\/ui:format:check\s+\|/)

    // 3. Path glob excluding root (!./ + ./packages/*)
    const pathSelect = runBun(["run", "--parallel", "--filter", "!./", "--filter", "./packages/*", "format:check"])
    expect(pathSelect.exitCode).toBe(0)
    expect(pathSelect.combined).toMatch(/@sportsdesk-ops\/ui:format:check\s+\|/)
    expect(pathSelect.combined).not.toContain("sportsdesk-ops:format:check")
  })

  test("supports dependency-relation filters (foo..., foo^..., ...^foo, !...foo) in topological order", () => {
    // bun --filter api... -> runs in strict topological dependency order: contracts -> backend -> api (excludes ui)
    const apiDeps = runBun(["--filter", "@sportsdesk-ops/api...", "format:check"])
    expect(apiDeps.exitCode).toBe(0)
    const contractsPos = apiDeps.combined.indexOf("@sportsdesk-ops/contracts format:check:")
    const backendPos = apiDeps.combined.indexOf("@sportsdesk-ops/backend format:check:")
    const apiPos = apiDeps.combined.indexOf("@sportsdesk-ops/api format:check:")
    expect(contractsPos).toBeGreaterThanOrEqual(0)
    expect(backendPos).toBeGreaterThan(contractsPos)
    expect(apiPos).toBeGreaterThan(backendPos)
    expect(apiDeps.combined).not.toContain("@sportsdesk-ops/ui")

    // --sequential Foreman-style prefixed output on api...
    const apiSeq = runBun(["run", "--sequential", "--filter", "@sportsdesk-ops/api...", "format:check"])
    expect(apiSeq.exitCode).toBe(0)
    expect(apiSeq.combined).toMatch(/@sportsdesk-ops\/contracts:format:check\s+\|/)
    expect(apiSeq.combined).toMatch(/@sportsdesk-ops\/backend:format:check\s+\|/)
    expect(apiSeq.combined).toMatch(/@sportsdesk-ops\/api:format:check\s+\|/)
    expect(apiSeq.combined).not.toContain("@sportsdesk-ops/ui:format:check")

    // api^... -> only dependencies of api (contracts, backend), excluding api itself
    const apiDepsOnly = runBun(["run", "--parallel", "--filter", "@sportsdesk-ops/api^...", "format:check"])
    expect(apiDepsOnly.exitCode).toBe(0)
    expect(apiDepsOnly.combined).toContain("@sportsdesk-ops/contracts:format:check")
    expect(apiDepsOnly.combined).toContain("@sportsdesk-ops/backend:format:check")
    expect(apiDepsOnly.combined).not.toContain("@sportsdesk-ops/api:format:check")

    // ...^contracts -> dependents of contracts (backend, api, ui), excluding contracts itself
    const contractsDependents = runBun([
      "run",
      "--parallel",
      "--filter",
      "...^@sportsdesk-ops/contracts",
      "format:check",
    ])
    expect(contractsDependents.exitCode).toBe(0)
    expect(contractsDependents.combined).not.toContain("@sportsdesk-ops/contracts:format:check")
    expect(contractsDependents.combined).toContain("@sportsdesk-ops/backend:format:check")
    expect(contractsDependents.combined).toContain("@sportsdesk-ops/api:format:check")
    expect(contractsDependents.combined).toContain("@sportsdesk-ops/ui:format:check")

    // Negated dependency relation: all workspaces except backend and its dependents (api)
    const excludeBackendTree = runBun([
      "run",
      "--parallel",
      "--filter",
      "@sportsdesk-ops/*",
      "--filter",
      "!...@sportsdesk-ops/backend",
      "format:check",
    ])
    expect(excludeBackendTree.exitCode).toBe(0)
    expect(excludeBackendTree.combined).toContain("@sportsdesk-ops/contracts:format:check")
    expect(excludeBackendTree.combined).toContain("@sportsdesk-ops/ui:format:check")
    expect(excludeBackendTree.combined).not.toContain("@sportsdesk-ops/backend:format:check")
    expect(excludeBackendTree.combined).not.toContain("@sportsdesk-ops/api:format:check")
  })

  test("executes real workspace typecheck in dependency order via bun --filter and --workspaces --if-present", () => {
    const apiTypecheck = runBun(["--filter", "@sportsdesk-ops/api...", "typecheck"])
    expect(apiTypecheck.exitCode).toBe(0)

    const missingScriptSafe = runBun(["run", "--workspaces", "--if-present", "nonexistent-optional-script"])
    expect(missingScriptSafe.exitCode).toBe(0)
  })

  test("accepts --filter after package-manager subcommands (bun pm licenses --filter)", () => {
    const licenses = runBun(["pm", "licenses", "--filter", "./packages/*"])
    expect(licenses.exitCode).toBe(0)
  })
})
