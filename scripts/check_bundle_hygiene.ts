/**
 * @file scripts/check_bundle_hygiene.ts
 * @description Phase 3 guardrail: scans compiled dist/ assets to ensure zero server
 * tokens, admin secrets, or raw weblog fixture IPs are compiled into the client SPA bundle.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const distDir = resolve(process.cwd(), "dist")
if (!existsSync(distDir)) {
  console.error("FAIL: dist/ directory does not exist. Run `npm run build` first.")
  process.exit(1)
}

const FORBIDDEN_PATTERNS: ReadonlyArray<{ label: string; regex: RegExp }> = [
  { label: "Bearer secret literal", regex: /Bearer\s+[A-Za-z0-9._-]{16,}/ },
  {
    label: "Hardcoded server secret env value",
    regex: /SPORTSDESK_(?:DASHBOARD|ADMIN)_TOKEN\s*[:=]\s*["'][^"']{4,}["']/,
  },
  { label: "Raw captured weblog IP 102.128.164.122", regex: /\b102\.128\.164\.122\b/ },
  { label: "Raw captured weblog IP 45.142.182.91", regex: /\b45\.142\.182\.91\b/ },
  { label: "Raw captured weblog IP 185.220.101.44", regex: /\b185\.220\.101\.44\b/ },
]

const files: string[] = []
function walk(dir: string) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full)
    } else if (/\.(js|mjs|cjs|html|css)$/i.test(entry)) {
      files.push(full)
    }
  }
}
walk(distDir)

const findings: string[] = []
for (const file of files) {
  const content = readFileSync(file, "utf8")
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.regex.test(content)) {
      findings.push(`${rule.label} matched in ${file}`)
    }
  }
}

if (findings.length > 0) {
  console.error("FAIL: Client bundle hygiene violations detected:")
  for (const f of findings) {
    console.error(`  - ${f}`)
  }
  process.exit(1)
}

console.log(
  `PASS: Scanned ${files.length} dist/ bundle file(s) — zero embedded secrets or raw weblog IPs found.`,
)
