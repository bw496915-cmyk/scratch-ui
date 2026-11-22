import type React from "react";
import { useMemo, useState } from "react";
import {
  Check,
  Code2,
  Copy,
  Cpu,
  Download,
  FlaskConical,
  Globe,
  Layers,
  RefreshCw,
  Search,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import {
  BUN_CORE_API_DOMAINS,
  BUN_GLOBAL_TIERS,
  BUN_UTILITIES_CATALOG,
  BUN_UTILITY_CATEGORIES,
  LIVE_SURFACE_AUDIT_SNIPPET,
  bunDeepEquals,
  decodeUuidV7TimestampIso,
  evaluateBunColorConversions,
  evaluateBunStringUtilities,
  generateBunUuidV7,
  runBunSurfaceAudit,
  type BunRuntimeSurfaceAuditSnapshot,
  type BunUtilityCategoryId,
  type GlobalTierId,
} from "@sportsdesk-ops/contracts";
import { CopyBunTerminalAnsiButton } from "./SyntaxHighlightedPre.tsx";

const MONO_FONT =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export type RuntimeSurfaceSubTab =
  | "globals"
  | "utilities"
  | "core-apis"
  | "live-audit"
  | "sandbox";

export interface BunRuntimeSurfaceSectionProps {
  readonly audit?: BunRuntimeSurfaceAuditSnapshot | null | undefined;
  readonly initialSubTab?: RuntimeSurfaceSubTab | undefined;
  readonly onRefresh?: (() => void) | undefined;
}

function sourceLabel(source: BunRuntimeSurfaceAuditSnapshot["source"]): string {
  switch (source) {
    case "bun-in-process":
      return "In-process Bun runtime";
    case "bun-binary-probe":
      return "Installed Bun binary probe";
    case "node-fallback":
      return "Node.js host fallback";
    case "browser-fallback":
      return "Browser runtime probe";
  }
}

export function BunRuntimeSurfaceSection({
  audit = null,
  initialSubTab = "globals",
  onRefresh,
}: BunRuntimeSurfaceSectionProps): React.ReactElement {
  const effectiveAudit = useMemo<BunRuntimeSurfaceAuditSnapshot>(
    () => audit ?? runBunSurfaceAudit(),
    [audit],
  );

  const [subTab, setSubTab] = useState<RuntimeSurfaceSubTab>(initialSubTab);

  // Globals filter state
  const [globalTierFilter, setGlobalTierFilter] = useState<"all" | GlobalTierId>("all");
  const [globalSearch, setGlobalSearch] = useState<string>("");

  // Utilities filter state
  const [utilityCategoryFilter, setUtilityCategoryFilter] = useState<
    "all" | BunUtilityCategoryId
  >("all");
  const [utilitySearch, setUtilitySearch] = useState<string>("");

  // Core APIs filter state
  const [coreApiSearch, setCoreApiSearch] = useState<string>("");

  // Live Surface Audit state
  const [auditSearch, setAuditSearch] = useState<string>("");
  const [auditTypeFilter, setAuditTypeFilter] = useState<string>("all");
  const [auditDisplayMode, setAuditDisplayMode] = useState<"table" | "inspect">("table");
  const [copiedSnippet, setCopiedSnippet] = useState<boolean>(false);
  const [copiedTable, setCopiedTable] = useState<boolean>(false);

  // Utility Sandbox state
  const [sandboxStringInput, setSandboxStringInput] = useState<string>(
    '\u001b[36mSportsDesk\u001b[0m · <script>alert("x")</script> · 東京 🚀',
  );
  const [sandboxColorInput, setSandboxColorInput] = useState<string>("#38bdf8");
  const [uuidHistory, setUuidHistory] = useState<readonly string[]>(() => [
    generateBunUuidV7(),
  ]);
  const [deepEqLeft, setDeepEqLeft] = useState<string>(
    '{\n  "desk": "main",\n  "tiers": [1, 2, 3],\n  "optionalFlag": null\n}',
  );
  const [deepEqRight, setDeepEqRight] = useState<string>(
    '{\n  "tiers": [1, 2, 3],\n  "desk": "main",\n  "optionalFlag": null\n}',
  );
  const [deepEqStrict, setDeepEqStrict] = useState<boolean>(false);

  // Lookup maps from live probes
  const globalProbeMap = useMemo(() => {
    const map = new Map<string, { readonly present: boolean; readonly valueType: string }>();
    for (const probe of effectiveAudit.globalProbes) {
      map.set(`${probe.tier}:${probe.name}`, {
        present: probe.present,
        valueType: probe.valueType,
      });
    }
    return map;
  }, [effectiveAudit.globalProbes]);

  const utilityProbeMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const probe of effectiveAudit.utilityProbes) {
      map.set(probe.id, probe.available);
    }
    return map;
  }, [effectiveAudit.utilityProbes]);

  const coreDomainProbeMap = useMemo(() => {
    const map = new Map<
      string,
      {
        readonly availableCount: number;
        readonly totalProbed: number;
        readonly availableKeys: readonly string[];
      }
    >();
    for (const probe of effectiveAudit.coreDomainProbes) {
      map.set(probe.id, {
        availableCount: probe.availableCount,
        totalProbed: probe.totalProbed,
        availableKeys: probe.availableKeys,
      });
    }
    return map;
  }, [effectiveAudit.coreDomainProbes]);

  // Summary counts
  const presentGlobalsCount = useMemo(
    () => effectiveAudit.globalProbes.filter((g) => g.present).length,
    [effectiveAudit.globalProbes],
  );
  const availableUtilitiesCount = useMemo(
    () => effectiveAudit.utilityProbes.filter((u) => u.available).length,
    [effectiveAudit.utilityProbes],
  );
  const availableCoreApisCount = useMemo(
    () =>
      effectiveAudit.coreDomainProbes.reduce((acc, d) => acc + d.availableCount, 0),
    [effectiveAudit.coreDomainProbes],
  );
  const totalCoreApisProbed = useMemo(
    () =>
      effectiveAudit.coreDomainProbes.reduce((acc, d) => acc + d.totalProbed, 0),
    [effectiveAudit.coreDomainProbes],
  );

  // Filtered Views
  const filteredGlobalTiers = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    return BUN_GLOBAL_TIERS.filter((tier) => {
      if (globalTierFilter !== "all" && tier.id !== globalTierFilter) return false;
      if (!q) return true;
      return (
        tier.label.toLowerCase().includes(q) ||
        tier.notes.toLowerCase().includes(q) ||
        tier.globals.some((g) => g.toLowerCase().includes(q))
      );
    }).map((tier) => {
      if (!q) return tier;
      const matchingGlobals = tier.globals.filter((g) => g.toLowerCase().includes(q));
      return {
        ...tier,
        globals: matchingGlobals.length > 0 ? matchingGlobals : tier.globals,
      };
    });
  }, [globalTierFilter, globalSearch]);

  const filteredUtilities = useMemo(() => {
    const q = utilitySearch.trim().toLowerCase();
    return BUN_UTILITIES_CATALOG.filter((item) => {
      if (utilityCategoryFilter !== "all" && item.category !== utilityCategoryFilter) {
        return false;
      }
      if (!q) return true;
      const hay = `${item.signature} ${item.purpose} ${item.runtimeNotes ?? ""} ${item.categoryLabel}`.toLowerCase();
      return hay.includes(q);
    });
  }, [utilityCategoryFilter, utilitySearch]);

  const filteredCoreDomains = useMemo(() => {
    const q = coreApiSearch.trim().toLowerCase();
    if (!q) return BUN_CORE_API_DOMAINS;
    return BUN_CORE_API_DOMAINS.filter((d) => {
      const hay = `${d.domain} ${d.apis.join(" ")} ${d.capabilities}`.toLowerCase();
      return hay.includes(q);
    });
  }, [coreApiSearch]);

  const exportTypes = useMemo(
    () => Object.keys(effectiveAudit.exportTypeCounts).sort(),
    [effectiveAudit.exportTypeCounts],
  );

  const filteredExports = useMemo(() => {
    const q = auditSearch.trim().toLowerCase();
    return effectiveAudit.exports.filter((entry) => {
      if (auditTypeFilter !== "all" && entry.type !== auditTypeFilter) return false;
      if (q && !entry.key.toLowerCase().includes(q) && !entry.type.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [effectiveAudit.exports, auditSearch, auditTypeFilter]);

  // Sandbox evaluations
  const stringProbe = useMemo(
    () => evaluateBunStringUtilities(sandboxStringInput),
    [sandboxStringInput],
  );
  const colorProbe = useMemo(
    () => evaluateBunColorConversions(sandboxColorInput),
    [sandboxColorInput],
  );
  const deepEqResult = useMemo(() => {
    try {
      const parsedA = JSON.parse(deepEqLeft) as unknown;
      const parsedB = JSON.parse(deepEqRight) as unknown;
      return {
        ok: true as const,
        equal: bunDeepEquals(parsedA, parsedB, deepEqStrict),
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "Invalid JSON input",
      };
    }
  }, [deepEqLeft, deepEqRight, deepEqStrict]);

  const handleCopySnippet = async () => {
    try {
      await navigator.clipboard.writeText(LIVE_SURFACE_AUDIT_SNIPPET);
      setCopiedSnippet(true);
      setTimeout(() => setCopiedSnippet(false), 1800);
    } catch {
      setCopiedSnippet(false);
    }
  };

  const handleCopyTable = async () => {
    try {
      await navigator.clipboard.writeText(effectiveAudit.inspectTableText);
      setCopiedTable(true);
      setTimeout(() => setCopiedTable(false), 1800);
    } catch {
      setCopiedTable(false);
    }
  };

  const handleDownloadAuditJson = () => {
    if (typeof document === "undefined") return;
    const blob = new Blob([`${JSON.stringify(effectiveAudit, null, 2)}\n`], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `bun-runtime-surface-${effectiveAudit.bunVersion ?? "host"}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const handleMintUuidV7 = () => {
    const next = generateBunUuidV7();
    setUuidHistory((prev) => [next, ...prev.slice(0, 5)]);
  };

  return (
    <div
      data-status-view="runtime-surface"
      data-bun-runtime-surface="true"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* 1. Live Runtime Surface Telemetry Header */}
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
            gap: "10px",
          }}
        >
          <div>
            <div
              style={{
                fontSize: "13px",
                fontWeight: 700,
                color: "var(--text-primary, #f8fafc)",
              }}
            >
              Bun Runtime Surface &amp; Live Namespace Audit
            </div>
            <div
              style={{
                marginTop: "2px",
                fontSize: "11px",
                color: "var(--text-muted, #94a3b8)",
                fontFamily: MONO_FONT,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {sourceLabel(effectiveAudit.source)} · host {effectiveAudit.hostRuntime} ·{" "}
              {effectiveAudit.auditDurationMs.toFixed(2)}ms · read-only introspection (secrets
              excluded)
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontSize: "11px",
                fontWeight: 600,
                color: effectiveAudit.bunDetected ? "#4ade80" : "#fbbf24",
                whiteSpace: "nowrap",
              }}
            >
              <ShieldCheck size={13} aria-hidden="true" />
              <span>
                {effectiveAudit.bunDetected
                  ? `Bun ${effectiveAudit.bunVersion} verified`
                  : "Catalog + host probe"}
              </span>
            </span>

            {onRefresh ? (
              <button
                type="button"
                onClick={onRefresh}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "5px 10px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "transparent",
                  color: "var(--text-primary, #e2e8f0)",
                  fontSize: "11.5px",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <RefreshCw size={12} aria-hidden="true" />
                <span>Re-audit</span>
              </button>
            ) : null}

            <button
              type="button"
              onClick={handleDownloadAuditJson}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "5px 10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "#38bdf8",
                backgroundColor: "rgba(56, 189, 248, 0.12)",
                color: "#38bdf8",
                fontSize: "11.5px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <Download size={12} aria-hidden="true" />
              <span>Export Audit JSON</span>
            </button>
          </div>
        </div>

        {/* 4-column KPI summary strip */}
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
              label: "Bun Binary & Revision",
              value: effectiveAudit.bunVersion
                ? `v${effectiveAudit.bunVersion}`
                : effectiveAudit.hostRuntime,
              sub: effectiveAudit.bunRevisionShort
                ? `rev ${effectiveAudit.bunRevisionShort} · mainThread=${String(effectiveAudit.isMainThread)}`
                : "No Bun binary detected on PATH",
            },
            {
              label: "Bun Namespace Exports",
              value: `${effectiveAudit.exportCount} exports`,
              sub:
                effectiveAudit.exportCount > 0
                  ? `${effectiveAudit.exportTypeCounts.function ?? 0} fn · ${effectiveAudit.exportTypeCounts.object ?? 0} obj · ${effectiveAudit.exportTypeCounts.string ?? 0} str`
                  : "Run under Bun to enumerate Bun.*",
            },
            {
              label: "Globals (3 Tiers)",
              value: `${presentGlobalsCount}/${effectiveAudit.globalProbes.length} live`,
              sub:
                effectiveAudit.processEnvEqualsBunEnv === true
                  ? "process.env === Bun.env verified"
                  : effectiveAudit.processEnvEqualsBunEnv === false
                    ? "process.env !== Bun.env"
                    : "Web & Node compat globals probed",
            },
            {
              label: "Utilities & Core APIs",
              value: `${availableUtilitiesCount}/${BUN_UTILITIES_CATALOG.length} utils · ${availableCoreApisCount}/${totalCoreApisProbed} APIs`,
              sub: `${BUN_UTILITY_CATEGORIES.length} utility groups · ${BUN_CORE_API_DOMAINS.length} core domains`,
            },
          ].map((kpi) => (
            <div
              key={kpi.label}
              style={{
                padding: "10px 14px",
                backgroundColor: "var(--surface-panel, #0f172a)",
              }}
            >
              <div style={{ fontSize: "11px", color: "var(--text-muted, #94a3b8)" }}>
                {kpi.label}
              </div>
              <div
                style={{
                  marginTop: "3px",
                  fontFamily: MONO_FONT,
                  fontSize: "13px",
                  fontWeight: 700,
                  color: "var(--text-primary, #f8fafc)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {kpi.value}
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
                {kpi.sub}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 2. Section Sub-Navigation */}
      <div
        role="tablist"
        aria-label="Bun Runtime Surface Sections"
        style={{
          display: "inline-flex",
          flexWrap: "wrap",
          alignSelf: "flex-start",
          gap: "3px",
          padding: "3px",
          borderRadius: "7px",
          borderWidth: "1px",
          borderStyle: "solid",
          borderColor: "var(--border-default, #1e293b)",
          backgroundColor: "var(--surface-panel, #0f172a)",
        }}
      >
        {(
          [
            { id: "globals", label: "01. Globals (3 Tiers)", icon: Globe },
            {
              id: "utilities",
              label: `02. Bun.* Utilities (${BUN_UTILITIES_CATALOG.length})`,
              icon: Wrench,
            },
            {
              id: "core-apis",
              label: `03. Core APIs (${BUN_CORE_API_DOMAINS.length})`,
              icon: Layers,
            },
            {
              id: "live-audit",
              label: `04. Live Surface Audit (${effectiveAudit.exportCount})`,
              icon: Cpu,
            },
            { id: "sandbox", label: "Utility Sandbox", icon: FlaskConical },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = subTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-runtime-subtab={tab.id}
              aria-selected={active}
              onClick={() => setSubTab(tab.id)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "6px 11px",
                borderRadius: "5px",
                border: "none",
                backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                fontSize: "11.5px",
                fontWeight: active ? 600 : 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <Icon size={13} aria-hidden="true" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* VIEW 1: GLOBALS (3 TIERS) */}
      {subTab === "globals" ? (
        <div
          data-runtime-view="globals"
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
              gap: "8px",
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
            }}
          >
            <div
              role="group"
              aria-label="Filter globals by tier"
              style={{
                display: "inline-flex",
                flexWrap: "wrap",
                gap: "2px",
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
                  { id: "all", label: "All Tiers" },
                  { id: "bun-specific", label: "Bun-Specific" },
                  { id: "node-compat", label: "Node.js Compat" },
                  { id: "web-standards", label: "Web Standards" },
                ] as const
              ).map((opt) => {
                const active = globalTierFilter === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setGlobalTierFilter(opt.id)}
                    style={{
                      padding: "4px 9px",
                      borderRadius: "4px",
                      border: "none",
                      backgroundColor: active ? "rgba(56, 189, 248, 0.14)" : "transparent",
                      color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                      fontSize: "11px",
                      fontWeight: active ? 600 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                flex: "1 1 200px",
                maxWidth: "300px",
              }}
            >
              <Search
                size={13}
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: "9px",
                  color: "#64748b",
                  pointerEvents: "none",
                }}
              />
              <input
                type="search"
                aria-label="Search runtime globals"
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
                placeholder="Filter globals (e.g. HTMLRewriter, fetch)…"
                style={{
                  width: "100%",
                  padding: "5px 10px 5px 28px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontSize: "11.5px",
                }}
              />
            </div>
          </div>

          {filteredGlobalTiers.length === 0 ? (
            <div style={{ padding: "18px 14px", fontSize: "12px", color: "#94a3b8" }}>
              No global tiers match &ldquo;{globalSearch}&rdquo;.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "12px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      fontSize: "11px",
                      color: "var(--text-muted, #94a3b8)",
                      borderBottomWidth: "1px",
                      borderBottomStyle: "solid",
                      borderBottomColor: "var(--border-default, #1e293b)",
                    }}
                  >
                    <th style={{ padding: "8px 14px", width: "160px", fontWeight: 600 }}>
                      Tier
                    </th>
                    <th style={{ padding: "8px 14px", fontWeight: 600 }}>
                      Key Globals (Live Runtime Probe)
                    </th>
                    <th style={{ padding: "8px 14px", width: "310px", fontWeight: 600 }}>
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredGlobalTiers.map((tier) => {
                    const liveCount = tier.globals.filter(
                      (g) => globalProbeMap.get(`${tier.id}:${g}`)?.present,
                    ).length;
                    return (
                      <tr
                        key={tier.id}
                        data-global-tier={tier.id}
                        style={{
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.7)",
                        }}
                      >
                        <td style={{ padding: "11px 14px", verticalAlign: "top" }}>
                          <div
                            style={{
                              fontWeight: 700,
                              color: "var(--text-primary, #f8fafc)",
                              fontSize: "12px",
                            }}
                          >
                            {tier.label}
                          </div>
                          <div
                            style={{
                              marginTop: "3px",
                              fontFamily: MONO_FONT,
                              fontSize: "10.5px",
                              color: "#64748b",
                              fontVariantNumeric: "tabular-nums",
                            }}
                          >
                            {liveCount}/{tier.globals.length} live
                          </div>
                        </td>
                        <td style={{ padding: "11px 14px", verticalAlign: "top" }}>
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: "4px 12px",
                              fontFamily: MONO_FONT,
                              fontSize: "11.5px",
                              lineHeight: 1.65,
                            }}
                          >
                            {tier.globals.map((gName) => {
                              const probe = globalProbeMap.get(`${tier.id}:${gName}`);
                              const present = probe?.present ?? false;
                              return (
                                <span
                                  key={gName}
                                  title={
                                    probe
                                      ? `${gName}: typeof === "${probe.valueType}"`
                                      : gName
                                  }
                                  style={{
                                    color: present
                                      ? "var(--text-primary, #e2e8f0)"
                                      : "#64748b",
                                  }}
                                >
                                  <span style={{ fontWeight: present ? 600 : 400 }}>
                                    {gName}
                                  </span>
                                  {probe && probe.present ? (
                                    <span style={{ color: "#4ade80", fontSize: "10px" }}>
                                      {" "}
                                      ({probe.valueType})
                                    </span>
                                  ) : (
                                    <span style={{ color: "#64748b", fontSize: "10px" }}>
                                      {" "}
                                      (absent)
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                        <td
                          style={{
                            padding: "11px 14px",
                            verticalAlign: "top",
                            fontSize: "11.5px",
                            color: "var(--text-muted, #94a3b8)",
                            lineHeight: 1.5,
                          }}
                        >
                          {tier.notes}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* VIEW 2: BUN.* UTILITIES */}
      {subTab === "utilities" ? (
        <div
          data-runtime-view="utilities"
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
              gap: "8px",
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
            }}
          >
            <div
              role="group"
              aria-label="Filter Bun utilities by category"
              style={{
                display: "inline-flex",
                flexWrap: "wrap",
                gap: "2px",
                padding: "2px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-default, #1e293b)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
              }}
            >
              <button
                type="button"
                onClick={() => setUtilityCategoryFilter("all")}
                style={{
                  padding: "4px 9px",
                  borderRadius: "4px",
                  border: "none",
                  backgroundColor:
                    utilityCategoryFilter === "all"
                      ? "rgba(56, 189, 248, 0.14)"
                      : "transparent",
                  color:
                    utilityCategoryFilter === "all"
                      ? "#38bdf8"
                      : "var(--text-muted, #94a3b8)",
                  fontSize: "11px",
                  fontWeight: utilityCategoryFilter === "all" ? 600 : 500,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                All ({BUN_UTILITIES_CATALOG.length})
              </button>
              {BUN_UTILITY_CATEGORIES.map((cat) => {
                const active = utilityCategoryFilter === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setUtilityCategoryFilter(cat.id)}
                    style={{
                      padding: "4px 9px",
                      borderRadius: "4px",
                      border: "none",
                      backgroundColor: active
                        ? "rgba(56, 189, 248, 0.14)"
                        : "transparent",
                      color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                      fontSize: "11px",
                      fontWeight: active ? 600 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>

            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                flex: "1 1 200px",
                maxWidth: "300px",
              }}
            >
              <Search
                size={13}
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: "9px",
                  color: "#64748b",
                  pointerEvents: "none",
                }}
              />
              <input
                type="search"
                aria-label="Search Bun utilities"
                value={utilitySearch}
                onChange={(e) => setUtilitySearch(e.target.value)}
                placeholder="Filter Bun.* utilities (e.g. zstd, peek, uuid)…"
                style={{
                  width: "100%",
                  padding: "5px 10px 5px 28px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontSize: "11.5px",
                }}
              />
            </div>
          </div>

          {filteredUtilities.length === 0 ? (
            <div style={{ padding: "18px 14px", fontSize: "12px", color: "#94a3b8" }}>
              No utilities match the current filter.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "12px",
                }}
              >
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      fontSize: "11px",
                      color: "var(--text-muted, #94a3b8)",
                      borderBottomWidth: "1px",
                      borderBottomStyle: "solid",
                      borderBottomColor: "var(--border-default, #1e293b)",
                    }}
                  >
                    <th style={{ padding: "8px 14px", width: "290px", fontWeight: 600 }}>
                      Utility Signature
                    </th>
                    <th style={{ padding: "8px 14px", fontWeight: 600 }}>
                      Purpose &amp; Hot-Path Notes
                    </th>
                    <th style={{ padding: "8px 14px", width: "175px", fontWeight: 600 }}>
                      Category
                    </th>
                    <th
                      style={{
                        padding: "8px 14px",
                        width: "96px",
                        textAlign: "right",
                        fontWeight: 600,
                      }}
                    >
                      Surface
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUtilities.map((util) => {
                    const available = utilityProbeMap.get(util.id) ?? false;
                    return (
                      <tr
                        key={util.id}
                        data-bun-utility-id={util.id}
                        style={{
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.65)",
                        }}
                      >
                        <td
                          style={{
                            padding: "9px 14px",
                            fontFamily: MONO_FONT,
                            fontSize: "11.5px",
                            fontWeight: 600,
                            color: "#7dd3fc",
                            verticalAlign: "top",
                          }}
                        >
                          {util.signature}
                        </td>
                        <td style={{ padding: "9px 14px", verticalAlign: "top" }}>
                          <div style={{ color: "var(--text-primary, #e2e8f0)" }}>
                            {util.purpose}
                          </div>
                          {util.runtimeNotes ? (
                            <div
                              style={{
                                marginTop: "2px",
                                fontSize: "11px",
                                color: "#64748b",
                              }}
                            >
                              {util.runtimeNotes}
                            </div>
                          ) : null}
                        </td>
                        <td
                          style={{
                            padding: "9px 14px",
                            fontSize: "11px",
                            color: "var(--text-muted, #94a3b8)",
                            verticalAlign: "top",
                          }}
                        >
                          {util.categoryLabel}
                        </td>
                        <td
                          style={{
                            padding: "9px 14px",
                            textAlign: "right",
                            fontFamily: MONO_FONT,
                            fontSize: "11px",
                            fontWeight: 600,
                            color: available ? "#4ade80" : "#64748b",
                            verticalAlign: "top",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {available ? "Verified" : "Bun-only"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {/* VIEW 3: CORE BUN APIS */}
      {subTab === "core-apis" ? (
        <div
          data-runtime-view="core-apis"
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
              gap: "8px",
              padding: "10px 14px",
              borderBottomWidth: "1px",
              borderBottomStyle: "solid",
              borderBottomColor: "var(--border-default, #1e293b)",
            }}
          >
            <div style={{ fontSize: "12px", fontWeight: 700, color: "var(--text-primary, #f8fafc)" }}>
              Core Bun APIs (Bun.* &amp; bun:*) across {BUN_CORE_API_DOMAINS.length} Domains
            </div>
            <div
              style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                flex: "1 1 200px",
                maxWidth: "300px",
              }}
            >
              <Search
                size={13}
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: "9px",
                  color: "#64748b",
                  pointerEvents: "none",
                }}
              />
              <input
                type="search"
                aria-label="Search core Bun APIs"
                value={coreApiSearch}
                onChange={(e) => setCoreApiSearch(e.target.value)}
                placeholder="Filter by domain or API (e.g. s3, sqlite, dns)…"
                style={{
                  width: "100%",
                  padding: "5px 10px 5px 28px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontSize: "11.5px",
                }}
              />
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "12px",
              }}
            >
              <thead>
                <tr
                  style={{
                    textAlign: "left",
                    fontSize: "11px",
                    color: "var(--text-muted, #94a3b8)",
                    borderBottomWidth: "1px",
                    borderBottomStyle: "solid",
                    borderBottomColor: "var(--border-default, #1e293b)",
                  }}
                >
                  <th style={{ padding: "8px 14px", width: "175px", fontWeight: 600 }}>
                    Domain
                  </th>
                  <th style={{ padding: "8px 14px", width: "280px", fontWeight: 600 }}>
                    APIs
                  </th>
                  <th style={{ padding: "8px 14px", fontWeight: 600 }}>
                    Key Capabilities
                  </th>
                  <th
                    style={{
                      padding: "8px 14px",
                      width: "96px",
                      textAlign: "right",
                      fontWeight: 600,
                    }}
                  >
                    Live Probe
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredCoreDomains.map((domain) => {
                  const probe = coreDomainProbeMap.get(domain.id);
                  const allLive =
                    probe !== undefined &&
                    probe.totalProbed > 0 &&
                    probe.availableCount === probe.totalProbed;
                  return (
                    <tr
                      key={domain.id}
                      data-core-api-domain={domain.id}
                      style={{
                        borderBottomWidth: "1px",
                        borderBottomStyle: "solid",
                        borderBottomColor: "rgba(30, 41, 59, 0.65)",
                      }}
                    >
                      <td
                        style={{
                          padding: "10px 14px",
                          fontWeight: 700,
                          color: "var(--text-primary, #f8fafc)",
                          verticalAlign: "top",
                        }}
                      >
                        {domain.domain}
                        {domain.builtinModules.length > 0 ? (
                          <div
                            style={{
                              marginTop: "3px",
                              fontFamily: MONO_FONT,
                              fontSize: "10.5px",
                              fontWeight: 500,
                              color: "#c084fc",
                            }}
                          >
                            {domain.builtinModules.join(" · ")}
                          </div>
                        ) : null}
                      </td>
                      <td
                        style={{
                          padding: "10px 14px",
                          fontFamily: MONO_FONT,
                          fontSize: "11.5px",
                          color: "#7dd3fc",
                          lineHeight: 1.6,
                          verticalAlign: "top",
                        }}
                      >
                        {domain.apis.join(" · ")}
                      </td>
                      <td
                        style={{
                          padding: "10px 14px",
                          color: "var(--text-muted, #cbd5e1)",
                          lineHeight: 1.5,
                          verticalAlign: "top",
                        }}
                      >
                        {domain.capabilities}
                      </td>
                      <td
                        style={{
                          padding: "10px 14px",
                          textAlign: "right",
                          fontFamily: MONO_FONT,
                          fontVariantNumeric: "tabular-nums",
                          fontSize: "11.5px",
                          fontWeight: 600,
                          color: allLive
                            ? "#4ade80"
                            : (probe?.availableCount ?? 0) > 0
                              ? "#fbbf24"
                              : "#64748b",
                          verticalAlign: "top",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {probe ? `${probe.availableCount}/${probe.totalProbed}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {/* VIEW 4: LIVE SURFACE AUDIT */}
      {subTab === "live-audit" ? (
        <div
          data-runtime-view="live-audit"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          {/* Section 4 Snippet Card */}
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
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                padding: "9px 14px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border-default, #1e293b)",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "12px",
                  fontWeight: 700,
                  color: "var(--text-primary, #f8fafc)",
                }}
              >
                <Code2 size={14} aria-hidden="true" />
                <span>Live Surface Audit Snippet (Object.getOwnPropertyNames(Bun))</span>
              </div>
              <button
                type="button"
                onClick={() => void handleCopySnippet()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  padding: "5px 10px",
                  borderRadius: "5px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: copiedSnippet ? "#4ade80" : "var(--border-strong, #334155)",
                  backgroundColor: "transparent",
                  color: copiedSnippet ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {copiedSnippet ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
                <span>{copiedSnippet ? "Snippet Copied" : "Copy Snippet"}</span>
              </button>
            </div>
            <pre
              data-live-audit-snippet="true"
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
              {LIVE_SURFACE_AUDIT_SNIPPET}
            </pre>
          </div>

          {/* Live Enumerated Bun Namespace Table / Inspect Output */}
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
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "8px",
                padding: "10px 14px",
                borderBottomWidth: "1px",
                borderBottomStyle: "solid",
                borderBottomColor: "var(--border-default, #1e293b)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <div
                  role="group"
                  aria-label="Live audit output display mode"
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
                      { id: "table", label: `Structured Grid (${filteredExports.length})` },
                      { id: "inspect", label: "Bun.inspect.table() Raw" },
                    ] as const
                  ).map((mode) => {
                    const active = auditDisplayMode === mode.id;
                    return (
                      <button
                        key={mode.id}
                        type="button"
                        onClick={() => setAuditDisplayMode(mode.id)}
                        style={{
                          padding: "4px 9px",
                          borderRadius: "4px",
                          border: "none",
                          backgroundColor: active
                            ? "rgba(56, 189, 248, 0.14)"
                            : "transparent",
                          color: active ? "#38bdf8" : "var(--text-muted, #94a3b8)",
                          fontSize: "11px",
                          fontWeight: active ? 600 : 500,
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                </div>

                {auditDisplayMode === "table" && exportTypes.length > 0 ? (
                  <div
                    role="group"
                    aria-label="Filter exports by typeof"
                    style={{
                      display: "inline-flex",
                      flexWrap: "wrap",
                      gap: "4px",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setAuditTypeFilter("all")}
                      style={{
                        padding: "4px 8px",
                        borderRadius: "4px",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor:
                          auditTypeFilter === "all"
                            ? "#38bdf8"
                            : "var(--border-strong, #334155)",
                        backgroundColor:
                          auditTypeFilter === "all"
                            ? "rgba(56, 189, 248, 0.12)"
                            : "transparent",
                        color: auditTypeFilter === "all" ? "#38bdf8" : "#94a3b8",
                        fontSize: "11px",
                        fontFamily: MONO_FONT,
                        cursor: "pointer",
                      }}
                    >
                      all ({effectiveAudit.exportCount})
                    </button>
                    {exportTypes.map((t) => {
                      const active = auditTypeFilter === t;
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setAuditTypeFilter(t)}
                          style={{
                            padding: "4px 8px",
                            borderRadius: "4px",
                            borderWidth: "1px",
                            borderStyle: "solid",
                            borderColor: active
                              ? "#38bdf8"
                              : "var(--border-strong, #334155)",
                            backgroundColor: active
                              ? "rgba(56, 189, 248, 0.12)"
                              : "transparent",
                            color: active ? "#38bdf8" : "#94a3b8",
                            fontSize: "11px",
                            fontFamily: MONO_FONT,
                            cursor: "pointer",
                          }}
                        >
                          {t} ({effectiveAudit.exportTypeCounts[t] ?? 0})
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                {auditDisplayMode === "table" ? (
                  <div
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      width: "220px",
                    }}
                  >
                    <Search
                      size={13}
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left: "9px",
                        color: "#64748b",
                        pointerEvents: "none",
                      }}
                    />
                    <input
                      type="search"
                      aria-label="Filter Bun namespace exports"
                      value={auditSearch}
                      onChange={(e) => setAuditSearch(e.target.value)}
                      placeholder="Filter Bun.* export key…"
                      style={{
                        width: "100%",
                        padding: "5px 10px 5px 28px",
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
                ) : (
                  <>
                    <CopyBunTerminalAnsiButton
                      text={effectiveAudit.inspectTableText}
                      format="markdown"
                      compact
                    />
                    <button
                      type="button"
                      onClick={() => void handleCopyTable()}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "5px",
                        padding: "5px 10px",
                        borderRadius: "5px",
                        borderWidth: "1px",
                        borderStyle: "solid",
                        borderColor: copiedTable
                          ? "#4ade80"
                          : "var(--border-strong, #334155)",
                        backgroundColor: "transparent",
                        color: copiedTable ? "#4ade80" : "var(--text-primary, #e2e8f0)",
                        fontSize: "11px",
                        fontWeight: 600,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {copiedTable ? (
                        <Check size={12} aria-hidden="true" />
                      ) : (
                        <Copy size={12} aria-hidden="true" />
                      )}
                      <span>{copiedTable ? "Table Copied" : "Copy Table"}</span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {auditDisplayMode === "inspect" ? (
              <pre
                data-bun-inspect-table-output="true"
                style={{
                  margin: 0,
                  padding: "14px",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "#e2e8f0",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                  lineHeight: 1.45,
                  overflowX: "auto",
                  maxHeight: "420px",
                }}
              >
                {effectiveAudit.inspectTableText}
              </pre>
            ) : filteredExports.length === 0 ? (
              <div style={{ padding: "20px 14px", fontSize: "12px", color: "#94a3b8" }}>
                {effectiveAudit.exportCount === 0
                  ? "No live Bun namespace exports were captured on this host. Run under Bun or ensure `bun` is on PATH."
                  : "No Bun namespace exports match the current filter."}
              </div>
            ) : (
              <div style={{ maxHeight: "420px", overflowY: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontFamily: MONO_FONT,
                    fontSize: "11.5px",
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
                      <th style={{ padding: "7px 14px", width: "54px", textAlign: "right" }}>
                        #
                      </th>
                      <th style={{ padding: "7px 14px" }}>Export Key (Bun.*)</th>
                      <th style={{ padding: "7px 14px", width: "130px" }}>typeof</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredExports.map((entry, idx) => (
                      <tr
                        key={entry.key}
                        data-bun-export-key={entry.key}
                        style={{
                          borderBottomWidth: "1px",
                          borderBottomStyle: "solid",
                          borderBottomColor: "rgba(30, 41, 59, 0.55)",
                        }}
                      >
                        <td
                          style={{
                            padding: "6px 14px",
                            textAlign: "right",
                            color: "#64748b",
                          }}
                        >
                          {idx}
                        </td>
                        <td
                          style={{
                            padding: "6px 14px",
                            color: "var(--text-primary, #f1f5f9)",
                            fontWeight: 600,
                          }}
                        >
                          Bun.{entry.key}
                        </td>
                        <td
                          style={{
                            padding: "6px 14px",
                            color:
                              entry.type === "function"
                                ? "#7dd3fc"
                                : entry.type === "object"
                                  ? "#c084fc"
                                  : entry.type === "string"
                                    ? "#86efac"
                                    : "#fbbf24",
                          }}
                        >
                          {entry.type}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* VIEW 5: INTERACTIVE UTILITY SANDBOX */}
      {subTab === "sandbox" ? (
        <div
          data-runtime-view="sandbox"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
            gap: "12px",
          }}
        >
          {/* Card A: Strings & Terminal Utilities */}
          <div
            style={{
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              padding: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
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
                Strings &amp; Terminal Probe
              </div>
              <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
                Evaluates <code style={{ fontFamily: MONO_FONT }}>Bun.stringWidth</code>,{" "}
                <code style={{ fontFamily: MONO_FONT }}>Bun.stripANSI</code>, and{" "}
                <code style={{ fontFamily: MONO_FONT }}>Bun.escapeHTML</code> live.
              </div>
            </div>

            <input
              type="text"
              aria-label="String utility probe input"
              value={sandboxStringInput}
              onChange={(e) => setSandboxStringInput(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "7px 10px",
                borderRadius: "6px",
                borderWidth: "1px",
                borderStyle: "solid",
                borderColor: "var(--border-strong, #334155)",
                backgroundColor: "var(--surface-overlay, #0a101d)",
                color: "var(--text-primary, #f1f5f9)",
                fontFamily: MONO_FONT,
                fontSize: "11.5px",
              }}
            />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px",
                fontFamily: MONO_FONT,
                fontSize: "11.5px",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              <div>
                <div style={{ color: "#64748b", fontSize: "10.5px" }}>
                  Bun.stringWidth()
                </div>
                <div style={{ color: "#38bdf8", fontWeight: 700, marginTop: "2px" }}>
                  {stringProbe.displayWidth} cols
                </div>
              </div>
              <div>
                <div style={{ color: "#64748b", fontSize: "10.5px" }}>UTF-16 Length</div>
                <div style={{ color: "#e2e8f0", fontWeight: 700, marginTop: "2px" }}>
                  {stringProbe.rawLength} chars
                </div>
              </div>
            </div>

            <div style={{ fontFamily: MONO_FONT, fontSize: "11px" }}>
              <div style={{ color: "#64748b", marginBottom: "3px" }}>Bun.stripANSI()</div>
              <div
                style={{
                  padding: "7px 9px",
                  borderRadius: "5px",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "#86efac",
                  wordBreak: "break-word",
                }}
              >
                {stringProbe.stripped}
              </div>
            </div>

            <div style={{ fontFamily: MONO_FONT, fontSize: "11px" }}>
              <div style={{ color: "#64748b", marginBottom: "3px" }}>Bun.escapeHTML()</div>
              <div
                style={{
                  padding: "7px 9px",
                  borderRadius: "5px",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "#cbd5e1",
                  wordBreak: "break-word",
                }}
              >
                {stringProbe.escapedHtml}
              </div>
            </div>
          </div>

          {/* Card B: Bun.color & Bun.randomUUIDv7 */}
          <div
            style={{
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              padding: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
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
                Bun.color() &amp; Bun.randomUUIDv7()
              </div>
              <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
                Convert CSS colors to hex/rgb/number/ansi-16m and mint monotonic UUIDv7 IDs.
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span
                aria-hidden="true"
                style={{
                  width: "26px",
                  height: "26px",
                  borderRadius: "5px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: colorProbe.valid && colorProbe.hex ? colorProbe.hex : "#1e293b",
                  flexShrink: 0,
                }}
              />
              <input
                type="text"
                aria-label="Bun.color CSS input"
                value={sandboxColorInput}
                onChange={(e) => setSandboxColorInput(e.target.value)}
                placeholder="#38bdf8 or rgb(56, 189, 248)"
                style={{
                  flex: 1,
                  padding: "6px 10px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                }}
              />
            </div>

            {colorProbe.valid ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "6px 10px",
                  padding: "8px 10px",
                  borderRadius: "6px",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  fontFamily: MONO_FONT,
                  fontSize: "11px",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <div>
                  <span style={{ color: "#64748b" }}>hex: </span>
                  <span style={{ color: "#e2e8f0" }}>{colorProbe.hex}</span>
                </div>
                <div>
                  <span style={{ color: "#64748b" }}>number: </span>
                  <span style={{ color: "#fbbf24" }}>{colorProbe.number}</span>
                </div>
                <div>
                  <span style={{ color: "#64748b" }}>rgb: </span>
                  <span style={{ color: "#86efac" }}>{colorProbe.rgb}</span>
                </div>
                <div>
                  <span style={{ color: "#64748b" }}>ansi-16m: </span>
                  <span style={{ color: "#c084fc" }}>
                    {colorProbe.ansi16m?.replace(/\u001b/g, "\\x1b")}
                  </span>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: "11.5px", color: "#fbbf24" }}>
                Enter a valid hex (#38bdf8) or rgb(r, g, b) color.
              </div>
            )}

            <div
              style={{
                borderTopWidth: "1px",
                borderTopStyle: "solid",
                borderTopColor: "var(--border-default, #1e293b)",
                paddingTop: "10px",
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
                <span style={{ fontSize: "11.5px", fontWeight: 600, color: "#e2e8f0" }}>
                  Time-Ordered UUIDv7 Generator
                </span>
                <button
                  type="button"
                  data-generate-uuidv7="true"
                  onClick={handleMintUuidV7}
                  style={{
                    padding: "5px 10px",
                    borderRadius: "5px",
                    borderWidth: "1px",
                    borderStyle: "solid",
                    borderColor: "#38bdf8",
                    backgroundColor: "rgba(56, 189, 248, 0.12)",
                    color: "#38bdf8",
                    fontSize: "11px",
                    fontWeight: 600,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  Generate UUIDv7
                </button>
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  fontFamily: MONO_FONT,
                  fontSize: "11px",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {uuidHistory.map((id) => (
                  <div
                    key={id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "8px",
                      padding: "5px 8px",
                      borderRadius: "4px",
                      backgroundColor: "var(--surface-overlay, #0a101d)",
                    }}
                  >
                    <span style={{ color: "#7dd3fc" }}>{id}</span>
                    <span style={{ color: "#64748b", fontSize: "10px" }}>
                      {decodeUuidV7TimestampIso(id)?.slice(11, 23)}Z
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Card C: Bun.deepEquals Comparator */}
          <div
            style={{
              gridColumn: "1 / -1",
              borderRadius: "8px",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "var(--border-default, #1e293b)",
              backgroundColor: "var(--surface-panel, #0f172a)",
              padding: "14px",
              display: "flex",
              flexDirection: "column",
              gap: "10px",
            }}
          >
            <div
              style={{
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
                  Bun.deepEquals(a, b, strict) Structural Comparator
                </div>
                <div style={{ marginTop: "2px", fontSize: "11px", color: "#94a3b8" }}>
                  Compare two JSON values using Bun&apos;s deep structural equality semantics.
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    fontSize: "11.5px",
                    fontFamily: MONO_FONT,
                    color: "var(--text-muted, #cbd5e1)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={deepEqStrict}
                    onChange={(e) => setDeepEqStrict(e.target.checked)}
                  />
                  <span>strict: {String(deepEqStrict)}</span>
                </label>

                <span
                  data-deep-equals-verdict={
                    deepEqResult.ok ? String(deepEqResult.equal) : "error"
                  }
                  style={{
                    fontFamily: MONO_FONT,
                    fontSize: "12px",
                    fontWeight: 700,
                    color: !deepEqResult.ok
                      ? "#f87171"
                      : deepEqResult.equal
                        ? "#4ade80"
                        : "#fbbf24",
                  }}
                >
                  {!deepEqResult.ok
                    ? `JSON Error: ${deepEqResult.error}`
                    : deepEqResult.equal
                      ? "Result: true (structurally equal)"
                      : "Result: false (differs)"}
                </span>
              </div>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
                gap: "10px",
              }}
            >
              <textarea
                aria-label="Bun.deepEquals left JSON"
                value={deepEqLeft}
                onChange={(e) => setDeepEqLeft(e.target.value)}
                rows={5}
                spellCheck={false}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                  lineHeight: 1.5,
                }}
              />
              <textarea
                aria-label="Bun.deepEquals right JSON"
                value={deepEqRight}
                onChange={(e) => setDeepEqRight(e.target.value)}
                rows={5}
                spellCheck={false}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "9px",
                  borderRadius: "6px",
                  borderWidth: "1px",
                  borderStyle: "solid",
                  borderColor: "var(--border-strong, #334155)",
                  backgroundColor: "var(--surface-overlay, #0a101d)",
                  color: "var(--text-primary, #f1f5f9)",
                  fontFamily: MONO_FONT,
                  fontSize: "11.5px",
                  lineHeight: 1.5,
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
