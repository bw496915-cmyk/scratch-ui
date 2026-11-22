import type React from "react"
import { useEffect, useRef, useState } from "react"
import { ClipboardList, Clock, X } from "lucide-react"
import { formatShiftSecondsClock } from "../operator_profiles.ts"

const SHIFT_DURATION_MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

export const SHIFT_HANDOFF_WARN_SECONDS = 7.5 * 3600
export const SHIFT_HANDOFF_DUE_SECONDS = 8 * 3600

export function computeShiftDurationSeconds(
  operatorSignedInAt: number | null,
  nowMs: number = Date.now(),
  signedOut = false,
): number {
  if (
    signedOut ||
    operatorSignedInAt === null ||
    !Number.isFinite(operatorSignedInAt) ||
    operatorSignedInAt <= 0
  ) {
    return 0
  }
  return Math.max(0, Math.floor((nowMs - operatorSignedInAt) / 1000))
}

export interface ShiftHandoffAlertCheckInput {
  readonly operatorSignedInAt: number | null
  readonly elapsedSeconds: number
  readonly signedOut?: boolean | undefined
  readonly handoffInitiated?: boolean | undefined
  readonly dismissed?: boolean | undefined
  readonly isShiftModalOpen?: boolean | undefined
}

export function shouldTriggerShiftHandoffAlert(input: ShiftHandoffAlertCheckInput): boolean {
  if (
    input.signedOut ||
    input.operatorSignedInAt === null ||
    !Number.isFinite(input.operatorSignedInAt) ||
    input.operatorSignedInAt <= 0
  ) {
    return false
  }
  if (input.handoffInitiated || input.dismissed || input.isShiftModalOpen) {
    return false
  }
  return input.elapsedSeconds >= SHIFT_HANDOFF_DUE_SECONDS
}

export function resolveShiftDurationTone(elapsedSeconds: number): {
  readonly accent: string
  readonly bg: string
  readonly border: string
  readonly statusLabel: string
} {
  if (elapsedSeconds >= SHIFT_HANDOFF_DUE_SECONDS) {
    return {
      accent: "#fca5a5",
      bg: "rgba(239, 68, 68, 0.14)",
      border: "rgba(239, 68, 68, 0.42)",
      statusLabel: "Handoff Due (8h+)",
    }
  }
  if (elapsedSeconds >= SHIFT_HANDOFF_WARN_SECONDS) {
    return {
      accent: "#fcd34d",
      bg: "rgba(245, 158, 11, 0.14)",
      border: "rgba(245, 158, 11, 0.42)",
      statusLabel: "Approaching 8h Handoff",
    }
  }
  return {
    accent: "#7dd3fc",
    bg: "#0f172a",
    border: "#334155",
    statusLabel: "Active Shift",
  }
}

export interface ShiftDurationTimerProps {
  readonly operatorSignedInAt: number | null
  readonly signedOut?: boolean | undefined
  readonly handoffInitiated?: boolean | undefined
  readonly nowMs?: number | undefined
  readonly onClick?: (() => void) | undefined
  readonly onEightHourCrossed?: ((elapsedSeconds: number) => void) | undefined
}

export function ShiftDurationTimer({
  operatorSignedInAt,
  signedOut = false,
  handoffInitiated = false,
  nowMs,
  onClick,
  onEightHourCrossed,
}: ShiftDurationTimerProps): React.ReactElement {
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(() =>
    computeShiftDurationSeconds(operatorSignedInAt, nowMs, signedOut),
  )
  const notifiedShiftAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (nowMs !== undefined) {
      setElapsedSeconds(computeShiftDurationSeconds(operatorSignedInAt, nowMs, signedOut))
      return
    }
    if (operatorSignedInAt === null || signedOut) {
      setElapsedSeconds(0)
      return
    }
    const sync = () => {
      setElapsedSeconds(computeShiftDurationSeconds(operatorSignedInAt, Date.now(), false))
    }
    sync()
    const timerId = setInterval(sync, 1000)
    return () => clearInterval(timerId)
  }, [operatorSignedInAt, signedOut, nowMs])

  useEffect(() => {
    if (!onEightHourCrossed || signedOut || handoffInitiated || operatorSignedInAt === null) {
      return
    }
    if (
      elapsedSeconds >= SHIFT_HANDOFF_DUE_SECONDS &&
      notifiedShiftAtRef.current !== operatorSignedInAt
    ) {
      notifiedShiftAtRef.current = operatorSignedInAt
      onEightHourCrossed(elapsedSeconds)
    }
  }, [elapsedSeconds, operatorSignedInAt, signedOut, handoffInitiated, onEightHourCrossed])

  const formattedClock = formatShiftSecondsClock(elapsedSeconds)
  const tone = resolveShiftDurationTone(elapsedSeconds)
  const handoffPending =
    !signedOut && !handoffInitiated && elapsedSeconds >= SHIFT_HANDOFF_DUE_SECONDS
  const signedInClock =
    operatorSignedInAt !== null && Number.isFinite(operatorSignedInAt)
      ? new Date(operatorSignedInAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "Not signed in"
  const tooltip = `Shift Duration: ${formattedClock} · ${tone.statusLabel}${handoffPending ? " · Shift handoff not yet initiated" : ""} · Signed in at ${signedInClock}`

  const sharedStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 9px",
    borderRadius: "6px",
    fontSize: "11px",
    fontWeight: 600,
    background: tone.bg,
    color: "#e2e8f0",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: tone.border,
    whiteSpace: "nowrap",
    cursor: onClick ? "pointer" : "default",
  }

  const content = (
    <>
      {handoffPending && (
        <span
          className="sd-shift-handoff-dot"
          data-shift-handoff-due-dot="true"
          aria-hidden="true"
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: "#fb7185",
            flexShrink: 0,
          }}
        />
      )}
      <Clock size={12} style={{ color: tone.accent, flexShrink: 0 }} aria-hidden="true" />
      <span
        style={{
          color: "#94a3b8",
          fontSize: "10.5px",
          fontWeight: 600,
        }}
      >
        Shift Duration
      </span>
      <time
        dateTime={`PT${elapsedSeconds}S`}
        data-shift-duration-clock="true"
        style={{
          color: tone.accent,
          fontFamily: SHIFT_DURATION_MONO_FONT,
          fontVariantNumeric: "tabular-nums",
          fontWeight: 700,
          letterSpacing: "0.02em",
        }}
      >
        {formattedClock}
      </time>
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        data-shift-duration-timer="true"
        onClick={onClick}
        style={sharedStyle}
        title={`${tooltip} · Click to open Shift Handoff`}
        aria-label={`Shift Duration ${formattedClock}`}
      >
        {content}
      </button>
    )
  }

  return (
    <span
      data-shift-duration-timer="true"
      role="timer"
      style={sharedStyle}
      title={tooltip}
      aria-label={`Shift Duration ${formattedClock}`}
    >
      {content}
    </span>
  )
}

export interface ShiftHandoffReminderToastProps {
  readonly elapsedSeconds: number
  readonly operatorId: string
  readonly onInitiateHandoff: () => void
  readonly onDismiss: () => void
}

export function ShiftHandoffReminderToast({
  elapsedSeconds,
  operatorId,
  onInitiateHandoff,
  onDismiss,
}: ShiftHandoffReminderToastProps): React.ReactElement {
  const formattedClock = formatShiftSecondsClock(elapsedSeconds)

  return (
    <aside
      role="status"
      aria-live="polite"
      aria-label={`8-hour shift handoff reminder (${formattedClock})`}
      data-shift-handoff-alert="true"
      className="sd-shift-handoff-alert"
      style={{
        position: "fixed",
        right: "18px",
        bottom: "18px",
        zIndex: 1400,
        width: "min(352px, calc(100vw - 36px))",
        backgroundColor: "rgba(13, 21, 39, 0.96)",
        backdropFilter: "blur(8px)",
        borderTopWidth: "1px",
        borderRightWidth: "1px",
        borderBottomWidth: "1px",
        borderLeftWidth: "3px",
        borderTopStyle: "solid",
        borderRightStyle: "solid",
        borderBottomStyle: "solid",
        borderLeftStyle: "solid",
        borderTopColor: "rgba(51, 65, 85, 0.9)",
        borderRightColor: "rgba(51, 65, 85, 0.9)",
        borderBottomColor: "rgba(51, 65, 85, 0.9)",
        borderLeftColor: "#f59e0b",
        borderRadius: "8px",
        boxShadow: "0 12px 30px rgba(2, 6, 23, 0.65)",
        padding: "11px 13px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            minWidth: 0,
          }}
        >
          <span
            className="sd-shift-handoff-dot"
            aria-hidden="true"
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor: "#f59e0b",
              flexShrink: 0,
            }}
          />
          <Clock size={13} style={{ color: "#fcd34d", flexShrink: 0 }} aria-hidden="true" />
          <span
            style={{
              fontSize: "11.5px",
              fontWeight: 700,
              color: "#f8fafc",
              letterSpacing: "0.01em",
            }}
          >
            8-Hour Shift Milestone
          </span>
          <span
            data-shift-handoff-alert-clock="true"
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "#fcd34d",
              fontFamily: SHIFT_DURATION_MONO_FONT,
              fontVariantNumeric: "tabular-nums",
              padding: "1px 5px",
              borderRadius: "4px",
              backgroundColor: "rgba(245, 158, 11, 0.14)",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "rgba(245, 158, 11, 0.35)",
            }}
          >
            {formattedClock}
          </span>
        </div>

        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss shift handoff reminder"
          title="Dismiss reminder"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: "22px",
            height: "22px",
            borderRadius: "4px",
            background: "transparent",
            borderWidth: "0px",
            color: "#94a3b8",
            cursor: "pointer",
            padding: 0,
            flexShrink: 0,
          }}
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <p
        style={{
          margin: 0,
          fontSize: "11.5px",
          lineHeight: 1.45,
          color: "#cbd5e1",
        }}
      >
        Active shift for <strong style={{ color: "#f8fafc", fontWeight: 600 }}>{operatorId}</strong>{" "}
        has reached 8 hours. Initiate a shift handoff when ready to transfer open desk notes.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: "8px",
        }}
      >
        <button
          type="button"
          data-shift-handoff-dismiss="true"
          onClick={onDismiss}
          style={{
            padding: "4px 9px",
            borderRadius: "5px",
            fontSize: "11px",
            fontWeight: 600,
            backgroundColor: "transparent",
            color: "#94a3b8",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#334155",
            cursor: "pointer",
          }}
        >
          Later
        </button>
        <button
          type="button"
          data-shift-handoff-initiate="true"
          onClick={onInitiateHandoff}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "4px 10px",
            borderRadius: "5px",
            fontSize: "11px",
            fontWeight: 600,
            backgroundColor: "rgba(245, 158, 11, 0.18)",
            color: "#fde68a",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "rgba(245, 158, 11, 0.45)",
            cursor: "pointer",
          }}
        >
          <ClipboardList size={12} aria-hidden="true" />
          Initiate Shift Handoff
        </button>
      </div>
    </aside>
  )
}
