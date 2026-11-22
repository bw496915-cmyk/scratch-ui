import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  SHIFT_HANDOFF_DUE_SECONDS,
  SHIFT_HANDOFF_WARN_SECONDS,
  ShiftDurationTimer,
  ShiftHandoffReminderToast,
  computeShiftDurationSeconds,
  resolveShiftDurationTone,
  shouldTriggerShiftHandoffAlert,
} from "../../packages/ui/src/panels/ShiftDurationTimer.tsx"

describe("Header Shift Duration Timer & 8-Hour Handoff Alert", () => {
  test("computeShiftDurationSeconds derives elapsed seconds from operatorSignedInAt safely", () => {
    const base = 1_795_100_000_000
    expect(computeShiftDurationSeconds(null, base)).toBe(0)
    expect(computeShiftDurationSeconds(base - 3_665_000, base)).toBe(3665)
    expect(computeShiftDurationSeconds(base - 3_665_000, base, true)).toBe(0)
    // Clamps future timestamps to 0
    expect(computeShiftDurationSeconds(base + 15_000, base)).toBe(0)
  })

  test("resolveShiftDurationTone transitions cleanly at 7.5h warning and 8h handoff thresholds", () => {
    expect(resolveShiftDurationTone(120).statusLabel).toBe("Active Shift")
    expect(resolveShiftDurationTone(SHIFT_HANDOFF_WARN_SECONDS).statusLabel).toBe(
      "Approaching 8h Handoff",
    )
    expect(resolveShiftDurationTone(SHIFT_HANDOFF_DUE_SECONDS).statusLabel).toBe(
      "Handoff Due (8h+)",
    )
  })

  test("shouldTriggerShiftHandoffAlert fires only when >= 8h and handoff has not been initiated or dismissed", () => {
    const signedInAt = 1_795_000_000_000
    expect(
      shouldTriggerShiftHandoffAlert({
        operatorSignedInAt: signedInAt,
        elapsedSeconds: SHIFT_HANDOFF_DUE_SECONDS - 1,
      }),
    ).toBe(false)
    expect(
      shouldTriggerShiftHandoffAlert({
        operatorSignedInAt: signedInAt,
        elapsedSeconds: SHIFT_HANDOFF_DUE_SECONDS,
      }),
    ).toBe(true)
    expect(
      shouldTriggerShiftHandoffAlert({
        operatorSignedInAt: signedInAt,
        elapsedSeconds: SHIFT_HANDOFF_DUE_SECONDS + 120,
        handoffInitiated: true,
      }),
    ).toBe(false)
    expect(
      shouldTriggerShiftHandoffAlert({
        operatorSignedInAt: signedInAt,
        elapsedSeconds: SHIFT_HANDOFF_DUE_SECONDS + 120,
        dismissed: true,
      }),
    ).toBe(false)
    expect(
      shouldTriggerShiftHandoffAlert({
        operatorSignedInAt: signedInAt,
        elapsedSeconds: SHIFT_HANDOFF_DUE_SECONDS + 120,
        isShiftModalOpen: true,
      }),
    ).toBe(false)
    expect(
      shouldTriggerShiftHandoffAlert({
        operatorSignedInAt: signedInAt,
        elapsedSeconds: SHIFT_HANDOFF_DUE_SECONDS + 120,
        signedOut: true,
      }),
    ).toBe(false)
    expect(
      shouldTriggerShiftHandoffAlert({
        operatorSignedInAt: null,
        elapsedSeconds: SHIFT_HANDOFF_DUE_SECONDS + 120,
      }),
    ).toBe(false)
  })

  test("ShiftDurationTimer renders readable HH:MM:SS clock based on operatorSignedInAt and due dot only when handoff pending", () => {
    const now = 1_795_100_000_000
    // 2 hours, 14 minutes, 9 seconds ago
    const signedInAt = now - (2 * 3600 + 14 * 60 + 9) * 1000
    const html = renderToStaticMarkup(
      React.createElement(ShiftDurationTimer, {
        operatorSignedInAt: signedInAt,
        nowMs: now,
      }),
    )

    expect(html).toContain('data-shift-duration-timer="true"')
    expect(html).toContain("Shift Duration")
    expect(html).toContain("02:14:09")
    expect(html).toContain('dateTime="PT8049S"')
    expect(html).toContain('aria-label="Shift Duration 02:14:09"')
    expect(html).not.toContain('data-shift-handoff-due-dot="true"')

    // Crossed 8h mark without handoff initiated -> shows subtle due dot
    const eightHoursAgo = now - (8 * 3600 + 42) * 1000
    const dueHtml = renderToStaticMarkup(
      React.createElement(ShiftDurationTimer, {
        operatorSignedInAt: eightHoursAgo,
        nowMs: now,
        handoffInitiated: false,
      }),
    )
    expect(dueHtml).toContain("08:00:42")
    expect(dueHtml).toContain('data-shift-handoff-due-dot="true"')

    // Once handoff initiated -> dot clears
    const initiatedHtml = renderToStaticMarkup(
      React.createElement(ShiftDurationTimer, {
        operatorSignedInAt: eightHoursAgo,
        nowMs: now,
        handoffInitiated: true,
      }),
    )
    expect(initiatedHtml).toContain("08:00:42")
    expect(initiatedHtml).not.toContain('data-shift-handoff-due-dot="true"')
  })

  test("ShiftDurationTimer renders 00:00:00 when signed out or operatorSignedInAt is null", () => {
    const html = renderToStaticMarkup(
      React.createElement(ShiftDurationTimer, {
        operatorSignedInAt: null,
        nowMs: 1_795_100_000_000,
      }),
    )
    expect(html).toContain("00:00:00")
    expect(html).toContain('aria-label="Shift Duration 00:00:00"')
  })

  test("ShiftHandoffReminderToast renders subtle non-blocking prompt with clock and initiate action", () => {
    const html = renderToStaticMarkup(
      React.createElement(ShiftHandoffReminderToast, {
        elapsedSeconds: 8 * 3600 + 125,
        operatorId: "dev-admin",
        onInitiateHandoff: () => {},
        onDismiss: () => {},
      }),
    )
    expect(html).toContain('data-shift-handoff-alert="true"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain("8-Hour Shift Milestone")
    expect(html).toContain("08:02:05")
    expect(html).toContain("dev-admin")
    expect(html).toContain("Initiate Shift Handoff")
    expect(html).toContain("Later")
  })
})
