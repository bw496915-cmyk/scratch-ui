import { describe, expect, test } from "bun:test"

import { createDashboardApi } from "../../packages/api/src/index.ts"
import { benchmarkNodeDns, executeNodeTerminalQuery } from "../../server/adapters.ts"
import { DnsBoundaryError } from "../../src/lib/dns_boundary.ts"
import {
  assertSafeSpawnArgv,
  buildBunTerminalSpawnOptions,
  resolveProfileTerminalOptions,
  scanSourceForUnsafeShellPatterns,
  ShellBoundaryError,
  validateTerminalCommand,
} from "../../src/lib/shell_boundary.ts"
import type { ProfileTheme } from "../../src/profile/types.ts"

describe("L1: Shell, Bun.Terminal & ProfileTheme Boundaries", () => {
  test("validateTerminalCommand enforces flag allowlist, rejects quotes/globs/subshells, and allows cron schedules", () => {
    expect(validateTerminalCommand("profile JAKE231 --depth=3 --radar")).toEqual({
      ok: true,
      command: "profile JAKE231 --depth=3 --radar",
      head: "profile",
    })
    expect(validateTerminalCommand("inspect-options --options=depth=2,compact")).toEqual({
      ok: true,
      command: "inspect-options --options=depth=2,compact",
      head: "inspect-options",
    })
    expect(validateTerminalCommand("cron */5 * * * *")).toEqual({
      ok: true,
      command: "cron */5 * * * *",
      head: "cron",
    })
    expect(validateTerminalCommand("md --theme dark --columns 110 --linkify-symbols dashboard.md").ok).toBe(true)
    expect(validateTerminalCommand("sh").ok).toBe(true)
    expect(validateTerminalCommand("rank-all").ok).toBe(true)
    expect(validateTerminalCommand("d fantasy402.com").ok).toBe(true)
    expect(validateTerminalCommand("r 1.1.1.1").ok).toBe(true)

    // Reject metacharacters, quotes, parens, globs, shell -c flags, and unallowlisted flags
    expect(validateTerminalCommand("sh -c ls").ok).toBe(false)
    expect(validateTerminalCommand('profile "JAKE231"').ok).toBe(false)
    expect(validateTerminalCommand("profile $(whoami)").ok).toBe(false)
    expect(validateTerminalCommand("profile JAKE231 --upload-pack=evil").ok).toBe(false)
    expect(validateTerminalCommand("wagers *").ok).toBe(false)
    expect(validateTerminalCommand("profiles [a-z]").ok).toBe(false)
    expect(validateTerminalCommand("help; id").ok).toBe(false)
  })

  test("assertSafeSpawnArgv blocks sh -c, NUL bytes, and unseparated positional flags", () => {
    expect(
      assertSafeSpawnArgv(["git", "diff", "--exit-code", "--", "bun.lock"], {
        requireDoubleDashBeforeOperands: true,
        operandStartIndex: 3,
      }),
    ).toEqual(["git", "diff", "--exit-code", "--", "bun.lock"])

    expect(() => assertSafeSpawnArgv(["sh", "-c", "ls"])).toThrow(ShellBoundaryError)
    expect(() => assertSafeSpawnArgv(["/bin/bash", "-lc", "env"])).toThrow("ERR_SHELL_SUBSHELL_FORBIDDEN")
    expect(() => assertSafeSpawnArgv(["git", "status\0"])).toThrow("ERR_SHELL_NULL_BYTE")
    expect(() =>
      assertSafeSpawnArgv(["git", "diff", "--upload-pack=evil"], {
        requireDoubleDashBeforeOperands: true,
        operandStartIndex: 2,
      }),
    ).toThrow("ERR_SHELL_FLAG_INJECTION")
  })

  test("scanSourceForUnsafeShellPatterns flags Bun.$ raw escapes and shell: true", () => {
    const clean = [
      "// Comment mentioning ${{ raw: 'safe' }} and sh -c",
      "const res = Bun.spawnSync(['bun', '--version']);",
    ].join("\n")
    expect(scanSourceForUnsafeShellPatterns(clean)).toEqual([])

    const unsafe = [
      "await $`echo ${{ raw: userInput }}`;",
      "Bun.spawn(['node', '-v'], { shell: true });",
      "await $`bash -c ${cmd}`;",
    ].join("\n")
    const findings = scanSourceForUnsafeShellPatterns(unsafe)
    expect(findings.map((f) => f.code)).toEqual([
      "ERR_SHELL_RAW_FORBIDDEN",
      "ERR_SHELL_SUBSHELL_FORBIDDEN",
      "ERR_SHELL_SUBSHELL_FORBIDDEN",
    ])
  })

  test("resolveProfileTerminalOptions and buildBunTerminalSpawnOptions clamp PTY bounds and scrub env", () => {
    const customTheme: ProfileTheme = {
      ui: "dark",
      terminal: {
        colors: false,
        light: "dark",
        hyperlinks: false,
        columns: 9999,
        kittyGraphics: false,
      },
      inspect: {
        colors: true,
        compact: true,
        depth: 12,
        sorted: true,
      },
      colorDepth: "ansi-256",
    }

    const resolved = resolveProfileTerminalOptions(customTheme, {
      cols: 12,
      rows: 500,
    })
    expect(resolved.cols).toBe(40)
    expect(resolved.rows).toBe(100)
    expect(resolved.inspect.colors).toBe(false)
    expect(resolved.inspect.compact).toBe(true)
    expect(resolved.inspect.depth).toBe(6)
    expect(resolved.inspect.sorted).toBe(true)

    const pty = buildBunTerminalSpawnOptions({ profileTheme: customTheme })
    expect(pty.cols).toBe(240)
    expect(pty.rows).toBe(30)
    expect(pty.env.TERM).toBe("dumb")
    expect(pty.env.NO_COLOR).toBe("1")
    expect(pty.env.COLORFGBG).toBe("15;0")
    expect(pty.env.BUN_OPTIONS).toBeUndefined()
  })

  test("executeNodeTerminalQuery & /api/terminal/exec propagate ProfileTheme with CLI flag overrides", async () => {
    const customTheme: ProfileTheme = {
      ui: "dark",
      terminal: {
        colors: false,
        light: "dark",
        hyperlinks: false,
        columns: 72,
        kittyGraphics: false,
      },
      inspect: {
        colors: false,
        compact: true,
        depth: 1,
        sorted: true,
      },
      colorDepth: "ansi-256",
    }

    const resNoColor = await executeNodeTerminalQuery(
      "who",
      {
        findCustomerRow: async () => null,
        getTiersConfig: async () => ({ tiers: {} }),
        getLiveWagers: async () => ({ wagers: [] }),
      },
      { cols: 72, rows: 24, profileTheme: customTheme },
    )
    expect(resNoColor.stdout).not.toContain("\x1b[")
    expect(resNoColor.stdout).toContain("cols=72 rows=24 depth=1 colors=false colorDepth=ansi-256")

    const resCliOverride = await executeNodeTerminalQuery(
      "who --colors --depth=3",
      {
        findCustomerRow: async () => null,
        getTiersConfig: async () => ({ tiers: {} }),
        getLiveWagers: async () => ({ wagers: [] }),
      },
      { cols: 72, rows: 24, profileTheme: customTheme },
    )
    expect(resCliOverride.stdout).toContain("\x1b[")
    expect(resCliOverride.stdout).toContain("depth=3 colors=true")

    // Verify router forwards resolved ProfileTheme & clamped dims into execTerminal
    let receivedDims: { cols: number; rows: number; profileTheme?: ProfileTheme } | null = null
    const api = createDashboardApi({
      env: {
        NODE_ENV: "production",
        SPORTSDESK_DASHBOARD_TOKEN: "op-token",
        SPORTSDESK_ADMIN_TOKEN: "admin-token",
      },
      enforceAuth: async () => null,
      enforceAdminAuth: async () => null,
      resolveTerminalProfile: () => customTheme,
      getHealthPayload: () => ({ status: "ok" }),
      loadDashboardMarkdown: async () => null,
      dns: {
        getTelemetryPayload: () => ({}),
        benchmark: async (host) => benchmarkNodeDns(host),
        classifyIp: async () => ({}),
      },
      customers: {
        getCohortReport: async () => ({ versionStamp: "v1", payload: {} }),
        getProfile: async () => null,
        getRating: async () => null,
      },
      execTerminal: async (command, dims) => {
        receivedDims = dims
        return { command, dims }
      },
      rankings: {
        getAll: async () => ({ generatedAtIso: "2026-01-01T00:00:00Z", payload: {} }),
        getConduits: async () => [],
      },
      getLiveWagersPayload: async () => ({ wagers: [] }),
      getTiersConfig: async () => ({}),
      alerts: { sweepOnce: async () => ({}), list: () => [] },
      shadowPricing: { getDashboard: async () => ({}) },
      betTicker: { getPayload: () => ({}) },
      r2Pipeline: { getPayload: async () => ({}), getHistory: async () => ({}) },
      verifyTickets: async () => ({}),
      getAutomationsSnapshot: async () => ({}),
      getBuildMatrix: async () => ({}),
      getAgentDetail: async () => null,
      queryWebLogs: () => ({}),
      getProfileInspect: () => ({}),
      diagnostics: { getImageAssets: async () => ({}), readRawAsset: async () => null },
    })

    const termRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer op-token",
          "x-admin-token": "admin-token",
        },
        body: JSON.stringify({ command: "who", cols: 9999, rows: 2 }),
      }),
    )
    expect(termRes.status).toBe(200)
    expect(receivedDims).toEqual({
      cols: 240,
      rows: 12,
      profileTheme: customTheme,
    })

    const badFlagRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer op-token",
          "x-admin-token": "admin-token",
        },
        body: JSON.stringify({ command: "profile JAKE231 --exec=sh" }),
      }),
    )
    expect(badFlagRes.status).toBe(400)

    // DNS benchmark rejects unvalidated URLs / IPv6 zone IDs with 400
    const badDnsRes = await api.fetch(
      new Request("http://127.0.0.1:3000/api/dns/benchmark?host=https://evil.com", {
        headers: { Authorization: "Bearer op-token" },
      }),
    )
    expect(badDnsRes.status).toBe(400)
  })

  test("benchmarkNodeDns rejects invalid hostnames via assertCleanHostname", async () => {
    await expect(benchmarkNodeDns("fe80::1%eth0")).rejects.toThrow(DnsBoundaryError)
    await expect(benchmarkNodeDns("https://desk.bookdeskops.com")).rejects.toThrow("ERR_DNS_INVALID_HOSTNAME")
  })
})
