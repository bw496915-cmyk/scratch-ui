/**
 * Pure helpers for selecting currently filtered System Logs / Weblogs rows via the active bitwise
 * filter index, serializing a formatted JSON export envelope with filter metadata, and triggering
 * client-side JSON file downloads.
 *
 * @file Packages/ui/src/system_logs_json_export.ts
 */

import {
  type BitwiseLogIndex,
  evaluateBitwiseLogIndex,
  formatBitmaskHex,
  LOG_SEVERITY_BIT_WATCH,
  LOG_SEVERITY_BITS,
  LOG_SEVERITY_MASK_ALL,
  type ParsedBitwiseLogQuery,
} from "./system_log_bitwise_filter.ts"

export type SystemLogsExportMode = "weblogs" | "unified"

export interface UnifiedSystemLogRow {
  readonly id: string
  readonly timestamp: string
  readonly level: "INFO" | "WARN" | "ERROR"
  readonly customerId: string
  readonly ipCategory: string
  readonly source: "ALERTS" | "R2" | "PTY" | "DESK"
  readonly message: string
}

export interface SystemLogsWeblogFilterContext {
  readonly severityFilter?: string | undefined
  readonly ipFilter?: string | undefined
  readonly ipFamily?: string | undefined
  readonly kindFilter?: string | undefined
  readonly marketFilter?: string | undefined
  readonly searchQuery?: string | undefined
  readonly clientFilter?:
    | {
        readonly site: string
        readonly version: string
      }
    | null
    | undefined
  readonly sortField?: string | undefined
  readonly sortDir?: string | undefined
}

export interface SystemLogsJsonExportMetadata {
  readonly schemaVersion: 1
  readonly exportedAt: string
  readonly mode: SystemLogsExportMode
  readonly totalRows: number
  readonly filteredRows: number
  readonly filters: {
    readonly rawQuery: string
    readonly bitwiseMask: string
    readonly activeSeverities: readonly string[]
    readonly textTerms: readonly string[]
    readonly weblogFilters?: SystemLogsWeblogFilterContext | undefined
  }
}

export interface SystemLogsJsonExportPayload<TEntry> extends SystemLogsJsonExportMetadata {
  readonly entries: readonly TEntry[]
}

/**
 * Evaluates the active bitwise filter query against a pre-built SoA index and returns the exact
 * matching slice of log rows in current display order.
 */
export function selectBitwiseFilteredRows<T>(
  rows: readonly T[],
  index: BitwiseLogIndex,
  query: ParsedBitwiseLogQuery,
): readonly T[] {
  if (rows.length === 0 || index.length === 0) return []
  const { visible } = evaluateBitwiseLogIndex(index, query)
  const out: T[] = []
  const limit = Math.min(rows.length, visible.length)
  for (let i = 0; i < limit; i += 1) {
    if (visible[i] === 1) {
      out.push(rows[i]!)
    }
  }
  return out
}

/** Maps an effective 4-bit severity mask into human-readable active severity labels. */
export function describeBitwiseMaskSeverities(
  effectiveMask: number,
  mode: SystemLogsExportMode,
): readonly string[] {
  const clamped = effectiveMask & LOG_SEVERITY_MASK_ALL
  const descriptors =
    mode === "unified"
      ? LOG_SEVERITY_BITS.filter((d) => d.bit !== LOG_SEVERITY_BIT_WATCH)
      : LOG_SEVERITY_BITS
  const labels: string[] = []
  for (const desc of descriptors) {
    if ((clamped & desc.bit) !== 0) {
      labels.push(mode === "weblogs" ? desc.weblogLabel : desc.unifiedLabel)
    }
  }
  return labels
}

export interface BuildSystemLogsJsonPayloadOptions<TEntry> {
  readonly mode: SystemLogsExportMode
  readonly entries: readonly TEntry[]
  readonly totalRows: number
  readonly parsedQuery: ParsedBitwiseLogQuery
  readonly weblogFilters?: SystemLogsWeblogFilterContext | undefined
  readonly exportedAt?: Date | string | undefined
}

/**
 * Builds the structured JSON export envelope containing filtered log entries and active filter
 * metadata for operator audit trails.
 */
export function buildSystemLogsJsonExportPayload<TEntry>(
  options: BuildSystemLogsJsonPayloadOptions<TEntry>,
): SystemLogsJsonExportPayload<TEntry> {
  const exportedAt =
    options.exportedAt instanceof Date
      ? options.exportedAt.toISOString()
      : typeof options.exportedAt === "string" && options.exportedAt.trim() !== ""
        ? options.exportedAt
        : new Date().toISOString()

  return {
    schemaVersion: 1,
    exportedAt,
    mode: options.mode,
    totalRows: Math.max(0, options.totalRows),
    filteredRows: options.entries.length,
    filters: {
      rawQuery: options.parsedQuery.rawQuery,
      bitwiseMask: formatBitmaskHex(options.parsedQuery.effectiveMask),
      activeSeverities: describeBitwiseMaskSeverities(
        options.parsedQuery.effectiveMask,
        options.mode,
      ),
      textTerms: options.parsedQuery.textTerms,
      ...(options.weblogFilters ? { weblogFilters: options.weblogFilters } : {}),
    },
    entries: options.entries,
  }
}

/** Serializes a System Logs export payload into pretty-printed, formatted JSON. */
export function formatSystemLogsJson<TEntry>(payload: SystemLogsJsonExportPayload<TEntry>): string {
  return `${JSON.stringify(payload, null, 2)}\n`
}

function slugToken(value: string | undefined, maxLen = 24): string | null {
  if (!value) return null
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (!normalized || normalized === "all") return null
  return normalized.slice(0, maxLen).replace(/-+$/g, "") || null
}

export interface BuildSystemLogsJsonFilenameOptions {
  readonly mode: SystemLogsExportMode
  readonly effectiveMask?: number | undefined
  readonly severityFilter?: string | undefined
  readonly ipFilter?: string | undefined
  readonly kindFilter?: string | undefined
  readonly marketFilter?: string | undefined
  readonly query?: string | undefined
  readonly date?: Date | undefined
}

/**
 * Builds a deterministic, filesystem-safe `.json` download filename reflecting the active log mode
 * and narrowed filters.
 */
export function buildSystemLogsJsonFilename(options: BuildSystemLogsJsonFilenameOptions): string {
  const isoDate = (options.date ?? new Date()).toISOString().slice(0, 10)
  const parts = ["sportsdesk", "system-logs", options.mode]

  const sevSlug = slugToken(options.severityFilter)
  if (sevSlug) parts.push(sevSlug)

  if (typeof options.effectiveMask === "number") {
    const clamped = options.effectiveMask & LOG_SEVERITY_MASK_ALL
    const fullMask =
      options.mode === "unified"
        ? LOG_SEVERITY_MASK_ALL & ~LOG_SEVERITY_BIT_WATCH
        : LOG_SEVERITY_MASK_ALL
    if ((clamped & fullMask) !== fullMask) {
      parts.push(`mask-${formatBitmaskHex(clamped).toLowerCase()}`)
    }
  }

  const kindSlug = slugToken(options.kindFilter)
  if (kindSlug) parts.push(kindSlug)

  const marketSlug = slugToken(options.marketFilter)
  if (marketSlug) parts.push(marketSlug)

  const ipSlug = slugToken(options.ipFilter, 18)
  if (ipSlug) parts.push(ipSlug)

  const querySlug = slugToken(options.query, 20)
  if (querySlug) parts.push(querySlug)

  parts.push(isoDate)
  return `${parts.join("-")}.json`
}

export interface JsonDownloadLinkLike {
  href: string
  download: string
  style?: { display?: string }
  click: () => void
  remove?: () => void
}

export interface JsonDownloadEnv {
  readonly document?: {
    readonly createElement: (tag: "a") => JsonDownloadLinkLike
    readonly body?: {
      appendChild: (node: JsonDownloadLinkLike) => unknown
      removeChild?: (node: JsonDownloadLinkLike) => unknown
    } | null
  } | null
  readonly URL?: {
    readonly createObjectURL: (blob: Blob) => string
    readonly revokeObjectURL: (url: string) => void
  } | null
}

/**
 * Triggers a client-side formatted JSON download and revokes the temporary object URL in all
 * execution paths.
 */
export function downloadSystemLogsJsonBlob(
  jsonContent: string,
  filename: string,
  env?: JsonDownloadEnv,
): boolean {
  const customDoc = env ? env.document : undefined
  const urlApi = env !== undefined ? env.URL : typeof URL !== "undefined" ? URL : null
  if (!urlApi || typeof urlApi.createObjectURL !== "function") {
    return false
  }

  const blob = new Blob([jsonContent], {
    type: "application/json;charset=utf-8;",
  })
  const objectUrl = urlApi.createObjectURL(blob)

  try {
    if (customDoc !== undefined) {
      if (!customDoc) return false
      const link = customDoc.createElement("a")
      link.href = objectUrl
      link.download = filename
      if (link.style) {
        link.style.display = "none"
      }
      customDoc.body?.appendChild(link)
      link.click()
      if (typeof link.remove === "function") {
        link.remove()
      } else if (customDoc.body && typeof customDoc.body.removeChild === "function") {
        customDoc.body.removeChild(link)
      }
      return true
    }

    if (typeof document === "undefined") {
      return false
    }
    const link = document.createElement("a")
    link.href = objectUrl
    link.download = filename
    link.style.display = "none"
    document.body?.appendChild(link)
    link.click()
    link.remove()
    return true
  } finally {
    if (typeof urlApi.revokeObjectURL === "function") {
      urlApi.revokeObjectURL(objectUrl)
    }
  }
}
