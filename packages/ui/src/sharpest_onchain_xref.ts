/**
 * Browser-safe cross-reference engine comparing Sharpest SportsDesk profiles against live on-chain
 * wager tracking (`GET /api/graph/live-feed`) and cross-domain bridge P&L divergence leads (`GET
 * /api/bridge/value`).
 */
import type { CustomerFlaggedTicketForensics, ShowcaseCustomer } from "./types.ts"

type JsonRecord = Readonly<Record<string, unknown>>

export type OnChainXrefStatus =
  "DIVERGENCE_ALERT" | "VERIFIED_LIVE" | "QUARANTINED_WALLET" | "UNLINKED_SHARP"

export type OnChainXrefCheckFlag =
  | "LIVE_ONCHAIN_VERIFIED"
  | "POLY_ONLY_UP_DIVERGENCE"
  | "SHARED_WALLET_CONDUIT"
  | "WALLET_ADDRESS_INVALID"
  | "WALLET_SOURCE_MISMATCH"
  | "SHADOW_TICKET_TRACKED"
  | "NO_ONCHAIN_ATTRIBUTION"

export interface OnChainWalletTrackRecord {
  readonly customerId: string
  readonly agentOwner: string | null
  readonly proxyWallet: string | null
  readonly shortWallet: string | null
  readonly archetype: string | null
  readonly dataSource: "LIVE" | "FIXTURE" | "UNKNOWN"
  readonly walletAddressValid: boolean
  readonly openBetsSummary: string | null
  readonly openVolumeUsd: number
  readonly openLegsCount: number
  readonly positionsValueUsd: number
  readonly openPnlUsd: number
  readonly enforcementStatus: string | null
  readonly fetchedAtIso: string | null
  readonly lastSyncedIso: string | null
  readonly lastError: string | null
  readonly polymarketProfileUrl: string | null
  readonly polymarketPositionsApiUrl: string | null
  readonly polygonscanUrl: string | null
  readonly trackedTickets: readonly CustomerFlaggedTicketForensics[]
}

export interface CrossDomainBridgeLeadRecord {
  readonly customerId: string
  readonly agentId: string
  readonly wallet: string
  readonly deskPnlUsd: number
  readonly polyPnlUsd: number
  readonly basis: string
  readonly verdict: string
  readonly priorityUsd: number
}

export interface CrossDomainBridgeSnapshot {
  readonly generatedAtIso: string | null
  readonly evidence: string | null
  readonly customersInBook: number
  readonly linkedCustomers: number
  readonly linkYieldPct: number
  readonly observedWallets: number
  readonly invalidWallets: number
  readonly sharedWallets: number
  readonly quarantined: number
  readonly deskVolumeUsd: number
  readonly polyVolumeUsd: number
  readonly polyPnlUsd: number
  readonly priorityUsd: number
  readonly leads: readonly CrossDomainBridgeLeadRecord[]
}

export interface SharpProfileOnChainXrefRow {
  readonly customerId: string
  readonly agentId: string
  readonly masterAgent: string
  readonly tier: ShowcaseCustomer["tier"]
  readonly sharpScore: number
  readonly clvScore: number
  readonly holdPct: number
  readonly ltvUsd: number
  readonly holdKnown: boolean
  readonly status: OnChainXrefStatus
  readonly statusLabel: string
  readonly flags: readonly OnChainXrefCheckFlag[]
  readonly checksPassed: number
  readonly checksTotal: number
  readonly proxyWallet: string | null
  readonly shortWallet: string | null
  readonly walletFormatValid: boolean
  readonly walletAddressValid: boolean | null
  readonly walletSourceMismatch: boolean
  readonly sharedWithCustomerIds: readonly string[]
  readonly lastError: string | null
  readonly dataSource: "LIVE" | "FIXTURE" | "UNTRACKED"
  readonly openVolumeUsd: number
  readonly openLegsCount: number
  readonly positionsValueUsd: number
  readonly openPnlUsd: number
  readonly openBetsSummary: string | null
  readonly enforcementStatus: string | null
  readonly fetchedAtIso: string | null
  readonly archetype: string | null
  readonly trackedTicketCount: number
  readonly trackedTicketRiskUsd: number
  readonly trackedTickets: readonly CustomerFlaggedTicketForensics[]
  readonly bridgeVerdict: string | null
  readonly bridgeDeskPnlUsd: number | null
  readonly bridgePolyPnlUsd: number | null
  readonly bridgeBasis: string | null
  readonly bridgePriorityUsd: number
  readonly polymarketProfileUrl: string | null
  readonly polymarketPositionsApiUrl: string | null
  readonly polygonscanUrl: string | null
}

export interface SharpestOnChainXrefSummary {
  readonly sharpThreshold: number
  readonly totalSharpProfiles: number
  readonly linkedSharpCount: number
  readonly verifiedLiveCount: number
  readonly divergenceAlertCount: number
  readonly quarantinedCount: number
  readonly unlinkedCount: number
  readonly sharedWalletAccountCount: number
  readonly totalOnChainVolumeUsd: number
  readonly totalPositionsValueUsd: number
  readonly totalTrackedTicketRiskUsd: number
  readonly totalBridgePriorityUsd: number
  readonly coveragePct: number
  readonly bridgeEvidence: string | null
  readonly bridgeGeneratedAtIso: string | null
}

export interface SharpestOnChainXrefReport {
  readonly rows: readonly SharpProfileOnChainXrefRow[]
  readonly byCustomerId: ReadonlyMap<string, SharpProfileOnChainXrefRow>
  readonly summary: SharpestOnChainXrefSummary
}

export const DEFAULT_SHARP_XREF_THRESHOLD = 7.0

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

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

function shortenWallet(wallet: string | null): string | null {
  if (!wallet) return null
  if (wallet.length <= 12) return wallet
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
}

/** Validate a standard 20-byte EVM hex wallet address (`0x` + 40 hex characters). */
export function isValidEvmAddress(address: string | null | undefined): boolean {
  if (!address) return false
  return EVM_ADDRESS_RE.test(address.trim())
}

/** Normalize the `GET /api/bridge/value` (`docs/cross-domain-bridge.json`) payload. */
export function parseCrossDomainBridgeSnapshot(raw: unknown): CrossDomainBridgeSnapshot | null {
  const root = asRecord(raw)
  if (!root) return null

  const coverage = asRecord(root.coverage)
  const value = asRecord(root.value)
  const leads: CrossDomainBridgeLeadRecord[] = []

  for (const rawLead of asArray(root.leads)) {
    const rec = asRecord(rawLead)
    if (!rec) continue
    const customerId = asText(rec.customerId)?.toUpperCase()
    const wallet = asText(rec.wallet)
    if (!customerId || !wallet) continue
    leads.push({
      customerId,
      agentId: asText(rec.agentId) ?? "—",
      wallet,
      deskPnlUsd: asNumber(rec.deskPnlUsd) ?? 0,
      polyPnlUsd: asNumber(rec.polyPnlUsd) ?? 0,
      basis: asText(rec.basis) ?? "GROSS",
      verdict: asText(rec.verdict) ?? "UNKNOWN",
      priorityUsd: asNumber(rec.priorityUsd) ?? 0,
    })
  }

  return {
    generatedAtIso: asText(root.generatedAtIso),
    evidence: asText(root.evidence),
    customersInBook: asNumber(coverage?.customersInBook) ?? 0,
    linkedCustomers: asNumber(coverage?.linkedCustomers) ?? leads.length,
    linkYieldPct: asNumber(coverage?.linkYieldPct) ?? 0,
    observedWallets: asNumber(coverage?.observedWallets) ?? 0,
    invalidWallets: asNumber(coverage?.invalidWallets) ?? 0,
    sharedWallets: asNumber(coverage?.sharedWallets) ?? 0,
    quarantined: asNumber(root.quarantined) ?? 0,
    deskVolumeUsd: asNumber(value?.deskVolumeUsd) ?? 0,
    polyVolumeUsd: asNumber(value?.polyVolumeUsd) ?? 0,
    polyPnlUsd: asNumber(value?.polyPnlUsd) ?? 0,
    priorityUsd: asNumber(value?.priorityUsd) ?? 0,
    leads,
  }
}

/**
 * Index live on-chain wallet tracking records and pending/shadow on-chain wagers from
 * `docs/graph-live-feed.json` (`GET /api/graph/live-feed`) by uppercase customer ID.
 */
export function indexOnChainWalletTracking(
  rawGraphFeed: unknown,
): ReadonlyMap<string, OnChainWalletTrackRecord> {
  const root = asRecord(rawGraphFeed)
  const out = new Map<string, OnChainWalletTrackRecord>()
  if (!root) return out

  const ticketsByCustomer = new Map<string, CustomerFlaggedTicketForensics[]>()
  for (const rawTicket of [...asArray(root.pendingBets), ...asArray(root.flaggedTickets)]) {
    const t = asRecord(rawTicket)
    if (!t) continue
    const custId = asText(t.f402CustomerId)?.toUpperCase()
    const ticketId = asText(t.ticketId)
    if (!custId || !ticketId) continue
    let list = ticketsByCustomer.get(custId)
    if (!list) {
      list = []
      ticketsByCustomer.set(custId, list)
    }
    if (!list.some((existing) => existing.ticketId === ticketId)) {
      list.push({
        ticketId,
        sourceVenue: asText(t.sourceVenue) ?? "UNKNOWN",
        sportAndPeriod: asText(t.sportAndPeriod) ?? "—",
        canonicalMarket: asText(t.canonicalMarket) ?? "—",
        oddsAmerican: asText(t.oddsAmerican) ?? "—",
        riskUsd: asNumber(t.riskUsd) ?? 0,
        toWinUsd: asNumber(t.toWinUsd) ?? 0,
        pmEntryVsFair: asText(t.pmEntryVsFair) ?? "—",
        placedAtUtc: asText(t.placedAtUtc) ?? "—",
        deskVerdict: asText(t.deskVerdict) ?? "—",
      })
    }
  }

  for (const rawProfile of asArray(root.walletProfiles)) {
    const prof = asRecord(rawProfile)
    if (!prof) continue
    const customerId = asText(prof.f402CustomerId)?.toUpperCase()
    if (!customerId) continue

    const proxyWallet = asText(prof.proxyWallet)
    const rawDataSource = asText(prof.dataSource)?.toUpperCase()
    const dataSource: "LIVE" | "FIXTURE" | "UNKNOWN" =
      rawDataSource === "LIVE" ? "LIVE" : rawDataSource === "FIXTURE" ? "FIXTURE" : "UNKNOWN"
    const walletAddressValid =
      typeof prof.walletAddressValid === "boolean"
        ? prof.walletAddressValid
        : isValidEvmAddress(proxyWallet)

    out.set(customerId, {
      customerId,
      agentOwner: asText(prof.agentOwner),
      proxyWallet,
      shortWallet: asText(prof.shortWallet) ?? shortenWallet(proxyWallet),
      archetype: asText(prof.archetype),
      dataSource,
      walletAddressValid,
      openBetsSummary: asText(prof.openBetsSummary),
      openVolumeUsd: asNumber(prof.openVolumeUsd) ?? 0,
      openLegsCount: asNumber(prof.openLegsCount) ?? 0,
      positionsValueUsd: asNumber(prof.positionsValueUsd) ?? 0,
      openPnlUsd: asNumber(prof.openPnlUsd) ?? 0,
      enforcementStatus: asText(prof.enforcementStatus),
      fetchedAtIso: asText(prof.fetchedAtIso),
      lastSyncedIso: asText(prof.lastSyncedIso),
      lastError: asText(prof.lastError),
      polymarketProfileUrl: asText(prof.polymarketProfileUrl),
      polymarketPositionsApiUrl: asText(prof.polymarketPositionsApiUrl),
      polygonscanUrl: asText(prof.polygonscanUrl),
      trackedTickets: ticketsByCustomer.get(customerId) ?? [],
    })
  }

  // Also capture customers who appear in pendingBets with a proxyWallet even if absent from walletProfiles
  for (const [custId, tickets] of ticketsByCustomer.entries()) {
    if (out.has(custId)) continue
    out.set(custId, {
      customerId: custId,
      agentOwner: null,
      proxyWallet: null,
      shortWallet: null,
      archetype: null,
      dataSource: "UNKNOWN",
      walletAddressValid: false,
      openBetsSummary: null,
      openVolumeUsd: 0,
      openLegsCount: 0,
      positionsValueUsd: 0,
      openPnlUsd: 0,
      enforcementStatus: null,
      fetchedAtIso: null,
      lastSyncedIso: null,
      lastError: null,
      polymarketProfileUrl: null,
      polymarketPositionsApiUrl: null,
      polygonscanUrl: null,
      trackedTickets: tickets,
    })
  }

  return out
}

const STATUS_LABELS: Readonly<Record<OnChainXrefStatus, string>> = {
  DIVERGENCE_ALERT: "Divergence Alert",
  VERIFIED_LIVE: "Verified Live",
  QUARANTINED_WALLET: "Quarantined Wallet",
  UNLINKED_SHARP: "Unlinked Sharp",
}

const STATUS_PRIORITY: Readonly<Record<OnChainXrefStatus, number>> = {
  DIVERGENCE_ALERT: 0,
  QUARANTINED_WALLET: 1,
  VERIFIED_LIVE: 2,
  UNLINKED_SHARP: 3,
}

export interface BuildSharpestOnChainXrefInput {
  readonly profiles: readonly ShowcaseCustomer[]
  readonly rawGraphFeed: unknown
  readonly bridgeSnapshot: CrossDomainBridgeSnapshot | null
  readonly minSharpScore?: number | undefined
}

/**
 * Cross-reference sharpest SportsDesk profiles against on-chain wallet tracking and cross-domain
 * Polymarket bridge P&L divergence leads.
 */
export function buildSharpestOnChainXrefReport(
  input: BuildSharpestOnChainXrefInput,
): SharpestOnChainXrefReport {
  const minSharpScore = input.minSharpScore ?? DEFAULT_SHARP_XREF_THRESHOLD
  const walletTrackById = indexOnChainWalletTracking(input.rawGraphFeed)
  const bridgeLeadById = new Map<string, CrossDomainBridgeLeadRecord>()
  for (const lead of input.bridgeSnapshot?.leads ?? []) {
    bridgeLeadById.set(lead.customerId.toUpperCase(), lead)
  }

  // Build global wallet -> customer IDs sharing index across profiles, walletProfiles, and bridge leads
  const walletOwners = new Map<string, Set<string>>()
  const registerWalletOwner = (wallet: string | null | undefined, custId: string) => {
    if (!wallet) return
    const norm = wallet.trim().toLowerCase()
    if (!norm) return
    let set = walletOwners.get(norm)
    if (!set) {
      set = new Set<string>()
      walletOwners.set(norm, set)
    }
    set.add(custId.toUpperCase())
  }

  for (const prof of input.profiles) {
    const id = prof.id.toUpperCase()
    registerWalletOwner(prof.forensicDossier?.parlayBacktest?.proxyWallet, id)
    registerWalletOwner(prof.forensicDossier?.telemetryOverview?.polymarketWallet, id)
  }
  for (const [id, rec] of walletTrackById.entries()) {
    registerWalletOwner(rec.proxyWallet, id)
  }
  for (const [id, lead] of bridgeLeadById.entries()) {
    registerWalletOwner(lead.wallet, id)
  }

  const byCustomerId = new Map<string, SharpProfileOnChainXrefRow>()
  const sharpRows: SharpProfileOnChainXrefRow[] = []

  const evaluateProfile = (cust: ShowcaseCustomer): SharpProfileOnChainXrefRow => {
    const id = cust.id.toUpperCase()
    const track = walletTrackById.get(id) ?? null
    const bridgeLead = bridgeLeadById.get(id) ?? null
    const backtestWallet = cust.forensicDossier?.parlayBacktest?.proxyWallet ?? null
    const telemetryWallet = cust.forensicDossier?.telemetryOverview?.polymarketWallet ?? null

    const candidateWallets = [
      track?.proxyWallet,
      bridgeLead?.wallet,
      backtestWallet,
      telemetryWallet,
    ]
      .filter((w): w is string => Boolean(w && w.trim().length > 0))
      .map((w) => w.trim())
    const uniqueNormalizedWallets = new Set(candidateWallets.map((w) => w.toLowerCase()))
    const walletSourceMismatch = uniqueNormalizedWallets.size > 1

    const proxyWallet = candidateWallets[0] ?? null
    const shortWallet =
      track?.shortWallet ??
      cust.forensicDossier?.parlayBacktest?.shortWallet ??
      shortenWallet(proxyWallet)
    const walletFormatValid = isValidEvmAddress(proxyWallet)
    const walletAddressValid =
      track !== null
        ? track.walletAddressValid && walletFormatValid
        : proxyWallet !== null
          ? walletFormatValid
          : null

    const sharedWithCustomerIds = proxyWallet
      ? [...(walletOwners.get(proxyWallet.toLowerCase()) ?? [])]
          .filter((ownerId) => ownerId !== id)
          .sort()
      : []

    const trackedTickets =
      track && track.trackedTickets.length > 0
        ? track.trackedTickets
        : (cust.forensicDossier?.flaggedTickets ?? [])
    const trackedTicketRiskUsd = trackedTickets.reduce((sum, t) => sum + t.riskUsd, 0)

    const dataSource: "LIVE" | "FIXTURE" | "UNTRACKED" =
      track?.dataSource === "LIVE"
        ? "LIVE"
        : track?.dataSource === "FIXTURE"
          ? "FIXTURE"
          : "UNTRACKED"

    const flags: OnChainXrefCheckFlag[] = []
    if (!proxyWallet) {
      flags.push("NO_ONCHAIN_ATTRIBUTION")
    }
    if (
      proxyWallet &&
      (!walletFormatValid || walletAddressValid === false || Boolean(track?.lastError))
    ) {
      flags.push("WALLET_ADDRESS_INVALID")
    }
    if (walletSourceMismatch) {
      flags.push("WALLET_SOURCE_MISMATCH")
    }
    if (sharedWithCustomerIds.length > 0) {
      flags.push("SHARED_WALLET_CONDUIT")
    }
    if (dataSource === "LIVE" && walletAddressValid === true) {
      flags.push("LIVE_ONCHAIN_VERIFIED")
    }
    if (bridgeLead?.verdict === "POLY_ONLY_UP") {
      flags.push("POLY_ONLY_UP_DIVERGENCE")
    }
    if (trackedTickets.length > 0) {
      flags.push("SHADOW_TICKET_TRACKED")
    }

    const hasInvalidWallet = flags.includes("WALLET_ADDRESS_INVALID")
    const hasDivergence =
      flags.includes("POLY_ONLY_UP_DIVERGENCE") ||
      flags.includes("SHARED_WALLET_CONDUIT") ||
      walletSourceMismatch

    let status: OnChainXrefStatus
    if (!proxyWallet) {
      status = "UNLINKED_SHARP"
    } else if (hasInvalidWallet) {
      status = "QUARANTINED_WALLET"
    } else if (hasDivergence) {
      status = "DIVERGENCE_ALERT"
    } else if (dataSource === "LIVE" || bridgeLead !== null || trackedTickets.length > 0) {
      status = "VERIFIED_LIVE"
    } else {
      status = "QUARANTINED_WALLET"
    }

    // 4 concrete cross-reference assertions:
    // 1) Valid 42-char EVM wallet mapped  2) No cross-source wallet mismatch
    // 3) Live on-chain feed synced (no error)  4) No unresolved shared-wallet / POLY_ONLY_UP divergence
    const checksTotal = 4
    let checksPassed = 0
    if (proxyWallet && walletFormatValid && walletAddressValid !== false) checksPassed += 1
    if (proxyWallet && !walletSourceMismatch) checksPassed += 1
    if (dataSource === "LIVE" && !track?.lastError) checksPassed += 1
    if (
      proxyWallet &&
      !flags.includes("POLY_ONLY_UP_DIVERGENCE") &&
      sharedWithCustomerIds.length === 0
    ) {
      checksPassed += 1
    }

    const polymarketProfileUrl =
      track?.polymarketProfileUrl ??
      cust.forensicDossier?.telemetryOverview?.polymarketProfileUrl ??
      cust.forensicDossier?.parlayBacktest?.polymarketProfileUrl ??
      (proxyWallet && walletFormatValid ? `https://polymarket.com/profile/${proxyWallet}` : null)

    const polymarketPositionsApiUrl =
      track?.polymarketPositionsApiUrl ??
      cust.forensicDossier?.parlayBacktest?.polymarketPositionsApiUrl ??
      (proxyWallet && walletFormatValid
        ? `https://data-api.polymarket.com/v2/positions?user=${proxyWallet}`
        : null)

    const polygonscanUrl =
      track?.polygonscanUrl ??
      cust.forensicDossier?.telemetryOverview?.polygonscanUrl ??
      (proxyWallet && walletFormatValid ? `https://polygonscan.com/address/${proxyWallet}` : null)

    const unknown = cust.unknown ?? []
    return {
      customerId: cust.id,
      agentId: cust.agentId,
      masterAgent: cust.masterAgent,
      tier: cust.tier,
      sharpScore: cust.score,
      clvScore: cust.clvScore,
      holdPct: cust.holdPct,
      ltvUsd: cust.ltvUsd,
      holdKnown: !unknown.includes("holdPct"),
      status,
      statusLabel: STATUS_LABELS[status],
      flags,
      checksPassed,
      checksTotal,
      proxyWallet,
      shortWallet,
      walletFormatValid,
      walletAddressValid,
      walletSourceMismatch,
      sharedWithCustomerIds,
      lastError: track?.lastError ?? (!walletFormatValid && proxyWallet ? "invalid address" : null),
      dataSource,
      openVolumeUsd: track?.openVolumeUsd ?? 0,
      openLegsCount: track?.openLegsCount ?? 0,
      positionsValueUsd: track?.positionsValueUsd ?? 0,
      openPnlUsd: track?.openPnlUsd ?? 0,
      openBetsSummary: track?.openBetsSummary ?? null,
      enforcementStatus: track?.enforcementStatus ?? null,
      fetchedAtIso: track?.fetchedAtIso ?? null,
      archetype: track?.archetype ?? cust.forensicDossier?.telemetryOverview?.archetype ?? null,
      trackedTicketCount: trackedTickets.length,
      trackedTicketRiskUsd,
      trackedTickets,
      bridgeVerdict: bridgeLead?.verdict ?? null,
      bridgeDeskPnlUsd: bridgeLead?.deskPnlUsd ?? null,
      bridgePolyPnlUsd: bridgeLead?.polyPnlUsd ?? null,
      bridgeBasis: bridgeLead?.basis ?? null,
      bridgePriorityUsd: bridgeLead?.priorityUsd ?? 0,
      polymarketProfileUrl,
      polymarketPositionsApiUrl,
      polygonscanUrl,
    }
  }

  for (const cust of input.profiles) {
    const row = evaluateProfile(cust)
    byCustomerId.set(cust.id.toUpperCase(), row)
    const isSharpProfile =
      cust.score >= minSharpScore ||
      cust.tier === "TIER_1_ELITE_ORIGINATOR" ||
      cust.tier === "TIER_2_STEAM_SYNDICATE"
    if (isSharpProfile) {
      sharpRows.push(row)
    }
  }

  sharpRows.sort((a, b) => {
    const priDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]
    if (priDiff !== 0) return priDiff
    if (b.bridgePriorityUsd !== a.bridgePriorityUsd)
      return b.bridgePriorityUsd - a.bridgePriorityUsd
    return b.sharpScore - a.sharpScore
  })

  let linkedSharpCount = 0
  let verifiedLiveCount = 0
  let divergenceAlertCount = 0
  let quarantinedCount = 0
  let unlinkedCount = 0
  let sharedWalletAccountCount = 0
  let totalOnChainVolumeUsd = 0
  let totalPositionsValueUsd = 0
  let totalTrackedTicketRiskUsd = 0
  let totalBridgePriorityUsd = 0

  for (const row of sharpRows) {
    if (row.proxyWallet) linkedSharpCount += 1
    if (row.status === "VERIFIED_LIVE") verifiedLiveCount += 1
    else if (row.status === "DIVERGENCE_ALERT") divergenceAlertCount += 1
    else if (row.status === "QUARANTINED_WALLET") quarantinedCount += 1
    else unlinkedCount += 1

    if (row.sharedWithCustomerIds.length > 0) sharedWalletAccountCount += 1
    totalOnChainVolumeUsd += row.openVolumeUsd
    totalPositionsValueUsd += row.positionsValueUsd
    totalTrackedTicketRiskUsd += row.trackedTicketRiskUsd
    totalBridgePriorityUsd += row.bridgePriorityUsd
  }

  const coveragePct =
    sharpRows.length > 0 ? Math.round((linkedSharpCount / sharpRows.length) * 1000) / 10 : 0

  return {
    rows: sharpRows,
    byCustomerId,
    summary: {
      sharpThreshold: minSharpScore,
      totalSharpProfiles: sharpRows.length,
      linkedSharpCount,
      verifiedLiveCount,
      divergenceAlertCount,
      quarantinedCount,
      unlinkedCount,
      sharedWalletAccountCount,
      totalOnChainVolumeUsd,
      totalPositionsValueUsd,
      totalTrackedTicketRiskUsd,
      totalBridgePriorityUsd,
      coveragePct,
      bridgeEvidence: input.bridgeSnapshot?.evidence ?? null,
      bridgeGeneratedAtIso: input.bridgeSnapshot?.generatedAtIso ?? null,
    },
  }
}
