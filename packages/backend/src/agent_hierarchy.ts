/**
 * @file packages/backend/src/agent_hierarchy.ts
 * @description Fantasy402 `getListAgenstByAgent` (`{ EXTRA, GENERAL, PLAYERS }`)
 * pre-order `(SeqNumber, Level)` hierarchy reconstructor, rate-card aggregator,
 * zero-password-retention player directory sanitizer, and stateful in-memory store.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FANTASY402_RATE_FIELDS,
  type AgentHierarchyCollisionGroup,
  type AgentHierarchyDirectoryResponse,
  type AgentHierarchyDirectorySummary,
  type AgentHierarchyIngestResponse,
  type AgentHierarchyNodeRecord,
  type Fantasy402RateCard,
  type SanitizedFantasy402Player,
} from "@sportsdesk-ops/contracts";

export const MAX_INGEST_AGENTS = 25_000;
export const MAX_INGEST_PLAYERS = 120_000;

interface DiskAgentTreeNode {
  readonly l?: number | null;
  readonly p?: string | null;
  readonly t?: string | null;
}

interface DiskAgentTreeFile {
  readonly schemaVersion?: number;
  readonly source?: string;
  readonly agentCount?: number;
  readonly roots?: readonly string[];
  readonly nodes?: Readonly<Record<string, DiskAgentTreeNode>>;
}

interface DiskAgentIndexEntry {
  readonly i?: string;
  readonly l?: number;
  readonly t?: string;
  readonly s?: number;
}

interface DiskAgentIndexFile {
  readonly agents?: Readonly<Record<string, DiskAgentIndexEntry>>;
}

export interface ParsedFantasy402HierarchySnapshot {
  readonly source: "baseline-disk" | "ingested-f402";
  readonly sourceLabel: string;
  readonly ingestedAt: string | null;
  readonly extraFlag: boolean | null;
  readonly nodesById: ReadonlyMap<string, AgentHierarchyNodeRecord>;
  readonly orderedNodeIds: readonly string[];
  readonly childrenByParent: ReadonlyMap<string, readonly string[]>;
  readonly playersByAgent: ReadonlyMap<string, readonly SanitizedFantasy402Player[]>;
  readonly allPlayers: readonly SanitizedFantasy402Player[];
  readonly summary: AgentHierarchyDirectorySummary;
  readonly warnings: readonly string[];
}

export interface AgentHierarchyQueryOptions {
  readonly q?: string | undefined;
  readonly root?: string | undefined;
  readonly agentType?: string | undefined;
  readonly level?: number | undefined;
  readonly includePlayers?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface AgentHierarchyNodeDetail {
  readonly node: AgentHierarchyNodeRecord;
  readonly childAgents: readonly string[];
  readonly players: readonly SanitizedFantasy402Player[];
}

const DEVTOOLS_TRUNCATION_RE = /\[\s*\d+\s*[….]\s*\d+\s*\]|\{,\s*…\}|\[\s*…\s*\]/;
const SENSITIVE_KEY_RE = /^(?:password|passwd|pwd|pass|pin|secret|token)$/i;

function normalizeId(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  return String(raw).trim().toUpperCase();
}

function normalizeText(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  return String(raw).trim();
}

function toFiniteNumber(raw: unknown, fallback = 0): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function canonicalCollisionKey(agentId: string): string {
  return agentId.replace(/[^A-Z0-9]/g, "");
}

function parseRateCard(row: Record<string, unknown>): Fantasy402RateCard | null {
  let sawAnyRateField = false;
  const values: Record<string, number> = {};
  let activeRateCount = 0;
  let totalMonthlyRateUsd = 0;

  for (const field of FANTASY402_RATE_FIELDS) {
    const hasField =
      Object.prototype.hasOwnProperty.call(row, field.rawKey) ||
      Object.prototype.hasOwnProperty.call(row, field.key);
    if (hasField) sawAnyRateField = true;
    const rawVal = row[field.rawKey] ?? row[field.key];
    const num = Math.max(0, toFiniteNumber(rawVal, 0));
    values[field.key] = num;
    if (num > 0) {
      activeRateCount += 1;
      totalMonthlyRateUsd += num;
    }
  }

  if (!sawAnyRateField) return null;

  return {
    headCountRateM: values.headCountRateM ?? 0,
    inetHeadCountRateM: values.inetHeadCountRateM ?? 0,
    liveBettingRateM: values.liveBettingRateM ?? 0,
    liveBetting2RateM: values.liveBetting2RateM ?? 0,
    liveCasinoRateM: values.liveCasinoRateM ?? 0,
    casinoHeadCountRateM: values.casinoHeadCountRateM ?? 0,
    propBuilderRateM: values.propBuilderRateM ?? 0,
    betBuilderRate: values.betBuilderRate ?? 0,
    amigoTechRate: values.amigoTechRate ?? 0,
    crashRate: values.crashRate ?? 0,
    extPropsRate: values.extPropsRate ?? 0,
    fantasyRate: values.fantasyRate ?? 0,
    flashBetsRate: values.flashBetsRate ?? 0,
    gitCasinoRate: values.gitCasinoRate ?? 0,
    activeRateCount,
    totalMonthlyRateUsd: Number(totalMonthlyRateUsd.toFixed(2)),
  };
}

function countSensitiveKeysInRow(row: Record<string, unknown>): number {
  let count = 0;
  for (const [k, v] of Object.entries(row)) {
    if (SENSITIVE_KEY_RE.test(k.trim()) && v !== undefined && v !== null) {
      count += 1;
    }
  }
  return count;
}

interface RawNodeIntermediate {
  readonly agentId: string;
  readonly login: string;
  readonly seqNumber: number | null;
  readonly level: number;
  readonly agentType: string;
  readonly parentAgentId: string | null;
  readonly rateCard: Fantasy402RateCard | null;
}

function finalizeHierarchySnapshot(input: {
  readonly source: "baseline-disk" | "ingested-f402";
  readonly sourceLabel: string;
  readonly ingestedAt: string | null;
  readonly extraFlag: boolean | null;
  readonly intermediates: readonly RawNodeIntermediate[];
  readonly rawPlayers: readonly {
    readonly customerId: string;
    readonly login: string;
    readonly nameFirst: string;
    readonly agentId: string;
  }[];
  readonly passwordsStripped: number;
  readonly warnings: readonly string[];
}): ParsedFantasy402HierarchySnapshot {
  const rawById = new Map<string, RawNodeIntermediate>();
  const orderedNodeIds: string[] = [];

  for (const item of input.intermediates) {
    if (!item.agentId) continue;
    if (!rawById.has(item.agentId)) {
      orderedNodeIds.push(item.agentId);
    }
    rawById.set(item.agentId, item);
  }

  // Build parent -> children map
  const childrenMutable = new Map<string, string[]>();
  const roots: string[] = [];

  for (const id of orderedNodeIds) {
    const item = rawById.get(id)!;
    const parentId =
      item.parentAgentId &&
      item.parentAgentId !== id &&
      rawById.has(item.parentAgentId)
        ? item.parentAgentId
        : null;
    if (parentId) {
      const list = childrenMutable.get(parentId) ?? [];
      list.push(id);
      childrenMutable.set(parentId, list);
    } else {
      roots.push(id);
    }
  }

  // Ancestors + root trunk lookup with cycle guard
  const ancestorsMap = new Map<string, readonly string[]>();
  const rootMasterMap = new Map<string, string>();
  const resolveLineage = (id: string): readonly string[] => {
    const cached = ancestorsMap.get(id);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>([id]);
    let cur = rawById.get(id)?.parentAgentId ?? null;
    while (cur && rawById.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      chain.unshift(cur);
      cur = rawById.get(cur)?.parentAgentId ?? null;
    }
    ancestorsMap.set(id, chain);
    rootMasterMap.set(id, chain[0] ?? id);
    return chain;
  };
  for (const id of orderedNodeIds) {
    resolveLineage(id);
  }

  // Compute recursive descendant counts bottom-up via memoized DFS
  const descendantCountMap = new Map<string, number>();
  const countDescendants = (id: string, visiting: Set<string>): number => {
    const cached = descendantCountMap.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const children = childrenMutable.get(id) ?? [];
    let total = children.length;
    for (const childId of children) {
      total += countDescendants(childId, visiting);
    }
    visiting.delete(id);
    descendantCountMap.set(id, total);
    return total;
  };
  for (const id of orderedNodeIds) {
    countDescendants(id, new Set());
  }

  // Punctuation collision groups (e.g., LP1. vs LP1, RM01. vs RM01)
  const collisionBuckets = new Map<string, string[]>();
  for (const id of orderedNodeIds) {
    const canonical = canonicalCollisionKey(id);
    if (!canonical) continue;
    const bucket = collisionBuckets.get(canonical) ?? [];
    bucket.push(id);
    collisionBuckets.set(canonical, bucket);
  }
  const collisions: AgentHierarchyCollisionGroup[] = [];
  const collidingAgentIds = new Set<string>();
  for (const [canonicalKey, agentIds] of collisionBuckets.entries()) {
    if (agentIds.length > 1) {
      collisions.push({ canonicalKey, agentIds: [...agentIds].sort() });
      for (const id of agentIds) collidingAgentIds.add(id);
    }
  }
  collisions.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey));

  // Map sanitized players to agents (strictly zero passwords!)
  const playersByAgentMutable = new Map<string, SanitizedFantasy402Player[]>();
  const allPlayers: SanitizedFantasy402Player[] = [];
  const orphanAgentIdSet = new Set<string>();
  let mappedPlayers = 0;
  let orphanPlayers = 0;

  for (const rawPlayer of input.rawPlayers) {
    if (!rawPlayer.customerId && !rawPlayer.login) continue;
    const agentId = rawPlayer.agentId || "UNASSIGNED";
    const knownAgent = rawById.has(agentId);
    const rootMasterAgent = knownAgent ? (rootMasterMap.get(agentId) ?? agentId) : null;
    if (knownAgent) {
      mappedPlayers += 1;
    } else {
      orphanPlayers += 1;
      if (agentId && agentId !== "UNASSIGNED") {
        orphanAgentIdSet.add(agentId);
      }
    }
    const sanitized: SanitizedFantasy402Player = {
      customerId: rawPlayer.customerId || rawPlayer.login,
      login: rawPlayer.login || rawPlayer.customerId,
      nameFirst: rawPlayer.nameFirst,
      agentId,
      rootMasterAgent,
    };
    allPlayers.push(sanitized);
    const list = playersByAgentMutable.get(agentId) ?? [];
    list.push(sanitized);
    playersByAgentMutable.set(agentId, list);
  }

  // Finalize nodes + summary metrics
  const nodesById = new Map<string, AgentHierarchyNodeRecord>();
  const levelCountsMutable: Record<string, number> = {};
  let masterCount = 0;
  let subAgentCount = 0;
  let maxDepth = 0;
  let activeRateAgentsCount = 0;

  for (const id of orderedNodeIds) {
    const item = rawById.get(id)!;
    const children = childrenMutable.get(id) ?? [];
    const ancestors = ancestorsMap.get(id) ?? [];
    const rootMasterAgent = rootMasterMap.get(id) ?? id;
    const parentAgentId =
      item.parentAgentId &&
      item.parentAgentId !== id &&
      rawById.has(item.parentAgentId)
        ? item.parentAgentId
        : null;
    const playerCount = playersByAgentMutable.get(id)?.length ?? 0;

    if (item.agentType === "M") masterCount += 1;
    else subAgentCount += 1;
    if (item.level > maxDepth) maxDepth = item.level;
    const levelKey = String(item.level);
    levelCountsMutable[levelKey] = (levelCountsMutable[levelKey] ?? 0) + 1;
    if (item.rateCard && item.rateCard.activeRateCount > 0) {
      activeRateAgentsCount += 1;
    }

    nodesById.set(id, {
      agentId: id,
      login: item.login || id,
      seqNumber: item.seqNumber,
      level: item.level,
      agentType: item.agentType || "A",
      parentAgentId,
      rootMasterAgent,
      ancestors,
      directChildCount: children.length,
      descendantCount: descendantCountMap.get(id) ?? 0,
      playerCount,
      rateCard: item.rateCard,
      hasPunctuationCollision: collidingAgentIds.has(id),
    });
  }

  const childrenByParent = new Map<string, readonly string[]>();
  for (const [parentId, kids] of childrenMutable.entries()) {
    childrenByParent.set(parentId, kids);
  }

  const playersByAgent = new Map<string, readonly SanitizedFantasy402Player[]>();
  for (const [agentId, list] of playersByAgentMutable.entries()) {
    playersByAgent.set(agentId, list);
  }

  return {
    source: input.source,
    sourceLabel: input.sourceLabel,
    ingestedAt: input.ingestedAt,
    extraFlag: input.extraFlag,
    nodesById,
    orderedNodeIds,
    childrenByParent,
    playersByAgent,
    allPlayers,
    warnings: input.warnings,
    summary: {
      source: input.source,
      sourceLabel: input.sourceLabel,
      ingestedAt: input.ingestedAt,
      extraFlag: input.extraFlag,
      totalAgents: orderedNodeIds.length,
      masterCount,
      subAgentCount,
      maxDepth,
      rootCount: roots.length,
      roots,
      totalPlayers: allPlayers.length,
      mappedPlayers,
      orphanPlayers,
      orphanAgentIds: [...orphanAgentIdSet].sort().slice(0, 50),
      passwordsStripped: input.passwordsStripped,
      collisionCount: collisions.length,
      collisions: collisions.slice(0, 40),
      levelCounts: levelCountsMutable,
      activeRateAgentsCount,
    },
  };
}

/**
 * Parse a Fantasy402 `getListAgenstByAgent` payload (`{ EXTRA, GENERAL, PLAYERS }`)
 * or raw JSON string into a reconstructed pre-order hierarchy snapshot.
 *
 * Security invariant: `PLAYERS[].Password` (and any sensitive variants) are
 * immediately discarded and NEVER retained anywhere in the returned snapshot.
 */
export function parseFantasy402HierarchyPayload(
  rawInput: unknown,
  options: { readonly sourceLabel?: string; readonly nowIso?: string } = {},
): ParsedFantasy402HierarchySnapshot {
  let payload: unknown = rawInput;

  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      throw new Error(
        'Provide a non-empty Fantasy402 JSON payload ({ "EXTRA": false, "GENERAL": [...], "PLAYERS": [...] }).',
      );
    }
    if (DEVTOOLS_TRUNCATION_RE.test(trimmed)) {
      throw new Error(
        "Detected a truncated Chrome DevTools preview (e.g. [100 … 199] or {,…}). Right-click the object in DevTools and choose 'Copy object' (or copy(response)) to paste valid JSON.",
      );
    }
    try {
      payload = JSON.parse(trimmed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid JSON syntax";
      throw new Error(
        `Invalid JSON payload (${msg}). Paste raw JSON from Fantasy402 getListAgenstByAgent ({ "EXTRA": false, "GENERAL": [...], "PLAYERS": [...] }).`,
      );
    }
  }

  if (!payload || typeof payload !== "object") {
    throw new Error(
      'Payload must be a JSON object containing "GENERAL" and/or "PLAYERS" arrays, or an array of Fantasy402 agent entries.',
    );
  }

  let extraFlag: boolean | null = null;
  let generalRows: unknown[] = [];
  let playerRows: unknown[] = [];
  const warnings: string[] = [];

  if (Array.isArray(payload)) {
    // Allow direct array of GENERAL agent objects or PLAYERS objects
    const firstObj = payload.find(
      (item) => item && typeof item === "object" && !Array.isArray(item),
    ) as Record<string, unknown> | undefined;
    if (
      firstObj &&
      ("customerID" in firstObj || "CustomerID" in firstObj) &&
      !("AgentID" in firstObj)
    ) {
      playerRows = payload;
    } else {
      generalRows = payload;
    }
  } else {
    const rec = payload as Record<string, unknown>;
    if (typeof rec.EXTRA === "boolean") extraFlag = rec.EXTRA;
    else if (typeof rec.extra === "boolean") extraFlag = rec.extra;

    const rawGen = rec.GENERAL ?? rec.general ?? rec.AGENTS ?? rec.agents;
    const rawPlayers = rec.PLAYERS ?? rec.players;

    if (Array.isArray(rawGen)) generalRows = rawGen;
    if (Array.isArray(rawPlayers)) playerRows = rawPlayers;

    // Support { rawText: "..." } or { payload: { ... } } wrapper if passed directly
    if (
      generalRows.length === 0 &&
      playerRows.length === 0 &&
      typeof rec.rawText === "string"
    ) {
      return parseFantasy402HierarchyPayload(rec.rawText, options);
    }
    if (
      generalRows.length === 0 &&
      playerRows.length === 0 &&
      rec.payload &&
      typeof rec.payload === "object"
    ) {
      return parseFantasy402HierarchyPayload(rec.payload, options);
    }
  }

  if (generalRows.length === 0 && playerRows.length === 0) {
    throw new Error(
      'No agent or player rows found. Expected Fantasy402 keys "GENERAL" (array of agents) and/or "PLAYERS" (array of players).',
    );
  }

  if (generalRows.length > MAX_INGEST_AGENTS) {
    warnings.push(
      `GENERAL exceeded cap (${MAX_INGEST_AGENTS}); truncated from ${generalRows.length} rows.`,
    );
    generalRows = generalRows.slice(0, MAX_INGEST_AGENTS);
  }
  if (playerRows.length > MAX_INGEST_PLAYERS) {
    warnings.push(
      `PLAYERS exceeded cap (${MAX_INGEST_PLAYERS}); truncated from ${playerRows.length} rows.`,
    );
    playerRows = playerRows.slice(0, MAX_INGEST_PLAYERS);
  }

  // Normalize GENERAL rows and sort by ascending SeqNumber if SeqNumbers are present
  interface NormalizedGeneralRow {
    readonly agentId: string;
    readonly login: string;
    readonly seqNumber: number | null;
    readonly level: number;
    readonly agentType: string;
    readonly explicitParent: string | null;
    readonly rateCard: Fantasy402RateCard | null;
    readonly originalOrder: number;
  }

  let passwordsStripped = 0;
  const normalizedGeneral: NormalizedGeneralRow[] = [];
  let hasSeqNumbers = false;

  for (let idx = 0; idx < generalRows.length; idx += 1) {
    const raw = generalRows[idx];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    passwordsStripped += countSensitiveKeysInRow(row);

    const agentId = normalizeId(
      row.AgentID ?? row.agentID ?? row.agentId ?? row.id,
    );
    if (!agentId) continue;

    const login =
      normalizeText(row.Login ?? row.login) || agentId;
    const rawSeq = row.SeqNumber ?? row.seqNumber ?? row.s;
    const seqNumber =
      rawSeq !== undefined && rawSeq !== null && rawSeq !== ""
        ? toFiniteNumber(rawSeq, Number.NaN)
        : Number.NaN;
    const validSeq = Number.isFinite(seqNumber) ? seqNumber : null;
    if (validSeq !== null) hasSeqNumbers = true;

    const rawLevel = row.Level ?? row.level ?? row.l;
    const level = Math.max(1, Math.round(toFiniteNumber(rawLevel, 1)));
    const agentTypeRaw = normalizeId(
      row.AgentType ?? row.agentType ?? row.t ?? "A",
    );
    const agentType =
      agentTypeRaw === "M" || agentTypeRaw === "MASTER"
        ? "M"
        : agentTypeRaw === "A" || agentTypeRaw === "AGENT"
          ? "A"
          : agentTypeRaw || "A";
    const explicitParentRaw = normalizeId(
      row.ParentAgentID ?? row.parentAgentId ?? row.p,
    );

    normalizedGeneral.push({
      agentId,
      login,
      seqNumber: validSeq,
      level,
      agentType,
      explicitParent: explicitParentRaw || null,
      rateCard: parseRateCard(row),
      originalOrder: idx,
    });
  }

  if (hasSeqNumbers) {
    normalizedGeneral.sort((a, b) => {
      if (a.seqNumber !== null && b.seqNumber !== null && a.seqNumber !== b.seqNumber) {
        return a.seqNumber - b.seqNumber;
      }
      return a.originalOrder - b.originalOrder;
    });
  }

  // Reconstruct parent-child tree via pre-order `(SeqNumber, Level)` stack traversal
  const stack: Array<{ readonly agentId: string; readonly level: number }> = [];
  const intermediates: RawNodeIntermediate[] = [];

  for (const row of normalizedGeneral) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= row.level) {
      stack.pop();
    }
    const inferredParent =
      stack.length > 0 ? stack[stack.length - 1]!.agentId : null;
    const parentAgentId = row.explicitParent ?? inferredParent;

    intermediates.push({
      agentId: row.agentId,
      login: row.login,
      seqNumber: row.seqNumber,
      level: row.level,
      agentType: row.agentType,
      parentAgentId,
      rateCard: row.rateCard,
    });

    stack.push({ agentId: row.agentId, level: row.level });
  }

  // Parse PLAYERS while IMMEDIATELY stripping all Password/secret keys
  const rawPlayers: Array<{
    readonly customerId: string;
    readonly login: string;
    readonly nameFirst: string;
    readonly agentId: string;
  }> = [];

  for (const raw of playerRows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    passwordsStripped += countSensitiveKeysInRow(row);

    const customerId = normalizeText(
      row.customerID ?? row.CustomerID ?? row.customerId ?? row.id,
    );
    const login = normalizeText(row.Login ?? row.login);
    const nameFirst = normalizeText(
      row.NameFirst ?? row.nameFirst ?? row.firstName,
    );
    const agentId = normalizeId(
      row.Agent ?? row.agent ?? row.AgentID ?? row.agentId,
    );

    if (!customerId && !login) continue;
    rawPlayers.push({
      customerId: customerId || login,
      login: login || customerId,
      nameFirst,
      agentId,
    });
  }

  const nowIso = options.nowIso ?? new Date().toISOString();
  return finalizeHierarchySnapshot({
    source: "ingested-f402",
    sourceLabel:
      options.sourceLabel ??
      `Fantasy402 Live Ingest (${intermediates.length.toLocaleString()} agents · ${rawPlayers.length.toLocaleString()} players)`,
    ingestedAt: nowIso,
    extraFlag,
    intermediates,
    rawPlayers,
    passwordsStripped,
    warnings,
  });
}

/**
 * Load baseline agent hierarchy from disk (`data/agent-tree.json` +
 * `data/agent-index.json`) so the directory is immediately populated on boot.
 */
export function loadBaselineAgentHierarchyFromDisk(
  cwd: string = process.cwd(),
): ParsedFantasy402HierarchySnapshot {
  const treePath = resolve(cwd, "data/agent-tree.json");
  const indexPath = resolve(cwd, "data/agent-index.json");

  let treeFile: DiskAgentTreeFile | null = null;
  let indexFile: DiskAgentIndexFile | null = null;

  try {
    if (existsSync(treePath)) {
      treeFile = JSON.parse(
        readFileSync(treePath, "utf8"),
      ) as DiskAgentTreeFile;
    }
  } catch {
    treeFile = null;
  }

  try {
    if (existsSync(indexPath)) {
      indexFile = JSON.parse(
        readFileSync(indexPath, "utf8"),
      ) as DiskAgentIndexFile;
    }
  } catch {
    indexFile = null;
  }

  const indexAgents = indexFile?.agents ?? {};
  const treeNodes = treeFile?.nodes ?? {};

  // Build lookup of seqNumber + level/type from agent-index.json
  const seqById = new Map<string, DiskAgentIndexEntry>();
  for (const [rawKey, entry] of Object.entries(indexAgents)) {
    const key = normalizeId(entry?.i ?? rawKey);
    if (key) seqById.set(key, entry);
  }

  const intermediates: RawNodeIntermediate[] = [];
  const seen = new Set<string>();

  // First add all tree nodes (they have explicit parent pointers `p`)
  for (const [rawId, node] of Object.entries(treeNodes)) {
    const agentId = normalizeId(rawId);
    if (!agentId || seen.has(agentId)) continue;
    seen.add(agentId);
    const idxEntry = seqById.get(agentId);
    intermediates.push({
      agentId,
      login: agentId,
      seqNumber: typeof idxEntry?.s === "number" ? idxEntry.s : null,
      level:
        typeof node?.l === "number" && node.l > 0
          ? node.l
          : typeof idxEntry?.l === "number" && idxEntry.l > 0
            ? idxEntry.l
            : 1,
      agentType:
        normalizeId(node?.t ?? idxEntry?.t ?? "A") || "A",
      parentAgentId: normalizeId(node?.p) || null,
      rateCard: null,
    });
  }

  // Sort by seqNumber when available so pre-order tree listing matches Fantasy402 order
  intermediates.sort((a, b) => {
    if (a.seqNumber !== null && b.seqNumber !== null && a.seqNumber !== b.seqNumber) {
      return a.seqNumber - b.seqNumber;
    }
    if (a.seqNumber !== null && b.seqNumber === null) return -1;
    if (a.seqNumber === null && b.seqNumber !== null) return 1;
    return a.level - b.level || a.agentId.localeCompare(b.agentId);
  });

  return finalizeHierarchySnapshot({
    source: "baseline-disk",
    sourceLabel: treeFile?.source
      ? `Disk baseline (${treeFile.source})`
      : "Disk baseline (data/agent-tree.json)",
    ingestedAt: null,
    extraFlag: null,
    intermediates,
    rawPlayers: [],
    passwordsStripped: 0,
    warnings: [],
  });
}

export function createAgentHierarchyStore(
  options: { readonly cwd?: string | undefined } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  let snapshot: ParsedFantasy402HierarchySnapshot =
    loadBaselineAgentHierarchyFromDisk(cwd);

  function getSnapshot(): ParsedFantasy402HierarchySnapshot {
    return snapshot;
  }

  function ingest(
    rawInput: unknown,
    ingestOptions?: { readonly sourceLabel?: string; readonly nowIso?: string },
  ): AgentHierarchyIngestResponse {
    const parsed = parseFantasy402HierarchyPayload(rawInput, ingestOptions);

    // If caller ingested PLAYERS-only without GENERAL, merge those sanitized
    // players onto the existing agent tree so parent links remain intact.
    if (parsed.summary.totalAgents === 0 && parsed.allPlayers.length > 0 && snapshot.summary.totalAgents > 0) {
      const existingIntermediates: RawNodeIntermediate[] = snapshot.orderedNodeIds.map((id) => {
        const node = snapshot.nodesById.get(id)!;
        return {
          agentId: node.agentId,
          login: node.login,
          seqNumber: node.seqNumber,
          level: node.level,
          agentType: node.agentType,
          parentAgentId: node.parentAgentId,
          rateCard: node.rateCard,
        };
      });
      snapshot = finalizeHierarchySnapshot({
        source: "ingested-f402",
        sourceLabel: `Merged PLAYERS (${parsed.allPlayers.length.toLocaleString()}) onto active hierarchy`,
        ingestedAt: parsed.ingestedAt,
        extraFlag: parsed.extraFlag ?? snapshot.extraFlag,
        intermediates: existingIntermediates,
        rawPlayers: parsed.allPlayers.map((p) => ({
          customerId: p.customerId,
          login: p.login,
          nameFirst: p.nameFirst,
          agentId: p.agentId,
        })),
        passwordsStripped: parsed.summary.passwordsStripped,
        warnings: parsed.warnings,
      });
    } else {
      snapshot = parsed;
    }

    return {
      ok: true,
      schemaVersion: 1,
      ingestedAgents: snapshot.summary.totalAgents,
      ingestedPlayers: snapshot.summary.totalPlayers,
      passwordsStripped: snapshot.summary.passwordsStripped,
      warnings: snapshot.warnings,
      summary: snapshot.summary,
    };
  }

  function reset(): AgentHierarchyDirectorySummary {
    snapshot = loadBaselineAgentHierarchyFromDisk(cwd);
    return snapshot.summary;
  }

  function getAgentNode(rawAgentId: string): AgentHierarchyNodeDetail | null {
    const agentId = normalizeId(rawAgentId);
    if (!agentId) return null;
    const node = snapshot.nodesById.get(agentId);
    if (!node) return null;
    return {
      node,
      childAgents: snapshot.childrenByParent.get(agentId) ?? [],
      players: snapshot.playersByAgent.get(agentId) ?? [],
    };
  }

  function query(
    opts: AgentHierarchyQueryOptions = {},
  ): AgentHierarchyDirectoryResponse {
    const q = (opts.q ?? "").trim().toLowerCase();
    const rootFilter = (opts.root ?? "").trim().toUpperCase();
    const typeFilter = (opts.agentType ?? "").trim().toUpperCase();
    const levelFilter =
      typeof opts.level === "number" && Number.isFinite(opts.level) && opts.level > 0
        ? Math.round(opts.level)
        : null;
    const includePlayers = opts.includePlayers ?? true;
    const limit = Math.max(1, Math.min(200, Math.round(opts.limit ?? 80)));
    const offset = Math.max(0, Math.round(opts.offset ?? 0));

    // Match sanitized players when searching or explicitly requested
    const matchedPlayers: SanitizedFantasy402Player[] = [];
    const agentIdsWithMatchingPlayers = new Set<string>();

    if (includePlayers && snapshot.allPlayers.length > 0) {
      for (const player of snapshot.allPlayers) {
        if (
          rootFilter &&
          rootFilter !== "ALL" &&
          (player.rootMasterAgent ?? "").toUpperCase() !== rootFilter
        ) {
          continue;
        }
        if (q) {
          const hay =
            `${player.customerId} ${player.login} ${player.nameFirst} ${player.agentId}`.toLowerCase();
          if (!hay.includes(q)) continue;
          agentIdsWithMatchingPlayers.add(player.agentId);
        }
        matchedPlayers.push(player);
      }
    }

    const matchedNodes: AgentHierarchyNodeRecord[] = [];
    for (const id of snapshot.orderedNodeIds) {
      const node = snapshot.nodesById.get(id);
      if (!node) continue;
      if (
        rootFilter &&
        rootFilter !== "ALL" &&
        node.rootMasterAgent.toUpperCase() !== rootFilter
      ) {
        continue;
      }
      if (
        typeFilter &&
        typeFilter !== "ALL" &&
        node.agentType.toUpperCase() !== typeFilter
      ) {
        continue;
      }
      if (levelFilter !== null && node.level !== levelFilter) {
        continue;
      }
      if (q) {
        const matchesNode =
          node.agentId.toLowerCase().includes(q) ||
          node.login.toLowerCase().includes(q) ||
          (node.parentAgentId?.toLowerCase().includes(q) ?? false) ||
          node.rootMasterAgent.toLowerCase().includes(q) ||
          (node.seqNumber !== null && String(node.seqNumber).includes(q)) ||
          agentIdsWithMatchingPlayers.has(node.agentId);
        if (!matchesNode) continue;
      }
      matchedNodes.push(node);
    }

    return {
      schemaVersion: 1,
      summary: snapshot.summary,
      nodes: matchedNodes.slice(offset, offset + limit),
      totalMatchedNodes: matchedNodes.length,
      players: includePlayers ? matchedPlayers.slice(0, Math.min(limit, 100)) : [],
      totalMatchedPlayers: matchedPlayers.length,
      limit,
      offset,
      observedAt: new Date().toISOString(),
    };
  }

  /**
   * Export legacy `data/agent-tree.json`-compatible structure so `GET /api/agent-tree`
   * stays 100% backward-compatible while reflecting live ingested updates.
   */
  function toLegacyAgentTreeJson(): {
    readonly schemaVersion: 1;
    readonly source: string;
    readonly agentCount: number;
    readonly roots: readonly string[];
    readonly collisions: readonly AgentHierarchyCollisionGroup[];
    readonly nodes: Readonly<
      Record<string, { readonly l: number; readonly p: string | null; readonly t: string }>
    >;
  } {
    const nodes: Record<string, { l: number; p: string | null; t: string }> = {};
    for (const id of snapshot.orderedNodeIds) {
      const n = snapshot.nodesById.get(id)!;
      nodes[id] = { l: n.level, p: n.parentAgentId, t: n.agentType };
    }
    return {
      schemaVersion: 1,
      source: snapshot.summary.sourceLabel,
      agentCount: snapshot.summary.totalAgents,
      roots: snapshot.summary.roots,
      collisions: snapshot.summary.collisions,
      nodes,
    };
  }

  return {
    getSnapshot,
    ingest,
    reset,
    getAgentNode,
    query,
    toLegacyAgentTreeJson,
  };
}

export type AgentHierarchyStore = ReturnType<typeof createAgentHierarchyStore>;
