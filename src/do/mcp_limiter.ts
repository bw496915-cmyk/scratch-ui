import { emitStructuredMcpLog, MCP_ERROR_CATALOG, type StructuredLogSink } from "../mcp/errors.ts"

export const MCP_LIMITER_CONSUME_URL = "https://mcp-limiter.internal/consume"

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9._:/-]{1,128}$/
const BUCKET_STORAGE_PREFIX = "bucket:"

export interface TokenBucketPolicy {
  /** Maximum burst tokens available per caller per tool. */
  readonly capacity: number
  /** Refill rate in tokens per second. */
  readonly refillPerSec: number
}

export interface PersistedTokenBucket {
  tokens: number
  /** Wall-clock epoch ms of last refill update (Date.now()). */
  lastRefillEpochMs: number
}

export interface McpLimiterConsumeResponseAllowed {
  readonly allowed: true
  readonly remaining: number
  readonly resetEpochMs: number
}

export interface McpLimiterConsumeResponseLimited {
  readonly error: "ERR_CF_RATE_LIMIT_429"
  readonly code: -32075
  readonly exit: 75
  readonly retryAfterSec: number
}

export interface McpLimiterStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>
  put<T = unknown>(key: string, value: T): Promise<void>
}

export interface McpLimiterStateLike {
  readonly storage: McpLimiterStorageLike
}

export interface McpLimiterOptions {
  readonly defaultPolicy?: TokenBucketPolicy | undefined
  readonly toolPolicies?: Readonly<Record<string, TokenBucketPolicy>> | undefined
  readonly wallClock?: (() => number) | undefined
  readonly monoClock?: (() => number) | undefined
  readonly logSink?: StructuredLogSink | undefined
}

export const DEFAULT_TOOL_BUCKET_POLICY: TokenBucketPolicy = {
  capacity: 60,
  refillPerSec: 1,
}

export const DEFAULT_MUTATING_TOOL_BUCKET_POLICY: TokenBucketPolicy = {
  capacity: 15,
  refillPerSec: 0.25,
}

const BUILTIN_TOOL_POLICIES: Readonly<Record<string, TokenBucketPolicy>> = {
  desk_ledger_manifest_cas_put: DEFAULT_MUTATING_TOOL_BUCKET_POLICY,
}

/**
 * Per-caller, per-tool token-bucket Durable Object (`MCP_LIMITER`). Instances are addressed via
 * `env.MCP_LIMITER.idFromName(callerHash)`. Separates Wall (`Date.now()`) for token refill /
 * resetEpochMs from Monotonic (`performance.now()`) for execution latency measurement.
 */
export class McpLimiterDO {
  private readonly ctx: McpLimiterStateLike
  private readonly defaultPolicy: TokenBucketPolicy
  private readonly toolPolicies: Readonly<Record<string, TokenBucketPolicy>>
  private readonly wallClock: () => number
  private readonly monoClock: () => number
  private readonly logSink: StructuredLogSink
  /** Hot-path in-memory bucket cache to avoid redundant storage reads. */
  private readonly bucketCache = new Map<string, PersistedTokenBucket>()

  constructor(ctx: McpLimiterStateLike, _env?: unknown, options?: McpLimiterOptions) {
    this.ctx = ctx
    this.defaultPolicy = options?.defaultPolicy ?? DEFAULT_TOOL_BUCKET_POLICY
    this.toolPolicies = {
      ...BUILTIN_TOOL_POLICIES,
      ...(options?.toolPolicies ?? {}),
    }
    this.wallClock = options?.wallClock ?? (() => Date.now())
    this.monoClock = options?.monoClock ?? (() => performance.now())
    this.logSink = options?.logSink ?? ((line) => console.log(line))
  }

  private resolvePolicy(toolName: string): TokenBucketPolicy {
    return this.toolPolicies[toolName] ?? this.defaultPolicy
  }

  private async loadBucket(
    toolName: string,
    policy: TokenBucketPolicy,
    nowWallMs: number,
  ): Promise<PersistedTokenBucket> {
    const cached = this.bucketCache.get(toolName)
    if (cached) {
      return cached
    }
    const key = `${BUCKET_STORAGE_PREFIX}${toolName}`
    const stored = await this.ctx.storage.get<PersistedTokenBucket>(key)
    const bucket: PersistedTokenBucket =
      stored &&
      typeof stored.tokens === "number" &&
      Number.isFinite(stored.tokens) &&
      typeof stored.lastRefillEpochMs === "number" &&
      Number.isFinite(stored.lastRefillEpochMs)
        ? { tokens: stored.tokens, lastRefillEpochMs: stored.lastRefillEpochMs }
        : { tokens: policy.capacity, lastRefillEpochMs: nowWallMs }

    this.bucketCache.set(toolName, bucket)
    return bucket
  }

  async fetch(request: Request): Promise<Response> {
    const startMonoMs = this.monoClock()
    const nowWallMs = this.wallClock()
    const callerHash = request.headers.get("X-MCP-Caller-Hash") ?? "unknown"
    const url = new URL(request.url)

    if (url.pathname !== "/consume") {
      emitStructuredMcpLog(
        {
          event: "limiter_not_found",
          component: "mcp_limiter",
          callerHash,
          method: request.method,
          status: 404,
          durationMs: this.monoClock() - startMonoMs,
          wallEpochMs: nowWallMs,
        },
        this.logSink,
      )
      return Response.json({ error: "Not Found" }, { status: 404 })
    }

    if (request.method !== "POST") {
      emitStructuredMcpLog(
        {
          event: "limiter_method_not_allowed",
          component: "mcp_limiter",
          callerHash,
          method: request.method,
          status: 405,
          durationMs: this.monoClock() - startMonoMs,
          wallEpochMs: nowWallMs,
        },
        this.logSink,
      )
      return Response.json(
        { error: "Method Not Allowed" },
        { status: 405, headers: { Allow: "POST" } },
      )
    }

    let body: unknown
    try {
      body = await request.json()
    } catch {
      emitStructuredMcpLog(
        {
          event: "limiter_bad_json",
          component: "mcp_limiter",
          callerHash,
          method: "POST",
          status: 400,
          durationMs: this.monoClock() - startMonoMs,
          wallEpochMs: nowWallMs,
        },
        this.logSink,
      )
      return Response.json({ error: "Invalid JSON payload" }, { status: 400 })
    }

    const toolName =
      typeof body === "object" &&
      body !== null &&
      "toolName" in body &&
      typeof (body as { toolName?: unknown }).toolName === "string"
        ? (body as { toolName: string }).toolName.trim()
        : ""

    if (!toolName || !TOOL_NAME_PATTERN.test(toolName)) {
      emitStructuredMcpLog(
        {
          event: "limiter_invalid_tool",
          component: "mcp_limiter",
          callerHash,
          method: "POST",
          status: 400,
          durationMs: this.monoClock() - startMonoMs,
          wallEpochMs: nowWallMs,
        },
        this.logSink,
      )
      return Response.json({ error: "Invalid or missing toolName" }, { status: 400 })
    }

    const policy = this.resolvePolicy(toolName)
    const bucket = await this.loadBucket(toolName, policy, nowWallMs)

    // Refill in place using Wall clock delta (zero allocation on hot path).
    const elapsedSec = Math.max(0, (nowWallMs - bucket.lastRefillEpochMs) / 1000)
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(policy.capacity, bucket.tokens + elapsedSec * policy.refillPerSec)
      bucket.lastRefillEpochMs = nowWallMs
    }

    const cost = 1
    if (bucket.tokens < cost) {
      const deficit = cost - bucket.tokens
      const retryAfterSec = Math.max(1, Math.ceil(deficit / policy.refillPerSec))
      const payload: McpLimiterConsumeResponseLimited = {
        error: MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.error,
        code: MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.code,
        exit: MCP_ERROR_CATALOG.ERR_CF_RATE_LIMIT_429.exit,
        retryAfterSec,
      }
      emitStructuredMcpLog(
        {
          event: "limiter_exhausted",
          component: "mcp_limiter",
          callerHash,
          toolName,
          method: "POST",
          status: 429,
          errorCode: "ERR_CF_RATE_LIMIT_429",
          remaining: 0,
          retryAfterSec,
          durationMs: this.monoClock() - startMonoMs,
          wallEpochMs: nowWallMs,
        },
        this.logSink,
      )
      return Response.json(payload, {
        status: 429,
        headers: {
          "Retry-After": String(retryAfterSec),
          "Cache-Control": "no-store",
        },
      })
    }

    bucket.tokens -= cost
    bucket.lastRefillEpochMs = nowWallMs
    await this.ctx.storage.put(`${BUCKET_STORAGE_PREFIX}${toolName}`, bucket)

    const remaining = Math.floor(bucket.tokens)
    const tokensToFull = Math.max(0, policy.capacity - bucket.tokens)
    const resetEpochMs = Math.ceil(nowWallMs + (tokensToFull / policy.refillPerSec) * 1000)

    const payload: McpLimiterConsumeResponseAllowed = {
      allowed: true,
      remaining,
      resetEpochMs,
    }

    emitStructuredMcpLog(
      {
        event: "limiter_allowed",
        component: "mcp_limiter",
        callerHash,
        toolName,
        method: "POST",
        status: 200,
        remaining,
        durationMs: this.monoClock() - startMonoMs,
        wallEpochMs: nowWallMs,
      },
      this.logSink,
    )

    return Response.json(payload, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    })
  }
}
