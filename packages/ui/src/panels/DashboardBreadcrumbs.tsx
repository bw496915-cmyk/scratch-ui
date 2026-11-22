import { ChevronRight, CornerLeftUp, Home } from "lucide-react"
import type React from "react"

import { DASHBOARD_TAB_SPECS, type DashboardTabId } from "../types.ts"

export type DashboardSectionId =
  "risk-exposure" | "bettor-intelligence" | "operations-telemetry" | "platform-infrastructure"

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

export type BreadcrumbAction =
  | { readonly kind: "navigate-tab"; readonly tab: DashboardTabId; readonly clearContext?: boolean }
  | { readonly kind: "clear-customer" }
  | { readonly kind: "clear-customer-tier" }
  | { readonly kind: "clear-wager" }
  | { readonly kind: "clear-wager-filters" }
  | { readonly kind: "clear-agent" }
  | { readonly kind: "clear-alert-filter" }
  | { readonly kind: "clear-log-severity" }

export interface BreadcrumbItem {
  readonly id: string
  readonly label: string
  readonly isCurrent: boolean
  readonly isRoot?: boolean
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
}

export function getSectionForTab(tab: DashboardTabId): DashboardSectionMeta {
  return DASHBOARD_SECTIONS[TAB_TO_SECTION[tab]]
}

/**
 * Builds the deterministic hierarchical breadcrumb trail for the active dashboard view
 * and any nested filter or inspected entity, attaching parent-level navigation actions.
 */
export function buildDashboardBreadcrumbs(
  ctx: DashboardBreadcrumbContext,
): readonly BreadcrumbItem[] {
  const section = getSectionForTab(ctx.activeTab)
  const tabSpec = DASHBOARD_TAB_SPECS[ctx.activeTab]
  const trail: BreadcrumbItem[] = []

  // Collect optional nested sub-context crumbs below the active tab
  const subCrumbs: Array<{
    readonly id: string
    readonly label: string
    readonly clearSelfAction: BreadcrumbAction
  }> = []

  if (ctx.activeTab === "customers") {
    const tier = ctx.customerTierFilter?.trim()
    if (tier && tier !== "ALL") {
      subCrumbs.push({
        id: `tier:${tier}`,
        label: `Tier: ${tier}`,
        clearSelfAction: { kind: "clear-customer-tier" },
      })
    }
    const custId = ctx.selectedCustomerId?.trim()
    if (custId) {
      subCrumbs.push({
        id: `customer:${custId}`,
        label: custId,
        clearSelfAction: { kind: "clear-customer" },
      })
    }
  } else if (ctx.activeTab === "wagers") {
    const channel = ctx.wagerChannelFilter?.trim()
    const sport = ctx.wagerSportFilter?.trim()
    const filterParts: string[] = []
    if (channel && channel !== "ALL") filterParts.push(channel)
    if (sport && sport !== "ALL") filterParts.push(sport)
    if (filterParts.length > 0) {
      subCrumbs.push({
        id: `wager-filter:${filterParts.join("/")}`,
        label: filterParts.join(" · "),
        clearSelfAction: { kind: "clear-wager-filters" },
      })
    }
    const ticketId = ctx.selectedWagerTicketId?.trim()
    if (ticketId) {
      subCrumbs.push({
        id: `ticket:${ticketId}`,
        label: `Ticket #${ticketId}`,
        clearSelfAction: { kind: "clear-wager" },
      })
    }
  } else if (ctx.activeTab === "rankings") {
    const agentId = ctx.selectedAgentId?.trim()
    if (agentId) {
      subCrumbs.push({
        id: `agent:${agentId}`,
        label: `Agent ${agentId}`,
        clearSelfAction: { kind: "clear-agent" },
      })
    }
  } else if (ctx.activeTab === "alerts") {
    const filter = ctx.alertFilter?.trim()
    if (filter && filter !== "ALL") {
      subCrumbs.push({
        id: `alert-filter:${filter}`,
        label: filter,
        clearSelfAction: { kind: "clear-alert-filter" },
      })
    }
  } else if (ctx.activeTab === "system-logs") {
    const sev = ctx.systemLogSeverityFilter?.trim()
    if (sev && sev !== "ALL") {
      subCrumbs.push({
        id: `log-severity:${sev}`,
        label: sev,
        clearSelfAction: { kind: "clear-log-severity" },
      })
    }
  }

  const hasSubCrumbs = subCrumbs.length > 0
  const isAtRootLanding = ctx.activeTab === ROOT_DASHBOARD_TAB && !hasSubCrumbs

  // 1. Root crumb
  trail.push({
    id: "root",
    label: "Dashboard",
    isRoot: true,
    isCurrent: false,
    ...(isAtRootLanding
      ? {}
      : { action: { kind: "navigate-tab", tab: ROOT_DASHBOARD_TAB, clearContext: true } }),
  })

  // 2. Domain section crumb
  const isSectionLanding = ctx.activeTab === section.landingTab
  trail.push({
    id: `section:${section.id}`,
    label: section.label,
    isCurrent: false,
    ...(!isSectionLanding || hasSubCrumbs
      ? { action: { kind: "navigate-tab", tab: section.landingTab, clearContext: true } }
      : {}),
  })

  // 3. Active tab crumb
  trail.push({
    id: `tab:${ctx.activeTab}`,
    label: tabSpec.label,
    isCurrent: !hasSubCrumbs,
    ...(hasSubCrumbs
      ? { action: { kind: "navigate-tab", tab: ctx.activeTab, clearContext: true } }
      : {}),
  })

  // 4. Optional nested filter / inspected entity crumbs
  for (let i = 0; i < subCrumbs.length; i += 1) {
    const item = subCrumbs[i]!
    const isLast = i === subCrumbs.length - 1
    // Clicking an intermediate filter crumb (e.g. channel filter when a ticket is open)
    // clears only the deeper leaf (ticket) while keeping the filter intact.
    const nextChild = subCrumbs[i + 1]
    trail.push({
      id: item.id,
      label: item.label,
      isCurrent: isLast,
      ...(!isLast && nextChild ? { action: nextChild.clearSelfAction } : {}),
    })
  }

  return trail
}

/**
 * Resolves the immediate navigable parent crumb above the current location,
 * or `null` when already at the root dashboard landing.
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
  onBreadcrumbAction,
}: DashboardBreadcrumbsProps): React.ReactElement {
  const items = buildDashboardBreadcrumbs({
    activeTab,
    selectedCustomerId,
    customerTierFilter,
    selectedWagerTicketId,
    wagerChannelFilter,
    wagerSportFilter,
    selectedAgentId,
    alertFilter,
    systemLogSeverityFilter,
  })
  const parentItem = resolveParentBreadcrumb(items)
  const tabSpec = DASHBOARD_TAB_SPECS[activeTab]

  return (
    <nav aria-label="Breadcrumb" data-dashboard-breadcrumbs="true" className="sd-breadcrumbs">
      <ol className="sd-breadcrumb-list">
        {items.map((item, idx) => {
          const isClickable = !item.isCurrent && Boolean(item.action)
          return (
            <li key={item.id} className="sd-breadcrumb-item">
              {idx > 0 ? (
                <ChevronRight size={13} aria-hidden="true" className="sd-breadcrumb-sep" />
              ) : null}
              {item.isCurrent ? (
                <span aria-current="page" className="sd-breadcrumb-current">
                  {item.label}
                </span>
              ) : isClickable && item.action ? (
                <button
                  type="button"
                  className="sd-breadcrumb-btn"
                  onClick={() => onBreadcrumbAction(item.action!)}
                  title={`Navigate to ${item.label}`}
                >
                  {item.isRoot ? (
                    <Home size={12} aria-hidden="true" className="sd-breadcrumb-home-icon" />
                  ) : null}
                  <span>{item.label}</span>
                </button>
              ) : (
                <span className="sd-breadcrumb-static">
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
        {tabSpec.shortcut ? (
          <span className="sd-breadcrumb-meta" title={tabSpec.description}>
            {tabSpec.shortcut}
          </span>
        ) : null}
        {parentItem && parentItem.action ? (
          <button
            type="button"
            className="sd-breadcrumb-up-btn"
            onClick={() => onBreadcrumbAction(parentItem.action!)}
            title={`Go up to ${parentItem.label}`}
            data-breadcrumb-up="true"
          >
            <CornerLeftUp size={12} aria-hidden="true" />
            <span>Up to {parentItem.label}</span>
          </button>
        ) : null}
      </div>
    </nav>
  )
}
