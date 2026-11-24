/**
 * Consistent Fantasy402 Manager Portal link builder with named browsing-context reuse
 * (`target="fantasy402-manager-session"`). Why a named target without `rel="noreferrer"` /
 * `noopener`: Spawning `target="_blank" rel="noreferrer"` creates a fresh isolated browsing context
 * on every click with empty `sessionStorage`, causing Fantasy402's `manager.html` to report "Your
 * session has expired" even when the operator is already signed in. Reusing a fixed named target
 * bound strictly to the hard-coded `https://fantasy402.com` origin lets the operator sign in once
 * in that tab and jump directly to `?customer=<ID>` while retaining session state.
 *
 * @file Packages/ui/src/portal_link.ts
 */

export const FANTASY402_PORTAL_ORIGIN = "https://fantasy402.com" as const
export const FANTASY402_PORTAL_WINDOW_TARGET = "fantasy402-manager-session" as const

export function buildFantasy402PortalEntryUrl(): string {
  return `${FANTASY402_PORTAL_ORIGIN}/manager.html`
}

export function buildFantasy402CustomerUrl(customerId: string): string {
  const cleaned = customerId.trim()
  if (!cleaned) {
    return buildFantasy402PortalEntryUrl()
  }
  return `${FANTASY402_PORTAL_ORIGIN}/manager.html?customer=${encodeURIComponent(cleaned)}`
}

export interface Fantasy402PortalLinkAttributes {
  readonly href: string
  readonly target: typeof FANTASY402_PORTAL_WINDOW_TARGET
}

/**
 * Returns anchor attributes that reuse the operator's authenticated Fantasy402 manager tab instead
 * of spawning an isolated sessionless tab.
 */
export function getFantasy402PortalLinkProps(customerId: string): Fantasy402PortalLinkAttributes {
  return {
    href: buildFantasy402CustomerUrl(customerId),
    target: FANTASY402_PORTAL_WINDOW_TARGET,
  }
}
