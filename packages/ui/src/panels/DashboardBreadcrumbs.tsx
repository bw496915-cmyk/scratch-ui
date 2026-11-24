import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Compass,
  CornerLeftUp,
  Hash,
  Home,
  Link2,
} from "lucide-react"
import type React from "react"
import { useEffect, useMemo, useState } from "react"

import { copyText } from "../clipboard.ts"
import {
  buildAbsoluteDiscoveryPermalink,
  buildCanonicalDashboardHref,
  DASHBOARD_SECTIONS,
  type DashboardHashRouteContext,
  type DashboardSectionId,
  type DashboardSectionMeta,
  DISCOVERY_DIMENSION_LIST,
  DISCOVERY_DIMENSIONS,
  type DiscoveryDimensionId,
  getSectionForTab,
  isDiscoveryDimensionId,
  ROOT_DASHBOARD_TAB,
  serializeDashboardHash,
} from "../discovery_hash.ts"
import { DASHBOARD_TAB_SPECS, type DashboardTabId } from "../types.ts"

export {
  DASHBOARD_SECTIONS,
  getSectionForTab,
  ROOT_DASHBOARD_TAB,
  type DashboardSectionId,
  type DashboardSectionMeta,
}

export type BreadcrumbAction =
  | { readonly kind: "navigate-tab"; readonly tab: DashboardTabId; readonly clearContext?: boolean }
  | { readonly kind: "clear-customer" }
  | { readonly kind: "clear-customer-tier" }
  | { readonly kind: "clear-wager" }
  | { readonly kind: "clear-wager-filters" }
  | { readonly kind: "clear-agent" }
  | { readonly kind: "clear-alert-filter" }
  | { readonly kind: "clear-log-severity" }
  | {
      readonly kind: "select-discovery-dimension"
      readonly dimension: DiscoveryDimensionId | null
    }
  | { readonly kind: "clear-discovery-dimension" }

export interface BreadcrumbItem {
  readonly id: string
  readonly label: string
  readonly isCurrent: boolean
  readonly isRoot?: boolean
  readonly badge?: string
  readonly href: string
  readonly hashFragment: string
  readonly action?: BreadcrumbAction
}

export interface DashboardBreadcrumbContext {
  readonly activeTab: DashboardTabId
  readonly selectedCustomerId?: string | null
  readonly customerTierFilter?: string | null
  readonly selectedWagerTicketId?: string | null
  readonly wagerChannelFilter?: string | null
  readonly wagerSportFilter?: string | null
  readonly selectedAgentId?: string | null
  readonly alertFilter?: string | null
  readonly systemLogSeverityFilter?: string | null
  readonly discoveryDimension?: DiscoveryDimensionId | null
  readonly rotId?: string | null
  readonly entityPair?: readonly [string, string] | null
}

function isPlainLeftClick(event: React.MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function buildCrumbLink(
  routeCtx: DashboardHashRouteContext,
  currentSearch = "",
): { readonly href: string; readonly hashFragment: string } {
  return {
    href: buildCanonicalDashboardHref(routeCtx, currentSearch),
    hashFragment: serializeDashboardHash(routeCtx),
  }
}

/**
 * Builds the deterministic hierarchical breadcrumb trail for the active dashboard view and any
 * nested filter, inspected entity, or SoA Discovery Dimension, attaching canonical hashed `href`
 * links and parent-level navigation actions to every node.
 */
export function buildDashboardBreadcrumbs(
  ctx: DashboardBreadcrumbContext,
  currentSearch = "",
): readonly BreadcrumbItem[] {
  const section = getSectionForTab(ctx.activeTab)
  const tabSpec = DASHBOARD_TAB_SPECS[ctx.activeTab]
  const trail: BreadcrumbItem[] = []

  // Collect optional nested sub-context crumbs below the active tab,
  // tracking the exact incremental route context at each level so every
  // breadcrumb renders a truthful canonical hashed URL.
  const subCrumbs: Array<{
    readonly id: string
    readonly label: string
    readonly badge?: string
    readonly clearSelfAction: BreadcrumbAction
    readonly routeCtx: DashboardHashRouteContext
  }> = []

  let runningCtx: DashboardHashRouteContext = { activeTab: ctx.activeTab }

  if (ctx.activeTab === "customers") {
    const tier = ctx.customerTierFilter?.trim()
    if (tier && tier !== "ALL") {
      runningCtx = { ...runningCtx, customerTierFilter: tier }
      subCrumbs.push({
        id: `tier:${tier}`,
        label: `Tier: ${tier}`,
        clearSelfAction: { kind: "clear-customer-tier" },
        routeCtx: runningCtx,
      })
    }
    const custId = ctx.selectedCustomerId?.trim()
    if (custId) {
      runningCtx = { ...runningCtx, selectedCustomerId: custId }
      subCrumbs.push({
        id: `customer:${custId}`,
        label: custId,
        clearSelfAction: { kind: "clear-customer" },
        routeCtx: runningCtx,
      })
    }
  } else if (ctx.activeTab === "wagers") {
    const channel = ctx.wagerChannelFilter?.trim()
    const sport = ctx.wagerSportFilter?.trim()
    const filterParts: string[] = []
    if (channel && channel !== "ALL") filterParts.push(channel)
    if (sport && sport !== "ALL") filterParts.push(sport)
    if (filterParts.length > 0) {
      runningCtx = {
        ...runningCtx,
        wagerChannelFilter: channel && channel !== "ALL" ? channel : null,
        wagerSportFilter: sport && sport !== "ALL" ? sport : null,
      }
      subCrumbs.push({
        id: `wager-filter:${filterParts.join("/")}`,
        label: filterParts.join(" · "),
        clearSelfAction: { kind: "clear-wager-filters" },
        routeCtx: runningCtx,
      })
    }
    const ticketId = ctx.selectedWagerTicketId?.trim()
    if (ticketId) {
      runningCtx = { ...runningCtx, selectedWagerTicketId: ticketId }
      subCrumbs.push({
        id: `ticket:${ticketId}`,
        label: `Ticket #${ticketId}`,
        clearSelfAction: { kind: "clear-wager" },
        routeCtx: runningCtx,
      })
    }
  } else if (ctx.activeTab === "rankings") {
    const agentId = ctx.selectedAgentId?.trim()
    if (agentId) {
      runningCtx = { ...runningCtx, selectedAgentId: agentId }
      subCrumbs.push({
        id: `agent:${agentId}`,
        label: `Agent ${agentId}`,
        clearSelfAction: { kind: "clear-agent" },
        routeCtx: runningCtx,
      })
    }
  } else if (ctx.activeTab === "alerts") {
    const filter = ctx.alertFilter?.trim()
    if (filter && filter !== "ALL") {
      runningCtx = { ...runningCtx, alertFilter: filter }
      subCrumbs.push({
        id: `alert-filter:${filter}`,
        label: filter,
        clearSelfAction: { kind: "clear-alert-filter" },
        routeCtx: runningCtx,
      })
    }
  } else if (ctx.activeTab === "system-logs") {
    const sev = ctx.systemLogSeverityFilter?.trim()
    if (sev && sev !== "ALL") {
      runningCtx = { ...runningCtx, systemLogSeverityFilter: sev }
      subCrumbs.push({
        id: `log-severity:${sev}`,
        label: sev,
        clearSelfAction: { kind: "clear-log-severity" },
        routeCtx: runningCtx,
      })
    }
  }

  if (ctx.rotId?.trim()) {
    runningCtx = { ...runningCtx, rotId: ctx.rotId.trim() }
  }
  if (ctx.entityPair && ctx.entityPair[0]?.trim() && ctx.entityPair[1]?.trim()) {
    runningCtx = { ...runningCtx, entityPair: ctx.entityPair }
  }

  if (ctx.discoveryDimension && isDiscoveryDimensionId(ctx.discoveryDimension)) {
    const dimSpec = DISCOVERY_DIMENSIONS[ctx.discoveryDimension]
    runningCtx = { ...runningCtx, discoveryDimension: dimSpec.id }
    subCrumbs.push({
      id: `dim:${dimSpec.id}`,
      label: dimSpec.dimension,
      badge: dimSpec.symbol,
      clearSelfAction: { kind: "clear-discovery-dimension" },
      routeCtx: runningCtx,
    })
  }

  const hasSubCrumbs = subCrumbs.length > 0
  const isAtRootLanding = ctx.activeTab === ROOT_DASHBOARD_TAB && !hasSubCrumbs

  // 1. Root crumb
  const rootLink = buildCrumbLink({ activeTab: ROOT_DASHBOARD_TAB }, currentSearch)
  trail.push({
    id: "root",
    label: "Dashboard",
    isRoot: true,
    isCurrent: false,
    ...rootLink,
    ...(isAtRootLanding
      ? {}
      : { action: { kind: "navigate-tab", tab: ROOT_DASHBOARD_TAB, clearContext: true } }),
  })

  // 2. Domain section crumb
  const isSectionLanding = ctx.activeTab === section.landingTab
  const sectionLink = buildCrumbLink({ activeTab: section.landingTab }, currentSearch)
  trail.push({
    id: `section:${section.id}`,
    label: section.label,
    isCurrent: false,
    ...sectionLink,
    ...(!isSectionLanding || hasSubCrumbs
      ? { action: { kind: "navigate-tab", tab: section.landingTab, clearContext: true } }
      : {}),
  })

  // 3. Active tab crumb
  const tabLink = buildCrumbLink({ activeTab: ctx.activeTab }, currentSearch)
  trail.push({
    id: `tab:${ctx.activeTab}`,
    label: tabSpec.label,
    isCurrent: !hasSubCrumbs,
    ...tabLink,
    ...(hasSubCrumbs
      ? { action: { kind: "navigate-tab", tab: ctx.activeTab, clearContext: true } }
      : {}),
  })

  // 4. Optional nested filter / inspected entity / Discovery Dimension crumbs
  for (let i = 0; i < subCrumbs.length; i += 1) {
    const item = subCrumbs[i]!
    const isLast = i === subCrumbs.length - 1
    const nextChild = subCrumbs[i + 1]
    const itemLink = buildCrumbLink(item.routeCtx, currentSearch)
    trail.push({
      id: item.id,
      label: item.label,
      ...(item.badge ? { badge: item.badge } : {}),
      isCurrent: isLast,
      ...itemLink,
      ...(!isLast && nextChild ? { action: nextChild.clearSelfAction } : {}),
    })
  }

  return trail
}

/**
 * Resolves the immediate navigable parent crumb above the current location, or `null` when already
 * at the root dashboard landing.
 */
export function resolveParentBreadcrumb(items: readonly BreadcrumbItem[]): BreadcrumbItem | null {
  for (let i = items.length - 2; i >= 0; i -= 1) {
    const candidate = items[i]
    if (candidate && candidate.action) {
      return candidate
    }
  }
  return null
}

export interface DashboardBreadcrumbsProps extends DashboardBreadcrumbContext {
  readonly onBreadcrumbAction: (action: BreadcrumbAction) => void
}

export function DashboardBreadcrumbs({
  activeTab,
  selectedCustomerId,
  customerTierFilter,
  selectedWagerTicketId,
  wagerChannelFilter,
  wagerSportFilter,
  selectedAgentId,
  alertFilter,
  systemLogSeverityFilter,
  discoveryDimension,
  rotId,
  entityPair,
  onBreadcrumbAction,
}: DashboardBreadcrumbsProps): React.ReactElement {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [matrixOpen, setMatrixOpen] = useState<boolean>(false)

  useEffect(() => {
    if (!copiedKey) return
    const timer = window.setTimeout(() => setCopiedKey(null), 1800)
    return () => window.clearTimeout(timer)
  }, [copiedKey])

  const currentSearch = typeof window !== "undefined" ? window.location.search : ""

  const routeContext: DashboardHashRouteContext = useMemo(
    () => ({
      activeTab,
      selectedCustomerId,
      customerTierFilter,
      selectedWagerTicketId,
      wagerChannelFilter,
      wagerSportFilter,
      selectedAgentId,
      alertFilter,
      systemLogSeverityFilter,
      discoveryDimension: discoveryDimension ?? null,
      rotId,
      entityPair,
    }),
    [
      activeTab,
      selectedCustomerId,
      customerTierFilter,
      selectedWagerTicketId,
      wagerChannelFilter,
      wagerSportFilter,
      selectedAgentId,
      alertFilter,
      systemLogSeverityFilter,
      discoveryDimension,
      rotId,
      entityPair,
    ],
  )

  const items = useMemo(
    () => buildDashboardBreadcrumbs(routeContext, currentSearch),
    [routeContext, currentSearch],
  )
  const parentItem = resolveParentBreadcrumb(items)
  const tabSpec = DASHBOARD_TAB_SPECS[activeTab]
  const canonicalHash = serializeDashboardHash(routeContext)
  const activeDimSpec =
    discoveryDimension && isDiscoveryDimensionId(discoveryDimension)
      ? DISCOVERY_DIMENSIONS[discoveryDimension]
      : null

  const copyPermalinkFor = async (ctx: DashboardHashRouteContext, key: string) => {
    const loc =
      typeof window !== "undefined"
        ? {
            origin: window.location.origin,
            pathname: window.location.pathname,
            search: window.location.search,
          }
        : null
    const permalink = buildAbsoluteDiscoveryPermalink(ctx, loc)
    const ok = await copyText(permalink)
    if (ok) {
      setCopiedKey(key)
    }
  }

  return (
    <nav
      aria-label="Breadcrumb"
      data-dashboard-breadcrumbs="true"
      data-canonical-hash={canonicalHash}
      data-discovery-dimension={activeDimSpec?.id ?? "none"}
      className="sd-breadcrumbs"
    >
      <div className="sd-breadcrumbs-row">
        <ol className="sd-breadcrumb-list">
          {items.map((item, idx) => {
            const isClickable = !item.isCurrent && Boolean(item.action)
            return (
              <li key={item.id} className="sd-breadcrumb-item">
                {idx > 0 ? (
                  <ChevronRight size={13} aria-hidden="true" className="sd-breadcrumb-sep" />
                ) : null}
                {item.isCurrent ? (
                  <span
                    aria-current="page"
                    className="sd-breadcrumb-current"
                    title={item.hashFragment}
                  >
                    {item.badge ? (
                      <span className="sd-breadcrumb-dim-badge sd-tabular">{item.badge}</span>
                    ) : null}
                    <span>{item.label}</span>
                  </span>
                ) : isClickable && item.action ? (
                  <a
                    href={item.href}
                    className="sd-breadcrumb-btn sd-breadcrumb-link"
                    onClick={(event) => {
                      if (isPlainLeftClick(event)) {
                        event.preventDefault()
                        onBreadcrumbAction(item.action!)
                      }
                    }}
                    title={`Navigate to ${item.label} (${item.hashFragment})`}
                  >
                    {item.isRoot ? (
                      <Home size={12} aria-hidden="true" className="sd-breadcrumb-home-icon" />
                    ) : null}
                    {item.badge ? (
                      <span className="sd-breadcrumb-dim-badge sd-tabular">{item.badge}</span>
                    ) : null}
                    <span>{item.label}</span>
                  </a>
                ) : (
                  <span className="sd-breadcrumb-static" title={item.hashFragment}>
                    {item.isRoot ? (
                      <Home size={12} aria-hidden="true" className="sd-breadcrumb-home-icon" />
                    ) : null}
                    <span>{item.label}</span>
                  </span>
                )}
              </li>
            )
          })}
        </ol>

        <div className="sd-breadcrumb-actions">
          {/* Canonical Hashed Route Chip + Copy Permalink */}
          <button
            type="button"
            className={`sd-breadcrumb-hash-chip${copiedKey === "current" ? " sd-breadcrumb-hash-chip--copied" : ""}`}
            onClick={() => void copyPermalinkFor(routeContext, "current")}
            title={`Copy hashed deep link (${canonicalHash})`}
            data-breadcrumb-copy-hash="true"
          >
            {copiedKey === "current" ? (
              <Check size={11} aria-hidden="true" />
            ) : (
              <Hash size={11} aria-hidden="true" />
            )}
            <code className="sd-breadcrumb-hash-code">{canonicalHash}</code>
            <span className="sd-breadcrumb-hash-verb">
              {copiedKey === "current" ? "Copied" : "Link"}
            </span>
          </button>

          {/* SoA Discovery Dimension Quick Selector */}
          <label
            className="sd-breadcrumb-dim-picker"
            title="Pin a Discovery Dimension estimator into the breadcrumb trail & canonical URL hash"
          >
            <Compass size={12} aria-hidden="true" className="sd-breadcrumb-dim-icon" />
            <select
              aria-label="Discovery Dimension estimator"
              className="sd-breadcrumb-dim-select"
              data-breadcrumb-discovery-select="true"
              value={activeDimSpec?.id ?? ""}
              onChange={(event) => {
                const raw = event.target.value
                onBreadcrumbAction({
                  kind: "select-discovery-dimension",
                  dimension: raw && isDiscoveryDimensionId(raw) ? raw : null,
                })
              }}
            >
              <option value="">SoA Discovery (7)</option>
              {DISCOVERY_DIMENSION_LIST.map((spec) => (
                <option key={spec.id} value={spec.id}>
                  {spec.symbol} · {spec.dimension}
                </option>
              ))}
            </select>
          </label>

          {/* Expandable SoA Discovery Estimator Matrix Toggle */}
          <button
            type="button"
            className={`sd-breadcrumb-matrix-btn${matrixOpen ? " sd-breadcrumb-matrix-btn--active" : ""}`}
            aria-expanded={matrixOpen}
            aria-controls="sd-discovery-dimension-matrix"
            data-breadcrumb-discovery-matrix-toggle="true"
            onClick={() => setMatrixOpen((prev) => !prev)}
            title="Show SoA Discovery Dimensions, derived estimators, formulas, and direct hashed links"
          >
            <span>Estimators</span>
            {matrixOpen ? (
              <ChevronUp size={12} aria-hidden="true" />
            ) : (
              <ChevronDown size={12} aria-hidden="true" />
            )}
          </button>

          {tabSpec.shortcut ? (
            <kbd className="sd-breadcrumb-meta sd-kbd-shortcut" title={tabSpec.description}>
              {tabSpec.shortcut}
            </kbd>
          ) : null}

          {parentItem && parentItem.action ? (
            <a
              href={parentItem.href}
              className="sd-breadcrumb-up-btn"
              onClick={(event) => {
                if (isPlainLeftClick(event)) {
                  event.preventDefault()
                  onBreadcrumbAction(parentItem.action!)
                }
              }}
              title={`Go up to ${parentItem.label} (${parentItem.hashFragment})`}
              data-breadcrumb-up="true"
            >
              <CornerLeftUp size={12} aria-hidden="true" />
              <span>Up to {parentItem.label}</span>
            </a>
          ) : null}
        </div>
      </div>

      {/* Active Discovery Dimension Formula Banner (compact single-line summary when pinned) */}
      {activeDimSpec && !matrixOpen ? (
        <div className="sd-breadcrumb-active-dim" data-active-discovery-strip={activeDimSpec.id}>
          <span className={`sd-dim-pill sd-dim-pill--${activeDimSpec.tone} sd-tabular`}>
            {activeDimSpec.symbol}
          </span>
          <span className="sd-breadcrumb-active-dim__name">{activeDimSpec.estimator}</span>
          <code className="sd-breadcrumb-active-dim__formula">{activeDimSpec.formula}</code>
          <span className="sd-breadcrumb-active-dim__desc">{activeDimSpec.whatItSurfaces}</span>
          <button
            type="button"
            className="sd-breadcrumb-active-dim__clear"
            onClick={() => onBreadcrumbAction({ kind: "clear-discovery-dimension" })}
            title="Clear active Discovery Dimension from hash & breadcrumb"
          >
            Clear
          </button>
        </div>
      ) : null}

      {/* Expandable SoA Discovery Dimensions Matrix with Canonical Hashed Deep Links */}
      {matrixOpen ? (
        <div
          id="sd-discovery-dimension-matrix"
          className="sd-discovery-matrix"
          data-discovery-matrix="true"
        >
          <div className="sd-discovery-matrix__head">
            <div className="sd-discovery-matrix__title-group">
              <Compass size={13} aria-hidden="true" />
              <span className="sd-discovery-matrix__title">
                SoA Slab Discovery Dimensions &amp; Hashed Deep Links
              </span>
              <span className="sd-discovery-matrix__scope sd-tabular">
                Scoped to{" "}
                <code>{serializeDashboardHash({ ...routeContext, discoveryDimension: null })}</code>
              </span>
            </div>
            {activeDimSpec ? (
              <button
                type="button"
                className="sd-breadcrumb-active-dim__clear"
                onClick={() => onBreadcrumbAction({ kind: "clear-discovery-dimension" })}
              >
                Clear Active ({activeDimSpec.symbol})
              </button>
            ) : null}
          </div>

          <div className="sd-discovery-matrix__scroll">
            <table className="sd-discovery-matrix__table">
              <thead>
                <tr>
                  <th>Discovery Dimension</th>
                  <th>Derived Estimator</th>
                  <th>Formula / Computation on SoA Slabs</th>
                  <th>What It Surfaces Without Buzzwords</th>
                  <th>Hashed Deep Link</th>
                </tr>
              </thead>
              <tbody>
                {DISCOVERY_DIMENSION_LIST.map((spec) => {
                  const isActive = activeDimSpec?.id === spec.id
                  const dimRouteCtx: DashboardHashRouteContext = {
                    ...routeContext,
                    discoveryDimension: spec.id,
                  }
                  const dimHref = buildCanonicalDashboardHref(dimRouteCtx, currentSearch)
                  const dimHash = serializeDashboardHash(dimRouteCtx)
                  const copyId = `dim:${spec.id}`
                  return (
                    <tr
                      key={spec.id}
                      className={isActive ? "sd-discovery-matrix__row--active" : undefined}
                      data-discovery-row={spec.id}
                    >
                      <td>
                        <div className="sd-discovery-matrix__dim-cell">
                          <span className={`sd-dim-pill sd-dim-pill--${spec.tone} sd-tabular`}>
                            {spec.symbol}
                          </span>
                          <div>
                            <div className="sd-discovery-matrix__dim-name">{spec.dimension}</div>
                            <div className="sd-discovery-matrix__slabs">
                              {spec.soaSlabs.join(" · ")}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="sd-discovery-matrix__estimator">{spec.estimator}</td>
                      <td>
                        <code className="sd-discovery-matrix__formula">{spec.formula}</code>
                      </td>
                      <td className="sd-discovery-matrix__surfaces">{spec.whatItSurfaces}</td>
                      <td>
                        <div className="sd-discovery-matrix__link-cell">
                          <a
                            href={dimHref}
                            className={`sd-discovery-matrix__anchor${isActive ? " sd-discovery-matrix__anchor--active" : ""}`}
                            onClick={(event) => {
                              if (isPlainLeftClick(event)) {
                                event.preventDefault()
                                onBreadcrumbAction({
                                  kind: "select-discovery-dimension",
                                  dimension: isActive ? null : spec.id,
                                })
                              }
                            }}
                            title={`Pin ${spec.dimension} (${dimHash})`}
                          >
                            <Link2 size={11} aria-hidden="true" />
                            <span>{isActive ? "Pinned" : `dim:${spec.shortCode}`}</span>
                          </a>
                          <button
                            type="button"
                            className="sd-discovery-matrix__copy-btn"
                            onClick={() => void copyPermalinkFor(dimRouteCtx, copyId)}
                            title={`Copy full permalink for ${spec.dimension} (${dimHash})`}
                            aria-label={`Copy permalink for ${spec.dimension}`}
                          >
                            {copiedKey === copyId ? (
                              <Check size={11} aria-hidden="true" />
                            ) : (
                              <Hash size={11} aria-hidden="true" />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </nav>
  )
}
