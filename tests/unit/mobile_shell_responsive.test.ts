import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { GlobalHeaderSearch } from "../../packages/ui/src/panels/GlobalHeaderSearch.tsx"

const UI_ROOT = resolve(import.meta.dir, "../../packages/ui/src")

function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "")
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = relativeLuminance(fgHex)
  const l2 = relativeLuminance(bgHex)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

describe("Mobile-First Responsive Dashboard Shell (375px–430px)", () => {
  const appSource = readFileSync(resolve(UI_ROOT, "App.tsx"), "utf8")
  const deskCss = readFileSync(resolve(UI_ROOT, "desk.css"), "utf8")
  const stylesSource = readFileSync(resolve(UI_ROOT, "dashboard_styles.ts"), "utf8")

  test("1. Header title bar is compact 1-row and telemetry strip is single-line horizontally scrollable", () => {
    expect(appSource).toContain('className="sd-app-header"')
    expect(appSource).toContain('className="sd-header-title-row" data-header-title-row="true"')
    expect(appSource).toContain('className="sd-mobile-menu-btn"')
    expect(appSource).toContain('data-mobile-nav-trigger="true"')

    expect(appSource).toContain('className="sd-telemetry-strip"')
    expect(appSource).toContain('data-telemetry-strip="true"')
    expect(appSource).toContain("Local :4022 SPA")
    expect(appSource).toContain("Refresh Telemetry")
    expect(appSource).toContain("<WsSyncStatusIndicator")

    expect(deskCss).toMatch(/\.sd-telemetry-strip\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;/s)
    expect(deskCss).toMatch(/\.sd-telemetry-item,\s*\.sd-telemetry-sep\s*\{[^}]*white-space:\s*nowrap;[^}]*flex-shrink:\s*0;/s)
  })

  test("2. Collapsible mobile navigation drawer (< 1024px) hides <kbd> shortcuts and sorts tabs Ctrl+1 through Ctrl+0", () => {
    expect(appSource).toContain('data-desktop-workspace-nav="true"')
    expect(appSource).toContain('data-mobile-nav-drawer="true"')
    expect(appSource).toContain('data-mobile-drawer-session="true"')
    expect(appSource).toContain('data-mobile-drawer-list="true"')

    // Verify all 10 workspace items use <kbd className="sd-kbd-shortcut"> in strict Ctrl+1..Ctrl+0 order
    const kbdMatches = [...appSource.matchAll(/<kbd className="sd-kbd-shortcut"[^>]*>\s*(Ctrl\+\d)\s*<\/kbd>/g)].map(
      (m) => m[1],
    )
    expect(kbdMatches).toEqual([
      "Ctrl+1",
      "Ctrl+2",
      "Ctrl+3",
      "Ctrl+4",
      "Ctrl+5",
      "Ctrl+6",
      "Ctrl+7",
      "Ctrl+8",
      "Ctrl+9",
      "Ctrl+0",
    ])

    // Below 1024px: desktop tab bar and <kbd> shortcuts hidden; >= 1024px: restored
    expect(deskCss).toMatch(/\.sd-desktop-tab-bar\s*\{\s*display:\s*none\s*!important;\s*\}/)
    expect(deskCss).toMatch(/\.sd-kbd-shortcut\s*\{\s*display:\s*none\s*!important;\s*\}/)
    expect(deskCss).toMatch(/@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.sd-desktop-tab-bar\s*\{\s*display:\s*flex\s*!important;\s*\}[\s\S]*\.sd-kbd-shortcut\s*\{\s*display:\s*inline-flex\s*!important;/s)
    expect(deskCss).toMatch(/@media\s*\(min-width:\s*1024px\)\s*\{[\s\S]*\.sd-mobile-menu-btn\s*\{\s*display:\s*none\s*!important;\s*\}/s)
  })

  test("3. Primary tab bar scrolls horizontally and Light-mode GlobalHeaderSearch uses surface/border tokens (not solid black)", () => {
    expect(deskCss).toMatch(/\.sd-primary-nav\s*\{[^}]*flex-wrap:\s*nowrap;[^}]*overflow-x:\s*auto;[^}]*white-space:\s*nowrap;/s)

    const searchHtml = renderToStaticMarkup(
      React.createElement(GlobalHeaderSearch, {
        query: "",
        onQueryChange: () => {},
        wagers: [],
        customers: [],
        tickers: [],
        onSelectWager: () => {},
        onSelectCustomer: () => {},
        onSelectTicker: () => {},
        onViewAllInTab: () => {},
      }),
    )

    expect(searchHtml).toContain("sd-global-search-box")
    expect(searchHtml).toContain("sd-global-search-input")
    expect(searchHtml).toContain("sd-global-search-kbd sd-kbd-shortcut")
    expect(searchHtml).toContain("background-color:var(--surface-page")
    expect(searchHtml).toContain("border-color:var(--border-default")
    expect(searchHtml).not.toContain("background-color:#070b14")
    expect(searchHtml).not.toContain("rgb(7, 11, 20)")

    expect(deskCss).toContain('[data-dashboard-theme="light"] > header .sd-global-search-box')
    expect(deskCss).toContain('[data-dashboard-theme="light"] > header .sd-global-search-input')
  })

  test("4. DESK QUICK-JUMP Light-mode pills meet >= 4.5:1 WCAG AA contrast and main canvas reserves pb-24 (6rem) safe-area padding", () => {
    expect(appSource).toContain('className="sd-quickjump-pill sd-quickjump-pill--neutral"')
    expect(appSource).toContain("BookDeskOps tokens")

    // Verify Light-mode pill contrast ratios >= 4.5:1
    const lightPillPairs: ReadonlyArray<readonly [string, string, string]> = [
      ["neutral (BookDeskOps tokens)", "#0f172a", "#e2e8f0"],
      ["sky (Active Risk / /static/* Dir)", "#0c4a6e", "#e0f2fe"],
      ["amber (NFL 1H Pregame / NCAAB)", "#78350f", "#fef3c7"],
      ["violet (GSLIVE / GS Builder)", "#581c87", "#f3e8ff"],
      ["green (Figure-Date Audit / NORM)", "#14532d", "#dcfce7"],
      ["red (CRIT)", "#7f1d1d", "#fee2e2"],
    ]
    for (const [_label, fg, bg] of lightPillPairs) {
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5)
    }

    expect(deskCss).toContain(
      '[data-dashboard-theme="light"] > section[aria-label="Operations Command Ribbon"] .sd-quickjump-pill--neutral',
    )
    expect(deskCss).toContain("padding-bottom: calc(6rem + env(safe-area-inset-bottom, 0px)) !important;")
    expect(stylesSource).toContain('padding: "36px 28px 96px"')
  })

  test("5. Required operational badges remain preserved (LIMIT, DEAD, STALE, Active Risk, GSLIVE)", () => {
    expect(appSource).toContain('"LIMIT"')
    expect(appSource).toContain("DEAD")
    expect(appSource).toContain("STALE")
    expect(appSource).toContain("Active Risk:")
    expect(appSource).toContain("GSLIVE")
  })

  test("6. Root layout container eliminates horizontal page overflow with overflow-x: clip, max-width: 100%, and min-width: 0 guards", () => {
    expect(appSource).toContain('className="sd-app-shell"')
    expect(stylesSource).toContain('overflowX: "clip" as const')
    expect(stylesSource).toContain('maxWidth: "100%"')
    expect(stylesSource).toContain("minWidth: 0")

    expect(deskCss).toMatch(/html,\s*body\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*clip;/s)
    expect(deskCss).toMatch(/\.sd-app-shell,\s*\[data-dashboard-theme\]\s*\{[^}]*overflow-x:\s*clip;[^}]*max-width:\s*100%;/s)
    expect(deskCss).toMatch(/\.sd-quickjump-meta\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s)
  })

  test("7. Light mode clears dark main canvas gradient and binds Fantasy402 Portal Session Notice to >= 4.5:1 tokens", () => {
    const customersPanelSource = readFileSync(
      resolve(UI_ROOT, "panels/CustomersTabPanel.tsx"),
      "utf8",
    )

    expect(deskCss).toMatch(
      /\[data-dashboard-theme="light"\]\s*>\s*main\.sd-main-canvas\s*\{[^}]*background-color:\s*var\(--surface-page,\s*#f1f5f9\)\s*!important;[^}]*background-image:\s*none\s*!important;/s,
    )
    expect(customersPanelSource).toContain('className="sd-portal-session-notice"')
    expect(customersPanelSource).toContain('className="sd-portal-session-notice-link"')
    expect(customersPanelSource).toContain('className="sd-portal-session-notice-dismiss"')

    expect(deskCss).toContain('[data-dashboard-theme="light"] .sd-portal-session-notice')
    expect(deskCss).toContain('[data-dashboard-theme="light"] .sd-portal-session-notice-link')
    expect(deskCss).toContain('[data-dashboard-theme="light"] .sd-portal-session-notice-dismiss')

    expect(contrastRatio("#78350f", "#fffbeb")).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio("#92400e", "#fffbeb")).toBeGreaterThanOrEqual(4.5)
  })

  test("8. Breadcrumb Ctrl+1 shortcut hint next to Up to Profiles is hidden below 1024px (sd-kbd-shortcut)", () => {
    const breadcrumbsSource = readFileSync(
      resolve(UI_ROOT, "panels/DashboardBreadcrumbs.tsx"),
      "utf8",
    )

    expect(breadcrumbsSource).toContain('<kbd className="sd-breadcrumb-meta sd-kbd-shortcut"')
    expect(breadcrumbsSource).not.toContain('<span className="sd-breadcrumb-meta"')
  })
})
