import React, { useEffect, useMemo, useState } from "react"
import { Check, Copy, Play, RefreshCw, ShieldCheck, Terminal, X } from "lucide-react"

import { validateApiBase } from "../api_base_validation.ts"
import {
  BUN_RUNTIME_RELEASE_ENHANCEMENTS,
  BUN_RUNTIME_UTILS_EXTENDED,
  BUN_UTILITIES_CATALOG,
  type BunUtilityCategory,
  type CompressionProbeResult,
  compressDeflateText,
  compressGzipText,
  compressZstdText,
  decodeBase64Utf8,
  deepEqualsSafe,
  deepMatchSafe,
  encodeBase64Utf8,
  escapeHtmlSafe,
  fileUrlToPathSafe,
  findAllowlistedExecutable,
  generateUuidV5,
  generateUuidV7,
  hashPasswordPreview,
  inspectModuleMetaSnapshot,
  parseXmlSafe,
  pathToFileUrlSafe,
  resolveSpaDecoupleStatus,
  sleepMs,
  stringifyXmlSafe,
  type SpaDecoupleStatus,
} from "../bun_utilities.ts"
import { copyText } from "../clipboard.ts"
import { BRAND_ASSETS } from "../operator_profiles.ts"

export interface BunUtilitiesDecouplePanelProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly status?: SpaDecoupleStatus | undefined
  readonly serverRuntimeEngine?: string | null | undefined
}

const CATEGORY_LABELS: ReadonlyArray<{
  readonly id: "all" | BunUtilityCategory
  readonly label: string
}> = [
  { id: "all", label: "All (19)" },
  { id: "runtime", label: "Runtime & Sleep" },
  { id: "crypto-encoding", label: "Crypto & Base64" },
  { id: "compression", label: "Gzip & DEFLATE" },
  { id: "strings-equality", label: "HTML & Equality" },
  { id: "paths-shell", label: "Paths & Which" },
  { id: "module-meta", label: "import.meta & Main" },
]

const API_BASE_PRESETS: readonly string[] = [
  "https://api.bookdeskops.com//v2///",
  "http://127.0.0.1:4022/api/",
  "https://staging.bookdeskops.com",
  "https://api.bookdeskops.com\\v2",
  "http://127.0.0.1:0",
]

export function BunUtilitiesDecouplePanel({
  open,
  onClose,
  status: statusProp,
  serverRuntimeEngine,
}: BunUtilitiesDecouplePanelProps): React.ReactElement | null {
  const status = useMemo(() => statusProp ?? resolveSpaDecoupleStatus(), [statusProp])
  const moduleMeta = useMemo(() => inspectModuleMetaSnapshot(), [])

  const [category, setCategory] = useState<"all" | BunUtilityCategory>("all")
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Hardened API base validator tester
  const [apiBaseCandidate, setApiBaseCandidate] = useState<string>(
    "https://api.bookdeskops.com//v2///",
  )
  const [allowLocalDevTest, setAllowLocalDevTest] = useState<boolean>(status.isLocalDev)
  const apiBaseResult = useMemo(
    () => validateApiBase(apiBaseCandidate, allowLocalDevTest),
    [apiBaseCandidate, allowLocalDevTest],
  )

  // Live utility workbench states
  const [uuidValue, setUuidValue] = useState<string>(() => generateUuidV7())
  const [uuidV5Value, setUuidV5Value] = useState<string>("")
  const [base64Raw, setBase64Raw] = useState<string>("SportsDesk Ops · Bun 1.4.4")
  const [htmlInput, setHtmlInput] = useState<string>('<img src=x onerror="alert(1)"> & "ops"')
  const [eqLeft, setEqLeft] = useState<string>('{"port":4022,"decoupled":true}')
  const [eqRight, setEqRight] = useState<string>('{"decoupled":true,"port":4022}')
  const [eqStrict, setEqStrict] = useState<boolean>(true)
  const [pathInput, setPathInput] = useState<string>("/app/packages/api/src/bun_server.ts")
  const [whichBin, setWhichBin] = useState<string>("bun")
  const [compressSample, setCompressSample] = useState<string>(
    "sportsdesk-ops telemetry payload ".repeat(12),
  )
  const [gzipResult, setGzipResult] = useState<CompressionProbeResult | null>(null)
  const [deflateResult, setDeflateResult] = useState<CompressionProbeResult | null>(null)
  const [zstdResult, setZstdResult] = useState<CompressionProbeResult | null>(null)
  const [sleepActualMs, setSleepActualMs] = useState<number | null>(null)
  const [sleepRunning, setSleepRunning] = useState<boolean>(false)
  const [pwInput, setPwInput] = useState<string>("desk-demo-passphrase")
  const [pwResult, setPwResult] = useState<{
    readonly algorithm: string
    readonly hash: string
    readonly serverSideNote: string
  } | null>(null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    let active = true
    void generateUuidV5(status.apiBaseUrl).then((v5) => {
      if (active) setUuidV5Value(v5)
    })
    return () => {
      active = false
    }
  }, [open, status.apiBaseUrl])

  useEffect(() => {
    if (!open) return
    let active = true
    void Promise.all([
      compressGzipText(compressSample),
      compressDeflateText(compressSample),
      compressZstdText(compressSample),
    ]).then(([gz, df, zs]) => {
      if (!active) return
      setGzipResult(gz)
      setDeflateResult(df)
      setZstdResult(zs)
    })
    return () => {
      active = false
    }
  }, [open, compressSample])

  const base64Encoded = useMemo(() => {
    try {
      return encodeBase64Utf8(base64Raw)
    } catch {
      return ""
    }
  }, [base64Raw])

  const base64RoundTrip = useMemo(() => {
    try {
      return base64Encoded ? decodeBase64Utf8(base64Encoded) : ""
    } catch {
      return ""
    }
  }, [base64Encoded])

  const escapedHtml = useMemo(() => escapeHtmlSafe(htmlInput), [htmlInput])

  const deepEqSummary = useMemo(() => {
    try {
      const a: unknown = JSON.parse(eqLeft)
      const b: unknown = JSON.parse(eqRight)
      return {
        ok: true as const,
        equal: deepEqualsSafe(a, b, eqStrict),
        match: deepMatchSafe(a, b),
      }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid JSON",
      }
    }
  }, [eqLeft, eqRight, eqStrict])

  const fileUrlRoundTrip = useMemo(() => {
    try {
      const url = pathToFileUrlSafe(pathInput)
      const back = fileUrlToPathSafe(url)
      return { ok: true as const, url, back }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid path",
      }
    }
  }, [pathInput])

  const whichProbe = useMemo(() => findAllowlistedExecutable(whichBin), [whichBin])

  const brandXmlSample = useMemo(
    () =>
      stringifyXmlSafe(
        "sportsdesk",
        {
          brand: BRAND_ASSETS.monogram,
          version: BRAND_ASSETS.version,
          tokens: BRAND_ASSETS.tokensVersion,
          domain: BRAND_ASSETS.domainContext,
        },
        BRAND_ASSETS.shortName,
      ),
    [],
  )

  const xmlProbe = useMemo(() => parseXmlSafe(brandXmlSample), [brandXmlSample])

  const visibleUtilities = useMemo(
    () =>
      category === "all"
        ? BUN_UTILITIES_CATALOG
        : BUN_UTILITIES_CATALOG.filter((u) => u.category === category),
    [category],
  )

  if (!open) return null

  const handleCopy = (id: string, text: string) => {
    void copyText(text).then(() => {
      setCopiedId(id)
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev))
      }, 1500)
    })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${BRAND_ASSETS.shortName} — SPA Origin Decoupling, Meta & Bun Runtime Utilities`}
      data-bun-utilities-decouple-panel="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        backgroundColor: "rgba(2, 6, 23, 0.72)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        data-brand-name={BRAND_ASSETS.shortName}
        data-brand-version={BRAND_ASSETS.version}
        data-brand-domain={BRAND_ASSETS.domainContext}
        data-tokens-version={BRAND_ASSETS.tokensVersion}
        style={{
          width: "min(980px, 100%)",
          maxHeight: "min(88vh, 860px)",
          overflowY: "auto",
          borderRadius: "12px",
          backgroundColor: "var(--sd-surface-card, #0f172a)",
          color: "var(--sd-text-primary, #e2e8f0)",
          border: "1px solid var(--sd-border-subtle, #334155)",
          boxShadow: "0 24px 64px rgba(0, 0, 0, 0.55)",
          padding: "18px 20px",
          display: "flex",
          flexDirection: "column",
          gap: "16px",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "12px",
            borderBottom: "1px solid var(--sd-border-subtle, #1e293b)",
            paddingBottom: "12px",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <img
                src={BRAND_ASSETS.emblemPng64}
                alt={BRAND_ASSETS.emblemAlt}
                width={20}
                height={20}
                style={{
                  width: "20px",
                  height: "20px",
                  borderRadius: "4px",
                  objectFit: "cover",
                  border: "1px solid rgba(56, 189, 248, 0.35)",
                  flexShrink: 0,
                }}
              />
              <Terminal size={15} style={{ color: "#38bdf8" }} aria-hidden="true" />
              <h2
                data-brand-version={BRAND_ASSETS.version}
                data-brand-domain={BRAND_ASSETS.domainContext}
                style={{ margin: 0, fontSize: "15px", fontWeight: 700 }}
              >
                {BRAND_ASSETS.shortName} — SPA Decoupling &amp; Bun Runtime Utilities (
                {BUN_UTILITIES_CATALOG.length}+{BUN_RUNTIME_UTILS_EXTENDED.length})
              </h2>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background: "rgba(52, 211, 153, 0.14)",
                  color: "#34d399",
                  border: "1px solid rgba(52, 211, 153, 0.35)",
                }}
              >
                {BRAND_ASSETS.version}
              </span>
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: "999px",
                  background:
                    status.mode === "override-rejected"
                      ? "rgba(239, 68, 68, 0.18)"
                      : "rgba(56, 189, 248, 0.16)",
                  color: status.mode === "override-rejected" ? "#f87171" : "#38bdf8",
                  border:
                    status.mode === "override-rejected"
                      ? "1px solid rgba(239, 68, 68, 0.4)"
                      : "1px solid rgba(56, 189, 248, 0.35)",
                }}
              >
                {status.mode}
              </span>
            </div>
            <p style={{ margin: 0, fontSize: "12px", color: "var(--sd-text-muted, #94a3b8)" }}>
              {BRAND_ASSETS.organization} · domain <code>{BRAND_ASSETS.domainContext}</code> ·
              tokens <code>v{BRAND_ASSETS.tokensVersion}</code> · <code>import.meta</code> &amp;{" "}
              <code>Bun.XML</code> (<code>parse</code>/<code>stringify</code>) — {status.summary}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${BRAND_ASSETS.shortName} runtime utilities panel`}
            style={{
              background: "transparent",
              border: "1px solid var(--sd-border-subtle, #334155)",
              color: "var(--sd-text-secondary, #cbd5e1)",
              borderRadius: "6px",
              padding: "6px",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Section 1: Decoupled SPA Origin & Hardened API Base Validator */}
        <section
          aria-label="SPA origin decoupling and hardened API base validation"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
            gap: "12px",
            padding: "12px",
            borderRadius: "8px",
            backgroundColor: "var(--sd-surface-elevated, rgba(15, 23, 42, 0.65))",
            border: "1px solid var(--sd-border-subtle, #1e293b)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700 }}>
              <ShieldCheck size={14} style={{ color: "#34d399" }} aria-hidden="true" />
              <span>Decoupled Runtime Contract</span>
            </div>
            <div>
              <strong>SPA Origin:</strong> <code>{status.spaOrigin}</code>
            </div>
            <div>
              <strong>Resolved API Base:</strong> <code>{status.apiBaseUrl}</code>{" "}
              <span style={{ color: "var(--sd-text-muted, #94a3b8)" }}>({status.apiSource})</span>
            </div>
            <div>
              <strong>URLPattern Startup Gate:</strong>{" "}
              <span style={{ color: status.patternsCompiled ? "#34d399" : "#f59e0b" }}>
                {status.patternsCompiled
                  ? "hasRegExpGroups = true"
                  : "Fallback pure-URL guard active"}
              </span>
              {" · "}
              <span>Max Input: {status.maxInputLength} chars</span>
            </div>
            <div>
              <strong>Bun Detection:</strong>{" "}
              <code>
                {status.bun.available
                  ? `bun/${status.bun.version ?? "detected"} (${status.bun.detectedVia})`
                  : serverRuntimeEngine
                    ? `browser SPA · API ${serverRuntimeEngine}`
                    : "browser SPA (process.versions.bun absent)"}
              </code>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "12px" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <strong>Live ?apiBase= Hardened Validator</strong>
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  fontSize: "11px",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={allowLocalDevTest}
                  onChange={(e) => setAllowLocalDevTest(e.target.checked)}
                />
                Allow local dev loopback
              </label>
            </div>
            <input
              type="text"
              value={apiBaseCandidate}
              onChange={(e) => setApiBaseCandidate(e.target.value)}
              aria-label="Test API base URL"
              style={{
                width: "100%",
                padding: "6px 8px",
                borderRadius: "6px",
                fontSize: "12px",
                fontFamily: "monospace",
                backgroundColor: "var(--sd-surface-base, #020617)",
                color: "var(--sd-text-primary, #e2e8f0)",
                border: "1px solid var(--sd-border-subtle, #334155)",
              }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
              {API_BASE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setApiBaseCandidate(preset)}
                  style={{
                    fontSize: "10px",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    cursor: "pointer",
                    background: "var(--sd-surface-card, #1e293b)",
                    color: "var(--sd-text-secondary, #cbd5e1)",
                    border: "1px solid var(--sd-border-subtle, #334155)",
                  }}
                >
                  {preset}
                </button>
              ))}
            </div>
            <div
              data-api-base-test-result="true"
              style={{
                fontFamily: "monospace",
                fontSize: "11px",
                padding: "6px 8px",
                borderRadius: "6px",
                backgroundColor: apiBaseResult.ok
                  ? "rgba(16, 185, 129, 0.14)"
                  : "rgba(239, 68, 68, 0.14)",
                color: apiBaseResult.ok ? "#34d399" : "#f87171",
                border: apiBaseResult.ok
                  ? "1px solid rgba(16, 185, 129, 0.35)"
                  : "1px solid rgba(239, 68, 68, 0.35)",
              }}
            >
              {apiBaseResult.ok
                ? `VALID -> ${apiBaseResult.normalized}${apiBaseResult.sub ? ` (sub=${apiBaseResult.sub})` : ""}`
                : `REJECTED -> ${apiBaseResult.code}`}
            </div>
          </div>
        </section>

        {/* Section 2: Interactive Bun Utilities Workbench */}
        <section
          aria-label="Interactive Bun utilities workbench"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(270px, 1fr))",
            gap: "10px",
          }}
        >
          {/* UUIDv7 & Sleep */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid var(--sd-border-subtle, #1e293b)",
              backgroundColor: "var(--sd-surface-elevated, rgba(15, 23, 42, 0.5))",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              fontSize: "12px",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>UUIDv7 &amp; Bounded Sleep</strong>
              <div style={{ display: "flex", gap: "6px" }}>
                <button
                  type="button"
                  onClick={() => setUuidValue(generateUuidV7())}
                  style={{
                    fontSize: "11px",
                    padding: "2px 8px",
                    borderRadius: "5px",
                    cursor: "pointer",
                    background: "rgba(56, 189, 248, 0.16)",
                    color: "#38bdf8",
                    border: "1px solid rgba(56, 189, 248, 0.35)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <RefreshCw size={11} aria-hidden="true" /> UUIDv7
                </button>
                <button
                  type="button"
                  disabled={sleepRunning}
                  onClick={() => {
                    setSleepRunning(true)
                    void sleepMs(50).then((elapsed) => {
                      setSleepActualMs(elapsed)
                      setSleepRunning(false)
                    })
                  }}
                  style={{
                    fontSize: "11px",
                    padding: "2px 8px",
                    borderRadius: "5px",
                    cursor: sleepRunning ? "wait" : "pointer",
                    background: "rgba(16, 185, 129, 0.15)",
                    color: "#34d399",
                    border: "1px solid rgba(16, 185, 129, 0.35)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                  }}
                >
                  <Play size={11} aria-hidden="true" /> Sleep 50ms
                </button>
              </div>
            </div>
            <code style={{ fontSize: "11px", wordBreak: "break-all" }}>v7: {uuidValue}</code>
            {uuidV5Value && (
              <code
                style={{
                  fontSize: "10px",
                  color: "var(--sd-text-muted, #94a3b8)",
                  wordBreak: "break-all",
                }}
              >
                v5 (apiBase): {uuidV5Value}
              </code>
            )}
            <div style={{ fontSize: "11px", color: "var(--sd-text-muted, #94a3b8)" }}>
              {sleepActualMs !== null
                ? `Last Bun.sleep(50) elapsed: ${sleepActualMs}ms`
                : "Click Sleep 50ms to measure async timer resolution."}
            </div>
          </div>

          {/* Base64 & Password Hash */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid var(--sd-border-subtle, #1e293b)",
              backgroundColor: "var(--sd-surface-elevated, rgba(15, 23, 42, 0.5))",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              fontSize: "12px",
            }}
          >
            <strong>Base64 Encoding &amp; Password Hash</strong>
            <input
              type="text"
              value={base64Raw}
              onChange={(e) => setBase64Raw(e.target.value)}
              aria-label="Base64 UTF-8 input"
              style={{
                padding: "4px 6px",
                borderRadius: "5px",
                fontSize: "11px",
                backgroundColor: "var(--sd-surface-base, #020617)",
                color: "var(--sd-text-primary, #e2e8f0)",
                border: "1px solid var(--sd-border-subtle, #334155)",
              }}
            />
            <div style={{ fontSize: "11px", fontFamily: "monospace", wordBreak: "break-all" }}>
              b64: {base64Encoded} · decoded: {base64RoundTrip}
            </div>
            <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
              <input
                type="password"
                value={pwInput}
                onChange={(e) => setPwInput(e.target.value)}
                aria-label="Sample passphrase for hash preview"
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  borderRadius: "5px",
                  fontSize: "11px",
                  backgroundColor: "var(--sd-surface-base, #020617)",
                  color: "var(--sd-text-primary, #e2e8f0)",
                  border: "1px solid var(--sd-border-subtle, #334155)",
                }}
              />
              <button
                type="button"
                onClick={() => {
                  void hashPasswordPreview(pwInput).then((res) => setPwResult(res))
                }}
                style={{
                  fontSize: "11px",
                  padding: "3px 8px",
                  borderRadius: "5px",
                  cursor: "pointer",
                  background: "rgba(168, 85, 247, 0.16)",
                  color: "#c084fc",
                  border: "1px solid rgba(168, 85, 247, 0.35)",
                }}
              >
                Hash
              </button>
            </div>
            {pwResult && (
              <div
                style={{
                  fontSize: "10px",
                  fontFamily: "monospace",
                  color: "var(--sd-text-muted, #94a3b8)",
                  wordBreak: "break-all",
                }}
              >
                {pwResult.algorithm}: {pwResult.hash.slice(0, 60)}…
              </div>
            )}
          </div>

          {/* Gzip & DEFLATE Compression */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid var(--sd-border-subtle, #1e293b)",
              backgroundColor: "var(--sd-surface-elevated, rgba(15, 23, 42, 0.5))",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              fontSize: "12px",
            }}
          >
            <strong>Gzip, DEFLATE &amp; Zstd Compression</strong>
            <input
              type="text"
              value={compressSample}
              onChange={(e) => setCompressSample(e.target.value)}
              aria-label="Compression payload input"
              style={{
                padding: "4px 6px",
                borderRadius: "5px",
                fontSize: "11px",
                backgroundColor: "var(--sd-surface-base, #020617)",
                color: "var(--sd-text-primary, #e2e8f0)",
                border: "1px solid var(--sd-border-subtle, #334155)",
              }}
            />
            <div style={{ fontSize: "11px", fontFamily: "monospace" }}>
              GZIP:{" "}
              {gzipResult
                ? `${gzipResult.inputBytes}B -> ${gzipResult.outputBytes}B (${gzipResult.ratioPct}%, ${gzipResult.engine})`
                : "computing..."}
            </div>
            <div style={{ fontSize: "11px", fontFamily: "monospace" }}>
              DEFLATE:{" "}
              {deflateResult
                ? `${deflateResult.inputBytes}B -> ${deflateResult.outputBytes}B (${deflateResult.ratioPct}%, ${deflateResult.engine})`
                : "computing..."}
            </div>
            <div style={{ fontSize: "11px", fontFamily: "monospace" }}>
              ZSTD:{" "}
              {zstdResult
                ? zstdResult.engine === "unavailable"
                  ? "server-side Bun 1.4.4 Accept-Encoding: zstd"
                  : `${zstdResult.inputBytes}B -> ${zstdResult.outputBytes}B (${zstdResult.ratioPct}%, ${zstdResult.engine})`
                : "computing..."}
            </div>
          </div>

          {/* Escape HTML & Deep Equality */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid var(--sd-border-subtle, #1e293b)",
              backgroundColor: "var(--sd-surface-elevated, rgba(15, 23, 42, 0.5))",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              fontSize: "12px",
            }}
          >
            <strong>Escape HTML &amp; Deep Equality</strong>
            <input
              type="text"
              value={htmlInput}
              onChange={(e) => setHtmlInput(e.target.value)}
              aria-label="HTML string to escape"
              style={{
                padding: "4px 6px",
                borderRadius: "5px",
                fontSize: "11px",
                fontFamily: "monospace",
                backgroundColor: "var(--sd-surface-base, #020617)",
                color: "var(--sd-text-primary, #e2e8f0)",
                border: "1px solid var(--sd-border-subtle, #334155)",
              }}
            />
            <code style={{ fontSize: "11px", color: "#34d399", wordBreak: "break-all" }}>
              {escapedHtml}
            </code>
            <div style={{ display: "flex", gap: "6px" }}>
              <input
                type="text"
                value={eqLeft}
                onChange={(e) => setEqLeft(e.target.value)}
                aria-label="Deep equality left JSON"
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  borderRadius: "5px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  backgroundColor: "var(--sd-surface-base, #020617)",
                  color: "var(--sd-text-primary, #e2e8f0)",
                  border: "1px solid var(--sd-border-subtle, #334155)",
                }}
              />
              <input
                type="text"
                value={eqRight}
                onChange={(e) => setEqRight(e.target.value)}
                aria-label="Deep equality right JSON"
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  borderRadius: "5px",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  backgroundColor: "var(--sd-surface-base, #020617)",
                  color: "var(--sd-text-primary, #e2e8f0)",
                  border: "1px solid var(--sd-border-subtle, #334155)",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <input
                  type="checkbox"
                  checked={eqStrict}
                  onChange={(e) => setEqStrict(e.target.checked)}
                />
                strict
              </label>
              <span
                style={{
                  fontFamily: "monospace",
                  color: deepEqSummary.ok
                    ? deepEqSummary.equal
                      ? "#34d399"
                      : "#f59e0b"
                    : "#f87171",
                }}
              >
                {deepEqSummary.ok
                  ? `deepEquals=${String(deepEqSummary.equal)} · deepMatch=${String(deepEqSummary.match)}`
                  : deepEqSummary.error}
              </span>
            </div>
          </div>

          {/* File URL <-> Path & Which */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid var(--sd-border-subtle, #1e293b)",
              backgroundColor: "var(--sd-surface-elevated, rgba(15, 23, 42, 0.5))",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              fontSize: "12px",
            }}
          >
            <strong>File URL ↔ Path &amp; Find Executable</strong>
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              aria-label="Filesystem path for fileURL conversion"
              style={{
                padding: "4px 6px",
                borderRadius: "5px",
                fontSize: "11px",
                fontFamily: "monospace",
                backgroundColor: "var(--sd-surface-base, #020617)",
                color: "var(--sd-text-primary, #e2e8f0)",
                border: "1px solid var(--sd-border-subtle, #334155)",
              }}
            />
            <div style={{ fontSize: "11px", fontFamily: "monospace", wordBreak: "break-all" }}>
              {fileUrlRoundTrip.ok
                ? `${fileUrlRoundTrip.url} -> ${fileUrlRoundTrip.back}`
                : fileUrlRoundTrip.error}
            </div>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", fontSize: "11px" }}>
              <span>Bun.which:</span>
              {(["bun", "node", "git"] as const).map((bin) => (
                <button
                  key={bin}
                  type="button"
                  onClick={() => setWhichBin(bin)}
                  style={{
                    padding: "2px 6px",
                    borderRadius: "4px",
                    fontSize: "10px",
                    cursor: "pointer",
                    background:
                      whichBin === bin ? "rgba(56, 189, 248, 0.2)" : "var(--sd-surface-card, #1e293b)",
                    color: whichBin === bin ? "#38bdf8" : "var(--sd-text-secondary, #cbd5e1)",
                    border: "1px solid var(--sd-border-subtle, #334155)",
                  }}
                >
                  {bin}
                </button>
              ))}
              <code style={{ fontSize: "10px", color: "var(--sd-text-muted, #94a3b8)" }}>
                {whichProbe.resolvedPath ?? `(${whichProbe.runtime})`}
              </code>
            </div>
          </div>

          {/* import.meta & Entrypoint */}
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "8px",
              border: "1px solid var(--sd-border-subtle, #1e293b)",
              backgroundColor: "var(--sd-surface-elevated, rgba(15, 23, 42, 0.5))",
              display: "flex",
              flexDirection: "column",
              gap: "4px",
              fontSize: "11px",
              fontFamily: "monospace",
            }}
          >
            <strong style={{ fontFamily: "inherit", fontSize: "12px", marginBottom: "2px" }}>
              import.meta, Brand Meta &amp; Bun.XML
            </strong>
            <div>dir: {moduleMeta.importMetaDir}</div>
            <div>file: {moduleMeta.importMetaFile}</div>
            <div style={{ wordBreak: "break-all" }}>path: {moduleMeta.importMetaPath}</div>
            <div>import.meta.main: {String(moduleMeta.importMetaMain)}</div>
            <div style={{ wordBreak: "break-all" }}>
              Bun.main: {moduleMeta.bunMain ?? "(browser SPA bundle)"}
            </div>
            <div style={{ wordBreak: "break-all", color: "#34d399" }}>
              Bun.XML ({xmlProbe.engine}): {xmlProbe.roundTrip ?? brandXmlSample}
            </div>
          </div>
        </section>

        {/* Section 3: Complete 19-Utility Reference Catalog */}
        <section aria-label="Complete Bun utilities reference catalog">
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "6px",
              marginBottom: "10px",
              alignItems: "center",
            }}
          >
            {CATEGORY_LABELS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setCategory(tab.id)}
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  padding: "4px 10px",
                  borderRadius: "6px",
                  cursor: "pointer",
                  background:
                    category === tab.id
                      ? "rgba(56, 189, 248, 0.18)"
                      : "var(--sd-surface-elevated, #1e293b)",
                  color: category === tab.id ? "#38bdf8" : "var(--sd-text-secondary, #cbd5e1)",
                  border:
                    category === tab.id
                      ? "1px solid rgba(56, 189, 248, 0.45)"
                      : "1px solid var(--sd-border-subtle, #334155)",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))",
              gap: "8px",
            }}
          >
            {visibleUtilities.map((util) => (
              <div
                key={util.id}
                data-bun-utility-id={util.id}
                style={{
                  padding: "9px 11px",
                  borderRadius: "7px",
                  border: "1px solid var(--sd-border-subtle, #1e293b)",
                  backgroundColor: "var(--sd-surface-base, rgba(2, 6, 23, 0.55))",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span style={{ fontSize: "12px", fontWeight: 700 }}>{util.title}</span>
                  <button
                    type="button"
                    onClick={() => handleCopy(util.id, util.snippet)}
                    title={`Copy ${util.title} snippet`}
                    style={{
                      background: "transparent",
                      border: "1px solid var(--sd-border-subtle, #334155)",
                      color: copiedId === util.id ? "#34d399" : "var(--sd-text-muted, #94a3b8)",
                      borderRadius: "4px",
                      padding: "2px 5px",
                      fontSize: "10px",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "3px",
                    }}
                  >
                    {copiedId === util.id ? (
                      <>
                        <Check size={10} aria-hidden="true" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy size={10} aria-hidden="true" /> Copy
                      </>
                    )}
                  </button>
                </div>
                <code style={{ fontSize: "11px", color: "#38bdf8", wordBreak: "break-word" }}>
                  {util.bunApi}
                </code>
                <div style={{ fontSize: "11px", color: "var(--sd-text-muted, #94a3b8)" }}>
                  {util.summary}
                </div>
                <div style={{ fontSize: "10px", color: "var(--sd-text-secondary, #cbd5e1)" }}>
                  Fallback: {util.browserFallback}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Section 4: Bun Runtime Release Guarantees (Bundler, --isolate, S3, Streams, TextDecoder) */}
        <section
          aria-label="Bun runtime release guarantees"
          data-bun-runtime-release-guarantees="true"
          style={{
            borderTop: "1px solid var(--sd-border-subtle, #1e293b)",
            paddingTop: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 700 }}>
            Bun Runtime Release Guarantees ({BUN_RUNTIME_RELEASE_ENHANCEMENTS.length})
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "8px",
            }}
          >
            {BUN_RUNTIME_RELEASE_ENHANCEMENTS.map((item) => (
              <div
                key={item.id}
                data-bun-release-item={item.id}
                style={{
                  padding: "8px 10px",
                  borderRadius: "7px",
                  border: "1px solid var(--sd-border-subtle, #1e293b)",
                  backgroundColor: "var(--sd-surface-elevated, rgba(15, 23, 42, 0.45))",
                  display: "flex",
                  flexDirection: "column",
                  gap: "3px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <span
                    style={{
                      fontSize: "10px",
                      fontWeight: 700,
                      padding: "1px 6px",
                      borderRadius: "4px",
                      backgroundColor: "rgba(56, 189, 248, 0.14)",
                      color: "#38bdf8",
                    }}
                  >
                    {item.area}
                  </span>
                  <span style={{ fontSize: "11px", fontWeight: 700 }}>{item.title}</span>
                </div>
                <div style={{ fontSize: "11px", color: "var(--sd-text-muted, #94a3b8)" }}>
                  {item.detail}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Section 5: Wired Bun utils.md Hot-Path Primitives */}
        <section
          aria-label="Wired Bun utils.md hot-path primitives"
          data-bun-runtime-utils-extended="true"
          style={{
            borderTop: "1px solid var(--sd-border-subtle, #1e293b)",
            paddingTop: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ fontSize: "12px", fontWeight: 700 }}>
            Wired utils.md Hot-Path Primitives ({BUN_RUNTIME_UTILS_EXTENDED.length})
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
              gap: "8px",
            }}
          >
            {BUN_RUNTIME_UTILS_EXTENDED.map((item) => (
              <div
                key={item.id}
                data-bun-extended-util={item.id}
                style={{
                  padding: "8px 10px",
                  borderRadius: "7px",
                  border: "1px solid var(--sd-border-subtle, #1e293b)",
                  backgroundColor: "var(--sd-surface-base, rgba(2, 6, 23, 0.5))",
                  display: "flex",
                  flexDirection: "column",
                  gap: "3px",
                }}
              >
                <code style={{ fontSize: "11px", color: "#34d399", fontWeight: 700 }}>
                  {item.bunApi}
                </code>
                <div style={{ fontSize: "10px", color: "#38bdf8" }}>{item.wiredIn}</div>
                <div style={{ fontSize: "11px", color: "var(--sd-text-muted, #94a3b8)" }}>
                  {item.summary}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
