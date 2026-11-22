/**
 * @file src/cli/preflight_guard.ts
 * @description Startup preflight guard preventing unintended `--env-file` token bleed
 * (`ERR_CF_TOKEN_BLEED_10000`) via `process.execArgv` or `process.env.BUN_OPTIONS`.
 *
 * Security invariant (empirically verified on Bun 1.4.4):
 * `--no-env-file` ONLY disables auto-loading `.env` / `.env.local`. Explicit
 * `--env-file=<path>` flags are ALWAYS loaded unconditionally by Bun regardless of
 * flag order or whether `--no-env-file` is present in `execArgv` or `BUN_OPTIONS`.
 *
 * Therefore `--no-env-file` NEVER exempts `--env-file`. Every `--env-file` flag
 * across both `execArgv` and `BUN_OPTIONS` is rejected fail-closed unless its exact
 * target path appears in an explicit `allowedEnvFiles` allowlist (default: empty).
 */

export const ERR_CF_TOKEN_BLEED_10000 = "ERR_CF_TOKEN_BLEED_10000"

export interface PreflightGuardOptions {
  /**
   * Explicit allowlist of permitted `--env-file` paths.
   * Defaults to empty (deny all `--env-file` flags).
   */
  readonly allowedEnvFiles?: ReadonlySet<string> | readonly string[] | undefined
  /**
   * Injectable runtime defaults used when `execArgv` or `bunOptions` arguments are omitted.
   * Defaults to `process.execArgv` and `process.env.BUN_OPTIONS`.
   */
  readonly runtime?: {
    readonly execArgv: readonly string[]
    readonly bunOptions?: string | undefined
  }
}

/**
 * Split a `BUN_OPTIONS` environment string into argv-like tokens, stripping simple
 * surrounding single/double quotes without invoking a shell.
 */
export function tokenizeBunOptions(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return []
  const tokens: string[] = []
  let cur = ""
  let quote: '"' | "'" | null = null

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        cur += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        tokens.push(cur)
        cur = ""
      }
      continue
    }
    cur += ch
  }
  if (cur.length > 0) tokens.push(cur)
  return tokens
}

function scanSourceForEnvFile(
  tokens: readonly string[],
  sourceName: "execArgv" | "BUN_OPTIONS",
  allowed: ReadonlySet<string>,
): void {
  // Deliberate fail-closed prefix scan across ALL tokens (including after `--` or
  // following value-taking flags) so parser edge cases fail safe rather than bypass.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!

    if (token === "--env-file") {
      const nextVal = tokens[i + 1]?.trim() ?? ""
      if (!nextVal || nextVal.startsWith("-") || !allowed.has(nextVal)) {
        throw new Error(
          `${ERR_CF_TOKEN_BLEED_10000}: disallowed --env-file in ${sourceName} (target: ${nextVal || "<missing>"})`,
        )
      }
      i += 1
      continue
    }

    if (token.startsWith("--env-file=")) {
      const val = token.slice("--env-file=".length).trim()
      if (!val || !allowed.has(val)) {
        throw new Error(
          `${ERR_CF_TOKEN_BLEED_10000}: disallowed --env-file in ${sourceName} (target: ${val || "<empty>"})`,
        )
      }
    }
  }
}

/**
 * Assert that neither `execArgv` nor `BUN_OPTIONS` injects an unallowlisted `--env-file`.
 *
 * When invoked with no arguments (`assertSafeExecArgv()`), reads `process.execArgv`
 * and `process.env.BUN_OPTIONS` directly.
 */
export function assertSafeExecArgv(
  execArgv?: readonly string[],
  bunOptions?: string,
  options?: PreflightGuardOptions,
): void {
  const runtimeExecArgv = options?.runtime?.execArgv ?? process.execArgv
  const runtimeBunOptions =
    options?.runtime !== undefined ? options.runtime.bunOptions : process.env.BUN_OPTIONS

  const effectiveExecArgv = execArgv ?? runtimeExecArgv
  const effectiveBunOptions = bunOptions !== undefined ? bunOptions : runtimeBunOptions

  const allowed =
    options?.allowedEnvFiles instanceof Set
      ? options.allowedEnvFiles
      : new Set(options?.allowedEnvFiles ?? [])

  // Scan each source independently; a `--no-env-file` in either source NEVER
  // neutralizes `--env-file` (verified on Bun 1.4.4: `--env-file` always wins).
  scanSourceForEnvFile(effectiveExecArgv, "execArgv", allowed)
  scanSourceForEnvFile(tokenizeBunOptions(effectiveBunOptions), "BUN_OPTIONS", allowed)
}
