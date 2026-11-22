import { isSentinelWager, parseWagerTimestampMs } from "./handle_volume_series.ts"
import type { LiveWager, ShowcaseCustomer } from "./types.ts"

export interface CustomerSportExposureRow {
  readonly sport: string
  readonly riskUsd: number
  readonly ticketCount: number
  readonly criticalCount: number
  readonly sharePct: number
}

export interface CustomerChannelExposureRow {
  readonly channel: string
  readonly riskUsd: number
  readonly ticketCount: number
}

export interface CustomerLiveActivitySummary {
  readonly customerId: string
  readonly tickets: readonly LiveWager[]
  readonly ticketCount: number
  readonly totalRiskUsd: number
  readonly totalToWinUsd: number
  readonly criticalCount: number
  readonly liveInPlayCount: number
  readonly avgClvCents: number | null
  readonly maxSingleStakeUsd: number
  readonly sportBreakdown: readonly CustomerSportExposureRow[]
  readonly channelBreakdown: readonly CustomerChannelExposureRow[]
}

export interface ProfileRiskHeadroom {
  readonly varToCapPct: number | null
  readonly isVarOverCap: boolean
  readonly hasMeasuredVar: boolean
  readonly hasMeasuredLimit: boolean
  readonly hasMeasuredHold: boolean
  readonly hasMeasuredLtv: boolean
}

function isLiveInPlayWager(wager: LiveWager): boolean {
  const writer = (wager.writer ?? wager.ticketWriter ?? "").toUpperCase()
  const betType = (wager.betType || "").toUpperCase()
  return writer === "GSLIVE" || writer.includes("LIVE") || betType.includes("LIVE")
}

export function summarizeCustomerLiveActivity(
  customerId: string,
  wagers: readonly LiveWager[],
): CustomerLiveActivitySummary {
  const target = customerId.trim().toUpperCase()
  const matched: LiveWager[] = []

  for (const w of wagers) {
    if (isSentinelWager(w)) continue
    if (w.customerId.trim().toUpperCase() === target) {
      matched.push(w)
    }
  }

  const anchorMs = Date.now()
  matched.sort((a, b) => {
    const timeDiff =
      (parseWagerTimestampMs(b.timestamp, anchorMs) ?? 0) -
      (parseWagerTimestampMs(a.timestamp, anchorMs) ?? 0)
    if (timeDiff !== 0) return timeDiff
    return b.riskUsd - a.riskUsd
  })

  let totalRiskUsd = 0
  let totalToWinUsd = 0
  let criticalCount = 0
  let liveInPlayCount = 0
  let maxSingleStakeUsd = 0
  let clvSum = 0
  let clvSamples = 0

  const sportMap = new Map<
    string,
    { riskUsd: number; ticketCount: number; criticalCount: number }
  >()
  const channelMap = new Map<string, { riskUsd: number; ticketCount: number }>()

  for (const w of matched) {
    const risk = Number.isFinite(w.riskUsd) && w.riskUsd > 0 ? w.riskUsd : 0
    const toWin = Number.isFinite(w.toWinUsd) && w.toWinUsd > 0 ? w.toWinUsd : 0
    totalRiskUsd += risk
    totalToWinUsd += toWin
    if (risk > maxSingleStakeUsd) maxSingleStakeUsd = risk

    const isCrit = w.alertTier === "CRITICAL" || w.alertTier === "STEAM"
    if (isCrit) criticalCount += 1
    if (isLiveInPlayWager(w)) liveInPlayCount += 1

    if (typeof w.clvCents === "number" && Number.isFinite(w.clvCents)) {
      clvSum += w.clvCents
      clvSamples += 1
    }

    const sport = (w.sport || "OTHER").trim().toUpperCase()
    const sportEntry = sportMap.get(sport) ?? {
      riskUsd: 0,
      ticketCount: 0,
      criticalCount: 0,
    }
    sportEntry.riskUsd += risk
    sportEntry.ticketCount += 1
    if (isCrit) sportEntry.criticalCount += 1
    sportMap.set(sport, sportEntry)

    const channel = (w.writer ?? w.ticketWriter ?? "DIRECT").trim() || "DIRECT"
    const channelEntry = channelMap.get(channel) ?? { riskUsd: 0, ticketCount: 0 }
    channelEntry.riskUsd += risk
    channelEntry.ticketCount += 1
    channelMap.set(channel, channelEntry)
  }

  const sportBreakdown: CustomerSportExposureRow[] = [...sportMap.entries()]
    .map(([sport, entry]) => ({
      sport,
      riskUsd: entry.riskUsd,
      ticketCount: entry.ticketCount,
      criticalCount: entry.criticalCount,
      sharePct: totalRiskUsd > 0 ? (entry.riskUsd / totalRiskUsd) * 100 : 0,
    }))
    .sort((a, b) => b.riskUsd - a.riskUsd || b.ticketCount - a.ticketCount)

  const channelBreakdown: CustomerChannelExposureRow[] = [...channelMap.entries()]
    .map(([channel, entry]) => ({
      channel,
      riskUsd: entry.riskUsd,
      ticketCount: entry.ticketCount,
    }))
    .sort((a, b) => b.riskUsd - a.riskUsd || b.ticketCount - a.ticketCount)

  return {
    customerId,
    tickets: matched,
    ticketCount: matched.length,
    totalRiskUsd,
    totalToWinUsd,
    criticalCount,
    liveInPlayCount,
    avgClvCents: clvSamples > 0 ? clvSum / clvSamples : null,
    maxSingleStakeUsd,
    sportBreakdown,
    channelBreakdown,
  }
}

export function computeProfileRiskHeadroom(customer: ShowcaseCustomer): ProfileRiskHeadroom {
  const unknown = customer.unknown ?? []
  const hasMeasuredVar = !unknown.includes("var95")
  const hasMeasuredLimit = !unknown.includes("limit")
  const hasMeasuredHold = !unknown.includes("holdPct")
  const hasMeasuredLtv = !unknown.includes("ltv")

  if (!hasMeasuredVar || !hasMeasuredLimit || customer.recommendedLimitUsd <= 0) {
    return {
      varToCapPct: null,
      isVarOverCap: false,
      hasMeasuredVar,
      hasMeasuredLimit,
      hasMeasuredHold,
      hasMeasuredLtv,
    }
  }

  const varToCapPct = Math.round((customer.var95Usd / customer.recommendedLimitUsd) * 100)
  return {
    varToCapPct,
    isVarOverCap: customer.var95Usd > customer.recommendedLimitUsd,
    hasMeasuredVar,
    hasMeasuredLimit,
    hasMeasuredHold,
    hasMeasuredLtv,
  }
}
