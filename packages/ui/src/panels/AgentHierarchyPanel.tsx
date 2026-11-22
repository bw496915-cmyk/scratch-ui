/**
 * @file packages/ui/src/panels/AgentHierarchyPanel.tsx
 * @description Interactive Fantasy402 `getListAgenstByAgent` (`GENERAL` / `PLAYERS`)
 * Agent Hierarchy & Sanitized Player Directory panel integrated into Rankings.
 *
 * Security invariant: `PLAYERS[].Password` is stripped client-side before upload
 * AND server-side on ingest. Plaintext passwords are never transmitted or stored.
 */

import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  RotateCcw,
  Search,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";
import {
  getActiveRateEntries,
  sanitizeFantasy402RawTextBeforeUpload,
  type AgentHierarchyDirectoryResponse,
  type AgentHierarchyIngestResponse,
  type AgentHierarchyNodeRecord,
} from "@sportsdesk-ops/contracts";
import { getDevCsrfToken, trackedFetch } from "../api_usage.ts";
import { styles } from "../dashboard_styles.ts";
import { SkeletonTableRows } from "./PanelSkeleton.tsx";

export interface AgentHierarchyPanelProps {
  readonly onSelectAgent?: ((agentId: string) => void) | undefined;
  readonly onSelectCustomerById?: ((customerId: string) => void) | undefined;
  readonly initialDirectory?: AgentHierarchyDirectoryResponse | null | undefined;
}

const TABULAR_NUMS: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
};

/**
 * Representative synthetic Fantasy402 hierarchy fixture for quick one-click testing.
 * Contains strictly synthetic placeholder records (zero real passwords).
 */
export const SAMPLE_FANTASY402_HIERARCHY_JSON = JSON.stringify(
  {
    EXTRA: false,
    GENERAL: [
      {
        AgentID: "BILLY667  ",
        SeqNumber: 5223,
        Level: 1,
        AgentType: "A",
        Login: "BILLY667  ",
        HeadCountRateM: 1,
        InetHeadCountRateM: 0,
        LiveBettingRateM: 0,
        LiveBetting2RateM: 0,
        LiveCasinoRateM: 0,
        CasinoHeadCountRateM: 0,
        PropBuilderRateM: 0,
        BetBuilderRate: 0,
        AmigoTechRate: 0,
        CrashRate: 0,
        ExtPropsRate: 0,
        FantasyRate: 0,
        FlashBetsRate: 0,
        GitCasinoRate: 0,
      },
      {
        AgentID: "NOLAWOLF  ",
        SeqNumber: 5224,
        Level: 1,
        AgentType: "M",
        Login: "NOLAWOLF  ",
        HeadCountRateM: 10,
        LiveBettingRateM: 5,
        PropBuilderRateM: 2,
      },
      {
        AgentID: "NOLAPPH   ",
        SeqNumber: 5230,
        Level: 2,
        AgentType: "M",
        Login: "NOLAPPH",
        HeadCountRateM: 8,
        LiveBettingRateM: 4,
      },
      {
        AgentID: "AUSTINPPH2",
        SeqNumber: 5231,
        Level: 3,
        AgentType: "M",
        Login: "AUSTINPPH2",
        HeadCountRateM: 6,
        PropBuilderRateM: 3,
      },
      {
        AgentID: "BAILEYMA  ",
        SeqNumber: 5232,
        Level: 4,
        AgentType: "M",
        Login: "BAILEYMA",
        HeadCountRateM: 5,
        LiveBettingRateM: 2,
        BetBuilderRate: 1,
      },
      {
        AgentID: "AFB1BB    ",
        SeqNumber: 5233,
        Level: 5,
        AgentType: "A",
        Login: "AFB1BB    ",
        HeadCountRateM: 5,
      },
      {
        AgentID: "BAILEYPPH ",
        SeqNumber: 5234,
        Level: 5,
        AgentType: "A",
        Login: "BAILEYPPH",
        HeadCountRateM: 5,
      },
      {
        AgentID: "JMBOOK    ",
        SeqNumber: 5248,
        Level: 5,
        AgentType: "A",
        Login: "JMBOOK",
        HeadCountRateM: 0,
      },
    ],
    PLAYERS: [
      {
        customerID: "1_0       ",
        Login: "1",
        NameFirst: "Sample Player",
        Agent: "AFB1BB",
      },
      {
        customerID: "1001      ",
        Login: "1001",
        NameFirst: "Austin Demo",
        Agent: "BAILEYPPH",
      },
      {
        customerID: "1002      ",
        Login: "1002",
        NameFirst: "Desk Account",
        Agent: "JMBOOK",
      },
    ],
  },
  null,
  2,
);

function formatRateSummary(node: AgentHierarchyNodeRecord): string {
  if (!node.rateCard) return "—";
  const active = getActiveRateEntries(node.rateCard);
  if (active.length === 0) return "$0";
  const topTwo = active
    .slice(0, 2)
    .map((r) => `${r.label.split(" ")[0]} $${r.value}`)
    .join(" · ");
  return active.length > 2 ? `${topTwo} (+${active.length - 2})` : topTwo;
}

export function AgentHierarchyPanel({
  onSelectAgent,
  onSelectCustomerById,
  initialDirectory = null,
}: AgentHierarchyPanelProps): React.ReactElement {
  const [directory, setDirectory] =
    useState<AgentHierarchyDirectoryResponse | null>(initialDirectory);
  const [loading, setLoading] = useState<boolean>(initialDirectory === null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState<string>("");
  const [rootFilter, setRootFilter] = useState<string>("ALL");
  const [agentTypeFilter, setAgentTypeFilter] = useState<"ALL" | "M" | "A">(
    "ALL",
  );
  const [levelFilter, setLevelFilter] = useState<string>("ALL");
  const [pageOffset, setPageOffset] = useState<number>(0);
  const [showPlayersTable, setShowPlayersTable] = useState<boolean>(false);

  const [ingestOpen, setIngestOpen] = useState<boolean>(false);
  const [ingestText, setIngestText] = useState<string>("");
  const [ingestBusy, setIngestBusy] = useState<boolean>(false);
  const [ingestMessage, setIngestMessage] = useState<{
    readonly tone: "ok" | "error";
    readonly text: string;
  } | null>(null);

  const pageSize = 50;

  const fetchDirectory = useCallback(
    async (opts: {
      readonly q: string;
      readonly root: string;
      readonly agentType: "ALL" | "M" | "A";
      readonly level: string;
      readonly offset: number;
    }) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (opts.q.trim()) params.set("q", opts.q.trim());
        if (opts.root !== "ALL") params.set("root", opts.root);
        if (opts.agentType !== "ALL") params.set("agentType", opts.agentType);
        if (opts.level !== "ALL") params.set("level", opts.level);
        params.set("limit", String(pageSize));
        params.set("offset", String(opts.offset));

        const res = await trackedFetch(
          `/api/agent-tree/directory?${params.toString()}`,
          { credentials: "include" },
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as AgentHierarchyDirectoryResponse;
        setDirectory(data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to load Fantasy402 agent hierarchy directory",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (initialDirectory !== null && !query && rootFilter === "ALL" && agentTypeFilter === "ALL" && levelFilter === "ALL" && pageOffset === 0) {
      return;
    }
    const timer = setTimeout(() => {
      void fetchDirectory({
        q: query,
        root: rootFilter,
        agentType: agentTypeFilter,
        level: levelFilter,
        offset: pageOffset,
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [
    fetchDirectory,
    initialDirectory,
    query,
    rootFilter,
    agentTypeFilter,
    levelFilter,
    pageOffset,
  ]);

  const handleIngestSubmit = async () => {
    const trimmed = ingestText.trim();
    if (!trimmed) {
      setIngestMessage({
        tone: "error",
        text: 'Paste a Fantasy402 JSON payload ({ "EXTRA": false, "GENERAL": [...], "PLAYERS": [...] }) before ingesting.',
      });
      return;
    }

    setIngestBusy(true);
    setIngestMessage(null);
    try {
      // Defense-in-depth: strip any PLAYERS[].Password fields in the browser BEFORE POSTing
      const preflight = sanitizeFantasy402RawTextBeforeUpload(trimmed);
      const csrf = getDevCsrfToken();
      const headers: Record<string, string> = {
        "Content-Type": preflight.parsedAsJson
          ? "application/json"
          : "text/plain",
      };
      if (csrf) headers["x-csrf-token"] = csrf;

      const res = await trackedFetch("/api/agent-tree/ingest", {
        method: "POST",
        credentials: "include",
        headers,
        body: preflight.sanitizedText,
      });

      const body = (await res.json()) as
        | AgentHierarchyIngestResponse
        | { readonly ok?: false; readonly error?: string };

      if (!res.ok || !("ok" in body) || !body.ok) {
        const errMsg =
          "error" in body && typeof body.error === "string"
            ? body.error
            : `Ingest failed (HTTP ${res.status})`;
        setIngestMessage({ tone: "error", text: errMsg });
        return;
      }

      const totalStripped =
        preflight.passwordsStripped + body.passwordsStripped;
      setIngestMessage({
        tone: "ok",
        text: `Ingested ${body.ingestedAgents.toLocaleString()} agents & ${body.ingestedPlayers.toLocaleString()} players.${
          totalStripped > 0
            ? ` Stripped ${totalStripped.toLocaleString()} password field(s) before storage.`
            : " Zero passwords retained."
        }`,
      });
      setPageOffset(0);
      if (body.ingestedPlayers > 0) {
        setShowPlayersTable(true);
      }
      await fetchDirectory({
        q: query,
        root: rootFilter,
        agentType: agentTypeFilter,
        level: levelFilter,
        offset: 0,
      });
    } catch (err) {
      setIngestMessage({
        tone: "error",
        text: err instanceof Error ? err.message : "Failed to ingest hierarchy payload",
      });
    } finally {
      setIngestBusy(false);
    }
  };

  const handleResetToBaseline = async () => {
    setIngestBusy(true);
    setIngestMessage(null);
    try {
      const csrf = getDevCsrfToken();
      const headers: Record<string, string> = {};
      if (csrf) headers["x-csrf-token"] = csrf;
      const res = await trackedFetch("/api/agent-tree/reset", {
        method: "POST",
        credentials: "include",
        headers,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          body.error ?? `Admin role required to reset hierarchy (HTTP ${res.status})`,
        );
      }
      setIngestText("");
      setShowPlayersTable(false);
      setPageOffset(0);
      setIngestMessage({
        tone: "ok",
        text: "Restored disk baseline agent hierarchy (data/agent-tree.json).",
      });
      await fetchDirectory({
        q: query,
        root: rootFilter,
        agentType: agentTypeFilter,
        level: levelFilter,
        offset: 0,
      });
    } catch (err) {
      setIngestMessage({
        tone: "error",
        text: err instanceof Error ? err.message : "Failed to reset hierarchy",
      });
    } finally {
      setIngestBusy(false);
    }
  };

  const summary = directory?.summary ?? null;
  const levelOptions = useMemo(() => {
    if (!summary) return [];
    return Object.entries(summary.levelCounts)
      .map(([lvl, count]) => ({ level: Number(lvl), count }))
      .filter((x) => Number.isFinite(x.level))
      .sort((a, b) => a.level - b.level);
  }, [summary]);

  const handleRowClick = (
    e: React.MouseEvent<HTMLTableRowElement>,
    agentId: string,
  ) => {
    if (!onSelectAgent) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, select")) return;
    onSelectAgent(agentId);
  };

  const handleRowKeyDown = (
    e: React.KeyboardEvent<HTMLTableRowElement>,
    agentId: string,
  ) => {
    if (!onSelectAgent) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    onSelectAgent(agentId);
  };

  const totalMatchedNodes = directory?.totalMatchedNodes ?? 0;
  const pageStart = totalMatchedNodes === 0 ? 0 : pageOffset + 1;
  const pageEnd = Math.min(pageOffset + pageSize, totalMatchedNodes);

  return (
    <section
      data-agent-hierarchy-panel="true"
      aria-label="Fantasy402 Agent Tree and Player Directory"
      style={{
        ...styles.tableCard,
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      }}
    >
      {/* Header Row */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "12px",
        }}
      >
        <div>
          <h3
            style={{
              margin: 0,
              fontSize: "15px",
              fontWeight: 700,
              color: "#f8fafc",
              display: "inline-flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <GitBranch size={15} style={{ color: "#38bdf8" }} aria-hidden="true" />
            <span>Fantasy402 Agent Tree &amp; Player Directory</span>
          </h3>
          <div
            style={{
              marginTop: "5px",
              fontSize: "12px",
              color: "#94a3b8",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
              ...TABULAR_NUMS,
            }}
          >
            {summary ? (
              <>
                <span>{summary.totalAgents.toLocaleString()} agents</span>
                <span aria-hidden="true">·</span>
                <span>{summary.masterCount.toLocaleString()} Masters (M)</span>
                <span aria-hidden="true">·</span>
                <span>{summary.subAgentCount.toLocaleString()} Sub-Agents (A)</span>
                <span aria-hidden="true">·</span>
                <span>Max Depth L{summary.maxDepth}</span>
                <span aria-hidden="true">·</span>
                <span>{summary.totalPlayers.toLocaleString()} players indexed</span>
                {summary.passwordsStripped > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span style={{ color: "#4ade80", fontWeight: 600 }}>
                      {summary.passwordsStripped.toLocaleString()} passwords stripped
                    </span>
                  </>
                )}
              </>
            ) : (
              <span>Loading agent hierarchy index…</span>
            )}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            data-hierarchy-toggle-ingest="true"
            onClick={() => setIngestOpen((prev) => !prev)}
            style={{
              ...styles.actionBtn,
              padding: "6px 12px",
              fontSize: "12px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              whiteSpace: "nowrap",
              borderColor: ingestOpen ? "#38bdf8" : undefined,
              backgroundColor: ingestOpen
                ? "rgba(56, 189, 248, 0.16)"
                : undefined,
            }}
          >
            <Upload size={13} aria-hidden="true" />
            <span>Ingest GENERAL / PLAYERS JSON</span>
            {ingestOpen ? (
              <ChevronDown size={13} aria-hidden="true" />
            ) : (
              <ChevronRight size={13} aria-hidden="true" />
            )}
          </button>

          {summary?.source === "ingested-f402" && (
            <button
              type="button"
              data-hierarchy-reset="true"
              disabled={ingestBusy}
              onClick={handleResetToBaseline}
              style={{
                ...styles.actionBtn,
                padding: "6px 10px",
                fontSize: "12px",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                whiteSpace: "nowrap",
              }}
              title="Restore disk baseline agent-tree.json (Admin required)"
            >
              <RotateCcw size={12} aria-hidden="true" />
              <span>Reset Baseline</span>
            </button>
          )}
        </div>
      </div>

      {/* Collapsible Fantasy402 JSON Ingest Drawer */}
      {ingestOpen && (
        <div
          data-hierarchy-ingest-drawer="true"
          style={{
            padding: "14px 16px",
            borderRadius: "8px",
            backgroundColor: "rgba(15, 23, 42, 0.72)",
            border: "1px solid #334155",
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
            <div
              style={{
                fontSize: "12px",
                color: "#cbd5e1",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              <ShieldCheck size={14} style={{ color: "#4ade80", flexShrink: 0 }} aria-hidden="true" />
              <span>
                Paste Fantasy402 <code>getListAgenstByAgent</code> JSON (
                <code>{"{ EXTRA, GENERAL, PLAYERS }"}</code>).{" "}
                <strong style={{ color: "#86efac" }}>
                  PLAYERS[].Password is stripped before upload and never stored.
                </strong>
              </span>
            </div>
            <button
              type="button"
              data-hierarchy-load-sample="true"
              onClick={() => {
                setIngestText(SAMPLE_FANTASY402_HIERARCHY_JSON);
                setIngestMessage(null);
              }}
              style={{
                ...styles.actionBtn,
                padding: "4px 10px",
                fontSize: "11px",
                whiteSpace: "nowrap",
              }}
            >
              Load Sample Snapshot
            </button>
          </div>

          <textarea
            data-hierarchy-ingest-input="true"
            value={ingestText}
            onChange={(e) => setIngestText(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder='{"EXTRA": false, "GENERAL": [{"AgentID": "BILLY667  ", "SeqNumber": 5223, "Level": 1, "AgentType": "A", "HeadCountRateM": 1, ...}], "PLAYERS": [{"customerID": "1_0", "Login": "1", "NameFirst": "Dummy", "Agent": "JKN"}]}'
            aria-label="Fantasy402 GENERAL and PLAYERS JSON payload"
            style={{
              width: "100%",
              boxSizing: "border-box",
              backgroundColor: "#020617",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: "6px",
              padding: "10px 12px",
              fontSize: "12px",
              fontFamily:
                "'JetBrains Mono', 'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
              resize: "vertical",
              lineHeight: 1.5,
            }}
          />

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
            }}
          >
            <div style={{ fontSize: "11.5px", color: "#94a3b8" }}>
              Tip: In Chrome DevTools, right-click the API response object and
              choose <em>Copy object</em> so arrays are not truncated as{" "}
              <code>[100 … 199]</code>.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                onClick={() => {
                  setIngestText("");
                  setIngestMessage(null);
                }}
                style={{
                  ...styles.actionBtn,
                  padding: "6px 12px",
                  fontSize: "12px",
                  whiteSpace: "nowrap",
                }}
              >
                Clear
              </button>
              <button
                type="button"
                data-hierarchy-ingest-submit="true"
                disabled={ingestBusy}
                onClick={() => void handleIngestSubmit()}
                style={{
                  padding: "6px 14px",
                  borderRadius: "6px",
                  border: "1px solid #0284c7",
                  backgroundColor: "#0284c7",
                  color: "#f8fafc",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: ingestBusy ? "wait" : "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {ingestBusy ? "Reconstructing Tree…" : "Parse & Ingest Hierarchy"}
              </button>
            </div>
          </div>

          {ingestMessage && (
            <div
              role={ingestMessage.tone === "error" ? "alert" : "status"}
              data-hierarchy-ingest-status={ingestMessage.tone}
              style={{
                padding: "8px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                backgroundColor:
                  ingestMessage.tone === "error"
                    ? "rgba(239, 68, 68, 0.14)"
                    : "rgba(34, 197, 94, 0.12)",
                border:
                  ingestMessage.tone === "error"
                    ? "1px solid rgba(239, 68, 68, 0.4)"
                    : "1px solid rgba(34, 197, 94, 0.35)",
                color: ingestMessage.tone === "error" ? "#fca5a5" : "#86efac",
              }}
            >
              {ingestMessage.text}
            </div>
          )}
        </div>
      )}

      {/* Filter Toolbar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
            flex: "1 1 320px",
          }}
        >
          <div style={{ ...styles.searchBox, flex: "1 1 220px", maxWidth: "360px" }}>
            <Search
              size={14}
              style={{ color: "#64748b", flexShrink: 0, marginLeft: "10px" }}
              aria-hidden="true"
            />
            <input
              data-hierarchy-search="true"
              style={styles.searchInput}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPageOffset(0);
              }}
              placeholder="Search AgentID, Seq#, Parent, or Player ID / Name..."
              aria-label="Search Fantasy402 agent tree and players"
            />
          </div>

          {/* Agent Type Segmented Filter */}
          <div
            role="group"
            aria-label="Filter by agent type"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
              padding: "3px",
              borderRadius: "7px",
              backgroundColor: "rgba(15, 23, 42, 0.7)",
              border: "1px solid #334155",
            }}
          >
            {(
              [
                { id: "ALL", label: "All Types" },
                { id: "M", label: "Masters (M)" },
                { id: "A", label: "Sub-Agents (A)" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                data-hierarchy-type-filter={opt.id}
                onClick={() => {
                  setAgentTypeFilter(opt.id);
                  setPageOffset(0);
                }}
                style={{
                  padding: "4px 9px",
                  borderRadius: "5px",
                  border: "none",
                  fontSize: "11px",
                  fontWeight: 600,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  backgroundColor:
                    agentTypeFilter === opt.id
                      ? "rgba(56, 189, 248, 0.2)"
                      : "transparent",
                  color: agentTypeFilter === opt.id ? "#38bdf8" : "#94a3b8",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Root Trunk Selector */}
          <select
            aria-label="Filter by root trunk"
            data-hierarchy-root-select="true"
            value={rootFilter}
            onChange={(e) => {
              setRootFilter(e.target.value);
              setPageOffset(0);
            }}
            style={{
              backgroundColor: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: "6px",
              padding: "5px 9px",
              fontSize: "12px",
            }}
          >
            <option value="ALL">
              All Root Trunks ({summary?.rootCount ?? 0})
            </option>
            {(summary?.roots ?? []).slice(0, 40).map((root) => (
              <option key={root} value={root}>
                Root: {root}
              </option>
            ))}
          </select>

          {/* Depth Level Selector */}
          <select
            aria-label="Filter by hierarchy level"
            data-hierarchy-level-select="true"
            value={levelFilter}
            onChange={(e) => {
              setLevelFilter(e.target.value);
              setPageOffset(0);
            }}
            style={{
              backgroundColor: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: "6px",
              padding: "5px 9px",
              fontSize: "12px",
            }}
          >
            <option value="ALL">All Levels</option>
            {levelOptions.map((item) => (
              <option key={item.level} value={String(item.level)}>
                Level {item.level} ({item.count.toLocaleString()})
              </option>
            ))}
          </select>
        </div>

        {/* Toggle Sanitized Players View when players are indexed */}
        {summary && summary.totalPlayers > 0 && (
          <button
            type="button"
            data-hierarchy-toggle-players="true"
            onClick={() => setShowPlayersTable((prev) => !prev)}
            style={{
              ...styles.actionBtn,
              padding: "5px 10px",
              fontSize: "11.5px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              whiteSpace: "nowrap",
              borderColor: showPlayersTable ? "#38bdf8" : undefined,
              backgroundColor: showPlayersTable
                ? "rgba(56, 189, 248, 0.16)"
                : undefined,
            }}
          >
            <Users size={12} aria-hidden="true" />
            <span>
              {showPlayersTable ? "Hide" : "Show"} Sanitized Players (
              {(directory?.totalMatchedPlayers ?? 0).toLocaleString()})
            </span>
          </button>
        )}
      </div>

      {error && (
        <div
          role="alert"
          style={{
            padding: "8px 12px",
            borderRadius: "6px",
            backgroundColor: "rgba(239, 68, 68, 0.14)",
            border: "1px solid rgba(239, 68, 68, 0.4)",
            color: "#fca5a5",
            fontSize: "12px",
          }}
        >
          Could not load agent hierarchy: {error}
        </div>
      )}

      {/* Agent Tree Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={styles.table} data-agent-hierarchy-table="true">
          <thead>
            <tr>
              <th style={styles.th}>AgentID &amp; Depth</th>
              <th style={styles.th}>Type</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Seq #</th>
              <th style={styles.th}>Parent</th>
              <th style={styles.th}>Root Trunk</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Downline</th>
              <th style={styles.th}>Rate Card</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Players</th>
            </tr>
          </thead>
          <tbody>
            {loading && !directory ? (
              <SkeletonTableRows
                rowCount={5}
                columnWidths={[
                  "78%",
                  "64%",
                  "54%",
                  "68%",
                  "66%",
                  "52%",
                  "72%",
                  "48%",
                ]}
                skeletonId="agent-hierarchy-rows"
              />
            ) : directory && directory.nodes.length > 0 ? (
              directory.nodes.map((node) => {
                const indentPx = Math.min(6, Math.max(0, node.level - 1)) * 14;
                return (
                  <tr
                    key={node.agentId}
                    className={
                      onSelectAgent ? "sd-rankings-clickable-row" : undefined
                    }
                    data-hierarchy-row-agent={node.agentId}
                    tabIndex={onSelectAgent ? 0 : undefined}
                    title={
                      onSelectAgent
                        ? `Click row to open Agent Inspector for ${node.agentId}`
                        : undefined
                    }
                    onClick={(e) => handleRowClick(e, node.agentId)}
                    onKeyDown={(e) => handleRowKeyDown(e, node.agentId)}
                  >
                    <td style={styles.td}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "7px",
                          paddingLeft: `${indentPx}px`,
                        }}
                      >
                        <span
                          style={{
                            fontSize: "11px",
                            color: "#64748b",
                            ...TABULAR_NUMS,
                          }}
                        >
                          L{node.level}
                        </span>
                        <button
                          type="button"
                          onClick={() => onSelectAgent?.(node.agentId)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            color:
                              node.agentType === "M" ? "#38bdf8" : "#e2e8f0",
                            fontWeight: node.agentType === "M" ? 700 : 600,
                            cursor: onSelectAgent ? "pointer" : "default",
                            fontSize: "12.5px",
                            textAlign: "left",
                          }}
                        >
                          {node.agentId}
                        </button>
                        {node.hasPunctuationCollision && (
                          <span
                            style={{ fontSize: "10.5px", color: "#fbbf24" }}
                            title="Punctuation-normalized ID collision detected"
                          >
                            · collision
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...styles.td, fontSize: "12px" }}>
                      <span
                        style={{
                          color: node.agentType === "M" ? "#38bdf8" : "#94a3b8",
                          fontWeight: node.agentType === "M" ? 600 : 400,
                        }}
                      >
                        {node.agentType === "M" ? "Master (M)" : `Agent (${node.agentType})`}
                      </span>
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        textAlign: "right",
                        color: "#94a3b8",
                        ...TABULAR_NUMS,
                      }}
                    >
                      {node.seqNumber !== null ? node.seqNumber : "—"}
                    </td>
                    <td style={styles.td}>
                      {node.parentAgentId ? (
                        <button
                          type="button"
                          onClick={() => onSelectAgent?.(node.parentAgentId!)}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            color: "#cbd5e1",
                            cursor: onSelectAgent ? "pointer" : "default",
                            fontSize: "12px",
                          }}
                        >
                          {node.parentAgentId}
                        </button>
                      ) : (
                        <span style={{ color: "#64748b", fontSize: "12px" }}>
                          Root
                        </span>
                      )}
                    </td>
                    <td style={{ ...styles.td, color: "#94a3b8", fontSize: "12px" }}>
                      {node.rootMasterAgent}
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        textAlign: "right",
                        ...TABULAR_NUMS,
                        color: "#cbd5e1",
                      }}
                    >
                      {node.directChildCount > 0
                        ? `${node.directChildCount} (${node.descendantCount})`
                        : "0"}
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        fontSize: "12px",
                        color:
                          node.rateCard && node.rateCard.activeRateCount > 0
                            ? "#4ade80"
                            : "#64748b",
                        ...TABULAR_NUMS,
                      }}
                    >
                      {formatRateSummary(node)}
                    </td>
                    <td
                      style={{
                        ...styles.td,
                        textAlign: "right",
                        fontWeight: node.playerCount > 0 ? 600 : 400,
                        color: node.playerCount > 0 ? "#f8fafc" : "#64748b",
                        ...TABULAR_NUMS,
                      }}
                    >
                      {node.playerCount.toLocaleString()}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td
                  colSpan={8}
                  style={{
                    ...styles.td,
                    textAlign: "center",
                    color: "#94a3b8",
                    padding: "18px",
                  }}
                >
                  No Fantasy402 agent nodes match the active filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {directory && totalMatchedNodes > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "10px",
            fontSize: "12px",
            color: "#94a3b8",
            ...TABULAR_NUMS,
          }}
        >
          <span>
            Showing {pageStart.toLocaleString()}–{pageEnd.toLocaleString()} of{" "}
            {totalMatchedNodes.toLocaleString()} matched agents · Source:{" "}
            {summary?.sourceLabel}
          </span>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <button
              type="button"
              disabled={pageOffset === 0 || loading}
              onClick={() => setPageOffset((prev) => Math.max(0, prev - pageSize))}
              style={{
                ...styles.actionBtn,
                padding: "4px 10px",
                fontSize: "11.5px",
                opacity: pageOffset === 0 ? 0.45 : 1,
              }}
            >
              Previous
            </button>
            <button
              type="button"
              disabled={pageOffset + pageSize >= totalMatchedNodes || loading}
              onClick={() => setPageOffset((prev) => prev + pageSize)}
              style={{
                ...styles.actionBtn,
                padding: "4px 10px",
                fontSize: "11.5px",
                opacity:
                  pageOffset + pageSize >= totalMatchedNodes ? 0.45 : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Optional Sanitized Player Roster Table (zero password column!) */}
      {showPlayersTable && directory && directory.players.length > 0 && (
        <div
          data-hierarchy-players-table="true"
          style={{
            borderTop: "1px solid #1e293b",
            paddingTop: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div
            style={{
              fontSize: "12.5px",
              fontWeight: 600,
              color: "#cbd5e1",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "8px",
              ...TABULAR_NUMS,
            }}
          >
            <span>
              Sanitized Player Roster ({directory.players.length.toLocaleString()}{" "}
              of {directory.totalMatchedPlayers.toLocaleString()})
            </span>
            <span style={{ fontSize: "11.5px", color: "#86efac", fontWeight: 500 }}>
              Passwords stripped · customerID / Login / NameFirst / Agent only
            </span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Customer ID</th>
                  <th style={styles.th}>Login</th>
                  <th style={styles.th}>First Name</th>
                  <th style={styles.th}>Assigned Agent</th>
                  <th style={styles.th}>Root Trunk</th>
                </tr>
              </thead>
              <tbody>
                {directory.players.map((p, idx) => (
                  <tr key={`${p.customerId}-${p.agentId}-${idx}`}>
                    <td style={{ ...styles.td, ...TABULAR_NUMS }}>
                      <button
                        type="button"
                        onClick={() => onSelectCustomerById?.(p.customerId)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "#38bdf8",
                          fontWeight: 600,
                          cursor: onSelectCustomerById ? "pointer" : "default",
                          fontSize: "12px",
                        }}
                      >
                        {p.customerId}
                      </button>
                    </td>
                    <td style={{ ...styles.td, ...TABULAR_NUMS, color: "#cbd5e1" }}>
                      {p.login}
                    </td>
                    <td style={{ ...styles.td, color: "#94a3b8" }}>
                      {p.nameFirst || "—"}
                    </td>
                    <td style={styles.td}>
                      <button
                        type="button"
                        onClick={() => onSelectAgent?.(p.agentId)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          color: "#f8fafc",
                          fontWeight: 600,
                          cursor: onSelectAgent ? "pointer" : "default",
                          fontSize: "12px",
                        }}
                      >
                        {p.agentId}
                      </button>
                    </td>
                    <td style={{ ...styles.td, color: "#94a3b8" }}>
                      {p.rootMasterAgent ?? "Unmapped"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
