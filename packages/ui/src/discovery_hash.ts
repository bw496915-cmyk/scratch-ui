/**
 * @file packages/ui/src/discovery_hash.ts
 * @description Canonical structured hash routing, deep-linking codec, and SoA
 * Discovery Dimension registry for SportsDesk Operations.
 *
 * Canonical hash grammar:
 *   #/{section}/{tab}[/tier:{tier}][/customer:{id}][/ch:{channel}][/sport:{sport}]
 *     [/ticket:{ticketId}][/agent:{agentId}][/alert:{filter}][/sev:{severity}]
 *     [/rot:{rotId}][/pair:{accountI}~{accountJ}][/dim:{discoveryDimensionId}]
 *
 * Legacy flat hashes (e.g. `#customers`, `#risk-overview`, `#wagers`, `#shadow`)
 * remain 100% supported on read and upgrade seamlessly to structured canonical
 * hashes on navigation.
 */

import { type DashboardTabId, resolveDashboardTabId } from "./types.ts"

// ---------------------------------------------------------------------------
// 1. Canonical Dashboard Section Hierarchy (shared across breadcrumbs & hashes)
// ---------------------------------------------------------------------------

export type DashboardSectionId =
  | "risk-exposure"
  | "bettor-intelligence"
  | "operations-telemetry"
  | "platform-infrastructure"

export interface DashboardSectionMeta {
  readonly id: DashboardSectionId
  readonly label: string
  readonly landingTab: DashboardTabId
}

export const DASHBOARD_SECTIONS: Readonly<Record<DashboardSectionId, DashboardSectionMeta>> =
  Object.freeze({
    "risk-exposure": {
      id: "risk-exposure",
      label: "Risk & Exposure",
      landingTab: "risk-overview",
    },
    "bettor-intelligence": {
      id: "bettor-intelligence",
      label: "Bettor Intelligence",
      landingTab: "customers",
    },
    "operations-telemetry": {
      id: "operations-telemetry",
      label: "Operations & Telemetry",
      landingTab: "surveillance",
    },
    "platform-infrastructure": {
      id: "platform-infrastructure",
      label: "Platform & Infrastructure",
      landingTab: "status-dashboard",
    },
  })

const TAB_TO_SECTION: Readonly<Record<DashboardTabId, DashboardSectionId>> = Object.freeze({
  "risk-overview": "risk-exposure",
  wagers: "risk-exposure",
  "bet-ticker": "risk-exposure",
  shadow: "risk-exposure",
  customers: "bettor-intelligence",
  rankings: "bettor-intelligence",
  "churn-simulation": "bettor-intelligence",
  surveillance: "operations-telemetry",
  alerts: "operations-telemetry",
  "system-logs": "operations-telemetry",
  terminal: "operations-telemetry",
  "status-dashboard": "platform-infrastructure",
  r2: "platform-infrastructure",
  assets: "platform-infrastructure",
})

export const ROOT_DASHBOARD_TAB: DashboardTabId = "risk-overview"

export function getSectionForTab(tab: DashboardTabId): DashboardSectionMeta {
  return DASHBOARD_SECTIONS[TAB_TO_SECTION[tab]]
}

// ---------------------------------------------------------------------------
// 2. Discovery Dimensions Registry & SoA Slab Estimator Specs
// ---------------------------------------------------------------------------

export const DISCOVERY_DIMENSION_IDS = [
  "directional-asymmetry",
  "exogenous-conditioning",
  "information-flow",
  "timing-regularity",
  "null-model-significance",
  "live-realized-net-spread",
  "topology-discovery",
] as const

export type DiscoveryDimensionId = (typeof DISCOVERY_DIMENSION_IDS)[number]

export type DiscoveryDimensionTone = "sky" | "amber" | "violet" | "emerald" | "slate" | "red" | "cyan"

export interface DiscoveryDimensionSpec {
  readonly id: DiscoveryDimensionId
  readonly dimension: string
  readonly estimator: string
  readonly symbol: string
  readonly shortCode: string
  readonly formula: string
  readonly soaSlabs: readonly string[]
  readonly whatItSurfaces: string
  readonly primaryTab: DashboardTabId
  readonly aliases: readonly string[]
  readonly tone: DiscoveryDimensionTone
}

export const DISCOVERY_DIMENSIONS: Readonly<Record<DiscoveryDimensionId, DiscoveryDimensionSpec>> =
  Object.freeze({
    "directional-asymmetry": {
      id: "directional-asymmetry",
      dimension: "Directional Asymmetry",
      estimator: "Signed Lead-Lag Index (A_ij) & IQR",
      symbol: "Aᵢⱼ",
      shortCode: "A_ij",
      formula: "A_ij = (N(t_j > t_i) - N(t_j < t_i)) / N_ij ∈ [-1, 1], plus p50, p95, IQR of Δt_ij",
      soaSlabs: ["tsMs:Float64Array", "accountIdx:Uint32Array", "rotId:Uint32Array"],
      whatItSurfaces:
        "Measures pure directional ordering and timing dispersion without assuming a fixed hierarchy.",
      primaryTab: "customers",
      aliases: ["a_ij", "aij", "lead-lag", "directional", "asymmetry"],
      tone: "sky",
    },
    "exogenous-conditioning": {
      id: "exogenous-conditioning",
      dimension: "Exogenous Conditioning",
      estimator: "Conditional Intensity Ratio (Λ_ij|E)",
      symbol: "Λᵢⱼ|E",
      shortCode: "Lambda_ij|E",
      formula: "Λ_ij|E = P(j in W | i, E) / P(j in W | E) where E = external sharp line move within W",
      soaSlabs: ["tsMs:Float64Array", "extSharpMoveMask:Uint8Array", "rotId:Uint32Array"],
      whatItSurfaces:
        "Separates direct account-to-account coupling (Λ ≫ 1) from independent reactions to the same public line move (Λ ≈ 1).",
      primaryTab: "wagers",
      aliases: ["lambda", "lambda_ij", "exogenous", "conditioning", "intensity"],
      tone: "amber",
    },
    "information-flow": {
      id: "information-flow",
      dimension: "Information Flow",
      estimator: "Discrete Transfer Entropy (T_i→j)",
      symbol: "Tᵢ→ⱼ",
      shortCode: "T_i->j",
      formula: "I(X_j(t); X_i(t - Δ) | M_ext(t)) over ROT × time bins",
      soaSlabs: ["rotBin:Uint32Array", "timeBin:Uint32Array", "mktStateBitset:Uint32Array"],
      whatItSurfaces:
        "Quantifies how many bits of account j's action are uniquely explained by account i's prior action beyond market state.",
      primaryTab: "customers",
      aliases: ["t_ij", "te", "transfer-entropy", "entropy", "info-flow"],
      tone: "violet",
    },
    "timing-regularity": {
      id: "timing-regularity",
      dimension: "Timing Regularity",
      estimator: "Burstiness / Fano Factor (B_ij)",
      symbol: "Bᵢⱼ",
      shortCode: "B_ij",
      formula: "B_ij = (σ(Δt) - μ(Δt)) / (σ(Δt) + μ(Δt)) ∈ [-1, 1]",
      soaSlabs: ["deltaTsMs:Float64Array", "pairEdgeIdx:Uint32Array"],
      whatItSurfaces:
        "B → -1 exposes periodic/clocked execution; B → +1 exposes bursty event-driven clustering.",
      primaryTab: "wagers",
      aliases: ["b_ij", "bij", "burstiness", "fano", "timing"],
      tone: "emerald",
    },
    "null-model-significance": {
      id: "null-model-significance",
      dimension: "Null-Model Significance",
      estimator: "Hypergeometric Lift & p-value (L_ij)",
      symbol: "Lᵢⱼ",
      shortCode: "L_ij",
      formula: "L_ij = O_ij / E[O_ij] from per-account ROT degree counts",
      soaSlabs: ["rotDegree:Uint32Array", "coOccurCount:Uint32Array", "totalRots:Uint32"],
      whatItSurfaces: "Filters high-volume marquee-game collisions automatically.",
      primaryTab: "rankings",
      aliases: ["l_ij", "lij", "lift", "hypergeometric", "null-model"],
      tone: "slate",
    },
    "live-realized-net-spread": {
      id: "live-realized-net-spread",
      dimension: "Live Realized Net Spread",
      estimator: "Live Executable Delta (Δ_exec)",
      symbol: "Δₑₓₑc",
      shortCode: "Delta_exec",
      formula: "realizedClvBps_ij - (liveVwapSlipBps_ROT + liveTakerFeeBps_ROT)",
      soaSlabs: [
        "realizedClvBps:Float32Array",
        "liveVwapSlipBps:Float32Array",
        "liveTakerFeeBps:Float32Array",
      ],
      whatItSurfaces:
        "Exact live-API basis points available for prediction-market lay-off vs. retaining risk, with zero simulation.",
      primaryTab: "shadow",
      aliases: ["delta_exec", "exec", "net-spread", "layoff", "clv-spread"],
      tone: "red",
    },
    "topology-discovery": {
      id: "topology-discovery",
      dimension: "Topology Discovery",
      estimator: "Spectral / Modularity Clustering on CSR",
      symbol: "CSR",
      shortCode: "CSR-Louvain",
      formula: "Weighted Louvain / spectral partitioning over Λ_ij|E and T_i→j",
      soaSlabs: [
        "csrRowPtr:Uint32Array",
        "csrColIdx:Uint32Array",
        "csrWeightLambda:Float32Array",
        "csrWeightTE:Float32Array",
      ],
      whatItSurfaces:
        "Discovers arbitrary graph shapes (stars, chains, cliques, bipartite arb pairs) from the data instead of forcing a 3-tier template.",
      primaryTab: "rankings",
      aliases: ["csr", "louvain", "spectral", "topology", "graph"],
      tone: "cyan",
    },
  })

export const DISCOVERY_DIMENSION_LIST: readonly DiscoveryDimensionSpec[] = Object.freeze(
  DISCOVERY_DIMENSION_IDS.map((id) => DISCOVERY_DIMENSIONS[id]),
)

const DISCOVERY_DIMENSION_SET: ReadonlySet<string> = new Set(DISCOVERY_DIMENSION_IDS)

const DISCOVERY_DIMENSION_ALIAS_MAP: Readonly<Record<string, DiscoveryDimensionId>> = Object.freeze(
  Object.fromEntries(
    DISCOVERY_DIMENSION_IDS.flatMap((id) =>
      DISCOVERY_DIMENSIONS[id].aliases.map((alias) => [alias.toLowerCase(), id] as const),
    ),
  ),
)

export function isDiscoveryDimensionId(value: unknown): value is DiscoveryDimensionId {
  return typeof value === "string" && DISCOVERY_DIMENSION_SET.has(value)
}

export function resolveDiscoveryDimensionId(raw: unknown): DiscoveryDimensionId | null {
  if (typeof raw !== "string") return null
  const cleaned = raw.trim().toLowerCase()
  if (!cleaned) return null
  if (isDiscoveryDimensionId(cleaned)) return cleaned
  return DISCOVERY_DIMENSION_ALIAS_MAP[cleaned] ?? null
}

// ---------------------------------------------------------------------------
// 3. Pure SoA Slab Estimator Primitives (Zero Simulation, Exact Arithmetic)
// ---------------------------------------------------------------------------

export interface LeadLagEstimate {
  readonly aij: number | null
  readonly nTotal: number
  readonly nForward: number
  readonly nReverse: number
  readonly p50Ms: number | null
  readonly p95Ms: number | null
  readonly iqrMs: number | null
}

function sortedQuantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]!
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  const weight = pos - lo
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight
}

/**
 * Computes Signed Lead-Lag Index A_ij ∈ [-1, 1] and timing dispersion (p50, p95, IQR)
 * directly over a slab of signed timestamp deltas Δt_ij = t_j - t_i (in ms).
 */
export function computeLeadLagIndex(deltasMs: ArrayLike<number>): LeadLagEstimate {
  const valid: number[] = []
  let nForward = 0
  let nReverse = 0
  for (let idx = 0; idx < deltasMs.length; idx += 1) {
    const dt = deltasMs[idx]
    if (typeof dt !== "number" || !Number.isFinite(dt)) continue
    valid.push(dt)
    if (dt > 0) nForward += 1
    else if (dt < 0) nReverse += 1
  }
  const nTotal = valid.length
  if (nTotal === 0) {
    return {
      aij: null,
      nTotal: 0,
      nForward: 0,
      nReverse: 0,
      p50Ms: null,
      p95Ms: null,
      iqrMs: null,
    }
  }
  valid.sort((a, b) => a - b)
  const q25 = sortedQuantile(valid, 0.25)
  const p50Ms = sortedQuantile(valid, 0.5)
  const q75 = sortedQuantile(valid, 0.75)
  const p95Ms = sortedQuantile(valid, 0.95)
  return {
    aij: (nForward - nReverse) / nTotal,
    nTotal,
    nForward,
    nReverse,
    p50Ms,
    p95Ms,
    iqrMs: q75 !== null && q25 !== null ? q75 - q25 : null,
  }
}

export interface BurstinessEstimate {
  readonly bij: number | null
  readonly fanoFactor: number | null
  readonly meanMs: number | null
  readonly stdMs: number | null
  readonly sampleCount: number
}

/**
 * Computes Goh-Barabási Burstiness B_ij = (σ - μ) / (σ + μ) ∈ [-1, 1]
 * and Fano Factor σ² / μ over positive inter-event intervals Δt (ms).
 */
export function computeBurstinessIndex(intervalsMs: ArrayLike<number>): BurstinessEstimate {
  const valid: number[] = []
  let sum = 0
  for (let idx = 0; idx < intervalsMs.length; idx += 1) {
    const dt = intervalsMs[idx]
    if (typeof dt !== "number" || !Number.isFinite(dt) || dt < 0) continue
    valid.push(dt)
    sum += dt
  }
  const n = valid.length
  if (n === 0) {
    return { bij: null, fanoFactor: null, meanMs: null, stdMs: null, sampleCount: 0 }
  }
  const meanMs = sum / n
  let sqDiffSum = 0
  for (const dt of valid) {
    const diff = dt - meanMs
    sqDiffSum += diff * diff
  }
  const variance = sqDiffSum / n
  const stdMs = Math.sqrt(variance)
  const denom = stdMs + meanMs
  return {
    bij: denom > 0 ? (stdMs - meanMs) / denom : null,
    fanoFactor: meanMs > 0 ? variance / meanMs : null,
    meanMs,
    stdMs,
    sampleCount: n,
  }
}

export interface HypergeometricLiftEstimate {
  readonly observed: number
  readonly expected: number | null
  readonly lift: number | null
}

/**
 * Computes Hypergeometric Lift L_ij = O_ij / E[O_ij] where E[O_ij] = (degI * degJ) / totalRots.
 */
export function computeHypergeometricLift(
  observedCoOccur: number,
  degI: number,
  degJ: number,
  totalRots: number,
): HypergeometricLiftEstimate {
  if (
    !Number.isFinite(observedCoOccur) ||
    !Number.isFinite(degI) ||
    !Number.isFinite(degJ) ||
    !Number.isFinite(totalRots) ||
    totalRots <= 0 ||
    degI <= 0 ||
    degJ <= 0
  ) {
    return { observed: observedCoOccur, expected: null, lift: null }
  }
  const expected = (degI * degJ) / totalRots
  return {
    observed: observedCoOccur,
    expected,
    lift: expected > 0 ? observedCoOccur / expected : null,
  }
}

/**
 * Computes Conditional Intensity Ratio Λ_ij|E = P(j in W | i, E) / P(j in W | E).
 */
export function computeConditionalIntensityRatio(
  pJGivenIAndE: number,
  pJGivenE: number,
): number | null {
  if (!Number.isFinite(pJGivenIAndE) || !Number.isFinite(pJGivenE) || pJGivenE <= 0) {
    return null
  }
  return pJGivenIAndE / pJGivenE
}

/**
 * Computes Live Executable Delta Δ_exec = realizedClvBps_ij - (liveVwapSlipBps_ROT + liveTakerFeeBps_ROT).
 */
export function computeLiveExecutableDeltaBps(
  realizedClvBps: number,
  liveVwapSlipBps: number,
  liveTakerFeeBps: number,
): number | null {
  if (
    !Number.isFinite(realizedClvBps) ||
    !Number.isFinite(liveVwapSlipBps) ||
    !Number.isFinite(liveTakerFeeBps)
  ) {
    return null
  }
  return realizedClvBps - (liveVwapSlipBps + liveTakerFeeBps)
}

// ---------------------------------------------------------------------------
// 4. Canonical Structured Hash & Deep-Link Codec
// ---------------------------------------------------------------------------

export interface DashboardHashRouteContext {
  readonly activeTab: DashboardTabId
  readonly customerTierFilter?: string | null | undefined
  readonly selectedCustomerId?: string | null | undefined
  readonly wagerChannelFilter?: string | null | undefined
  readonly wagerSportFilter?: string | null | undefined
  readonly selectedWagerTicketId?: string | null | undefined
  readonly selectedAgentId?: string | null | undefined
  readonly alertFilter?: string | null | undefined
  readonly systemLogSeverityFilter?: string | null | undefined
  readonly discoveryDimension?: DiscoveryDimensionId | null | undefined
  readonly rotId?: string | null | undefined
  readonly entityPair?: readonly [string, string] | null | undefined
}

export interface ParsedDashboardHash {
  readonly isStructured: boolean
  readonly sectionId: DashboardSectionId
  readonly tab: DashboardTabId
  readonly customerTierFilter: string | null
  readonly selectedCustomerId: string | null
  readonly wagerChannelFilter: string | null
  readonly wagerSportFilter: string | null
  readonly selectedWagerTicketId: string | null
  readonly selectedAgentId: string | null
  readonly alertFilter: string | null
  readonly systemLogSeverityFilter: string | null
  readonly discoveryDimension: DiscoveryDimensionId | null
  readonly rotId: string | null
  readonly entityPair: readonly [string, string] | null
}

function cleanSegmentValue(value: string | null | undefined): string {
  return value?.trim() ?? ""
}

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * Serializes a dashboard view + entity context + optional Discovery Dimension
 * into a deterministic, human-readable canonical hash fragment:
 *   `#/{section}/{tab}[/tier:...][/customer:...][/dim:...]`
 */
export function serializeDashboardHash(ctx: DashboardHashRouteContext): string {
  const section = getSectionForTab(ctx.activeTab)
  const segments: string[] = [section.id, ctx.activeTab]

  if (ctx.activeTab === "customers") {
    const tier = cleanSegmentValue(ctx.customerTierFilter)
    if (tier && tier !== "ALL") {
      segments.push(`tier:${encodeURIComponent(tier)}`)
    }
    const cust = cleanSegmentValue(ctx.selectedCustomerId)
    if (cust) {
      segments.push(`customer:${encodeURIComponent(cust)}`)
    }
  } else if (ctx.activeTab === "wagers") {
    const ch = cleanSegmentValue(ctx.wagerChannelFilter)
    if (ch && ch !== "ALL") {
      segments.push(`ch:${encodeURIComponent(ch)}`)
    }
    const sport = cleanSegmentValue(ctx.wagerSportFilter)
    if (sport && sport !== "ALL") {
      segments.push(`sport:${encodeURIComponent(sport)}`)
    }
    const ticket = cleanSegmentValue(ctx.selectedWagerTicketId)
    if (ticket) {
      segments.push(`ticket:${encodeURIComponent(ticket)}`)
    }
  } else if (ctx.activeTab === "rankings") {
    const agent = cleanSegmentValue(ctx.selectedAgentId)
    if (agent) {
      segments.push(`agent:${encodeURIComponent(agent)}`)
    }
  } else if (ctx.activeTab === "alerts") {
    const alert = cleanSegmentValue(ctx.alertFilter)
    if (alert && alert !== "ALL") {
      segments.push(`alert:${encodeURIComponent(alert)}`)
    }
  } else if (ctx.activeTab === "system-logs") {
    const sev = cleanSegmentValue(ctx.systemLogSeverityFilter)
    if (sev && sev !== "ALL") {
      segments.push(`sev:${encodeURIComponent(sev)}`)
    }
  }

  const rot = cleanSegmentValue(ctx.rotId)
  if (rot) {
    segments.push(`rot:${encodeURIComponent(rot)}`)
  }

  if (ctx.entityPair && ctx.entityPair[0]?.trim() && ctx.entityPair[1]?.trim()) {
    const left = encodeURIComponent(ctx.entityPair[0].trim())
    const right = encodeURIComponent(ctx.entityPair[1].trim())
    segments.push(`pair:${left}~${right}`)
  }

  if (ctx.discoveryDimension && isDiscoveryDimensionId(ctx.discoveryDimension)) {
    segments.push(`dim:${ctx.discoveryDimension}`)
  }

  return `#/${segments.join("/")}`
}

const VALID_SECTION_IDS: ReadonlySet<string> = new Set(Object.keys(DASHBOARD_SECTIONS))

/**
 * Parses either a structured canonical hash (`#/{section}/{tab}/...`) or a
 * legacy flat hash (`#customers`, `#wagers`, `#risk-overview`) back into typed state.
 */
export function parseDashboardHash(
  rawHash: string,
  fallbackTab: DashboardTabId = ROOT_DASHBOARD_TAB,
): ParsedDashboardHash | null {
  const trimmed = rawHash.trim()
  if (!trimmed || trimmed === "#" || trimmed === "#/") return null

  const body = trimmed.replace(/^#/, "")
  const isStructured = body.startsWith("/")
  const rawSegments = body
    .replace(/^\/+/, "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)

  if (rawSegments.length === 0) return null

  // Legacy flat hash like `#wagers` or `#risk-overview`
  if (!isStructured && rawSegments.length === 1 && !rawSegments[0]!.includes(":")) {
    const resolvedTab = resolveDashboardTabId(rawSegments[0], fallbackTab)
    const section = getSectionForTab(resolvedTab)
    return {
      isStructured: false,
      sectionId: section.id,
      tab: resolvedTab,
      customerTierFilter: null,
      selectedCustomerId: null,
      wagerChannelFilter: null,
      wagerSportFilter: null,
      selectedWagerTicketId: null,
      selectedAgentId: null,
      alertFilter: null,
      systemLogSeverityFilter: null,
      discoveryDimension: null,
      rotId: null,
      entityPair: null,
    }
  }

  let cursor = 0
  let sectionCandidate: DashboardSectionId | null = null
  if (VALID_SECTION_IDS.has(rawSegments[0]!)) {
    sectionCandidate = rawSegments[0]! as DashboardSectionId
    cursor = 1
  }

  let resolvedTab: DashboardTabId = sectionCandidate
    ? DASHBOARD_SECTIONS[sectionCandidate].landingTab
    : fallbackTab

  if (cursor < rawSegments.length && !rawSegments[cursor]!.includes(":")) {
    resolvedTab = resolveDashboardTabId(rawSegments[cursor], resolvedTab)
    cursor += 1
  }

  let customerTierFilter: string | null = null
  let selectedCustomerId: string | null = null
  let wagerChannelFilter: string | null = null
  let wagerSportFilter: string | null = null
  let selectedWagerTicketId: string | null = null
  let selectedAgentId: string | null = null
  let alertFilter: string | null = null
  let systemLogSeverityFilter: string | null = null
  let discoveryDimension: DiscoveryDimensionId | null = null
  let rotId: string | null = null
  let entityPair: readonly [string, string] | null = null

  for (let i = cursor; i < rawSegments.length; i += 1) {
    const seg = rawSegments[i]!
    const colonIdx = seg.indexOf(":")
    if (colonIdx <= 0) continue
    const key = seg.slice(0, colonIdx).toLowerCase()
    const val = safeDecode(seg.slice(colonIdx + 1)).trim()
    if (!val) continue

    switch (key) {
      case "tier":
        customerTierFilter = val
        break
      case "customer":
      case "cust":
        selectedCustomerId = val
        break
      case "ch":
      case "channel":
        wagerChannelFilter = val
        break
      case "sport":
        wagerSportFilter = val
        break
      case "ticket":
        selectedWagerTicketId = val
        break
      case "agent":
        selectedAgentId = val
        break
      case "alert":
        alertFilter = val
        break
      case "sev":
      case "severity":
        systemLogSeverityFilter = val
        break
      case "rot":
        rotId = val
        break
      case "pair": {
        const parts = val.split("~").map((p) => p.trim())
        if (parts.length === 2 && parts[0] && parts[1]) {
          entityPair = [parts[0], parts[1]]
        }
        break
      }
      case "dim":
      case "dimension":
      case "discovery": {
        const resolvedDim = resolveDiscoveryDimensionId(val)
        if (resolvedDim) discoveryDimension = resolvedDim
        break
      }
      default:
        break
    }
  }

  const canonicalSection = getSectionForTab(resolvedTab)

  return {
    isStructured: true,
    sectionId: canonicalSection.id,
    tab: resolvedTab,
    customerTierFilter,
    selectedCustomerId,
    wagerChannelFilter,
    wagerSportFilter,
    selectedWagerTicketId,
    selectedAgentId,
    alertFilter,
    systemLogSeverityFilter,
    discoveryDimension,
    rotId,
    entityPair,
  }
}

/**
 * Builds a shareable relative URL (`?tab=...&...#/{section}/{tab}/...`) for any
 * breadcrumb crumb, entity header link, or Discovery Dimension deep link.
 * Preserves loopback `?apiBase=` when present in `currentSearch`.
 */
export function buildCanonicalDashboardHref(
  ctx: DashboardHashRouteContext,
  currentSearch = "",
): string {
  const existing = new URLSearchParams(
    currentSearch.startsWith("?") ? currentSearch.slice(1) : currentSearch,
  )
  const params = new URLSearchParams()

  params.set("tab", ctx.activeTab)

  if (ctx.activeTab === "customers" && ctx.selectedCustomerId?.trim()) {
    params.set("customer", ctx.selectedCustomerId.trim())
  }
  if (ctx.activeTab === "rankings" && ctx.selectedAgentId?.trim()) {
    params.set("agent", ctx.selectedAgentId.trim())
  }
  if (ctx.activeTab === "wagers") {
    if (ctx.wagerChannelFilter?.trim() && ctx.wagerChannelFilter !== "ALL") {
      params.set("wChannel", ctx.wagerChannelFilter.trim())
    }
    if (ctx.wagerSportFilter?.trim() && ctx.wagerSportFilter !== "ALL") {
      params.set("wSport", ctx.wagerSportFilter.trim())
    }
    if (ctx.selectedWagerTicketId?.trim()) {
      params.set("ticket", ctx.selectedWagerTicketId.trim())
    }
  }
  if (ctx.discoveryDimension && isDiscoveryDimensionId(ctx.discoveryDimension)) {
    params.set("dim", ctx.discoveryDimension)
  }

  const apiBase = existing.get("apiBase")?.trim()
  if (apiBase) {
    params.set("apiBase", apiBase)
  }

  const hash = serializeDashboardHash(ctx)
  return `?${params.toString()}${hash}`
}

/**
 * Builds an absolute shareable permalink (origin + pathname + query + canonical hash)
 * safe for clipboard copy and external sharing.
 */
export function buildAbsoluteDiscoveryPermalink(
  ctx: DashboardHashRouteContext,
  locationLike?: {
    readonly origin?: string
    readonly pathname?: string
    readonly search?: string
  } | null,
): string {
  const search = locationLike?.search ?? ""
  const relative = buildCanonicalDashboardHref(ctx, search)
  const origin =
    locationLike?.origin && locationLike.origin !== "null" ? locationLike.origin : ""
  const pathname = locationLike?.pathname || "/"
  return origin ? `${origin}${pathname}${relative}` : `${pathname}${relative}`
}
