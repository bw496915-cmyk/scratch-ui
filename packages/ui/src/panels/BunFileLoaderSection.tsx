import { Check, Copy, FileCode2, HardDrive, Layers, Terminal } from "lucide-react"
import type React from "react"
import { useMemo, useState } from "react"

import {
  buildBunAssetPipelineSnippets,
  BUN_ASSET_LOADER_COMPARISON,
  BUN_ASSET_LOADER_SPECS,
  BUN_FILE_BLOB_CONSUMERS,
  BUN_FILE_PROPERTIES,
  type BunAssetBuildTarget,
  type BunFileLoaderLiveProbe,
  DEFAULT_BUN_FILE_LOADER_PIPELINE,
} from "@sportsdesk-ops/contracts"

import { formatBytes } from "../format_bytes.ts"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

export interface BunFileLoaderSectionProps {
  readonly probe?: BunFileLoaderLiveProbe | null | undefined
}

type CodeTabId = "runtime" | "build-api" | "cli" | "ci" | "dist-tree"

export function BunFileLoaderSection({
  probe = null,
}: BunFileLoaderSectionProps): React.ReactElement {
  const [enabledLoaderIds, setEnabledLoaderIds] = useState<readonly string[]>(
    DEFAULT_BUN_FILE_LOADER_PIPELINE.enabledLoaderIds,
  )
  const [target, setTarget] = useState<BunAssetBuildTarget>("bun")
  const [compileMode, setCompileMode] = useState<boolean>(false)
  const [includeMetafile, setIncludeMetafile] = useState<boolean>(true)
  const [externalSourcemap, setExternalSourcemap] = useState<boolean>(true)
  const [codeTab, setCodeTab] = useState<CodeTabId>("runtime")
  const [activeConsumerId, setActiveConsumerId] = useState<string>(
    BUN_FILE_BLOB_CONSUMERS[0]?.id ?? "http-response",
  )
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const pipeline = useMemo(
    () =>
      buildBunAssetPipelineSnippets({
        enabledLoaderIds,
        target,
        compileMode,
        includeMetafile,
        externalSourcemap,
      }),
    [enabledLoaderIds, target, compileMode, includeMetafile, externalSourcemap],
  )

  const toggleLoader = (id: string) => {
    setEnabledLoaderIds((prev) => {
      if (prev.includes(id)) {
        if (prev.length <= 1) return prev
        return prev.filter((item) => item !== id)
      }
      return [...prev, id]
    })
  }

  const activeCodeText = useMemo(() => {
    switch (codeTab) {
      case "runtime":
        return pipeline.runtimeAppTs
      case "build-api":
        return pipeline.buildApiTs
      case "cli":
        return compileMode ? pipeline.compileCommand : pipeline.cliCommand
      case "ci":
        return pipeline.ciPackageJson
      case "dist-tree":
        return pipeline.distTree
    }
  }, [codeTab, compileMode, pipeline])

  const activeConsumer = useMemo(
    () =>
      BUN_FILE_BLOB_CONSUMERS.find((c) => c.id === activeConsumerId) ?? BUN_FILE_BLOB_CONSUMERS[0]!,
    [activeConsumerId],
  )

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedKey(key)
      setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1800)
    } catch {
      setCopiedKey(null)
    }
  }

  const sample = probe?.sampleAsset ?? null

  return (
    <div
      data-runtime-view="file-loader"
      data-bun-file-loader="true"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* 1. Live BunFile / Blob / Bun.embeddedFiles Probe Strip */}
      <div
        data-file-loader-live-probe="true"
        style={{
          borderRadius: "8px",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--border-default, #1e293b)",
          backgroundColor: "var(--surface-panel, #0f172a)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "var(--border-default, #1e293b)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <HardDrive size={14} aria-hidden="true" style={{ color: "#38bdf8" }} />
            <span
              style={{
                fontSize: "12.5px",
                fontWeight: 700,
                color: "var(--text-primary, #f8fafc)",
              }}
            >
              The file Loader -&gt; BunFile (Blob) &amp; --compile Embedded Table
            </span>
          </div>
          <div
            style={{
              fontFamily: MONO_FONT,
              fontSize: "11px",
              color: "#94a3b8",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {probe?.bunVersion ? `Bun v${probe.bunVersion}` : "Reference spec"} ·{" "}
            {probe?.bunFileAvailable ? "Bun.file() live" : "host probe pending"} ·{" "}
            {probe?.isStandaloneExecutable ? "standalone --compile" : "standard runtime"}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "1px",
            backgroundColor: "var(--border-default, #1e293b)",
          }}
        >
          {[
            {
              label: "BunFile -> Blob Identity",
              value: sample
                ? `instanceof Blob === ${String(sample.instanceofBlob)}`
                : probe?.bunFileAvailable
                  ? "Bun.file() ready"
                  : "Bun-native Blob subclass",
              sub: sample
                ? `${sample.assetPath} · ${sample.type} · ${formatBytes(sample.size)}`
                : "Lazy handle — zero I/O until first read",
              accent: sample?.instanceofBlob ? "#4ade80" : "#38bdf8",
            },
            {
              label: "Lazy Slice & Stream Surface",
              value: sample
                ? `slice(0, 64)=${sample.sliceByteLength}B · stream=${String(sample.streamSupported)}`
                : ".stream() · .slice() · .arrayBuffer()",
              sub: sample
                ? `Response=${String(sample.responseReady)} · FormData=${String(sample.formDataReady)} · fallback=${sample.unknownExtFallbackMime}`
                : "Streams directly in new Response() & FormData",
              accent: sample?.streamSupported ? "#4ade80" : "#94a3b8",
            },
            {
              label: "Bun.embeddedFiles (--compile)",
              value: probe?.embeddedFilesAvailable
                ? `${probe.embeddedFilesCount} embedded file${probe.embeddedFilesCount === 1 ? "" : "s"}`
                : "BunFile[] (--compile only)",
              sub: probe?.isStandaloneExecutable
                ? "Standalone binary — Bun.file() reads embedded table"
                : "Empty in normal bun run / bun build deployments",
              accent: probe?.embeddedFilesAvailable ? "#38bdf8" : "#94a3b8",
            },
            {
              label: "Bundler & Zero-Copy Write",
              value:
                probe?.bunBuildAvailable && probe?.bunWriteAvailable
                  ? "Bun.build() + Bun.write() live"
                  : "Bun.build() + Bun.write()",
              sub: "loaders: file / yaml / napi · --metafile & --metafile-md",
              accent: probe?.bunBuildAvailable && probe?.bunWriteAvailable ? "#4ade80" : "#94a3b8",
            },
          ].map((metric) => (
            <div
              key={metric.label}
              style={{
                padding: "10px 14px",
                backgroundColor: "var(--surface-panel, #0f172a)",
              }}
            >
              <div style={{ fontSize: "11px", color: "var(--text-muted, #94a3b8)" }}>
                {metric.label}
              </div>
              <div
                style={{
                  marginTop: "3px",
                  fontFamily: MONO_FONT,
                  fontSize: "12.5px",
                  fontWeight: 700,
                  color: metric.accent,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {metric.value}
              </div>
              <div
                style={{
                  marginTop: "2px",
                  fontFamily: MONO_FONT,
                  fontSize: "10.5px",
                  color: "#64748b",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {metric.sub}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 2. Interactive Loader & --compile Pipeline Workbench */}
      <div
        data-file-loader-workbench="true"
        style={{
          borderRadius: "8px",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--border-default, #1e293b)",
          backgroundColor: "var(--surface-panel, #0f172a)",
          overflow: "hidden",
        }}
      >
        {/* Workbench Controls Toolbar */}
        <div
          style={{
            padding: "10px 14px",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "var(--border-default, #1e293b)",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px" }}>
            <span
              style={{
                fontSize: "11.5px",
                fontWeight: 700,
                color: "var(--text-primary, #f8fafc)",
                marginRight: "4px",
              }}
            >
              Active Loaders
            </span>
            {BUN_ASSET_LOADER_SPECS.map((spec) => {
              const active = enabledLoaderIds.includes(spec.id)
              return (
                <button
                  key={spec.id}
                  type="button"
                  data-loader-toggle={spec.id}
                  aria-pressed={active}
                  onClick={() => toggleLoader(spec.id)}
                  style={{
                    padding: "4px 9px",
                    borderRadius: "5px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: active ? "#38bdf8" : "var(--border-strong, #334155)",
                    backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                    color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                    fontFamily: MONO_FONT,
                    fontSize: "11px",
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {spec.extension}={spec.loader}
                </button>
              )
            })}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
            {/* Target switch */}
            <div
              role="group"
              aria-label="Build target"
              style={{
                display: "inline-flex",
                padding: "2px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
              }}
            >
              {(["bun", "browser"] as const).map((t) => {
                const active = target === t
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTarget(t)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "4px",
                      border: "none",
                      backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                      color: active ? "#38bdf8" : "#94a3b8",
                      fontFamily: MONO_FONT,
                      fontSize: "11px",
                      fontWeight: active ? 600 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    target:{t}
                  </button>
                )
              })}
            </div>

            {/* Output mode switch */}
            <div
              role="group"
              aria-label="Build output mode"
              style={{
                display: "inline-flex",
                padding: "2px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
              }}
            >
              {(
                [
                  { id: false, label: "--outdir ./dist" },
                  { id: true, label: "--compile binary" },
                ] as const
              ).map((opt) => {
                const active = compileMode === opt.id
                return (
                  <button
                    key={opt.label}
                    type="button"
                    data-compile-mode-btn={opt.id ? "compile" : "outdir"}
                    aria-pressed={active}
                    onClick={() => setCompileMode(opt.id)}
                    style={{
                      padding: "3px 8px",
                      borderRadius: "4px",
                      border: "none",
                      backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                      color: active ? "#38bdf8" : "#94a3b8",
                      fontFamily: MONO_FONT,
                      fontSize: "11px",
                      fontWeight: active ? 600 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                fontFamily: MONO_FONT,
                fontSize: "11px",
                color: "var(--text-muted, #cbd5e1)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <input
                type="checkbox"
                checked={includeMetafile}
                onChange={(e) => setIncludeMetafile(e.target.checked)}
              />
              <span>metafile (.json + .md)</span>
            </label>

            <label
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                fontFamily: MONO_FONT,
                fontSize: "11px",
                color: "var(--text-muted, #cbd5e1)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <input
                type="checkbox"
                checked={externalSourcemap}
                onChange={(e) => setExternalSourcemap(e.target.checked)}
              />
              <span>sourcemap</span>
            </label>
          </div>
        </div>

        {/* Emitted Artifact & Runtime Resolution Table */}
        <div
          style={{
            overflowX: "auto",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "var(--border-default, #1e293b)",
          }}
        >
          <table
            data-file-loader-emissions="true"
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "11.5px",
              fontFamily: MONO_FONT,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  fontSize: "10.5px",
                  color: "var(--text-muted, #94a3b8)",
                  borderBottomWidth: "1px",
                  borderBottomStyle: "solid",
                  borderBottomColor: "var(--border-default, #1e293b)",
                }}
              >
                <th style={{ padding: "8px 14px", fontWeight: 600 }}>Import Source</th>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>Loader</th>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>
                  {compileMode ? "Embedded Artifact (--compile)" : "Emitted Output Path"}
                </th>
                <th style={{ padding: "8px 12px", fontWeight: 600 }}>Runtime Import Value</th>
                <th style={{ padding: "8px 14px", fontWeight: 600 }}>typeof / MIME</th>
              </tr>
            </thead>
            <tbody>
              {pipeline.emissions.map((row) => (
                <tr
                  key={row.id}
                  style={{
                    borderBottomWidth: "1px",
                    borderBottomStyle: "solid",
                    borderBottomColor: "rgba(30, 41, 59, 0.55)",
                  }}
                >
                  <td style={{ padding: "8px 14px", color: "#e2e8f0", fontWeight: 600 }}>
                    import {row.importVar} from &quot;{row.sampleFile}&quot;
                  </td>
                  <td
                    style={{
                      padding: "8px 12px",
                      color:
                        row.loader === "file"
                          ? "#38bdf8"
                          : row.loader === "napi"
                            ? "#f59e0b"
                            : "#c084fc",
                      fontWeight: 600,
                    }}
                  >
                    {row.loader}
                  </td>
                  <td style={{ padding: "8px 12px", color: "#86efac" }}>{row.emittedPath}</td>
                  <td style={{ padding: "8px 12px", color: "#cbd5e1" }}>
                    {row.runtimeValueType === "string"
                      ? JSON.stringify(row.runtimeImportValue)
                      : row.runtimeImportValue}
                  </td>
                  <td style={{ padding: "8px 14px", color: "#94a3b8", whiteSpace: "nowrap" }}>
                    {row.runtimeValueType} · {row.inferredMime}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Live End-to-End Code Tabs */}
        <div>
          <div
            style={{
              padding: "8px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <div
              role="tablist"
              aria-label="Generated pipeline snippets"
              style={{
                display: "inline-flex",
                flexWrap: "wrap",
                gap: "3px",
              }}
            >
              {(
                [
                  { id: "runtime", label: "src/index.ts", icon: FileCode2 },
                  { id: "build-api", label: "build.ts (Bun.build)", icon: Layers },
                  {
                    id: "cli",
                    label: compileMode ? "CLI (--compile)" : "CLI (bun build)",
                    icon: Terminal,
                  },
                  { id: "ci", label: "package.json CI", icon: FileCode2 },
                  {
                    id: "dist-tree",
                    label: compileMode ? "Binary Layout" : "dist/ Tree",
                    icon: HardDrive,
                  },
                ] as const
              ).map((t) => {
                const Icon = t.icon
                const active = codeTab === t.id
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    data-pipeline-code-tab={t.id}
                    aria-selected={active}
                    onClick={() => setCodeTab(t.id)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                      padding: "4px 9px",
                      borderRadius: "4px",
                      border: "none",
                      backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                      color: active ? "#38bdf8" : "#94a3b8",
                      fontFamily: MONO_FONT,
                      fontSize: "11px",
                      fontWeight: active ? 600 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <Icon size={12} aria-hidden="true" />
                    <span>{t.label}</span>
                  </button>
                )
              })}
            </div>

            <button
              type="button"
              onClick={() => void handleCopy("pipeline", activeCodeText)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "4px 10px",
                borderRadius: "5px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: copiedKey === "pipeline" ? "#4ade80" : "var(--border-strong, #334155)",
                backgroundColor: "transparent",
                color: copiedKey === "pipeline" ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {copiedKey === "pipeline" ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <Copy size={12} aria-hidden="true" />
              )}
              <span>{copiedKey === "pipeline" ? "Copied" : "Copy Snippet"}</span>
            </button>
          </div>

          <pre
            data-file-loader-code-preview="true"
            style={{
              margin: 0,
              padding: "13px 14px",
              backgroundColor: "var(--surface-overlay, #0a101d)",
              color: "#e2e8f0",
              fontFamily: MONO_FONT,
              fontSize: "11.5px",
              lineHeight: 1.55,
              overflowX: "auto",
            }}
          >
            {activeCodeText}
          </pre>
        </div>
      </div>

      {/* 3. BunFile (Blob Subclass) Properties & Canonical Consumers */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))",
          gap: "12px",
          alignItems: "start",
        }}
      >
        <div
          style={{
            borderRadius: "8px",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "var(--border-default, #1e293b)",
            backgroundColor: "var(--surface-panel, #0f172a)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
            }}
          >
            <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#f8fafc" }}>
              Bun.file() -&gt; BunFile (Blob Subclass) Properties
            </div>
            <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
              The file loader emits and hashes assets into string paths; Bun.file() provides lazy,
              Blob-compatible runtime reads.
            </div>
          </div>

          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "11.5px",
            }}
          >
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  fontSize: "10.5px",
                  color: "#94a3b8",
                  borderBottomWidth: "1px",
                  borderBottomStyle: "solid",
                  borderBottomColor: "var(--border-default, #1e293b)",
                }}
              >
                <th style={{ padding: "7px 14px", width: "125px", fontWeight: 600 }}>Feature</th>
                <th style={{ padding: "7px 14px", fontWeight: 600 }}>Behavior</th>
              </tr>
            </thead>
            <tbody>
              {BUN_FILE_PROPERTIES.map((prop) => (
                <tr
                  key={prop.id}
                  style={{
                    borderBottomWidth: "1px",
                    borderBottomStyle: "solid",
                    borderBottomColor: "rgba(30, 41, 59, 0.55)",
                  }}
                >
                  <td
                    style={{
                      padding: "8px 14px",
                      fontWeight: 700,
                      color: "#38bdf8",
                      verticalAlign: "top",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {prop.feature}
                  </td>
                  <td style={{ padding: "8px 14px", color: "#cbd5e1", lineHeight: 1.45 }}>
                    <div>{prop.behavior}</div>
                    <div
                      style={{
                        marginTop: "3px",
                        fontFamily: MONO_FONT,
                        fontSize: "10.5px",
                        color: "#64748b",
                      }}
                    >
                      {prop.apiExample}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Canonical Platform Blob Consumers */}
        <div
          style={{
            borderRadius: "8px",
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: "var(--border-default, #1e293b)",
            backgroundColor: "var(--surface-panel, #0f172a)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
            }}
          >
            <div>
              <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#f8fafc" }}>
                Zero-Copy Blob Consumers &amp; --compile Lookup
              </div>
              <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
                Anywhere the Web/Bun platform expects a Blob, BunFile works directly.
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleCopy("consumer", activeConsumer.code)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "4px 9px",
                borderRadius: "5px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: copiedKey === "consumer" ? "#4ade80" : "var(--border-strong, #334155)",
                backgroundColor: "transparent",
                color: copiedKey === "consumer" ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {copiedKey === "consumer" ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <Copy size={12} aria-hidden="true" />
              )}
              <span>{copiedKey === "consumer" ? "Copied" : "Copy"}</span>
            </button>
          </div>

          <div
            role="tablist"
            aria-label="BunFile consumer patterns"
            style={{
              padding: "8px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
              display: "flex",
              flexWrap: "wrap",
              gap: "4px",
            }}
          >
            {BUN_FILE_BLOB_CONSUMERS.map((consumer) => {
              const active = consumer.id === activeConsumer.id
              return (
                <button
                  key={consumer.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveConsumerId(consumer.id)}
                  style={{
                    padding: "4px 9px",
                    borderRadius: "4px",
                    border: "none",
                    backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                    color: active ? "#38bdf8" : "#94a3b8",
                    fontSize: "11px",
                    fontWeight: active ? 600 : 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {consumer.label}
                </button>
              )
            })}
          </div>

          <div
            style={{
              padding: "8px 14px",
              fontSize: "11.5px",
              color: "#94a3b8",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "rgba(30, 41, 59, 0.65)",
            }}
          >
            {activeConsumer.summary}
          </div>

          <pre
            style={{
              margin: 0,
              padding: "12px 14px",
              backgroundColor: "var(--surface-overlay, #0a101d)",
              color: "#e2e8f0",
              fontFamily: MONO_FONT,
              fontSize: "11.5px",
              lineHeight: 1.55,
              overflowX: "auto",
            }}
          >
            {activeConsumer.code}
          </pre>
        </div>
      </div>

      {/* 4. Sibling Loader Matrix: file vs napi (TSFN) vs yaml */}
      <div
        style={{
          borderRadius: "8px",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--border-default, #1e293b)",
          backgroundColor: "var(--surface-panel, #0f172a)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "10px 14px",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "var(--border-default, #1e293b)",
          }}
        >
          <div style={{ fontSize: "12.5px", fontWeight: 700, color: "#f8fafc" }}>
            Sibling Loaders: file vs napi (TSFN Native Addons) vs yaml
          </div>
          <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
            Both file and napi assets survive --compile via embedding: .node addons retain TSFN
            cross-thread calls while companion assets flow through file -&gt; Bun.file().
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "11.5px",
            }}
          >
            <thead>
              <tr
                style={{
                  textAlign: "left",
                  fontSize: "10.5px",
                  color: "#94a3b8",
                  borderBottomWidth: "1px",
                  borderBottomStyle: "solid",
                  borderBottomColor: "var(--border-default, #1e293b)",
                }}
              >
                <th style={{ padding: "8px 14px", width: "86px", fontWeight: 600 }}>Loader</th>
                <th style={{ padding: "8px 14px", width: "220px", fontWeight: 600 }}>
                  Emits to outdir
                </th>
                <th style={{ padding: "8px 14px", width: "210px", fontWeight: 600 }}>
                  Import Resolves To
                </th>
                <th style={{ padding: "8px 14px", width: "240px", fontWeight: 600 }}>
                  Runtime API
                </th>
                <th style={{ padding: "8px 14px", fontWeight: 600 }}>--compile Embedding</th>
              </tr>
            </thead>
            <tbody>
              {BUN_ASSET_LOADER_COMPARISON.map((row) => (
                <tr
                  key={row.loader}
                  style={{
                    borderBottomWidth: "1px",
                    borderBottomStyle: "solid",
                    borderBottomColor: "rgba(30, 41, 59, 0.55)",
                  }}
                >
                  <td
                    style={{
                      padding: "9px 14px",
                      fontFamily: MONO_FONT,
                      fontWeight: 700,
                      color:
                        row.loader === "file"
                          ? "#38bdf8"
                          : row.loader === "napi"
                            ? "#f59e0b"
                            : "#c084fc",
                      verticalAlign: "top",
                    }}
                  >
                    {row.loader}
                  </td>
                  <td
                    style={{
                      padding: "9px 14px",
                      fontFamily: MONO_FONT,
                      color: "#e2e8f0",
                      verticalAlign: "top",
                    }}
                  >
                    {row.emitsToOutdir}
                  </td>
                  <td style={{ padding: "9px 14px", color: "#cbd5e1", verticalAlign: "top" }}>
                    {row.importResolvesTo}
                  </td>
                  <td
                    style={{
                      padding: "9px 14px",
                      fontFamily: MONO_FONT,
                      color: "#7dd3fc",
                      verticalAlign: "top",
                    }}
                  >
                    {row.runtimeApi}
                  </td>
                  <td
                    style={{
                      padding: "9px 14px",
                      color: "#94a3b8",
                      lineHeight: 1.45,
                      verticalAlign: "top",
                    }}
                  >
                    {row.compileBehavior}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
