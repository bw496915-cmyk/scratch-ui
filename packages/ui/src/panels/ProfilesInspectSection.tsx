import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  Check,
  Copy,
  Download,
  Flag,
  MoreVertical,
  RefreshCw,
  Terminal,
} from "lucide-react"
import { renderAnsiReact } from "../ansi.tsx"
import { getDevCsrfToken, trackedFetch } from "../api_usage.ts"
import { copyText } from "../clipboard.ts"
import { classifyCustomerProfile } from "../profile_taxonomy.ts"
import type { CustomerProfileClassification, CustomerSortKey, ShowcaseCustomer } from "../types.ts"

export interface ProfileInspectApiResponse {
  readonly selectedId: string | null
  readonly totalCount: number
  readonly displayedCount: number
  readonly summary: {
    readonly avgSharpness: number | null
    readonly alertCount: number | null
    readonly totalVar95Usd: number | null
    readonly totalLimitCapUsd: number | null
    readonly tierCounts: Record<string, number>
  }
  readonly profileAnsi: string
  readonly cohortAnsi: string
  readonly radarAnsi: string
  readonly tableAnsi: string
  readonly optionsBannerAnsi: string
  readonly optionsJsLiteral: string
  readonly cliFlags: string
  readonly profileCliCommand: string
  readonly cohortCliCommand: string
  readonly radarCliCommand: string
  readonly generatedAt: string
}

export interface ProfilesInspectSectionProps {
  readonly profiles: readonly ShowcaseCustomer[]
  readonly selectedCustomer: ShowcaseCustomer | null
  readonly profileClassifications?: ReadonlyMap<string, CustomerProfileClassification> | undefined
  readonly sortField: CustomerSortKey
  readonly sortDir: 1 | -1
  readonly activeFilters: readonly string[]
  readonly onRunTerminalCommand?: ((cmd: string) => void) | undefined
  readonly onOpenTerminalProfile?: ((customerId: string) => void) | undefined
  readonly onAddCustomProfileTag?: ((customerId: string, rawLabel: string) => void) | undefined
  readonly onRemoveCustomProfileTag?: ((customerId: string, tagLabel: string) => void) | undefined
}

const REVIEW_FLAG_TAG_LABEL = "FLAGGED-FOR-REVIEW"

type ProfileInspectViewMode = "profile" | "cohort" | "radar" | "table"
type InspectDepth = 1 | 2 | 3 | 4

interface CardContextMenuState {
  readonly x: number
  readonly y: number
}

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

function mapSortKey(sortField: CustomerSortKey): string {
  switch (sortField) {
    case "id":
      return "id"
    case "score":
      return "score"
    case "gini":
      return "gini"
    case "var95Usd":
      return "var95Usd"
    case "holdPct":
      return "holdPct"
    default:
      return "score"
  }
}

export function ProfilesInspectSection({
  profiles,
  selectedCustomer,
  profileClassifications,
  sortField,
  sortDir,
  activeFilters,
  onRunTerminalCommand,
  onOpenTerminalProfile,
  onAddCustomProfileTag,
  onRemoveCustomProfileTag,
}: ProfilesInspectSectionProps): React.ReactElement {
  const [inspectMode, setInspectMode] = useState<ProfileInspectViewMode>("profile")
  const [inspectColors, setInspectColors] = useState(true)
  const [inspectCompact, setInspectCompact] = useState(false)
  const [inspectSorted, setInspectSorted] = useState(false)
  const [inspectShowHidden, setInspectShowHidden] = useState(false)
  const [inspectNumericSeparator, setInspectNumericSeparator] = useState(false)
  const [inspectGetters, setInspectGetters] = useState(true)
  const [inspectShowOptions, setInspectShowOptions] = useState(true)
  const [inspectDepth, setInspectDepth] = useState<InspectDepth>(2)
  const [inspectMaxArrayLength, setInspectMaxArrayLength] = useState<number>(20)
  const [inspectBreakLength, setInspectBreakLength] = useState<number>(96)

  const [data, setData] = useState<ProfileInspectApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedMode, setCopiedMode] = useState<false | "plain" | "ansi" | "options" | "id">(false)
  const [contextMenu, setContextMenu] = useState<CardContextMenuState | null>(null)
  const [localFlaggedIds, setLocalFlaggedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [actionFeedback, setActionFeedback] = useState<string | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const lastSentPayloadRef = useRef<string | null>(null)
  const requestSeqRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (feedbackTimerRef.current !== null) {
        clearTimeout(feedbackTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const handlePointerDown = (event: MouseEvent) => {
      if (
        contextMenuRef.current &&
        event.target instanceof Node &&
        contextMenuRef.current.contains(event.target)
      ) {
        return
      }
      setContextMenu(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null)
      }
    }
    const handleDismiss = () => setContextMenu(null)
    window.addEventListener("mousedown", handlePointerDown)
    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("scroll", handleDismiss, true)
    window.addEventListener("resize", handleDismiss)
    return () => {
      window.removeEventListener("mousedown", handlePointerDown)
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("scroll", handleDismiss, true)
      window.removeEventListener("resize", handleDismiss)
    }
  }, [contextMenu])

  const profileIds = useMemo(() => profiles.map((customer) => customer.id), [profiles])

  const activeFiltersKey = activeFilters.join("\u0001")
  const stableActiveFilters = useMemo(
    () => (activeFiltersKey ? activeFiltersKey.split("\u0001") : []),
    [activeFiltersKey],
  )

  const requestPayloadJson = useMemo(
    () =>
      JSON.stringify({
        profileIds,
        selectedId: selectedCustomer?.id ?? profileIds[0] ?? null,
        sort: mapSortKey(sortField),
        dir: sortDir === 1 ? "asc" : "desc",
        activeFilters: stableActiveFilters,
        showOptions: inspectShowOptions,
        options: {
          colors: inspectColors,
          compact: inspectCompact,
          sorted: inspectSorted,
          depth: inspectDepth,
          showHidden: inspectShowHidden,
          numericSeparator: inspectNumericSeparator,
          getters: inspectGetters,
          maxArrayLength: inspectMaxArrayLength,
          breakLength: inspectBreakLength,
        },
      }),
    [
      profileIds,
      selectedCustomer?.id,
      sortField,
      sortDir,
      stableActiveFilters,
      inspectShowOptions,
      inspectColors,
      inspectCompact,
      inspectSorted,
      inspectDepth,
      inspectShowHidden,
      inspectNumericSeparator,
      inspectGetters,
      inspectMaxArrayLength,
      inspectBreakLength,
    ],
  )

  const fetchInspect = useCallback(
    async (force = false) => {
      if (!force && lastSentPayloadRef.current === requestPayloadJson) {
        return
      }
      lastSentPayloadRef.current = requestPayloadJson
      const seq = ++requestSeqRef.current
      setLoading(true)
      setError(null)
      try {
        const cookieCsrf =
          typeof document !== "undefined"
            ? document.cookie.match(/(?:^|;\s*)sd_csrf=([^;]+)/)?.[1]
            : undefined
        const csrfToken = cookieCsrf ? decodeURIComponent(cookieCsrf) : getDevCsrfToken()
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        }
        if (csrfToken) {
          headers["x-csrf-token"] = csrfToken
        }
        const res = await trackedFetch("/api/profiles/inspect", {
          method: "POST",
          headers,
          cache: "no-store",
          body: requestPayloadJson,
        })
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const json = (await res.json()) as ProfileInspectApiResponse
        if (mountedRef.current && seq === requestSeqRef.current) {
          setData(json)
        }
      } catch (err) {
        if (mountedRef.current && seq === requestSeqRef.current) {
          setError(err instanceof Error ? err.message : String(err))
          lastSentPayloadRef.current = null
        }
      } finally {
        if (mountedRef.current && seq === requestSeqRef.current) {
          setLoading(false)
        }
      }
    },
    [requestPayloadJson],
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      void fetchInspect(false)
    }, 120)
    return () => {
      clearTimeout(timer)
    }
  }, [fetchInspect])

  const activeAnsi =
    inspectMode === "profile"
      ? (data?.profileAnsi ?? "")
      : inspectMode === "cohort"
        ? (data?.cohortAnsi ?? "")
        : inspectMode === "radar"
          ? (data?.radarAnsi ?? "")
          : (data?.tableAnsi ?? "")

  const targetCustomerId =
    selectedCustomer?.id ?? data?.selectedId ?? profiles[0]?.id ?? "SYNTH_SNIPER_02"

  const cliCommand = useMemo(() => {
    const flags = (data?.cliFlags ?? "").trim()
    const hasOptionsFlag = /(?:^|\s)--options(?:$|\s|=)/.test(flags)
    const optSuffix = inspectShowOptions && !hasOptionsFlag ? " --options" : ""
    const tail = `${flags ? ` ${flags}` : ""}${optSuffix}`.trim()
    if (inspectMode === "profile") {
      return data?.profileCliCommand ?? `profile ${targetCustomerId}${tail ? ` ${tail}` : ""}`
    }
    if (inspectMode === "radar") {
      return data?.radarCliCommand ?? `profile ${targetCustomerId} --radar${tail ? ` ${tail}` : ""}`
    }
    if (inspectMode === "table") {
      return `profiles --table${tail ? ` ${tail}` : ""}`
    }
    return data?.cohortCliCommand ?? `profiles${tail ? ` ${tail}` : ""}`
  }, [
    data?.cliFlags,
    data?.profileCliCommand,
    data?.cohortCliCommand,
    data?.radarCliCommand,
    inspectMode,
    inspectShowOptions,
    targetCustomerId,
  ])

  const jsInvocation = useMemo(() => {
    const opts =
      data?.optionsJsLiteral ??
      `{ colors: ${inspectColors}, compact: ${inspectCompact}, depth: ${inspectDepth}, sorted: ${inspectSorted}, showHidden: ${inspectShowHidden}, numericSeparator: ${inspectNumericSeparator}, getters: ${inspectGetters}, maxArrayLength: ${inspectMaxArrayLength}, breakLength: ${inspectBreakLength} }`
    if (inspectMode === "profile") {
      return `Bun.inspect(new ProfileView("${targetCustomerId}"), ${opts})`
    }
    if (inspectMode === "cohort") {
      return `Bun.inspect(new ProfileCohortView(profiles), ${opts})`
    }
    if (inspectMode === "radar") {
      return `Bun.inspect(new ProfileRadarView(selectedProfiles, { weblogEvidence }), ${opts})`
    }
    return `Bun.inspect.table(profiles, columns, ${opts})`
  }, [
    data?.optionsJsLiteral,
    inspectMode,
    targetCustomerId,
    inspectColors,
    inspectCompact,
    inspectDepth,
    inspectSorted,
    inspectShowHidden,
    inspectNumericSeparator,
    inspectGetters,
    inspectMaxArrayLength,
    inspectBreakLength,
  ])

  const inspectStats = useMemo(() => {
    if (!activeAnsi) return { lines: 0, bytes: 0 }
    return {
      lines: activeAnsi.split("\n").length,
      bytes: new TextEncoder().encode(activeAnsi).length,
    }
  }, [activeAnsi])

  const handleCopy = (mode: "plain" | "ansi" | "options") => {
    let text = ""
    if (mode === "options") {
      text = cliCommand
    } else if (mode === "ansi") {
      text = activeAnsi
    } else {
      text = activeAnsi.replace(/\x1b\[[0-9;]*m/g, "")
    }
    if (!text) return
    void navigator.clipboard?.writeText(text)
    setCopiedMode(mode)
    setTimeout(() => setCopiedMode(false), 1500)
  }

  const handleDownload = () => {
    if (!activeAnsi) return
    const plain = activeAnsi.replace(/\x1b\[[0-9;]*m/g, "")
    const blob = new Blob([plain], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `sportsdesk-${inspectMode}-${targetCustomerId.toLowerCase()}-d${inspectDepth}.txt`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const targetCustomer = useMemo(
    () =>
      selectedCustomer ?? profiles.find((p) => p.id === targetCustomerId) ?? profiles[0] ?? null,
    [selectedCustomer, profiles, targetCustomerId],
  )

  const isFlaggedForReview = useMemo(() => {
    const key = targetCustomerId.toUpperCase()
    if (localFlaggedIds.has(key)) return true
    if (!targetCustomer) return false
    const cls =
      profileClassifications?.get(targetCustomer.id) ?? classifyCustomerProfile(targetCustomer)
    return cls.tags.some(
      (tag) =>
        tag.label.toUpperCase() === REVIEW_FLAG_TAG_LABEL ||
        tag.id === `custom:${REVIEW_FLAG_TAG_LABEL.toLowerCase()}`,
    )
  }, [localFlaggedIds, targetCustomer, targetCustomerId, profileClassifications])

  const showFeedback = useCallback((message: string) => {
    setActionFeedback(message)
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current)
    }
    feedbackTimerRef.current = setTimeout(() => {
      setActionFeedback(null)
    }, 2200)
  }, [])

  const openContextMenuAt = useCallback((clientX: number, clientY: number) => {
    const menuWidth = 240
    const menuHeight = 236
    const margin = 10
    const maxX =
      typeof window !== "undefined"
        ? Math.max(margin, window.innerWidth - menuWidth - margin)
        : clientX
    const maxY =
      typeof window !== "undefined"
        ? Math.max(margin, window.innerHeight - menuHeight - margin)
        : clientY
    setContextMenu({
      x: Math.min(Math.max(margin, clientX), maxX),
      y: Math.min(Math.max(margin, clientY), maxY),
    })
  }, [])

  const handleCardContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    openContextMenuAt(e.clientX, e.clientY)
  }

  const handleCopyId = () => {
    void copyText(targetCustomerId)
    setCopiedMode("id")
    setTimeout(() => setCopiedMode(false), 1500)
    showFeedback(`Copied ID ${targetCustomerId}`)
    setContextMenu(null)
  }

  const handleInspectInTerminal = () => {
    setContextMenu(null)
    if (onRunTerminalCommand) {
      onRunTerminalCommand(cliCommand)
      return
    }
    if (onOpenTerminalProfile && targetCustomerId) {
      onOpenTerminalProfile(targetCustomerId)
    }
  }

  const handleInspectRadarInTerminal = () => {
    setContextMenu(null)
    if (onRunTerminalCommand) {
      onRunTerminalCommand(`profile ${targetCustomerId} --radar`)
      return
    }
    if (onOpenTerminalProfile && targetCustomerId) {
      onOpenTerminalProfile(targetCustomerId)
    }
  }

  const handleToggleFlagForReview = () => {
    const key = targetCustomerId.toUpperCase()
    if (isFlaggedForReview) {
      onRemoveCustomProfileTag?.(targetCustomerId, REVIEW_FLAG_TAG_LABEL)
      setLocalFlaggedIds((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
      showFeedback(`Cleared review flag · ${targetCustomerId}`)
    } else {
      onAddCustomProfileTag?.(targetCustomerId, REVIEW_FLAG_TAG_LABEL)
      if (!onAddCustomProfileTag) {
        setLocalFlaggedIds((prev) => {
          const next = new Set(prev)
          next.add(key)
          return next
        })
      }
      showFeedback(`Flagged ${targetCustomerId} for review`)
    }
    setContextMenu(null)
  }

  const handleRunInTerminal = () => {
    if (onRunTerminalCommand) {
      onRunTerminalCommand(cliCommand)
      return
    }
    if (onOpenTerminalProfile && targetCustomerId) {
      onOpenTerminalProfile(targetCustomerId)
    }
  }

  return (
    <div
      data-profiles-inspect="true"
      onContextMenu={handleCardContextMenu}
      style={{
        marginTop: "16px",
        backgroundColor: "#070b14",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: isFlaggedForReview ? "rgba(245, 158, 11, 0.48)" : "#1e293b",
        borderRadius: "8px",
        overflow: "hidden",
      }}
    >
      {/* Header Row: View Tabs & Action Controls */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          padding: "10px 14px",
          backgroundColor: "#0d1527",
          borderBottomWidth: "1px",
          borderBottomStyle: "solid",
          borderBottomColor: "#1e293b",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <Terminal size={14} style={{ color: "#38bdf8" }} />
          <span
            style={{
              fontSize: "12px",
              fontWeight: 700,
              color: "#f8fafc",
              fontFamily: MONO_FONT,
            }}
          >
            Bun.inspect.custom · Profiles Output
          </span>
          {isFlaggedForReview && (
            <span
              data-review-flagged="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 7px",
                borderRadius: "4px",
                fontSize: "10px",
                fontWeight: 700,
                fontFamily: MONO_FONT,
                letterSpacing: "0.03em",
                backgroundColor: "rgba(245, 158, 11, 0.16)",
                color: "#fbbf24",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "rgba(245, 158, 11, 0.42)",
              }}
              title={`${targetCustomerId} is flagged for operator review`}
            >
              <Flag size={10} />
              FLAGGED FOR REVIEW
            </span>
          )}
          {actionFeedback && (
            <span
              role="status"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 7px",
                borderRadius: "4px",
                fontSize: "10px",
                fontWeight: 600,
                fontFamily: MONO_FONT,
                backgroundColor: "rgba(34, 197, 94, 0.14)",
                color: "#86efac",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "rgba(34, 197, 94, 0.35)",
              }}
            >
              <Check size={10} />
              {actionFeedback}
            </span>
          )}
          {(
            [
              {
                id: "profile",
                label: `ProfileView (${targetCustomerId})`,
              },
              {
                id: "cohort",
                label: `ProfileCohortView (${profiles.length})`,
              },
              { id: "radar", label: "ProfileRadarView" },
              { id: "table", label: "Bun.inspect.table()" },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setInspectMode(m.id)}
              style={{
                padding: "3px 8px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 600,
                fontFamily: MONO_FONT,
                cursor: "pointer",
                backgroundColor: inspectMode === m.id ? "rgba(56, 189, 248, 0.18)" : "#070b14",
                color: inspectMode === m.id ? "#7dd3fc" : "#94a3b8",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: inspectMode === m.id ? "#38bdf8" : "#1e293b",
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={() => void fetchInspect(true)}
            title="Re-render Bun.inspect.custom view"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 8px",
              borderRadius: "5px",
              fontSize: "11px",
              backgroundColor: "#1e293b",
              color: "#cbd5e1",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              cursor: "pointer",
            }}
          >
            <RefreshCw size={11} />
            {loading ? "Syncing" : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => handleCopy("plain")}
            title="Copy ANSI-stripped plain text output"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 8px",
              borderRadius: "5px",
              fontSize: "11px",
              backgroundColor: "#1e293b",
              color: copiedMode === "plain" ? "#4ade80" : "#e2e8f0",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: copiedMode === "plain" ? "#22c55e" : "#334155",
              cursor: "pointer",
            }}
          >
            <Copy size={11} />
            {copiedMode === "plain" ? "Copied" : "Copy Plain"}
          </button>
          <button
            type="button"
            onClick={() => handleCopy("ansi")}
            title="Copy raw ANSI escape sequences for terminal playback"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 8px",
              borderRadius: "5px",
              fontSize: "11px",
              fontFamily: MONO_FONT,
              backgroundColor: "#1e293b",
              color: copiedMode === "ansi" ? "#4ade80" : "#cbd5e1",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: copiedMode === "ansi" ? "#22c55e" : "#334155",
              cursor: "pointer",
            }}
          >
            <Copy size={11} />
            {copiedMode === "ansi" ? "Copied ANSI" : "ANSI"}
          </button>
          <button
            type="button"
            onClick={() => handleCopy("options")}
            title="Copy full CLI command with --options flags"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 8px",
              borderRadius: "5px",
              fontSize: "11px",
              fontFamily: MONO_FONT,
              backgroundColor: "#1e293b",
              color: copiedMode === "options" ? "#4ade80" : "#fcd34d",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: copiedMode === "options" ? "#22c55e" : "#334155",
              cursor: "pointer",
            }}
          >
            <Copy size={11} />
            {copiedMode === "options" ? "Copied CLI" : "Copy --options"}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            title="Export rendered Bun.inspect report (.txt)"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 8px",
              borderRadius: "5px",
              fontSize: "11px",
              backgroundColor: "#1e293b",
              color: "#e2e8f0",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              cursor: "pointer",
            }}
          >
            <Download size={11} />
            Export
          </button>
          {(onRunTerminalCommand || onOpenTerminalProfile) && (
            <button
              type="button"
              onClick={handleRunInTerminal}
              title={`Execute "${cliCommand}" in the interactive PTY terminal`}
              style={{
                padding: "4px 9px",
                borderRadius: "5px",
                fontSize: "11px",
                fontWeight: 600,
                backgroundColor: "rgba(56, 189, 248, 0.14)",
                color: "#7dd3fc",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "rgba(56, 189, 248, 0.4)",
                cursor: "pointer",
              }}
            >
              Run in Terminal ↗
            </button>
          )}
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={contextMenu !== null}
            data-profiles-inspect-menu-trigger="true"
            onClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              if (contextMenu) {
                setContextMenu(null)
              } else {
                openContextMenuAt(rect.right - 236, rect.bottom + 6)
              }
            }}
            title={`Quick actions for ${targetCustomerId} (or right-click anywhere on this card)`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              padding: "4px 7px",
              borderRadius: "5px",
              fontSize: "11px",
              fontWeight: 600,
              backgroundColor: contextMenu !== null ? "rgba(56, 189, 248, 0.2)" : "#1e293b",
              color: contextMenu !== null ? "#7dd3fc" : "#cbd5e1",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: contextMenu !== null ? "rgba(56, 189, 248, 0.5)" : "#334155",
              cursor: "pointer",
            }}
          >
            <MoreVertical size={12} />
            Actions
          </button>
        </div>
      </div>

      {/* Full Bun.inspect.options Control Strip */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "8px 12px",
          padding: "7px 14px",
          backgroundColor: "#0a1120",
          borderBottomWidth: "1px",
          borderBottomStyle: "solid",
          borderBottomColor: "#172033",
          fontSize: "11px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontFamily: MONO_FONT,
              fontSize: "10px",
              fontWeight: 700,
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Bun.inspect.options
          </span>
          {(
            [
              {
                label: "colors",
                checked: inspectColors,
                set: setInspectColors,
                title: "Toggle ANSI color formatting (--colors / --no-color)",
              },
              {
                label: "compact",
                checked: inspectCompact,
                set: setInspectCompact,
                title: "Compact single-line / dense output (--compact)",
              },
              {
                label: "sorted",
                checked: inspectSorted,
                set: setInspectSorted,
                title: "Sort keys / rows alphabetically (--sorted)",
              },
              {
                label: "showHidden",
                checked: inspectShowHidden,
                set: setInspectShowHidden,
                title: "Reveal provenance, unknown fields & sub-account metadata (--show-hidden)",
              },
              {
                label: "numericSeparator",
                checked: inspectNumericSeparator,
                set: setInspectNumericSeparator,
                title: "Format large USD / volume figures with _ separators (--numeric-separator)",
              },
              {
                label: "getters",
                checked: inspectGetters,
                set: setInspectGetters,
                title: "Evaluate computed Bayesian / Kelly & risk getters (--getters)",
              },
              {
                label: "--options",
                checked: inspectShowOptions,
                set: setInspectShowOptions,
                title: "Append resolved Bun.inspect.options diagnostic footer (--options)",
              },
            ] as const
          ).map((opt) => (
            <label
              key={opt.label}
              title={opt.title}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                color: opt.checked ? "#e2e8f0" : "#94a3b8",
                fontFamily: MONO_FONT,
                fontSize: "11px",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <input
                type="checkbox"
                checked={opt.checked}
                onChange={(e) => opt.set(e.target.checked)}
              />
              {opt.label}
            </label>
          ))}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          {/* Depth segmented control d1..d4 */}
          <div
            role="group"
            aria-label="Bun.inspect depth level"
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: "5px",
              overflow: "hidden",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "#334155",
              backgroundColor: "#070b14",
            }}
          >
            <span
              style={{
                padding: "3px 6px",
                fontSize: "10px",
                fontFamily: MONO_FONT,
                color: "#64748b",
                borderRightWidth: "1px",
                borderRightStyle: "solid",
                borderRightColor: "#1e293b",
              }}
            >
              depth
            </span>
            {([1, 2, 3, 4] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setInspectDepth(d)}
                title={
                  d === 1
                    ? "Depth 1: Summary + directives + top rows"
                    : d === 2
                      ? "Depth 2: 5-axis sharpness radar + capital protection + cohort breakdown"
                      : d === 3
                        ? "Depth 3: Portal reconciliation + syndicate hotspots + deep forensics"
                        : "Depth 4: Full expanded inspect tree + hidden provenance"
                }
                style={{
                  padding: "3px 7px",
                  fontSize: "11px",
                  fontWeight: inspectDepth === d ? 700 : 500,
                  fontFamily: MONO_FONT,
                  backgroundColor: inspectDepth === d ? "rgba(56, 189, 248, 0.2)" : "transparent",
                  color: inspectDepth === d ? "#7dd3fc" : "#94a3b8",
                  borderWidth: 0,
                  cursor: "pointer",
                }}
              >
                d{d}
              </button>
            ))}
          </div>

          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontFamily: MONO_FONT,
              fontSize: "10.5px",
              color: "#94a3b8",
            }}
            title="Maximum rows/items rendered before truncation (--max-array-length)"
          >
            maxArr
            <select
              value={inspectMaxArrayLength}
              onChange={(e) => setInspectMaxArrayLength(Number(e.target.value))}
              style={{
                backgroundColor: "#070b14",
                color: "#e2e8f0",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
                borderRadius: "4px",
                padding: "2px 4px",
                fontFamily: MONO_FONT,
                fontSize: "10.5px",
              }}
            >
              {[10, 20, 35, 50].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>

          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              fontFamily: MONO_FONT,
              fontSize: "10.5px",
              color: "#94a3b8",
            }}
            title="Line-wrap / box width target in columns (--break-length)"
          >
            cols
            <select
              value={inspectBreakLength}
              onChange={(e) => setInspectBreakLength(Number(e.target.value))}
              style={{
                backgroundColor: "#070b14",
                color: "#e2e8f0",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#334155",
                borderRadius: "4px",
                padding: "2px 4px",
                fontFamily: MONO_FONT,
                fontSize: "10.5px",
              }}
            >
              {[76, 96, 116].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Dual Invocation Bar: JS Bun.inspect() + CLI --options */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          padding: "7px 14px",
          backgroundColor: "#070d19",
          borderBottomWidth: "1px",
          borderBottomStyle: "solid",
          borderBottomColor: "#172033",
          fontFamily: MONO_FONT,
          fontSize: "10.5px",
          color: "#94a3b8",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "#38bdf8", overflowWrap: "anywhere" }}>$ {jsInvocation}</span>
          <span
            style={{
              color: "#64748b",
              whiteSpace: "nowrap",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {inspectStats.lines} lines · {inspectStats.bytes.toLocaleString()} B ansi ·
            Symbol.for("Bun.inspect.custom")
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <span style={{ color: "#fcd34d", overflowWrap: "anywhere" }}>cli&gt; {cliCommand}</span>
          {error && <span style={{ color: "#fca5a5" }}>Error: {error}</span>}
        </div>
      </div>

      <pre className="sd-bun-fmt-pre sd-bun-fmt-wrap" data-bun-fmt-diagnostic="true">
        {activeAnsi
          ? renderAnsiReact(activeAnsi)
          : "Rendering ProfileView[Bun.inspect.custom] output..."}
      </pre>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          role="menu"
          aria-label={`Quick actions for ${targetCustomerId}`}
          data-profiles-inspect-context-menu="true"
          className="sd-card-context-menu"
          style={{
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              padding: "5px 9px 7px",
              marginBottom: "4px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "rgba(30, 41, 59, 0.9)",
              fontFamily: MONO_FONT,
              fontSize: "10px",
              fontWeight: 700,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "#94a3b8",
            }}
          >
            <span>Profile · {targetCustomerId}</span>
            {isFlaggedForReview && <span style={{ color: "#fbbf24" }}>FLAGGED</span>}
          </div>

          <button
            type="button"
            role="menuitem"
            className="sd-card-context-menu-item"
            onClick={handleCopyId}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <Copy size={13} style={{ color: "#38bdf8" }} />
              <span>Copy ID</span>
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: "10px",
                color: "#64748b",
              }}
            >
              {targetCustomerId}
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="sd-card-context-menu-item"
            onClick={handleInspectInTerminal}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <Terminal size={13} style={{ color: "#38bdf8" }} />
              <span>Inspect in Terminal</span>
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: "10px",
                color: "#64748b",
              }}
            >
              PTY ↗
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="sd-card-context-menu-item sd-card-context-menu-item--amber"
            onClick={handleToggleFlagForReview}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <Flag size={13} style={{ color: isFlaggedForReview ? "#fbbf24" : "#f59e0b" }} />
              <span>{isFlaggedForReview ? "Remove Review Flag" : "Flag for Review"}</span>
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: "10px",
                color: isFlaggedForReview ? "#fbbf24" : "#64748b",
              }}
            >
              {isFlaggedForReview ? "ON" : "TAG"}
            </span>
          </button>

          <div
            role="separator"
            style={{
              height: "1px",
              margin: "5px 4px",
              backgroundColor: "rgba(30, 41, 59, 0.9)",
            }}
          />

          <button
            type="button"
            role="menuitem"
            className="sd-card-context-menu-item"
            onClick={handleInspectRadarInTerminal}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <Activity size={13} style={{ color: "#a78bfa" }} />
              <span>Inspect Radar in Terminal</span>
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: "10px",
                color: "#64748b",
              }}
            >
              --radar
            </span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="sd-card-context-menu-item"
            onClick={() => {
              handleCopy("options")
              showFeedback("Copied CLI --options command")
              setContextMenu(null)
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
              <Copy size={13} style={{ color: "#fcd34d" }} />
              <span>Copy --options CLI</span>
            </span>
            <span
              style={{
                fontFamily: MONO_FONT,
                fontSize: "10px",
                color: "#64748b",
              }}
            >
              CLI
            </span>
          </button>
        </div>
      )}
    </div>
  )
}
