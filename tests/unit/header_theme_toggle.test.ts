import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import {
  DASHBOARD_THEME_STORAGE_KEY,
  HeaderThemeToggle,
  nextDashboardTheme,
  normalizeDashboardTheme,
} from "../../packages/ui/src/panels/ThemeToggle.tsx"

const UI_ROOT = resolve(import.meta.dir, "../../packages/ui/src")

describe("Header Light/Dark Theme Toggle", () => {
  test("normalizeDashboardTheme defaults safely to dark and accepts light", () => {
    expect(normalizeDashboardTheme("light")).toBe("light")
    expect(normalizeDashboardTheme("dark")).toBe("dark")
    expect(normalizeDashboardTheme(null)).toBe("dark")
    expect(normalizeDashboardTheme(undefined)).toBe("dark")
    expect(normalizeDashboardTheme("sepia")).toBe("dark")
    expect(DASHBOARD_THEME_STORAGE_KEY).toBe("sportsdesk_dashboard_theme")
  })

  test("nextDashboardTheme alternates cleanly between dark and light", () => {
    expect(nextDashboardTheme("dark")).toBe("light")
    expect(nextDashboardTheme("light")).toBe("dark")
  })

  test("HeaderThemeToggle renders accessible dark and light states", () => {
    const darkHtml = renderToStaticMarkup(
      React.createElement(HeaderThemeToggle, {
        theme: "dark",
        onToggle: () => {},
      }),
    )
    expect(darkHtml).toContain('data-theme-toggle="true"')
    expect(darkHtml).toContain('data-theme-value="dark"')
    expect(darkHtml).toContain('aria-pressed="false"')
    expect(darkHtml).toContain("Dark")
    expect(darkHtml).toContain("Switch to light theme")

    const lightHtml = renderToStaticMarkup(
      React.createElement(HeaderThemeToggle, {
        theme: "light",
        onToggle: () => {},
      }),
    )
    expect(lightHtml).toContain('data-theme-toggle="true"')
    expect(lightHtml).toContain('data-theme-value="light"')
    expect(lightHtml).toContain('aria-pressed="true"')
    expect(lightHtml).toContain("Light")
    expect(lightHtml).toContain("Switch to dark theme")
  })

  test("tokens.css and desk.css define light-theme overrides for header, command ribbon section, and main canvas", () => {
    const tokensCss = readFileSync(resolve(UI_ROOT, "styles/tokens.css"), "utf8")
    const deskCss = readFileSync(resolve(UI_ROOT, "desk.css"), "utf8")

    expect(tokensCss).toContain('[data-dashboard-theme="light"]')
    expect(tokensCss).toContain("--neutral-0: #f1f5f9;")
    expect(tokensCss).toContain("--neutral-11: #0f172a;")

    expect(deskCss).toContain('[data-dashboard-theme="light"] > header')
    expect(deskCss).toContain(
      '[data-dashboard-theme="light"] > section[aria-label="Operations Command Ribbon"]',
    )
    expect(deskCss).toContain('[data-dashboard-theme="light"] > main.sd-main-canvas')
  })
})
