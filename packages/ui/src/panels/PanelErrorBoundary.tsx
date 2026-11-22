import React from "react"
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Home,
  RefreshCw,
  RotateCcw,
} from "lucide-react"
import { copyText } from "../clipboard.ts"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

const PANEL_LABELS: Readonly<Record<string, string>> = {
  wagers: "Live Wagers",
  customers: "Customer Profiles",
  shadow: "Shadow Pricing",
  surveillance: "Surveillance & DNS",
  terminal: "Operator Terminal",
  rankings: "Rankings",
  alerts: "Alert Deliveries",
  "bet-ticker": "Bet Ticker",
  r2: "R2 Pipeline",
  assets: "Bun Assets",
  "risk-overview": "Risk Overview",
  "churn-simulation": "Churn Simulation",
  "system-logs": "System Logs",
}

export function resolvePanelLabel(panelKey?: string | null): string {
  const normalized = panelKey?.trim() ?? ""
  if (normalized === "") return "Dashboard Panel"
  return PANEL_LABELS[normalized] ?? normalized
}

export function haveResetKeysChanged(
  prevKeys: readonly unknown[] | undefined,
  nextKeys: readonly unknown[] | undefined,
): boolean {
  if (prevKeys === nextKeys) return false
  if (!prevKeys || !nextKeys) return Boolean(prevKeys?.length || nextKeys?.length)
  if (prevKeys.length !== nextKeys.length) return true
  for (let i = 0; i < prevKeys.length; i += 1) {
    if (!Object.is(prevKeys[i], nextKeys[i])) return true
  }
  return false
}

export interface PanelErrorDiagnosticSummary {
  readonly name: string
  readonly message: string
  readonly stack: string | null
  readonly componentStack: string | null
  readonly diagnosticText: string
}

export function formatPanelErrorDiagnostic(
  error: unknown,
  options: {
    readonly panelKey?: string | undefined
    readonly panelLabel?: string | undefined
    readonly componentStack?: string | null | undefined
    readonly caughtAtIso?: string | null | undefined
  } = {},
): PanelErrorDiagnosticSummary {
  const errObj = error instanceof Error ? error : null
  const name = errObj?.name?.trim() || "RuntimeError"
  const rawMessage = errObj
    ? errObj.message
    : typeof error === "string"
      ? error
      : error !== null && error !== undefined
        ? String(error)
        : "Unknown panel exception"
  const message =
    rawMessage.trim() || "An unexpected exception occurred while rendering this panel."
  const stack = errObj?.stack?.trim() || null
  const componentStack = options.componentStack?.trim() || null
  const label = options.panelLabel?.trim() || resolvePanelLabel(options.panelKey)
  const lines: string[] = [
    `Panel: ${label}${options.panelKey ? ` (${options.panelKey})` : ""}`,
    `Error: ${name}: ${message}`,
  ]
  if (options.caughtAtIso) {
    lines.push(`Captured: ${options.caughtAtIso}`)
  }
  if (stack) {
    lines.push("", "Stack trace:", stack)
  }
  if (componentStack) {
    lines.push("", "React component tree:", componentStack)
  }
  return {
    name,
    message,
    stack,
    componentStack,
    diagnosticText: lines.join("\n"),
  }
}

export interface PanelErrorFallbackContext {
  readonly error: Error
  readonly panelKey?: string | undefined
  readonly panelLabel: string
  readonly componentStack: string | null
  readonly caughtAtIso: string | null
  readonly retryCount: number
  readonly resetErrorBoundary: () => void
}

export interface PanelErrorBoundaryProps {
  readonly children: React.ReactNode
  readonly panelKey?: string | undefined
  readonly panelLabel?: string | undefined
  readonly resetKeys?: readonly unknown[] | undefined
  readonly onError?: (error: Error, info: React.ErrorInfo, panelKey?: string) => void
  readonly onReset?: (panelKey?: string) => void
  readonly onReturnSafeTab?: (() => void) | undefined
  readonly safeTabLabel?: string | undefined
  readonly fallbackRender?: (context: PanelErrorFallbackContext) => React.ReactNode
}

interface PanelErrorBoundaryState {
  readonly hasError: boolean
  readonly error: Error | null
  readonly componentStack: string | null
  readonly caughtAtIso: string | null
  readonly retryCount: number
  readonly showDetails: boolean
  readonly copiedDiagnostics: boolean
}

const INITIAL_ERROR_STATE: Omit<PanelErrorBoundaryState, "retryCount"> = {
  hasError: false,
  error: null,
  componentStack: null,
  caughtAtIso: null,
  showDetails: false,
  copiedDiagnostics: false,
}

export class PanelErrorBoundary extends React.Component<
  PanelErrorBoundaryProps,
  PanelErrorBoundaryState
> {
  private copyResetTimer: ReturnType<typeof setTimeout> | null = null

  constructor(props: PanelErrorBoundaryProps) {
    super(props)
    this.state = {
      ...INITIAL_ERROR_STATE,
      retryCount: 0,
    }
  }

  static getDerivedStateFromError(error: Error): Partial<PanelErrorBoundaryState> {
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    return {
      hasError: true,
      error: normalizedError,
      showDetails: false,
      copiedDiagnostics: false,
    }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error))
    this.setState({
      componentStack: info.componentStack?.trim() || null,
      caughtAtIso: new Date().toISOString(),
    })
    this.props.onError?.(normalizedError, info, this.props.panelKey)
  }

  override componentDidUpdate(prevProps: PanelErrorBoundaryProps): void {
    if (!this.state.hasError) return
    if (
      prevProps.panelKey !== this.props.panelKey ||
      haveResetKeysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.clearCopyTimer()
      this.setState({
        ...INITIAL_ERROR_STATE,
        retryCount: 0,
      })
    }
  }

  override componentWillUnmount(): void {
    this.clearCopyTimer()
  }

  private clearCopyTimer(): void {
    if (this.copyResetTimer !== null) {
      clearTimeout(this.copyResetTimer)
      this.copyResetTimer = null
    }
  }

  resetErrorBoundary = (): void => {
    this.clearCopyTimer()
    this.setState((prev) => ({
      ...INITIAL_ERROR_STATE,
      retryCount: prev.retryCount + 1,
    }))
    this.props.onReset?.(this.props.panelKey)
  }

  private handleCopyDiagnostics = (diagnosticText: string): void => {
    void copyText(diagnosticText).then((copied) => {
      if (!copied) return
      this.clearCopyTimer()
      this.setState({ copiedDiagnostics: true })
      this.copyResetTimer = setTimeout(() => {
        this.setState({ copiedDiagnostics: false })
      }, 2000)
    })
  }

  private handleReloadPage = (): void => {
    if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
      window.location.reload()
    }
  }

  override render(): React.ReactNode {
    const { hasError, error, componentStack, caughtAtIso, retryCount } = this.state
    if (!hasError || error === null) {
      return (
        <React.Fragment key={`${this.props.panelKey ?? "panel"}:${retryCount}`}>
          {this.props.children}
        </React.Fragment>
      )
    }

    const panelLabel = this.props.panelLabel?.trim() || resolvePanelLabel(this.props.panelKey)

    if (this.props.fallbackRender) {
      return this.props.fallbackRender({
        error,
        panelKey: this.props.panelKey,
        panelLabel,
        componentStack,
        caughtAtIso,
        retryCount,
        resetErrorBoundary: this.resetErrorBoundary,
      })
    }

    const diagnostic = formatPanelErrorDiagnostic(error, {
      panelKey: this.props.panelKey,
      panelLabel,
      componentStack,
      caughtAtIso,
    })
    const hasTechnicalDetails = Boolean(diagnostic.stack || diagnostic.componentStack)

    return (
      <div
        role="alert"
        aria-live="assertive"
        data-panel-error-boundary={this.props.panelKey ?? "main"}
        style={{
          backgroundColor: "#0d1527",
          backgroundImage:
            "linear-gradient(180deg, rgba(239, 68, 68, 0.065) 0%, rgba(13, 21, 39, 0.98) 140px)",
          border: "1px solid rgba(239, 68, 68, 0.36)",
          borderRadius: "10px",
          padding: "24px",
          boxShadow: "0 12px 32px rgba(2, 6, 23, 0.45), inset 0 1px 0 rgba(248, 113, 113, 0.12)",
          color: "#f1f5f9",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          minWidth: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: "12px", minWidth: 0 }}>
            <div
              style={{
                width: "36px",
                height: "36px",
                borderRadius: "8px",
                backgroundColor: "rgba(239, 68, 68, 0.14)",
                border: "1px solid rgba(239, 68, 68, 0.32)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#f87171",
                flexShrink: 0,
              }}
            >
              <AlertTriangle size={18} strokeWidth={2} />
            </div>
            <div style={{ minWidth: 0 }}>
              <h2
                style={{
                  margin: "0 0 4px 0",
                  fontSize: "17px",
                  fontWeight: 700,
                  color: "#f8fafc",
                }}
              >
                {panelLabel} encountered a rendering error
              </h2>
              <div
                style={{
                  fontSize: "12px",
                  color: "#94a3b8",
                  lineHeight: 1.5,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                Shell navigation remains active · Fault isolated to{" "}
                <span style={{ color: "#cbd5e1", fontWeight: 600 }}>{panelLabel}</span>
                {caughtAtIso ? ` · ${new Date(caughtAtIso).toLocaleTimeString()}` : ""}
                {retryCount > 0 ? ` · Retry #${retryCount}` : ""}
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <button
              type="button"
              onClick={this.resetErrorBoundary}
              data-error-boundary-retry="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                borderRadius: "6px",
                backgroundColor: "#38bdf8",
                color: "#0f172a",
                border: "none",
                fontSize: "12px",
                fontWeight: 700,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              <RefreshCw size={13} strokeWidth={2.25} />
              <span>Retry Panel</span>
            </button>

            {this.props.onReturnSafeTab && (
              <button
                type="button"
                onClick={this.props.onReturnSafeTab}
                data-error-boundary-safe-tab="true"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "8px 14px",
                  borderRadius: "6px",
                  backgroundColor: "#1e293b",
                  color: "#e2e8f0",
                  border: "1px solid #334155",
                  fontSize: "12px",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
              >
                <Home size={13} strokeWidth={2} />
                <span>{this.props.safeTabLabel ?? "Return to Live Wagers"}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => this.handleCopyDiagnostics(diagnostic.diagnosticText)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 12px",
                borderRadius: "6px",
                backgroundColor: "rgba(15, 23, 42, 0.72)",
                color: this.state.copiedDiagnostics ? "#4ade80" : "#cbd5e1",
                border: "1px solid #334155",
                fontSize: "12px",
                fontWeight: 600,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              {this.state.copiedDiagnostics ? (
                <Check size={13} strokeWidth={2.25} />
              ) : (
                <Copy size={13} strokeWidth={2} />
              )}
              <span>{this.state.copiedDiagnostics ? "Copied" : "Copy Diagnostics"}</span>
            </button>

            <button
              type="button"
              onClick={this.handleReloadPage}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 12px",
                borderRadius: "6px",
                backgroundColor: "transparent",
                color: "#94a3b8",
                border: "1px solid rgba(51, 65, 85, 0.8)",
                fontSize: "12px",
                fontWeight: 600,
                whiteSpace: "nowrap",
                cursor: "pointer",
              }}
            >
              <RotateCcw size={13} strokeWidth={2} />
              <span>Reload Page</span>
            </button>
          </div>
        </div>

        <div
          style={{
            backgroundColor: "#070b14",
            border: "1px solid #1e293b",
            borderRadius: "6px",
            padding: "12px 14px",
            fontFamily: MONO_FONT,
            fontSize: "12px",
            lineHeight: 1.55,
            color: "#fca5a5",
            wordBreak: "break-word",
          }}
        >
          <span style={{ color: "#f87171", fontWeight: 700 }}>{diagnostic.name}:</span>{" "}
          <span>{diagnostic.message}</span>
        </div>

        {hasTechnicalDetails && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <button
              type="button"
              aria-expanded={this.state.showDetails}
              onClick={() => this.setState((prev) => ({ showDetails: !prev.showDetails }))}
              style={{
                alignSelf: "flex-start",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "4px 0",
                background: "none",
                border: "none",
                color: "#94a3b8",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {this.state.showDetails ? (
                <ChevronDown size={14} strokeWidth={2} />
              ) : (
                <ChevronRight size={14} strokeWidth={2} />
              )}
              <span>
                {this.state.showDetails
                  ? "Hide Technical Stack Trace"
                  : "Show Technical Stack Trace"}
              </span>
            </button>

            {this.state.showDetails && (
              <pre
                style={{
                  margin: 0,
                  padding: "12px 14px",
                  backgroundColor: "#060913",
                  border: "1px solid #1e293b",
                  borderRadius: "6px",
                  fontFamily: MONO_FONT,
                  fontSize: "11px",
                  lineHeight: 1.5,
                  color: "#94a3b8",
                  maxHeight: "240px",
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {[
                  diagnostic.stack,
                  diagnostic.componentStack
                    ? `React Component Stack:\n${diagnostic.componentStack}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n\n")}
              </pre>
            )}
          </div>
        )}
      </div>
    )
  }
}

export const ErrorBoundary = PanelErrorBoundary
