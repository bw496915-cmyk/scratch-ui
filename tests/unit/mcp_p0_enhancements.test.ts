import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { MCP_LIMITER_CONSUME_URL, McpLimiterDO, type McpLimiterStateLike } from "../../src/do/mcp_limiter.ts"
import { MCP_ERROR_CATALOG } from "../../src/mcp/errors.ts"
import { handleMcpRequest } from "../../src/mcp/handler.ts"
import type { SportsOpsDeskEnv } from "../../src/types/env.ts"

function createMemoryDoState(): McpLimiterStateLike {
  const store = new Map<string, unknown>()
  return {
    storage: {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined
      },
      async put<T = unknown>(key: string, value: T): Promise<void> {
        store.set(key, value)
      },
    },
  }
}

function createFakeLimiterNamespace(options?: {
  capacity?: number
  refillPerSec?: number
  wallClock?: () => number
  monoClock?: () => number
  logSink?: (line: string) => void
}): DurableObjectNamespace {
  const instances = new Map<string, McpLimiterDO>()
  return {
    idFromName(name: string) {
      return { toString: () => name } as DurableObjectId
    },
    get(id: DurableObjectId) {
      const key = id.toString()
      let inst = instances.get(key)
      if (!inst) {
        inst = new McpLimiterDO(createMemoryDoState(), undefined, {
          defaultPolicy: {
            capacity: options?.capacity ?? 3,
            refillPerSec: options?.refillPerSec ?? 0.5,
          },
          toolPolicies: {
            desk_ledger_manifest_cas_put: {
              capacity: options?.capacity ?? 3,
              refillPerSec: options?.refillPerSec ?? 0.5,
            },
          },
          wallClock: options?.wallClock,
          monoClock: options?.monoClock,
          logSink: options?.logSink,
        })
        instances.set(key, inst)
      }
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init)
          return inst!.fetch(req)
        },
      } as unknown as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

function createFakeR2Bucket(hooks?: {
  onHead?: (key: string) => R2Object | null
  onPut?: (key: string, value: unknown, opts?: R2PutOptions) => R2Object | null
}): R2Bucket {
  return {
    async head(key: string) {
      return hooks?.onHead ? hooks.onHead(key) : null
    },
    async put(key: string, value: unknown, opts?: R2PutOptions) {
      if (hooks?.onPut) return hooks.onPut(key, value, opts)
      return {
        key,
        etag: "etag-v2",
        size: typeof value === "string" ? value.length : 0,
      } as unknown as R2Object
    },
  } as unknown as R2Bucket
}

const FAKE_CTX = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

function createTestEnv(
  overrides?: Partial<SportsOpsDeskEnv> & {
    limiterNamespace?: DurableObjectNamespace
  },
): SportsOpsDeskEnv {
  return {
    DESK_ARCHIVE: createFakeR2Bucket(),
    OPS_REPORTS: createFakeR2Bucket(),
    BETS_BUCKET: createFakeR2Bucket(),
    LEDGER_RECEIPTS: createFakeR2Bucket(),
    MCP_LIMITER: overrides?.limiterNamespace ?? createFakeLimiterNamespace(),
    DATABASE_URL: "postgres://user:pass@db.internal/desk",
    DESK_ADMIN_TOKEN: "super-secret-admin-token-998877",
    TELEGRAM_BOT_TOKEN: "123456:telegram-secret",
    TELEGRAM_ALLOWED_CHATS: "1001,1002",
    WORKSPACE_VAULT_KEY: "vault-key-secret",
    ...overrides,
  }
}

describe("P0 Cloudflare Wrangler Configs", () => {
  test("sports-ops-desk wrangler.jsonc declares native R2 buckets, required secrets, and 0.10 trace sampling", () => {
    const raw = readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8")
    const cfg = Bun.JSONC.parse(raw) as {
      name: string
      r2_buckets: Array<{ binding: string; bucket_name: string }>
      durable_objects: { bindings: Array<{ name: string; class_name: string }> }
      secrets: { required: string[] }
      observability: {
        redact_query_string: boolean
        traces: { head_sampling_rate: number }
      }
    }

    expect(cfg.name).toBe("sports-ops-desk")
    expect(cfg.r2_buckets).toEqual([
      { binding: "DESK_ARCHIVE", bucket_name: "desk-archive" },
      { binding: "OPS_REPORTS", bucket_name: "sportsdesk-ops-reports" },
      { binding: "BETS_BUCKET", bucket_name: "f402-bets" },
      { binding: "LEDGER_RECEIPTS", bucket_name: "ledger-receipts" },
    ])
    expect(cfg.durable_objects.bindings).toContainEqual({
      name: "MCP_LIMITER",
      class_name: "McpLimiterDO",
    })
    expect(cfg.secrets.required).toEqual([
      "DATABASE_URL",
      "DESK_ADMIN_TOKEN",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_ALLOWED_CHATS",
      "WORKSPACE_VAULT_KEY",
    ])
    expect(cfg.observability.traces.head_sampling_rate).toBe(0.1)
    expect(cfg.observability.redact_query_string).toBe(true)
  })

  test("fantasy402-bet-ingest wrangler.jsonc aligns compatibility_date to 2026-10-07 with ANALYTICS and BETS_BUCKET intact", () => {
    const raw = readFileSync(resolve(process.cwd(), "workers/fantasy402-bet-ingest/wrangler.jsonc"), "utf8")
    const cfg = Bun.JSONC.parse(raw) as {
      name: string
      compatibility_date: string
      analytics_engine_datasets: Array<{ binding: string; dataset: string }>
      r2_buckets: Array<{ binding: string; bucket_name: string }>
    }

    expect(cfg.name).toBe("fantasy402-bet-ingest")
    expect(cfg.compatibility_date).toBe("2026-10-07")
    expect(cfg.analytics_engine_datasets).toContainEqual({
      binding: "ANALYTICS",
      dataset: "fantasy402_bet_ingest",
    })
    expect(cfg.r2_buckets).toContainEqual({
      binding: "BETS_BUCKET",
      bucket_name: "f402-bets",
    })
  })
})

describe("MCP_LIMITER Durable Object (src/do/mcp_limiter.ts)", () => {
  test("returns 200 within budget and 429 + Retry-After + -32075 on exhaustion", async () => {
    let wallMs = 1_760_000_000_000
    let monoMs = 100
    const logs: string[] = []
    const limiter = new McpLimiterDO(createMemoryDoState(), undefined, {
      defaultPolicy: { capacity: 2, refillPerSec: 0.5 },
      wallClock: () => wallMs,
      monoClock: () => {
        monoMs += 1.5
        return monoMs
      },
      logSink: (line) => logs.push(line),
    })

    const consume = () =>
      limiter.fetch(
        new Request(MCP_LIMITER_CONSUME_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-MCP-Caller-Hash": "0123456789abcdef0123456789abcdef",
          },
          body: JSON.stringify({ toolName: "desk_r2_status" }),
        }),
      )

    const r1 = await consume()
    expect(r1.status).toBe(200)
    const b1 = (await r1.json()) as {
      allowed: boolean
      remaining: number
      resetEpochMs: number
    }
    expect(b1.allowed).toBe(true)
    expect(b1.remaining).toBe(1)
    expect(b1.resetEpochMs).toBeGreaterThan(wallMs)

    const r2 = await consume()
    expect(r2.status).toBe(200)
    const b2 = (await r2.json()) as { allowed: boolean; remaining: number }
    expect(b2.allowed).toBe(true)
    expect(b2.remaining).toBe(0)

    // 3rd request exhausts budget -> 429 + integer Retry-After + -32075
    const r3 = await consume()
    expect(r3.status).toBe(429)
    const retryHeader = r3.headers.get("Retry-After")
    expect(retryHeader).toBe("2")
    const b3 = (await r3.json()) as {
      error: string
      code: number
      exit: number
      retryAfterSec: number
    }
    expect(b3).toEqual({
      error: "ERR_CF_RATE_LIMIT_429",
      code: -32075,
      exit: 75,
      retryAfterSec: 2,
    })

    // Advancing wall clock by 2 seconds refills 1 token
    wallMs += 2_000
    const r4 = await consume()
    expect(r4.status).toBe(200)
    expect(logs.length).toBe(4)
  })
})

describe("Streamable HTTP /mcp Handler (src/mcp/handler.ts)", () => {
  test("returns 405 on bare GET /mcp", async () => {
    const logs: string[] = []
    const env = createTestEnv()
    const res = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "GET",
        headers: { Host: "localhost:8788" },
      }),
      env,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )
    expect(res.status).toBe(405)
    expect(res.headers.get("Allow")).toContain("POST")
  })

  test("returns 403 on disallowed Origin and disallowed Host", async () => {
    const logs: string[] = []
    const env = createTestEnv()

    const badOriginRes = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8788",
          Origin: "https://evil.attacker.invalid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }),
      env,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )
    expect(badOriginRes.status).toBe(403)

    const badHostRes = await handleMcpRequest(
      new Request("http://evil.attacker.invalid/mcp", {
        method: "POST",
        headers: {
          Host: "evil.attacker.invalid",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
      env,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )
    expect(badHostRes.status).toBe(403)
  })

  test("returns 401 on mutating tool without valid DESK_ADMIN_TOKEN and preserves CAS 412 -> -32074 with valid token", async () => {
    const logs: string[] = []
    let putCalls = 0
    const env = createTestEnv({
      LEDGER_RECEIPTS: createFakeR2Bucket({
        onPut: () => {
          putCalls += 1
          // Simulate R2 HTTP 412 precondition failed -> null
          return null
        },
      }),
    })

    const callBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "desk_ledger_manifest_cas_put",
        arguments: {
          key: "manifests/2026-11-21.json",
          expectedEtag: "stale-etag-1",
          payloadJson: '{"seq":2}',
        },
      },
    })

    // Missing Authorization -> 401
    const unauthRes = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8788",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: callBody,
      }),
      env,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )
    expect(unauthRes.status).toBe(401)
    expect(putCalls).toBe(0)

    // Wrong Bearer token -> 401
    const wrongRes = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8788",
          Authorization: "Bearer wrong-token-value",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: callBody,
      }),
      env,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )
    expect(wrongRes.status).toBe(401)
    expect(putCalls).toBe(0)

    // Valid DESK_ADMIN_TOKEN -> invokes R2 CAS once (0 rebases) and maps 412 -> -32074
    const casRes = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8788",
          Authorization: `Bearer ${env.DESK_ADMIN_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: callBody,
      }),
      env,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )
    const casBody = (await casRes.json()) as {
      error?: {
        code: number
        message: string
        data?: { error: string; exit: number; rebases: number }
      }
    }
    expect(putCalls).toBe(1)
    expect(casBody.error?.code).toBe(MCP_ERROR_CATALOG.ERR_R2_MANIFEST_CAS_REJECTED.code)
    expect(casBody.error?.data?.exit).toBe(74)
    expect(casBody.error?.data?.rebases).toBe(0)
  })

  test("gates every tool through MCP_LIMITER before touching R2 and maps 429 to JSON-RPC -32075", async () => {
    const logs: string[] = []
    let r2HeadCalls = 0
    const limiterNamespace = createFakeLimiterNamespace({
      capacity: 1,
      refillPerSec: 0.25,
      logSink: (line) => logs.push(line),
    })
    const env = createTestEnv({
      limiterNamespace,
      OPS_REPORTS: createFakeR2Bucket({
        onHead: (key) => {
          r2HeadCalls += 1
          return {
            key,
            size: 128,
            etag: "etag-ok",
            uploaded: new Date(Date.now() - 5_000),
          } as unknown as R2Object
        },
      }),
    })

    const makeCall = (id: number) =>
      handleMcpRequest(
        new Request("http://localhost:8788/mcp", {
          method: "POST",
          headers: {
            Host: "localhost:8788",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "CF-Connecting-IP": "203.0.113.42",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: "desk_r2_head_object",
              arguments: {
                bucket: "OPS_REPORTS",
                key: "daily/summary.json",
              },
            },
          }),
        }),
        env,
        FAKE_CTX,
        { logSink: (line) => logs.push(line) },
      )

    // 1st call succeeds within budget and touches R2 once
    const first = await makeCall(1)
    expect(first.status).toBe(200)
    expect(r2HeadCalls).toBe(1)

    // 2nd call hits MCP_LIMITER 429 -> returns JSON-RPC -32075 BEFORE touching R2
    const second = await makeCall(2)
    expect(second.status).toBe(429)
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1)
    expect(r2HeadCalls).toBe(1)
    const errBody = (await second.json()) as {
      error: { code: number; message: string; data: { error: string; exit: number } }
    }
    expect(errBody.error.code).toBe(-32075)
    expect(errBody.error.data.error).toBe("ERR_CF_RATE_LIMIT_429")
    expect(errBody.error.data.exit).toBe(75)
  })

  test("serves tools/list with 200 and emits zero raw tokens, IPs, or emails in logs", async () => {
    const logs: string[] = []
    const rawSecretToken = "super-secret-admin-token-998877"
    const rawIp = "198.51.100.77"
    const rawEmail = "operator.leak@sportsdesk.invalid"
    const env = createTestEnv({
      DESK_ADMIN_TOKEN: rawSecretToken,
      limiterNamespace: createFakeLimiterNamespace({
        capacity: 10,
        logSink: (line) => logs.push(line),
      }),
    })

    const listRes = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8788",
          Authorization: `Bearer ${rawSecretToken}`,
          "CF-Connecting-IP": rawIp,
          "X-Operator-Email": rawEmail,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/list",
          params: {},
        }),
      }),
      env,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )

    expect(listRes.status).toBe(200)
    const text = await listRes.text()
    expect(text).toContain("desk_r2_status")
    expect(text).toContain("desk_r2_head_object")
    expect(text).toContain("desk_topology_check")
    expect(text).toContain("desk_ledger_manifest_cas_put")

    // Zero PII / secret leakage check across every emitted log line
    expect(logs.length).toBeGreaterThan(0)
    for (const line of logs) {
      expect(line).not.toContain(rawSecretToken)
      expect(line).not.toContain(rawIp)
      expect(line).not.toContain(rawEmail)
      const parsed = JSON.parse(line) as {
        callerHash: string
        durationMs: number
        wallEpochMs: number
      }
      expect(parsed.callerHash).toMatch(/^[a-f0-9]{32}$/)
      expect(typeof parsed.durationMs).toBe("number")
      expect(typeof parsed.wallEpochMs).toBe("number")
    }
  })

  test("preserves BLK_R2_STALE_SINK (-32078), ERR_CF_TOPOLOGY_DRIFT (-32070), and ERR_CF_TOKEN_BLEED_10000 (-32077)", async () => {
    const logs: string[] = []
    const nowMs = 1_760_000_100_000

    // 1. Stale sink -> -32078
    const staleEnv = createTestEnv({
      BETS_BUCKET: createFakeR2Bucket({
        onHead: (key) =>
          ({
            key,
            size: 42,
            etag: "etag-old",
            uploaded: new Date(nowMs - 600_000),
          }) as unknown as R2Object,
      }),
    })
    const staleRes = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8788",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 101,
          method: "tools/call",
          params: {
            name: "desk_r2_head_object",
            arguments: {
              bucket: "BETS_BUCKET",
              key: "f402-bets.jsonl",
              maxAgeSec: 60,
            },
          },
        }),
      }),
      staleEnv,
      FAKE_CTX,
      { wallClock: () => nowMs, logSink: (line) => logs.push(line) },
    )
    const staleJson = (await staleRes.json()) as {
      error?: { code: number; data?: { exit: number } }
    }
    expect(staleJson.error?.code).toBe(-32078)
    expect(staleJson.error?.data?.exit).toBe(78)

    // 2. Topology drift (missing native R2 binding) -> -32070
    const driftEnv = createTestEnv({
      LEDGER_RECEIPTS: undefined as unknown as R2Bucket,
    })
    const driftRes = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8788",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 102,
          method: "tools/call",
          params: {
            name: "desk_r2_status",
            arguments: {},
          },
        }),
      }),
      driftEnv,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )
    const driftJson = (await driftRes.json()) as {
      error?: { code: number; data?: { exit: number } }
    }
    expect(driftJson.error?.code).toBe(-32070)
    expect(driftJson.error?.data?.exit).toBe(70)

    // 3. Token bleed -> -32077
    const bleedEnv = {
      ...createTestEnv(),
      AWS_ACCESS_KEY_ID: "AKIA_BLEED_TEST",
      CLOUDFLARE_API_TOKEN: "CF_BLEED_TEST",
    } as unknown as SportsOpsDeskEnv
    const bleedRes = await handleMcpRequest(
      new Request("http://localhost:8788/mcp", {
        method: "POST",
        headers: {
          Host: "localhost:8788",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 103,
          method: "tools/call",
          params: {
            name: "desk_topology_check",
            arguments: {},
          },
        }),
      }),
      bleedEnv,
      FAKE_CTX,
      { logSink: (line) => logs.push(line) },
    )
    const bleedJson = (await bleedRes.json()) as {
      error?: { code: number; data?: { exit: number } }
    }
    expect(bleedJson.error?.code).toBe(-32077)
    expect(bleedJson.error?.data?.exit).toBe(77)
  })
})
