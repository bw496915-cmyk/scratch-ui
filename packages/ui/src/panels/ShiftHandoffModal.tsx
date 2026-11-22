import type React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ClipboardList,
  Copy,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Terminal,
  UserCheck,
  X,
} from "lucide-react"
import {
  BRAND_ASSETS,
  buildEightHourShiftReport,
  computeEightHourActivityMetrics,
  formatShiftSecondsClock,
  getOperatorInitials,
  OPERATOR_PROFILES,
  resolveOperatorProfile,
} from "../operator_profiles.ts"
import type {
  DashboardAlertRecord,
  LiveWager,
  ShiftSessionAction,
  ShiftSessionLogEntry,
  ShiftSummaryData,
} from "../types.ts"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

export type ShiftLogCategoryFilter = "all" | "auth" | "handoff" | "alerts"

function resolveShiftLogCategory(
  action: ShiftSessionAction,
): Exclude<ShiftLogCategoryFilter, "all"> {
  if (action === "login" || action === "logout" || action === "operator_switch") {
    return "auth"
  }
  if (
    action === "handoff_initiated" ||
    action === "handoff_synced" ||
    action === "handoff_report_copied"
  ) {
    return "handoff"
  }
  return "alerts"
}

function resolveActionColor(action: ShiftSessionAction): string {
  switch (action) {
    case "login":
      return "#4ade80"
    case "logout":
      return "#f87171"
    case "operator_switch":
      return "#38bdf8"
    case "handoff_initiated":
    case "handoff_synced":
    case "handoff_report_copied":
      return "#60a5fa"
    case "alert_ack":
      return "#c084fc"
    case "alert_retry":
      return "#fbbf24"
    case "alert_sweep":
      return "#2dd4bf"
    case "terminal_cmd":
      return "#94a3b8"
  }
}

function renderActionIcon(action: ShiftSessionAction): React.ReactElement {
  const color = resolveActionColor(action)
  switch (action) {
    case "login":
      return <LogIn size={13} style={{ color, flexShrink: 0 }} aria-hidden="true" />
    case "logout":
      return <LogOut size={13} style={{ color, flexShrink: 0 }} aria-hidden="true" />
    case "operator_switch":
      return <UserCheck size={13} style={{ color, flexShrink: 0 }} aria-hidden="true" />
    case "handoff_initiated":
    case "handoff_report_copied":
      return <ClipboardList size={13} style={{ color, flexShrink: 0 }} aria-hidden="true" />
    case "handoff_synced":
    case "alert_sweep":
      return <RefreshCw size={13} style={{ color, flexShrink: 0 }} aria-hidden="true" />
    case "alert_ack":
      return <CheckCircle2 size={13} style={{ color, flexShrink: 0 }} aria-hidden="true" />
    case "alert_retry":
      return <RotateCcw size={13} style={{ color, flexShrink: 0 }} aria-hidden="true" />
    case "terminal_cmd":
      return <Terminal size={13} style={{ color, flexShrink: 0 }} aria-hidden="true" />
  }
}

function formatLogUtcClock(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "--:--:--Z"
  return `${new Date(ms).toISOString().slice(11, 19)}Z`
}

function formatShiftOffsetLabel(
  iso: string,
  shiftStartedAtMs: number | null | undefined,
): string | null {
  if (typeof shiftStartedAtMs !== "number" || !Number.isFinite(shiftStartedAtMs)) {
    return null
  }
  const eventMs = Date.parse(iso)
  if (!Number.isFinite(eventMs)) return null
  const deltaSec = Math.max(0, Math.floor((eventMs - shiftStartedAtMs) / 1000))
  const hours = Math.floor(deltaSec / 3600)
  const mins = Math.floor((deltaSec % 3600) / 60)
  return `+${String(hours).padStart(2, "0")}h${String(mins).padStart(2, "0")}m`
}

export interface ShiftHandoffModalProps {
  readonly shiftOperator: string
  readonly onShiftOperatorChange: (operatorId: string) => void
  readonly shiftLoading: boolean
  readonly onRefresh: (operatorId: string) => void
  readonly shiftSummary: ShiftSummaryData | null
  readonly shiftLogs?: readonly ShiftSessionLogEntry[] | undefined
  readonly shiftLogsLoading?: boolean | undefined
  readonly shiftLogsError?: string | null | undefined
  readonly shiftStartedAtMs?: number | null | undefined
  readonly onRefreshShiftLogs?: (() => void) | undefined
  readonly onCopyReportLogged?: (() => void) | undefined
  readonly onOperatorSwitched?:
    ((nextOperatorId: string, previousOperatorId: string) => void) | undefined
  readonly alerts?: readonly DashboardAlertRecord[] | undefined
  readonly wagers?: readonly LiveWager[] | undefined
  readonly activeShiftSeconds?: number | undefined
  readonly onClose: () => void
}

interface OperatorAvatarProps {
  readonly src: string
  readonly alt: string
  readonly initials: string
  readonly accentColor: string
  readonly size: number
  readonly active?: boolean
}

function OperatorAvatarBadge({
  src,
  alt,
  initials,
  accentColor,
  size,
  active = false,
}: OperatorAvatarProps): React.ReactElement {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "50%",
        overflow: "hidden",
        flexShrink: 0,
        backgroundColor: "#0f172a",
        borderWidth: active ? "2px" : "1px",
        borderStyle: "solid",
        borderColor: active ? accentColor : "rgba(148, 163, 184, 0.35)",
        color: accentColor,
        fontFamily: MONO_FONT,
        fontSize: `${Math.max(10, Math.round(size * 0.34))}px`,
        fontWeight: 700,
      }}
    >
      {failed ? (
        <span>{initials}</span>
      ) : (
        <img
          src={src}
          alt={alt}
          width={size}
          height={size}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: "block",
          }}
        />
      )}
    </span>
  )
}

export function ShiftHandoffModal({
  shiftOperator,
  onShiftOperatorChange,
  shiftLoading,
  onRefresh,
  shiftSummary,
  shiftLogs = [],
  shiftLogsLoading = false,
  shiftLogsError = null,
  shiftStartedAtMs = null,
  onRefreshShiftLogs,
  onCopyReportLogged,
  onOperatorSwitched,
  alerts,
  wagers,
  activeShiftSeconds = 0,
  onClose,
}: ShiftHandoffModalProps): React.ReactElement {
  const activeProfile = useMemo(() => resolveOperatorProfile(shiftOperator), [shiftOperator])
  const metrics = useMemo(
    () =>
      computeEightHourActivityMetrics({
        shiftSummary,
        alerts,
        wagers,
      }),
    [shiftSummary, alerts, wagers],
  )

  const generatedReport = useMemo(
    () =>
      buildEightHourShiftReport({
        operatorId: shiftOperator,
        metrics,
        activeShiftSeconds,
      }),
    [shiftOperator, metrics, activeShiftSeconds],
  )

  const [reportDraft, setReportDraft] = useState<string>(generatedReport)
  const [hasCustomEdits, setHasCustomEdits] = useState<boolean>(false)
  const [copiedReport, setCopiedReport] = useState<boolean>(false)
  const [logCategoryFilter, setLogCategoryFilter] = useState<ShiftLogCategoryFilter>("all")

  const filteredShiftLogs = useMemo(() => {
    if (logCategoryFilter === "all") return shiftLogs
    return shiftLogs.filter((entry) => resolveShiftLogCategory(entry.action) === logCategoryFilter)
  }, [shiftLogs, logCategoryFilter])

  // Keep pre-filled report synced with live 8-hour telemetry unless the operator manually edited it
  useEffect(() => {
    if (!hasCustomEdits) {
      setReportDraft(generatedReport)
    }
  }, [generatedReport, hasCustomEdits])

  const handleSelectOperator = (operatorId: string) => {
    const previous = shiftOperator
    onShiftOperatorChange(operatorId)
    setHasCustomEdits(false)
    if (operatorId.trim().toLowerCase() !== previous.trim().toLowerCase()) {
      onOperatorSwitched?.(operatorId, previous)
    }
    onRefresh(operatorId)
  }

  const handleCopyReport = async () => {
    try {
      await navigator.clipboard.writeText(reportDraft)
      setCopiedReport(true)
      onCopyReportLogged?.()
      setTimeout(() => setCopiedReport(false), 1800)
    } catch {
      setCopiedReport(false)
    }
  }

  const dlqPending = metrics.deadLetterAlerts8h
  const shiftClock = formatShiftSecondsClock(activeShiftSeconds)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Operator Shift Handoff Summary"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(3, 7, 18, 0.78)",
        backdropFilter: "blur(6px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        style={{
          width: "720px",
          maxWidth: "100%",
          maxHeight: "90vh",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#0d1527",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "#1e293b",
          borderRadius: "10px",
          boxShadow: "0 24px 54px -12px rgba(0, 0, 0, 0.65)",
          overflow: "hidden",
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: "14px 20px",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "#1e293b",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            backgroundColor: "#0a101d",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <img
              src={BRAND_ASSETS.emblemWebp}
              alt={BRAND_ASSETS.emblemAlt}
              width={32}
              height={32}
              decoding="async"
              referrerPolicy="no-referrer"
              style={{
                width: "32px",
                height: "32px",
                borderRadius: "6px",
                objectFit: "cover",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "rgba(56, 189, 248, 0.3)",
                flexShrink: 0,
              }}
            />
            <div>
              <h3
                style={{
                  margin: 0,
                  fontSize: "15px",
                  fontWeight: 700,
                  color: "#f8fafc",
                }}
              >
                Operator Shift Handoff Summary
              </h3>
              <div
                style={{
                  marginTop: "2px",
                  fontSize: "11.5px",
                  color: "#94a3b8",
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                Rolling 8h telemetry · {BRAND_ASSETS.version} · Shift{" "}
                <span style={{ color: "#38bdf8" }}>{shiftClock}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close shift handoff modal"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "30px",
              height: "30px",
              borderRadius: "6px",
              background: "transparent",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "transparent",
              color: "#94a3b8",
              cursor: "pointer",
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Modal Body */}
        <div
          style={{
            padding: "18px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            overflowY: "auto",
          }}
        >
          {/* Active Operator Profile + Roster Switcher */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              paddingBottom: "14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "#1e293b",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <OperatorAvatarBadge
                  src={activeProfile.avatarUrl}
                  alt={activeProfile.avatarAlt}
                  initials={getOperatorInitials(activeProfile.displayName)}
                  accentColor={activeProfile.accentColor}
                  size={48}
                  active
                />
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "14px",
                      fontWeight: 700,
                      color: "#f8fafc",
                    }}
                  >
                    <span>{activeProfile.displayName}</span>
                    <span
                      style={{
                        fontFamily: MONO_FONT,
                        fontSize: "11px",
                        fontWeight: 600,
                        color: activeProfile.accentColor,
                      }}
                    >
                      {activeProfile.deskCode}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: "2px",
                      fontSize: "12px",
                      color: "#94a3b8",
                    }}
                  >
                    {activeProfile.role} · {activeProfile.shiftBand}
                  </div>
                </div>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                <input
                  value={shiftOperator}
                  onChange={(e) => {
                    onShiftOperatorChange(e.target.value)
                    setHasCustomEdits(false)
                  }}
                  aria-label="Operator ID"
                  style={{
                    backgroundColor: "#070b14",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "#334155",
                    color: "#f1f5f9",
                    padding: "6px 9px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontFamily: MONO_FONT,
                    width: "146px",
                  }}
                  placeholder="operator_id"
                />
                <button
                  type="button"
                  onClick={() => onRefresh(shiftOperator)}
                  disabled={shiftLoading}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "6px 11px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    fontWeight: 600,
                    backgroundColor: "#0f172a",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "#334155",
                    color: "#e2e8f0",
                    cursor: shiftLoading ? "wait" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  <RefreshCw size={12} aria-hidden="true" />
                  <span>{shiftLoading ? "Syncing…" : "Sync"}</span>
                </button>
              </div>
            </div>

            {/* Desk Roster Quick-Select Avatars */}
            <div
              role="group"
              aria-label="Desk operator roster"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "8px",
              }}
            >
              {OPERATOR_PROFILES.map((op) => {
                const isSelected = op.id.toLowerCase() === shiftOperator.trim().toLowerCase()
                return (
                  <button
                    key={op.id}
                    type="button"
                    onClick={() => handleSelectOperator(op.id)}
                    title={`Switch to ${op.displayName} (${op.role})`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "7px",
                      padding: "4px 10px 4px 5px",
                      borderRadius: "6px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: isSelected ? op.accentColor : "#1e293b",
                      backgroundColor: isSelected ? "rgba(56, 189, 248, 0.1)" : "#0a101d",
                      color: isSelected ? "#f8fafc" : "#94a3b8",
                      fontSize: "11.5px",
                      fontWeight: isSelected ? 600 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <OperatorAvatarBadge
                      src={op.avatarUrl}
                      alt={op.avatarAlt}
                      initials={getOperatorInitials(op.displayName)}
                      accentColor={op.accentColor}
                      size={24}
                      active={isSelected}
                    />
                    <span>{op.displayName}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Rolling 8-Hour Activity Metrics Grid */}
          <div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
                marginBottom: "8px",
                fontSize: "11.5px",
                color: "#94a3b8",
              }}
            >
              <span style={{ fontWeight: 600, color: "#cbd5e1" }}>
                Last 8 Hours Activity Metrics
              </span>
              <span
                style={{
                  fontFamily: MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                  fontSize: "11px",
                }}
              >
                {metrics.windowStartIso.slice(11, 16)}Z → {metrics.windowEndIso.slice(11, 16)}Z ·
                JSONL Audit Verified
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                gap: "10px",
              }}
            >
              <div
                style={{
                  backgroundColor: "#0a101d",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "#1e293b",
                  borderRadius: "8px",
                  padding: "11px 12px",
                }}
              >
                <div style={{ fontSize: "11px", color: "#94a3b8" }}>Acknowledged Alerts (8h)</div>
                <div
                  style={{
                    marginTop: "4px",
                    fontSize: "20px",
                    fontWeight: 700,
                    fontFamily: MONO_FONT,
                    fontVariantNumeric: "tabular-nums",
                    color: "#c084fc",
                  }}
                >
                  {metrics.acknowledgedAlerts8h}
                </div>
                <div style={{ fontSize: "10.5px", color: "#64748b" }}>
                  of {metrics.totalAlerts8h} alerts in window
                </div>
              </div>

              <div
                style={{
                  backgroundColor: "#0a101d",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "#1e293b",
                  borderRadius: "8px",
                  padding: "11px 12px",
                }}
              >
                <div style={{ fontSize: "11px", color: "#94a3b8" }}>
                  Wager Tickets Processed (8h)
                </div>
                <div
                  style={{
                    marginTop: "4px",
                    fontSize: "20px",
                    fontWeight: 700,
                    fontFamily: MONO_FONT,
                    fontVariantNumeric: "tabular-nums",
                    color: "#38bdf8",
                  }}
                >
                  {metrics.wagerTicketsProcessed8h}
                </div>
                <div
                  style={{
                    fontSize: "10.5px",
                    color: "#64748b",
                    fontFamily: MONO_FONT,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  ${Math.round(metrics.wagerRiskUsd8h).toLocaleString()} handle
                </div>
              </div>

              <div
                style={{
                  backgroundColor: "#0a101d",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "#1e293b",
                  borderRadius: "8px",
                  padding: "11px 12px",
                }}
              >
                <div style={{ fontSize: "11px", color: "#94a3b8" }}>Dead-Letter DLQ Pending</div>
                <div
                  style={{
                    marginTop: "4px",
                    fontSize: "20px",
                    fontWeight: 700,
                    fontFamily: MONO_FONT,
                    fontVariantNumeric: "tabular-nums",
                    color: dlqPending > 0 ? "#f87171" : "#4ade80",
                  }}
                >
                  {dlqPending}
                </div>
                <div style={{ fontSize: "10.5px", color: "#64748b" }}>
                  {metrics.deliveredAlerts8h} delivered · {metrics.failedAttempts} retries
                </div>
              </div>
            </div>
          </div>

          {/* Session Logs Panel (Current Shift Action Feed) */}
          <section
            aria-label="Session Logs"
            data-shift-session-logs="true"
            style={{
              backgroundColor: "#0a101d",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#1e293b",
              borderRadius: "8px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                padding: "9px 12px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "#1e293b",
                backgroundColor: "#080d18",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                <ScrollText
                  size={14}
                  style={{ color: "#38bdf8", flexShrink: 0 }}
                  aria-hidden="true"
                />
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "#e2e8f0",
                  }}
                >
                  Session Logs
                </span>
                <span
                  style={{
                    fontSize: "11px",
                    color: "#64748b",
                    fontFamily: MONO_FONT,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {filteredShiftLogs.length}
                  {logCategoryFilter !== "all" ? `/${shiftLogs.length}` : ""}{" "}
                  {filteredShiftLogs.length === 1 ? "event" : "events"} · current shift
                </span>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  flexWrap: "wrap",
                }}
              >
                <div
                  role="group"
                  aria-label="Filter session logs by category"
                  style={{
                    display: "inline-flex",
                    borderRadius: "5px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "#1e293b",
                    overflow: "hidden",
                    backgroundColor: "#070b14",
                  }}
                >
                  {(
                    [
                      ["all", "All"],
                      ["auth", "Auth"],
                      ["handoff", "Handoff"],
                      ["alerts", "Alerts"],
                    ] as const
                  ).map(([value, label], idx) => {
                    const active = logCategoryFilter === value
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setLogCategoryFilter(value)}
                        style={{
                          padding: "3px 8px",
                          fontSize: "11px",
                          fontWeight: active ? 600 : 500,
                          border: "none",
                          borderLeftWidth: idx === 0 ? "0px" : "1px",
                          borderLeftStyle: "solid",
                          borderLeftColor: "#1e293b",
                          backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                          color: active ? "#38bdf8" : "#94a3b8",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>

                {onRefreshShiftLogs ? (
                  <button
                    type="button"
                    onClick={onRefreshShiftLogs}
                    disabled={shiftLogsLoading}
                    aria-label="Refresh session logs"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "3px 8px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "#334155",
                      backgroundColor: "#0f172a",
                      color: "#cbd5e1",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: shiftLogsLoading ? "wait" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <RefreshCw size={11} aria-hidden="true" />
                    <span>{shiftLogsLoading ? "Loading…" : "Refresh"}</span>
                  </button>
                ) : null}
              </div>
            </div>

            {shiftLogsError ? (
              <div
                role="alert"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                  padding: "10px 12px",
                  backgroundColor: "rgba(239, 68, 68, 0.08)",
                  color: "#fca5a5",
                  fontSize: "11.5px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
                  <AlertCircle size={14} aria-hidden="true" />
                  <span>{shiftLogsError}</span>
                </div>
                {onRefreshShiftLogs ? (
                  <button
                    type="button"
                    onClick={onRefreshShiftLogs}
                    style={{
                      padding: "3px 9px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "rgba(248, 113, 113, 0.45)",
                      backgroundColor: "rgba(239, 68, 68, 0.14)",
                      color: "#fecaca",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
            ) : shiftLogsLoading && shiftLogs.length === 0 ? (
              <div
                data-shift-logs-skeleton="true"
                aria-label="Loading session logs"
                style={{
                  padding: "10px 12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                {[0, 1, 2].map((rowIdx) => (
                  <div
                    key={rowIdx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                    }}
                  >
                    <div
                      style={{
                        width: "74px",
                        height: "12px",
                        borderRadius: "3px",
                        backgroundColor: "#1e293b",
                        flexShrink: 0,
                      }}
                    />
                    <div
                      style={{
                        width: "110px",
                        height: "12px",
                        borderRadius: "3px",
                        backgroundColor: "#1e293b",
                        flexShrink: 0,
                      }}
                    />
                    <div
                      style={{
                        flex: 1,
                        height: "12px",
                        borderRadius: "3px",
                        backgroundColor: "#162033",
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : filteredShiftLogs.length === 0 ? (
              <div
                data-shift-logs-empty="true"
                style={{
                  padding: "16px 12px",
                  textAlign: "center",
                  color: "#64748b",
                  fontSize: "11.5px",
                }}
              >
                {shiftLogs.length === 0 ? (
                  <span>No operator actions recorded during this shift window yet.</span>
                ) : (
                  <span>
                    No {logCategoryFilter} events in this shift.{" "}
                    <button
                      type="button"
                      onClick={() => setLogCategoryFilter("all")}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#38bdf8",
                        cursor: "pointer",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        padding: 0,
                        textDecoration: "underline",
                      }}
                    >
                      Show all ({shiftLogs.length})
                    </button>
                  </span>
                )}
              </div>
            ) : (
              <ol
                data-shift-logs-feed="true"
                style={{
                  listStyle: "none",
                  margin: 0,
                  padding: 0,
                  maxHeight: "196px",
                  overflowY: "auto",
                }}
              >
                {filteredShiftLogs.map((entry, idx) => {
                  const offset = formatShiftOffsetLabel(entry.timestamp, shiftStartedAtMs)
                  return (
                    <li
                      key={entry.id}
                      data-shift-log-action={entry.action}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        padding: "8px 12px",
                        borderTopWidth: idx === 0 ? "0px" : "1px",
                        borderTopStyle: "solid",
                        borderTopColor: "rgba(30, 41, 59, 0.8)",
                      }}
                    >
                      <div
                        style={{
                          minWidth: "74px",
                          flexShrink: 0,
                          fontFamily: MONO_FONT,
                          fontVariantNumeric: "tabular-nums",
                          fontSize: "11px",
                          lineHeight: 1.35,
                          color: "#94a3b8",
                        }}
                      >
                        <div>{formatLogUtcClock(entry.timestamp)}</div>
                        {offset ? (
                          <div style={{ fontSize: "10px", color: "#64748b" }}>{offset}</div>
                        ) : null}
                      </div>

                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "center",
                            gap: "6px",
                            fontSize: "11.5px",
                            lineHeight: 1.35,
                          }}
                        >
                          {renderActionIcon(entry.action)}
                          <span
                            style={{
                              fontWeight: 600,
                              color: resolveActionColor(entry.action),
                            }}
                          >
                            {entry.label}
                          </span>
                          <span
                            style={{
                              color: "#64748b",
                              fontFamily: MONO_FONT,
                              fontSize: "10.5px",
                            }}
                          >
                            @{entry.operatorId}
                          </span>
                          {entry.targetId ? (
                            <span
                              style={{
                                color: "#94a3b8",
                                fontFamily: MONO_FONT,
                                fontSize: "10.5px",
                              }}
                            >
                              · #{entry.targetId.slice(0, 12)}
                            </span>
                          ) : null}
                        </div>

                        <div
                          style={{
                            marginTop: "2px",
                            fontSize: "11.5px",
                            color: "#cbd5e1",
                            lineHeight: 1.4,
                            wordBreak: "break-word",
                          }}
                        >
                          {entry.summary}
                        </div>

                        {entry.detail ? (
                          <div
                            style={{
                              marginTop: "2px",
                              fontSize: "10.5px",
                              color: "#64748b",
                              fontFamily: MONO_FONT,
                              wordBreak: "break-word",
                            }}
                          >
                            {entry.detail}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ol>
            )}
          </section>

          {/* Pre-Filled Editable 8-Hour Handoff Summary Report */}
          <div>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "8px",
                marginBottom: "6px",
              }}
            >
              <label
                htmlFor="shift-handoff-report-textarea"
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#e2e8f0",
                }}
              >
                Pre-Filled 8-Hour Shift Handoff Report
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                {hasCustomEdits ? (
                  <button
                    type="button"
                    onClick={() => {
                      setHasCustomEdits(false)
                      setReportDraft(generatedReport)
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "4px",
                      padding: "4px 8px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "#334155",
                      backgroundColor: "#0a101d",
                      color: "#cbd5e1",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <RotateCcw size={11} aria-hidden="true" />
                    <span>Regenerate from 8h Telemetry</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleCopyReport()}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                    padding: "4px 9px",
                    borderRadius: "5px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: copiedReport ? "#4ade80" : "#38bdf8",
                    backgroundColor: copiedReport
                      ? "rgba(74, 222, 128, 0.14)"
                      : "rgba(56, 189, 248, 0.14)",
                    color: copiedReport ? "#4ade80" : "#38bdf8",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {copiedReport ? (
                    <Check size={12} aria-hidden="true" />
                  ) : (
                    <Copy size={12} aria-hidden="true" />
                  )}
                  <span>{copiedReport ? "Copied Report" : "Copy Report"}</span>
                </button>
              </div>
            </div>

            <textarea
              id="shift-handoff-report-textarea"
              data-shift-handoff-report="true"
              value={reportDraft}
              onChange={(e) => {
                setReportDraft(e.target.value)
                setHasCustomEdits(true)
              }}
              rows={9}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 12px",
                borderRadius: "8px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
                backgroundColor: "#070b14",
                color: "#e2e8f0",
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
                fontSize: "11.5px",
                lineHeight: 1.55,
                resize: "vertical",
              }}
            />
          </div>

          {/* Handoff Readiness Status */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "6px",
              backgroundColor: dlqPending > 0 ? "rgba(239, 68, 68, 0.1)" : "rgba(34, 197, 94, 0.1)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: dlqPending > 0 ? "rgba(239, 68, 68, 0.45)" : "rgba(34, 197, 94, 0.45)",
              fontSize: "12px",
              color: dlqPending > 0 ? "#fca5a5" : "#86efac",
            }}
          >
            {dlqPending > 0
              ? `Handoff Warning: ${dlqPending} dead-letter alert(s) require operator acknowledgment or replay before closing this 8h shift.`
              : `Shift Handoff Ready: Zero unresolved DLQ alerts. ${metrics.acknowledgedAlerts8h} alert(s) acknowledged and ${metrics.wagerTicketsProcessed8h} wager ticket(s) processed over the last 8 hours.`}
          </div>
        </div>

        {/* Modal Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTopWidth: "1px",
            borderTopStyle: "solid",
            borderTopColor: "#1e293b",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            backgroundColor: "#0a101d",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: "11px",
              color: "#64748b",
              fontFamily: MONO_FONT,
            }}
          >
            {metrics.criticalWagers8h} critical · {metrics.steamWagers8h} steam/sharp ·{" "}
            {metrics.terminalCommandsCount} PTY cmds
          </span>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "7px 16px",
              borderRadius: "6px",
              fontSize: "12px",
              fontWeight: 600,
              backgroundColor: "#1e293b",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              color: "#f1f5f9",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
