/**
 * Browser-safe contracts & zero-password-retention sanitizers for Fantasy402 `getListAgenstByAgent`
 * (`{ EXTRA, GENERAL, PLAYERS }`) hierarchy and player-directory snapshots.
 *
 * @file Packages/contracts/src/agent_hierarchy.ts
 */

export const FANTASY402_RATE_FIELDS = [
  { rawKey: "HeadCountRateM", key: "headCountRateM", label: "Head Count / Mo" },
  { rawKey: "InetHeadCountRateM", key: "inetHeadCountRateM", label: "Inet Head Count" },
  { rawKey: "LiveBettingRateM", key: "liveBettingRateM", label: "Live Betting" },
  { rawKey: "LiveBetting2RateM", key: "liveBetting2RateM", label: "Live Betting 2" },
  { rawKey: "LiveCasinoRateM", key: "liveCasinoRateM", label: "Live Casino" },
  { rawKey: "CasinoHeadCountRateM", key: "casinoHeadCountRateM", label: "Casino Head Count" },
  { rawKey: "PropBuilderRateM", key: "propBuilderRateM", label: "Prop Builder" },
  { rawKey: "BetBuilderRate", key: "betBuilderRate", label: "Bet Builder" },
  { rawKey: "AmigoTechRate", key: "amigoTechRate", label: "Amigo Tech" },
  { rawKey: "CrashRate", key: "crashRate", label: "Crash" },
  { rawKey: "ExtPropsRate", key: "extPropsRate", label: "Ext Props" },
  { rawKey: "FantasyRate", key: "fantasyRate", label: "Fantasy" },
  { rawKey: "FlashBetsRate", key: "flashBetsRate", label: "Flash Bets" },
  { rawKey: "GitCasinoRate", key: "gitCasinoRate", label: "Git Casino" },
] as const

export type Fantasy402RateFieldKey = (typeof FANTASY402_RATE_FIELDS)[number]["key"]

export interface Fantasy402RateCard {
  readonly headCountRateM: number
  readonly inetHeadCountRateM: number
  readonly liveBettingRateM: number
  readonly liveBetting2RateM: number
  readonly liveCasinoRateM: number
  readonly casinoHeadCountRateM: number
  readonly propBuilderRateM: number
  readonly betBuilderRate: number
  readonly amigoTechRate: number
  readonly crashRate: number
  readonly extPropsRate: number
  readonly fantasyRate: number
  readonly flashBetsRate: number
  readonly gitCasinoRate: number
  readonly activeRateCount: number
  readonly totalMonthlyRateUsd: number
}

/**
 * Sanitized Fantasy402 player record. Security invariant: plaintext Password fields from upstream
 * `PLAYERS` are NEVER represented, stored, or serialized in this contract.
 */
export interface SanitizedFantasy402Player {
  readonly customerId: string
  readonly login: string
  readonly nameFirst: string
  readonly agentId: string
  readonly rootMasterAgent: string | null
}

export interface AgentHierarchyNodeRecord {
  readonly agentId: string
  readonly login: string
  readonly seqNumber: number | null
  readonly level: number
  readonly agentType: "M" | "A" | string
  readonly parentAgentId: string | null
  readonly rootMasterAgent: string
  readonly ancestors: readonly string[]
  readonly directChildCount: number
  readonly descendantCount: number
  readonly playerCount: number
  readonly rateCard: Fantasy402RateCard | null
  readonly hasPunctuationCollision: boolean
}

export interface AgentHierarchyCollisionGroup {
  readonly canonicalKey: string
  readonly agentIds: readonly string[]
}

export interface AgentHierarchyDirectorySummary {
  readonly source: "baseline-disk" | "ingested-f402"
  readonly sourceLabel: string
  readonly ingestedAt: string | null
  readonly extraFlag: boolean | null
  readonly totalAgents: number
  readonly masterCount: number
  readonly subAgentCount: number
  readonly maxDepth: number
  readonly rootCount: number
  readonly roots: readonly string[]
  readonly totalPlayers: number
  readonly mappedPlayers: number
  readonly orphanPlayers: number
  readonly orphanAgentIds: readonly string[]
  readonly passwordsStripped: number
  readonly collisionCount: number
  readonly collisions: readonly AgentHierarchyCollisionGroup[]
  readonly levelCounts: Readonly<Record<string, number>>
  readonly activeRateAgentsCount: number
}

export interface AgentHierarchyDirectoryResponse {
  readonly schemaVersion: 1
  readonly summary: AgentHierarchyDirectorySummary
  readonly nodes: readonly AgentHierarchyNodeRecord[]
  readonly totalMatchedNodes: number
  readonly players: readonly SanitizedFantasy402Player[]
  readonly totalMatchedPlayers: number
  readonly limit: number
  readonly offset: number
  readonly observedAt: string
}

export interface AgentHierarchyIngestResponse {
  readonly ok: true
  readonly schemaVersion: 1
  readonly ingestedAgents: number
  readonly ingestedPlayers: number
  readonly passwordsStripped: number
  readonly warnings: readonly string[]
  readonly summary: AgentHierarchyDirectorySummary
}

const SENSITIVE_PLAYER_KEY_RE = /^(?:password|passwd|pwd|pass|pin|secret|token)$/i

/**
 * Strip sensitive password keys from a parsed Fantasy402 payload object before transmission or
 * storage. Never mutates the original input; returns a cloned sanitized structure plus exact count
 * of stripped credential fields.
 */
export function stripSensitiveFieldsFromFantasy402Object(input: unknown): {
  readonly sanitized: unknown
  readonly passwordsStripped: number
} {
  let passwordsStripped = 0

  const sanitizeRow = (row: unknown): unknown => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
      if (SENSITIVE_PLAYER_KEY_RE.test(k.trim())) {
        if (v !== undefined && v !== null) {
          passwordsStripped += 1
        }
        continue
      }
      out[k] = v
    }
    return out
  }

  if (Array.isArray(input)) {
    return {
      sanitized: input.map(sanitizeRow),
      passwordsStripped,
    }
  }

  if (!input || typeof input !== "object") {
    return { sanitized: input, passwordsStripped: 0 }
  }

  const record = input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(record)) {
    if (SENSITIVE_PLAYER_KEY_RE.test(key.trim())) {
      passwordsStripped += 1
      continue
    }
    if (
      (key === "PLAYERS" || key === "players" || key === "GENERAL" || key === "general") &&
      Array.isArray(val)
    ) {
      out[key] = val.map(sanitizeRow)
    } else {
      out[key] = val
    }
  }

  return { sanitized: out, passwordsStripped }
}

/**
 * Client-side pre-flight sanitizer for pasted JSON text: parses JSON if valid and strips all
 * `PLAYERS[].Password` (and sensitive variants) BEFORE the payload ever crosses the network. Falls
 * back to line-level regex stripping if the text is not valid JSON so raw passwords are never sent
 * over the wire.
 */
export function sanitizeFantasy402RawTextBeforeUpload(rawText: string): {
  readonly sanitizedText: string
  readonly passwordsStripped: number
  readonly parsedAsJson: boolean
} {
  const trimmed = rawText.trim()
  if (!trimmed) {
    return { sanitizedText: "", passwordsStripped: 0, parsedAsJson: false }
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    const { sanitized, passwordsStripped } = stripSensitiveFieldsFromFantasy402Object(parsed)
    return {
      sanitizedText: JSON.stringify(sanitized),
      passwordsStripped,
      parsedAsJson: true,
    }
  } catch {
    let strippedCount = 0
    const sanitizedText = trimmed.replace(
      /["']?(?:Password|password|passwd|pwd|secret|token)["']?\s*:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}\]]+)/g,
      () => {
        strippedCount += 1
        return '"Password":"[STRIPPED]"'
      },
    )
    return {
      sanitizedText,
      passwordsStripped: strippedCount,
      parsedAsJson: false,
    }
  }
}

/** Compute active non-zero rate entries for compact UI/terminal rendering. */
export function getActiveRateEntries(rateCard: Fantasy402RateCard | null | undefined): readonly {
  readonly label: string
  readonly key: Fantasy402RateFieldKey
  readonly value: number
}[] {
  if (!rateCard) return []
  const entries: { label: string; key: Fantasy402RateFieldKey; value: number }[] = []
  for (const field of FANTASY402_RATE_FIELDS) {
    const val = rateCard[field.key]
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      entries.push({ label: field.label, key: field.key, value: val })
    }
  }
  return entries
}
