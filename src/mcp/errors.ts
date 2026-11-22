import { ProtocolError } from "@modelcontextprotocol/server"

export const MCP_ERROR_CATALOG = {
  ERR_CF_API_ENVELOPE_FAIL: {
    error: "ERR_CF_API_ENVELOPE_FAIL",
    code: -32065,
    exit: 65,
  },
  ERR_CF_TOPOLOGY_DRIFT: {
    error: "ERR_CF_TOPOLOGY_DRIFT",
    code: -32070,
    exit: 70,
  },
  ERR_R2_MANIFEST_CAS_REJECTED: {
    error: "ERR_R2_MANIFEST_CAS_REJECTED",
    code: -32074,
    exit: 74,
  },
  ERR_CF_RATE_LIMIT_429: {
    error: "ERR_CF_RATE_LIMIT_429",
    code: -32075,
    exit: 75,
  },
  ERR_CF_TOKEN_BLEED_10000: {
    error: "ERR_CF_TOKEN_BLEED_10000",
    code: -32077,
    exit: 77,
  },
  BLK_R2_STALE_SINK: {
    error: "BLK_R2_STALE_SINK",
    code: -32078,
    exit: 78,
  },
} as const

export type McpErrorName = keyof typeof MCP_ERROR_CATALOG

export function createMcpProtocolError(
  name: McpErrorName,
  detail?: string,
  extraData?: Record<string, unknown>,
): ProtocolError {
  const spec = MCP_ERROR_CATALOG[name]
  const message = detail ? `${spec.error}: ${detail}` : spec.error
  return new ProtocolError(spec.code, message, {
    error: spec.error,
    code: spec.code,
    exit: spec.exit,
    ...(extraData ?? {}),
  })
}

export interface StructuredMcpLogEntry {
  readonly event: string
  readonly component: "mcp_handler" | "mcp_limiter"
  readonly callerHash: string
  readonly toolName?: string | undefined
  readonly method?: string | undefined
  readonly status: number
  readonly errorCode?: McpErrorName | number | undefined
  readonly remaining?: number | undefined
  readonly retryAfterSec?: number | undefined
  /** Elapsed duration measured strictly via monotonic performance.now(). */
  readonly durationMs: number
  /** Wall-clock Unix epoch milliseconds measured strictly via Date.now(). */
  readonly wallEpochMs: number
}

export type StructuredLogSink = (serializedLine: string) => void

const CALLER_HASH_RE = /^[a-f0-9]{8,64}$/i
const TOOL_NAME_RE = /^[a-zA-Z0-9._:/-]{1,128}$/

/**
 * Emits a zero-PII structured JSON log line.
 * Only allows pre-sanitized operational fields (hashed caller id, validated tool
 * name, status, error code, and monotonic/wall timing). Never emits raw tokens,
 * IPs, emails, cookies, or request headers.
 */
export function emitStructuredMcpLog(
  entry: StructuredMcpLogEntry,
  sink: StructuredLogSink = (line) => console.log(line),
): string {
  const safeCallerHash = CALLER_HASH_RE.test(entry.callerHash)
    ? entry.callerHash.toLowerCase()
    : "redacted"
  const safeToolName =
    entry.toolName && TOOL_NAME_RE.test(entry.toolName) ? entry.toolName : undefined
  const safeDurationMs = Number.isFinite(entry.durationMs)
    ? Math.max(0, Math.round(entry.durationMs * 1000) / 1000)
    : 0
  const safeWallEpochMs = Number.isFinite(entry.wallEpochMs)
    ? Math.trunc(entry.wallEpochMs)
    : Date.now()

  const payload: Record<string, unknown> = {
    event: entry.event,
    component: entry.component,
    callerHash: safeCallerHash,
    status: entry.status,
    durationMs: safeDurationMs,
    wallEpochMs: safeWallEpochMs,
  }
  if (safeToolName !== undefined) payload.toolName = safeToolName
  if (entry.method !== undefined) payload.method = entry.method
  if (entry.errorCode !== undefined) payload.errorCode = entry.errorCode
  if (entry.remaining !== undefined) payload.remaining = entry.remaining
  if (entry.retryAfterSec !== undefined) payload.retryAfterSec = entry.retryAfterSec

  const line = JSON.stringify(payload)
  sink(line)
  return line
}
