import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import {
  Bookmark,
  Check,
  ChevronDown,
  ClipboardList,
  Clock,
  Copy,
  Download,
  LogOut,
  Trash2,
} from "lucide-react"
import { copyText } from "../clipboard.ts"
import { downloadQrSvgFile, FastSignInQrCode } from "./FastSignInQrCode.tsx"
import {
  formatShiftSecondsClock,
  getOperatorInitials,
  OPERATOR_PROFILES,
  resolveOperatorProfile,
} from "../operator_profiles.ts"

const TELEMETRY_MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

export interface FastSignInBookmarkMintResult {
  readonly ok: boolean
  readonly bookmarkUrl?: string | undefined
  readonly expiresAtIso?: string | undefined
  readonly activeCount?: number | undefined
  readonly error?: string | undefined
}

export interface FastSignInBookmarkRevokeResult {
  readonly ok: boolean
  readonly revokedCount?: number | undefined
  readonly error?: string | undefined
}

export interface OperatorProfileMenuProps {
  readonly username: string
  readonly accessRole?: "Admin" | "Operator" | undefined
  readonly signedInAt: number | null
  readonly activeShiftSeconds?: number | undefined
  readonly onSwitchOperator?: ((operatorId: string) => void) | undefined
  readonly onOpenShiftHandoff: () => void
  readonly onMintFastSignInBookmark?:
    ((ttlMinutes: number) => Promise<FastSignInBookmarkMintResult>) | undefined
  readonly onRevokeFastSignInBookmarks?: (() => Promise<FastSignInBookmarkRevokeResult>) | undefined
  readonly onLogout: () => void
}

interface ProfileAvatarImgProps {
  readonly src: string
  readonly alt: string
  readonly initials: string
  readonly accentColor: string
  readonly size: number
  readonly online?: boolean
}

function ProfileAvatarImg({
  src,
  alt,
  initials,
  accentColor,
  size,
  online,
}: ProfileAvatarImgProps): React.ReactElement {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "50%",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: `${size}px`,
          height: `${size}px`,
          borderRadius: "50%",
          overflow: "hidden",
          backgroundColor: "rgba(56, 189, 248, 0.16)",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: accentColor,
          color: accentColor,
          fontSize: `${Math.max(9, Math.round(size * 0.36))}px`,
          fontWeight: 700,
          fontFamily: TELEMETRY_MONO_FONT,
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
      {online !== undefined ? (
        <span
          style={{
            position: "absolute",
            right: "-1px",
            bottom: "-1px",
            width: "7px",
            height: "7px",
            borderRadius: "50%",
            backgroundColor: online ? "#4ade80" : "#64748b",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#0d1527",
          }}
        />
      ) : null}
    </span>
  )
}

export function OperatorProfileMenu({
  username,
  accessRole,
  signedInAt,
  activeShiftSeconds,
  onSwitchOperator,
  onOpenShiftHandoff,
  onMintFastSignInBookmark,
  onRevokeFastSignInBookmarks,
  onLogout,
}: OperatorProfileMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [showBookmarkTools, setShowBookmarkTools] = useState(false)
  const [bookmarkTtlMinutes, setBookmarkTtlMinutes] = useState<number>(1440)
  const [bookmarkBusy, setBookmarkBusy] = useState(false)
  const [bookmarkUrl, setBookmarkUrl] = useState<string | null>(null)
  const [bookmarkMeta, setBookmarkMeta] = useState<string | null>(null)
  const [bookmarkError, setBookmarkError] = useState<string | null>(null)
  const [bookmarkCopied, setBookmarkCopied] = useState(false)
  const [fallbackSeconds, setFallbackSeconds] = useState<number>(() =>
    signedInAt !== null ? Math.max(0, Math.floor((Date.now() - signedInAt) / 1000)) : 0,
  )
  const rootRef = useRef<HTMLDivElement>(null)

  const handleMintBookmark = async () => {
    if (!onMintFastSignInBookmark || bookmarkBusy) return
    setBookmarkBusy(true)
    setBookmarkError(null)
    setBookmarkCopied(false)
    try {
      const result = await onMintFastSignInBookmark(bookmarkTtlMinutes)
      if (!result.ok || !result.bookmarkUrl) {
        setBookmarkError(result.error || "Unable to generate bookmark link")
        return
      }
      setBookmarkUrl(result.bookmarkUrl)
      const expText = result.expiresAtIso
        ? new Date(result.expiresAtIso).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "temporary"
      const activeText =
        typeof result.activeCount === "number" ? ` · ${result.activeCount} active` : ""
      setBookmarkMeta(`Expires ${expText}${activeText}`)
      const copied = await copyText(result.bookmarkUrl)
      if (copied) {
        setBookmarkCopied(true)
      }
    } catch (err) {
      setBookmarkError(err instanceof Error ? err.message : "Failed to generate bookmark")
    } finally {
      setBookmarkBusy(false)
    }
  }

  const handleRevokeBookmarks = async () => {
    if (!onRevokeFastSignInBookmarks || bookmarkBusy) return
    setBookmarkBusy(true)
    setBookmarkError(null)
    try {
      const result = await onRevokeFastSignInBookmarks()
      if (!result.ok) {
        setBookmarkError(result.error || "Unable to revoke active links")
        return
      }
      setBookmarkUrl(null)
      setBookmarkCopied(false)
      setBookmarkMeta(
        `Revoked ${result.revokedCount ?? 0} link${result.revokedCount === 1 ? "" : "s"}`,
      )
    } catch (err) {
      setBookmarkError(err instanceof Error ? err.message : "Failed to revoke links")
    } finally {
      setBookmarkBusy(false)
    }
  }

  useEffect(() => {
    if (activeShiftSeconds !== undefined) return
    if (signedInAt === null) {
      setFallbackSeconds(0)
      return
    }
    const update = () => {
      setFallbackSeconds(Math.max(0, Math.floor((Date.now() - signedInAt) / 1000)))
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [activeShiftSeconds, signedInAt])

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [open])

  const displayName = username.trim() || "operator"
  const profile = useMemo(() => resolveOperatorProfile(displayName), [displayName])
  const initials = getOperatorInitials(profile.displayName)
  const effectiveShiftSeconds = activeShiftSeconds ?? fallbackSeconds
  const shiftDurationText = formatShiftSecondsClock(effectiveShiftSeconds)
  const signedInClock =
    signedInAt !== null
      ? new Date(signedInAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        })
      : "Signed out"

  return (
    <div
      ref={rootRef}
      data-operator-profile-menu="true"
      style={{
        position: "relative",
        marginLeft: "auto",
        display: "inline-flex",
        alignItems: "center",
      }}
    >
      <button
        type="button"
        aria-label={`Operator profile menu (${profile.displayName}${accessRole ? `, ${accessRole} access` : ""}), active shift duration ${shiftDurationText}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-operator-menu-trigger="true"
        onClick={() => setOpen((prev) => !prev)}
        title={`${profile.displayName}${accessRole ? ` · ${accessRole} access` : ""} · Active shift ${shiftDurationText}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "7px",
          padding: "4px 9px 4px 5px",
          borderRadius: "6px",
          backgroundColor: open ? "#0f172a" : "#1e293b",
          color: "#e2e8f0",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: open ? "#38bdf8" : "#334155",
          fontSize: "12px",
          fontWeight: 600,
          cursor: "pointer",
          whiteSpace: "nowrap",
          transition: "border-color 0.15s ease, background-color 0.15s ease",
        }}
      >
        <ProfileAvatarImg
          src={profile.avatarUrl}
          alt={profile.avatarAlt}
          initials={initials}
          accentColor={profile.accentColor}
          size={22}
          online={signedInAt !== null}
        />
        <span
          data-operator-username-label="true"
          style={{
            maxWidth: "136px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontFamily: TELEMETRY_MONO_FONT,
            fontSize: "11.5px",
            fontWeight: 600,
            letterSpacing: "0.05em",
            fontVariantNumeric: "tabular-nums",
            color: "#f8fafc",
            textShadow: "0 0 8px rgba(56, 189, 248, 0.14)",
          }}
        >
          {displayName}
        </span>
        {accessRole && (
          <span className="sd-session-role" data-role={accessRole}>
            {accessRole}
          </span>
        )}
        <span
          data-active-shift-duration="true"
          title={`Active Shift Duration (since ${signedInClock})`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "2px 6px",
            borderRadius: "4px",
            backgroundColor: "rgba(11, 15, 25, 0.85)",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "rgba(56, 189, 248, 0.25)",
            fontFamily: TELEMETRY_MONO_FONT,
            fontVariantNumeric: "tabular-nums",
            fontSize: "10px",
            fontWeight: 600,
            color: signedInAt !== null ? "#38bdf8" : "#64748b",
          }}
        >
          <Clock size={10} aria-hidden="true" />
          <span>{shiftDurationText}</span>
        </span>
        <ChevronDown
          size={12}
          aria-hidden="true"
          style={{
            color: "#94a3b8",
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 0.15s ease",
          }}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Operator profile actions"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            minWidth: "264px",
            backgroundColor: "#0b1120",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "#334155",
            borderRadius: "8px",
            boxShadow: "0 16px 36px rgba(2, 6, 23, 0.8)",
            overflow: "hidden",
            zIndex: 1000,
          }}
        >
          {/* Current Operator Identity Card */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "12px",
              backgroundColor: "#0d1527",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "#1e293b",
            }}
          >
            <ProfileAvatarImg
              src={profile.avatarUrl}
              alt={profile.avatarAlt}
              initials={initials}
              accentColor={profile.accentColor}
              size={38}
              online={signedInAt !== null}
            />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                data-operator-username="true"
                style={{
                  fontSize: "13px",
                  fontWeight: 700,
                  letterSpacing: "0.02em",
                  color: "#f8fafc",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {profile.displayName}
              </div>
              <div
                style={{
                  marginTop: "1px",
                  fontSize: "10.5px",
                  color: "#94a3b8",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {profile.role} · {profile.deskCode}
              </div>
              <div
                style={{
                  marginTop: "4px",
                  display: "flex",
                  alignItems: "center",
                  gap: "5px",
                  fontSize: "10.5px",
                  color: "#94a3b8",
                  fontFamily: TELEMETRY_MONO_FONT,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <Clock size={10} style={{ color: "#38bdf8" }} />
                <span>Shift:</span>
                <span style={{ color: "#38bdf8", fontWeight: 700 }}>{shiftDurationText}</span>
              </div>
            </div>
          </div>

          {/* Desk Operator Quick Switcher */}
          {onSwitchOperator ? (
            <div
              style={{
                padding: "8px 10px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "#1e293b",
              }}
            >
              <div
                style={{
                  fontSize: "10px",
                  fontWeight: 700,
                  color: "#64748b",
                  marginBottom: "6px",
                }}
              >
                Switch Desk Operator
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: "5px",
                }}
              >
                {OPERATOR_PROFILES.map((op) => {
                  const isCurrent = op.id.toLowerCase() === displayName.toLowerCase()
                  return (
                    <button
                      key={op.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onSwitchOperator(op.id)
                        setOpen(false)
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "4px 6px",
                        borderRadius: "5px",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor: isCurrent ? op.accentColor : "#1e293b",
                        backgroundColor: isCurrent ? "rgba(56, 189, 248, 0.12)" : "#0f172a",
                        color: isCurrent ? "#f8fafc" : "#cbd5e1",
                        fontSize: "11px",
                        fontWeight: isCurrent ? 600 : 500,
                        cursor: "pointer",
                        textAlign: "left",
                        overflow: "hidden",
                      }}
                    >
                      <ProfileAvatarImg
                        src={op.avatarUrl}
                        alt={op.avatarAlt}
                        initials={getOperatorInitials(op.displayName)}
                        accentColor={op.accentColor}
                        size={20}
                      />
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {op.displayName.split(" ")[0]}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {/* Primary Menu Actions */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "6px",
              gap: "4px",
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onOpenShiftHandoff()
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "7px 9px",
                borderRadius: "6px",
                backgroundColor: "transparent",
                borderWidth: 0,
                color: "#cbd5e1",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <ClipboardList size={14} style={{ color: "#38bdf8" }} />
              <span>Shift Handoff &amp; 8h Report</span>
            </button>

            {onMintFastSignInBookmark ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <button
                  type="button"
                  role="menuitem"
                  data-fast-signin-bookmark-toggle="true"
                  onClick={() => setShowBookmarkTools((prev) => !prev)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                    padding: "7px 9px",
                    borderRadius: "6px",
                    backgroundColor: showBookmarkTools ? "rgba(56, 189, 248, 0.1)" : "transparent",
                    borderWidth: 0,
                    color: showBookmarkTools ? "#f8fafc" : "#cbd5e1",
                    fontSize: "12px",
                    fontWeight: 600,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <Bookmark size={14} style={{ color: "#38bdf8" }} />
                    <span>Fast Sign-In Bookmark</span>
                  </span>
                  <ChevronDown
                    size={12}
                    style={{
                      color: "#94a3b8",
                      transform: showBookmarkTools ? "rotate(180deg)" : "none",
                      transition: "transform 0.15s ease",
                    }}
                  />
                </button>
                {showBookmarkTools ? (
                  <div
                    data-fast-signin-bookmark-panel="true"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "7px",
                      padding: "8px 9px",
                      borderRadius: "6px",
                      backgroundColor: "#0f172a",
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
                        gap: "6px",
                        fontSize: "10.5px",
                        color: "#94a3b8",
                      }}
                    >
                      <span>Token TTL</span>
                      <div style={{ display: "flex", gap: "4px" }}>
                        {[
                          { label: "1h", minutes: 60 },
                          { label: "8h", minutes: 480 },
                          { label: "24h", minutes: 1440 },
                          { label: "7d", minutes: 10080 },
                        ].map((opt) => {
                          const selected = bookmarkTtlMinutes === opt.minutes
                          return (
                            <button
                              key={opt.minutes}
                              type="button"
                              onClick={() => setBookmarkTtlMinutes(opt.minutes)}
                              style={{
                                padding: "2px 6px",
                                borderRadius: "4px",
                                borderWidth: "1px",
                                borderStyle: "solid",
                                borderColor: selected ? "#38bdf8" : "#334155",
                                backgroundColor: selected ? "rgba(56, 189, 248, 0.16)" : "#0b1120",
                                color: selected ? "#7dd3fc" : "#94a3b8",
                                fontSize: "10px",
                                fontFamily: TELEMETRY_MONO_FONT,
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                            >
                              {opt.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: "5px" }}>
                      <button
                        type="button"
                        disabled={bookmarkBusy}
                        data-fast-signin-generate="true"
                        onClick={() => void handleMintBookmark()}
                        style={{
                          flex: 1,
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "5px",
                          padding: "6px 8px",
                          borderRadius: "5px",
                          borderWidth: "1px",
                          borderStyle: "solid",
                          borderColor: "#38bdf8",
                          backgroundColor: "#0284c7",
                          color: "#f8fafc",
                          fontSize: "11px",
                          fontWeight: 600,
                          cursor: bookmarkBusy ? "wait" : "pointer",
                          whiteSpace: "nowrap",
                          opacity: bookmarkBusy ? 0.65 : 1,
                        }}
                      >
                        {bookmarkCopied ? <Check size={12} /> : <Copy size={12} />}
                        <span>
                          {bookmarkBusy
                            ? "Minting…"
                            : bookmarkCopied
                              ? "Copied Link"
                              : "Copy Bookmark"}
                        </span>
                      </button>
                      {onRevokeFastSignInBookmarks ? (
                        <button
                          type="button"
                          disabled={bookmarkBusy}
                          title="Revoke all active Fast Sign-In links for this operator"
                          onClick={() => void handleRevokeBookmarks()}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            padding: "6px 8px",
                            borderRadius: "5px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: "#334155",
                            backgroundColor: "#0b1120",
                            color: "#94a3b8",
                            fontSize: "11px",
                            cursor: bookmarkBusy ? "wait" : "pointer",
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      ) : null}
                    </div>

                    {bookmarkUrl ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          gap: "7px",
                        }}
                      >
                        <input
                          type="text"
                          readOnly
                          aria-label="Generated Fast Sign-In bookmark URL"
                          value={bookmarkUrl}
                          onFocus={(e) => e.currentTarget.select()}
                          style={{
                            width: "100%",
                            boxSizing: "border-box",
                            padding: "5px 7px",
                            borderRadius: "4px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: "#334155",
                            backgroundColor: "#070b14",
                            color: "#7dd3fc",
                            fontSize: "10px",
                            fontFamily: TELEMETRY_MONO_FONT,
                          }}
                        />
                        <FastSignInQrCode
                          url={bookmarkUrl}
                          sizePx={132}
                          label="Fast Sign-In bookmark QR code for mobile handoff"
                        />
                        <button
                          type="button"
                          onClick={() => downloadQrSvgFile(bookmarkUrl)}
                          style={{
                            width: "100%",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "5px",
                            padding: "4px 8px",
                            borderRadius: "4px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: "#334155",
                            backgroundColor: "#0b1120",
                            color: "#cbd5e1",
                            fontSize: "10.5px",
                            fontWeight: 600,
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                        >
                          <Download size={11} />
                          <span>Save QR SVG</span>
                        </button>
                      </div>
                    ) : null}

                    {bookmarkMeta ? (
                      <div
                        style={{
                          fontSize: "10px",
                          color: "#94a3b8",
                          fontFamily: TELEMETRY_MONO_FONT,
                          fontVariantNumeric: "tabular-nums",
                        }}
                      >
                        {bookmarkMeta}
                      </div>
                    ) : null}

                    {bookmarkError ? (
                      <div
                        role="alert"
                        style={{
                          fontSize: "10.5px",
                          color: "#fca5a5",
                        }}
                      >
                        {bookmarkError}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}

            <div
              style={{
                height: "1px",
                backgroundColor: "#1e293b",
                margin: "2px 4px",
              }}
            />

            <button
              type="button"
              role="menuitem"
              data-operator-logout="true"
              onClick={() => {
                setOpen(false)
                onLogout()
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "7px 9px",
                borderRadius: "6px",
                backgroundColor: "rgba(239, 68, 68, 0.1)",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "rgba(239, 68, 68, 0.25)",
                color: "#fca5a5",
                fontSize: "12px",
                fontWeight: 600,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <LogOut size={14} style={{ color: "#f87171" }} />
              <span>Log out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
