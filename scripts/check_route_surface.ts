/**
 * @file scripts/check_route_surface.ts
 * @description Phase 3 guardrail: statically inspects server.ts and packages/api/src/router.ts
 * to guarantee no unauthenticated bypass routes or fail-open auth hooks are reintroduced.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const cwd = process.cwd()
const routerSrc = readFileSync(resolve(cwd, "packages/api/src/router.ts"), "utf8")
const serverSrc = readFileSync(resolve(cwd, "server.ts"), "utf8")
const parsersSrc = readFileSync(resolve(cwd, "packages/backend/src/parsers.ts"), "utf8")

const violations: string[] = []

// 1. Fail-open auth hook forbidden; requireSession middleware required on route families
if (/if\s*\(\s*!deps\.enforceAuth\s*\)\s*return\s+null/.test(routerSrc)) {
  violations.push(
    "packages/api/src/router.ts contains fail-open `if (!deps.enforceAuth) return null`",
  )
}
if (
  !routerSrc.includes("export function requireSession") ||
  !routerSrc.includes("protectRouteFamily")
) {
  violations.push(
    "packages/api/src/router.ts must wrap protected route families with `requireSession` middleware",
  )
}
if (/enforceAuth:\s*async\s*\(\)\s*=>\s*null/.test(serverSrc)) {
  violations.push("server.ts contains hardcoded no-op `enforceAuth: async () => null`")
}

// 2. Express must disable X-Powered-By and mount centralized /api auth middleware before direct /api routes
if (!serverSrc.includes('app.disable("x-powered-by")')) {
  violations.push('server.ts missing `app.disable("x-powered-by")`')
}
const apiGuardIdx = serverSrc.indexOf('app.use("/api",')
const firstDirectApiIdx = serverSrc.search(/app\.(?:get|post|put|patch|delete)\(\s*["'`]\/api\//)
if (apiGuardIdx < 0 || firstDirectApiIdx < 0 || apiGuardIdx > firstDirectApiIdx) {
  violations.push(
    'server.ts must mount centralized `app.use("/api", ...)` auth gate BEFORE direct Express /api/* routes',
  )
}

// 3. WebSocket upgrade must call verifyWebSocketUpgrade
if (!serverSrc.includes("verifyWebSocketUpgrade")) {
  violations.push("server.ts missing WebSocket upgrade authentication (`verifyWebSocketUpgrade`)")
}

// 4. Production cannot opt out of auth in parsers.ts
if (
  !/if\s*\(\s*env\.NODE_ENV\s*===\s*"production"\s*\)\s*\{\s*return\s+true\s*;?\s*\}/.test(
    parsersSrc,
  )
) {
  violations.push(
    "packages/backend/src/parsers.ts must unconditionally return true when NODE_ENV === 'production'",
  )
}

// 5. Terminal exec must use adminGuard + enforceAdminAuth
const termIdx = routerSrc.indexOf('"/api/terminal/exec"')
const termSlice = termIdx >= 0 ? routerSrc.slice(termIdx, termIdx + 500) : ""
if (
  !routerSrc.includes("export function adminGuard") ||
  !termSlice.includes("adminGuard") ||
  !termSlice.includes("enforceAdminAuth")
) {
  violations.push(
    "packages/api/src/router.ts `/api/terminal/exec` must be gated by `adminGuard` and `enforceAdminAuth`",
  )
}

if (violations.length > 0) {
  console.error("FAIL: Route surface security audit violations:")
  for (const v of violations) {
    console.error(`  - ${v}`)
  }
  process.exit(1)
}

console.log("PASS: Route surface & fail-closed auth invariants verified.")
