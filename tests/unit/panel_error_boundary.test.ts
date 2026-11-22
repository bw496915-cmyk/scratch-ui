import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import {
  ErrorBoundary,
  formatPanelErrorDiagnostic,
  haveResetKeysChanged,
  PanelErrorBoundary,
  resolvePanelLabel,
} from "../../packages/ui/src/panels/PanelErrorBoundary.tsx"

describe("PanelErrorBoundary recovery & diagnostics", () => {
  test("resolvePanelLabel maps dashboard tab keys to operator labels", () => {
    expect(resolvePanelLabel("wagers")).toBe("Live Wagers")
    expect(resolvePanelLabel("customers")).toBe("Customer Profiles")
    expect(resolvePanelLabel("system-logs")).toBe("System Logs")
    expect(resolvePanelLabel("risk-overview")).toBe("Risk Overview")
    expect(resolvePanelLabel("churn-simulation")).toBe("Churn Simulation")
    expect(resolvePanelLabel("custom-panel")).toBe("custom-panel")
    expect(resolvePanelLabel("")).toBe("Dashboard Panel")
    expect(resolvePanelLabel(null)).toBe("Dashboard Panel")
  })

  test("haveResetKeysChanged detects tab or key transitions using Object.is", () => {
    expect(haveResetKeysChanged(undefined, undefined)).toBe(false)
    expect(haveResetKeysChanged(["wagers"], ["wagers"])).toBe(false)
    expect(haveResetKeysChanged([NaN], [NaN])).toBe(false)
    expect(haveResetKeysChanged(["wagers"], ["customers"])).toBe(true)
    expect(haveResetKeysChanged(["wagers"], ["wagers", 1])).toBe(true)
    expect(haveResetKeysChanged(undefined, ["wagers"])).toBe(true)
    expect(haveResetKeysChanged([], undefined)).toBe(false)
  })

  test("formatPanelErrorDiagnostic formats Error and non-Error payloads cleanly", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'handleUsd')")
    const diag = formatPanelErrorDiagnostic(err, {
      panelKey: "wagers",
      componentStack: "    at LiveWagersTabPanel\n    at PanelErrorBoundary",
      caughtAtIso: "2026-11-20T15:30:00.000Z",
    })

    expect(diag.name).toBe("TypeError")
    expect(diag.message).toBe("Cannot read properties of undefined (reading 'handleUsd')")
    expect(diag.diagnosticText).toContain("Panel: Live Wagers (wagers)")
    expect(diag.diagnosticText).toContain("Error: TypeError: Cannot read properties of undefined")
    expect(diag.diagnosticText).toContain("Captured: 2026-11-20T15:30:00.000Z")
    expect(diag.diagnosticText).toContain("React component tree:")

    const strDiag = formatPanelErrorDiagnostic("Hydration timeout", {
      panelKey: "r2",
    })
    expect(strDiag.name).toBe("RuntimeError")
    expect(strDiag.message).toBe("Hydration timeout")
    expect(strDiag.diagnosticText).toContain("Panel: R2 Pipeline (r2)")
  })

  test("getDerivedStateFromError, componentDidCatch, resetErrorBoundary, and tab reset transitions work", () => {
    expect(ErrorBoundary).toBe(PanelErrorBoundary)

    const onErrorCalls: Array<{ message: string; panelKey?: string | undefined }> = []
    const onResetCalls: Array<string | undefined> = []
    const boundary = new PanelErrorBoundary({
      children: React.createElement("div", null, "Healthy panel"),
      panelKey: "customers",
      resetKeys: ["customers"],
      onError: (err, _info, panelKey) => {
        onErrorCalls.push({ message: err.message, panelKey })
      },
      onReset: (panelKey) => {
        onResetCalls.push(panelKey)
      },
      onReturnSafeTab: () => {},
    })

    const boom = new Error("Malformed cohort payload")
    const derived = PanelErrorBoundary.getDerivedStateFromError(boom)
    expect(derived.hasError).toBe(true)
    expect(derived.error).toBe(boom)

    // Simulate React state update after getDerivedStateFromError + componentDidCatch
    const capturedStates: Array<Record<string, unknown>> = []
    boundary.setState = ((updater: unknown) => {
      const next =
        typeof updater === "function"
          ? (updater as (prev: typeof boundary.state) => Partial<typeof boundary.state>)(
              boundary.state,
            )
          : (updater as Partial<typeof boundary.state>)
      boundary.state = { ...boundary.state, ...next }
      capturedStates.push(boundary.state as unknown as Record<string, unknown>)
    }) as typeof boundary.setState

    boundary.state = { ...boundary.state, ...derived }
    boundary.componentDidCatch(boom, {
      componentStack: "\n    at CustomersTabPanel\n    at main",
    })

    expect(onErrorCalls).toHaveLength(1)
    expect(onErrorCalls[0]).toEqual({
      message: "Malformed cohort payload",
      panelKey: "customers",
    })
    expect(boundary.state.hasError).toBe(true)
    expect(boundary.state.componentStack).toBe("at CustomersTabPanel\n    at main")
    expect(typeof boundary.state.caughtAtIso).toBe("string")

    // Render recovery fallback markup and confirm operator recovery actions are present
    const fallbackHtml = renderToStaticMarkup(boundary.render() as React.ReactElement)
    expect(fallbackHtml).toContain('role="alert"')
    expect(fallbackHtml).toContain("Customer Profiles encountered a rendering error")
    expect(fallbackHtml).toContain("Malformed cohort payload")
    expect(fallbackHtml).toContain("Retry Panel")
    expect(fallbackHtml).toContain("Return to Live Wagers")
    expect(fallbackHtml).toContain("Copy Diagnostics")
    expect(fallbackHtml).toContain("Reload Page")

    // Manual retry clears error state and increments retryCount
    boundary.resetErrorBoundary()
    expect(boundary.state.hasError).toBe(false)
    expect(boundary.state.error).toBeNull()
    expect(boundary.state.retryCount).toBe(1)
    expect(onResetCalls).toEqual(["customers"])

    // Subsequent error followed by panelKey/resetKeys change auto-recovers
    boundary.state = {
      ...boundary.state,
      ...PanelErrorBoundary.getDerivedStateFromError(new Error("Transient NaN")),
    }
    expect(boundary.state.hasError).toBe(true)

    const prevProps = boundary.props
    ;(boundary as { props: typeof boundary.props }).props = {
      ...prevProps,
      panelKey: "wagers",
      resetKeys: ["wagers"],
    }
    boundary.componentDidUpdate(prevProps)
    expect(boundary.state.hasError).toBe(false)
    expect(boundary.state.error).toBeNull()
  })

  test("healthy children render cleanly without wrapping overhead", () => {
    const boundary = new PanelErrorBoundary({
      children: React.createElement("div", { id: "healthy-panel" }, "Live feed ok"),
      panelKey: "wagers",
    })
    const html = renderToStaticMarkup(boundary.render() as React.ReactElement)
    expect(html).toBe('<div id="healthy-panel">Live feed ok</div>')
  })
})
