/**
 * @file scripts/check_shell_boundary.ts
 * @description CI security guardrail verifying zero `{ raw: ... }` Bun.$ escapes,
 * zero `shell: true` / `sh -c` / `bash -c` subshells, and clean terminal boundary wiring.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { scanSourceForUnsafeShellPatterns } from "../src/lib/shell_boundary.ts"

const cwd = process.cwd()
const SCAN_ROOTS = ["src", "lib", "packages", "server", "scripts"]
const EXPLICIT_FILES = ["server.ts"]

const filesToScan: string[] = []

for (const relFile of EXPLICIT_FILES) {
  const full = resolve(cwd, relFile)
  if (existsSync(full)) filesToScan.push(full)
}

function walkTsFiles(dir: string): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walkTsFiles(full)
    } else if (/\.(ts|tsx|mts|js|mjs)$/i.test(entry)) {
      filesToScan.push(full)
    }
  }
}

for (const root of SCAN_ROOTS) {
  walkTsFiles(resolve(cwd, root))
}

const violations: string[] = []

for (const filePath of filesToScan) {
  // Ignore the static scanner definition file itself
  if (filePath.endsWith("src/lib/shell_boundary.ts")) continue
  const content = readFileSync(filePath, "utf8")
  const findings = scanSourceForUnsafeShellPatterns(content)
  for (const f of findings) {
    violations.push(`${filePath}:${f.line} [${f.code}] ${f.snippet}`)
  }
}

// Verify server.ts wires runRuntimePreflightAudit and ProfileStore -> execTerminal
const serverSrc = readFileSync(resolve(cwd, "server.ts"), "utf8")
if (!serverSrc.includes("runRuntimePreflightAudit")) {
  violations.push("server.ts must call `runRuntimePreflightAudit` during startup")
}
if (!serverSrc.includes("resolveTerminalProfile")) {
  violations.push("server.ts must wire `resolveTerminalProfile` into `createDashboardApi`")
}

// Verify server/adapters.ts validates benchmark host via assertCleanHostname
const adaptersSrc = readFileSync(resolve(cwd, "server/adapters.ts"), "utf8")
if (!adaptersSrc.includes("assertCleanHostname")) {
  violations.push(
    "server/adapters.ts `benchmarkNodeDns` must validate hosts with `assertCleanHostname`",
  )
}

if (violations.length > 0) {
  console.error("FAIL: Shell & runtime boundary audit violations:")
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  process.exit(1)
}

console.log(
  `PASS: Scanned ${filesToScan.length} source file(s) — zero Bun.$ raw escapes or subshells, runtime preflight + ProfileTheme/Terminal + DNS boundaries wired.`,
)
