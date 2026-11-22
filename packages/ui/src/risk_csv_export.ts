import { wagerChannelOf } from "@sportsdesk-ops/contracts"
import { sanitizeCaptureText } from "./capture_text.ts"
import { formatWagerSelection } from "./wager_display.ts"
import type { LiveWager, ShowcaseCustomer } from "./types.ts"

const SAFE_SIGNED_NUMBER_RE = /^[+-]\d+(?:\.\d+)?$/

/**
 * Escapes a single CSV cell per RFC 4180 and neutralizes spreadsheet formula
 * injection while preserving legitimate signed numeric values (such as
 * American odds "-110", "+145" or point spreads "-3.5").
 */
export function escapeRiskCsvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return ""
  let str = String(value)

  if (typeof value === "string" && str.length > 0) {
    const first = str[0]
    const isFormulaPrefix =
      first === "=" ||
      first === "@" ||
      first === "\t" ||
      first === "\r" ||
      ((first === "+" || first === "-") && !SAFE_SIGNED_NUMBER_RE.test(str.trim()))
    if (isFormulaPrefix) {
      str = `'${str}`
    }
  }

  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export const LIVE_WAGERS_RISK_CSV_HEADERS = [
  "Ticket ID",
  "Timestamp",
  "Customer ID",
  "Agent ID",
  "Master Agent",
  "Sport",
  "Subsport",
  "Bet Type",
  "Channel",
  "Event",
  "Selection",
  "Line",
  "Odds",
  "Risk USD",
  "To Win USD",
  "Total Payout USD",
  "CLV Cents",
  "Alert Tier",
  "Max Recommended Stake USD",
  "Cap Utilization %",
  "Operator Directive",
] as const

export function buildLiveWagersRiskCsv(wagers: readonly LiveWager[]): string {
  const lines: string[] = [LIVE_WAGERS_RISK_CSV_HEADERS.map(escapeRiskCsvCell).join(",")]

  for (const w of wagers) {
    const channel = wagerChannelOf(w) ?? w.ticketWriter ?? ""
    const totalPayoutUsd = w.riskUsd + w.toWinUsd
    const capUtilizationPct =
      w.maxRecommendedStake > 0 ? ((w.riskUsd / w.maxRecommendedStake) * 100).toFixed(1) : ""

    const row: readonly (string | number | null)[] = [
      w.ticketId,
      w.timestamp,
      w.customerId,
      w.agentId,
      w.masterAgent,
      w.sport,
      w.subSport ?? "",
      w.betType,
      channel,
      sanitizeCaptureText(w.event ?? ""),
      formatWagerSelection(w, { includeOdds: false }),
      sanitizeCaptureText(w.lineDisplay ?? ""),
      w.oddsAmerican,
      w.riskUsd.toFixed(2),
      w.toWinUsd.toFixed(2),
      totalPayoutUsd.toFixed(2),
      w.clvCents !== null ? w.clvCents.toFixed(2) : "",
      w.alertTier,
      w.maxRecommendedStake.toFixed(2),
      capUtilizationPct,
      sanitizeCaptureText(w.operatorDirective ?? ""),
    ]

    lines.push(row.map(escapeRiskCsvCell).join(","))
  }

  return lines.join("\r\n")
}

export interface LiveWagersCsvFilenameOptions {
  readonly alertFilter?: string | undefined
  readonly sportFilter?: string | undefined
  readonly channelFilter?: string | undefined
  readonly date?: Date | undefined
}

function slugToken(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!normalized || normalized === "all") return null
  return normalized
}

export function buildLiveWagersCsvFilename(options: LiveWagersCsvFilenameOptions = {}): string {
  const isoDate = (options.date ?? new Date()).toISOString().slice(0, 10)
  const parts = ["sportsdesk", "risk-wagers"]
  const alertSlug = slugToken(options.alertFilter)
  const sportSlug = slugToken(options.sportFilter)
  const channelSlug = slugToken(options.channelFilter)
  if (alertSlug) parts.push(alertSlug)
  if (sportSlug) parts.push(sportSlug)
  if (channelSlug) parts.push(channelSlug)
  parts.push(isoDate)
  return `${parts.join("-")}.csv`
}

export const RISK_OVERVIEW_ACCOUNTS_CSV_HEADERS = [
  "Customer ID",
  "Name",
  "Agent ID",
  "Master Agent",
  "Tier",
  "Sharp Score",
  "Syndicate Risk",
  "Correlated Risk",
  "Syndicate Prob %",
  "VaR 95% USD",
  "CVaR 95% USD",
  "Recommended Limit USD",
  "Open Risk USD",
  "Flagged Breach Tickets",
  "Desk Action",
] as const

export function buildRiskOverviewAccountsCsv(
  customers: readonly ShowcaseCustomer[],
  wagers: readonly LiveWager[] = [],
): string {
  const openStatsByCustomer = new Map<string, { openRiskUsd: number; flaggedCount: number }>()
  for (const w of wagers) {
    const existing = openStatsByCustomer.get(w.customerId) ?? {
      openRiskUsd: 0,
      flaggedCount: 0,
    }
    existing.openRiskUsd += w.riskUsd
    if (
      w.alertTier === "CRITICAL" ||
      w.alertTier === "STEAM" ||
      w.alertTier === "ORIGINATOR_HIGH_RISK" ||
      w.alertTier === "STEAM_MOVE"
    ) {
      existing.flaggedCount += 1
    }
    openStatsByCustomer.set(w.customerId, existing)
  }

  const lines: string[] = [RISK_OVERVIEW_ACCOUNTS_CSV_HEADERS.map(escapeRiskCsvCell).join(",")]

  for (const c of customers) {
    const liveStats = openStatsByCustomer.get(c.id)
    const openRiskUsd = liveStats ? liveStats.openRiskUsd : (c.openRiskUsd ?? 0)
    const flaggedCount = liveStats ? liveStats.flaggedCount : 0
    const tierDisplay = c.tierLabel ?? c.tier.replace(/^TIER_\d+_/, "")

    const row: readonly (string | number)[] = [
      c.id,
      c.name,
      c.agentId,
      c.masterAgent,
      tierDisplay,
      c.score.toFixed(1),
      c.syndicateRisk,
      c.correlatedRisk,
      (c.syndicateProb * 100).toFixed(1),
      c.var95Usd.toFixed(2),
      c.cvar95Usd.toFixed(2),
      c.recommendedLimitUsd.toFixed(2),
      openRiskUsd.toFixed(2),
      flaggedCount,
      c.action,
    ]

    lines.push(row.map(escapeRiskCsvCell).join(","))
  }

  return lines.join("\r\n")
}

export function buildRiskOverviewCsvFilename(date?: Date): string {
  const isoDate = (date ?? new Date()).toISOString().slice(0, 10)
  return `sportsdesk-risk-overview-breaches-${isoDate}.csv`
}

export interface CsvDownloadLinkLike {
  href: string
  download: string
  style?: { display?: string }
  click: () => void
  remove?: () => void
}

export interface CsvDownloadEnv {
  readonly document?: {
    readonly createElement: (tag: "a") => CsvDownloadLinkLike
    readonly body?: {
      appendChild: (node: CsvDownloadLinkLike) => unknown
      removeChild?: (node: CsvDownloadLinkLike) => unknown
    } | null
  } | null
  readonly URL?: {
    readonly createObjectURL: (blob: Blob) => string
    readonly revokeObjectURL: (url: string) => void
  } | null
}

/**
 * Triggers a client-side CSV download with a UTF-8 BOM for reliable Excel
 * parsing and cleans up the temporary object URL.
 */
export function downloadRiskCsvBlob(
  csvContent: string,
  filename: string,
  env?: CsvDownloadEnv,
): boolean {
  const customDoc = env ? env.document : undefined
  const urlApi = env !== undefined ? env.URL : typeof URL !== "undefined" ? URL : null
  if (!urlApi || typeof urlApi.createObjectURL !== "function") {
    return false
  }

  const blob = new Blob([`\uFEFF${csvContent}`], {
    type: "text/csv;charset=utf-8;",
  })
  const objectUrl = urlApi.createObjectURL(blob)

  try {
    if (customDoc !== undefined) {
      if (!customDoc) return false
      const link = customDoc.createElement("a")
      link.href = objectUrl
      link.download = filename
      if (link.style) {
        link.style.display = "none"
      }
      customDoc.body?.appendChild(link)
      link.click()
      if (typeof link.remove === "function") {
        link.remove()
      } else if (customDoc.body && typeof customDoc.body.removeChild === "function") {
        customDoc.body.removeChild(link)
      }
      return true
    }

    if (typeof document === "undefined") {
      return false
    }
    const link = document.createElement("a")
    link.href = objectUrl
    link.download = filename
    link.style.display = "none"
    document.body?.appendChild(link)
    link.click()
    link.remove()
    return true
  } finally {
    if (typeof urlApi.revokeObjectURL === "function") {
      urlApi.revokeObjectURL(objectUrl)
    }
  }
}
