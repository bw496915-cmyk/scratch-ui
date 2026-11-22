import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronDown, Copy, Download, LogIn, QrCode, RefreshCw } from "lucide-react"
import { copyText } from "../clipboard.ts"
import {
  buildFastSignInBookmarkUrl,
  buildFastSignInQrMatrix,
  extractFastSignInTokenFromInput,
  resolveFastSignInBookmarkUrl,
} from "../fast_signin.ts"

const TELEMETRY_MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

export interface FastSignInQrCodeProps {
  readonly url: string
  readonly sizePx?: number | undefined
  readonly label?: string | undefined
}

export function buildFastSignInQrSvgMarkup(url: string): string | null {
  const matrix = buildFastSignInQrMatrix(url)
  if (!matrix) return null
  const vb = `-4 -4 ${matrix.size + 8} ${matrix.size + 8}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" shape-rendering="crispEdges"><rect x="-4" y="-4" width="${matrix.size + 8}" height="${matrix.size + 8}" fill="#ffffff"/><path d="${matrix.pathData}" fill="#070b14"/></svg>`
}

export function FastSignInQrCode({
  url,
  sizePx = 148,
  label = "Fast Sign-In bookmark QR code",
}: FastSignInQrCodeProps): React.ReactElement | null {
  const matrix = useMemo(() => buildFastSignInQrMatrix(url), [url])
  if (!matrix) return null

  const viewBox = `-4 -4 ${matrix.size + 8} ${matrix.size + 8}`

  return (
    <div
      data-fast-signin-qr-frame="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "8px",
        borderRadius: "6px",
        backgroundColor: "#ffffff",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "#cbd5e1",
        flexShrink: 0,
      }}
    >
      <svg
        role="img"
        aria-label={label}
        data-fast-signin-qr-svg="true"
        viewBox={viewBox}
        width={sizePx}
        height={sizePx}
        shapeRendering="crispEdges"
        style={{ display: "block" }}
      >
        <rect x={-4} y={-4} width={matrix.size + 8} height={matrix.size + 8} fill="#ffffff" />
        <path d={matrix.pathData} fill="#070b14" />
      </svg>
    </div>
  )
}

export function downloadQrSvgFile(
  url: string,
  filename = "sportsdesk-fast-signin-qr.svg",
): boolean {
  const svg = buildFastSignInQrSvgMarkup(url)
  if (!svg || typeof document === "undefined") return false
  try {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
    const objectUrl = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = objectUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    return true
  } catch {
    return false
  }
}

export interface SignInModalQrMintResult {
  readonly ok: boolean
  readonly bookmarkUrl?: string | undefined
  readonly expiresAtIso?: string | undefined
  readonly role?: string | undefined
  readonly error?: string | undefined
}

export interface SignInModalQrGeneratorProps {
  readonly currentHref: string
  readonly initialBookmarkUrl?: string | null | undefined
  readonly devQuickLoginAvailable: boolean
  readonly authConfigured: boolean
  readonly authRequired: boolean
  readonly hasEnteredCredentialToken: boolean
  readonly onMintBookmarkUrl: (ttlMinutes: number) => Promise<SignInModalQrMintResult>
  readonly onRedeemFastToken: (fastToken: string) => Promise<boolean>
  readonly onBookmarkUrlChange?: ((nextUrl: string | null) => void) | undefined
}

const TTL_CHOICES: ReadonlyArray<{ readonly label: string; readonly minutes: number }> = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "8h", minutes: 480 },
  { label: "24h", minutes: 1440 },
]

export function SignInModalQrGenerator({
  currentHref,
  initialBookmarkUrl,
  devQuickLoginAvailable,
  authConfigured,
  authRequired,
  hasEnteredCredentialToken,
  onMintBookmarkUrl,
  onRedeemFastToken,
  onBookmarkUrlChange,
}: SignInModalQrGeneratorProps): React.ReactElement | null {
  const [expanded, setExpanded] = useState<boolean>(() =>
    Boolean(initialBookmarkUrl && initialBookmarkUrl.trim().length > 0),
  )
  const [rawInput, setRawInput] = useState<string>(() => initialBookmarkUrl?.trim() ?? "")
  const [ttlMinutes, setTtlMinutes] = useState<number>(60)
  const [busy, setBusy] = useState<boolean>(false)
  const [copied, setCopied] = useState<boolean>(false)
  const [metaText, setMetaText] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)
  const autoMintedOnExpandRef = useRef<boolean>(false)

  useEffect(() => {
    if (initialBookmarkUrl && initialBookmarkUrl.trim().length > 0) {
      setRawInput(initialBookmarkUrl.trim())
    }
  }, [initialBookmarkUrl])

  const resolvedBookmarkUrl = useMemo(
    () => resolveFastSignInBookmarkUrl(currentHref, rawInput),
    [currentHref, rawInput],
  )

  const extractedToken = useMemo(() => extractFastSignInTokenFromInput(rawInput), [rawInput])

  const runMint = async (targetTtlMinutes = ttlMinutes) => {
    if (busy) return
    setBusy(true)
    setErrorText(null)
    setCopied(false)
    try {
      const res = await onMintBookmarkUrl(targetTtlMinutes)
      if (!res.ok || !res.bookmarkUrl) {
        setErrorText(res.error || "Unable to generate a Fast Sign-In bookmark QR.")
        return
      }
      setRawInput(res.bookmarkUrl)
      onBookmarkUrlChange?.(res.bookmarkUrl)
      const expiryLabel = res.expiresAtIso
        ? new Date(res.expiresAtIso).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : null
      const roleLabel = res.role === "ADMIN" ? "Admin" : "Operator"
      setMetaText(
        expiryLabel ? `${roleLabel} · Expires ${expiryLabel}` : `${roleLabel} · Temporary bookmark`,
      )
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : "Unable to generate Fast Sign-In QR code.")
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (
      expanded &&
      devQuickLoginAvailable &&
      !resolvedBookmarkUrl &&
      !autoMintedOnExpandRef.current &&
      !busy
    ) {
      autoMintedOnExpandRef.current = true
      void runMint(ttlMinutes)
    }
  }, [expanded, devQuickLoginAvailable, resolvedBookmarkUrl])

  if (!authRequired) return null

  const canMintNow = devQuickLoginAvailable || hasEnteredCredentialToken

  return (
    <div
      data-signin-qr-generator="true"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        paddingTop: "10px",
        borderTopWidth: "1px",
        borderTopStyle: "solid",
        borderTopColor: "#1e293b",
      }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        data-signin-qr-toggle="true"
        onClick={() => setExpanded((prev) => !prev)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "8px",
          padding: "7px 10px",
          borderRadius: "6px",
          backgroundColor: expanded ? "#0f172a" : "#070b14",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: expanded ? "#38bdf8" : "#1e293b",
          color: expanded ? "#f8fafc" : "#cbd5e1",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
          <QrCode size={14} style={{ color: "#38bdf8", flexShrink: 0 }} />
          <span>QR Code Handoff</span>
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "11px",
            fontWeight: 500,
            color: "#94a3b8",
          }}
        >
          <span>{resolvedBookmarkUrl ? "Bookmark Ready" : "Mobile ↔ Desktop"}</span>
          <ChevronDown
            size={13}
            style={{
              transform: expanded ? "rotate(180deg)" : "none",
              transition: "transform 0.15s ease",
            }}
          />
        </span>
      </button>

      {expanded && (
        <div
          data-signin-qr-panel="true"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            padding: "12px",
            borderRadius: "6px",
            backgroundColor: "#0b1120",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#1e293b",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{
                fontSize: "11px",
                color: "#94a3b8",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {metaText ??
                (devQuickLoginAvailable
                  ? "Dev bookmark · Scan or paste URL"
                  : authConfigured
                    ? "Enter Desk Token or paste bookmark URL"
                    : "Paste an existing Fast Sign-In bookmark URL")}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              {TTL_CHOICES.map((opt) => {
                const selected = ttlMinutes === opt.minutes
                return (
                  <button
                    key={opt.minutes}
                    type="button"
                    onClick={() => {
                      setTtlMinutes(opt.minutes)
                      if (canMintNow && resolvedBookmarkUrl) {
                        void runMint(opt.minutes)
                      }
                    }}
                    style={{
                      padding: "3px 6px",
                      borderRadius: "4px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: selected ? "#38bdf8" : "#334155",
                      backgroundColor: selected ? "rgba(56, 189, 248, 0.16)" : "#070b14",
                      color: selected ? "#7dd3fc" : "#94a3b8",
                      fontSize: "10px",
                      fontFamily: TELEMETRY_MONO_FONT,
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>

          {resolvedBookmarkUrl ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                flexWrap: "wrap",
              }}
            >
              <FastSignInQrCode
                url={resolvedBookmarkUrl}
                sizePx={136}
                label="QR code encoding current Fast Sign-In bookmark URL"
              />
              <div
                style={{
                  flex: 1,
                  minWidth: "150px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                <div style={{ fontSize: "11.5px", color: "#cbd5e1", lineHeight: 1.45 }}>
                  Scan on mobile or copy the bookmark URL to sign in instantly without re-entering
                  credentials.
                </div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    data-signin-qr-copy="true"
                    onClick={async () => {
                      const ok = await copyText(resolvedBookmarkUrl)
                      if (ok) {
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1800)
                      }
                    }}
                    style={{
                      flex: 1,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "5px",
                      padding: "6px 10px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "#334155",
                      backgroundColor: "#0f172a",
                      color: copied ? "#86efac" : "#e2e8f0",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    <span>{copied ? "Copied" : "Copy URL"}</span>
                  </button>
                  <button
                    type="button"
                    data-signin-qr-download="true"
                    onClick={() => downloadQrSvgFile(resolvedBookmarkUrl)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "5px",
                      padding: "6px 10px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "#334155",
                      backgroundColor: "#0f172a",
                      color: "#cbd5e1",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Download size={12} />
                    <span>Save SVG</span>
                  </button>
                </div>
                {extractedToken && (
                  <button
                    type="button"
                    disabled={busy}
                    data-signin-qr-redeem="true"
                    onClick={() => {
                      if (extractedToken) {
                        void onRedeemFastToken(extractedToken)
                      }
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: "6px",
                      padding: "6px 10px",
                      borderRadius: "5px",
                      borderWidth: "1px",
                      borderStyle: "solid",
                      borderColor: "#38bdf8",
                      backgroundColor: "rgba(56, 189, 248, 0.14)",
                      color: "#7dd3fc",
                      fontSize: "11px",
                      fontWeight: 600,
                      cursor: busy ? "wait" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <LogIn size={12} />
                    <span>Sign In with Bookmark</span>
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px",
                borderRadius: "6px",
                backgroundColor: "#070b14",
                borderWidth: "1px",
                borderStyle: "dashed",
                borderColor: "#334155",
                color: "#94a3b8",
                fontSize: "11.5px",
                lineHeight: 1.45,
              }}
            >
              <QrCode size={22} style={{ color: "#475569", flexShrink: 0 }} />
              <span>
                {devQuickLoginAvailable
                  ? "Click Generate QR to mint a temporary Fast Sign-In bookmark code."
                  : "Enter your Desk Access Token above and click Generate QR, or paste a Fast Sign-In bookmark URL below."}
              </span>
            </div>
          )}

          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <input
              type="text"
              aria-label="Fast Sign-In bookmark URL or token"
              data-signin-qr-input="true"
              value={rawInput}
              onChange={(e) => {
                const next = e.target.value
                setRawInput(next)
                setErrorText(null)
                setMetaText(null)
                onBookmarkUrlChange?.(resolveFastSignInBookmarkUrl(currentHref, next))
              }}
              onFocus={(e) => {
                if (resolvedBookmarkUrl) e.currentTarget.select()
              }}
              placeholder={buildFastSignInBookmarkUrl(currentHref, "sdfast_...").replace(
                /^https?:\/\/[^/]+/,
                "",
              )}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "6px 8px",
                borderRadius: "5px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
                backgroundColor: "#070b14",
                color: "#7dd3fc",
                fontSize: "11px",
                fontFamily: TELEMETRY_MONO_FONT,
                outline: "none",
              }}
            />
            {(devQuickLoginAvailable || authConfigured) && (
              <button
                type="button"
                disabled={busy}
                data-signin-qr-generate="true"
                onClick={() => void runMint(ttlMinutes)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "6px 10px",
                  borderRadius: "5px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "#38bdf8",
                  backgroundColor: "#0284c7",
                  color: "#f8fafc",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: busy ? "wait" : "pointer",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  opacity: busy ? 0.65 : 1,
                }}
              >
                <RefreshCw size={12} />
                <span>{busy ? "Minting…" : resolvedBookmarkUrl ? "New QR" : "Generate QR"}</span>
              </button>
            )}
          </div>

          {errorText && (
            <div
              role="alert"
              style={{
                fontSize: "11px",
                color: "#fca5a5",
                lineHeight: 1.4,
              }}
            >
              {errorText}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
