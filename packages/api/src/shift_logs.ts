/**
 * Server-side ring-buffered shift session log store powering `GET/POST /api/shift/logs` for the
 * Operator Shift Handoff modal. Captures timestamped operator lifecycle and desk actions (login,
 * logout, handoff initiated, alert acknowledgement, alert replay, sweep, operator switch, report
 * copied) within the active shift window. Strict allowlists and length bounds prevent untrusted
 * payloads or unbounded memory growth, and credentials/tokens are never recorded.
 *
 * @file Packages/api/src/shift_logs.ts
 */

export const SHIFT_SESSION_ACTIONS = [
  "login",
  "logout",
  "handoff_initiated",
  "handoff_synced",
  "handoff_report_copied",
  "alert_ack",
  "alert_retry",
  "alert_sweep",
  "operator_switch",
  "terminal_cmd",
] as const

export type ShiftSessionAction = (typeof SHIFT_SESSION_ACTIONS)[number]

const ACTION_SET: ReadonlySet<string> = new Set(SHIFT_SESSION_ACTIONS)

const ACTION_LABELS: Readonly<Record<ShiftSessionAction, string>> = {
  login: "Operator Login",
  logout: "Operator Sign-Out",
  handoff_initiated: "Handoff Initiated",
  handoff_synced: "Handoff Synced",
  handoff_report_copied: "Report Copied",
  alert_ack: "Alert Acknowledged",
  alert_retry: "Alert Replayed",
  alert_sweep: "Alert Sweep",
  operator_switch: "Operator Switched",
  terminal_cmd: "Terminal Command",
}

export interface ShiftSessionLogEntry {
  readonly id: string
  readonly timestamp: string
  readonly action: ShiftSessionAction
  readonly label: string
  readonly operatorId: string
  readonly summary: string
  readonly detail?: string | undefined
  readonly targetId?: string | undefined
  readonly source: "server" | "client"
}

export interface RecordShiftSessionLogInput {
  readonly action: ShiftSessionAction
  readonly operatorId?: string | undefined
  readonly summary: string
  readonly detail?: string | undefined
  readonly targetId?: string | undefined
  readonly source?: "server" | "client" | undefined
  readonly timestamp?: string | number | undefined
}

export interface ShiftSessionLogQuery {
  readonly operatorId?: string | undefined
  readonly sinceMs?: number | undefined
  readonly action?: ShiftSessionAction | undefined
  readonly limit?: number | undefined
}

export interface ShiftSessionLogsResponse {
  readonly operatorId: string | null
  readonly sinceIso: string | null
  readonly count: number
  readonly totalCaptured: number
  readonly logs: readonly ShiftSessionLogEntry[]
  readonly generatedAt: string
}

export interface ShiftSessionLogStore {
  record(input: RecordShiftSessionLogInput): ShiftSessionLogEntry
  list(query?: ShiftSessionLogQuery): ShiftSessionLogsResponse
  clear(): void
}

export function isShiftSessionAction(value: unknown): value is ShiftSessionAction {
  return typeof value === "string" && ACTION_SET.has(value)
}

/** Strip ASCII control characters and clamp length to prevent log/display abuse. */
export function sanitizeShiftLogText(raw: unknown, maxLength: number, fallback = ""): string {
  if (typeof raw !== "string") return fallback
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length === 0) return fallback
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned
}

/** Parse a `since` query parameter accepting either epoch ms or ISO-8601 string. */
export function parseShiftSinceMs(raw: string | null): number | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  if (/^\d{10,16}$/.test(trimmed)) {
    const num = Number(trimmed)
    return Number.isFinite(num) && num > 0 ? num : undefined
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function resolveTimestampIso(input?: string | number | undefined): string {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    return new Date(input).toISOString()
  }
  if (typeof input === "string" && input.trim() !== "") {
    const parsed = Date.parse(input)
    if (Number.isFinite(parsed) && parsed > 0) {
      return new Date(parsed).toISOString()
    }
  }
  return new Date().toISOString()
}

export function createShiftSessionLogStore(maxEntries = 500): ShiftSessionLogStore {
  const cap = Math.max(10, Math.min(5_000, Math.trunc(maxEntries)))
  const entries: ShiftSessionLogEntry[] = []
  let sequence = 0

  return {
    record(input: RecordShiftSessionLogInput): ShiftSessionLogEntry {
      sequence += 1
      const timestamp = resolveTimestampIso(input.timestamp)
      const operatorId = sanitizeShiftLogText(input.operatorId, 64, "operator")
      const summary = sanitizeShiftLogText(input.summary, 200, ACTION_LABELS[input.action])
      const detail = sanitizeShiftLogText(input.detail, 320, "")
      const targetId = sanitizeShiftLogText(input.targetId, 96, "")

      const entry: ShiftSessionLogEntry = {
        id: `shl-${sequence}-${Date.parse(timestamp)}`,
        timestamp,
        action: input.action,
        label: ACTION_LABELS[input.action],
        operatorId,
        summary,
        ...(detail !== "" ? { detail } : {}),
        ...(targetId !== "" ? { targetId } : {}),
        source: input.source ?? "server",
      }

      entries.push(entry)
      if (entries.length > cap) {
        entries.splice(0, entries.length - cap)
      }
      return entry
    },

    list(query: ShiftSessionLogQuery = {}): ShiftSessionLogsResponse {
      const normalizedOp = query.operatorId
        ? sanitizeShiftLogText(query.operatorId, 64, "").toLowerCase()
        : ""
      const sinceMs =
        typeof query.sinceMs === "number" && Number.isFinite(query.sinceMs)
          ? query.sinceMs
          : undefined
      const limit =
        typeof query.limit === "number" && Number.isFinite(query.limit)
          ? Math.max(1, Math.min(200, Math.trunc(query.limit)))
          : 100

      const matched: ShiftSessionLogEntry[] = []
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const item = entries[i]!
        if (sinceMs !== undefined && Date.parse(item.timestamp) < sinceMs) {
          continue
        }
        if (normalizedOp !== "" && item.operatorId.toLowerCase() !== normalizedOp) {
          continue
        }
        if (query.action && item.action !== query.action) {
          continue
        }
        matched.push(item)
        if (matched.length >= limit) break
      }

      return {
        operatorId: normalizedOp !== "" ? query.operatorId!.trim() : null,
        sinceIso: sinceMs !== undefined ? new Date(sinceMs).toISOString() : null,
        count: matched.length,
        totalCaptured: entries.length,
        logs: matched,
        generatedAt: new Date().toISOString(),
      }
    },

    clear(): void {
      entries.length = 0
    },
  }
}
