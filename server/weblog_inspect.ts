import { isIP } from "node:net"

import {
  type ParsedParlayLeg,
  WEBLOG_OPERATIONS,
  WEBLOG_SEVERITY_RULES,
  type WebLogClientSummary,
  type WebLogEvent,
  type WebLogEventKind,
  type WebLogSeverity,
} from "@sportsdesk-ops/contracts"

import { redactIpToSubnetHash } from "../lib/http_auth.ts"
/**
 * Bun.inspect.custom Weblogs parser, IP forensics classifier, multi-field detail sorter, and 6-axis
 * behavioral vectoring & cosine similarity clustering engine for Fantasy402 / SportsDesk
 * surveillance logs.
 *
 * @file Server/weblog_inspect.ts
 */
import { parseShortDesc } from "../lib/live_wagers.ts"
import { parseParlayLegs, readParlayOperation } from "../lib/parlay_description.ts"
import {
  type BunInspectOptions,
  DeskView,
  formatInspectCliFlags,
  formatInspectNumber,
  formatInspectOptionsObject,
  inspectDeskValue,
  inspectTable,
  renderInspectOptionsBanner,
  type ResolvedBunInspectOptions,
  resolveInspectOptions,
  truncateVisible,
} from "./desk_inspect.ts"
import type { RetainedWeblogRow } from "./profile_weblog_evidence.ts"

export type WebLogSortField =
  | "time"
  | "severity"
  | "ip"
  | "ipCategory"
  | "ipFamily"
  | "account"
  | "gameId"
  | "botKey"
  | "event"
  | "period"
  | "market"
  | "pick"
  | "kind"
  | "cadence"
  | "score"

export type WebLogSortDir = "asc" | "desc"

export interface ParsedBotKey {
  readonly rawKey: string
  readonly prefix: string
  readonly gameId: string
  readonly periodCode: string
  readonly periodLabel: string
  readonly marketCode: string
  readonly marketLabel: string
  readonly sideCode: string
  readonly sideLabel: string
  readonly seq: number
}

export type WebLogIpFamily = "IPv4" | "IPv6" | "Unknown"

export interface ParsedWebLogActionMeta {
  readonly ticketId?: string | null
  readonly gameId?: string | null
  readonly riskUsd?: number | null
  readonly winUsd?: number | null
  readonly limitUsd?: number | null
  readonly attemptedUsd?: number | null
  readonly channel?: "mobile" | "desktop" | null
  readonly selectionSummary?: string | null
}

export interface WebLogIpMeta {
  /** A redacted IPv4 /24 or IPv6 /48 plus a keyed address hash. */
  readonly family: WebLogIpFamily
  readonly ip: string
  readonly subnet24: string
  readonly ipHash?: string | undefined
  readonly classification: "PRIVATE" | "UNMEASURED"
  readonly asnLabel: string
}

export interface WebLogSelection {
  readonly source: "bot-key" | "chosen-team" | "bet-description"
  readonly gameId: string | null
  readonly period: string | null
  readonly market: string | null
  readonly pick: string | null
  readonly listedNumber?: string
}

export interface WebLogEntry {
  readonly id: string
  readonly dateLabel: string
  readonly timeEst: string
  /** Provider wall time with its original fractional precision. */
  readonly sourceTime: string | null
  /** Encoded wall time for ordering and cadence. The capture omits an offset. */
  readonly sourceSortMs: number
  /** UTC epoch based on the source clock or explicit timestamp offset. */
  readonly epochMs: number
  readonly ip: string
  readonly ipMeta: WebLogIpMeta
  readonly rawAction: string
  readonly event: WebLogEvent
  readonly eventKind: WebLogEventKind
  readonly accountId: string
  readonly botKey: ParsedBotKey | null
  readonly selection: WebLogSelection | null
  readonly parlayLegs?: readonly ParsedParlayLeg[]
  readonly ticketNumber: string | null

  readonly gameId?: string | null
  readonly ticketId?: string | null
  readonly actionMeta?: ParsedWebLogActionMeta | null
  readonly clientVersion: string | null
  readonly portalHost: string | null
  readonly deviceMarker: "M" | "D" | null
  readonly apiMarked: boolean
  readonly interArrivalSec: number | null
  readonly vectorScore: number
  readonly severity: WebLogSeverity
  readonly clusterLabel: string
  readonly source: "capture" | "ingested"
}

export interface WebLogVectorAxes {
  readonly blockRatio: number
  readonly burstCadence: number
  readonly cadenceRegularity: number
  readonly gameConcentration: number
  readonly tokenChurn: number
  readonly marketSpread: number
}

export interface WebLogVectorProfile {
  readonly vectorId: string
  readonly ip: string
  readonly subnet24: string
  readonly ipMeta: WebLogIpMeta
  readonly accountId: string
  readonly eventCount: number
  readonly blockCount: number
  readonly loginCount: number
  readonly tokenCount: number
  readonly uniqueGames: readonly string[]
  readonly uniqueBotKeys: readonly string[]
  readonly medianCadenceSec: number | null
  readonly minCadenceSec: number | null
  readonly axes: WebLogVectorAxes
  readonly vector: readonly [number, number, number, number, number, number]
  readonly botScore: number
  readonly archetype: string
  readonly severity: WebLogSeverity
}

export interface WebLogCosinePair {
  readonly leftId: string
  readonly rightId: string
  readonly leftIp: string
  readonly rightIp: string
  readonly leftAccount: string
  readonly rightAccount: string
  readonly cosine: number
  readonly sharedGames: readonly string[]
  readonly verdict: string
}

export interface WebLogQueryOptions extends BunInspectOptions {
  readonly sort?: WebLogSortField
  readonly dir?: WebLogSortDir
  readonly ip?: string
  readonly ipFamily?: string
  readonly limit?: number
  readonly offset?: number
  readonly kind?: string
  readonly site?: string
  readonly version?: string
  readonly market?: string
  readonly account?: string
  readonly severity?: string
  readonly q?: string
  readonly showOptions?: boolean
  readonly captureOnly?: boolean
}

export interface WebLogQueryResult {
  readonly source: "retained-mode-a" | "operator-import" | "mixed" | "unavailable"
  readonly entries: readonly WebLogEntry[]
  readonly page: { readonly offset: number; readonly nextOffset: number | null }
  readonly vectors: readonly WebLogVectorProfile[]
  readonly cosinePairs: readonly WebLogCosinePair[]
  readonly availableIps: readonly string[]
  readonly availableAccounts: readonly string[]
  readonly kinds: readonly { readonly kind: WebLogEventKind; readonly count: number }[]
  readonly clients: WebLogClientSummary
  readonly summary: {
    readonly totalEntries: number
    readonly filteredEntries: number
    readonly uniqueIps: number
    readonly uniqueSubnets: number
    readonly botBlockCount: number
    readonly loginEventCount: number
    readonly medianBotCadenceSec: number | null
    readonly peakBotScore: number
    readonly correlatedPairsCount: number
    readonly severityCounts: {
      readonly CRITICAL: number
      readonly HIGH: number
      readonly WATCH: number
      readonly NORMAL: number
    }
  }
  readonly inspectAnsi: string
  readonly vectorInspectAnsi: string
  readonly tableInspectAnsi: string
  readonly resolvedOptions: ResolvedBunInspectOptions
  readonly optionsJsLiteral: string
  readonly cliFlags: string
  readonly generatedAt: string
}

const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  boldCyan: "\x1b[1;36m",
  boldYellow: "\x1b[1;33m",
  boldGreen: "\x1b[1;32m",
  boldRed: "\x1b[1;31m",
  boldMagenta: "\x1b[1;35m",
  boldWhite: "\x1b[1;37m",
} as const

function paint(text: string, code: string, colors: boolean): string {
  return colors ? `${code}${text}${ANSI.reset}` : text
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*m/g, "")
}

function padVisibleEnd(input: string, width: number): string {
  const diff = width - stripAnsi(input).length
  return diff > 0 ? input + " ".repeat(diff) : input
}

// ── IP Classification & Subnet Forensics ─────────────────────────────────────

export function classifyIpNetwork(ip: string): WebLogIpMeta {
  const clean = ip.trim()
  const addressFamily = isIP(clean)
  const { redacted, subnet24, hash } = redactIpToSubnetHash(addressFamily ? clean : "unknown")

  const privateNetwork =
    /^(?:10\.|127\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i.test(clean)
  return {
    family: addressFamily === 4 ? "IPv4" : addressFamily === 6 ? "IPv6" : "Unknown",
    ip: redacted,
    subnet24,
    ipHash: hash,
    classification: privateNetwork ? "PRIVATE" : "UNMEASURED",
    asnLabel: privateNetwork ? "Private or loopback address" : "ASN unmeasured",
  }
}

// ── Fantasy402 Bot Key & Action Parsers ──────────────────────────────────────

export function parseBotBlockKey(rawKey: string): ParsedBotKey | null {
  const trimmed = rawKey.trim()
  // Format observed in Fantasy402 weblogs:
  // bot_619135665_0_S__0   -> game=619135665, period=0 (FG), market=S (Spread), side=""
  // bot_619136474_1_L_O_0  -> game=619136474, period=1 (1H), market=L (Total), side=O (Over)
  // bot_619137349_0_L_U_0  -> game=619137349, period=0 (FG), market=L (Total), side=U (Under)
  const m = /^(bot)_(\d+)_(\d+)_([A-Z]+)_([A-Z]*)_(\d+)$/.exec(trimmed)
  if (!m) return null

  const prefix = m[1]!
  const gameId = m[2]!
  const periodCode = m[3]!
  const marketCode = m[4]!
  const sideCode = m[5] ?? ""
  const seq = Number.parseInt(m[6]!, 10) || 0

  const periodLabel =
    periodCode === "0"
      ? "FG"
      : periodCode === "1"
        ? "1H"
        : periodCode === "2"
          ? "2H"
          : `P${periodCode}`

  const marketLabel =
    marketCode === "S"
      ? "Spread"
      : marketCode === "L"
        ? "Total"
        : marketCode === "M"
          ? "Moneyline"
          : marketCode

  const sideLabel =
    sideCode === "O"
      ? "Over"
      : sideCode === "U"
        ? "Under"
        : sideCode === "H"
          ? "Home"
          : sideCode === "A"
            ? "Away"
            : sideCode

  return {
    rawKey: trimmed,
    prefix,
    gameId,
    periodCode,
    periodLabel,
    marketCode,
    marketLabel,
    sideCode,
    sideLabel,
    seq,
  }
}

// Retain only the fields identified by the provider's operation grammar.
function parseWebLogSelection(
  operation: string,
  botKey: ParsedBotKey | null,
): WebLogSelection | null {
  if (botKey) {
    return {
      source: "bot-key",
      gameId: botKey.gameId,
      period: botKey.periodLabel,
      market: botKey.marketLabel,
      pick: botKey.sideLabel || null,
    }
  }
  const chosen =
    /^Chosen Team\s*:\s*([^|]+?)\s*\|\s*Game Num\s*:\s*(\d{1,13})(?=\s*(?:\||$))/i.exec(operation)
  if (chosen?.[1] && chosen[2] && /^[\p{L}\p{N} .,'’&()-]{1,80}$/u.test(chosen[1])) {
    return { source: "chosen-team", gameId: chosen[2], period: null, market: null, pick: chosen[1] }
  }
  const description =
    /^(?:API LOG\s*\|\s*)(?:BLOCK BET\s*\|\s*)?Bet\s*:\s*([^|]{1,256})(?=\||$)/i.exec(
      operation,
    )?.[1]
  if (!description) return null
  // Some quote messages put the point-buy suffix immediately before the period.
  const compactDescription = description
    .replace(/&(?:amp;)?(?:#189|#xBD|frac12);/gi, "½")
    .replace(/\s+-\s+buying\s+[+-]?[\d.½]+\s+(For\s+[^|]+)$/i, " - $1")
  const { legs } = parseShortDesc(compactDescription)
  const leg = legs[0]
  if (
    legs.length !== 1 ||
    !leg?.sport ||
    !leg.gameNumber ||
    !/^[\p{L}\p{N} .,'’&/+()½-]{1,120}$/u.test(leg.pick) ||
    (leg.period !== "" &&
      !/^(?:Game|Match|Prop|Overtime|(?:[1-9](?:st|nd|rd|th)|Last) (?:Half|Quarter|Period|Set|Innings?|OT))$/i.test(
        leg.period,
      ))
  )
    return null
  // The compact total format uses O/U between the matchup and the line plus price.
  const total =
    /\b(Over|Under)\s+\d/i.exec(leg.pick)?.[1]?.toLowerCase() ??
    /\s([OU])\s+\d[\d.½, -]*\s+[+-]\d{3,4}\s*$/i.exec(leg.pick)?.[1]?.toLowerCase()
  const totalPick = total === "over" || total === "o" ? "Over" : total ? "Under" : null
  return {
    source: "bet-description",
    gameId: null,
    listedNumber: leg.gameNumber,
    period: leg.period || null,
    market: leg.market || (totalPick ? "Total" : null),
    pick: totalPick ?? leg.pick,
  }
}

// Rules recognize provider markers while keeping free-form operation text private.
const operationRules: readonly {
  readonly marker: RegExp
  readonly kind: WebLogEventKind
  readonly label?: string
}[] = [
  { marker: /\bBOT\s+BLOCK\s+LINE\s+ST\b/i, kind: "BOT_BLOCK_LINE_ST" },
  { marker: /\bBLOCK\s+BET\b/i, kind: "API_BLOCK_BET" },
  { marker: /^Login\s+successful\s+Token\b/i, kind: "LOGIN_TOKEN" },
  { marker: /^Login\s+successful\b/i, kind: "LOGIN_SUCCESS" },
  { marker: /\bRATE[ -]?LIMIT(?:ED)?\b|\bHTTP\s+429\b/i, kind: "RATE_LIMIT" },
  { marker: /^API LOG\s*\|\s*PARLAY\s*:/i, kind: "API_PARLAY_DESCRIPTION" },
  { marker: /^API LOG\s*\|\s*ROUND ROBIN(?:\s*\||$)/i, kind: "API_ROUND_ROBIN" },
  {
    marker: /^API LOG\s*\|\s*PARLAY\s*\|\s*UPDATE(?:\s*\||$)/i,
    kind: "API_PARLAY",
    label: "API parlay update",
  },
  { marker: /^API LOG\s*\|\s*PARLAY(?:\s*\||$)/i, kind: "API_PARLAY" },
  { marker: /^SET OPEN PARLAY\b/i, kind: "API_PARLAY" },
  { marker: /^API LOG\s*\|\s*Bet\s*:/i, kind: "API_BET" },
  { marker: /^API LOG\s*\|\s*Ticket\s*:/i, kind: "API_TICKET" },
  { marker: /^API LOG\s*\|/i, kind: "API_LOG" },
  { marker: /^Wager accepted by:/i, kind: "WAGER_ACCEPTED" },
  { marker: /^Chosen team\b/i, kind: "TEAM_CHOSEN" },
  { marker: /^View\s+Pending\b/i, kind: "VIEW", label: "View pending wagers" },
  { marker: /^View\s+Ultra Live\b/i, kind: "VIEW", label: "View Ultra Live" },
  { marker: /^View\s+Daily Figures\b/i, kind: "VIEW", label: "View daily figures" },
  {
    marker: /^View\s+Prop Builder\s+By Sport\b/i,
    kind: "VIEW",
    label: "View Prop Builder by sport",
  },
  { marker: /^View\s+Prop Builder\b/i, kind: "VIEW", label: "View Prop Builder" },
  { marker: /^View\s+Transactions\b/i, kind: "VIEW", label: "View transactions" },
  { marker: /^View\b/i, kind: "VIEW" },
  {
    marker: /^Straight Lines Displayed\b/i,
    kind: "LINES_DISPLAYED",
    label: "Straight lines displayed",
  },
  {
    marker: /^Parlay Lines Displayed\b/i,
    kind: "LINES_DISPLAYED",
    label: "Parlay lines displayed",
  },
  {
    marker: /^Teaser Lines Displayed\b/i,
    kind: "LINES_DISPLAYED",
    label: "Teaser lines displayed",
  },
  { marker: /^Teaser List Displayed\b/i, kind: "LINES_DISPLAYED", label: "Teaser list displayed" },
  { marker: /^Teaser Bets\s*(?:\([^)]*\))?\s+Accepted\b/i, kind: "TEASER_ACCEPTED" },
  { marker: /^Enter live casino\b/i, kind: "CASINO_ENTRY" },
  {
    marker: /^Set Picks In A Open Parlay\b/i,
    kind: "OPEN_WAGER_EDIT",
    label: "Set picks in an open parlay",
  },
  { marker: /^Set Open Parlay\b/i, kind: "OPEN_WAGER_EDIT", label: "Set open parlay" },
  { marker: /^Set Open Teaser\b/i, kind: "OPEN_WAGER_EDIT", label: "Set open teaser" },
  { marker: /^Maximum wager amount for this selection\b/i, kind: "WAGER_LIMIT" },
  { marker: /^Round Robin\s+(?:\/\s*)?Selections\b/i, kind: "ROUND_ROBIN_SELECTION" },
  { marker: /^Round Robin\b/i, kind: "ROUND_ROBIN_ACTIVITY" },
  { marker: /^\d+\s+or more games selected are\b/i, kind: "SELECTION_LIMIT" },
  { marker: /^Show Customer Message popup\b/i, kind: "CUSTOMER_MESSAGE" },
  { marker: /^Changed Skin\b/i, kind: "SKIN_CHANGE" },
  {
    marker: /^Change Line\s+Money\s*\/\s*Price\b/i,
    kind: "LINE_CHANGE",
    label: "Moneyline price change",
  },
  {
    marker: /^Change Line\s+Total\s*\/\s*Price\b/i,
    kind: "LINE_CHANGE",
    label: "Total price change",
  },
  {
    marker: /^Change Line\s+Total\s*\/\s*Point\b/i,
    kind: "LINE_CHANGE",
    label: "Total points change",
  },
  {
    marker: /^Change Line\s+Spread\s*\/\s*Price\b/i,
    kind: "LINE_CHANGE",
    label: "Spread price change",
  },
  {
    marker: /^Change Line\s+Spread\s*\/\s*Point\b/i,
    kind: "LINE_CHANGE",
    label: "Spread points change",
  },
  { marker: /^Change Line\s+(?:Money|Total|Spread)\b/i, kind: "LINE_CHANGE" },
]

function readPortalHost(value: string | undefined): string | null {
  const hostname = value?.trim().toLowerCase()
  return hostname &&
    hostname.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)
    ? hostname
    : null
}

export function parseFantasy402Action(rawAction: string): {
  event: WebLogEvent
  eventKind: WebLogEventKind
  operationLabel: string
  accountId: string
  botKey: ParsedBotKey | null
  selection: WebLogSelection | null
  parlayLegs: readonly ParsedParlayLeg[] | null
  ticketNumber: string | null

  actionMeta: ParsedWebLogActionMeta | null
  clientVersion: string | null
  portalHost: string | null
  deviceMarker: "M" | "D" | null
  apiMarked: boolean
} {
  const action = rawAction.trim().replace(/&quot;|&#34;|&#x22;/gi, '"')
  const operation = action.replace(/^\([MD]\)\s*/i, "")
  const rule = operationRules.find(({ marker }) => marker.test(operation))
  const eventKind = rule?.kind ?? "OTHER"
  const operationLabel = rule?.label ?? WEBLOG_OPERATIONS[eventKind].label
  let accountId = "UNKNOWN"
  let botKey: ParsedBotKey | null = null

  // Extract JSON array payload after #
  const jsonMatch = /#\s*(\[\s*\{[\s\S]*?\}\s*\])/.exec(action)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]!) as Array<{
        key?: unknown
        val?: unknown
      }>
      const first = parsed[0]
      if (first) {
        if (typeof first.val === "string" && first.val.trim().length > 0) {
          accountId = first.val.trim().toUpperCase()
        }
        if (typeof first.key === "string" && first.key.trim().length > 0) {
          botKey = parseBotBlockKey(first.key)
        }
      }
    } catch {
      // Fallback regex if payload is truncated
      const keyFallback = /"key"\s*:\s*"([^"]+)"/.exec(action)
      const valFallback = /"val"\s*:\s*"([^"]+)"/.exec(action)
      if (valFallback) accountId = valFallback[1]!.toUpperCase()
      if (keyFallback) botKey = parseBotBlockKey(keyFallback[1]!)
    }
  } else {
    const acctMatch = /\b(?:val|acct|user|account)[=:]\s*([A-Z0-9._-]{3,16})/i.exec(action)
    if (acctMatch) accountId = acctMatch[1]!.toUpperCase()
  }

  // The bracketed site and version are explicit metadata from the logged message.
  const metadata = /\[\s*(v\d{1,8}(?:\.\d{1,8}){1,3})\s*\|\s*([^\s\]]+)\s*\](?=\s*(?:\||$))/i.exec(
    action,
  )
  const clientVersion = metadata?.[1]?.toLowerCase() ?? null
  const portalHost = readPortalHost(metadata?.[2])
  const leadingMarker = /^\(([MD])\)/i.exec(action)?.[1]?.toUpperCase()
  const trailingMarker = metadata
    ? /\(([MD])\)\s*$/i.exec(action.slice(0, metadata.index))?.[1]?.toUpperCase()
    : undefined
  const marker =
    leadingMarker && trailingMarker && leadingMarker !== trailingMarker
      ? null
      : (leadingMarker ?? trailingMarker)
  const deviceMarker = marker === "M" || marker === "D" ? marker : null

  const event = WEBLOG_OPERATIONS[eventKind].event
  const parlayDescription =
    eventKind === "API_PARLAY_DESCRIPTION" ? readParlayOperation(operation) : null
  const ticketNumber =
    event === "API"
      ? (/(?:^|\|)\s*Ticket\s*:\s*(\d{1,13})(?=\s*(?:\||$))/i.exec(operation)?.[1] ?? null)
      : null
  const hasTicketReference =
    event === "API" || eventKind === "ROUND_ROBIN_ACTIVITY" || eventKind === "ROUND_ROBIN_SELECTION"
  const ticketMatch = hasTicketReference
    ? /(?:^|\|)\s*Ticket\s*:\s*(\d{1,13})(?=\s*(?:[|/]|$))/i.exec(operation)
    : null
  const gameMatch = /\bGame\s+Num\s*:\s*(\d+)/i.exec(action)
  const riskMatch = /\bRisk\s*:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(action)
  const winMatch = /\bWin\s*:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(action)
  const limitMatch = /\bLimit\s*:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(action)
  const amountMatch = /\bAmount\s*:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(action)
  const chosenTeamMatch = /\bChosen\s+Team\s*:\s*([^|\[]+)/i.exec(action)
  const selectionsMatch = /\bSelections\s*:\s*([^|]+)/i.exec(action)
  const logTypeMatch = /\bLOG\s*:\s*([^/\s]+)/i.exec(action)
  const isMobile = deviceMarker === "M"

  const selectionSummary = chosenTeamMatch
    ? chosenTeamMatch[1]!.trim()
    : selectionsMatch
      ? selectionsMatch[1]!.trim()
      : logTypeMatch
        ? logTypeMatch[1]!.trim()
        : null

  const hasMeta =
    Boolean(ticketMatch) ||
    Boolean(gameMatch) ||
    Boolean(riskMatch) ||
    Boolean(winMatch) ||
    Boolean(limitMatch) ||
    Boolean(amountMatch) ||
    isMobile ||
    Boolean(selectionSummary)

  const actionMeta: ParsedWebLogActionMeta | null = hasMeta
    ? {
        ticketId: ticketMatch?.[1] ?? null,
        gameId: botKey?.gameId ?? gameMatch?.[1] ?? null,
        riskUsd: riskMatch ? Number(riskMatch[1]) : null,
        winUsd: winMatch ? Number(winMatch[1]) : null,
        limitUsd: limitMatch ? Number(limitMatch[1]) : null,
        attemptedUsd: amountMatch ? Number(amountMatch[1]) : null,
        channel: isMobile ? "mobile" : deviceMarker === "D" ? "desktop" : null,
        selectionSummary,
      }
    : null

  return {
    event,
    eventKind,
    operationLabel,
    actionMeta,
    accountId,
    botKey,
    selection: parseWebLogSelection(operation, botKey),
    parlayLegs: parlayDescription ? parseParlayLegs(parlayDescription) : null,
    ticketNumber,
    clientVersion,
    portalHost,
    deviceMarker,
    apiMarked: /^API LOG\s*\|/i.test(operation),
  }
}

function encodeSourceTime(dateLabel: string, timeEst: string): number {
  return Date.parse(`${dateLabel} ${timeEst} GMT`)
}

// ── Source rows ─────────────────────────────────────────────────────────────

interface RawWebLogSeed {
  readonly dateLabel: string
  readonly timeEst: string
  readonly sourceTime?: string
  readonly epochMs?: number
  readonly ip: string
  readonly action: string
  readonly fallbackAccount?: string
  readonly fallbackPortalHost?: string
  readonly source?: "capture" | "ingested"
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const va = a[i]!
    const vb = b[i]!
    dot += va * vb
    magA += va * va
    magB += vb * vb
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom > 0 ? Number((dot / denom).toFixed(3)) : 0
}

function clamp01(v: number): number {
  return Number(Math.max(0, Math.min(1, v)).toFixed(3))
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Number(((sorted[mid - 1]! + sorted[mid]!) / 2).toFixed(1))
    : Number(sorted[mid]!.toFixed(1))
}

export function buildEnrichedWebLogs(seeds: readonly RawWebLogSeed[]): {
  entries: WebLogEntry[]
  vectors: WebLogVectorProfile[]
  cosinePairs: WebLogCosinePair[]
} {
  const resolvedRows = seeds.flatMap((seed, idx) => {
    const sourceSortMs = seed.sourceTime
      ? Date.parse(seed.sourceTime.replace(" ", "T") + "Z")
      : encodeSourceTime(seed.dateLabel, seed.timeEst)
    if (!Number.isFinite(sourceSortMs)) return []
    const parsed = parseFantasy402Action(seed.action)
    const ipMeta = classifyIpNetwork(seed.ip)
    return [
      {
        id: `wlog-${idx + 1}`,
        dateLabel: seed.dateLabel,
        timeEst: seed.timeEst,
        sourceTime: seed.sourceTime ?? null,
        sourceSortMs,
        epochMs: seed.epochMs ?? sourceSortMs + 5 * 60 * 60_000,
        ip: ipMeta.ip,
        ipMeta,
        rawAction: parsed.operationLabel,
        event: parsed.event,
        eventKind: parsed.eventKind,
        accountId:
          seed.fallbackAccount ??
          (parsed.accountId === "UNKNOWN" ? "UNATTRIBUTED" : parsed.accountId),
        botKey: parsed.botKey,
        selection: parsed.selection,
        actionMeta: parsed.actionMeta,
        gameId: parsed.actionMeta?.gameId ?? parsed.selection?.gameId ?? null,
        ticketId: parsed.ticketNumber ?? parsed.actionMeta?.ticketId ?? null,
        ...(parsed.parlayLegs ? { parlayLegs: parsed.parlayLegs } : {}),
        ticketNumber: parsed.ticketNumber,
        clientVersion: parsed.clientVersion,
        portalHost: parsed.portalHost ?? readPortalHost(seed.fallbackPortalHost),
        deviceMarker: parsed.deviceMarker,
        apiMarked: parsed.apiMarked,
        source: seed.source ?? "capture",
      },
    ]
  })

  // Compute inter-arrival cadence (seconds) per (ip, account) ordered chronologically
  const byGroup = new Map<string, typeof resolvedRows>()
  for (const row of resolvedRows) {
    const key = `${row.ip}|${row.accountId}`
    const list = byGroup.get(key) ?? []
    list.push(row)
    byGroup.set(key, list)
  }

  const cadenceById = new Map<string, number | null>()
  const vectorByGroup = new Map<string, WebLogVectorProfile>()

  for (const [groupKey, groupRows] of byGroup.entries()) {
    const chrono = [...groupRows].sort((a, b) => a.sourceSortMs - b.sourceSortMs)
    const deltas: number[] = []
    const burstDeltas: number[] = []

    for (let i = 0; i < chrono.length; i++) {
      const curr = chrono[i]!
      if (i === 0) {
        cadenceById.set(curr.id, null)
      } else {
        const diffSec = (curr.sourceSortMs - chrono[i - 1]!.sourceSortMs) / 1000
        cadenceById.set(curr.id, diffSec)
        if (diffSec > 0 && diffSec <= 120) {
          deltas.push(diffSec)
          if (
            curr.eventKind === "BOT_BLOCK_LINE_ST" ||
            curr.eventKind === "API_BLOCK_BET" ||
            curr.eventKind === "WAGER_LIMIT"
          ) {
            burstDeltas.push(diffSec)
          }
        }
      }
    }

    const first = chrono[0]!
    const total = chrono.length
    const blockCount = chrono.filter(
      (r) =>
        r.eventKind === "BOT_BLOCK_LINE_ST" ||
        r.eventKind === "API_BLOCK_BET" ||
        r.eventKind === "WAGER_LIMIT",
    ).length
    const loginCount = chrono.filter((r) => r.eventKind === "LOGIN_SUCCESS").length
    const tokenCount = chrono.filter((r) => r.eventKind === "LOGIN_TOKEN").length

    const games = new Map<string, number>()
    const botKeys = new Set<string>()
    const markets = new Set<string>()
    for (const r of chrono) {
      if (r.botKey) {
        games.set(r.botKey.gameId, (games.get(r.botKey.gameId) ?? 0) + 1)
        botKeys.add(r.botKey.rawKey)
        markets.add(`${r.botKey.periodLabel}:${r.botKey.marketCode}:${r.botKey.sideCode || "S"}`)
      } else if (r.gameId) {
        games.set(r.gameId, (games.get(r.gameId) ?? 0) + 1)
      }
    }

    const activeDeltas = burstDeltas.length > 0 ? burstDeltas : deltas
    const intraBurstDeltas = activeDeltas.filter((d) => d <= 20)
    const regularityDeltas = intraBurstDeltas.length >= 2 ? intraBurstDeltas : activeDeltas
    const medCadence = median(activeDeltas)
    const minCadence = activeDeltas.reduce<number | null>(
      (min, delta) => (min === null ? delta : Math.min(min, delta)),
      null,
    )

    // 6-Axis Normalized Behavioral Feature Vector
    const blockRatio = clamp01(blockCount / Math.max(1, total))
    const burstCadence = medCadence !== null ? clamp01(1 - Math.min(medCadence, 60) / 60) : 0

    let cadenceRegularity = 0
    if (regularityDeltas.length >= 2) {
      const mean = regularityDeltas.reduce((s, v) => s + v, 0) / regularityDeltas.length
      const variance =
        regularityDeltas.reduce((s, v) => s + (v - mean) ** 2, 0) / regularityDeltas.length
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1
      cadenceRegularity = clamp01(1 - Math.min(cv, 1.2) / 1.2)
    }

    const topGameHits = Math.max(0, ...games.values())
    const gameConcentration = blockCount > 0 ? clamp01(topGameHits / Math.max(1, blockCount)) : 0
    const tokenChurn = clamp01(((tokenCount + loginCount) / Math.max(2, total)) * 1.35)
    const marketSpread = clamp01(markets.size / 3)

    const vector: [number, number, number, number, number, number] = [
      blockRatio,
      burstCadence,
      cadenceRegularity,
      gameConcentration,
      tokenChurn,
      marketSpread,
    ]

    const activityLabel =
      blockCount > 0
        ? "Blocked requests"
        : loginCount + tokenCount > 0
          ? "Login activity"
          : "Other access activity"

    // Weighted Bot Automation Score (0–100)
    const rawScore =
      blockRatio * 34 + burstCadence * 26 + cadenceRegularity * 16 + gameConcentration * 24
    const botScore = Math.round(Math.max(0, Math.min(100, rawScore)))
    const severity =
      WEBLOG_SEVERITY_RULES.find((rule) => botScore >= rule.minimum)?.severity ?? "NORMAL"

    vectorByGroup.set(groupKey, {
      vectorId: groupKey,
      ip: first.ip,
      subnet24: first.ipMeta.subnet24,
      ipMeta: first.ipMeta,
      accountId: first.accountId,
      eventCount: total,
      blockCount,
      loginCount,
      tokenCount,
      uniqueGames: Array.from(games.keys()),
      uniqueBotKeys: Array.from(botKeys),
      medianCadenceSec: medCadence,
      minCadenceSec: minCadence,
      axes: {
        blockRatio,
        burstCadence,
        cadenceRegularity,
        gameConcentration,
        tokenChurn,
        marketSpread,
      },
      vector,
      botScore,
      archetype: activityLabel,
      severity,
    })
  }

  const vectors = Array.from(vectorByGroup.values()).sort(
    (a, b) => b.botScore - a.botScore || b.eventCount - a.eventCount,
  )

  // Pairwise cosine similarity across IP/Account vectors
  const cosinePairs: WebLogCosinePair[] = []
  const comparisonVectors = vectors.filter((vector) => vector.blockCount > 0).slice(0, 64)
  for (let i = 0; i < comparisonVectors.length; i++) {
    for (let j = i + 1; j < comparisonVectors.length; j++) {
      const left = comparisonVectors[i]!
      const right = comparisonVectors[j]!
      const cos = cosineSimilarity(left.vector, right.vector)
      const sharedGames = left.uniqueGames.filter((g) => right.uniqueGames.includes(g))
      const verdict =
        cos >= 0.9 && sharedGames.length > 0
          ? "HIGH SIMILARITY WITH SHARED GAME"
          : cos >= 0.85
            ? "HIGH VECTOR SIMILARITY"
            : cos >= 0.65
              ? "MODERATE CORRELATION (Overlapping Behavior)"
              : "DIVERGENT PROFILE"

      cosinePairs.push({
        leftId: left.vectorId,
        rightId: right.vectorId,
        leftIp: left.ip,
        rightIp: right.ip,
        leftAccount: left.accountId,
        rightAccount: right.accountId,
        cosine: cos,
        sharedGames,
        verdict,
      })
    }
  }
  cosinePairs.sort((a, b) => b.cosine - a.cosine)

  const entries: WebLogEntry[] = resolvedRows.map((row) => {
    const groupKey = `${row.ip}|${row.accountId}`
    const vp = vectorByGroup.get(groupKey)
    return {
      ...row,
      interArrivalSec: cadenceById.get(row.id) ?? null,
      vectorScore: vp?.botScore ?? 0,
      severity: vp?.severity ?? "NORMAL",
      clusterLabel: vp?.archetype ?? "Unclassified",
    }
  })

  return { entries, vectors, cosinePairs }
}

// ── Raw Text & JSON Ingestion Parser ─────────────────────────────────────────

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const

function formatAccessDateTime(raw: string): {
  dateLabel: string
  timeEst: string
  sourceTime: string
  epochMs?: number
} | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(?=$|Z$|[+-]\d{2}:?\d{2}$)/.exec(
      raw.trim(),
    )
  const sourceTime = m?.[0].replace("T", " ")
  if (m && sourceTime && Number.isFinite(Date.parse(sourceTime.replace(" ", "T") + "Z"))) {
    const year = Number(m[1])
    const month = Number(m[2])
    const day = Number(m[3])
    const monthIdx = Math.max(0, Math.min(11, month - 1))
    const hour24 = Number(m[4])
    const min = m[5]!
    const sec = m[6]!
    const period = hour24 >= 12 ? "PM" : "AM"
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
    const offset = /(?:Z|[+-]\d{2}:?\d{2})$/.exec(raw.trim())?.[0] ?? "-05:00"
    const epochMs = Date.parse(sourceTime.replace(" ", "T") + offset)
    return {
      dateLabel: `${MONTH_NAMES[monthIdx]} ${day}, ${year}`,
      timeEst: `${String(hour12).padStart(2, "0")}:${min}:${sec}${m[7] ?? ""} ${period}`,
      sourceTime,
      ...(Number.isFinite(epochMs) ? { epochMs } : {}),
    }
  }
  return null
}

function unwrapFantasy402JsonRecords(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!parsed || typeof parsed !== "object") return null

  const obj = parsed as Record<string, unknown>
  const containerKeys = ["LIST", "list", "records", "rows", "entries", "items", "logs"]
  for (const key of containerKeys) {
    const val = obj[key]
    if (Array.isArray(val)) return val
  }
  if (obj.data !== undefined) {
    const nested = unwrapFantasy402JsonRecords(obj.data)
    if (nested && nested.length > 0) return nested
  }
  return [parsed]
}

function parseFantasy402JsonWebLogs(rawText: string): RawWebLogSeed[] {
  const trimmed = rawText.trim()
  if (!trimmed.includes("{")) return []

  const tryParseArray = (candidate: string): unknown[] | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown
      return unwrapFantasy402JsonRecords(parsed)
    } catch {
      return null
    }
  }

  // Support valid JSON arrays, Fantasy402 { "LIST": [...], "INFO": "" } envelopes,
  // single objects, or pasted fragments missing outer [ ] or with trailing commas
  let records = tryParseArray(trimmed)
  if (!records) {
    const stripped = trimmed.replace(/^\[/, "").replace(/\]$/, "").replace(/,\s*$/, "")
    records = tryParseArray(`[${stripped}]`)
  }
  if (!records) {
    const extracted: unknown[] = []
    const objRe = /\{[^{}]*"IPAddress"[^{}]*\}/gi
    let match: RegExpExecArray | null
    while ((match = objRe.exec(trimmed)) !== null) {
      try {
        extracted.push(JSON.parse(match[0]))
      } catch {
        // skip malformed fragment
      }
    }
    if (extracted.length > 0) records = extracted
  }

  if (!records || records.length === 0) return []

  const seeds: RawWebLogSeed[] = []
  for (const item of records) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const ip = String(rec.IPAddress ?? rec.ip ?? "").trim()
    if (!isIP(ip)) continue

    const accessDt = String(rec.AccessDateTime ?? rec.timestamp ?? rec.time ?? "").trim()
    const date = formatAccessDateTime(accessDt)
    if (!date) continue
    const loginId = String(rec.LoginID ?? rec.accountId ?? rec.customerId ?? "")
      .trim()
      .toUpperCase()
    const operation = String(rec.Operation ?? rec.action ?? "").trim()
    const rawData = String(rec.Data ?? "")
      .replace(/\s*\|\s*$/, "")
      .trim()
    const clientCode = String(rec.ClientCode ?? "").trim()

    let action = operation
    if (rawData && !operation.toLowerCase().includes(rawData.toLowerCase())) {
      action = action ? `${action} | ${rawData}` : rawData
    }
    if (
      clientCode &&
      !action.toLowerCase().includes(clientCode.toLowerCase()) &&
      !/\[.*\|.*\]/.test(action) &&
      /^Login\s+successful$/i.test(action)
    ) {
      action = `${action} [ ${clientCode} ]`
    }
    if (!action) continue

    seeds.push({
      ...date,
      ip,
      action,
      fallbackAccount: loginId || undefined,
      fallbackPortalHost: clientCode || undefined,
      source: "ingested",
    })
  }

  return seeds
}

export function extractWebLogIngestRawText(body: unknown): string {
  if (typeof body === "string") return body
  if (!body || typeof body !== "object") return ""
  if (Array.isArray(body)) return JSON.stringify(body)
  const obj = body as Record<string, unknown>
  if (typeof obj.rawText === "string") return obj.rawText
  if (
    Array.isArray(obj.LIST) ||
    Array.isArray(obj.list) ||
    Array.isArray(obj.records) ||
    Array.isArray(obj.rows) ||
    Array.isArray(obj.entries) ||
    obj.data !== undefined ||
    obj.IPAddress !== undefined
  ) {
    return JSON.stringify(obj)
  }
  return ""
}

export function parseRawWebLogText(rawText: string): RawWebLogSeed[] {
  const jsonParsed = parseFantasy402JsonWebLogs(rawText)
  if (jsonParsed.length > 0) {
    return jsonParsed
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  let currentDate: string | undefined
  const parsed: RawWebLogSeed[] = []

  const dateLineRe =
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$/i
  const rowRe = /^(\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?)\s+(?:\|\s*)?([^\s|]+)\s+(?:\|\s*)?(.+)$/i

  for (const line of lines) {
    if (dateLineRe.test(line)) {
      currentDate = line
      continue
    }
    if (!currentDate || /^Time\(EST\)/i.test(line)) continue

    // Support tab-separated or pipe-separated or whitespace-separated rows
    const tabParts = line
      .split("\t")
      .map((s) => s.trim())
      .filter(Boolean)
    if (tabParts.length >= 3 && isIP(tabParts[1]!)) {
      parsed.push({
        dateLabel: currentDate,
        timeEst: tabParts[0]!,
        ip: tabParts[1]!,
        action: tabParts.slice(2).join(" "),
        source: "ingested",
      })
      continue
    }

    const m = rowRe.exec(line)
    if (m && isIP(m[2]!)) {
      parsed.push({
        dateLabel: currentDate,
        timeEst: m[1]!.trim(),
        ip: m[2]!.trim(),
        action: m[3]!.trim(),
        source: "ingested",
      })
    }
  }

  return parsed
}

// ── Multi-Field Sorter ───────────────────────────────────────────────────────

export function sortWebLogs(
  entries: readonly WebLogEntry[],
  sort: WebLogSortField = "time",
  dir: WebLogSortDir = "desc",
): WebLogEntry[] {
  const factor = dir === "asc" ? 1 : -1
  const severityRank: Record<WebLogEntry["severity"], number> = {
    NORMAL: 0,
    WATCH: 1,
    HIGH: 2,
    CRITICAL: 3,
  }
  return [...entries].sort((a, b) => {
    let cmp = 0
    switch (sort) {
      case "severity":
        cmp =
          severityRank[a.severity] - severityRank[b.severity] ||
          a.vectorScore - b.vectorScore ||
          a.sourceSortMs - b.sourceSortMs
        break
      case "ip":
        cmp = a.ip.localeCompare(b.ip) || a.sourceSortMs - b.sourceSortMs
        break
      case "ipFamily":
        cmp = a.ipMeta.family.localeCompare(b.ipMeta.family) || a.sourceSortMs - b.sourceSortMs
        break
      case "ipCategory":
        cmp =
          a.ipMeta.classification.localeCompare(b.ipMeta.classification) ||
          a.ip.localeCompare(b.ip) ||
          a.sourceSortMs - b.sourceSortMs
        break
      case "account":
        cmp = a.accountId.localeCompare(b.accountId) || a.sourceSortMs - b.sourceSortMs
        break
      case "gameId":
        cmp =
          (a.selection?.gameId ?? "").localeCompare(b.selection?.gameId ?? "", undefined, {
            numeric: true,
          }) || a.sourceSortMs - b.sourceSortMs
        break
      case "market": {
        const ma = a.selection?.market ?? ""
        const mb = b.selection?.market ?? ""
        cmp = ma.localeCompare(mb) || a.sourceSortMs - b.sourceSortMs
        break
      }
      case "botKey":
        cmp =
          (a.botKey?.rawKey ?? "").localeCompare(b.botKey?.rawKey ?? "") ||
          a.sourceSortMs - b.sourceSortMs
        break
      case "period":
        cmp =
          (a.selection?.period ?? "").localeCompare(b.selection?.period ?? "") ||
          a.sourceSortMs - b.sourceSortMs
        break
      case "event":
        cmp = a.event.localeCompare(b.event) || a.sourceSortMs - b.sourceSortMs
        break
      case "pick":
        cmp =
          (a.selection?.pick ?? "").localeCompare(b.selection?.pick ?? "") ||
          a.sourceSortMs - b.sourceSortMs
        break
      case "kind":
        cmp = a.eventKind.localeCompare(b.eventKind) || a.sourceSortMs - b.sourceSortMs
        break
      case "cadence": {
        const ca = a.interArrivalSec ?? 999_999
        const cb = b.interArrivalSec ?? 999_999
        cmp = ca - cb || a.sourceSortMs - b.sourceSortMs
        break
      }
      case "score":
        cmp = a.vectorScore - b.vectorScore || a.sourceSortMs - b.sourceSortMs
        break
      case "time":
      default:
        cmp = a.sourceSortMs - b.sourceSortMs
        break
    }
    return cmp * factor
  })
}

// ── Bun.inspect.custom Desk Views ───────────────────────────────────────────

const severityColors: Record<WebLogSeverity, string> = {
  CRITICAL: ANSI.boldRed,
  HIGH: ANSI.yellow,
  WATCH: ANSI.cyan,
  NORMAL: ANSI.green,
}

const severityMarks: Record<WebLogSeverity, string> = {
  CRITICAL: "CRIT",
  HIGH: "HIGH",
  WATCH: "WATCH",
  NORMAL: "NORM",
}

function describeWebLogEvidence(row: WebLogEntry, maxStringLength?: number): string {
  const { selection, ticketNumber, clientVersion } = row
  return [
    selection?.gameId && `Game ${selection.gameId}`,
    selection?.period,
    selection?.market,
    selection?.pick &&
      (maxStringLength ? truncateVisible(selection.pick, maxStringLength) : selection.pick),
    row.parlayLegs && `${row.parlayLegs.length} parsed legs`,
    ticketNumber && `Ticket ${ticketNumber}`,
    clientVersion,
  ]
    .filter(Boolean)
    .join(" · ")
}

export class WebLogView extends DeskView<WebLogEntry> {
  constructor(
    rows: readonly WebLogEntry[],
    private readonly meta: {
      readonly sort: WebLogSortField
      readonly dir: WebLogSortDir
      readonly totalCount: number
      readonly filteredCount?: number
      readonly offset?: number
      readonly activeFilters?: readonly string[]
      readonly showOptions?: boolean
      readonly inspectOptions?: BunInspectOptions
    },
  ) {
    super(rows)
  }

  render(options: BunInspectOptions = {}): string {
    const opts = resolveInspectOptions({ ...this.meta.inspectOptions, ...options })
    const { colors, depth, compact, breakLength } = opts
    const count = (n: number) => formatInspectNumber(n, opts)
    const matched = this.meta.filteredCount ?? this.rows.length
    const offset = this.meta.offset ?? 0
    const end = offset + this.rows.length
    const range = this.rows.length > 0 ? `${count(offset + 1)}–${count(end)}` : "none"
    const sort = opts.sorted ? "IP (sorted)" : `${this.meta.sort} ${this.meta.dir}`
    const lines: string[] = []
    const add = (value: string, color: string = ANSI.gray, indent = "") => {
      const width = breakLength - indent.length
      // Keep long evidence visible on a continuation line instead of widening the terminal.
      let line = ""
      for (const word of value.split(/\s+/)) {
        if (line && line.length + word.length + 1 > width) {
          lines.push(indent + paint(line, color, colors))
          line = ""
        }
        const clipped = truncateVisible(word, width)
        line = line ? `${line} ${clipped}` : clipped
      }
      lines.push(indent + paint(line, color, colors))
    }

    add("WEBLOGS · WebLogView[Bun.inspect.custom]", ANSI.boldCyan)
    add(`Page ${range} · ${count(matched)} of ${count(this.meta.totalCount)} rows matched`)
    add(`Order ${sort} · Depth ${depth}`)
    if (this.meta.activeFilters?.length) add(this.meta.activeFilters.join(" · "), ANSI.yellow)
    if (!this.rows.length) {
      add("No matching weblog entries.")
    } else if (depth > 0) {
      const ordered = opts.sorted
        ? [...this.rows].sort((a, b) => a.ip.localeCompare(b.ip) || b.sourceSortMs - a.sourceSortMs)
        : this.rows
      const shown = ordered.slice(0, opts.maxArrayLength)
      let day = ""
      for (const row of shown) {
        const groupedByDate = this.meta.sort === "time" && !opts.sorted
        if (groupedByDate && row.dateLabel !== day) {
          day = row.dateLabel
          lines.push("")
          add(day, ANSI.boldCyan)
        } else if (!compact) {
          lines.push("")
        }
        const timestamp = groupedByDate ? row.timeEst : `${row.dateLabel} ${row.timeEst}`
        add(
          `${timestamp} · ${severityMarks[row.severity]} · ${row.accountId} · ${row.rawAction}`,
          severityColors[row.severity],
        )
        const evidence = describeWebLogEvidence(row, opts.maxStringLength)
        if (evidence) add(evidence, ANSI.boldWhite, "  ")
        if (depth >= 2 && !compact) {
          const cadence = row.interArrivalSec === null ? "—" : `${row.interArrivalSec}s`
          add(`Rule score ${count(row.vectorScore)}/100 · Δt ${cadence}`, ANSI.gray, "  ")
        }
        if (depth >= 3) {
          add(`${row.ipMeta.family} ${row.ip}`, ANSI.cyan, "  ")
          const metadata = [
            row.portalHost,
            row.clientVersion,
            row.deviceMarker && `(${row.deviceMarker})`,
            row.apiMarked && "API LOG",
          ]
            .filter(Boolean)
            .join(" · ")
          if (metadata) add(`Logged metadata ${metadata}`, ANSI.gray, "  ")
          for (const [index, leg] of (row.parlayLegs ?? [])
            .slice(0, opts.maxArrayLength)
            .entries()) {
            const quote = [
              leg.sport,
              leg.period,
              leg.selection,
              leg.priceAmerican,
              leg.pointsBought && `buy ${leg.pointsBought}`,
            ]
              .filter(Boolean)
              .join(" · ")
            add(`Leg ${index + 1} · ${quote}`, ANSI.boldWhite, "  ")
          }
          if (row.botKey) add(`Bot key ${row.botKey.rawKey}`, ANSI.yellow, "  ")
        }
        if (opts.getters) add(`Activity ${row.clusterLabel}`, ANSI.magenta, "  ")
        if (opts.showHidden || depth >= 4)
          add(
            `Source ${row.source} · Row ${row.id} · Prefix ${row.ipMeta.subnet24}`,
            ANSI.gray,
            "  ",
          )
      }
      if (shown.length < ordered.length) {
        add(
          `… ${count(ordered.length - shown.length)} more on this page (maxArrayLength=${opts.maxArrayLength})`,
        )
      }
    }
    if (this.meta.showOptions)
      lines.push(renderInspectOptionsBanner(opts, "WebLogView --options", { showOptions: true }))
    return lines.join("\n")
  }
}

export class WebLogVectorView extends DeskView<WebLogVectorProfile> {
  private readonly cosinePairs: readonly WebLogCosinePair[]
  private readonly meta: {
    readonly showOptions?: boolean
    readonly inspectOptions?: BunInspectOptions
  }
  constructor(
    rows: readonly WebLogVectorProfile[],
    cosinePairs: readonly WebLogCosinePair[] = [],
    meta: { readonly showOptions?: boolean; readonly inspectOptions?: BunInspectOptions } = {},
  ) {
    super(rows)
    this.cosinePairs = cosinePairs
    this.meta = meta
  }

  render(options: BunInspectOptions = {}): string {
    const opts = resolveInspectOptions({ ...this.meta.inspectOptions, ...options })
    const colors = opts.colors
    const cardWidth = opts.breakLength - 2
    const top = paint(`╔${"═".repeat(cardWidth)}╗`, ANSI.boldCyan, colors)
    const div = paint(`╠${"═".repeat(cardWidth)}╣`, ANSI.boldCyan, colors)
    const bot = paint(`╚${"═".repeat(cardWidth)}╝`, ANSI.boldCyan, colors)

    const frame = (content: string) =>
      paint("║ ", ANSI.boldCyan, colors) +
      padVisibleEnd(truncateVisible(content, cardWidth - 2), cardWidth - 2) +
      paint(" ║", ANSI.boldCyan, colors)

    const bar = (val: number, width: number, color: string) => {
      const filled = Math.round(Math.max(0, Math.min(1, val)) * width)
      return (
        paint("█".repeat(filled), color, colors) +
        paint("░".repeat(Math.max(0, width - filled)), ANSI.gray, colors)
      )
    }

    const lines: string[] = [
      top,
      frame(
        paint(
          "◆ WEBLOG BEHAVIORAL VECTORING [WebLogVectorView[Bun.inspect.custom]]",
          ANSI.boldWhite,
          colors,
        ),
      ),
      frame(
        paint(
          `Axes: [blockRatio, burstCadence, regularity, gameFocus, tokenChurn, mktSpread] · depth=${opts.depth}`,
          ANSI.gray,
          colors,
        ),
      ),
    ]

    const list = opts.sorted ? [...this.rows].sort((a, b) => a.ip.localeCompare(b.ip)) : this.rows

    for (const v of list.slice(0, opts.maxArrayLength)) {
      lines.push(div)
      const sevColor =
        v.severity === "CRITICAL"
          ? ANSI.boldRed
          : v.severity === "HIGH"
            ? ANSI.boldYellow
            : v.severity === "WATCH"
              ? ANSI.cyan
              : ANSI.green

      lines.push(
        frame(
          `${paint(v.ip, ANSI.boldCyan, colors)} (${paint(v.accountId, ANSI.boldWhite, colors)}) · ` +
            `${paint(`${v.severity} ${v.botScore}/100`, sevColor, colors)} · ` +
            `${paint(v.archetype, ANSI.yellow, colors)}`,
        ),
      )
      lines.push(
        frame(
          `${paint("Archetype:", ANSI.gray, colors)} ${v.archetype}  ` +
            `${paint("Δt med:", ANSI.gray, colors)} ${v.medianCadenceSec !== null ? `${v.medianCadenceSec}s` : "—"}  ` +
            `${paint("Blocks:", ANSI.gray, colors)} ${v.blockCount}/${v.eventCount}`,
        ),
      )
      lines.push(
        frame(
          `${paint("Vec:", ANSI.gray, colors)} [${v.vector.map((n) => n.toFixed(2)).join(", ")}]`,
        ),
      )
      if (!opts.compact) {
        lines.push(
          frame(
            `  Blk ${bar(v.axes.blockRatio, 8, ANSI.red)} ${(v.axes.blockRatio * 100).toFixed(0).padStart(3)}%  ` +
              `Cdn ${bar(v.axes.burstCadence, 8, ANSI.yellow)} ${(v.axes.burstCadence * 100).toFixed(0).padStart(3)}%  ` +
              `Reg ${bar(v.axes.cadenceRegularity, 8, ANSI.cyan)} ${(v.axes.cadenceRegularity * 100).toFixed(0).padStart(3)}%`,
          ),
        )
        if (opts.depth >= 3 || opts.getters) {
          lines.push(
            frame(
              `  Foc ${bar(v.axes.gameConcentration, 8, ANSI.magenta)} ${(v.axes.gameConcentration * 100).toFixed(0).padStart(3)}%  ` +
                `Chn ${bar(v.axes.tokenChurn, 8, ANSI.yellow)} ${(v.axes.tokenChurn * 100).toFixed(0).padStart(3)}%  ` +
                `Mkt ${bar(v.axes.marketSpread, 8, ANSI.green)} ${(v.axes.marketSpread * 100).toFixed(0).padStart(3)}%`,
            ),
          )
        }
      }
      if (opts.showHidden) {
        lines.push(
          frame(
            paint(
              `  [hidden] subnet=${v.subnet24} · botKeys=${v.uniqueBotKeys.length} · games=${v.uniqueGames.join(",") || "none"}`,
              ANSI.gray,
              colors,
            ),
          ),
        )
      }
    }

    const strongPairs = this.cosinePairs.filter((p) => p.cosine >= 0.75).slice(0, 3)
    if (strongPairs.length > 0) {
      lines.push(div)
      lines.push(
        frame(
          paint("COSINE SIMILARITY CLUSTERS (IP × ACCOUNT CORRELATION)", ANSI.boldYellow, colors),
        ),
      )
      for (const pair of strongPairs) {
        const pairColor = pair.cosine >= 0.9 ? ANSI.boldRed : ANSI.yellow
        lines.push(
          frame(
            `${paint(pair.leftIp, ANSI.cyan, colors)}(${pair.leftAccount}) ↔ ` +
              `${paint(pair.rightIp, ANSI.cyan, colors)}(${pair.rightAccount})  ` +
              `${paint(`cos=${pair.cosine.toFixed(3)}`, pairColor, colors)} ` +
              `${pair.sharedGames.length > 0 ? paint(`games:${pair.sharedGames.length}`, ANSI.green, colors) : ""}`,
          ),
        )
      }
    }

    lines.push(bot)
    if (this.meta.showOptions) {
      lines.push(
        renderInspectOptionsBanner(opts, "WebLogVectorView --options", { showOptions: true }),
      )
    }
    return lines.join("\n")
  }
}

// ── Stateful Session WebLog Store ────────────────────────────────────────────

function summarizeWebLogClients(rows: readonly WebLogEntry[]): WebLogClientSummary {
  const groups = new Map<
    string,
    {
      site: string
      version: string
      count: number
      kinds: Map<WebLogEventKind, number>
    }
  >()
  const sites = new Set<string>()
  const versions = new Set<string>()
  let rowsWithSiteVersion = 0

  for (const { portalHost: site, clientVersion: version, eventKind } of rows) {
    if (!site || !version) continue
    const key = `${site} ${version}`
    const profile = groups.get(key) ?? {
      site,
      version,
      count: 0,
      kinds: new Map<WebLogEventKind, number>(),
    }
    profile.count++
    profile.kinds.set(eventKind, (profile.kinds.get(eventKind) ?? 0) + 1)
    groups.set(key, profile)
    sites.add(site)
    versions.add(version)
    rowsWithSiteVersion++
  }
  return {
    rowsWithSiteVersion,
    siteCount: sites.size,
    versionCount: versions.size,
    profileCount: groups.size,
    profiles: [...groups.values()]
      .sort(
        (a, b) =>
          b.count - a.count || a.site.localeCompare(b.site) || a.version.localeCompare(b.version),
      )
      .slice(0, 40)
      .map(({ site, version, count, kinds }) => ({
        site,
        version,
        count,
        operations: [...kinds]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      })),
  }
}

export function createWebLogStore() {
  let ingested: RawWebLogSeed[] = []
  let snapshot: readonly RetainedWeblogRow[] | undefined
  let captured: RawWebLogSeed[] = []
  let captureAvailable = false
  let enriched:
    (ReturnType<typeof buildEnrichedWebLogs> & { clients: WebLogClientSummary }) | undefined

  function setCapture(rows: readonly RetainedWeblogRow[], available: boolean) {
    if (snapshot === rows && captureAvailable === available) return
    captureAvailable = available
    snapshot = rows
    captured = rows.flatMap((row) => {
      const date = formatAccessDateTime(row.time)
      if (!date) return []
      return [
        {
          ...date,
          ip: row.address,
          action: row.operation,
          fallbackAccount: row.account,
          source: "capture",
        },
      ]
    })
    enriched = undefined
  }

  function query(opts: WebLogQueryOptions = {}): WebLogQueryResult {
    const sort: WebLogSortField = opts.sort ?? "time"
    const dir: WebLogSortDir = opts.dir ?? "desc"

    if (!enriched) {
      const analysis = buildEnrichedWebLogs([...captured, ...ingested])
      enriched = { ...analysis, clients: summarizeWebLogClients(analysis.entries) }
    }
    const { entries: allEntries, vectors, cosinePairs } = enriched

    const ipFilter = opts.ip?.trim()
    const ipFamilyFilter = opts.ipFamily?.trim().toLowerCase()
    const kindFilter = opts.kind?.trim().toUpperCase()
    const siteFilter = opts.site?.trim().toLowerCase()
    const versionFilter = opts.version?.trim().toLowerCase()
    const marketFilter = opts.market?.trim().toUpperCase()
    const accountFilter = opts.account?.trim().toUpperCase()
    const rawSeverity = opts.severity?.trim().toUpperCase()
    const severityFilter: WebLogEntry["severity"] | null =
      rawSeverity === "CRIT" || rawSeverity === "CRITICAL"
        ? "CRITICAL"
        : rawSeverity === "HIGH"
          ? "HIGH"
          : rawSeverity === "WATCH" || rawSeverity === "WTCH"
            ? "WATCH"
            : rawSeverity === "NORM" || rawSeverity === "NORMAL"
              ? "NORMAL"
              : null
    const qFilter = opts.q?.trim().toLowerCase()

    const filtered = allEntries.filter((row) => {
      if (opts.captureOnly && row.source !== "capture") return false
      if (siteFilter && row.portalHost !== siteFilter) return false
      if (versionFilter && row.clientVersion !== versionFilter) return false
      if (
        ipFamilyFilter &&
        ipFamilyFilter !== "all" &&
        row.ipMeta.family.toLowerCase() !== ipFamilyFilter
      )
        return false
      if (
        ipFilter &&
        ipFilter !== "ALL" &&
        row.ip !== ipFilter &&
        row.ipMeta.subnet24 !== ipFilter
      ) {
        return false
      }
      if (kindFilter && kindFilter !== "ALL" && row.eventKind !== kindFilter) {
        return false
      }
      if (marketFilter && marketFilter !== "ALL") {
        const market = row.botKey?.marketCode ?? (row.selection?.market === "Total" ? "L" : null)
        if (market !== marketFilter) return false
      }
      if (accountFilter && accountFilter !== "ALL" && row.accountId !== accountFilter) {
        return false
      }
      if (severityFilter && row.severity !== severityFilter) {
        return false
      }
      if (qFilter) {
        const hay = [
          row.dateLabel,
          row.timeEst,
          row.sourceTime ?? "",
          row.ip,
          row.ipMeta.subnet24,
          row.ipMeta.asnLabel,
          row.accountId,
          row.event,
          row.eventKind,
          row.rawAction,
          row.portalHost ?? "",
          row.clientVersion ?? "",
          row.botKey?.rawKey ?? "",
          row.selection?.pick ?? "",
          row.selection?.gameId ?? "",
          row.selection?.market ?? "",
          row.selection?.period ?? "",
          row.ticketNumber ?? "",
          ...(row.parlayLegs ?? []).flatMap((leg) => [leg.sport, leg.selection, leg.period ?? ""]),

          row.ticketId ?? "",
          row.gameId ?? row.botKey?.gameId ?? "",
          row.botKey?.marketLabel ?? "",
          row.clusterLabel,
        ]
          .join(" ")
          .toLowerCase()
        if (!hay.includes(qFilter)) return false
      }
      return true
    })

    const ordered = sortWebLogs(filtered, sort, dir)
    const offset = Math.min(opts.offset ?? 0, ordered.length)
    const pageRows = opts.limit === undefined ? ordered : ordered.slice(offset, offset + opts.limit)
    const nextOffset = offset + pageRows.length < ordered.length ? offset + pageRows.length : null

    const botCadences = ordered
      .filter(
        (r) =>
          (r.eventKind === "BOT_BLOCK_LINE_ST" || r.eventKind === "API_BLOCK_BET") &&
          r.interArrivalSec !== null &&
          r.interArrivalSec > 0 &&
          r.interArrivalSec <= 120,
      )
      .map((r) => r.interArrivalSec!)

    const resolved = resolveInspectOptions({
      colors: opts.colors,
      compact: opts.compact,
      sorted: opts.sorted,
      depth: opts.depth,
      showHidden: opts.showHidden,
      maxArrayLength: opts.maxArrayLength,
      maxStringLength: opts.maxStringLength,
      breakLength: opts.breakLength,
      numericSeparator: opts.numericSeparator,
      getters: opts.getters,
    })
    const activeFilters = [
      ipFilter && ipFilter !== "ALL" ? `ip=${ipFilter}` : null,
      ipFamilyFilter && ipFamilyFilter !== "all" ? `family=${ipFamilyFilter}` : null,
      kindFilter && kindFilter !== "ALL" ? `kind=${kindFilter}` : null,
      siteFilter ? `site=${siteFilter}` : null,
      versionFilter ? `version=${versionFilter}` : null,
      marketFilter && marketFilter !== "ALL" ? `mkt=${marketFilter}` : null,
      accountFilter && accountFilter !== "ALL" ? `acct=${accountFilter}` : null,
      severityFilter ? `sev=${severityFilter}` : null,
      qFilter ? `q="${qFilter}"` : null,
    ].filter((x): x is string => x !== null)

    const logView = new WebLogView(pageRows, {
      sort,
      dir,
      totalCount: allEntries.length,
      filteredCount: ordered.length,
      offset,
      activeFilters,
      showOptions: opts.showOptions,
    })
    const vectorView = new WebLogVectorView(vectors, cosinePairs, {
      showOptions: opts.showOptions,
    })

    const tableRows = pageRows.map((row) => ({
      Time: row.timeEst,
      Login: row.accountId,
      Event: row.rawAction,
      Evidence: describeWebLogEvidence(row) || "—",
      IP: row.ip,
      Prefix: row.ipMeta.subnet24,
    }))
    const tableColumns = [
      "Time",
      "Login",
      "Event",
      "Evidence",
      ...(resolved.breakLength >= 116 && !resolved.compact ? ["IP"] : []),
      ...(resolved.showHidden && resolved.breakLength >= 132 ? ["Prefix"] : []),
    ]
    const cellWidth =
      Math.floor((resolved.breakLength - 7) / tableColumns.length) - (resolved.compact ? 1 : 3)
    const renderedTable = [
      inspectTable(tableRows, tableColumns, {
        ...resolved,
        maxColWidth: Math.min(resolved.maxStringLength, cellWidth),
      }),
      ...(opts.showOptions
        ? [renderInspectOptionsBanner(resolved, "Weblog table --options", { showOptions: true })]
        : []),
    ].join("\n")

    return {
      source: captureAvailable
        ? ingested.length
          ? "mixed"
          : "retained-mode-a"
        : ingested.length
          ? "operator-import"
          : "unavailable",
      entries: pageRows,
      page: { offset, nextOffset },
      vectors: opts.limit === undefined ? vectors : vectors.slice(0, 24),
      cosinePairs: opts.limit === undefined ? cosinePairs : cosinePairs.slice(0, 24),
      availableIps: Array.from(new Set(allEntries.map((r) => r.ip))),
      availableAccounts: Array.from(new Set(allEntries.map((r) => r.accountId))),
      clients: enriched.clients,
      kinds: Array.from(
        allEntries.reduce(
          (counts, row) => counts.set(row.eventKind, (counts.get(row.eventKind) ?? 0) + 1),
          new Map<WebLogEventKind, number>(),
        ),
      ).map(([kind, count]) => ({ kind, count })),
      summary: {
        totalEntries: allEntries.length,
        filteredEntries: ordered.length,
        uniqueIps: new Set(allEntries.flatMap((r) => (r.ip === "unknown" ? [] : [r.ip]))).size,
        uniqueSubnets: new Set(
          allEntries.flatMap((r) => (r.ip === "unknown" ? [] : [r.ipMeta.subnet24])),
        ).size,
        botBlockCount: ordered.filter((r) => r.eventKind === "BOT_BLOCK_LINE_ST").length,
        loginEventCount: ordered.filter(
          (r) => r.eventKind === "LOGIN_SUCCESS" || r.eventKind === "LOGIN_TOKEN",
        ).length,
        medianBotCadenceSec: median(botCadences),
        peakBotScore: vectors[0]?.botScore ?? 0,
        correlatedPairsCount: cosinePairs.filter((p) => p.cosine >= 0.85).length,
        severityCounts: {
          CRITICAL: allEntries.filter((r) => r.severity === "CRITICAL").length,
          HIGH: allEntries.filter((r) => r.severity === "HIGH").length,
          WATCH: allEntries.filter((r) => r.severity === "WATCH").length,
          NORMAL: allEntries.filter((r) => r.severity === "NORMAL").length,
        },
      },
      inspectAnsi: inspectDeskValue(logView, resolved),
      vectorInspectAnsi: inspectDeskValue(vectorView, resolved),
      tableInspectAnsi: renderedTable,
      resolvedOptions: resolved,
      optionsJsLiteral: formatInspectOptionsObject(resolved),
      cliFlags: formatInspectCliFlags(resolved, {
        showOptions: opts.showOptions,
      }),
      generatedAt: new Date().toISOString(),
    }
  }

  function ingest(rawText: string): {
    ingestedCount: number
    result: WebLogQueryResult
  } {
    const incoming = parseRawWebLogText(rawText)
    if (incoming.length > 0) {
      ingested = [...incoming, ...ingested]
      enriched = undefined
    }
    return {
      ingestedCount: incoming.length,
      result: query(),
    }
  }

  function reset(): WebLogQueryResult {
    ingested = []
    enriched = undefined
    return query()
  }

  return { query, ingest, reset, setCapture }
}
