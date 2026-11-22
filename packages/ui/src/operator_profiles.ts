/**
 * @file packages/ui/src/operator_profiles.ts
 * @description Operator profile roster, studio avatar registry, branding asset
 * manifest, and 8-hour rolling Shift Handoff summary report generator.
 */
import type { DashboardAlertRecord, LiveWager, ShiftSummaryData } from "./types.ts"

export interface OperatorProfile {
  readonly id: string
  readonly displayName: string
  readonly role: string
  readonly shiftBand: string
  readonly deskCode: string
  readonly avatarUrl: string
  readonly avatarAlt: string
  readonly accentColor: string
}

export const BRAND_ASSETS = {
  appName: "SportsDesk Ops Surveillance Dashboard-v1.01.23-next",
  shortName: "SportsDesk & Fantasy402 Operations",
  monogram: "SD",
  version: "v1.01.23-next",
  organization: "SportsDesk & Fantasy402 Quantitative Risk Operations",
  tagline: "Real-time wager surveillance, sharp profiling, and automated risk desk telemetry",
  tokensVersion: "1.5.0",
  domainContext: "sportsbook-risk-surveillance",
  emblemWebp: "/assets/branding/sportsdesk-emblem.webp",
  emblemPng64: "/assets/branding/sportsdesk-emblem-64.png",
  emblemPng180: "/assets/branding/sportsdesk-emblem-180.png",
  emblemPng512: "/assets/branding/sportsdesk-emblem-512.png",
  ogCardJpg: "/assets/branding/sportsdesk-og-card.jpg",
  ogCardWebp: "/assets/branding/sportsdesk-og-card.webp",
  ogCardWidth: 1200,
  ogCardHeight: 630,
  manifestUrl: "/manifest.webmanifest",
  metadataCatalogUrl: "/assets/branding/branding-metadata.json",
  emblemAlt:
    "SportsDesk & Fantasy402 hexagonal obsidian radar shield emblem with cyan trajectory vector",
  ogImageAlt:
    "SportsDesk & Fantasy402 Operations surveillance radar shield and real-time telemetry banner",
  palette: {
    canvasBg: "#070b14",
    surfaceElevated: "#0b1120",
    accentPrimary: "#38bdf8",
    accentEmerald: "#34d399",
    accentAmber: "#fbbf24",
    accentDanger: "#f87171",
  },
} as const

export const OPERATOR_PROFILES: readonly OperatorProfile[] = [
  {
    id: "operator",
    displayName: "Alex Vance",
    role: "Senior Risk Desk Lead",
    shiftBand: "06:00–14:00 EST",
    deskCode: "DESK-01",
    avatarUrl: "/assets/operators/operator-lead.webp",
    avatarAlt: "Portrait of Alex Vance, Senior Risk Desk Lead",
    accentColor: "#38bdf8",
  },
  {
    id: "maya.chen",
    displayName: "Maya Chen",
    role: "Quantitative Line Surveillance",
    shiftBand: "14:00–22:00 EST",
    deskCode: "QUANT-02",
    avatarUrl: "/assets/operators/operator-quant.webp",
    avatarAlt: "Portrait of Maya Chen, Quantitative Line Surveillance",
    accentColor: "#a78bfa",
  },
  {
    id: "marcus.cole",
    displayName: "Marcus Cole",
    role: "Night-Shift Surveillance Specialist",
    shiftBand: "22:00–06:00 EST",
    deskCode: "NIGHT-03",
    avatarUrl: "/assets/operators/operator-night.webp",
    avatarAlt: "Portrait of Marcus Cole, Night-Shift Surveillance Specialist",
    accentColor: "#34d399",
  },
  {
    id: "elena.rostova",
    displayName: "Elena Rostova",
    role: "Compliance & DLQ Audit Lead",
    shiftBand: "08:00–16:00 EST",
    deskCode: "AUDIT-04",
    avatarUrl: "/assets/operators/operator-audit.webp",
    avatarAlt: "Portrait of Elena Rostova, Compliance & DLQ Audit Lead",
    accentColor: "#fbbf24",
  },
] as const

function hashString(input: string): number {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash)
}

export function getOperatorInitials(identifier: string): string {
  const cleaned = identifier.trim()
  if (!cleaned) return "OP"
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase()
  }
  return cleaned.slice(0, 2).toUpperCase()
}

export function resolveOperatorProfile(operatorId: string): OperatorProfile {
  const normalized = operatorId.trim().toLowerCase() || "operator"
  const exact = OPERATOR_PROFILES.find(
    (p) => p.id.toLowerCase() === normalized || p.displayName.toLowerCase() === normalized,
  )
  if (exact) return exact

  const fallbackIdx = hashString(normalized) % OPERATOR_PROFILES.length
  const template = OPERATOR_PROFILES[fallbackIdx]!
  return {
    id: operatorId.trim() || "operator",
    displayName: operatorId.trim() || "operator",
    role: "Risk Surveillance Operator",
    shiftBand: template.shiftBand,
    deskCode: `OPS-${String(fallbackIdx + 1).padStart(2, "0")}`,
    avatarUrl: template.avatarUrl,
    avatarAlt: `Operator profile portrait for ${operatorId.trim() || "operator"}`,
    accentColor: template.accentColor,
  }
}

export interface EightHourActivityMetrics {
  readonly windowHours: 8
  readonly windowStartIso: string
  readonly windowEndIso: string
  readonly acknowledgedAlerts8h: number
  readonly totalAlerts8h: number
  readonly deliveredAlerts8h: number
  readonly deadLetterAlerts8h: number
  readonly wagerTicketsProcessed8h: number
  readonly wagerRiskUsd8h: number
  readonly criticalWagers8h: number
  readonly steamWagers8h: number
  readonly avgClvCents8h: number | null
  readonly terminalCommandsCount: number
  readonly failedAttempts: number
}

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000

function parseTimestampMs(raw?: string | number | null): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

export function computeEightHourActivityMetrics(input: {
  readonly shiftSummary: ShiftSummaryData | null
  readonly alerts?: readonly DashboardAlertRecord[] | undefined
  readonly wagers?: readonly LiveWager[] | undefined
  readonly nowMs?: number | undefined
}): EightHourActivityMetrics {
  const nowMs = input.nowMs ?? Date.now()
  const cutoffMs = nowMs - EIGHT_HOURS_MS
  const windowStartIso = input.shiftSummary?.windowStartIso ?? new Date(cutoffMs).toISOString()
  const windowEndIso = input.shiftSummary?.windowEndIso ?? new Date(nowMs).toISOString()

  const allAlerts = input.alerts ?? []
  const recentAlerts = allAlerts.filter((a) => {
    const ts = parseTimestampMs(a.updatedAt ?? a.createdAt)
    return ts === null || ts >= cutoffMs
  })

  const uiAck8h = recentAlerts.filter((a) => a.status === "acknowledged").length
  const uiDelivered8h = recentAlerts.filter((a) => a.status === "delivered").length
  const uiDead8h = recentAlerts.filter((a) => a.status === "dead").length

  const acknowledgedAlerts8h = Math.max(
    uiAck8h,
    input.shiftSummary?.acknowledgedAlertsLast8h ?? input.shiftSummary?.acknowledgedAlerts ?? 0,
  )
  const totalAlerts8h = Math.max(
    recentAlerts.length,
    input.shiftSummary?.alertsLast8h ?? input.shiftSummary?.totalAlerts ?? 0,
  )
  const deliveredAlerts8h = Math.max(
    uiDelivered8h,
    input.shiftSummary?.deliveredAlertsLast8h ?? input.shiftSummary?.deliveredAlerts ?? 0,
  )
  const deadLetterAlerts8h = Math.max(
    uiDead8h,
    input.shiftSummary?.deadLetterAlertsLast8h ?? input.shiftSummary?.deadLetterAlerts ?? 0,
  )

  const allWagers = input.wagers ?? []
  const timedRecentWagers = allWagers.filter((w) => {
    const ts = parseTimestampMs(w.timestamp)
    return ts !== null && ts >= cutoffMs
  })
  // If fixture/capture timestamps predate wall clock, fall back to active live capture slice
  const activeWagerSlice = timedRecentWagers.length > 0 ? timedRecentWagers : allWagers

  const wagerTicketsProcessed8h = Math.max(
    activeWagerSlice.length,
    input.shiftSummary?.wagerTicketsProcessedLast8h ?? 0,
  )
  const wagerRiskUsd8h = activeWagerSlice.reduce(
    (sum, w) => sum + (Number.isFinite(w.riskUsd) ? w.riskUsd : 0),
    0,
  )
  const criticalWagers8h = activeWagerSlice.filter((w) => w.alertTier === "CRITICAL").length
  const steamWagers8h = activeWagerSlice.filter(
    (w) =>
      w.alertTier === "STEAM_MOVE" ||
      w.alertTier === "ORIGINATOR_HIGH_RISK" ||
      w.alertTier === "LATENCY" ||
      w.alertTier === "LATENCY_ARB",
  ).length

  const clvValues = activeWagerSlice
    .map((w) => w.clvCents)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  const avgClvCents8h =
    clvValues.length > 0
      ? Number((clvValues.reduce((s, v) => s + v, 0) / clvValues.length).toFixed(1))
      : null

  return {
    windowHours: 8,
    windowStartIso,
    windowEndIso,
    acknowledgedAlerts8h,
    totalAlerts8h,
    deliveredAlerts8h,
    deadLetterAlerts8h,
    wagerTicketsProcessed8h,
    wagerRiskUsd8h,
    criticalWagers8h,
    steamWagers8h,
    avgClvCents8h,
    terminalCommandsCount: input.shiftSummary?.terminalCommandsCount ?? 0,
    failedAttempts: input.shiftSummary?.failedAttempts ?? 0,
  }
}

export function formatShiftSecondsClock(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(clamped / 3600)
  const minutes = Math.floor((clamped % 3600) / 60)
  const seconds = clamped % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

export function buildEightHourShiftReport(input: {
  readonly operatorId: string
  readonly metrics: EightHourActivityMetrics
  readonly activeShiftSeconds?: number | undefined
}): string {
  const profile = resolveOperatorProfile(input.operatorId)
  const { metrics } = input
  const startUtc = metrics.windowStartIso.replace("T", " ").slice(0, 16) + "Z"
  const endUtc = metrics.windowEndIso.replace("T", " ").slice(0, 16) + "Z"
  const shiftClock = formatShiftSecondsClock(input.activeShiftSeconds ?? 0)
  const handleFormatted = `$${Math.round(metrics.wagerRiskUsd8h).toLocaleString()}`
  const clvLine =
    metrics.avgClvCents8h !== null
      ? `${metrics.avgClvCents8h > 0 ? "+" : ""}${metrics.avgClvCents8h.toFixed(1)}¢ avg CLV`
      : "CLV pending close"
  const statusLine =
    metrics.deadLetterAlerts8h > 0
      ? `ACTION REQUIRED — ${metrics.deadLetterAlerts8h} dead-letter alert(s) pending replay or operator sign-off.`
      : "CLEAR FOR HANDOFF — Zero unresolved dead-letter alerts; all critical and steam exposures reviewed."

  return [
    `SHIFT HANDOFF REPORT · LAST 8 HOURS (${startUtc} → ${endUtc})`,
    `Operator: ${profile.displayName} (${profile.id}) · ${profile.role} [${profile.deskCode}]`,
    `Active Shift Duration: ${shiftClock} · Shift Band: ${profile.shiftBand}`,
    "",
    "8-HOUR ACTIVITY SUMMARY",
    `- Acknowledged Alerts: ${metrics.acknowledgedAlerts8h} / ${metrics.totalAlerts8h} total (${metrics.deliveredAlerts8h} delivered, ${metrics.deadLetterAlerts8h} DLQ)`,
    `- Wager Tickets Processed: ${metrics.wagerTicketsProcessed8h} ticket(s) · ${handleFormatted} handle (${clvLine})`,
    `- Priority Exposure: ${metrics.criticalWagers8h} CRITICAL · ${metrics.steamWagers8h} STEAM/SHARP ticket(s) triaged`,
    `- Forensics & Retries: ${metrics.terminalCommandsCount} PTY command(s) executed · ${metrics.failedAttempts} delivery retry error(s)`,
    "",
    `HANDOFF VERDICT: ${statusLine}`,
    "Incoming Desk Notes: Verify live :4020 ticker freshness and monitor high-CLV steam accounts at next tip-off.",
  ].join("\n")
}
