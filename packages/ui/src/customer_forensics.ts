/**
 * Browser-safe customer forensic dossier extraction and enrichment helpers.
 *
 * Hydrates structured 4-week parlay protection economics (`docs/backtest-4wk-cfb-nba.json`) and
 * 10-mode graph intelligence (`docs/graph-live-feed.json`) onto `ShowcaseCustomer` rows without
 * guessing unmeasured values.
 */
import type {
  CustomerActivityOverlapEvent,
  CustomerActivityOverlapForensics,
  CustomerBacktestParlayMetrics,
  CustomerBeardBridgeForensics,
  CustomerCrossOfficeTwin,
  CustomerFlaggedTicketForensics,
  CustomerForensicDossier,
  CustomerMode1TelemetryOverview,
  ShowcaseCustomer,
} from "./types.ts"

type JsonRecord = Readonly<Record<string, unknown>>

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function asStringArray(value: unknown): readonly string[] {
  return asArray(value)
    .map((entry) => asText(entry))
    .filter((entry): entry is string => entry !== null)
}

function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function normalizeCustomerId(value: unknown): string | null {
  const text = asText(value)
  return text ? text.toUpperCase() : null
}

/** Extract a Probit correlation coefficient such as `ρ=0.756` or `rho=0.756` from guard text. */
export function parseProbitRho(text: string | null | undefined): number | null {
  if (!text) return null
  const match = /(?:ρ|rho)\s*=\s*([0-9]+(?:\.[0-9]+)?)/i.exec(text)
  if (!match?.[1]) return null
  const parsed = Number(match[1])
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null
  return round(parsed, 3)
}

/** Format an elapsed duration in seconds (e.g. `196040` -> `54h 27m`) deterministically. */
export function formatFreshnessDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return "—"
  }
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  if (hours >= 1) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`
  }
  if (minutes >= 1) {
    return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`
  }
  return `${whole}s`
}

/** Extract structured 4-week CFB/NBA parlay protection metrics from a backtest leaderboard row. */
export function extractBacktestParlayMetrics(
  row: JsonRecord,
): CustomerBacktestParlayMetrics | undefined {
  const totalParlayTickets = asNumber(row.totalParlayTickets)
  const totalParlayHandleUsd = asNumber(row.totalParlayHandleUsd)
  const baselineDeskNetUsd = asNumber(row.baselineDeskNetUsd)
  const protectedDeskNetUsd = asNumber(row.protectedDeskNetUsd)
  const deskSavingsUsd = asNumber(row.deskSavingsUsd)

  if (
    totalParlayTickets === null &&
    totalParlayHandleUsd === null &&
    baselineDeskNetUsd === null &&
    deskSavingsUsd === null
  ) {
    return undefined
  }

  const sampleComboSelection = asText(row.sampleComboSelection) ?? ""
  const primaryGuardTriggered = asText(row.primaryGuardTriggered) ?? ""
  const dominantComboFamily =
    asText(row.dominantComboFamily) ?? asText(row.contextType) ?? "UNSPECIFIED"

  const baselineNet = baselineDeskNetUsd ?? 0
  const protectedNet = protectedDeskNetUsd ?? 0
  const savings = deskSavingsUsd ?? round(protectedNet - baselineNet, 2)

  return {
    rank: asNumber(row.rank),
    contextType: asText(row.contextType ?? row.context_type) ?? "UNKNOWN",
    ipSubnet: asText(row.ipSubnet ?? row.ip_subnet),
    cfbParlayTickets: asNumber(row.cfbParlayTickets) ?? 0,
    cfbParlayHandleUsd: asNumber(row.cfbParlayHandleUsd) ?? 0,
    cfbBaselineDeskNetUsd: asNumber(row.cfbBaselineDeskNetUsd) ?? 0,
    cfbProtectedDeskNetUsd: asNumber(row.cfbProtectedDeskNetUsd) ?? 0,
    nbaParlayTickets: asNumber(row.nbaParlayTickets) ?? 0,
    nbaParlayHandleUsd: asNumber(row.nbaParlayHandleUsd) ?? 0,
    nbaBaselineDeskNetUsd: asNumber(row.nbaBaselineDeskNetUsd) ?? 0,
    nbaProtectedDeskNetUsd: asNumber(row.nbaProtectedDeskNetUsd) ?? 0,
    totalParlayTickets: totalParlayTickets ?? 0,
    totalParlayLegs: asNumber(row.totalParlayLegs) ?? 0,
    totalParlayHandleUsd: totalParlayHandleUsd ?? 0,
    avgClvBps: asNumber(row.avgClvBps ?? row.clv_bps) ?? 0,
    baselineDeskNetUsd: baselineNet,
    baselineHoldPct: asNumber(row.baselineHoldPct) ?? 0,
    protectedDeskNetUsd: protectedNet,
    protectedHoldPct: asNumber(row.protectedHoldPct) ?? 0,
    deskSavingsUsd: savings,
    dominantComboFamily,
    primaryGuardTriggered,
    sampleComboSelection,
    probitRho: parseProbitRho(sampleComboSelection) ?? parseProbitRho(primaryGuardTriggered),
    lastActiveAt: asText(row.lastActiveAt),
    proxyWallet: asText(row.proxyWallet),
    shortWallet: asText(row.shortWallet),
    polymarketProfileUrl: asText(row.polymarketProfileUrl),
    polymarketPositionsApiUrl: asText(row.polymarketPositionsApiUrl),
    f402CustomerProfileUrl: asText(row.f402CustomerProfileUrl),
  }
}

interface MutableCustomerForensics {
  parlayBacktest?: CustomerBacktestParlayMetrics
  beardBridge?: CustomerBeardBridgeForensics
  activityOverlap?: CustomerActivityOverlapForensics
  telemetryOverview?: CustomerMode1TelemetryOverview
  flaggedTickets: CustomerFlaggedTicketForensics[]
}

function getOrCreateEntry(
  map: Map<string, MutableCustomerForensics>,
  customerId: string,
): MutableCustomerForensics {
  const key = customerId.toUpperCase()
  let entry = map.get(key)
  if (!entry) {
    entry = { flaggedTickets: [] }
    map.set(key, entry)
  }
  return entry
}

function parseOverlapWindow(raw: unknown): CustomerActivityOverlapEvent | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const accountId = asText(rec.accountId)
  if (!accountId) return null
  return {
    accountId,
    officeAgentId: asText(rec.officeAgentId) ?? "—",
    windowKind: asText(rec.windowKind) ?? "POINT_IN_TIME_EVENT_WINDOW",
    startUtc: asText(rec.startUtc) ?? "—",
    endUtc: asText(rec.endUtc) ?? "—",
    ipAddress: asText(rec.ipAddress) ?? "—",
    actionSummary: asText(rec.actionSummary) ?? "—",
  }
}

function extractLeadingIpv4(text: string | null): string | null {
  if (!text) return null
  const match = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(text)
  return match?.[1] ?? null
}

/**
 * Index `docs/graph-live-feed.json` (served by `GET /api/graph/live-feed`) by uppercase customer ID
 * so every customer in the feed receives its real Cross-Office Beard Bridge, Mode 6 Activity
 * Overlap, Mode 1 Telemetry Overview, Wallet Profile links, and Flagged Tickets.
 */
export function indexGraphLiveFeedForensics(
  rawFeed: unknown,
): ReadonlyMap<string, CustomerForensicDossier> {
  const root = asRecord(rawFeed)
  const index = new Map<string, MutableCustomerForensics>()
  if (!root) return index

  // 1. Backtest leaderboard rows embedded in graph-live-feed
  const backtest4Wk = asRecord(root.backtest4Wk)
  for (const rawRow of asArray(backtest4Wk?.customerLeaderboard)) {
    const row = asRecord(rawRow)
    if (!row) continue
    const custId = normalizeCustomerId(row.customerId ?? row.customer_id)
    if (!custId) continue
    const metrics = extractBacktestParlayMetrics(row)
    if (metrics) {
      getOrCreateEntry(index, custId).parlayBacktest = metrics
    }
  }

  // 2. Wallet profiles (GSLive links, Polygonscan, archetype)
  const walletByCustomer = new Map<string, JsonRecord>()
  for (const rawProfile of asArray(root.walletProfiles)) {
    const prof = asRecord(rawProfile)
    if (!prof) continue
    const custId = normalizeCustomerId(prof.f402CustomerId)
    if (!custId) continue
    walletByCustomer.set(custId, prof)
  }

  // 3. Flagged & blocked tickets (`pendingBets` in docs/graph-live-feed.json, plus optional `flaggedTickets`)
  for (const rawTicket of [...asArray(root.pendingBets), ...asArray(root.flaggedTickets)]) {
    const ticket = asRecord(rawTicket)
    if (!ticket) continue
    const custId = normalizeCustomerId(ticket.f402CustomerId)
    const ticketId = asText(ticket.ticketId)
    if (!custId || !ticketId) continue
    const entry = getOrCreateEntry(index, custId)
    if (!entry.flaggedTickets.some((existing) => existing.ticketId === ticketId)) {
      entry.flaggedTickets.push({
        ticketId,
        sourceVenue: asText(ticket.sourceVenue) ?? "UNKNOWN",
        sportAndPeriod: asText(ticket.sportAndPeriod) ?? "—",
        canonicalMarket: asText(ticket.canonicalMarket) ?? "—",
        oddsAmerican: asText(ticket.oddsAmerican) ?? "—",
        riskUsd: asNumber(ticket.riskUsd) ?? 0,
        toWinUsd: asNumber(ticket.toWinUsd) ?? 0,
        pmEntryVsFair: asText(ticket.pmEntryVsFair) ?? "—",
        placedAtUtc: asText(ticket.placedAtUtc) ?? "—",
        deskVerdict: asText(ticket.deskVerdict) ?? "—",
      })
    }
  }

  // 4. Mode 3 Shared IP Groups (groupId, date window, supporting observations)
  const tenMode = asRecord(root.tenModeSnapshot)
  const mode3 = asRecord(tenMode?.mode3SharedIpOverview)
  const sharedIpGroupByCustomer = new Map<string, JsonRecord>()
  for (const rawGroup of asArray(mode3?.groups)) {
    const grp = asRecord(rawGroup)
    if (!grp) continue
    for (const login of asStringArray(grp.distinctCustomers)) {
      sharedIpGroupByCustomer.set(login.toUpperCase(), grp)
    }
  }

  // 5. Per-Office IP Tracker Clusters (Cross-Office Beard Bridge)
  for (const rawCluster of asArray(root.perOfficeIpTrackerClusters)) {
    const cluster = asRecord(rawCluster)
    if (!cluster) continue
    const officeAgentId = asText(cluster.officeAgentId) ?? "—"
    const masterAgentId = asText(cluster.masterAgentId)
    const matchClassification = asText(cluster.matchClassification) ?? "SHARED_IP_CLUSTER"
    const sharedIpOrSubnet = asText(cluster.sharedIpOrSubnet) ?? "—"
    const matchedLoginsInOffice = asStringArray(cluster.matchedLoginsInOffice)
    const crossOfficeTwins: CustomerCrossOfficeTwin[] = asArray(cluster.crossOfficeLogins)
      .map((item) => {
        const rec = asRecord(item)
        const loginId = asText(rec?.loginId)
        const twinAgent = asText(rec?.officeAgentId)
        if (!loginId || !twinAgent) return null
        return { loginId, officeAgentId: twinAgent }
      })
      .filter((item): item is CustomerCrossOfficeTwin => item !== null)

    const allParticipants: Array<{ readonly loginId: string; readonly officeAgentId: string }> = [
      ...matchedLoginsInOffice.map((loginId) => ({ loginId, officeAgentId })),
      ...crossOfficeTwins,
    ]

    for (const participant of allParticipants) {
      const key = participant.loginId.toUpperCase()
      const grp = sharedIpGroupByCustomer.get(key) ?? null
      const counterparts: CustomerCrossOfficeTwin[] = allParticipants
        .filter((other) => other.loginId.toUpperCase() !== key)
        .map((other) => ({ loginId: other.loginId, officeAgentId: other.officeAgentId }))

      getOrCreateEntry(index, key).beardBridge = {
        groupId: asText(grp?.groupId),
        matchClassification,
        scope: asText(grp?.scope),
        officeAgentId: participant.officeAgentId,
        masterAgentId,
        sharedIpOrSubnet,
        normalizedIp: asText(grp?.normalizedIp) ?? extractLeadingIpv4(sharedIpOrSubnet),
        subnetCidr: asText(grp?.subnetCidr),
        dateWindowStartMdy: asText(grp?.dateWindowStartMdy),
        dateWindowEndMdy: asText(grp?.dateWindowEndMdy),
        matchedLoginsInOffice,
        crossOfficeTwins: counterparts,
        bridgedPolymarketWallets: asStringArray(cluster.bridgedPolymarketWallets),
        modeASessionDwellSeconds: asNumber(cluster.modeASessionDwellSeconds),
        mfcsCompositeScore: asNumber(cluster.mfcsCompositeScore),
        activeRotations: asStringArray(cluster.activeRotations),
        recommendedDeskAction: asText(cluster.recommendedDeskAction) ?? "—",
        supportingObservations: asStringArray(grp?.supportingObservations),
      }
    }
  }

  // 6. Mode 6 Activity Overlap (explicitly distinguishes nearby point events from concurrent overlap)
  for (const rawOverlap of asArray(tenMode?.mode6ActivityOverlap)) {
    const overlap = asRecord(rawOverlap)
    if (!overlap) continue
    const primaryWindow = parseOverlapWindow(overlap.primaryWindow)
    const secondaryWindow = parseOverlapWindow(overlap.secondaryWindow)
    if (!primaryWindow || !secondaryWindow) continue
    const record: CustomerActivityOverlapForensics = {
      distinctionVerdict:
        asText(overlap.distinctionVerdict) ?? "NEARBY_POINT_EVENTS_WITHOUT_SESSION_OVERLAP",
      overlapDurationSeconds: asNumber(overlap.overlapDurationSeconds) ?? 0,
      gapBetweenWindowsSeconds: asNumber(overlap.gapBetweenWindowsSeconds) ?? 0,
      explanation: asText(overlap.explanation) ?? "",
      primaryWindow,
      secondaryWindow,
    }
    getOrCreateEntry(index, primaryWindow.accountId).activityOverlap = record
    getOrCreateEntry(index, secondaryWindow.accountId).activityOverlap = record
  }

  // 7. Mode 1 Customer Overview (telemetry freshness, warnings, GSLive & Polymarket links)
  for (const rawOverview of asArray(tenMode?.mode1CustomerOverview)) {
    const overview = asRecord(rawOverview)
    if (!overview) continue
    const custId = normalizeCustomerId(overview.customerId)
    if (!custId) continue
    const drillDownLinks = asRecord(overview.drillDownLinks)
    const walletProfile = walletByCustomer.get(custId) ?? null

    getOrCreateEntry(index, custId).telemetryOverview = {
      officeAgentId: asText(overview.officeAgentId) ?? asText(walletProfile?.agentOwner) ?? "—",
      gsLivePlayerId: asText(overview.gsLivePlayerId) ?? asText(walletProfile?.gsLivePlayerId),
      polymarketWallet: asText(overview.polymarketWallet) ?? asText(walletProfile?.proxyWallet),
      validatedNetUsd: round((asNumber(overview.validatedNetCents) ?? 0) / 100, 2),
      pendingStakeUsd: round((asNumber(overview.pendingStakeCents) ?? 0) / 100, 2),
      pendingDefinedLiabilityUsd: round(
        (asNumber(overview.pendingDefinedLiabilityCents) ?? 0) / 100,
        2,
      ),
      lastAccessUtc: asText(overview.lastAccessUtc),
      accessFreshnessSeconds: asNumber(overview.accessFreshnessSeconds),
      isAccessFresh: Boolean(overview.isAccessFresh),
      missingDataWarnings: asStringArray(overview.missingDataWarnings),
      summaryVerdict: asText(overview.summaryVerdict),
      f402CustomerUrl:
        asText(drillDownLinks?.f402CustomerUrl) ?? asText(walletProfile?.f402CustomerProfileUrl),
      gsLiveProfileUrl:
        asText(drillDownLinks?.gsLiveProfileUrl) ?? asText(walletProfile?.gsLivePlayerReportUrl),
      gsLiveBetHistoryUrl: asText(walletProfile?.gsLiveBetHistoryUrl),
      polymarketProfileUrl:
        asText(drillDownLinks?.polymarketProfileUrl) ?? asText(walletProfile?.polymarketProfileUrl),
      polygonscanUrl: asText(walletProfile?.polygonscanUrl),
      archetype: asText(walletProfile?.archetype),
    }
  }

  // Attach wallet-only metadata for customers that have a wallet profile + bridge/ticket but no mode1 entry
  for (const [custId, walletProfile] of walletByCustomer.entries()) {
    const entry = index.get(custId)
    if (!entry || entry.telemetryOverview) continue
    entry.telemetryOverview = {
      officeAgentId: asText(walletProfile.agentOwner) ?? "—",
      gsLivePlayerId: asText(walletProfile.gsLivePlayerId),
      polymarketWallet: asText(walletProfile.proxyWallet),
      validatedNetUsd: 0,
      pendingStakeUsd: 0,
      pendingDefinedLiabilityUsd: 0,
      lastAccessUtc: null,
      accessFreshnessSeconds: null,
      isAccessFresh: true,
      missingDataWarnings: [],
      summaryVerdict: null,
      f402CustomerUrl: asText(walletProfile.f402CustomerProfileUrl),
      gsLiveProfileUrl: asText(walletProfile.gsLivePlayerReportUrl),
      gsLiveBetHistoryUrl: asText(walletProfile.gsLiveBetHistoryUrl),
      polymarketProfileUrl: asText(walletProfile.polymarketProfileUrl),
      polygonscanUrl: asText(walletProfile.polygonscanUrl),
      archetype: asText(walletProfile.archetype),
    }
  }

  return index
}

/** Merge two forensic dossiers, preferring primary fields when both exist. */
export function mergeForensicDossiers(
  primary: CustomerForensicDossier | undefined,
  secondary: CustomerForensicDossier | undefined,
): CustomerForensicDossier | undefined {
  if (!primary) return secondary
  if (!secondary) return primary

  const ticketsById = new Map<string, CustomerFlaggedTicketForensics>()
  for (const t of [...primary.flaggedTickets, ...secondary.flaggedTickets]) {
    if (!ticketsById.has(t.ticketId)) ticketsById.set(t.ticketId, t)
  }

  return {
    parlayBacktest: primary.parlayBacktest ?? secondary.parlayBacktest,
    beardBridge: primary.beardBridge ?? secondary.beardBridge,
    activityOverlap: primary.activityOverlap ?? secondary.activityOverlap,
    telemetryOverview: primary.telemetryOverview ?? secondary.telemetryOverview,
    flaggedTickets: [...ticketsById.values()],
  }
}

/**
 * Enrich profile rows with graph-live-feed forensic intelligence (Cross-Office Beard Bridge, Mode 6
 * non-overlap distinction, Mode 1 telemetry freshness, and blocked flagged tickets).
 */
export function applyGraphForensicsToProfiles(
  profiles: readonly ShowcaseCustomer[],
  forensicsById: ReadonlyMap<string, CustomerForensicDossier>,
): ShowcaseCustomer[] {
  if (forensicsById.size === 0) return [...profiles]

  return profiles.map((cust) => {
    const graphDossier = forensicsById.get(cust.id.trim().toUpperCase())
    if (!graphDossier) return cust

    const mergedDossier = mergeForensicDossiers(cust.forensicDossier, graphDossier)
    if (!mergedDossier) return cust

    const unknownSet = new Set(cust.unknown ?? [])
    let ipAddress = cust.ipAddress
    let syndicateRisk = cust.syndicateRisk
    let syndicateProb = cust.syndicateProb
    let correlatedRisk = cust.correlatedRisk
    let correlatedExploitRate = cust.correlatedExploitRate
    let action = cust.action

    const bridge = mergedDossier.beardBridge
    if (bridge) {
      if (bridge.normalizedIp && (ipAddress === "—" || ipAddress.includes("/"))) {
        ipAddress = bridge.normalizedIp
      }
      if (bridge.mfcsCompositeScore !== null) {
        const prob = round(Math.max(0, Math.min(1, bridge.mfcsCompositeScore / 100)), 2)
        if (unknownSet.has("syndicate") || prob > syndicateProb) {
          syndicateProb = prob
          syndicateRisk =
            bridge.mfcsCompositeScore >= 75
              ? "HIGH"
              : bridge.mfcsCompositeScore >= 45
                ? "ELEVATED"
                : "LOW"
          unknownSet.delete("syndicate")
        }
      }
      if (
        bridge.matchClassification === "CROSS_OFFICE_BEARD_BRIDGE" &&
        action === "ACCEPT_NORMAL"
      ) {
        action = "ALERT_OPERATOR"
      }
    }

    const ticketRho = mergedDossier.flaggedTickets
      .map((t) => parseProbitRho(t.deskVerdict))
      .find((rho): rho is number => rho !== null)
    const probitRho = mergedDossier.parlayBacktest?.probitRho ?? ticketRho ?? null
    if (probitRho !== null) {
      if (unknownSet.has("correlation") || probitRho > correlatedExploitRate) {
        correlatedExploitRate = round(probitRho, 2)
        correlatedRisk = probitRho >= 0.65 ? "CRITICAL" : probitRho >= 0.45 ? "HIGH" : "MODERATE"
        unknownSet.delete("correlation")
      }
    }

    return {
      ...cust,
      ipAddress,
      syndicateRisk,
      syndicateProb,
      correlatedRisk,
      correlatedExploitRate,
      action,
      unknown: [...unknownSet],
      forensicDossier: mergedDossier,
    }
  })
}
