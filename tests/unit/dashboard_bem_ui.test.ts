import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
const statusBarSource = readFileSync(
  resolve(root, "packages/ui/src/panels/UnifiedStatusBar.tsx"),
  "utf8",
)
const tickerOverlaySource = readFileSync(
  resolve(root, "packages/ui/src/panels/LiveTickerOverlay.tsx"),
  "utf8",
)
const customersSource = readFileSync(
  resolve(root, "packages/ui/src/panels/CustomersTabPanel.tsx"),
  "utf8",
)
const appSource = readFileSync(resolve(root, "packages/ui/src/App.tsx"), "utf8")
const deskCss = readFileSync(resolve(root, "packages/ui/src/desk.css"), "utf8")

describe("Bloomberg High-Density Ops UI (`sd-` BEM) architecture", () => {
  test("UnifiedStatusBar implements BEM status items, modifiers, data attributes, and pulse semantics", () => {
    expect(statusBarSource).toContain("sd-status-bar")
    expect(statusBarSource).toContain("sd-status-bar__item--api")
    expect(statusBarSource).toContain("sd-status-bar__item--r2")
    expect(statusBarSource).toContain("sd-status-bar__item--ws")
    expect(statusBarSource).toContain("sd-status-bar__item--health")
    expect(statusBarSource).toContain("sd-status-bar__item--risk")
    expect(statusBarSource).toContain("sd-status-bar__item--portal")
    expect(statusBarSource).toContain("sd-status-bar__item--ticker")
    expect(statusBarSource).toContain("sd-status-bar__item--pulse")
    expect(statusBarSource).toContain("sd-tabular")
    expect(statusBarSource).toContain("data-status=")
    expect(statusBarSource).toContain("data-severity=")
    expect(statusBarSource).toContain("data-type=")
    expect(statusBarSource).toContain('data-ws-status-pill="true"')
    expect(statusBarSource).toContain('data-ws-latency-indicator="true"')
    expect(statusBarSource).toContain('data-risk-threshold-indicator="true"')
  })

  test("App.tsx wires UnifiedStatusBar inside sd-telemetry-strip and mounts LiveTickerOverlay", () => {
    expect(appSource).toContain('className="sd-telemetry-strip"')
    expect(appSource).toContain("<UnifiedStatusBar")
    expect(appSource).toContain('refreshLabel="Refresh Telemetry"')
    expect(appSource).toContain("<LiveTickerOverlay")
    expect(appSource).toContain("tickerOverlayOpen={tickerOverlayOpen}")
    expect(appSource).toContain("rankings={rankings}")
  })

  test("CustomersTabPanel implements sticky BEM panes, gauges, sparklines, Sharpness Heatmap, Divergence Alert, and session banner", () => {
    expect(customersSource).toContain("sd-profile-list")
    expect(customersSource).toContain("sd-profile-list__header")
    expect(customersSource).toContain("sd-profile-row")
    expect(customersSource).toContain("sd-profile-row--selected")
    expect(customersSource).toContain("sd-profile-row--sharp")
    expect(customersSource).toContain("Sharpness Heatmap")
    expect(customersSource).toContain('data-sharpness-heatmap-toggle="true"')
    expect(customersSource).toContain("sd-profile-row__score")
    expect(customersSource).toContain("sd-risk-gauge")
    expect(customersSource).toContain("sd-profile-detail")
    expect(customersSource).toContain("sd-profile-detail__header")
    expect(customersSource).toContain("sd-profile-detail__alert--divergence")
    expect(customersSource).toContain("sd-alert-banner--divergence")
    expect(customersSource).toContain("sd-alert-banner--session-expired")
    expect(customersSource).toContain('data-alert="divergence"')
    expect(customersSource).toContain('data-alert="session-expired"')
    expect(customersSource).toContain("sd-action-bar")
    expect(customersSource).toContain("sd-action-btn--primary")
    expect(customersSource).toContain("sd-activity-timeline")
    expect(customersSource).toContain("sd-tabular")
    expect(customersSource).toContain("ProfileScoreSparkline")
  })

  test("LiveTickerOverlay implements dockable overlay with sharp/whale modifiers and tabular figures", () => {
    expect(tickerOverlaySource).toContain("sd-ticker-overlay")
    expect(tickerOverlaySource).toContain("sd-ticker-item--whale")
    expect(tickerOverlaySource).toContain("sd-ticker-item--sharp")
    expect(tickerOverlaySource).toContain("sd-badge--whale")
    expect(tickerOverlaySource).toContain("sd-badge--sharp")
    expect(tickerOverlaySource).toContain("sd-tabular")
    expect(tickerOverlaySource).toContain('data-type="live-ticker-overlay"')
  })

  test("desk.css defines all requested BEM selectors, semantic badges, pulse keyframes, reduced-motion, and light theme overrides", () => {
    const requiredSelectors = [
      ".sd-tabular",
      ".sd-status-bar",
      ".sd-status-bar__item--healthy",
      ".sd-status-bar__item--warning",
      ".sd-status-bar__item--critical",
      ".sd-status-bar__item--stale",
      ".sd-status-bar__item--offline",
      ".sd-status-bar__item--dead",
      ".sd-status-bar__item--selected",
      ".sd-status-bar__item--pulse",
      ".sd-profile-list",
      ".sd-profile-row",
      ".sd-profile-row--selected",
      ".sd-profile-row--sharp",
      ".sd-profile-row__score",
      ".sd-profile-detail",
      ".sd-profile-detail__alert--divergence",
      ".sd-badge--originator",
      ".sd-badge--syndicate-link",
      ".sd-badge--clv-leader",
      ".sd-badge--parlay-critical",
      ".sd-badge--sharp",
      ".sd-badge--whale",
      ".sd-badge--alert-operator",
      ".sd-alert-banner--session-expired",
      ".sd-alert-banner--divergence",
      ".sd-ticker-overlay",
      ".sd-ticker-item--whale",
      ".sd-ticker-item--sharp",
      ".sd-action-bar",
      ".sd-action-btn--primary",
      "@keyframes sd-critical-pulse",
      "prefers-reduced-motion: reduce",
      '[data-dashboard-theme="light"] .sd-status-bar__item',
      '[data-dashboard-theme="light"] .sd-profile-row--sharp',
    ]
    for (const sel of requiredSelectors) {
      expect(deskCss).toContain(sel)
    }
  })
})
