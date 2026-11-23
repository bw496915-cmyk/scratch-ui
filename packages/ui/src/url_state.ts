/**
 * @file packages/ui/src/url_state.ts
 * @description Shareable dashboard URL state.
 *
 * Owns only the state that is safe to put in a link: the active tab, the build
 * matrix overlay, the selected agent, wagers-table filters/sort, and
 * surveillance tab state (`survView`, `survIp`, `survHost`). Customer and ticket
 * deep links, shadow-pricing slice params (`sport`, `period`, …) and `apiBase`
 * are preserved untouched; free-text search stays out of the URL.
 */

import { isLocalDevLocation, sanitizeApiBaseParam } from "./api_base_validation.ts"
import { DASHBOARD_DEFAULT_TAB } from "./config/dashboard.ts"
import { WAGERS_DEFAULTS } from "./config/wagers.ts"
import {
  type DiscoveryDimensionId,
  isDiscoveryDimensionId,
  parseDashboardHash,
  resolveDiscoveryDimensionId,
} from "./discovery_hash.ts"
import { resolveInitialTab } from "./tab_routes.ts"
import {
  type DashboardTabId,
  isWagerSortField,
  resolveDashboardTabId,
  type WagerSortField,
} from "./types.ts"

export type SurveillanceViewMode = "interactive" | "raw"

export const SURVEILLANCE_URL_DEFAULTS = Object.freeze({
  view: "interactive" as SurveillanceViewMode,
  ip: "1.1.1.1",
  host: "fantasy402.com",
})

export interface DashboardUrlState {
  readonly tab: DashboardTabId
  readonly matrix: boolean
  /** Selected agent id for Agent Inspector modal (kept raw here; consumers uppercase for matching). */
  readonly agent: string
  /** Multi-select Agent ID filter for Downlines (`?agentID=BILLY666` or comma-separated list). */
  readonly downlineAgents?: readonly string[] | undefined
  /** Rankings handle heat-map overlay toggle (`?heatmap=0` when off; omitted when default on). */
  readonly rankingsHeatmap?: boolean | undefined
  /** Explicitly focused customer id (only written on customer-aware tabs when set). */
  readonly customer?: string | undefined
  /** Active SoA Discovery Dimension estimator (`?dim=` or `#/.../dim:`). */
  readonly discovery?: DiscoveryDimensionId | null | undefined
  readonly wSport: string
  readonly wAlert: string
  readonly wType: string
  readonly wChannel: string
  readonly wSort: WagerSortField
  readonly wDir: "asc" | "desc"
  readonly survView?: SurveillanceViewMode | undefined
  readonly survIp?: string | undefined
  readonly survHost?: string | undefined
}

export const DEFAULT_DASHBOARD_URL_STATE: DashboardUrlState = Object.freeze({
  tab: DASHBOARD_DEFAULT_TAB,
  matrix: false,
  agent: "",
  downlineAgents: [],
  customer: "",
  discovery: null,
  wSport: "ALL",
  wAlert: "ALL",
  wType: "ALL",
  wChannel: "ALL",
  wSort: WAGERS_DEFAULTS.sort_field,
  wDir: WAGERS_DEFAULTS.sort_dir,
  survView: SURVEILLANCE_URL_DEFAULTS.view,
  survIp: SURVEILLANCE_URL_DEFAULTS.ip,
  survHost: SURVEILLANCE_URL_DEFAULTS.host,
})

const P = {
  tab: "tab",
  matrix: "matrix",
  agent: "agent",
  agentID: "agentID",
  agentOwner: "agentOwner",
  agents: "agents",
  heatmap: "heatmap",
  customer: "customer",
  dim: "dim",
  discovery: "discovery",
  wSport: "wSport",
  wAlert: "wAlert",
  wType: "wType",
  wChannel: "wChannel",
  wSort: "wSort",
  wDir: "wDir",
  survView: "survView",
  survIp: "survIp",
  survHost: "survHost",
} as const

function paramsOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
}

function text(value: string | null): string {
  return value?.trim() ?? ""
}

function parseAgentList(params: URLSearchParams): readonly string[] {
  const raw =
    text(params.get(P.agentID)) || text(params.get(P.agents)) || text(params.get(P.agentOwner))
  if (raw === "") return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const piece of raw.split(",")) {
    const clean = piece.trim().toUpperCase()
    if (clean === "" || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

function filter(value: string | null): string {
  const trimmed = text(value)
  return trimmed === "" ? "ALL" : trimmed
}

function resolveSurveillanceView(value: string | null): SurveillanceViewMode {
  return text(value).toLowerCase() === "raw" ? "raw" : "interactive"
}

function parseOptionalBooleanFlag(value: string | null): boolean | undefined {
  const clean = text(value).toLowerCase()
  if (clean === "0" || clean === "false" || clean === "off") return false
  if (clean === "1" || clean === "true" || clean === "on") return true
  return undefined
}

function resolveTab(
  params: URLSearchParams,
  search: string,
  pathname: string,
  hash: string,
): DashboardTabId {
  const queryTab = text(params.get(P.tab))
  if (queryTab !== "") {
    return resolveDashboardTabId(queryTab, DASHBOARD_DEFAULT_TAB)
  }
  // Slice params are a shadow-pricing quick-jump; keep them opening that tab.
  const sport = text(params.get("sport"))
  const subSport = text(params.get("subSport"))
  if (
    (sport !== "" && sport.toUpperCase() !== "ALL") ||
    (subSport !== "" && subSport.toUpperCase() !== "ALL")
  ) {
    return "shadow"
  }
  // Downlines multi-agent deep links (`?agentID=BILLY666...`) open Rankings directly.
  if (
    text(params.get(P.agentID)) !== "" ||
    text(params.get(P.agents)) !== "" ||
    text(params.get(P.agentOwner)) !== ""
  ) {
    return "rankings"
  }
  if (hash !== "") {
    const parsedHash = parseDashboardHash(hash, DASHBOARD_DEFAULT_TAB)
    if (parsedHash) return parsedHash.tab
    return resolveDashboardTabId(hash, DASHBOARD_DEFAULT_TAB)
  }
  return resolveInitialTab(search, pathname)
}

/** Read and validate shareable state from a location search/path/hash. */
export function readDashboardUrlState(search = "", pathname = "/", hash = ""): DashboardUrlState {
  const params = paramsOf(search)
  const parsedHash = hash ? parseDashboardHash(hash, DASHBOARD_DEFAULT_TAB) : null
  const sort = params.get(P.wSort)
  const dir = params.get(P.wDir)
  const survIpRaw = text(params.get(P.survIp))
  const survHostRaw = text(params.get(P.survHost))
  const queryDim =
    resolveDiscoveryDimensionId(params.get(P.dim)) ??
    resolveDiscoveryDimensionId(params.get(P.discovery))
  const queryAgent = text(params.get(P.agent))
  const queryCustomer = text(params.get(P.customer))
  const queryWSport = text(params.get(P.wSport))
  const queryWChannel = text(params.get(P.wChannel))
  return {
    tab: resolveTab(params, search, pathname, hash),
    matrix: params.get(P.matrix) === "1",
    agent: queryAgent || parsedHash?.selectedAgentId || "",
    downlineAgents: parseAgentList(params),
    rankingsHeatmap: parseOptionalBooleanFlag(params.get(P.heatmap)),
    customer: queryCustomer || parsedHash?.selectedCustomerId || "",
    discovery: queryDim ?? parsedHash?.discoveryDimension ?? null,
    wSport: filter(queryWSport || parsedHash?.wagerSportFilter || null),
    wAlert: filter(params.get(P.wAlert)),
    wType: filter(params.get(P.wType)),
    wChannel: filter(queryWChannel || parsedHash?.wagerChannelFilter || null),
    wSort: isWagerSortField(sort) ? sort : WAGERS_DEFAULTS.sort_field,
    wDir: dir === "asc" || dir === "desc" ? dir : WAGERS_DEFAULTS.sort_dir,
    survView: resolveSurveillanceView(params.get(P.survView)),
    survIp: survIpRaw || SURVEILLANCE_URL_DEFAULTS.ip,
    survHost: survHostRaw || SURVEILLANCE_URL_DEFAULTS.host,
  }
}

/**
 * Merge state into a query string using a dedicated `URLSearchParams` instance.
 * Unknown params (`ticket`, `sport`, `apiBase`, …) are preserved.
 * The `tab` param is omitted when the path already resolves to that tab (so
 * `/live-bets` stays clean), and set explicitly when the desired tab differs
 * from the path.
 */
export function buildDashboardSearch(
  state: DashboardUrlState,
  currentSearch = "",
  pathname = "/",
): string {
  const params = paramsOf(currentSearch)
  const pathTab = resolveInitialTab("", pathname)

  if (state.tab === pathTab) params.delete(P.tab)
  else params.set(P.tab, state.tab)

  if (state.matrix) params.set(P.matrix, "1")
  else params.delete(P.matrix)

  if (state.agent !== "") params.set(P.agent, state.agent)
  else params.delete(P.agent)

  if (state.downlineAgents !== undefined) {
    const cleanAgents: string[] = []
    const seen = new Set<string>()
    for (const id of state.downlineAgents) {
      const upper = id.trim().toUpperCase()
      if (upper === "" || seen.has(upper)) continue
      seen.add(upper)
      cleanAgents.push(upper)
    }
    params.delete(P.agents)
    if (state.tab === "rankings" && cleanAgents.length > 0) {
      params.set(P.agentID, cleanAgents.join(","))
    } else {
      params.delete(P.agentID)
      params.delete(P.agentOwner)
    }
  }

  if (state.rankingsHeatmap !== undefined) {
    if (state.tab === "rankings" && state.rankingsHeatmap === false) {
      params.set(P.heatmap, "0")
    } else {
      params.delete(P.heatmap)
    }
  } else if (state.tab !== "rankings") {
    params.delete(P.heatmap)
  }

  if (state.customer !== undefined) {
    const cleanCustomer = state.customer.trim()
    const customerScopedTab = state.tab === "customers" || state.tab === "rankings"
    if (customerScopedTab && cleanCustomer !== "") {
      params.set(P.customer, cleanCustomer)
    } else {
      params.delete(P.customer)
    }
  }

  if (state.discovery && isDiscoveryDimensionId(state.discovery)) {
    params.set(P.dim, state.discovery)
  } else {
    params.delete(P.dim)
  }
  params.delete(P.discovery)

  const wagerFilters: ReadonlyArray<[string, string]> = [
    [P.wSport, state.wSport],
    [P.wAlert, state.wAlert],
    [P.wType, state.wType],
    [P.wChannel, state.wChannel],
  ]
  if (state.tab === "wagers") {
    for (const [name, value] of wagerFilters) {
      if (value !== "ALL") params.set(name, value)
      else params.delete(name)
    }
    if (state.wSort !== WAGERS_DEFAULTS.sort_field) params.set(P.wSort, state.wSort)
    else params.delete(P.wSort)
    if (state.wDir !== WAGERS_DEFAULTS.sort_dir) params.set(P.wDir, state.wDir)
    else params.delete(P.wDir)
  } else {
    for (const [name] of wagerFilters) params.delete(name)
    params.delete(P.wSort)
    params.delete(P.wDir)
  }

  if (state.tab === "surveillance") {
    const survView = state.survView ?? SURVEILLANCE_URL_DEFAULTS.view
    const survIp = (state.survIp ?? SURVEILLANCE_URL_DEFAULTS.ip).trim()
    const survHost = (state.survHost ?? SURVEILLANCE_URL_DEFAULTS.host).trim()

    if (survView !== SURVEILLANCE_URL_DEFAULTS.view) {
      params.set(P.survView, survView)
    } else {
      params.delete(P.survView)
    }
    if (survIp !== "" && survIp !== SURVEILLANCE_URL_DEFAULTS.ip) {
      params.set(P.survIp, survIp)
    } else {
      params.delete(P.survIp)
    }
    if (survHost !== "" && survHost !== SURVEILLANCE_URL_DEFAULTS.host) {
      params.set(P.survHost, survHost)
    } else {
      params.delete(P.survHost)
    }
  } else {
    params.delete(P.survView)
    params.delete(P.survIp)
    params.delete(P.survHost)
  }

  // Never re-emit a temporary fast sign-in credential or duplicate/untrusted apiBase in shareable URLs.
  params.delete("fast_signin")
  sanitizeApiBaseParam(params, isLocalDevLocation())

  return params.toString()
}

/**
 * Construct a separate `URL` object for a dashboard state without mutating
 * `Window.location`. Unknown params (`apiBase`, `customer`, `ticket`) survive.
 */
export function buildDashboardUrlObject(
  state: DashboardUrlState,
  currentHref = "/",
  originBase = "http://dashboard.local",
  canonicalHash?: string,
): URL {
  const url = new URL(currentHref, originBase)
  url.search = buildDashboardSearch(state, url.search, url.pathname)
  if (canonicalHash !== undefined) {
    url.hash = canonicalHash.startsWith("#") || canonicalHash === "" ? canonicalHash : `#${canonicalHash}`
  }
  return url
}

/** Relative URL (path + query + hash) for a state, preserving unknown params. */
export function dashboardUrl(
  state: DashboardUrlState,
  currentHref = "/",
  canonicalHash?: string,
): string {
  const url = buildDashboardUrlObject(state, currentHref, "http://dashboard.local", canonicalHash)
  return `${url.pathname}${url.search}${url.hash}`
}

export interface DashboardHistoryWindow {
  readonly location: {
    readonly origin?: string
    readonly href: string
    readonly pathname: string
    readonly search: string
    readonly hash: string
  }
  readonly history: {
    replaceState(data: unknown, unused: string, url: string): void
    pushState?(data: unknown, unused: string, url: string): void
  }
}

export interface DashboardWriteOptions {
  /** Add a history entry (tab navigation) instead of replacing the current one. */
  readonly push?: boolean
  /** Optional canonical structured hash (`#/{section}/{tab}/...`) to synchronize. */
  readonly hash?: string
}

function defaultHistoryWindow(): DashboardHistoryWindow | null {
  const candidate = (globalThis as unknown as { window?: DashboardHistoryWindow }).window
  return candidate ?? null
}

/**
 * Replace or push the current `Window.history` entry using a separate `URL`
 * object when the serialized path+query+hash changes. No-op during SSR.
 */
export function writeDashboardUrl(
  state: DashboardUrlState,
  win: DashboardHistoryWindow | null = defaultHistoryWindow(),
  options: DashboardWriteOptions = {},
): boolean {
  if (win === null) return false
  const baseOrigin =
    win.location.origin && win.location.origin !== "null"
      ? win.location.origin
      : "http://dashboard.local"
  const nextUrl = buildDashboardUrlObject(state, win.location.href, baseOrigin, options.hash)
  const next = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`
  const current = `${win.location.pathname}${win.location.search}${win.location.hash}`
  if (next === current) return false
  if (options.push === true && typeof win.history.pushState === "function") {
    win.history.pushState(null, "", next)
  } else {
    win.history.replaceState(null, "", next)
  }
  return true
}
