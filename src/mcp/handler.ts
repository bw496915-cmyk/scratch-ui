import { createMcpHandler } from "agents/mcp/server"
import { McpServer, ProtocolError } from "@modelcontextprotocol/server"
import { z } from "zod"
import { MCP_LIMITER_CONSUME_URL } from "../do/mcp_limiter.ts"
import type { SportsOpsDeskEnv, WorkerExecutionContextLike } from "../types/env.ts"
import {
  createMcpProtocolError,
  emitStructuredMcpLog,
  MCP_ERROR_CATALOG,
  type McpErrorName,
  type StructuredLogSink,
} from "./errors.ts"

export const MCP_ROUTE_PATH = "/mcp"

export const MUTATING_MCP_TOOLS = new Set<string>(["desk_ledger_manifest_cas_put"])

const DEFAULT_ALLOWED_HOSTNAMES = new Set<string>(["localhost", "127.0.0.1", "[::1]"])

const R2_BUCKET_BINDINGS = [
  "DESK_ARCHIVE",
  "OPS_REPORTS",
  "BETS_BUCKET",
  "LEDGER_RECEIPTS",
] as const

type R2BucketBindingName = (typeof R2_BUCKET_BINDINGS)[number]

const REQUIRED_SECRETS = [
  "DATABASE_URL",
  "DESK_ADMIN_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHATS",
  "WORKSPACE_VAULT_KEY",
] as const

const SAFE_OBJECT_KEY_RE = /^[a-zA-Z0-9._/-]{1,512}$/

const textEncoder = new TextEncoder()

/**
 * Constant-time UTF-8 comparison to prevent timing side-channels when verifying
 * `DESK_ADMIN_TOKEN`. Compares full byte length without early return.
 */
export function constantTimeEqualUtf8(a: string, b: string): boolean {
  const bytesA = textEncoder.encode(a)
  const bytesB = textEncoder.encode(b)
  const maxLen = Math.max(bytesA.length, bytesB.length)
  let diff = bytesA.length ^ bytesB.length
  for (let i = 0; i < maxLen; i += 1) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0)
  }
  return diff === 0 && bytesA.length > 0
}

/**
 * Parses an HTTP Host header (with optional port or IPv6 brackets) into a
 * normalized lowercase hostname. Returns null on malformed input.
 */
export function parseHostHeaderHostname(hostHeader: string | null): string | null {
  if (!hostHeader) return null
  const trimmed = hostHeader.trim().toLowerCase()
  if (!trimmed || /\s/.test(trimmed)) return null

  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]")
    if (closeIdx <= 1) return null
    const hostPart = trimmed.slice(0, closeIdx + 1)
    const rest = trimmed.slice(closeIdx + 1)
    if (rest.length > 0 && !/^:\d{1,5}$/.test(rest)) return null
    return hostPart
  }

  const colonIdx = trimmed.indexOf(":")
  if (colonIdx !== -1) {
    const portPart = trimmed.slice(colonIdx + 1)
    if (!/^\d{1,5}$/.test(portPart)) return null
    const hostPart = trimmed.slice(0, colonIdx)
    return hostPart || null
  }
  return trimmed
}

function parseAllowlistHostnames(csv: string | undefined): Set<string> {
  const out = new Set<string>(DEFAULT_ALLOWED_HOSTNAMES)
  if (!csv) return out
  for (const part of csv.split(",")) {
    const normalized = parseHostHeaderHostname(part)
    if (normalized) {
      out.add(normalized)
    }
  }
  return out
}

function isHostnameAllowed(hostname: string, allowlist: ReadonlySet<string>): boolean {
  if (allowlist.has(hostname)) return true
  for (const entry of allowlist) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1)
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
        return true
      }
    }
  }
  return false
}

export function validateMcpHostAndOrigin(
  request: Request,
  env: Partial<Pick<SportsOpsDeskEnv, "MCP_ALLOWED_HOSTS" | "MCP_ALLOWED_ORIGINS">>,
  overrides?: {
    readonly allowedHosts?: readonly string[] | undefined
    readonly allowedOrigins?: readonly string[] | undefined
  },
):
  | { readonly ok: true; readonly allowedOriginHeader: string | null }
  | { readonly ok: false; readonly reason: string } {
  const allowedHosts = parseAllowlistHostnames(env.MCP_ALLOWED_HOSTS)
  if (overrides?.allowedHosts) {
    for (const host of overrides.allowedHosts) {
      const parsed = parseHostHeaderHostname(host)
      if (parsed) allowedHosts.add(parsed)
    }
  }

  const hostHeader = request.headers.get("Host") ?? new URL(request.url).host
  const hostname = parseHostHeaderHostname(hostHeader)
  if (!hostname || !isHostnameAllowed(hostname, allowedHosts)) {
    return { ok: false, reason: "disallowed_host" }
  }

  const originHeader = request.headers.get("Origin")
  if (!originHeader) {
    return { ok: true, allowedOriginHeader: null }
  }

  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(originHeader)
  } catch {
    return { ok: false, reason: "malformed_origin" }
  }
  if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
    return { ok: false, reason: "disallowed_origin_scheme" }
  }

  const allowedOrigins = parseAllowlistHostnames(env.MCP_ALLOWED_ORIGINS)
  if (overrides?.allowedOrigins) {
    for (const origin of overrides.allowedOrigins) {
      const parsed = parseHostHeaderHostname(origin)
      if (parsed) allowedOrigins.add(parsed)
    }
  }

  const originHost = parsedOrigin.hostname.toLowerCase()
  const bracketedHost =
    originHost.includes(":") && !originHost.startsWith("[") ? `[${originHost}]` : originHost
  if (!isHostnameAllowed(bracketedHost, allowedOrigins)) {
    return { ok: false, reason: "disallowed_origin" }
  }

  return { ok: true, allowedOriginHeader: parsedOrigin.origin }
}

/**
 * Extracts raw Bearer token from `Authorization` header (never logged).
 */
function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization")
  if (!auth) return null
  const match = /^Bearer\s+(\S+)$/i.exec(auth.trim())
  return match ? match[1] : null
}

/**
 * Computes a deterministic, zero-PII SHA-256 caller identifier (`callerHash`)
 * used exclusively as the `MCP_LIMITER` Durable Object key and log field.
 * Raw tokens, client IPs, and emails are never stored or logged.
 */
export async function deriveCallerHash(request: Request): Promise<string> {
  const bearer = extractBearerToken(request)
  const ip =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "anonymous"
  const rawMaterial = bearer
    ? `sports-ops-desk:mcp-bearer:v1:${bearer}`
    : `sports-ops-desk:mcp-ip:v1:${ip}`

  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(rawMaterial))
  const bytes = new Uint8Array(digest)
  let hex = ""
  for (let i = 0; i < 16; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return hex
}

export interface McpRequestAuthContext {
  readonly callerHash: string
  readonly isAdminAuthorized: boolean
  readonly rateLimitedTools: Set<string>
  terminalProtocolError: ProtocolError | null
  lastRetryAfterSec: number | null
  readonly logSink: StructuredLogSink
  readonly wallClock: () => number
  readonly monoClock: () => number
}

interface LimiterConsumeOutcomeAllowed {
  readonly allowed: true
  readonly remaining: number
  readonly resetEpochMs: number
}

interface LimiterConsumeOutcomeDenied {
  readonly allowed: false
  readonly retryAfterSec: number
}

/**
 * Gates an MCP tool or resource call through `env.MCP_LIMITER` BEFORE touching
 * R2, Analytics Engine, or any other Durable Object.
 */
export async function consumeMcpLimiterBudget(
  env: Pick<SportsOpsDeskEnv, "MCP_LIMITER">,
  callerHash: string,
  toolName: string,
): Promise<LimiterConsumeOutcomeAllowed | LimiterConsumeOutcomeDenied> {
  if (!env.MCP_LIMITER) {
    throw createMcpProtocolError(
      "ERR_CF_API_ENVELOPE_FAIL",
      "MCP_LIMITER Durable Object binding is unavailable",
    )
  }

  const id = env.MCP_LIMITER.idFromName(callerHash)
  const stub = env.MCP_LIMITER.get(id)
  const response = await stub.fetch(MCP_LIMITER_CONSUME_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MCP-Caller-Hash": callerHash,
    },
    body: JSON.stringify({ toolName }),
  })

  if (response.status === 429) {
    let retryAfterSec = Number(response.headers.get("Retry-After") ?? "1")
    try {
      const payload = (await response.json()) as { retryAfterSec?: unknown }
      if (typeof payload.retryAfterSec === "number" && Number.isFinite(payload.retryAfterSec)) {
        retryAfterSec = payload.retryAfterSec
      }
    } catch {
      // Fall back to Retry-After header when body cannot be decoded.
    }
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil(Number.isFinite(retryAfterSec) ? retryAfterSec : 1)),
    }
  }

  if (!response.ok) {
    throw createMcpProtocolError(
      "ERR_CF_API_ENVELOPE_FAIL",
      `MCP_LIMITER returned unexpected HTTP ${response.status}`,
    )
  }

  const data = (await response.json()) as {
    allowed?: unknown
    remaining?: unknown
    resetEpochMs?: unknown
  }
  if (
    data.allowed !== true ||
    typeof data.remaining !== "number" ||
    typeof data.resetEpochMs !== "number"
  ) {
    throw createMcpProtocolError(
      "ERR_CF_API_ENVELOPE_FAIL",
      "MCP_LIMITER returned malformed allow envelope",
    )
  }

  return {
    allowed: true,
    remaining: data.remaining,
    resetEpochMs: data.resetEpochMs,
  }
}

function makeJsonRpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data: Record<string, unknown>,
  httpStatus: number,
  extraHeaders?: Record<string, string>,
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        data,
      },
    },
    {
      status: httpStatus,
      headers: {
        "Cache-Control": "no-store",
        ...(extraHeaders ?? {}),
      },
    },
  )
}

/**
 * Fresh per-request SDK v2 `McpServer` factory using `registerTool()` and
 * `registerResource()`. Every tool and resource gates through `env.MCP_LIMITER`
 * before touching R2, Analytics Engine, or other Durable Objects.
 */
export function createServer(env: SportsOpsDeskEnv, authCtx: McpRequestAuthContext): McpServer {
  const server = new McpServer(
    {
      name: "sports-ops-desk",
      version: "2.0.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  )

  const gateWithLimiter = async (targetName: string): Promise<void> => {
    if (authCtx.rateLimitedTools.has(targetName)) {
      return
    }
    const outcome = await consumeMcpLimiterBudget(env, authCtx.callerHash, targetName)
    if (!outcome.allowed) {
      authCtx.lastRetryAfterSec = outcome.retryAfterSec
      const err = createMcpProtocolError("ERR_CF_RATE_LIMIT_429", "Caller tool budget exhausted", {
        retryAfterSec: outcome.retryAfterSec,
      })
      authCtx.terminalProtocolError = err
      throw err
    }
    authCtx.rateLimitedTools.add(targetName)
  }

  const makeTypedError = (
    name: McpErrorName,
    detail: string,
    extraData?: Record<string, unknown>,
  ): ProtocolError => {
    const err = createMcpProtocolError(name, detail, extraData)
    authCtx.terminalProtocolError = err
    return err
  }

  // 1. Read-only tool: Verify native R2 bindings topology
  server.registerTool(
    "desk_r2_status",
    {
      title: "Desk R2 Bindings Status",
      description:
        "Inspects native R2 bucket bindings (DESK_ARCHIVE, OPS_REPORTS, BETS_BUCKET, LEDGER_RECEIPTS) and fails closed on topology drift.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async () => {
      await gateWithLimiter("desk_r2_status")
      const missing: string[] = []
      const bound: Record<R2BucketBindingName, boolean> = {
        DESK_ARCHIVE: Boolean(env.DESK_ARCHIVE),
        OPS_REPORTS: Boolean(env.OPS_REPORTS),
        BETS_BUCKET: Boolean(env.BETS_BUCKET),
        LEDGER_RECEIPTS: Boolean(env.LEDGER_RECEIPTS),
      }
      for (const binding of R2_BUCKET_BINDINGS) {
        if (!bound[binding]) missing.push(binding)
      }
      if (missing.length > 0) {
        throw makeTypedError(
          "ERR_CF_TOPOLOGY_DRIFT",
          `Missing native R2 bindings: ${missing.join(", ")}`,
          { missingBindings: missing },
        )
      }

      const payload = {
        ok: true,
        buckets: bound,
        wallEpochMs: authCtx.wallClock(),
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
      }
    },
  )

  // 2. Read-only tool: HEAD object in native R2 bucket with staleness gate
  server.registerTool(
    "desk_r2_head_object",
    {
      title: "Desk R2 Head Object",
      description:
        "Checks object metadata in one of the native R2 buckets and enforces optional freshness budget (BLK_R2_STALE_SINK).",
      inputSchema: z.object({
        bucket: z.enum(R2_BUCKET_BINDINGS),
        key: z.string().min(1).max(512),
        maxAgeSec: z.number().int().positive().max(86_400).optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({ bucket, key, maxAgeSec }) => {
      await gateWithLimiter("desk_r2_head_object")
      if (!SAFE_OBJECT_KEY_RE.test(key) || key.includes("..")) {
        throw makeTypedError("ERR_CF_API_ENVELOPE_FAIL", "Invalid R2 object key")
      }
      const r2 = env[bucket]
      if (!r2) {
        throw makeTypedError("ERR_CF_TOPOLOGY_DRIFT", `Native R2 binding ${bucket} is not bound`)
      }

      const head = await r2.head(key)
      if (!head) {
        return {
          content: [{ type: "text", text: JSON.stringify({ exists: false, bucket, key }) }],
        }
      }

      const nowWallMs = authCtx.wallClock()
      const uploadedMs = head.uploaded instanceof Date ? head.uploaded.getTime() : nowWallMs
      const ageSec = Math.max(0, Math.floor((nowWallMs - uploadedMs) / 1000))
      if (maxAgeSec !== undefined && ageSec > maxAgeSec) {
        throw makeTypedError(
          "BLK_R2_STALE_SINK",
          `R2 object ${bucket}/${key} age ${ageSec}s exceeds maxAgeSec ${maxAgeSec}s`,
          { bucket, key, ageSec, maxAgeSec },
        )
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              exists: true,
              bucket,
              key: head.key,
              size: head.size,
              etag: head.etag,
              ageSec,
              wallEpochMs: nowWallMs,
            }),
          },
        ],
      }
    },
  )

  // 3. Read-only tool: Topology & secret-hygiene drift check
  server.registerTool(
    "desk_topology_check",
    {
      title: "Desk Topology & Secret Hygiene Check",
      description:
        "Verifies required secrets presence (boolean only, zero secret disclosure) and checks for token-bleed hazards.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async () => {
      await gateWithLimiter("desk_topology_check")

      const envRecord = env as unknown as Record<string, unknown>
      if (
        typeof envRecord.AWS_ACCESS_KEY_ID === "string" &&
        envRecord.AWS_ACCESS_KEY_ID.length > 0 &&
        typeof envRecord.CLOUDFLARE_API_TOKEN === "string" &&
        envRecord.CLOUDFLARE_API_TOKEN.length > 0
      ) {
        throw makeTypedError(
          "ERR_CF_TOKEN_BLEED_10000",
          "Simultaneous AWS and Cloudflare API credentials detected in runtime env",
        )
      }

      const missingBuckets = R2_BUCKET_BINDINGS.filter((b) => !env[b])
      if (missingBuckets.length > 0) {
        throw makeTypedError(
          "ERR_CF_TOPOLOGY_DRIFT",
          `Missing R2 bindings: ${missingBuckets.join(", ")}`,
        )
      }

      const secretStatus: Record<string, boolean> = {}
      for (const secretName of REQUIRED_SECRETS) {
        const val = env[secretName]
        secretStatus[secretName] = typeof val === "string" && val.length > 0
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              r2BindingsPresent: R2_BUCKET_BINDINGS.length,
              secretsConfigured: secretStatus,
              wallEpochMs: authCtx.wallClock(),
            }),
          },
        ],
      }
    },
  )

  // 4. Mutating tool: Conditional CAS manifest write into LEDGER_RECEIPTS (0 rebases on 412)
  server.registerTool(
    "desk_ledger_manifest_cas_put",
    {
      title: "Desk Ledger Manifest CAS Put",
      description:
        "Atomically updates a ledger manifest in LEDGER_RECEIPTS using strict ETag CAS (0 rebases on 412 -> ERR_R2_MANIFEST_CAS_REJECTED). Requires DESK_ADMIN_TOKEN.",
      inputSchema: z.object({
        key: z.string().min(1).max(512),
        expectedEtag: z.string().min(1).max(256),
        payloadJson: z.string().min(2).max(262_144),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ key, expectedEtag, payloadJson }) => {
      if (!authCtx.isAdminAuthorized) {
        throw makeTypedError("ERR_CF_API_ENVELOPE_FAIL", "Admin authorization required")
      }
      await gateWithLimiter("desk_ledger_manifest_cas_put")

      if (!SAFE_OBJECT_KEY_RE.test(key) || key.includes("..")) {
        throw makeTypedError("ERR_CF_API_ENVELOPE_FAIL", "Invalid manifest key")
      }
      if (!env.LEDGER_RECEIPTS) {
        throw makeTypedError("ERR_CF_TOPOLOGY_DRIFT", "LEDGER_RECEIPTS binding unavailable")
      }

      const result = await env.LEDGER_RECEIPTS.put(key, payloadJson, {
        onlyIf: { etagMatches: expectedEtag },
        httpMetadata: { contentType: "application/json" },
      })

      // R2 returns null on HTTP 412 Precondition Failed: fail closed with 0 rebases.
      if (result === null) {
        throw makeTypedError(
          "ERR_R2_MANIFEST_CAS_REJECTED",
          `Conditional ETag mismatch for ${key} (0 rebases performed)`,
          { key, rebases: 0 },
        )
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              key: result.key,
              etag: result.etag,
              size: result.size,
              rebases: 0,
              wallEpochMs: authCtx.wallClock(),
            }),
          },
        ],
      }
    },
  )

  // Resource: Read-only native R2 binding inventory (gated by MCP_LIMITER)
  server.registerResource(
    "r2-bindings",
    "sportsdesk://r2/bindings",
    {
      title: "Sports Ops Desk Native R2 Bindings",
      description: "Declared native R2 bucket bindings for sports-ops-desk.",
      mimeType: "application/json",
    },
    async (uri) => {
      await gateWithLimiter(`resource:${uri.href}`)
      const summary = {
        bindings: R2_BUCKET_BINDINGS.map((binding) => ({
          binding,
          bound: Boolean(env[binding]),
        })),
        wallEpochMs: authCtx.wallClock(),
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(summary),
          },
        ],
      }
    },
  )

  return server
}

interface ParsedRpcInspection {
  readonly id: string | number | null
  readonly method: string | null
  readonly targetName: string | null
  readonly isMutating: boolean
}

function inspectJsonRpcMessage(payload: unknown): ParsedRpcInspection {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { id: null, method: null, targetName: null, isMutating: false }
  }
  const record = payload as Record<string, unknown>
  const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : null
  const method = typeof record.method === "string" ? record.method : null
  const params =
    typeof record.params === "object" && record.params !== null
      ? (record.params as Record<string, unknown>)
      : null

  if (method === "tools/call" && params && typeof params.name === "string") {
    const toolName = params.name
    return {
      id,
      method,
      targetName: toolName,
      isMutating: MUTATING_MCP_TOOLS.has(toolName),
    }
  }
  if (method === "resources/read" && params && typeof params.uri === "string") {
    return {
      id,
      method,
      targetName: `resource:${params.uri}`,
      isMutating: false,
    }
  }
  return { id, method, targetName: null, isMutating: false }
}

export interface HandleMcpRequestOptions {
  readonly allowedHosts?: readonly string[] | undefined
  readonly allowedOrigins?: readonly string[] | undefined
  readonly logSink?: StructuredLogSink | undefined
  readonly wallClock?: (() => number) | undefined
  readonly monoClock?: (() => number) | undefined
}

/**
 * Primary fail-closed Streamable HTTP `/mcp` handler for `sports-ops-desk`.
 * - Enforces Host & Origin allowlists (`403` on mismatch)
 * - Rejects bare `GET /mcp` without valid Streamable HTTP session/accept headers (`405`)
 * - Enforces constant-time Bearer `DESK_ADMIN_TOKEN` on mutating tools (`401`)
 * - Gates EVERY tool and resource call through `env.MCP_LIMITER` (`429` -> `-32075`)
 * - Serves Streamable HTTP exclusively via `createMcpHandler` + fresh per-request `createServer()`
 */
export async function handleMcpRequest(
  request: Request,
  env: SportsOpsDeskEnv,
  ctx: WorkerExecutionContextLike,
  options?: HandleMcpRequestOptions,
): Promise<Response> {
  const monoClock = options?.monoClock ?? (() => performance.now())
  const wallClock = options?.wallClock ?? (() => Date.now())
  const logSink = options?.logSink ?? ((line) => console.log(line))
  const startMonoMs = monoClock()
  const url = new URL(request.url)

  if (url.pathname !== MCP_ROUTE_PATH) {
    return Response.json({ error: "Not Found" }, { status: 404 })
  }

  const callerHash = await deriveCallerHash(request)

  // 1. Fail-closed Host & Origin allowlist enforcement
  const hostOrigin = validateMcpHostAndOrigin(request, env, {
    allowedHosts: options?.allowedHosts,
    allowedOrigins: options?.allowedOrigins,
  })
  if (!hostOrigin.ok) {
    emitStructuredMcpLog(
      {
        event: "mcp_origin_or_host_rejected",
        component: "mcp_handler",
        callerHash,
        method: request.method,
        status: 403,
        durationMs: monoClock() - startMonoMs,
        wallEpochMs: wallClock(),
      },
      logSink,
    )
    return Response.json(
      { error: "Forbidden", reason: hostOrigin.reason },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    )
  }

  const corsHeaders: Record<string, string> = hostOrigin.allowedOriginHeader
    ? {
        "Access-Control-Allow-Origin": hostOrigin.allowedOriginHeader,
        Vary: "Origin",
      }
    : {}

  // 2. Reject bare GET /mcp without valid Streamable HTTP session & Accept headers
  if (request.method === "GET") {
    const sessionId = request.headers.get("Mcp-Session-Id")?.trim() ?? ""
    const accept = request.headers.get("Accept")?.toLowerCase() ?? ""
    const hasValidStreamableGet = sessionId.length > 0 && accept.includes("text/event-stream")
    if (!hasValidStreamableGet) {
      emitStructuredMcpLog(
        {
          event: "mcp_bare_get_rejected",
          component: "mcp_handler",
          callerHash,
          method: "GET",
          status: 405,
          durationMs: monoClock() - startMonoMs,
          wallEpochMs: wallClock(),
        },
        logSink,
      )
      return Response.json(
        {
          error:
            "Method Not Allowed: bare GET /mcp requires Mcp-Session-Id and Accept: text/event-stream",
        },
        {
          status: 405,
          headers: {
            Allow: "POST, DELETE",
            "Cache-Control": "no-store",
            ...corsHeaders,
          },
        },
      )
    }
  }

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
        "Access-Control-Max-Age": "600",
      },
    })
  }

  if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
    return Response.json(
      { error: "Method Not Allowed" },
      { status: 405, headers: { Allow: "POST, DELETE", ...corsHeaders } },
    )
  }

  // Constant-time Bearer token check (never logged)
  const bearerToken = extractBearerToken(request)
  const adminToken = typeof env.DESK_ADMIN_TOKEN === "string" ? env.DESK_ADMIN_TOKEN : ""
  const isAdminAuthorized =
    bearerToken !== null && adminToken.length > 0 && constantTimeEqualUtf8(bearerToken, adminToken)

  const authCtx: McpRequestAuthContext = {
    callerHash,
    isAdminAuthorized,
    rateLimitedTools: new Set<string>(),
    terminalProtocolError: null,
    lastRetryAfterSec: null,
    logSink,
    wallClock,
    monoClock,
  }

  // 3. For POST JSON-RPC calls, pre-verify admin auth for mutating tools and
  //    gate EVERY tool/resource call through MCP_LIMITER before touching downstream bindings.
  let forwardRequest = request
  let inspected: ParsedRpcInspection = {
    id: null,
    method: null,
    targetName: null,
    isMutating: false,
  }

  if (request.method === "POST") {
    const rawBody = await request.text()
    let parsedJson: unknown = null
    try {
      parsedJson = rawBody.length > 0 ? JSON.parse(rawBody) : null
    } catch {
      parsedJson = null
    }

    inspected = inspectJsonRpcMessage(parsedJson)

    // Fail-closed 401 when invoking any mutating tool without valid DESK_ADMIN_TOKEN
    if (inspected.isMutating && !isAdminAuthorized) {
      emitStructuredMcpLog(
        {
          event: "mcp_mutating_tool_unauthorized",
          component: "mcp_handler",
          callerHash,
          toolName: inspected.targetName ?? undefined,
          method: inspected.method ?? "POST",
          status: 401,
          durationMs: monoClock() - startMonoMs,
          wallEpochMs: wallClock(),
        },
        logSink,
      )
      return makeJsonRpcErrorResponse(
        inspected.id,
        MCP_ERROR_CATALOG.ERR_CF_API_ENVELOPE_FAIL.code,
        "Unauthorized: valid Bearer DESK_ADMIN_TOKEN required for mutating tools",
        {
          error: "UNAUTHORIZED",
          toolName: inspected.targetName,
        },
        401,
        {
          "WWW-Authenticate": 'Bearer realm="sports-ops-desk"',
          ...corsHeaders,
        },
      )
    }

    // Gate EVERY tool/resource call through MCP_LIMITER before touching R2 / Analytics / DOs
    if (inspected.targetName !== null) {
      try {
        const outcome = await consumeMcpLimiterBudget(env, callerHash, inspected.targetName)
        if (!outcome.allowed) {
          emitStructuredMcpLog(
            {
              event: "mcp_tool_rate_limited",
              component: "mcp_handler",
              callerHash,
              toolName: inspected.targetName,
              method: inspected.method ?? "POST",
              status: 429,
              errorCode: "ERR_CF_RATE_LIMIT_429",
              retryAfterSec: outcome.retryAfterSec,
              durationMs: monoClock() - startMonoMs,
              wallEpochMs: wallClock(),
            },
            logSink,
          )
          return makeJsonRpcErrorResponse(
            inspected.id,
            MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.code,
            MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.error,
            {
              error: MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.error,
              code: MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.code,
              exit: MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.exit,
              retryAfterSec: outcome.retryAfterSec,
            },
            429,
            {
              "Retry-After": String(outcome.retryAfterSec),
              ...corsHeaders,
            },
          )
        }
        authCtx.rateLimitedTools.add(inspected.targetName)
      } catch (err) {
        const protoErr =
          err instanceof ProtocolError
            ? err
            : createMcpProtocolError("ERR_CF_API_ENVELOPE_FAIL", "MCP_LIMITER invocation failed")
        emitStructuredMcpLog(
          {
            event: "mcp_limiter_envelope_error",
            component: "mcp_handler",
            callerHash,
            toolName: inspected.targetName,
            method: inspected.method ?? "POST",
            status: 503,
            errorCode: protoErr.code,
            durationMs: monoClock() - startMonoMs,
            wallEpochMs: wallClock(),
          },
          logSink,
        )
        return makeJsonRpcErrorResponse(
          inspected.id,
          protoErr.code,
          protoErr.message,
          typeof protoErr.data === "object" && protoErr.data !== null
            ? (protoErr.data as Record<string, unknown>)
            : { error: MCP_ERROR_CATALOG.ERR_CF_API_ENVELOPE_FAIL.error },
          503,
          corsHeaders,
        )
      }
    }

    // Reconstruct Request with exact headers/body for createMcpHandler
    const forwardHeaders = new Headers(request.headers)
    if (!forwardHeaders.has("Accept")) {
      forwardHeaders.set("Accept", "application/json, text/event-stream")
    }
    forwardRequest = new Request(request.url, {
      method: request.method,
      headers: forwardHeaders,
      body: rawBody,
    })
  }

  // 4. Delegate exclusively to Streamable HTTP createMcpHandler with fresh per-request createServer()
  const allowedHostnames = [...parseAllowlistHostnames(env.MCP_ALLOWED_HOSTS)]
  if (options?.allowedHosts) {
    for (const host of options.allowedHosts) {
      const parsed = parseHostHeaderHostname(host)
      if (parsed) allowedHostnames.push(parsed)
    }
  }
  const allowedOriginHostnames = [...parseAllowlistHostnames(env.MCP_ALLOWED_ORIGINS)]
  if (options?.allowedOrigins) {
    for (const origin of options.allowedOrigins) {
      const parsed = parseHostHeaderHostname(origin)
      if (parsed) allowedOriginHostnames.push(parsed)
    }
  }

  const handler = createMcpHandler(() => createServer(env, authCtx), {
    route: MCP_ROUTE_PATH,
    corsOptions: false,
    allowedHostnames,
    allowedOriginHostnames,
  })

  const response = await handler(forwardRequest, env, ctx as never)

  // For POST tool/resource calls, await completion of the handler body so
  // monotonic durationMs and typed ProtocolError codes (-32065..-32078) are
  // always finalized before sending the wire response.
  const bufferedBody =
    request.method === "POST" && inspected.targetName !== null ? await response.text() : null

  // Preserve typed JSON-RPC ProtocolError codes if SDK v2 wrapped them into a tool result
  if (authCtx.terminalProtocolError) {
    const err = authCtx.terminalProtocolError
    const isRateLimited = err.code === MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.code
    const httpStatus = isRateLimited ? 429 : 200
    const extraHeaders: Record<string, string> = {
      ...corsHeaders,
      ...(isRateLimited && authCtx.lastRetryAfterSec !== null
        ? { "Retry-After": String(authCtx.lastRetryAfterSec) }
        : {}),
    }
    emitStructuredMcpLog(
      {
        event: "mcp_protocol_error",
        component: "mcp_handler",
        callerHash,
        toolName: inspected.targetName ?? undefined,
        method: inspected.method ?? request.method,
        status: httpStatus,
        errorCode: err.code,
        retryAfterSec: authCtx.lastRetryAfterSec ?? undefined,
        durationMs: monoClock() - startMonoMs,
        wallEpochMs: wallClock(),
      },
      logSink,
    )
    return makeJsonRpcErrorResponse(
      inspected.id,
      err.code,
      err.message,
      typeof err.data === "object" && err.data !== null
        ? (err.data as Record<string, unknown>)
        : { code: err.code },
      httpStatus,
      extraHeaders,
    )
  }

  emitStructuredMcpLog(
    {
      event: "mcp_request_complete",
      component: "mcp_handler",
      callerHash,
      toolName: inspected.targetName ?? undefined,
      method: inspected.method ?? request.method,
      status: response.status,
      durationMs: monoClock() - startMonoMs,
      wallEpochMs: wallClock(),
    },
    logSink,
  )

  const outHeaders = new Headers(response.headers)
  if (hostOrigin.allowedOriginHeader) {
    outHeaders.set("Access-Control-Allow-Origin", hostOrigin.allowedOriginHeader)
    outHeaders.set("Vary", "Origin")
  }

  if (bufferedBody !== null) {
    return new Response(bufferedBody, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    })
  }

  if (hostOrigin.allowedOriginHeader) {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    })
  }

  return response
}
