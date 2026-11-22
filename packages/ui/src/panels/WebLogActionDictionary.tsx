import React from "react"
import {
  WEBLOG_ACTION_DICTIONARY,
  WEBLOG_OPERATIONS,
  type WebLogClientProfile,
  type WebLogClientSummary,
  type WebLogEventKind,
} from "@sportsdesk-ops/contracts"

interface WebLogActionDictionaryProps {
  readonly kinds: readonly { readonly kind: WebLogEventKind; readonly count: number }[]
  readonly clients: WebLogClientSummary
  readonly onSelectKind: (kind: WebLogEventKind) => void
  readonly onSelectClient: (profile: WebLogClientProfile) => void
}

const cell = { padding: "6px 8px", textAlign: "left", verticalAlign: "top" } as const
const button = {
  backgroundColor: "#142238",
  border: "1px solid #334155",
  borderRadius: "4px",
  color: "#bae6fd",
  cursor: "pointer",
  font: "inherit",
  padding: "3px 6px",
} as const

const kinds = Object.keys(WEBLOG_OPERATIONS).filter((kind): kind is WebLogEventKind =>
  Object.hasOwn(WEBLOG_ACTION_DICTIONARY, kind),
)

export function WebLogActionDictionary({
  kinds: observedKinds,
  clients,
  onSelectKind,
  onSelectClient,
}: WebLogActionDictionaryProps) {
  const counts = new Map(observedKinds.map(({ kind, count }) => [kind, count]))
  return (
    <details style={{ padding: "8px 10px", fontSize: "12px", color: "#cbd5e1" }}>
      <summary style={{ cursor: "pointer", color: "#7dd3fc" }}>Action dictionary</summary>
      <p>
        <code>API LOG</code> is a marker in the Action text. A bracketed version and site identify
        values recorded in that message. <code>(M)</code> and <code>(D)</code> are source codes. The
        log leaves the execution layer and device identity unverified.
      </p>
      <div style={{ maxHeight: "320px", overflow: "auto" }}>
        <table
          style={{ width: "100%", borderCollapse: "collapse" }}
          aria-label="Weblog action dictionary"
        >
          <thead style={{ position: "sticky", top: 0, backgroundColor: "#101a2b" }}>
            <tr>
              <th scope="col" style={cell}>
                Action
              </th>
              <th scope="col" style={cell}>
                Provider marker
              </th>
              <th scope="col" style={cell}>
                Meaning
              </th>
              <th scope="col" style={cell}>
                Rows
              </th>
            </tr>
          </thead>
          <tbody>
            {kinds.map((kind) => {
              const count = counts.get(kind) ?? 0
              const definition = WEBLOG_ACTION_DICTIONARY[kind]
              return (
                <tr key={kind} style={{ borderBottom: "1px solid #1e293b" }}>
                  <th scope="row" style={cell}>
                    {count > 0 ? (
                      <button style={button} type="button" onClick={() => onSelectKind(kind)}>
                        {WEBLOG_OPERATIONS[kind].label}
                      </button>
                    ) : (
                      WEBLOG_OPERATIONS[kind].label
                    )}
                  </th>
                  <td style={cell}>
                    <code>{definition.marker}</code>
                  </td>
                  <td style={cell}>{definition.meaning}</td>
                  <td style={cell}>{count.toLocaleString()}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginBottom: "4px", fontSize: "13px" }}>Logged sites and versions</h3>
      <p style={{ marginTop: 0 }}>
        {clients.rowsWithSiteVersion.toLocaleString()} rows · {clients.siteCount} sites ·{" "}
        {clients.versionCount} versions. Each group counts messages by action.
        {clients.profileCount > clients.profiles.length &&
          ` Showing the ${clients.profiles.length} largest of ${clients.profileCount} groups.`}
      </p>
      {clients.profiles.length > 0 && (
        <div style={{ maxHeight: "280px", overflow: "auto" }}>
          <table
            style={{ width: "100%", borderCollapse: "collapse" }}
            aria-label="Logged site and version profiles"
          >
            <thead style={{ position: "sticky", top: 0, backgroundColor: "#101a2b" }}>
              <tr>
                <th scope="col" style={cell}>
                  Site and version
                </th>
                <th scope="col" style={cell}>
                  Rows
                </th>
                <th scope="col" style={cell}>
                  Action counts
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.profiles.map((profile) => (
                <tr
                  key={`${profile.site} ${profile.version}`}
                  style={{ borderBottom: "1px solid #1e293b" }}
                >
                  <th scope="row" style={cell}>
                    <button style={button} type="button" onClick={() => onSelectClient(profile)}>
                      {profile.site} · {profile.version}
                    </button>
                  </th>
                  <td style={cell}>{profile.count.toLocaleString()}</td>
                  <td style={cell}>
                    {profile.operations
                      .map(
                        ({ kind, count }) =>
                          `${WEBLOG_OPERATIONS[kind].label} ${count.toLocaleString()}`,
                      )
                      .join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  )
}
