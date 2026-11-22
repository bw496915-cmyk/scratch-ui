/**
 * @file tests/preflight_guard.test.ts
 * @description Comprehensive tests for `assertSafeExecArgv` plus a live Bun 1.4.4
 * runtime contract assertion proving `--no-env-file` does NOT suppress explicit
 * `--env-file=<path>` loading (so the pairing exemption stays permanently deleted).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertSafeExecArgv, ERR_CF_TOKEN_BLEED_10000 } from "../src/cli/preflight_guard.ts"

const BLEED = ERR_CF_TOKEN_BLEED_10000

describe("term-profile startup preflight (fail-closed, no --no-env-file pairing exemption)", () => {
  test("allows clean execArgv without --env-file", () => {
    expect(() =>
      assertSafeExecArgv(["--smol", "--disallow-code-generation-from-strings=strict"]),
    ).not.toThrow()
  })

  test("allows --no-env-file alone (disables auto-loading .env)", () => {
    expect(() => assertSafeExecArgv(["--no-env-file"])).not.toThrow()
  })

  test("rejects --env-file without allowlist in execArgv", () => {
    expect(() => assertSafeExecArgv(["--env-file=r2.env"])).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--env-file", "pages.env"])).toThrow(BLEED)
  })

  test("rejects bare or empty --env-file (even when an allowlist is configured)", () => {
    expect(() => assertSafeExecArgv(["--env-file"])).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--env-file="])).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--env-file"], "", { allowedEnvFiles: ["safe.env"] })).toThrow(
      BLEED,
    )
    expect(() =>
      assertSafeExecArgv(["--env-file="], "", { allowedEnvFiles: ["safe.env"] }),
    ).toThrow(BLEED)
  })

  test("rejects --env-file even when paired with --no-env-file in EITHER order (Bun loads --env-file unconditionally)", () => {
    expect(() => assertSafeExecArgv(["--no-env-file", "--env-file=r2.env"])).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--env-file=r2.env", "--no-env-file"])).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--no-env-file", "--env-file", "r2.env"])).toThrow(BLEED)
  })

  test("rejects unguarded --env-file injected via BUN_OPTIONS", () => {
    expect(() => assertSafeExecArgv(["--smol"], "--env-file=r2.env")).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--smol"], '--env-file="r2.env"')).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--smol"], "--env-file pages.env")).toThrow(BLEED)
  })

  test("rejects cross-source --env-file across execArgv and BUN_OPTIONS", () => {
    expect(() => assertSafeExecArgv(["--no-env-file"], "--env-file=r2.env")).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--env-file=a.env"], "--no-env-file")).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--env-file=a.env"], "--env-file=b.env")).toThrow(BLEED)
  })

  test("rejects multiple --env-file flags unless EVERY path is explicitly allowlisted", () => {
    expect(() =>
      assertSafeExecArgv(["--no-env-file", "--env-file=a.env", "--env-file=b.env"]),
    ).toThrow(BLEED)
    expect(() =>
      assertSafeExecArgv(["--env-file=safe.env", "--env-file=r2.env"], "", {
        allowedEnvFiles: ["safe.env"],
      }),
    ).toThrow(BLEED)
    expect(() =>
      assertSafeExecArgv(["--env-file=safe.env", "--env-file", "safe2.env"], "", {
        allowedEnvFiles: ["safe.env", "safe2.env"],
      }),
    ).not.toThrow()
  })

  // Documented fail-closed limitation: prefix scan, not a full CLI parser.
  // These are safe-direction false positives; pinned so a future "fix" doesn't
  // accidentally open a bypass.
  test("documented safe-direction false positives: --env-file as flag value or after --", () => {
    expect(() => assertSafeExecArgv(["--title", "--env-file=r2.env"])).toThrow(BLEED)
    expect(() => assertSafeExecArgv(["--", "--env-file=r2.env"])).toThrow(BLEED)
  })

  test("default-argument path reads process.execArgv and process.env.BUN_OPTIONS", () => {
    // Clean injectable runtime passes
    expect(() =>
      assertSafeExecArgv(undefined, undefined, {
        runtime: { execArgv: ["--smol"], bunOptions: undefined },
      }),
    ).not.toThrow()

    // Dirty injectable runtime throws
    expect(() =>
      assertSafeExecArgv(undefined, undefined, {
        runtime: { execArgv: ["--smol"], bunOptions: "--env-file=r2.env" },
      }),
    ).toThrow(BLEED)

    // Real zero-arg invocation reads process.env.BUN_OPTIONS
    const prevBunOptions = process.env.BUN_OPTIONS
    try {
      delete process.env.BUN_OPTIONS
      expect(() => assertSafeExecArgv()).not.toThrow()

      process.env.BUN_OPTIONS = "--env-file=r2.env"
      expect(() => assertSafeExecArgv()).toThrow(BLEED)
    } finally {
      if (prevBunOptions === undefined) {
        delete process.env.BUN_OPTIONS
      } else {
        process.env.BUN_OPTIONS = prevBunOptions
      }
    }
  })

  test("Bun runtime contract: --no-env-file does NOT suppress explicit --env-file=X", () => {
    const dir = mkdtempSync(join(tmpdir(), "bun-env-preflight-"))
    const envPath = join(dir, "r2.env")
    try {
      writeFileSync(envPath, "PREFLIGHT_BLEED_PROBE=LEAKED_10000\n", "utf8")

      const proc = Bun.spawnSync(
        [
          "bun",
          "--no-env-file",
          `--env-file=${envPath}`,
          "-e",
          "process.stdout.write(process.env.PREFLIGHT_BLEED_PROBE ?? '')",
        ],
        { cwd: dir, env: { PATH: process.env.PATH ?? "" } },
      )
      expect(proc.exitCode).toBe(0)
      // Proves pairing --no-env-file with --env-file=X STILL leaks X in Bun 1.4.4,
      // confirming why any pairing exemption would be a security hole.
      expect(proc.stdout.toString("utf8")).toBe("LEAKED_10000")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
