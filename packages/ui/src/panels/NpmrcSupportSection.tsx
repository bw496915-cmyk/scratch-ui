import { AlertCircle, Check, Copy, Download, Lock, ShieldCheck } from "lucide-react"
import type React from "react"
import { useMemo, useState } from "react"

import {
  auditRegistryCredentialMatch,
  convertNpmrcToBunfigToml,
  type MatchRegistryCredentialsRequest,
  parseNpmrc,
  type RedactedNpmrcStatusSummary,
  resolveBunPackageConfig,
} from "@sportsdesk-ops/contracts"

import {
  CopyBunTerminalAnsiButton,
  SyntaxHighlightedPre,
  SyntaxTokenLegend,
} from "./SyntaxHighlightedPre.tsx"

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace'

export const DEFAULT_NPMRC_PLAYGROUND_SNIPPET = `# Bun .npmrc sample — evaluated locally (never sent over the network)
registry=https://registry.npmjs.org/
@myorg:registry=https://npm.example.com/team/a/

# Scoped registry credentials (segment-prefix matching)
//npm.example.com/team/:_authToken=\${NPM_TOKEN}
//localhost:4873/:username=operator
//localhost:4873/:_password=\${NPM_PASSWORD}

# Install & security options
ignore-scripts=true
save-exact=true
link-workspace-packages=true
node-linker=isolated
public-hoist-pattern[]=*eslint*
public-hoist-pattern[]=*prettier*
omit[]=optional
`

export interface NpmrcSupportSectionProps {
  readonly summary?: RedactedNpmrcStatusSummary | null | undefined
}

type SimulatorKind = "registry" | "tarball-project" | "tarball-transitive" | "publishConfig"

export function NpmrcSupportSection({
  summary = null,
}: NpmrcSupportSectionProps): React.ReactElement {
  const [npmrcText, setNpmrcText] = useState<string>(DEFAULT_NPMRC_PLAYGROUND_SNIPPET)
  const [probeUrl, setProbeUrl] = useState<string>(
    "https://npm.example.com/team/a/@myorg/sdk/-/sdk-1.0.0.tgz",
  )
  const [probeKind, setProbeKind] = useState<SimulatorKind>("tarball-project")
  const [copiedToml, setCopiedToml] = useState<boolean>(false)

  const playgroundEvaluation = useMemo(() => {
    try {
      const parsed = parseNpmrc(npmrcText, {
        source: "project-npmrc",
        baseDir: "/workspace",
        homeDir: "/home/operator",
        env: {
          NPM_TOKEN: "__SIMULATED_ENV_TOKEN__",
          NPM_PASSWORD: "c2ltdWxhdGVkLXBhc3N3b3Jk",
        },
      })
      const resolved = resolveBunPackageConfig({ projectNpmrc: parsed })
      const bunfigToml = convertNpmrcToBunfigToml(resolved)

      let matchRequest: MatchRegistryCredentialsRequest
      if (probeKind === "tarball-project") {
        matchRequest = {
          kind: "tarball",
          targetUrl: probeUrl,
          namedBy: "project",
        }
      } else if (probeKind === "tarball-transitive") {
        matchRequest = {
          kind: "tarball",
          targetUrl: probeUrl,
          namedBy: "transitive",
        }
      } else if (probeKind === "publishConfig") {
        matchRequest = {
          kind: "publishConfig",
          targetUrl: probeUrl,
        }
      } else {
        matchRequest = {
          kind: "registry",
          targetUrl: probeUrl,
        }
      }

      const matchAudit = auditRegistryCredentialMatch(resolved, matchRequest)
      return {
        ok: true as const,
        parsed,
        resolved,
        bunfigToml,
        matchAudit,
      }
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [npmrcText, probeUrl, probeKind])

  const handleCopyBunfig = async () => {
    if (!playgroundEvaluation.ok) return
    try {
      await navigator.clipboard.writeText(playgroundEvaluation.bunfigToml)
      setCopiedToml(true)
      setTimeout(() => setCopiedToml(false), 1800)
    } catch {
      setCopiedToml(false)
    }
  }

  const handleDownloadBunfig = () => {
    if (!playgroundEvaluation.ok || typeof document === "undefined") return
    const blob = new Blob([playgroundEvaluation.bunfigToml], {
      type: "text/plain;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "bunfig.toml"
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div
      data-status-view="npmrc"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* 1. Workspace Active .npmrc & bunfig.toml Resolution */}
      {summary ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(280px, 1fr) minmax(320px, 1.35fr)",
            gap: "12px",
          }}
        >
          {/* Precedence Stack */}
          <div
            data-npmrc-precedence="true"
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
              <div
                style={{
                  fontSize: "12.5px",
                  fontWeight: 700,
                  color: "var(--text-primary, #f8fafc)",
                }}
              >
                Bun Configuration Precedence Order
              </div>
              <div
                style={{
                  marginTop: "2px",
                  fontSize: "11px",
                  color: "var(--text-muted, #94a3b8)",
                }}
              >
                Later layers override earlier ones; secrets remain server-side.
              </div>
            </div>

            <div>
              {summary.layers.map((layer, idx) => (
                <div
                  key={layer.layer}
                  data-npmrc-layer={layer.layer}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: "10px",
                    padding: "9px 14px",
                    borderTopWidth: idx === 0 ? "0px" : "1px",
                    borderTopStyle: "solid",
                    borderTopColor: "rgba(30, 41, 59, 0.7)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        color: layer.detected
                          ? "var(--text-primary, #f8fafc)"
                          : "var(--text-muted, #94a3b8)",
                      }}
                    >
                      {layer.label}
                    </div>
                    {layer.path ? (
                      <div
                        style={{
                          marginTop: "2px",
                          fontFamily: MONO_FONT,
                          fontSize: "11px",
                          color: "#64748b",
                        }}
                      >
                        {layer.path}
                      </div>
                    ) : null}
                    {layer.activeKeys.length > 0 ? (
                      <div
                        style={{
                          marginTop: "3px",
                          fontFamily: MONO_FONT,
                          fontSize: "10.5px",
                          color: "#94a3b8",
                          wordBreak: "break-word",
                        }}
                      >
                        {layer.activeKeys.join(", ")}
                      </div>
                    ) : null}
                  </div>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      fontFamily: MONO_FONT,
                      whiteSpace: "nowrap",
                      color: layer.detected ? "#4ade80" : "#64748b",
                    }}
                  >
                    {layer.detected ? "Active" : "Absent"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Effective Workspace Policy */}
          <div
            data-npmrc-effective="true"
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
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "12.5px",
                    fontWeight: 700,
                    color: "var(--text-primary, #f8fafc)",
                  }}
                >
                  Resolved Workspace Package Policy
                </div>
                <div
                  style={{
                    marginTop: "2px",
                    fontSize: "11px",
                    color: "var(--text-muted, #94a3b8)",
                  }}
                >
                  Merged from user/project <code style={{ fontFamily: MONO_FONT }}>.npmrc</code>,{" "}
                  <code style={{ fontFamily: MONO_FONT }}>bunfig.toml</code>, and env overrides.
                </div>
              </div>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#4ade80",
                  whiteSpace: "nowrap",
                }}
              >
                <ShieldCheck size={13} aria-hidden="true" />
                <span>Tokens Redacted</span>
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(175px, 1fr))",
                gap: "1px",
                backgroundColor: "var(--border-default, #1e293b)",
              }}
            >
              {[
                {
                  label: "Default Registry",
                  value: summary.defaultRegistryUrl,
                  sub: `${summary.defaultRegistrySource}${summary.defaultRegistryHasAuth ? ` · ${summary.defaultRegistryAuthScheme ?? "Auth"}` : " · Anonymous"}`,
                },
                {
                  label: "Supply-Chain Security",
                  value: summary.options.ignoreScripts
                    ? `ignoreScripts · age ${summary.options.minimumReleaseAge ?? "off"}`
                    : `scripts on · age ${summary.options.minimumReleaseAge ?? "off"}`,
                  sub: summary.options.securityScanner
                    ? `scanner: ${summary.options.securityScanner}`
                    : "install.security.scanner: none",
                },
                {
                  label: "Lockfile Policy",
                  value: summary.options.frozenLockfile
                    ? "frozenLockfile"
                    : summary.options.saveTextLockfile
                      ? "bun.lock (text)"
                      : "bun.lockb (binary)",
                  sub: `save=${String(summary.options.lockfileSave)}${summary.options.lockfilePrint ? ` · print=${summary.options.lockfilePrint}` : ""} · exact=${String(summary.options.saveExact)}`,
                },
                {
                  label: "Deps & Auto-Install",
                  value: summary.options.production
                    ? "production (no dev)"
                    : `dev=${String(summary.options.dev)} · opt=${String(summary.options.optional)} · peer=${String(summary.options.peer)}`,
                  sub: `auto=${summary.options.autoInstall} · linker=${summary.options.linker} (${summary.options.linkerSource}) · hoist=${String(summary.options.hoist)}`,
                },
                {
                  label: "Cache & Global Store",
                  value: summary.options.cacheDisabled
                    ? "cache disabled"
                    : (summary.options.cacheDir ?? "default cache"),
                  sub: `disableManifest=${String(summary.options.cacheDisableManifest)} · globalStore=${String(summary.options.globalStore)}`,
                },
                {
                  label: "[run] Process & Shell",
                  value: summary.options.runNoOrphans
                    ? `noOrphans=true · ${summary.options.runShell}`
                    : `noOrphans=false · ${summary.options.runShell}`,
                  sub: `run.bun=${String(summary.options.runBun)} · silent=${String(summary.options.runSilent)}`,
                },
                {
                  label: "TLS CA Trust",
                  value: summary.options.cafile
                    ? `cafile: ${summary.options.cafile}`
                    : summary.options.caCertCount > 0
                      ? `${summary.options.caCertCount} inline CA cert(s)`
                      : "System default CAs",
                  sub: `linkWorkspace=${String(summary.options.linkWorkspacePackages)} · dryRun=${String(summary.options.dryRun)}`,
                },
                {
                  label: "Scopes & Global Dirs",
                  value: `${summary.scopes.length} scoped · ${summary.credentialPrefixes.length} auth prefix`,
                  sub: summary.options.globalDir
                    ? `globalDir=${summary.options.globalDir}`
                    : "globalDir/globalBinDir: global bunfig only",
                },
              ].map((cell) => (
                <div
                  key={cell.label}
                  style={{
                    padding: "10px 12px",
                    backgroundColor: "var(--surface-panel, #0f172a)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "11px",
                      color: "var(--text-muted, #94a3b8)",
                    }}
                  >
                    {cell.label}
                  </div>
                  <div
                    style={{
                      marginTop: "3px",
                      fontFamily: MONO_FONT,
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "var(--text-primary, #f8fafc)",
                      wordBreak: "break-all",
                    }}
                  >
                    {cell.value}
                  </div>
                  <div
                    style={{
                      marginTop: "2px",
                      fontSize: "10.5px",
                      color: "#64748b",
                      fontFamily: MONO_FONT,
                    }}
                  >
                    {cell.sub}
                  </div>
                </div>
              ))}
            </div>

            {summary.scopes.length > 0 || summary.credentialPrefixes.length > 0 ? (
              <div
                style={{
                  padding: "10px 14px",
                  borderTopWidth: "1px",
                  borderTopStyle: "solid",
                  borderTopColor: "var(--border-default, #1e293b)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                {summary.scopes.map((sc) => (
                  <div
                    key={sc.scope}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "10px",
                      fontFamily: MONO_FONT,
                      fontSize: "11.5px",
                    }}
                  >
                    <span style={{ color: "#38bdf8", fontWeight: 600 }}>{sc.scope}:registry</span>
                    <span style={{ color: "var(--text-primary, #e2e8f0)" }}>{sc.registryUrl}</span>
                    <span style={{ color: sc.hasAuth ? "#4ade80" : "#64748b" }}>
                      {sc.hasAuth
                        ? `${sc.authScheme} (${sc.matchedPrefix ?? sc.source})`
                        : "No auth"}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 1b. bun.lock (BunLockFile) & Install Linker Strategy */}
      {summary?.lockfileSummary ? (
        <div
          data-bun-lockfile-panel="true"
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
              <div
                style={{
                  fontSize: "12.5px",
                  fontWeight: 700,
                  color: "var(--text-primary, #f8fafc)",
                }}
              >
                bun.lock (BunLockFile) &amp; Install Linker Strategy
              </div>
              <div
                style={{
                  marginTop: "2px",
                  fontSize: "11px",
                  color: "var(--text-muted, #94a3b8)",
                }}
              >
                {summary.lockfileSummary.defaultLinkerReason}
              </div>
            </div>
            <div
              style={{
                fontFamily: MONO_FONT,
                fontSize: "11.5px",
                fontWeight: 600,
                color:
                  summary.options.linker === "isolated"
                    ? "#38bdf8"
                    : "var(--text-primary, #e2e8f0)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              Effective linker: {summary.options.linker} ({summary.options.linkerSource})
            </div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
              gap: "1px",
              backgroundColor: "var(--border-default, #1e293b)",
            }}
          >
            {[
              {
                label: "lockfileVersion",
                value: `v${summary.lockfileSummary.lockfileVersion}`,
                sub: "Text JSONC schema",
              },
              {
                label: "configVersion",
                value:
                  summary.lockfileSummary.configVersion !== null
                    ? String(summary.lockfileSummary.configVersion)
                    : "unset (0)",
                sub: `Default: ${summary.lockfileSummary.defaultLinkerStrategy}`,
              },
              {
                label: "Workspaces",
                value: String(summary.lockfileSummary.workspaceCount),
                sub: summary.lockfileSummary.isWorkspaceProject
                  ? "Monorepo topology"
                  : "Single-package",
              },
              {
                label: "Locked Packages",
                value: String(summary.lockfileSummary.packageCount),
                sub: `${summary.lockfileSummary.libcNativePackageCount} libc-scoped`,
              },
              {
                label: "Install Scripts",
                value: String(summary.lockfileSummary.hasInstallScriptCount),
                sub: summary.options.ignoreScripts
                  ? "Blocked by ignoreScripts"
                  : "Lifecycle enabled",
              },
              {
                label: "Policy Maps",
                value: `${summary.lockfileSummary.overrideCount} ovr · ${summary.lockfileSummary.trustedDependencyCount} trust`,
                sub: `${summary.lockfileSummary.patchedDependencyCount} patched · ${summary.lockfileSummary.catalogCount} catalog`,
              },
            ].map((metric) => (
              <div
                key={metric.label}
                style={{
                  padding: "10px 12px",
                  backgroundColor: "var(--surface-panel, #0f172a)",
                }}
              >
                <div
                  style={{
                    fontSize: "11px",
                    color: "var(--text-muted, #94a3b8)",
                  }}
                >
                  {metric.label}
                </div>
                <div
                  style={{
                    marginTop: "3px",
                    fontFamily: MONO_FONT,
                    fontSize: "12.5px",
                    fontWeight: 700,
                    color: "var(--text-primary, #f8fafc)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {metric.value}
                </div>
                <div
                  style={{
                    marginTop: "2px",
                    fontSize: "10.5px",
                    fontFamily: MONO_FONT,
                    color: "#64748b",
                  }}
                >
                  {metric.sub}
                </div>
              </div>
            ))}
          </div>

          {summary.lockfileSummary.workspaces.length > 0 ? (
            <div
              style={{
                borderTopWidth: "1px",
                borderTopStyle: "solid",
                borderTopColor: "var(--border-default, #1e293b)",
              }}
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(140px, 1.4fr) minmax(120px, 1fr) 90px 90px",
                  gap: "8px",
                  padding: "7px 14px",
                  fontSize: "10.5px",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--text-muted, #94a3b8)",
                  backgroundColor: "rgba(15, 23, 42, 0.5)",
                }}
              >
                <span>Workspace Package</span>
                <span>Path</span>
                <span style={{ textAlign: "right" }}>Deps</span>
                <span style={{ textAlign: "right" }}>DevDeps</span>
              </div>
              {summary.lockfileSummary.workspaces.map((ws) => (
                <div
                  key={ws.path}
                  data-bun-lockfile-workspace={ws.path}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(140px, 1.4fr) minmax(120px, 1fr) 90px 90px",
                    gap: "8px",
                    padding: "7px 14px",
                    borderTopWidth: "1px",
                    borderTopStyle: "solid",
                    borderTopColor: "rgba(30, 41, 59, 0.65)",
                    fontFamily: MONO_FONT,
                    fontSize: "11.5px",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <span style={{ color: "var(--text-primary, #f1f5f9)", fontWeight: 600 }}>
                    {ws.name}
                    {ws.version ? (
                      <span style={{ color: "#64748b", fontWeight: 400 }}> @{ws.version}</span>
                    ) : null}
                  </span>
                  <span style={{ color: "#94a3b8" }}>{ws.path}</span>
                  <span style={{ textAlign: "right", color: "var(--text-primary, #e2e8f0)" }}>
                    {ws.dependencyCount}
                  </span>
                  <span style={{ textAlign: "right", color: "#94a3b8" }}>
                    {ws.devDependencyCount}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 2. Interactive .npmrc Parser, Credential Matcher & bunfig.toml Migrator */}
      <div
        data-npmrc-migrator="true"
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
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            padding: "10px 14px",
            borderBottomWidth: "1px",
            borderBottomStyle: "solid",
            borderBottomColor: "var(--border-default, #1e293b)",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "12.5px",
                fontWeight: 700,
                color: "var(--text-primary, #f8fafc)",
              }}
            >
              Interactive .npmrc Validator, Credential Matcher & bunfig.toml Migrator
            </div>
            <div
              style={{
                marginTop: "2px",
                fontSize: "11px",
                color: "var(--text-muted, #94a3b8)",
              }}
            >
              Evaluates <code style={{ fontFamily: MONO_FONT }}>.npmrc</code> locally in memory
              (never transmitted) and emits secret-safe{" "}
              <code style={{ fontFamily: MONO_FONT }}>bunfig.toml</code>.
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              disabled={!playgroundEvaluation.ok}
              onClick={() => void handleCopyBunfig()}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "6px 11px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: copiedToml ? "#4ade80" : "var(--border-strong, #334155)",
                backgroundColor: "transparent",
                color: copiedToml ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                fontSize: "11.5px",
                fontWeight: 600,
                cursor: playgroundEvaluation.ok ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              {copiedToml ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <Copy size={12} aria-hidden="true" />
              )}
              <span>{copiedToml ? "Copied" : "Copy bunfig.toml"}</span>
            </button>

            <button
              type="button"
              disabled={!playgroundEvaluation.ok}
              onClick={handleDownloadBunfig}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "6px 11px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#38bdf8",
                backgroundColor: "rgba(56, 189, 248, 0.12)",
                color: "#38bdf8",
                fontSize: "11.5px",
                fontWeight: 600,
                cursor: playgroundEvaluation.ok ? "pointer" : "not-allowed",
                whiteSpace: "nowrap",
              }}
            >
              <Download size={12} aria-hidden="true" />
              <span>Download bunfig.toml</span>
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: "1px",
            backgroundColor: "var(--border-default, #1e293b)",
          }}
        >
          {/* Left: .npmrc input */}
          <div
            style={{
              padding: "12px 14px",
              backgroundColor: "var(--surface-panel, #0f172a)",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <label
              htmlFor="sd-npmrc-input"
              style={{
                fontSize: "11.5px",
                fontWeight: 600,
                fontFamily: MONO_FONT,
                color: "var(--text-muted, #94a3b8)",
              }}
            >
              .npmrc Input
            </label>
            <textarea
              id="sd-npmrc-input"
              data-npmrc-editor="true"
              value={npmrcText}
              onChange={(e) => setNpmrcText(e.target.value)}
              rows={13}
              spellCheck={false}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-strong, #334155)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
                color: "var(--text-primary, #f1f5f9)",
                fontFamily: MONO_FONT,
                fontSize: "11.5px",
                lineHeight: 1.55,
                resize: "vertical",
              }}
            />
          </div>

          {/* Right: Generated bunfig.toml */}
          <div
            style={{
              padding: "12px 14px",
              backgroundColor: "var(--surface-panel, #0f172a)",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                fontSize: "11.5px",
                fontWeight: 600,
                fontFamily: MONO_FONT,
                color: "var(--text-muted, #94a3b8)",
              }}
            >
              <span>Generated bunfig.toml Equivalent</span>
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "8px",
                }}
              >
                <SyntaxTokenLegend compact />
                {playgroundEvaluation.ok ? (
                  <CopyBunTerminalAnsiButton
                    text={playgroundEvaluation.bunfigToml}
                    format="toml"
                    compact
                  />
                ) : null}
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    fontSize: "10.5px",
                    color: "#fbbf24",
                  }}
                >
                  <Lock size={11} aria-hidden="true" />
                  <span>Env placeholders only</span>
                </span>
              </div>
            </div>

            {playgroundEvaluation.ok ? (
              <SyntaxHighlightedPre
                data-bunfig-preview="true"
                text={playgroundEvaluation.bunfigToml}
                format="toml"
                style={{
                  margin: 0,
                  padding: "10px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #e2e8f0)",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                  lineHeight: 1.55,
                  overflowX: "auto",
                  minHeight: "205px",
                }}
              />
            ) : (
              <div
                role="alert"
                data-npmrc-parse-error="true"
                style={{
                  padding: "10px 12px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "rgba(239, 68, 68, 0.45)",
                  backgroundColor: "rgba(239, 68, 68, 0.08)",
                  color: "#fca5a5",
                  fontSize: "12px",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "8px",
                }}
              >
                <AlertCircle size={14} aria-hidden="true" />
                <span>{playgroundEvaluation.error}</span>
              </div>
            )}
          </div>
        </div>

        {/* Credential Matching Simulator Bar */}
        <div
          data-npmrc-credential-probe="true"
          style={{
            padding: "12px 14px",
            borderTopWidth: "1px",
            borderTopStyle: "solid",
            borderTopColor: "var(--border-default, #1e293b)",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div
            style={{
              fontSize: "11.5px",
              fontWeight: 700,
              color: "var(--text-primary, #f8fafc)",
            }}
          >
            Credential Matching Inspector (Path Segment Fallback & Cross-Origin Tarball Guard)
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <select
              aria-label="Request target kind"
              value={probeKind}
              onChange={(e) => setProbeKind(e.target.value as SimulatorKind)}
              style={{
                padding: "6px 10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-strong, #334155)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
                color: "var(--text-primary, #f1f5f9)",
                fontSize: "11.5px",
                fontFamily: MONO_FONT,
              }}
            >
              <option value="registry">Registry Request</option>
              <option value="tarball-project">Tarball URL (Project-Named)</option>
              <option value="tarball-transitive">Tarball URL (Transitive Pkg)</option>
              <option value="publishConfig">publishConfig.registry</option>
            </select>

            <input
              type="text"
              aria-label="Target registry or tarball URL"
              value={probeUrl}
              onChange={(e) => setProbeUrl(e.target.value)}
              placeholder="https://npm.example.com/team/a/pkg/-/pkg-1.0.0.tgz"
              style={{
                flex: "1 1 300px",
                minWidth: "240px",
                padding: "6px 10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-strong, #334155)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
                color: "var(--text-primary, #f1f5f9)",
                fontSize: "11.5px",
                fontFamily: MONO_FONT,
              }}
            />
          </div>

          {playgroundEvaluation.ok ? (
            <div
              data-npmrc-match-result={
                playgroundEvaluation.matchAudit.matched ? "matched" : "unmatched"
              }
              style={{
                padding: "9px 12px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: playgroundEvaluation.matchAudit.error
                  ? "rgba(239, 68, 68, 0.45)"
                  : playgroundEvaluation.matchAudit.matched
                    ? "rgba(34, 197, 94, 0.4)"
                    : "var(--border-strong, #334155)",
                backgroundColor: playgroundEvaluation.matchAudit.error
                  ? "rgba(239, 68, 68, 0.08)"
                  : playgroundEvaluation.matchAudit.matched
                    ? "rgba(34, 197, 94, 0.08)"
                    : "var(--surface-overlay, #0a101d)",
                fontSize: "11.5px",
                fontFamily: MONO_FONT,
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
              }}
            >
              <span
                style={{
                  fontWeight: 700,
                  color: playgroundEvaluation.matchAudit.error
                    ? "#fca5a5"
                    : playgroundEvaluation.matchAudit.matched
                      ? "#4ade80"
                      : "#fbbf24",
                }}
              >
                {playgroundEvaluation.matchAudit.error
                  ? "BLOCKED (ERROR)"
                  : playgroundEvaluation.matchAudit.matched
                    ? `AUTH SENT · ${playgroundEvaluation.matchAudit.scheme} (${playgroundEvaluation.matchAudit.matchedPrefix ?? playgroundEvaluation.matchAudit.source})`
                    : "NO CREDENTIALS SENT"}
              </span>
              <span style={{ color: "var(--text-muted, #cbd5e1)" }}>
                {playgroundEvaluation.matchAudit.error ?? playgroundEvaluation.matchAudit.reason}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
