/** Static terminal command vocabulary for the dashboard. */
import { ALLOWED_TERMINAL_COMMAND_HEADS } from "@sportsdesk-ops/contracts"

/** Palette grouping; mirrors the Terminal tab's category filter plus utilities. */
export type TerminalCommandGroup = "SHARPS" | "DOWNLINES" | "RISK" | "NET" | "UTILITY"

export interface TerminalCommandSpec {
  readonly command: string
  readonly usage: string
  readonly description: string
  readonly group: TerminalCommandGroup
  readonly aliases: readonly string[]
}

const commandSpecs: readonly TerminalCommandSpec[] = [
  {
    command: "profile",
    usage: "profile <id> [--radar] [--wagers] [--weblogs] [--depth=N] [--options]",
    description: "Inspect one customer profile",
    group: "SHARPS",
    aliases: ["p", "c"],
  },
  {
    command: "profiles",
    usage: "profiles [--sort=score] [--tier=T1] [--table] [--options]",
    description: "Inspect the retained customer cohort",
    group: "SHARPS",
    aliases: ["cohort"],
  },
  {
    command: "wagers",
    usage: "wagers",
    description: "Summarize the active wager feed",
    group: "RISK",
    aliases: [],
  },
  {
    command: "weblogs",
    usage: "weblogs [--table] [--json] [--options]",
    description: "Inspect retained web access events",
    group: "RISK",
    aliases: ["ip-logs"],
  },
  {
    command: "weblog-vectors",
    usage: "weblog-vectors",
    description: "Summarize retained web access patterns",
    group: "RISK",
    aliases: ["vectors"],
  },
  {
    command: "block-log",
    usage: "block-log",
    description: "Read recorded blocks and rate limits",
    group: "RISK",
    aliases: ["blocks"],
  },
  {
    command: "events",
    usage: "events",
    description: "View recorded Fantasy402 events",
    group: "RISK",
    aliases: ["f402-events", "event-log"],
  },
  {
    command: "overview",
    usage: "overview",
    description: "Summarize recorded Fantasy402 activity",
    group: "RISK",
    aliases: ["f402-overview", "desk"],
  },
  {
    command: "table",
    usage: "table",
    description: "Inspect the live wager table",
    group: "RISK",
    aliases: ["inspect-table"],
  },
  {
    command: "who",
    usage: "who",
    description: "Show desk runtime information",
    group: "NET",
    aliases: ["w", "status"],
  },
  {
    command: "tiers",
    usage: "tiers",
    description: "Show configured tier thresholds",
    group: "SHARPS",
    aliases: [],
  },
  {
    command: "dns",
    usage: "dns",
    description: "Show resolver telemetry and monitored endpoints",
    group: "NET",
    aliases: [],
  },
  {
    command: "features",
    usage: "features",
    description: "Show active runtime feature flags",
    group: "NET",
    aliases: [],
  },
  {
    command: "cron",
    usage: "cron <expression>",
    description: "Describe a cron expression",
    group: "NET",
    aliases: ["cr"],
  },
  {
    command: "inspect-options",
    usage: "inspect-options [--depth=N] [--no-color]",
    description: "Show resolved inspection settings",
    group: "NET",
    aliases: ["options", "--options"],
  },
  {
    command: "clear",
    usage: "clear",
    description: "Clear this terminal transcript",
    group: "UTILITY",
    aliases: [],
  },
  {
    command: "help",
    usage: "help",
    description: "Show the terminal command reference",
    group: "UTILITY",
    aliases: ["h"],
  },
]

export const TERMINAL_COMMAND_SPECS = commandSpecs
  .filter(({ command }) => command === "clear" || ALLOWED_TERMINAL_COMMAND_HEADS.has(command))
  .map((spec) => ({
    ...spec,
    aliases: spec.aliases.filter((alias) => ALLOWED_TERMINAL_COMMAND_HEADS.has(alias)),
  }))

/**
 * Canonical commands first, then shortcodes: `handleAutocomplete` uses
 * `startsWith` order, so a prefix that names a command must not be shadowed by
 * a shortcode defined earlier in the list.
 */
export const CLIENT_AUTOCOMPLETE_COMMANDS: readonly string[] = [
  ...new Set([
    ...TERMINAL_COMMAND_SPECS.map((spec) => spec.command),
    ...TERMINAL_COMMAND_SPECS.flatMap((spec) => spec.aliases),
  ]),
]

/** One palette row: the matched command, its usage and why it matched. */
export interface TerminalCommandSuggestion {
  readonly command: string
  readonly usage: string
  readonly description: string
  readonly group: TerminalCommandGroup
  /** Shortcode the query matched, when it did not match the command name. */
  readonly viaAlias: string | null
}

export const TERMINAL_SUGGESTION_LIMIT = 6

/**
 * Inline palette suggestions for the token being typed. Returns nothing once
 * the operator has started on arguments (a space is present) or has typed a
 * complete canonical command, so the palette neither covers the output nor
 * captures the ↑/↓ history keys while a real command is being composed.
 */
export function suggestTerminalCommands(
  rawInput: string,
  limit: number = TERMINAL_SUGGESTION_LIMIT,
): readonly TerminalCommandSuggestion[] {
  if (limit <= 0) return []
  const input = rawInput.trim().toLowerCase()
  if (input.length === 0 || /\s/.test(input)) return []
  if (TERMINAL_COMMAND_SPECS.some((spec) => spec.command.toLowerCase() === input)) {
    return []
  }

  const scored: {
    readonly spec: TerminalCommandSpec
    readonly score: number
    readonly viaAlias: string | null
  }[] = []

  for (const spec of TERMINAL_COMMAND_SPECS) {
    const command = spec.command.toLowerCase()
    if (command.startsWith(input)) {
      scored.push({ spec, score: 0, viaAlias: null })
      continue
    }
    const prefixAlias = spec.aliases.find((alias) => alias.toLowerCase().startsWith(input))
    if (prefixAlias !== undefined) {
      scored.push({ spec, score: 1, viaAlias: prefixAlias })
      continue
    }
    if (command.includes(input)) {
      scored.push({ spec, score: 2, viaAlias: null })
      continue
    }
    const innerAlias = spec.aliases.find((alias) => alias.toLowerCase().includes(input))
    if (innerAlias !== undefined) {
      scored.push({ spec, score: 3, viaAlias: innerAlias })
    }
  }

  scored.sort(
    (a, b) =>
      a.score - b.score ||
      a.spec.command.length - b.spec.command.length ||
      a.spec.command.localeCompare(b.spec.command),
  )

  return scored.slice(0, limit).map(({ spec, viaAlias }) => ({
    command: spec.command,
    usage: spec.usage,
    description: spec.description,
    group: spec.group,
    viaAlias,
  }))
}

export const TERMINAL_INITIAL_COMMANDS = ["help", "profiles", "weblogs", "inspect-options"]

export const TERMINAL_WELCOME_HELP_STDOUT = [
  "SportsDesk Ops Surveillance Terminal",
  "Type `help` or pick a command below:",
  ...TERMINAL_COMMAND_SPECS.map((spec) => `  ${spec.usage.padEnd(44)} ${spec.description}`),
].join("\n")

