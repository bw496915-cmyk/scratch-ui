import { useEffect, useState } from "react"

import type { ProfileTheme } from "../../../../src/profile/types.ts"
import { parseProfileTheme } from "../../../../src/profile/validate.ts"
import { apiPostHeaders } from "../session_headers.ts"

async function readTheme(response: Response): Promise<ProfileTheme> {
  if (!response.ok) throw new Error("Profile settings are unavailable.")
  const body: unknown = await response.json()
  const parsed = parseProfileTheme(
    typeof body === "object" && body !== null && "theme" in body ? body.theme : null,
  )
  if (!parsed.ok) throw new Error("Profile settings could not be read.")
  return parsed.value
}

export function TerminalThemeControls() {
  const [theme, setTheme] = useState<ProfileTheme | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")

  useEffect(() => {
    const cancel = new AbortController()
    void fetch("/api/profile", { signal: cancel.signal, cache: "no-store" })
      .then(readTheme)
      .then(setTheme)
      .catch(() => {
        if (!cancel.signal.aborted) setMessage("Session theme is unavailable.")
      })
    return () => cancel.abort()
  }, [])

  async function saveTheme(value: ProfileTheme) {
    setSaving(true)
    setMessage("")
    try {
      const saved = await fetch("/api/profile/theme", {
        method: "POST",
        headers: apiPostHeaders(),
        body: JSON.stringify(value),
      }).then(readTheme)
      setTheme(saved)
      setMessage("Saved for this session.")
    } catch {
      setMessage("Could not save the session theme.")
    } finally {
      setSaving(false)
    }
  }

  if (theme === null) return message ? <span role="status">{message}</span> : null
  return (
    <form
      aria-label="Session terminal theme"
      onSubmit={(event) => {
        event.preventDefault()
        void saveTheme(theme)
      }}
    >
      <fieldset
        disabled={saving}
        style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center" }}
      >
        <legend>Session terminal theme</legend>
        <label>
          Detail depth{" "}
          <select
            value={Math.min(theme.inspect.depth, 6)}
            onChange={(event) =>
              setTheme({
                ...theme,
                inspect: { ...theme.inspect, depth: Number(event.target.value) },
              })
            }
          >
            {[0, 1, 2, 3, 4, 5, 6].map((depth) => (
              <option key={depth}>{depth}</option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={theme.inspect.colors}
            onChange={(event) =>
              setTheme({ ...theme, inspect: { ...theme.inspect, colors: event.target.checked } })
            }
          />{" "}
          Command colors
        </label>
        <label>
          Markdown background{" "}
          <select
            value={theme.terminal.light}
            onChange={(event) => {
              const light = event.target.value
              if (light === "auto" || light === "light" || light === "dark")
                setTheme({ ...theme, terminal: { ...theme.terminal, light } })
            }}
          >
            <option value="auto">Auto</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={theme.terminal.colors}
            onChange={(event) =>
              setTheme({ ...theme, terminal: { ...theme.terminal, colors: event.target.checked } })
            }
          />{" "}
          Markdown colors
        </label>
        <button type="submit">{saving ? "Saving…" : "Save theme"}</button>
        <span role="status">{message}</span>
      </fieldset>
    </form>
  )
}
