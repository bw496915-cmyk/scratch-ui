import { Moon, Sun } from "lucide-react"
import type React from "react"

export type DashboardTheme = "dark" | "light"

export const DASHBOARD_THEME_STORAGE_KEY = "sportsdesk_dashboard_theme"

export function normalizeDashboardTheme(raw: unknown): DashboardTheme {
  return raw === "light" ? "light" : "dark"
}

export function nextDashboardTheme(current: DashboardTheme): DashboardTheme {
  return current === "dark" ? "light" : "dark"
}

export function readStoredDashboardTheme(): DashboardTheme {
  try {
    if (typeof localStorage !== "undefined") {
      return normalizeDashboardTheme(localStorage.getItem(DASHBOARD_THEME_STORAGE_KEY))
    }
  } catch {
    // Ignore storage restriction errors in sandboxed iframes
  }
  return "dark"
}

export function applyDashboardThemeToDocument(theme: DashboardTheme): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DASHBOARD_THEME_STORAGE_KEY, theme)
    }
  } catch {
    // Ignore storage restriction errors
  }
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.dataset.dashboardTheme = theme
    document.documentElement.style.colorScheme = theme
  }
}

export interface HeaderThemeToggleProps {
  readonly theme: DashboardTheme
  readonly onToggle: (next: DashboardTheme) => void
}

export function HeaderThemeToggle({ theme, onToggle }: HeaderThemeToggleProps): React.ReactElement {
  const isLight = theme === "light"
  const next = nextDashboardTheme(theme)

  return (
    <button
      type="button"
      data-theme-toggle="true"
      data-theme-value={theme}
      aria-pressed={isLight}
      aria-label={`Switch to ${next} theme (current: ${theme})`}
      title={`Switch to ${next === "light" ? "Light" : "Dark"} mode for ${next === "light" ? "bright environments" : "low-light desks"}`}
      onClick={() => onToggle(next)}
      className="sd-theme-toggle-btn"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "5px 10px",
        borderRadius: "6px",
        fontSize: "11px",
        fontWeight: 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
        backgroundColor: isLight ? "#ffffff" : "#1e293b",
        color: isLight ? "#0f172a" : "#e2e8f0",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: isLight ? "#cbd5e1" : "#334155",
        boxShadow: isLight ? "0 1px 2px rgba(15, 23, 42, 0.08)" : "0 1px 2px rgba(2, 6, 23, 0.4)",
        transition: "background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease",
      }}
    >
      {isLight ? (
        <Sun size={13} aria-hidden="true" style={{ color: "#d97706", flexShrink: 0 }} />
      ) : (
        <Moon size={13} aria-hidden="true" style={{ color: "#38bdf8", flexShrink: 0 }} />
      )}
      <span>{isLight ? "Light" : "Dark"}</span>
    </button>
  )
}
