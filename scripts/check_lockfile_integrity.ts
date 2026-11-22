/**
 * @file scripts/check_lockfile_integrity.ts
 * @description Composite CI gate verifying:
 * 1. Installed Bun runtime matches pinned `.bun-version` (preventing silent `hasInstallScript` / `libc` drops).
 * 2. `bun.lock` retains `lockfileVersion >= 2`, `hasInstallScript`, and `libc` optional-dep metadata.
 * 3. `bunfig.toml` enforces `env = false`, `[install].ignoreScripts = true`, and `[install].minimumReleaseAge`.
 * 4. `package.json` declares `publishConfig.tag` (guarding prerelease versions such as `v1.01.23-next`).
 * 5. `bun.lock` has no uncommitted schema drift when running inside a git repository.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { eq, isValidSemver } from "../packages/contracts/src/bun_semver.ts"

const cwd = process.cwd()
const violations: string[] = []

// 1. Check .bun-version pin against active Bun runtime
const bunVersionFile = resolve(cwd, ".bun-version")
if (!existsSync(bunVersionFile)) {
  violations.push("Missing `.bun-version` pin file in repository root")
} else {
  const pinnedVersion = readFileSync(bunVersionFile, "utf8").trim()
  if (!isValidSemver(pinnedVersion)) {
    violations.push(`Invalid semver in .bun-version: '${pinnedVersion}'`)
  } else {
    try {
      const actualBun = execFileSync("bun", ["--version"], {
        cwd,
        encoding: "utf8",
      }).trim()
      if (!eq(actualBun, pinnedVersion)) {
        violations.push(
          `Bun version mismatch: runtime is ${actualBun}, but .bun-version pins ${pinnedVersion} (risk of silent bun.lock hasInstallScript drop)`,
        )
      }
    } catch {
      violations.push("Unable to execute `bun --version` to verify pinned runtime")
    }
  }
}

// 2. Check bun.lock retains lockfileVersion >= 2 and hasInstallScript entries
const lockfilePath = resolve(cwd, "bun.lock")
if (!existsSync(lockfilePath)) {
  violations.push("Missing `bun.lock`")
} else {
  const lockText = readFileSync(lockfilePath, "utf8")
  const verMatch = /"lockfileVersion"\s*:\s*(\d+)/.exec(lockText)
  const lockVersion = verMatch ? Number(verMatch[1]) : 0
  if (lockVersion < 2) {
    violations.push(
      `bun.lock lockfileVersion is ${lockVersion} (expected >= 2 for hasInstallScript support)`,
    )
  }
  const hasInstallScriptMatches = lockText.match(/"hasInstallScript"\s*:\s*true/g) ?? []
  if (hasInstallScriptMatches.length === 0) {
    violations.push(
      "bun.lock contains zero `hasInstallScript` entries (possible silent schema strip by older Bun)",
    )
  }
  const libcMatches = lockText.match(/"libc"\s*:\s*"(?:glibc|musl)"/g) ?? []
  if (libcMatches.length === 0) {
    violations.push(
      "bun.lock contains zero `libc` entries for Linux native optional deps (possible schema strip by older Bun)",
    )
  }
}

// 3. Check bunfig.toml supply-chain & env-bleed hardening
const bunfigPath = resolve(cwd, "bunfig.toml")
if (!existsSync(bunfigPath)) {
  violations.push("Missing `bunfig.toml` with `env = false` and `[install] ignoreScripts = true`")
} else {
  const bunfigText = readFileSync(bunfigPath, "utf8")
  if (!/(?:^|\n)env\s*=\s*false(?:\s|$|#)/.test(bunfigText)) {
    violations.push(
      "bunfig.toml must set top-level `env = false` to disable implicit .env auto-loading in Bun CLI/pm",
    )
  }
  if (!/\[install\][\s\S]*?ignoreScripts\s*=\s*true/.test(bunfigText)) {
    violations.push("bunfig.toml must set `ignoreScripts = true` under `[install]`")
  }
  if (!/\[install\][\s\S]*?minimumReleaseAge\s*=\s*(?:"[^"]+"|\d+)/.test(bunfigText)) {
    violations.push('bunfig.toml must set `minimumReleaseAge` (e.g. "3d") under `[install]`')
  }
}

// 4. Check package.json publishConfig.tag guard for prerelease versions
const pkgPath = resolve(cwd, "package.json")
const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
  publishConfig?: { tag?: string; registry?: string }
}
const publishTag = pkg.publishConfig?.tag?.trim() ?? ""
if (!publishTag || publishTag === "latest") {
  violations.push(
    'package.json must set `publishConfig.tag` to a non-latest prerelease tag (e.g. "next") for prerelease safety',
  )
}

// 5. If inside a git worktree, verify bun.lock has no unstaged schema drift
try {
  const inGit = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()
  if (inGit === "true") {
    try {
      execFileSync("git", ["diff", "--exit-code", "--", "bun.lock"], {
        cwd,
        stdio: "ignore",
      })
    } catch {
      violations.push("git diff --exit-code bun.lock failed: uncommitted lockfile drift detected")
    }
  }
} catch {
  // Not a git checkout (e.g., archive/container snapshot) — skip git diff step cleanly
}

if (violations.length > 0) {
  console.error("FAIL: Lockfile & supply-chain integrity violations:")
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  process.exit(1)
}

console.log(
  "PASS: Lockfile integrity (hasInstallScript + libc), pinned Bun version, bunfig.toml hardening (env=false, ignoreScripts, minimumReleaseAge), and publishConfig.tag verified.",
)
