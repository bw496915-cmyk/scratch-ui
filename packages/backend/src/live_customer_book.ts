/** Private projected manager roster; no fixture or model-derived fallback. */
import { readFile, stat } from "node:fs/promises"

import {
  type CustomerRetainedHistory,
  type DashboardSourceProvenance,
  parseCustomerRetainedHistory,
} from "@sportsdesk-ops/contracts"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function createLiveCustomerBook(filePath: string | undefined, historyPath?: string) {
  let cached: {
    stamp: string
    rows: readonly Record<string, unknown>[]
    byId: ReadonlyMap<string, Record<string, unknown>>
    historyCoverage: {
      status: string
      matchedAccounts: number | null
      unmatchedHistoryKeys: number | null
      ambiguousHistoryKeys: number | null
      generatedAt: string | null
    }
    provenance: DashboardSourceProvenance
  } | null = null
  const load = async () => {
    if (!filePath) return null
    const info = await stat(filePath)
    const historyInfo = historyPath ? await stat(historyPath).catch(() => null) : null
    const stamp = `${info.mtimeMs}:${info.size}|${historyInfo?.mtimeMs ?? "none"}:${historyInfo?.size ?? "none"}`
    if (cached?.stamp === stamp) return cached
    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"))
    if (
      !isRecord(raw) ||
      raw.schemaVersion !== 1 ||
      !Array.isArray(raw.players) ||
      !Array.isArray(raw.agents)
    )
      throw new Error("Live customer source must be a projected manager roster")
    const byId = new Map<string, Record<string, unknown>>()
    for (const player of raw.players) {
      if (!isRecord(player) || typeof player.customerId !== "string" || !player.customerId.trim())
        throw new Error("Live roster contains an invalid customer identity")
      const id = player.customerId.trim().toUpperCase()
      if (/^(?:SYNTH_|DEMO_|FIXTURE_)/i.test(id))
        throw new Error("Synthetic identity rejected from live roster")
      if (byId.has(id)) continue
      // Explicit structural projection prevents credentials or raw provider attributes reaching HTTP.
      byId.set(id, {
        customer_id: id,
        ...(typeof player.login === "string" ? { login: player.login.trim() } : {}),
        ...(typeof player.agent === "string" ? { agent_id: player.agent.trim() } : {}),
        provenance: "projected-manager-roster",
      })
    }
    if (byId.size === 0) throw new Error("Live customer roster is empty")
    const historyCoverage = {
      status: historyPath ? "unavailable" : "unconfigured",
      matchedAccounts: null as number | null,
      unmatchedHistoryKeys: null as number | null,
      ambiguousHistoryKeys: null as number | null,
      generatedAt: null as string | null,
    }
    if (historyPath && historyInfo) {
      try {
        const projection: unknown = JSON.parse(await readFile(historyPath, "utf8"))
        if (
          !isRecord(projection) ||
          projection.schemaVersion !== 1 ||
          projection.kind !== "f402-retained-wager-metrics" ||
          projection.wholeAccountHistory !== false ||
          !Array.isArray(projection.records) ||
          typeof projection.generatedAt !== "string" ||
          !Number.isFinite(Date.parse(projection.generatedAt))
        )
          throw new Error("Invalid retained history projection")
        const aliases = new Map<string, string | null>()
        for (const [id, row] of byId) {
          for (const alias of [id, typeof row.login === "string" ? row.login.toUpperCase() : ""]) {
            if (!alias) continue
            const previous = aliases.get(alias)
            aliases.set(alias, previous === undefined || previous === id ? id : null)
          }
        }
        const assigned = new Map<string, CustomerRetainedHistory>()
        const ambiguous = new Set<string>()
        let unmatched = 0,
          ambiguousKeys = 0
        for (const value of projection.records) {
          if (!isRecord(value) || typeof value.customerKey !== "string")
            throw new Error("Invalid history identity")
          const metrics = parseCustomerRetainedHistory(value.metrics)
          if (metrics === null) throw new Error("Invalid history metrics")
          const id = aliases.get(value.customerKey.trim().toUpperCase())
          if (id === undefined) {
            unmatched++
            continue
          }
          if (id === null) {
            ambiguousKeys++
            continue
          }
          if (assigned.has(id) || ambiguous.has(id)) {
            ambiguousKeys += assigned.has(id) ? 2 : 1
            assigned.delete(id)
            ambiguous.add(id)
            continue
          }
          assigned.set(id, metrics)
        }
        for (const [id, metrics] of assigned) {
          const row = byId.get(id)
          if (row) byId.set(id, { ...row, retained_history: metrics })
        }
        historyCoverage.status = "available"
        historyCoverage.matchedAccounts = assigned.size
        historyCoverage.unmatchedHistoryKeys = unmatched
        historyCoverage.ambiguousHistoryKeys = ambiguousKeys
        historyCoverage.generatedAt = projection.generatedAt
      } catch {
        historyCoverage.status = "invalid"
      }
    }
    const observedAt =
      typeof raw.capturedAt === "string" && Number.isFinite(Date.parse(raw.capturedAt))
        ? raw.capturedAt
        : info.mtime.toISOString()
    cached = {
      stamp,
      rows: [...byId.values()],
      historyCoverage,
      byId,
      provenance: {
        kind: "capture",
        label:
          historyCoverage.status === "available"
            ? "Projected Live Book · retained history where measured"
            : "Projected Live Book · identities only",
        sourcePath: filePath,
        observedAt,
      },
    }
    return cached
  }
  return {
    load,
    find: async (id: string) => (await load())?.byId.get(id.trim().toUpperCase()) ?? null,
  }
}
