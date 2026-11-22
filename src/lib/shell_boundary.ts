/**
 * @file src/lib/shell_boundary.ts
 * @description L1 boundary module unifying:
 *  1. Strict Bun.Terminal / operator command + flag validation (no shell metacharacters,
 *     globs, quotes, subshells, or unallowlisted CLI flag injection).
 *  2. Bun.$ & subprocess guardrails (banning `{ raw }`, `sh -c`/`bash -c`, and
 *     unguarded `--flag` positional operand injection).
 *  3. Bun Profile (`ProfileTheme`) <-> Bun.Terminal PTY dimension & inspect bridging.
 */

import { DEFAULT_PROFILE_THEME, type ProfileTheme } from "../profile/types.ts"

export type ShellBoundaryErrorCode =
  | "ERR_SHELL_RAW_FORBIDDEN"
  | "ERR_SHELL_SUBSHELL_FORBIDDEN"
  | "ERR_SHELL_METACHAR_FORBIDDEN"
  | "ERR_SHELL_FLAG_INJECTION"
  | "ERR_SHELL_NULL_BYTE"

export class ShellBoundaryError extends Error {
  readonly code: ShellBoundaryErrorCode

  constructor(code: ShellBoundaryErrorCode, message: string) {
    super(message.includes(code) ? message : `${code}: ${message}`)
    this.name = "ShellBoundaryError"
    this.code = code
  }
}

export const MAX_TERMINAL_CMD_LEN = 256

/**
 * Canonical allowlist of read-only desk terminal command heads.
 * Shared by HTTP auth, API router, and terminal query engine.
 */
export const ALLOWED_TERMINAL_COMMAND_HEADS = new Set<string>([
  "help",
  "h",
  "who",
  "w",
  "status",
  "profile",
  "p",
  "c",
  "cust",
  "lookup",
  "profiles",
  "cohort",
  "customers",
  "profile-list",
  "find",
  "f",
  "s",
  "q",
  "search",
  "query",
  "harvest",
  "hv",
  "anomalies",
  "sharps",
  "sh",
  "sharp",
  "top",
  "leaderboard",
  "syndicates",
  "syn",
  "hook",
  "hooks",
  "key-numbers",
  "k",
  "key",
  "keys",
  "keynumbers",
  "gini",
  "g",
  "rankings",
  "rank",
  "ranks",
  "rank-all",
  "rk",
  "conduits",
  "proxies",
  "proxy",
  "subagents",
  "sa",
  "subagent",
  "trunks",
  "trunk",
  "trees",
  "t",
  "directives",
  "dir",
  "dirs",
  "limits",
  "risk",
  "var",
  "cvar",
  "forensics",
  "stats",
  "stat",
  "summary",
  "bursts",
  "burst",
  "steam",
  "b",
  "quarantine",
  "guard",
  "quar",
  "burst-guard",
  "wagers",
  "weblogs",
  "weblog",
  "ip-logs",
  "weblog-vectors",
  "vectors",
  "log-vectors",
  "block-log",
  "blocks",
  "blocklog",
  "events",
  "f402-events",
  "event-log",
  "overview",
  "f402-overview",
  "desk",
  "table",
  "inspect-table",
  "inspect-options",
  "options",
  "--options",
  "tiers",
  "ws",
  "subscriptions",
  "dns",
  "d",
  "reverse",
  "r",
  "rev",
  "ip",
  "capabilities",
  "caps",
  "features",
  "markdown",
  "md",
  "keybindings",
  "kb",
  "keyshelp",
  "cron",
  "cr",
])

/**
 * Explicit allowlist of CLI flags permitted inside operator terminal commands.
 * Prevents arbitrary `--flag` smuggling even inside read-only terminal queries.
 */
export const ALLOWED_TERMINAL_FLAGS = new Set<string>([
  "--depth",
  "-d",
  "--max-array",
  "--max-array-length",
  "--limit",
  "--max-string",
  "--max-string-length",
  "--break-length",
  "--width",
  "--columns",
  "--linkify-symbols",
  "--sort",
  "--dir",
  "--asc",
  "--ip",
  "--kind",
  "--market",
  "--account",
  "--tier",
  "--type",
  "--tag",
  "--q",
  "--theme",
  "-t",
  "-s",
  "-a",
  "--options",
  "--inspect-options",
  "--colors",
  "--color",
  "--no-color",
  "--no-colors",
  "--plain",
  "--compact",
  "--no-compact",
  "--sorted",
  "--no-sorted",
  "--show-hidden",
  "--hidden",
  "--numeric-separator",
  "--numeric-sep",
  "--getters",
  "--radar",
  "--table",
  "--json",
  "--wagers",
  "--weblogs",
  "--help",
  "-h",
])

/**
 * Base metacharacters forbidden everywhere (pipes, chains, redirections,
 * backticks, variable substitution, quotes, subshells, braces, brackets, globs, tilde, history, NUL/CRLF).
 */
export const SHELL_METACHAR_RE = /[;|&`$><\r\n\0\\"'\(\){}\[\]?~!]/

const CRON_FIELD_RE = /^[0-9*/,-]+$/

export type TerminalCommandValidationResult =
  | { readonly ok: true; readonly command: string; readonly head: string }
  | { readonly ok: false; readonly error: string }

/**
 * Validates an operator terminal command against length, shell metacharacters,
 * command-head allowlist, and CLI flag allowlist rules.
 */
export function validateTerminalCommand(rawCommand: unknown): TerminalCommandValidationResult {
  if (typeof rawCommand !== "string") {
    return { ok: false, error: "Command must be a string" }
  }
  const trimmed = rawCommand.trim()
  if (!trimmed) {
    return { ok: true, command: "help", head: "help" }
  }
  if (trimmed.length > MAX_TERMINAL_CMD_LEN) {
    return {
      ok: false,
      error: `Command exceeds maximum length of ${MAX_TERMINAL_CMD_LEN} characters`,
    }
  }
  if (SHELL_METACHAR_RE.test(trimmed)) {
    return {
      ok: false,
      error: "Shell metacharacters and control characters are prohibited",
    }
  }

  const tokens = trimmed.split(/\s+/)
  const head = (tokens[0] ?? "").toLowerCase()
  if (!ALLOWED_TERMINAL_COMMAND_HEADS.has(head)) {
    return {
      ok: false,
      error: `Command '${head}' is not on the operator allowlist`,
    }
  }

  const isCron = head === "cron" || head === "cr"
  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i]!
    if (tok.includes("*")) {
      if (!isCron || !CRON_FIELD_RE.test(tok)) {
        return {
          ok: false,
          error: "Wildcard '*' is permitted only inside cron schedule fields",
        }
      }
      continue
    }

    if (tok.startsWith("-")) {
      const eqIdx = tok.indexOf("=")
      const flagName = (eqIdx === -1 ? tok : tok.slice(0, eqIdx)).toLowerCase()
      if (!ALLOWED_TERMINAL_FLAGS.has(flagName)) {
        return {
          ok: false,
          error: `Flag '${flagName}' is not on the operator terminal flag allowlist`,
        }
      }
    }
  }

  return { ok: true, command: trimmed, head }
}

const DISALLOWED_SHELL_BINARIES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "ash",
  "csh",
  "tcsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
])

function basenameLower(binary: string): string {
  const parts = binary.split(/[/\\]/)
  return (parts[parts.length - 1] ?? binary).toLowerCase()
}

export interface SafeSpawnArgvOptions {
  /**
   * When true, requires positional operand arguments after any flags to be preceded
   * by `--` (preventing `--upload-pack` / `-oProxyCommand` flag smuggling).
   */
  readonly requireDoubleDashBeforeOperands?: boolean
  /** Minimum index where user-supplied positional operands start (default: 1). */
  readonly operandStartIndex?: number
}

/**
 * Runtime guard for `Bun.spawn` / `execFileSync` argument arrays:
 * blocks nested shell invocations (`sh -c`, `bash -c`, `cmd /c`), NUL bytes,
 * and optional unguarded `--flag` smuggling in positional operands.
 */
export function assertSafeSpawnArgv(
  argv: readonly string[],
  options: SafeSpawnArgvOptions = {},
): readonly string[] {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new ShellBoundaryError(
      "ERR_SHELL_SUBSHELL_FORBIDDEN",
      "Spawn argv must be a non-empty array.",
    )
  }

  for (const arg of argv) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      throw new ShellBoundaryError(
        "ERR_SHELL_NULL_BYTE",
        "Spawn argv cannot contain NUL bytes or non-string arguments.",
      )
    }
  }

  const bin = basenameLower(argv[0]!)
  if (DISALLOWED_SHELL_BINARIES.has(bin)) {
    const hasInlineExec = argv.slice(1).some((a) => /^(-c|-lc|-ic|\/c|-command)$/i.test(a))
    if (hasInlineExec || argv.length > 1) {
      throw new ShellBoundaryError(
        "ERR_SHELL_SUBSHELL_FORBIDDEN",
        `Direct system shell invocation '${argv[0]}' is forbidden.`,
      )
    }
  }

  if (options.requireDoubleDashBeforeOperands) {
    const startIdx = options.operandStartIndex ?? 1
    const doubleDashIdx = argv.indexOf("--")
    if (doubleDashIdx === -1 || doubleDashIdx < startIdx) {
      for (let i = startIdx; i < argv.length; i += 1) {
        if (argv[i]!.startsWith("-")) {
          throw new ShellBoundaryError(
            "ERR_SHELL_FLAG_INJECTION",
            `Positional operand '${argv[i]}' starts with '-' without an explicit '--' separator.`,
          )
        }
      }
    }
  }

  return argv
}

export interface UnsafeShellFinding {
  readonly code: "ERR_SHELL_RAW_FORBIDDEN" | "ERR_SHELL_SUBSHELL_FORBIDDEN"
  readonly line: number
  readonly snippet: string
}

const RAW_INTERPOLATION_RE = /\$\{\s*\{\s*raw\s*:/
const SHELL_TRUE_RE = /\bshell\s*:\s*true\b/
const SH_C_SUBSHELL_RE = /\b(?:sh|bash|zsh|dash|ksh|ash)\b[^;\n]*?\s-[a-zA-Z]*c\b/

/**
 * Static audit scanner detecting `Bun.$` `{ raw: ... }` escaping bypasses,
 * `shell: true` subprocess spawns, and `sh -c`/`bash -c` handoffs.
 */
export function scanSourceForUnsafeShellPatterns(
  sourceText: string,
): readonly UnsafeShellFinding[] {
  const findings: UnsafeShellFinding[] = []
  const lines = sourceText.split("\n")

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!
    const trimmed = line.trim()
    // Skip pure comment lines so doc warnings do not trigger false positives
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue
    }

    if (RAW_INTERPOLATION_RE.test(line)) {
      findings.push({
        code: "ERR_SHELL_RAW_FORBIDDEN",
        line: i + 1,
        snippet: trimmed.slice(0, 120),
      })
    }
    if (SHELL_TRUE_RE.test(line) || SH_C_SUBSHELL_RE.test(line)) {
      findings.push({
        code: "ERR_SHELL_SUBSHELL_FORBIDDEN",
        line: i + 1,
        snippet: trimmed.slice(0, 120),
      })
    }
  }

  return findings
}

export interface ResolvedProfileTerminalOptions {
  readonly cols: number
  readonly rows: number
  readonly inspect: {
    readonly colors: boolean
    readonly compact: boolean
    readonly depth: number
    readonly sorted: boolean
    readonly breakLength: number
  }
  readonly terminal: {
    readonly colors: boolean
    readonly light: "light" | "dark" | "auto"
    readonly hyperlinks: boolean
    readonly columns: number
    readonly kittyGraphics: boolean
    readonly colorDepth: ProfileTheme["colorDepth"]
  }
}

function clampBoundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value)))
}

/**
 * Safely bridges a session's `ProfileTheme` with bounded `Bun.Terminal` PTY
 * dimensions and `Bun.inspect` / `Bun.markdown.ansi` options.
 */
export function resolveProfileTerminalOptions(
  profileTheme?: ProfileTheme,
  dims?: { readonly cols?: number; readonly rows?: number },
): ResolvedProfileTerminalOptions {
  const theme = profileTheme ?? DEFAULT_PROFILE_THEME
  const profileCols =
    theme.terminal.columns > 0 ? clampBoundedInt(theme.terminal.columns, 80, 40, 240) : 100
  const cols = clampBoundedInt(dims?.cols, profileCols, 40, 240)
  const rows = clampBoundedInt(dims?.rows, 30, 12, 100)
  const depth = clampBoundedInt(theme.inspect.depth, 4, 0, 6)

  return {
    cols,
    rows,
    inspect: {
      colors: Boolean(theme.inspect.colors && theme.terminal.colors),
      compact: Boolean(theme.inspect.compact),
      depth,
      sorted: Boolean(theme.inspect.sorted),
      breakLength: clampBoundedInt(cols, 96, 56, 160),
    },
    terminal: {
      colors: Boolean(theme.terminal.colors),
      light: theme.terminal.light,
      hyperlinks: Boolean(theme.terminal.hyperlinks),
      columns: cols,
      kittyGraphics: Boolean(theme.terminal.kittyGraphics),
      colorDepth: theme.colorDepth,
    },
  }
}

/**
 * Builds scrubbed, dimension-bounded options for `Bun.Terminal` PTY spawning
 * (never forwarding `BUN_OPTIONS` or server secret env vars into child PTYs).
 */
export function buildBunTerminalSpawnOptions(options: {
  readonly profileTheme?: ProfileTheme
  readonly cols?: number
  readonly rows?: number
  readonly cwd?: string
}): {
  readonly cols: number
  readonly rows: number
  readonly cwd?: string
  readonly env: Record<string, string>
} {
  const resolved = resolveProfileTerminalOptions(options.profileTheme, {
    cols: options.cols,
    rows: options.rows,
  })

  const colorTerm =
    resolved.terminal.colorDepth === "ansi-16m"
      ? "truecolor"
      : resolved.terminal.colorDepth === "ansi-256"
        ? "256color"
        : "truecolor"

  const env: Record<string, string> = {
    TERM: resolved.terminal.colors ? "xterm-256color" : "dumb",
    COLORTERM: resolved.terminal.colors ? colorTerm : "",
    COLUMNS: String(resolved.cols),
    LINES: String(resolved.rows),
    NO_COLOR: resolved.terminal.colors ? "" : "1",
  }

  if (resolved.terminal.light === "light") {
    env.COLORFGBG = "0;15"
  } else if (resolved.terminal.light === "dark") {
    env.COLORFGBG = "15;0"
  }

  return {
    cols: resolved.cols,
    rows: resolved.rows,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env,
  }
}
