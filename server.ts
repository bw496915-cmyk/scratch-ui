/**
 * Node.js 22 Express + Vite + WebSocket server for the SportsDesk Enhanced Surveillance Dashboard.
 * Binds to 0.0.0.0:3000 as a single unified process (API + WebSocket pub/sub + Vite SPA).
 *
 * @file Server.ts
 */

import "dotenv/config"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, resolve } from "node:path"

import express from "express"
import { type WebSocket, WebSocketServer } from "ws"

import { containedAssetPath } from "./lib/asset_path.ts"
import { auditConfig } from "./lib/audit_log.ts"
import { runBatchedRanking } from "./lib/customer_rankings.ts"
import {
  buildSecurityHeaders,
  constantTimeEqual,
  createEnforceAdminMiddleware,
  createEnforceAuthMiddleware,
  createHttpAuthController,
  HASHED_ASSET_CACHE_CONTROL,
  isPublicApiRoute,
  sendNoncedHtmlShell,
  validateTerminalCommand,
} from "./lib/http_auth.ts"
import { probeR2ImageProvenance } from "./lib/image_provenance.ts"
import { parseShortDesc } from "./lib/live_wagers.ts"
import { SUBSPORT_TAXONOMY_CATALOG } from "./lib/market_taxonomy_catalog.ts"
import { SLAB_SERVER } from "./lib/slab_config.ts"
import { loadTomlConfig } from "./lib/wager_config.ts"
import { loadWagersTabPolicyStamp } from "./lib/wagers_tab_policy.ts"
import { inspectWagersWireContract } from "./lib/wagers_wire_contract.ts"
import {
  createDashboardApi,
  deriveWebSocketUrl,
  loadValidatedEgressOrigins,
  type WsLike,
} from "./packages/api/src/index.ts"
import {
  computeCustomersCohortPayload,
  createAgentDetailService,
  createBetTickerService,
  createCachedJsonReader,
  createCustomerRowFinder,
  createDevLiveWagersLoader,
  createR2PipelineService,
  DashboardHealthTracker,
  DashboardMarkdownCache,
  DEFAULT_R2_PUBLIC_BASE,
  isSentinelTickerWriter,
} from "./packages/backend/src/index.ts"
import { type AgentDetailApiResponse, bunEscapeHtml } from "./packages/contracts/src/index.ts"
import {
  benchmarkNodeDns,
  buildCustomerProfileFromRow,
  buildCustomerRatingFromRow,
  buildNodeAutomationsSnapshot,
  classifyIpAddressNode,
  createInMemoryAlertStore,
  executeNodeTerminalQuery,
  getDnsTelemetryPayload,
  getNodeBuildMatrix,
  runNodeShadowPricingDashboard,
  runNodeTicketVerification,
} from "./server/adapters.ts"
import {
  type BunImageTransformRequest,
  readRawAssetFile,
  scanBunImageAssets,
  transformBunImageAsset,
} from "./server/bun_image_engine.ts"
import {
  archiveWebLogsToR2,
  getBunS3Capabilities,
  loadR2ClientConfiguration,
  R2_CLIENT_INSPECT_PATH,
} from "./server/bun_r2_inspect.ts"
import { type BunInspectOptions, parseInspectOptionsFromQuery } from "./server/desk_inspect.ts"
import {
  formatProfileInspectPayload,
  normalizeRawCustomerToProfileRecord,
  type ProfileInspectRecord,
  type ProfileInspectSortField,
} from "./server/profile_inspect.ts"
import {
  createWebLogStore,
  extractWebLogIngestRawText,
  type WebLogSortDir,
  type WebLogSortField,
} from "./server/weblog_inspect.ts"
import { profileRoutes } from "./src/http/profile_routes.ts"
import { createMemoryProfileStore, profileOrDefault } from "./src/profile/store.ts"
import { runRuntimePreflightAudit } from "./src/runtime-preflight.ts"
import {
  isAllowedS3StorageClass,
  isR2ObjectPrefix,
  isR2ObjectProbeKey,
  withInspectRole,
} from "./src/s3/sealed_r2_handle.ts"

function resolvePrimaryPort(): number {
  const cliPortIdx = process.argv.indexOf("--port")
  if (cliPortIdx !== -1) {
    const cliPort = Number(process.argv[cliPortIdx + 1])
    if (Number.isInteger(cliPort) && cliPort > 0 && cliPort <= 65535) {
      return cliPort
    }
  }
  const envPort = Number(process.env.PORT)
  if (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535) {
    return envPort
  }
  const defaultAppPort = Number(process.env.DEFAULT_APP_PORT)
  if (Number.isInteger(defaultAppPort) && defaultAppPort > 0 && defaultAppPort <= 65535) {
    return defaultAppPort
  }
  return 3000
}

const FALLBACK_APP_PORT =
  Number.isInteger(Number(process.env.DEFAULT_APP_PORT)) && Number(process.env.DEFAULT_APP_PORT) > 0
    ? Number(process.env.DEFAULT_APP_PORT)
    : 3000
let PORT = resolvePrimaryPort()
const HOST = "0.0.0.0"
const CWD = existsSync(resolve(process.cwd(), "dist/index.html"))
  ? process.cwd()
  : existsSync(resolve(import.meta.dirname ?? process.cwd(), "dist/index.html"))
    ? (import.meta.dirname ?? process.cwd())
    : process.cwd()
const HAS_DIST_BUILD = existsSync(resolve(CWD, "dist/index.html"))
const USE_VITE_DEV =
  process.env.SPORTSDESK_DEV_SERVER === "1" ||
  (!HAS_DIST_BUILD && process.env.NODE_ENV === "development")
const IS_PROD =
  !USE_VITE_DEV &&
  (HAS_DIST_BUILD || process.env.NODE_ENV === "production" || Boolean(process.env.K_SERVICE))

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
}

function escapeHtml(value: unknown): string {
  return bunEscapeHtml(String(value ?? ""))
}

function renderAgentHtmlPage(detail: AgentDetailApiResponse): string {
  const agentId = escapeHtml(detail.agentId)
  const master = detail.masterAgent
    ? `<a href="/agent/${encodeURIComponent(detail.masterAgent)}">${escapeHtml(detail.masterAgent)}</a>`
    : "Root / Unassigned"
  const childrenHtml =
    detail.childAgents.length > 0
      ? detail.childAgents
          .map((c) => `<a class="chip" href="/agent/${encodeURIComponent(c)}">${escapeHtml(c)}</a>`)
          .join("")
      : "<span class='muted'>None</span>"

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent ${agentId} · SportsDesk Ops</title>
  <style>
    body { background:#0b1120; color:#e2e8f0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; margin:0; padding:24px; }
    .wrap { max-width:960px; margin:0 auto; }
    .card { background:#111827; border:1px solid #1f2937; border-radius:8px; padding:16px; margin-bottom:16px; }
    a { color:#38bdf8; text-decoration:none; }
    .chip { display:inline-block; padding:4px 8px; margin:4px; background:#1e293b; border-radius:4px; }
    .muted { color:#94a3b8; }
  </style>
</head>
<body>
  <div class="wrap">
    <p><a href="/">← Back to SportsDesk Surveillance Dashboard</a></p>
    <div class="card">
      <h1>Agent ${agentId}</h1>
      <p>Master Agent: ${master} · Customers: ${detail.customers.length} · Recent Wagers: ${detail.recentWagers.length}</p>
    </div>
    <div class="card">
      <h2>Child Agents (${detail.childAgents.length})</h2>
      <div>${childrenHtml}</div>
    </div>
  </div>
</body>
</html>`
}

/** Wrap a Node `ws` WebSocket to satisfy `@sportsdesk-ops/api`'s `WsLike` topic interface. */
class NodeWsAdapter implements WsLike {
  private readonly topicSet = new Set<string>()
  private readonly socket: WebSocket

  constructor(socket: WebSocket) {
    this.socket = socket
  }

  get subscriptions(): readonly string[] {
    return [...this.topicSet]
  }

  subscribe(topic: string): void {
    this.topicSet.add(topic)
  }

  unsubscribe(topic: string): void {
    this.topicSet.delete(topic)
  }

  send(data: string): unknown {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(data)
      return data.length
    }
    return 0
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }
}

async function toWebRequest(req: express.Request): Promise<Request> {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim()
    .toLowerCase()
  const proto = req.secure || forwardedProto === "https" ? "https" : req.protocol || "http"
  const origin = `${proto}://${req.headers.host || `127.0.0.1:${PORT}`}`
  const url = new URL(req.originalUrl, origin)
  const headers = new Headers()
  for (const [key, val] of Object.entries(req.headers)) {
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v)
    } else if (val !== undefined) {
      headers.set(key, val)
    }
  }
  const method = req.method.toUpperCase()
  let body: BodyInit | undefined
  if (method !== "GET" && method !== "HEAD") {
    if (Buffer.isBuffer(req.body)) {
      body = new Uint8Array(req.body)
    } else if (typeof req.body === "string") {
      body = req.body
    } else if (req.body && Object.keys(req.body).length > 0) {
      body = JSON.stringify(req.body)
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json")
      }
    }
  }
  return new Request(url.toString(), { method, headers, body })
}

async function sendWebResponse(res: express.Response, webRes: Response): Promise<void> {
  res.status(webRes.status)
  const setCookies =
    typeof webRes.headers.getSetCookie === "function" ? webRes.headers.getSetCookie() : []
  for (const [key, value] of webRes.headers) {
    const lower = key.toLowerCase()
    if (lower === "transfer-encoding" || lower === "set-cookie") continue
    if (lower === "cache-control" && value.toLowerCase() === "no-cache") {
      res.setHeader("Cache-Control", "no-store")
      continue
    }
    res.setHeader(key, value)
  }
  if (setCookies.length > 0) {
    res.setHeader("Set-Cookie", setCookies)
  }
  const buf = Buffer.from(await webRes.arrayBuffer())
  res.send(buf)
}

async function startServer() {
  runRuntimePreflightAudit({ throwOnFailure: true })
  const app = express()
  app.disable("x-powered-by")

  const httpAuth = createHttpAuthController()

  // Global security headers (F5) + no-store on API/health responses
  app.use((req, res, next) => {
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      ?.trim()
      .toLowerCase()
    const secHeaders = buildSecurityHeaders({
      isProd: IS_PROD,
      isHttps: req.secure || forwardedProto === "https",
    })
    for (const [key, val] of Object.entries(secHeaders)) {
      res.setHeader(key, val)
    }
    if (req.path === "/health" || req.path.startsWith("/api")) {
      res.setHeader("Cache-Control", "no-store")
    }
    next()
  })

  app.use(express.json({ limit: "4mb" }))
  app.use(express.text({ limit: "4mb" }))

  const requireExpressAuth = createEnforceAuthMiddleware(httpAuth, {
    fallbackPort: PORT,
  })
  const requireExpressAdminAuth = createEnforceAdminMiddleware(httpAuth, {
    fallbackPort: PORT,
  })

  const wsClients = new Set<NodeWsAdapter>()
  const alertStore = createInMemoryAlertStore()
  const weblogStore = createWebLogStore()
  const profileStore = createMemoryProfileStore()
  const profileAllowedOrigins = new Set<string>([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://desk.bookdeskops.com",
    ...(process.env.SPORTSDESK_ALLOWED_ORIGINS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []),
  ])
  const profileApi = profileRoutes(
    profileStore,
    {
      allowedOrigins: profileAllowedOrigins,
      allowSameOrigin: true,
      verifyCsrfToken: (sid, token) => {
        const expected = httpAuth.getSessionCsrfToken(sid)
        return expected !== null && constantTimeEqual(token, expected)
      },
    },
    {
      resolveSessionId: (req) => {
        const auth = httpAuth.authenticateHeaders(req.headers, "GET")
        if (!auth.authenticated) return null
        return auth.sessionId ?? null
      },
    },
  )
  const jsonReader = createCachedJsonReader(24)
  const { findCustomerRow } = createCustomerRowFinder<Record<string, unknown>>({
    cwd: CWD,
  })
  const markdownCache = new DashboardMarkdownCache(resolve(CWD, "dashboard.md"))

  const loadCohortProfileRecords = async (): Promise<ProfileInspectRecord[]> => {
    const [backtestCached, fixtureCached, localBookCached] = await Promise.all([
      jsonReader.readCachedJson<{
        customerLeaderboard?: Array<Record<string, unknown>>
      }>(resolve(CWD, "docs/backtest-4wk-cfb-nba.json")),
      jsonReader.readCachedJson<Array<Record<string, unknown>>>(
        resolve(CWD, "tests/fixtures/backtest/enriched_customers_full.json"),
      ),
      jsonReader.readCachedJson<Array<Record<string, unknown>>>(
        resolve(CWD, "enriched_customers_full.json"),
      ),
    ])

    const byId = new Map<string, ProfileInspectRecord>()
    const addRawRows = (rows: readonly Record<string, unknown>[] | undefined, source: string) => {
      if (!rows) return
      for (const row of rows) {
        const rec = normalizeRawCustomerToProfileRecord({ ...row, source })
        if (rec.id && rec.id !== "UNKNOWN" && !byId.has(rec.id)) {
          byId.set(rec.id, rec)
        }
      }
    }

    addRawRows(localBookCached?.value, "book")
    addRawRows(backtestCached?.value?.customerLeaderboard, "backtest")
    addRawRows(fixtureCached?.value, "fixture")
    return Array.from(byId.values())
  }

  const egressOrigins = loadValidatedEgressOrigins(process.env)

  const r2PipelineService = createR2PipelineService({
    daemon4020Origin: egressOrigins.API_ORIGIN.origin,
    publicBase: egressOrigins.R2_PUBLIC_ORIGIN.origin,
    getAutomationsSnapshot: () => buildNodeAutomationsSnapshot(),
  })

  const wagerCandidates = [
    ...(process.env.SPORTSDESK_LIVE_WAGERS_JSON
      ? [resolve(CWD, process.env.SPORTSDESK_LIVE_WAGERS_JSON)]
      : []),
    resolve(CWD, "data/live-wagers.json"),
    resolve(CWD, "tests/fixtures/live-wagers-LIST-100.json"),
    resolve(CWD, "tests/fixtures/live-wagers-list-sample.json"),
  ]

  const { buildLiveWagersPayload } = createDevLiveWagersLoader({
    cwd: CWD,
    candidatePaths: wagerCandidates,
    inspectRawRows: (rows) =>
      inspectWagersWireContract(rows, undefined, {
        skipRow: (row) => isSentinelTickerWriter(row.TicketWriter),
      }),
    describeSlab: () => ({
      schema: SLAB_SERVER.meta.schema,
      version: SLAB_SERVER.meta.version,
      window_bytes: SLAB_SERVER.capacity.ticker_window_bytes,
      unsafe_allowed: SLAB_SERVER.unsafe.allowed,
      sentinels: SLAB_SERVER.sentinels,
    }),
    loadSharpDeps: async () => ({
      parseShortDesc,
      sharpCustomerIds: new Set(["JAKE231", "SHARP99", "MIKE882", "PRO402", "VEX77"]),
    }),
  })

  const betTickerService = createBetTickerService({
    cwd: CWD,
    parseShortDesc,
    getSharpCustomerIds: async () => new Set(["JAKE231", "SHARP99", "MIKE882", "PRO402", "VEX77"]),
    getBridge3aSnapshot: () => r2PipelineService.getLatestBetTickerBridge3a(),
  })

  const agentDetailService = createAgentDetailService({
    cwd: CWD,
    getConduits: async () => {
      const data = await runBatchedRanking({ limitPlayers: 50 })
      return data.topSubAgents.map((agent) => ({
        agentId: agent.agentId,
        masterAgent: agent.masterAgent,
        handleUsd: agent.totalHandleUsd,
        wagers: agent.totalWagers,
        customers: agent.customerCount,
        topCustomer: agent.topCustomer,
        concentrationPct: agent.topCustomerConcentrationPct,
        isProxyConduit: agent.isProxyConduit,
      }))
    },
    getRecentWagers: async () => {
      const payload = await buildLiveWagersPayload()
      return payload.wagers as unknown as ReadonlyArray<Record<string, unknown>>
    },
  })

  const healthTracker = new DashboardHealthTracker({
    isDbConfigured: () => false,
    probeDb: async () => {
      // MOCKED in-memory per AI Studio Web constraints
    },
    cleanupSessions: () => httpAuth.cleanupSessions(),
    getAlertMetrics: () => alertStore.getHealthMetrics(),
    getPort: () => PORT,
  })

  let cachedBuildMatrix: Awaited<ReturnType<typeof getNodeBuildMatrix>> | null = null

  const api = createDashboardApi<NodeWsAdapter>(
    {
      enforceAuth: (req) => httpAuth.enforceAuth(req),
      enforceAdminAuth: (req) => httpAuth.enforceAdminAuth(req),
      validateTerminalCommand,
      auth: httpAuth.auth,
      getHealthPayload: () => healthTracker.sample(),
      getPublicHealthPayload: () => healthTracker.samplePublic(),
      loadDashboardMarkdown: () => markdownCache.load(),
      dns: {
        getTelemetryPayload: () => getDnsTelemetryPayload(),
        benchmark: (host) => benchmarkNodeDns(host),
        classifyIp: (ip) => classifyIpAddressNode(ip),
      },
      customers: {
        getCohortReport: async () => {
          const [backtestCached, fixtureCached, localBookCached] = await Promise.all([
            jsonReader.readCachedJson<{
              customerLeaderboard?: Array<Record<string, unknown>>
            }>(resolve(CWD, "docs/backtest-4wk-cfb-nba.json")),
            jsonReader.readCachedJson<Array<Record<string, unknown>>>(
              resolve(CWD, "tests/fixtures/backtest/enriched_customers_full.json"),
            ),
            jsonReader.readCachedJson<Array<Record<string, unknown>>>(
              resolve(CWD, "enriched_customers_full.json"),
            ),
          ])
          const payload = computeCustomersCohortPayload({
            backtestLeaderboard: backtestCached?.value?.customerLeaderboard ?? [],
            fixtures: fixtureCached?.value ?? [],
            localBookRows: localBookCached?.value,
            keyNumberBuyerIds: ["JAKE231", "SHARP99", "MIKE882"],
            hookSyndicateIds: ["JAKE231", "PRO402"],
          })
          return {
            versionStamp: `node-customers|${backtestCached?.stamp ?? "none"}|${fixtureCached?.stamp ?? "none"}`,
            payload,
          }
        },
        getProfile: async (id) => {
          const row = await findCustomerRow(id)
          if (!row) return null
          return buildCustomerProfileFromRow(row, id)
        },
        getRating: async (id) => {
          const row = await findCustomerRow(id)
          if (!row) return null
          return buildCustomerRatingFromRow(row, id)
        },
      },
      resolveTerminalProfile: (req) => {
        const auth = httpAuth.authenticateHeaders(req.headers, "GET")
        if (!auth.authenticated || !auth.sessionId) return undefined
        return profileOrDefault(profileStore, auth.sessionId).theme
      },
      execTerminal: (command, dims) => {
        auditConfig({
          action: "terminal_exec",
          details: { command: command.slice(0, 128) },
        })
        return executeNodeTerminalQuery(
          command,
          {
            findCustomerRow,
            listProfileRecords: loadCohortProfileRecords,
            getTiersConfig: () => loadTomlConfig(),
            getLiveWagers: async () =>
              (await buildLiveWagersPayload()) as unknown as Record<string, unknown>,
            getAlertRecords: () => alertStore.list("all"),
            queryWebLogs: (opts) => weblogStore.query(opts),
            getRankings: () => runBatchedRanking({ limitPlayers: 50 }),
            getMarkdownSource: async () => (await markdownCache.load())?.markdown ?? null,
            getWsClientCount: () => wsClients.size,
            onCommand: () => alertStore.recordTerminalCommand(),
          },
          dims,
        )
      },
      rankings: {
        getAll: async (limit) => {
          const data = await runBatchedRanking({ limitPlayers: limit })
          return {
            generatedAtIso: data.generatedAtIso,
            payload: data,
          }
        },
        getConduits: async () => {
          const data = await runBatchedRanking({ limitPlayers: 50 })
          return data.topSubAgents.filter((s) => s.isProxyConduit)
        },
      },
      getLiveWagersPayload: () => buildLiveWagersPayload(),
      getWagersTabPolicy: () => loadWagersTabPolicyStamp(),
      getBetTickerPayload: (filters) => betTickerService.getPayload(filters),
      getR2PipelinePayload: (opts) => r2PipelineService.probeAll(opts),
      getR2PipelineHistoryPayload: (opts) => r2PipelineService.getHistory(opts),
      getR2ImageProvenancePayload: async ({ key }) =>
        await probeR2ImageProvenance({
          key,
          bucketPublicBase: DEFAULT_R2_PUBLIC_BASE,
        }),
      getDaemonStatusPayload: () => r2PipelineService.probeDaemon(),
      getAutomationsPayload: () => buildNodeAutomationsSnapshot(),
      runGsliveTicketVerify: (opts) => runNodeTicketVerification(opts?.dryRun ?? true),
      getAgentDetailPayload: (agentId) => agentDetailService.getAgentDetail(agentId),
      getTiersConfig: () => loadTomlConfig(),
      alerts: {
        sweepOnce: () => alertStore.sweepOnce(),
        list: (status) => alertStore.list(status),
        ack: (input) => alertStore.ack(input),
        retry: (input) => alertStore.retry(input),
        getShiftSummary: (operatorId) => alertStore.getShiftSummary(operatorId),
      },
      getTaxonomyCatalog: () => SUBSPORT_TAXONOMY_CATALOG,
      runShadowPricing: (params) => runNodeShadowPricingDashboard(params),
      forceShadowFixture: true,
      getBuildMatrix: async (force = false) => {
        if (force || cachedBuildMatrix === null) {
          cachedBuildMatrix = await getNodeBuildMatrix(CWD)
        }
        return cachedBuildMatrix
      },
    },
    { clients: wsClients },
  )

  // ── Centralized Fail-Closed Auth Gate for ALL /api/* routes (F1, F2, F3) ──
  // Only the explicit public allowlist (GET /api/health, GET /api/auth/me,
  // POST /api/auth/login, POST /api/auth/logout) bypasses authentication.
  app.use("/api", (req, res, next) => {
    const fullPath = req.baseUrl + req.path
    if (isPublicApiRoute(fullPath, req.method)) {
      next()
      return
    }
    void requireExpressAuth(req, res, next)
  })

  // ── Host-specific diagnostic & static JSON endpoints ──
  app.get("/api/health", async (req, res) => {
    const webReq = new Request(`http://127.0.0.1:${PORT}/api/health`, {
      method: req.method,
    })
    await sendWebResponse(res, await api.fetch(webReq))
  })

  // ── Profile Theme & ANSI Markdown Preview Routes (Session + CSRF/Origin Guarded) ──
  app.get("/api/profile", async (req, res) => {
    const webReq = await toWebRequest(req)
    await sendWebResponse(res, profileApi["/api/profile"].GET(webReq))
  })

  app.post("/api/profile/theme", async (req, res) => {
    const webReq = await toWebRequest(req)
    await sendWebResponse(res, await profileApi["/api/profile/theme"].POST(webReq))
  })

  app.get("/api/profile/render.md", async (req, res) => {
    const webReq = await toWebRequest(req)
    await sendWebResponse(res, profileApi["/api/profile/render.md"].GET(webReq))
  })

  app.get("/api/diagnostics/image-assets", async (req, res) => {
    const refresh = req.query.refresh === "1" || req.query.refresh === "true"
    const root =
      typeof req.query.root === "string" && req.query.root.trim().length > 0
        ? req.query.root.trim()
        : undefined
    res.json(await scanBunImageAssets(CWD, { refresh, root }))
  })

  app.get("/api/diagnostics/image-assets/raw", async (req, res) => {
    const source = typeof req.query.source === "string" ? req.query.source.trim() : ""
    if (!source) {
      return res.status(400).json({ error: "Missing source query parameter" })
    }
    const asset = await readRawAssetFile(CWD, source)
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" })
    }
    res.setHeader("Content-Type", asset.mimeType)
    res.setHeader("Cache-Control", "no-store")
    return res.send(asset.bytes)
  })

  app.post("/api/diagnostics/image-assets/transform", requireExpressAdminAuth, async (req, res) => {
    try {
      const body = (req.body ?? {}) as Partial<BunImageTransformRequest>
      if (typeof body.source !== "string" || !body.source.trim()) {
        return res.status(400).json({ ok: false, error: "Missing source asset path" })
      }
      if (typeof body.format !== "string" || !body.format.trim()) {
        return res.status(400).json({ ok: false, error: "Missing target format" })
      }
      const result = await transformBunImageAsset(CWD, body as BunImageTransformRequest)
      return res.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return res.status(400).json({ ok: false, error: message })
    }
  })

  app.get("/api/agent-tree", async (_req, res) => {
    const p = resolve(CWD, "data/agent-tree.json")
    if (!existsSync(p)) return res.status(404).json({ error: "agent-tree.json not found" })
    res.type("application/json").send(await readFile(p, "utf8"))
  })

  app.get("/api/live-bets", async (_req, res) => {
    const p = resolve(CWD, "data/live-bets.json")
    if (!existsSync(p)) {
      return res.json({
        games: [],
        pendingCount: 0,
        note: "No live-bets.json capture present",
      })
    }
    res.type("application/json").send(await readFile(p, "utf8"))
  })

  app.get("/api/status", (_req, res) => {
    res.json({
      ok: true,
      daemon4020Online: false,
      authRequired: httpAuth.isAuthRequired(),
      authConfigured: httpAuth.isConfigured(),
      adminConfigured: httpAuth.isAdminConfigured(),
    })
  })

  app.get("/api/graph/live-feed", async (_req, res) => {
    const p = resolve(CWD, "docs/graph-live-feed.json")
    if (!existsSync(p)) return res.status(404).json({ error: "graph-live-feed.json not found" })
    res.type("application/json").send(await readFile(p, "utf8"))
  })

  app.get("/api/combo/uniqueness", async (_req, res) => {
    const p = resolve(CWD, "docs/combo-uniqueness.json")
    if (!existsSync(p)) return res.status(404).json({ error: "combo-uniqueness.json not found" })
    res.type("application/json").send(await readFile(p, "utf8"))
  })

  app.get("/api/bridge/value", async (_req, res) => {
    const p = resolve(CWD, "docs/cross-domain-bridge.json")
    if (!existsSync(p)) return res.status(404).json({ error: "cross-domain-bridge.json not found" })
    res.type("application/json").send(await readFile(p, "utf8"))
  })

  app.get("/api/weblogs", (req, res) => {
    const allowedSort = new Set<WebLogSortField>([
      "time",
      "severity",
      "ip",
      "ipCategory",
      "ipFamily",
      "account",
      "gameId",
      "botKey",
      "event",
      "period",
      "market",
      "pick",
      "kind",
      "cadence",
      "score",
    ])
    const rawSort = String(req.query.sort ?? "time") as WebLogSortField
    const sort: WebLogSortField = allowedSort.has(rawSort) ? rawSort : "time"
    const dir: WebLogSortDir = req.query.dir === "asc" ? "asc" : "desc"
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined
    const limit =
      rawLimit !== undefined && Number.isInteger(rawLimit) && rawLimit >= 1
        ? Math.min(200, rawLimit)
        : undefined
    const rawOffset = typeof req.query.offset === "string" ? Number(req.query.offset) : undefined
    const offset =
      rawOffset !== undefined && Number.isInteger(rawOffset) && rawOffset >= 0
        ? rawOffset
        : undefined
    const { options: inspectOptions, showOptions } = parseInspectOptionsFromQuery(
      req.query as Record<string, unknown>,
    )

    const payload = weblogStore.query({
      sort,
      dir,
      ip: typeof req.query.ip === "string" ? req.query.ip : undefined,
      ipFamily: typeof req.query.ipFamily === "string" ? req.query.ipFamily : undefined,
      site: typeof req.query.site === "string" ? req.query.site : undefined,
      version: typeof req.query.version === "string" ? req.query.version : undefined,
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      market: typeof req.query.market === "string" ? req.query.market : undefined,
      account: typeof req.query.account === "string" ? req.query.account : undefined,
      severity: typeof req.query.severity === "string" ? req.query.severity : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      limit,
      offset,
      ...inspectOptions,
      showOptions,
    })
    res.setHeader("Cache-Control", "no-store")
    res.json(payload)
  })

  app.post("/api/weblogs/ingest", (req, res) => {
    const rawText = extractWebLogIngestRawText(req.body)
    if (!rawText.trim()) {
      return res.status(400).json({
        error: 'Provide non-empty rawText or Fantasy402 AccessLog JSON ({ "LIST": [...] }).',
      })
    }
    const { ingestedCount, result } = weblogStore.ingest(rawText)
    res.setHeader("Cache-Control", "no-store")
    return res.json({ ingestedCount, ...result })
  })

  app.post("/api/weblogs/reset", requireExpressAdminAuth, (_req, res) => {
    res.setHeader("Cache-Control", "no-store")
    res.json(weblogStore.reset())
  })

  const bunR2ClientConfig = loadR2ClientConfiguration()

  app.get(R2_CLIENT_INSPECT_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "no-store")
    return res.json(getBunS3Capabilities(bunR2ClientConfig))
  })

  app.get("/api/r2/client/list", requireExpressAdminAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    if (bunR2ClientConfig.state !== "configured") {
      return res.status(503).json({
        error: "ERR_R2_CLIENT_UNAVAILABLE",
        clientState: bunR2ClientConfig.state,
      })
    }
    const prefix = typeof req.query.prefix === "string" ? req.query.prefix.trim() : ""
    if (!isR2ObjectPrefix(prefix)) {
      return res.status(400).json({
        error: "ERR_S3_INVALID_PREFIX",
        message: "Invalid R2 object prefix.",
      })
    }
    const maxKeysRaw = typeof req.query.maxKeys === "string" ? Number(req.query.maxKeys) : 50
    const maxKeys = Number.isInteger(maxKeysRaw) && maxKeysRaw >= 1 ? Math.min(200, maxKeysRaw) : 50
    const delimiter =
      typeof req.query.delimiter === "string" && req.query.delimiter.length > 0
        ? req.query.delimiter
        : undefined
    const startAfter =
      typeof req.query.startAfter === "string" && req.query.startAfter.trim().length > 0
        ? req.query.startAfter.trim()
        : undefined
    const continuationToken =
      typeof req.query.continuationToken === "string" &&
      req.query.continuationToken.trim().length > 0
        ? req.query.continuationToken.trim()
        : undefined

    try {
      const listing = await withInspectRole("ROLE_OPS_ADMIN", () =>
        bunR2ClientConfig.handle.listObjects({
          prefix,
          maxKeys,
          delimiter,
          startAfter,
          continuationToken,
        }),
      )
      return res.json(listing)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return res.status(502).json({ error: "ERR_S3_LIST_FAILED", message })
    }
  })

  app.get("/api/r2/client/stat", requireExpressAdminAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    if (bunR2ClientConfig.state !== "configured") {
      return res.status(503).json({
        error: "ERR_R2_CLIENT_UNAVAILABLE",
        clientState: bunR2ClientConfig.state,
      })
    }
    const key = typeof req.query.key === "string" ? req.query.key.trim() : ""
    if (!isR2ObjectProbeKey(key)) {
      return res.status(400).json({
        error: "ERR_S3_INVALID_KEY",
        message: "Valid object key query parameter is required.",
      })
    }
    const requestPayer = req.query.requestPayer === "1"
    const stats = await withInspectRole("ROLE_OPS_ADMIN", () =>
      bunR2ClientConfig.handle.statObject(key, { requestPayer }),
    )
    return res.status(stats.state === "not-found" ? 404 : 200).json(stats)
  })

  app.post("/api/weblogs/archive-s3", requireExpressAdminAuth, async (req, res) => {
    res.setHeader("Cache-Control", "no-store")
    if (bunR2ClientConfig.state !== "configured") {
      return res.status(503).json({
        error: "ERR_R2_CLIENT_UNAVAILABLE",
        clientState: bunR2ClientConfig.state,
        message:
          "R2 S3 client is not configured (set R2_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).",
      })
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const rawStorageClass = body.storageClass ?? "STANDARD_IA"
    if (!isAllowedS3StorageClass(rawStorageClass)) {
      return res.status(400).json({
        error: "ERR_S3_INVALID_STORAGE_CLASS",
        message: "Unsupported S3 storageClass value.",
      })
    }
    const prefix =
      typeof body.prefix === "string" && body.prefix.trim()
        ? body.prefix.trim()
        : "weblogs/archives"
    const maxEntries =
      typeof body.maxEntries === "number" &&
      Number.isInteger(body.maxEntries) &&
      body.maxEntries >= 1
        ? Math.min(2_000, body.maxEntries)
        : 500

    const queryPayload = weblogStore.query({
      severity: typeof body.severity === "string" ? body.severity : undefined,
      account: typeof body.account === "string" ? body.account : undefined,
      q: typeof body.q === "string" ? body.q : undefined,
      limit: maxEntries,
    })

    try {
      const archived = await withInspectRole("ROLE_OPS_ADMIN", () =>
        archiveWebLogsToR2(bunR2ClientConfig, queryPayload, {
          storageClass: rawStorageClass,
          prefix,
          maxEntries,
        }),
      )
      return res.json(archived)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return res.status(502).json({ error: "ERR_S3_ARCHIVE_FAILED", message })
    }
  })

  const allowedProfileSorts = new Set<ProfileInspectSortField>([
    "score",
    "id",
    "var95Usd",
    "holdPct",
    "gini",
    "limit",
    "meanStake",
    "syndicateProb",
  ])

  app.get("/api/profiles/inspect", async (req, res) => {
    try {
      const allProfiles = await loadCohortProfileRecords()
      const tierFilter =
        typeof req.query.tier === "string" ? req.query.tier.trim().toUpperCase() : ""
      const qFilter = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : ""
      const selectedId =
        typeof req.query.id === "string" && req.query.id.trim().length > 0
          ? req.query.id.trim().toUpperCase()
          : null
      const rawSort = String(req.query.sort ?? "score") as ProfileInspectSortField
      const sort: ProfileInspectSortField = allowedProfileSorts.has(rawSort) ? rawSort : "score"
      const dir: "asc" | "desc" = req.query.dir === "asc" ? "asc" : "desc"
      const { options: inspectOptions, showOptions } = parseInspectOptionsFromQuery(
        req.query as Record<string, unknown>,
      )

      const filtered = allProfiles.filter((p) => {
        if (tierFilter && tierFilter !== "ALL" && !p.tier.toUpperCase().includes(tierFilter)) {
          return false
        }
        if (qFilter) {
          const hay =
            `${p.id} ${p.name} ${p.agentId} ${p.tier} ${p.specialization} ${p.ipAddress}`.toLowerCase()
          if (!hay.includes(qFilter)) return false
        }
        return true
      })

      const activeFilters = [
        tierFilter && tierFilter !== "ALL" ? `tier=${tierFilter}` : null,
        qFilter ? `q="${qFilter}"` : null,
      ].filter((x): x is string => x !== null)

      const payload = formatProfileInspectPayload({
        profiles: filtered,
        selectedId,
        totalCount: allProfiles.length,
        sort,
        dir,
        activeFilters,
        options: inspectOptions,
        showOptions,
      })
      res.setHeader("Cache-Control", "no-store")
      return res.json(payload)
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to inspect profiles",
      })
    }
  })

  app.post("/api/profiles/inspect", async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        profiles?: Array<Record<string, unknown>>
        selectedId?: string | null
        totalCount?: number
        sort?: string
        dir?: string
        activeFilters?: string[]
        options?: BunInspectOptions
        showOptions?: boolean
      }
      const rawProfiles =
        Array.isArray(body.profiles) && body.profiles.length > 0
          ? body.profiles.map((row) => normalizeRawCustomerToProfileRecord(row))
          : await loadCohortProfileRecords()

      const rawSort = String(body.sort ?? "score") as ProfileInspectSortField
      const sort: ProfileInspectSortField = allowedProfileSorts.has(rawSort) ? rawSort : "score"
      const dir: "asc" | "desc" = body.dir === "asc" ? "asc" : "desc"
      const { options: queryOptions, showOptions: queryShowOptions } = parseInspectOptionsFromQuery(
        req.query as Record<string, unknown>,
      )
      const mergedOptions: BunInspectOptions = {
        ...queryOptions,
        ...(body.options ?? {}),
      }

      const payload = formatProfileInspectPayload({
        profiles: rawProfiles,
        selectedId: body.selectedId ?? null,
        totalCount: typeof body.totalCount === "number" ? body.totalCount : rawProfiles.length,
        sort,
        dir,
        activeFilters: Array.isArray(body.activeFilters) ? body.activeFilters : undefined,
        options: mergedOptions,
        showOptions: Boolean(body.showOptions ?? queryShowOptions),
      })
      res.setHeader("Cache-Control", "no-store")
      return res.json(payload)
    } catch (err) {
      return res.status(500).json({
        error: err instanceof Error ? err.message : "Failed to inspect profiles",
      })
    }
  })

  // ── Core Dashboard API Router (`/health`, `/api/*`, `/mcp`) ──
  app.all(["/health", "/mcp", "/api", "/api/*"], async (req, res) => {
    try {
      const webReq = await toWebRequest(req)
      const webRes = await api.fetch(webReq)
      await sendWebResponse(res, webRes)
    } catch (err) {
      console.error("[SportsDesk API Error]", err)
      res.status(500).json({
        error: err instanceof Error ? err.message : "Internal Server Error",
      })
    }
  })

  // ── Agent HTML Inspector Route (Authenticated, Nonced, No-Store, No-ETag) ──
  app.get("/agent/:id", requireExpressAuth, async (req, res) => {
    const detail = await agentDetailService.getAgentDetail(req.params.id)
    const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      ?.trim()
      .toLowerCase()
    sendNoncedHtmlShell(res, {
      html: renderAgentHtmlPage(detail),
      isProd: IS_PROD,
      isHttps: req.secure || forwardedProto === "https",
    })
  })

  // ── Contained Static & Docs Asset Serving ──
  const serveContainedDir = (mountPrefix: string, dirPath: string, requireAuth: boolean) => {
    const handlers: express.RequestHandler[] = [
      ...(requireAuth ? [requireExpressAuth] : []),
      async (req, res) => {
        const rel = req.path.slice(mountPrefix.length + 1)
        const safePath = containedAssetPath(dirPath, rel)
        if (!safePath || !existsSync(safePath)) {
          return res.status(404).send("Not Found")
        }
        const mime = MIME_BY_EXT[extname(safePath).toLowerCase()] ?? "application/octet-stream"
        res.type(mime).send(await readFile(safePath))
      },
    ]
    app.get(`${mountPrefix}/*`, ...handlers)
  }
  serveContainedDir("/static", resolve(CWD, "static"), false)
  serveContainedDir("/docs", resolve(CWD, "docs"), true)

  // ── Frontend SPA (Nonced HTML Shell + Immutable Hashed Assets in Prod, Lazy Vite in Dev) ──
  const distDir = resolve(CWD, "dist")
  const distIndexPath = resolve(distDir, "index.html")
  if (IS_PROD && existsSync(distIndexPath)) {
    const distIndexTemplate = await readFile(distIndexPath, "utf8")
    const distAssetsDir = resolve(distDir, "assets")
    if (existsSync(distAssetsDir)) {
      app.use(
        "/assets",
        express.static(distAssetsDir, {
          etag: false,
          immutable: true,
          maxAge: "1y",
          setHeaders: (res) => {
            res.setHeader("Cache-Control", HASHED_ASSET_CACHE_CONTROL)
          },
        }),
      )
    }
    // Never auto-serve dist/index.html via express.static (would attach ETag & skip per-request nonce)
    app.use(express.static(distDir, { index: false }))
    app.get("*", (req, res) => {
      const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
        .split(",")[0]
        ?.trim()
        .toLowerCase()
      sendNoncedHtmlShell(res, {
        html: distIndexTemplate,
        isProd: true,
        isHttps: req.secure || forwardedProto === "https",
      })
    })
  } else {
    const { createServer: createViteServer } = await import("vite")
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        host: HOST,
        port: PORT,
        hmr: false,
      },
      appType: "spa",
    })
    app.use(vite.middlewares)
  }

  // ── Multiplexed HTTP + WebSocket Server on Port 3000 ──
  const httpServer = createServer(app)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 })

  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`).pathname
    if (pathname === "/ws") {
      const wsAuth = httpAuth.verifyWebSocketUpgrade(req)
      if (!wsAuth.authenticated) {
        const statusLine =
          wsAuth.status === 503
            ? "503 Service Unavailable"
            : wsAuth.status === 403
              ? "403 Forbidden"
              : "401 Unauthorized"
        socket.write(
          `HTTP/1.1 ${statusLine}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n${JSON.stringify({ error: wsAuth.error, code: wsAuth.code })}`,
        )
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req)
      })
    } else {
      socket.destroy()
    }
  })

  wss.on("connection", (ws) => {
    const adapter = new NodeWsAdapter(ws)
    api.websocket.open(adapter)
    ws.on("message", (data) => {
      const payload =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer)
      const text = typeof payload === "string" ? payload : payload.toString("utf8")
      if (text.includes('"ping"')) {
        try {
          const parsed = JSON.parse(text) as {
            action?: unknown
            type?: unknown
            sentAt?: unknown
          }
          if (parsed.action === "ping" || parsed.type === "ping") {
            if (ws.readyState === ws.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "pong",
                  sentAt: typeof parsed.sentAt === "number" ? parsed.sentAt : null,
                  serverTs: Date.now(),
                }),
              )
            }
            return
          }
        } catch {
          // fall through to standard topic handler
        }
      }
      api.websocket.message(adapter, payload)
    })
    ws.on("close", () => {
      api.websocket.close(adapter)
    })
  })

  let retriedFallbackPort = false
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && !retriedFallbackPort && PORT !== FALLBACK_APP_PORT) {
      retriedFallbackPort = true
      console.warn(
        `[SportsDesk] Port ${PORT} already in use (in-container proxy); retrying on ${FALLBACK_APP_PORT}`,
      )
      PORT = FALLBACK_APP_PORT
      httpServer.listen(PORT, HOST)
      return
    }
    console.error("[SportsDesk] Fatal HTTP server error:", err)
    process.exit(1)
  })

  httpServer.on("listening", () => {
    const addr = httpServer.address()
    if (addr && typeof addr === "object") {
      PORT = addr.port
    }
    const authMode = !httpAuth.isAuthRequired()
      ? "DISABLED (explicit dev/test opt-out)"
      : httpAuth.isConfigured()
        ? `ENFORCED (session+CSRF / Bearer · admin-exec=${httpAuth.isAdminConfigured() ? "configured" : "locked"})`
        : "ENFORCED — FAIL-CLOSED (no token configured; set SPORTSDESK_DASHBOARD_TOKEN or SPORTSDESK_ADMIN_TOKEN)"
    const uiMode = IS_PROD && HAS_DIST_BUILD ? "static dist/" : "Vite dev middleware"
    const hasTls = Boolean(
      process.env.SPORTSDESK_TLS_CERT_PATH && process.env.SPORTSDESK_TLS_KEY_PATH,
    )
    const serverBaseUrl = `${hasTls ? "https" : "http"}://${HOST}:${PORT}`
    console.log(`\n⚡ SportsDesk Ops Enhanced Surveillance Dashboard running on ${serverBaseUrl}`)
    console.log(`   ➜ Runtime:   Node.js ${process.version} (Express + ${uiMode} + ws)`)
    console.log(`   ➜ Auth Gate: ${authMode}`)
    console.log(`   ➜ Health:    ${serverBaseUrl}/health`)
    console.log(`   ➜ WebSocket: ${deriveWebSocketUrl(serverBaseUrl, "/ws")}\n`)
  })

  const shutdown = () => {
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.once("SIGTERM", shutdown)
  process.once("SIGINT", shutdown)

  httpServer.listen(PORT, HOST)
}

startServer().catch((err) => {
  console.error("Failed to start SportsDesk server:", err)
  process.exit(1)
})
