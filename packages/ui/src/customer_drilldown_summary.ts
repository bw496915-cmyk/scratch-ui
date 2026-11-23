import { isSentinelWager, parseWagerTimestampMs } from "./handle_volume_series.ts"
import { computeDeskExposureModel, type TailSeverity } from "./profile_formulas.ts"
import type { LiveWager, ShowcaseCustomer } from "./types.ts"

export interface CustomerSportExposureRow {
  readonly sport: string
  readonly riskUsd: number
  readonly toWinUsd: number
  readonly ticketCount: number
  readonly criticalCount: number
  readonly avgClvCents: number | null
  readonly sharePct: number
}

export interface CustomerChannelExposureRow {
  readonly channel: string
  readonly riskUsd: number
  readonly ticketCount: number
  readonly sharePct: number
}

export interface CustomerLiveActivitySummary {
  readonly customerId: string
  readonly tickets: readonly LiveWager[]
  readonly ticketCount: number
  readonly totalRiskUsd: number
  readonly totalToWinUsd: number
  readonly avgRiskUsd: number
  readonly avgToWinRatio: number | null
  readonly criticalCount: number
  readonly liveInPlayCount: number
  readonly avgClvCents: number | null
  readonly maxSingleStakeUsd: number
  readonly dominantChannel: string | null
  readonly sportBreakdown: readonly CustomerSportExposureRow[]
  readonly channelBreakdown: readonly CustomerChannelExposureRow[]
}

export interface ProfileRiskHeadroom {
  readonly varToCapPct: number | null
  readonly isVarOverCap: boolean
  readonly cvarToVarRatio: number | null
  readonly tailSeverity: TailSeverity
  readonly policyGapCount: number
  readonly suggestedCapUsd: number
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
    {
      riskUsd: number
      toWinUsd: number
      ticketCount: number
      criticalCount: number
      clvSum: number
      clvSamples: number
    }
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

    const hasClv = typeof w.clvCents === "number" && Number.isFinite(w.clvCents)
    if (hasClv) {
      clvSum += w.clvCents!
      clvSamples += 1
    }

    const sport = (w.sport || "OTHER").trim().toUpperCase()
    const sportEntry = sportMap.get(sport) ?? {
      riskUsd: 0,
      toWinUsd: 0,
      ticketCount: 0,
      criticalCount: 0,
      clvSum: 0,
      clvSamples: 0,
    }
    sportEntry.riskUsd += risk
    sportEntry.toWinUsd += toWin
    sportEntry.ticketCount += 1
    if (isCrit) sportEntry.criticalCount += 1
    if (hasClv) {
      sportEntry.clvSum += w.clvCents!
      sportEntry.clvSamples += 1
    }
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
      toWinUsd: entry.toWinUsd,
      ticketCount: entry.ticketCount,
      criticalCount: entry.criticalCount,
      avgClvCents: entry.clvSamples > 0 ? entry.clvSum / entry.clvSamples : null,
      sharePct: totalRiskUsd > 0 ? (entry.riskUsd / totalRiskUsd) * 100 : 0,
    }))
    .sort((a, b) => b.riskUsd - a.riskUsd || b.ticketCount - a.ticketCount)

  const channelBreakdown: CustomerChannelExposureRow[] = [...channelMap.entries()]
    .map(([channel, entry]) => ({
      channel,
      riskUsd: entry.riskUsd,
      ticketCount: entry.ticketCount,
      sharePct: totalRiskUsd > 0 ? (entry.riskUsd / totalRiskUsd) * 100 : 0,
    }))
    .sort((a, b) => b.riskUsd - a.riskUsd || b.ticketCount - a.ticketCount)

  return {
    customerId,
    tickets: matched,
    ticketCount: matched.length,
    totalRiskUsd,
    totalToWinUsd,
    avgRiskUsd: matched.length > 0 ? Math.round((totalRiskUsd / matched.length) * 100) / 100 : 0,
    avgToWinRatio: totalRiskUsd > 0 ? Math.round((totalToWinUsd / totalRiskUsd) * 100) / 100 : null,
    criticalCount,
    liveInPlayCount,
    avgClvCents: clvSamples > 0 ? clvSum / clvSamples : null,
    maxSingleStakeUsd,
    dominantChannel: channelBreakdown[0]?.channel ?? null,
    sportBreakdown,
    channelBreakdown,
  }
}

export function computeProfileRiskHeadroom(customer: ShowcaseCustomer): ProfileRiskHeadroom {
  const exposure = computeDeskExposureModel(customer)
  return {
    varToCapPct: exposure.varToCapPct,
    isVarOverCap: exposure.isVarOverCap,
    cvarToVarRatio: exposure.cvarToVarRatio,
    tailSeverity: exposure.tailSeverity,
    policyGapCount: exposure.policyGapCount,
    suggestedCapUsd: exposure.suggestedCapUsd,
    hasMeasuredVar: exposure.hasMeasuredVar,
    hasMeasuredLimit: exposure.hasMeasuredLimit,
    hasMeasuredHold: exposure.hasMeasuredHold,
    hasMeasuredLtv: exposure.hasMeasuredLtv,
  }
}
