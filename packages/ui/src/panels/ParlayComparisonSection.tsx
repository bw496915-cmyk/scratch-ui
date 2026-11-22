import React, { useEffect, useRef, useState } from "react"
import type { ParlayComparisonResponse, ParlayComparisonSource } from "@sportsdesk-ops/contracts"

const cell = { padding: "6px 8px", textAlign: "left", verticalAlign: "top" } as const
const input = {
  backgroundColor: "#0b1525",
  border: "1px solid #334155",
  borderRadius: "5px",
  color: "#e2e8f0",
  padding: "4px 7px",
  font: "inherit",
} as const

export function ParlayComparisonSection() {
  const [source, setSource] = useState<ParlayComparisonSource>("ticker")
  const [date, setDate] = useState("")
  const [account, setAccount] = useState("")
  const [result, setResult] = useState<ParlayComparisonResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])

  async function refreshParlayComparison() {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const params = new URLSearchParams({ source })
    if (date) params.set("day", date)
    if (account.trim()) params.set("account", account.trim())
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/weblogs/parlay-comparison?${params}`, {
        cache: "no-store",
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Comparison request returned ${response.status}`)
      const payload: ParlayComparisonResponse = await response.json()
      if (!controller.signal.aborted) {
        setResult(payload)
        if (!date && payload.sourceDay) setDate(payload.sourceDay)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : "Comparison unavailable")
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }

  const formatted = (n: number) => n.toLocaleString()
  const rate = (n: number, eligible: number) =>
    eligible ? `${formatted(n)}/${formatted(eligible)}` : "—"

  return (
    <details
      style={{ padding: "8px 10px", fontSize: "12px", color: "#cbd5e1" }}
      onToggle={(event) => {
        if (event.currentTarget.open && !result && !loading) void refreshParlayComparison()
      }}
    >
      <summary style={{ cursor: "pointer", color: "#7dd3fc" }}>Parlay comparison</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void refreshParlayComparison()
        }}
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          marginTop: "10px",
        }}
      >
        <label>
          Source{" "}
          <select
            style={input}
            value={source}
            onChange={(event) => setSource(event.target.value === "weblog" ? "weblog" : "ticker")}
          >
            <option value="ticker">Ticker wagers</option>
            <option value="weblog">Weblog descriptions</option>
          </select>
        </label>
        <label>
          Source date{" "}
          <input
            style={input}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label>
          Account{" "}
          <input
            style={input}
            value={account}
            maxLength={64}
            placeholder="Separate logins with commas"
            onChange={(event) => setAccount(event.target.value)}
          />
        </label>
        <button style={input} type="submit" disabled={loading}>
          {loading ? "Loading…" : "Compare"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && !result.available && <p>{result.reason}</p>}
      {result?.available && (
        <>
          <p aria-live="polite">
            <strong>
              {result.source === "ticker" ? "Ticker wagers" : "Weblog descriptions"} ·{" "}
              {result.sourceDay}
            </strong>
            {" · "}
            {formatted(result.total.rows)} rows · {formatted(result.scopeCount)} account scopes
            {" · "}
            {formatted(result.total.parsedRows)} parsed · Median {result.total.medianLegs ?? "—"}{" "}
            legs
            {" · "}Mixed sports {rate(result.total.mixedSportRows, result.total.parsedRows)}
            {" · "}Part-period {rate(result.total.partialPeriodRows, result.total.parsedRows)}
          </p>
          {result.source === "ticker" ? (
            <p>
              Ticker archive window {((result.archiveBytes ?? 0) / 1024 / 1024).toFixed(1)} MiB.
              Excluded {formatted(result.excluded.sentinelRows)} notices,{" "}
              {formatted(result.excluded.duplicateRows)} duplicates,{" "}
              {formatted(result.excluded.conflictGroups)} conflicts and{" "}
              {formatted(result.excluded.invalidRows)} invalid rows.
            </p>
          ) : (
            <p>Retained Action messages. Ticket acceptance requires separate evidence.</p>
          )}
          {result.matchingScopeCount > result.accounts.length && (
            <p>
              Showing {result.accounts.length} of {formatted(result.matchingScopeCount)} matching
              account scopes. Search for an account to narrow the list.
            </p>
          )}
          {result.accounts.length === 0 && (
            <p>No parlay rows match this date and account filter.</p>
          )}
          {result.accounts.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table
                aria-label="Parlay composition by account"
                style={{ width: "100%", borderCollapse: "collapse" }}
              >
                <thead style={{ backgroundColor: "#101a2b" }}>
                  <tr>
                    {[
                      "Login",
                      "Parsed / rows",
                      "Median legs",
                      "Two legs",
                      "Mixed sports",
                      "Part-period",
                      "Point buy",
                      "Top sport mix",
                    ].map((label) => (
                      <th key={label} scope="col" style={cell}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.accounts.map((row) => (
                    <tr
                      key={JSON.stringify([row.agent, row.customer, row.login])}
                      style={{ borderBottom: "1px solid #1e293b" }}
                    >
                      <th scope="row" style={cell}>
                        {row.login}
                        {row.customer && row.customer !== row.login && (
                          <small> · {row.customer}</small>
                        )}
                        {row.agent && <small> · {row.agent}</small>}
                      </th>
                      <td style={cell}>{rate(row.parsedRows, row.rows)}</td>
                      <td style={cell}>{row.medianLegs ?? "—"}</td>
                      <td style={cell}>{rate(row.twoLegRows, row.parsedRows)}</td>
                      <td style={cell}>{rate(row.mixedSportRows, row.parsedRows)}</td>
                      <td
                        style={cell}
                        title={`${row.missingPeriodRows} parsed rows have a leg without a recognized period`}
                      >
                        {rate(row.partialPeriodRows, row.parsedRows)}
                      </td>
                      <td style={cell}>{rate(row.pointBuyRows, row.parsedRows)}</td>
                      <td style={cell}>
                        {row.topMix ? `${row.topMix.label} (${row.topMix.rows})` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </details>
  )
}
