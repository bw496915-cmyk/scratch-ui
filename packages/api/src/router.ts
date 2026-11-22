/**
 * @file packages/api/src/router.ts
 * @description Injectable dashboard HTTP API router + in-memory `fetch()` dispatcher for zero-port testing & `Bun.serve({ routes })`.
 */

import {
  parseFiniteNumber,
  parseRepriceMode,
  parseRouterAuditMode,
} from "../../backend/src/index.ts"
import {
  type DashboardWsTopic,
  type MarketFilter,
  type PeriodFilter,
  type RegimeFilter,
  type RouterAuditMode,
  type ShadowRepriceMode,
  type SportFilter,
  type SubSportFilter,
} from "../../contracts/src/index.ts"
import { DnsBoundaryError } from "../../../src/lib/dns_boundary.ts"
import {
  resolveProfileTerminalOptions,
  validateTerminalCommand as defaultValidateTerminalCommand,
} from "../../../src/lib/shell_boundary.ts"
import type { DashboardApiDeps, EncodedResponseSpec, RouteRequestWithParams } from "./types.ts"
import {
  DASHBOARD_ROUTES,
  extractRawRouteParam,
  safeDecodeRouteParam,
  type TypedRouteRequest,
} from "./bun_routes.ts"
import { createConfigStatusStore } from "./config_status.ts"
import {
  createShiftSessionLogStore,
  isShiftSessionAction,
  parseShiftSinceMs,
  sanitizeShiftLogText,
} from "./shift_logs.ts"
import { createDashboardWebSocketHandler, publishDashboardTopicEvent, type WsLike } from "./ws.ts"

export const AGENT_DETAIL_ROUTE = DASHBOARD_ROUTES.agentById
export const AGENT_DETAILS_ROUTE = DASHBOARD_ROUTES.agentsById
export type AgentDetailRoute = typeof AGENT_DETAIL_ROUTE | typeof AGENT_DETAILS_ROUTE

export function matchAgentDetailRoute(
  pathname: string,
): { readonly route: AgentDetailRoute; readonly encodedId: string } | null {
  const match = /^\/api\/(agents?)\/([^/]+)$/.exec(pathname)
  if (!match?.[1] || !match[2]) return null
  return {
    route: match[1] === "agents" ? AGENT_DETAILS_ROUTE : AGENT_DETAIL_ROUTE,
    encodedId: match[2],
  }
}

export function decodeAgentRouteId(encodedId: string): string | null {
  const decoded = safeDecodeRouteParam(encodedId)
  return decoded.ok ? decoded.value : null
}

export function invalidAgentRouteIdResponse(error = "Invalid agent route parameter"): Response {
  return Response.json(
    { error, code: "INVALID_ROUTE_PARAM" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  )
}

type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS"

export type RouteHandler<TReq extends Request = Request> = (
  req: TReq,
) => Response | Promise<Response>

export type SessionAuthHook = (req: Request) => Promise<Response | null> | Response | null

type SimpleMethodHandlers = {
  readonly [M in HttpMethod]?: RouteHandler<Request>
}

type IdParamMethodHandlers = {
  readonly [M in HttpMethod]?: RouteHandler<RouteRequestWithParams<{ readonly id: string }>>
}

function buildFailClosedUnauthorizedResponse(
  message = "Authentication required (auth hook not configured)",
): Response {
  return Response.json(
    { error: message, code: "UNAUTHENTICATED" },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="sportsdesk-ops"',
      },
    },
  )
}

/**
 * Route middleware enforcing an authenticated session (cookie + CSRF or Bearer
 * token via `enforceAuth`) prior to executing a route handler.
 *
 * Fails closed with HTTP `401 Unauthorized` whenever `enforceAuth` is missing,
 * non-callable, or throws — never permitting anonymous access.
 */
export function requireSession<TReq extends Request = Request>(
  enforceAuth: SessionAuthHook | undefined,
  handler: RouteHandler<TReq>,
): RouteHandler<TReq> {
  return async (req: TReq): Promise<Response> => {
    if (typeof enforceAuth !== "function") {
      return buildFailClosedUnauthorizedResponse()
    }
    try {
      const denied = await enforceAuth(req)
      if (denied) return denied
    } catch {
      return buildFailClosedUnauthorizedResponse("Authentication required (auth hook error)")
    }
    return handler(req)
  }
}

export interface AdminGuardOptions {
  /** Optional environment override (defaults to `process.env`). */
  readonly env?: Record<string, string | undefined> | undefined
}

function isExplicitDevAdminBypass(env: Record<string, string | undefined>): boolean {
  const nodeEnv = env.NODE_ENV
  return (nodeEnv === "development" || nodeEnv === "test") && env.SPORTSDESK_AUTH_DISABLED === "1"
}

function isExplicitDevServerSessionAdminAllowed(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "development" && env.SPORTSDESK_DEV_SERVER === "1"
}

function buildAdminForbiddenResponse(
  error: string,
  code: "ADMIN_REQUIRED" | "ADMIN_TOKEN_REQUIRED",
): Response {
  return Response.json(
    { error, code },
    {
      status: 403,
      headers: { "Cache-Control": "no-store" },
    },
  )
}

/**
 * Route middleware enforcing `x-admin-token` verification prior to executing
 * privileged handlers (such as `POST /api/terminal/exec`).
 *
 * Fails closed with HTTP `403 Forbidden`:
 * - Blocks any request lacking a non-empty `x-admin-token` header in production
 *   (and in all non-dev-bypassed environments, except an already-verified Dev Admin
 *   session on the local dev server when no separate `SPORTSDESK_ADMIN_TOKEN` is set).
 * - Delegates cryptographic verification of `x-admin-token` to `enforceAdminAuth`,
 *   denying with `403` whenever `enforceAdminAuth` is missing, non-callable, or throws.
 */
export function adminGuard<TReq extends Request = Request>(
  enforceAdminAuth: SessionAuthHook | undefined,
  handler: RouteHandler<TReq>,
  options: AdminGuardOptions = {},
): RouteHandler<TReq> {
  return async (req: TReq): Promise<Response> => {
    const env = options.env ?? (typeof process !== "undefined" ? process.env : {})
    const isProduction = env.NODE_ENV === "production"
    const devBypass = !isProduction && isExplicitDevAdminBypass(env)
    const devServerSessionAllowed = !isProduction && isExplicitDevServerSessionAdminAllowed(env)
    const adminTokenHeader = req.headers.get("x-admin-token")?.trim() ?? ""

    if (typeof enforceAdminAuth !== "function") {
      if (!devBypass && !adminTokenHeader) {
        return buildAdminForbiddenResponse(
          "Missing required x-admin-token header",
          "ADMIN_TOKEN_REQUIRED",
        )
      }
      return buildAdminForbiddenResponse("Admin execution gate not configured", "ADMIN_REQUIRED")
    }

    try {
      const denied = await enforceAdminAuth(req)
      if (denied) return denied
    } catch {
      return buildAdminForbiddenResponse("Admin verification failed", "ADMIN_REQUIRED")
    }

    // Defense-in-depth: in production (or whenever auth is not explicitly dev-disabled
    // and not an already-verified Dev Admin session on an unconfigured local dev server),
    // never allow execution if the `x-admin-token` header is absent.
    if (!devBypass && !devServerSessionAllowed && !adminTokenHeader) {
      return buildAdminForbiddenResponse(
        "Missing required x-admin-token header",
        "ADMIN_TOKEN_REQUIRED",
      )
    }

    return handler(req)
  }
}

/**
 * Wrap every HTTP method handler in a route family map with `requireSession`.
 */
function protectRouteFamily<
  TReq extends Request,
  THandlers extends { readonly [M in HttpMethod]?: RouteHandler<TReq> },
  TTable extends Record<string, THandlers>,
>(enforceAuth: SessionAuthHook | undefined, table: TTable): TTable {
  const guarded: Record<string, Record<string, RouteHandler<TReq>>> = {}
  for (const [routePath, methodMap] of Object.entries(table)) {
    const wrappedMethods: Record<string, RouteHandler<TReq>> = {}
    for (const [method, handler] of Object.entries(methodMap)) {
      if (typeof handler === "function") {
        wrappedMethods[method] = requireSession(enforceAuth, handler as RouteHandler<TReq>)
      }
    }
    guarded[routePath] = wrappedMethods
  }
  return guarded as TTable
}

interface BunRuntimeProbe {
  readonly version?: string
  readonly nanoseconds?: () => number
}

function getBunRuntimeProbe(): BunRuntimeProbe | undefined {
  const candidate = (globalThis as unknown as { Bun?: BunRuntimeProbe }).Bun
  return candidate && typeof candidate === "object" ? candidate : undefined
}

function resolveRuntimeEngineHeader(): string {
  const bunGlobal = getBunRuntimeProbe()
  if (bunGlobal && typeof bunGlobal.version === "string") {
    return `bun/${bunGlobal.version}`
  }
  if (typeof process !== "undefined" && process.versions?.node) {
    return `node/${process.versions.node}`
  }
  return "web-runtime"
}

function startApiTimer(): { readonly ns: number | null; readonly ms: number } {
  const bunGlobal = getBunRuntimeProbe()
  if (bunGlobal && typeof bunGlobal.nanoseconds === "function") {
    return { ns: bunGlobal.nanoseconds(), ms: performance.now() }
  }
  return { ns: null, ms: performance.now() }
}

function finishApiTimerMs(started: { readonly ns: number | null; readonly ms: number }): string {
  const bunGlobal = getBunRuntimeProbe()
  if (started.ns !== null && bunGlobal && typeof bunGlobal.nanoseconds === "function") {
    const deltaMs = Math.max(0, (bunGlobal.nanoseconds() - started.ns) / 1e6)
    return deltaMs.toFixed(2)
  }
  return Math.max(0, performance.now() - started.ms).toFixed(2)
}

function buildAlignedApiHeaders(
  req: Request,
  options: {
    readonly endpoint: string
    readonly tab?: string | undefined
    readonly timer?: { readonly ns: number | null; readonly ms: number } | undefined
    readonly extra?: Record<string, string> | undefined
  },
): Record<string, string> {
  const requestId =
    req.headers.get("x-request-id")?.trim() ||
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`)
  const elapsedMs = options.timer ? finishApiTimerMs(options.timer) : null
  return {
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding, Authorization, Cookie, X-SportsDesk-Tab",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
    "X-SportsDesk-Endpoint": options.endpoint,
    ...(options.tab ? { "X-SportsDesk-Tab": options.tab } : {}),
    "X-Runtime-Engine": resolveRuntimeEngineHeader(),
    ...(elapsedMs !== null
      ? {
          "X-Response-Time-Ms": elapsedMs,
          "Server-Timing": `api;dur=${elapsedMs}`,
        }
      : {}),
    ...options.extra,
  }
}

function defaultEncodeResponse(_req: Request, spec: EncodedResponseSpec): Response {
  const bytes = spec.produce()
  const body = new Uint8Array(bytes.byteLength)
  body.set(bytes)
  return new Response(body, {
    headers: {
      "Content-Type": spec.contentType,
      "Cache-Control": "no-store",
      Vary: "Accept-Encoding, Authorization, Cookie, X-SportsDesk-Tab",
      "X-Content-Type-Options": "nosniff",
      ...spec.headers,
    },
  })
}

/**
 * Merge the wagers-tab policy stamp into a live-wagers payload.
 *
 * The stamp is read from `packages/ui/src/config/wagers.toml` at request time,
 * so `curl -s :4021/api/wagers | jq -r .policy_version` is a stable probe that
 * survives rebuilds (unlike a bundle content hash). A missing/invalid policy
 * file must not take the feed down: the payload is returned unstamped.
 */
async function withWagersTabPolicy(deps: DashboardApiDeps, payload: object): Promise<object> {
  const readPolicy = deps.getWagersTabPolicy
  if (!readPolicy) return payload
  try {
    const stamp = await readPolicy()
    return stamp ? { ...payload, ...stamp } : payload
  } catch (err) {
    console.warn(
      "[api] wagers tab policy stamp unavailable:",
      err instanceof Error ? err.message : err,
    )
    return payload
  }
}

/** A public R2 key that may carry image provenance: relative, no traversal, PNG/WebP. */
function isSafeImageProvenanceKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 512 &&
    !key.startsWith("/") &&
    !key.includes("\\") &&
    !key.includes("..") &&
    !key.includes("://") &&
    /\.(png|webp)$/i.test(key)
  )
}

function projectPublicHealth(payload: unknown): {
  readonly status: "ok" | "degraded"
  readonly version: string
} {
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  const status = obj.status === "degraded" ? "degraded" : "ok"
  const version =
    typeof obj.version === "string" && obj.version.trim().length > 0
      ? obj.version.trim()
      : "v1.01.23-next"
  return { status, version }
}

/**
 * Create the SportsDesk dashboard HTTP + WebSocket API surface.
 *
 * Exposes:
 * - `routes`: declarative route table ready to mount in `Bun.serve({ routes })`
 * - `fetch(req)`: zero-port in-memory request dispatcher for fast unit & contract tests
 * - `websocket` + `clients`: topic-based WebSocket handler
 */
export function createDashboardApi<TWs extends WsLike = WsLike>(
  deps: DashboardApiDeps,
  options: { readonly clients?: Set<TWs> | undefined } = {},
) {
  const clients = options.clients ?? new Set<TWs>()
  const { websocket, buildWsStatusPayload } = createDashboardWebSocketHandler(clients)
  const publishTopic = (topic: DashboardWsTopic, message: string): number =>
    publishDashboardTopicEvent(clients, topic, message)
  const emitAlertsUpdated = () => {
    publishTopic(
      "syndicate-alerts",
      JSON.stringify({
        type: "topic-event",
        topic: "syndicate-alerts",
        event: "alerts-updated",
        timestamp: new Date().toISOString(),
      }),
    )
  }

  // Explicit runtime auth hook passed into `requireSession` for every protected route family.
  // Any missing or undefined `deps.enforceAuth` fails closed with HTTP 401.
  const sessionAuthHook: SessionAuthHook | undefined = deps.enforceAuth
  const shiftLogStore = deps.shiftLogs ?? createShiftSessionLogStore()
  const configStatusStore = deps.configStatus ?? createConfigStatusStore({ env: deps.env })

  const handlePublicHealth = async (): Promise<Response> => {
    const raw = deps.getPublicHealthPayload
      ? await deps.getPublicHealthPayload()
      : await deps.getHealthPayload()
    return Response.json(projectPublicHealth(raw), {
      headers: { "Cache-Control": "no-store" },
    })
  }

  const handleMcp = async (req: Request): Promise<Response> => {
    if (!deps.handleMcp) {
      return req.method.toUpperCase() === "HEAD"
        ? new Response(null, { status: 404 })
        : Response.json({ error: "MCP endpoint not configured" }, { status: 404 })
    }
    return deps.handleMcp(req)
  }

  const encodeResponse = (
    req: Request,
    spec: EncodedResponseSpec,
  ): Response | Promise<Response> => {
    if (deps.encodeResponse) {
      return deps.encodeResponse(req, spec)
    }
    return defaultEncodeResponse(req, spec)
  }

  const textEncoder = new TextEncoder()

  /**
   * Explicit unauthenticated route allowlist (liveness probes + auth lifecycle only).
   */
  const publicStaticRoutes = {
    "/health": {
      GET: handlePublicHealth,
    },
    "/api/health": {
      GET: handlePublicHealth,
    },
    "/api/auth/login": {
      POST: async (req: Request): Promise<Response> => {
        const res = await deps.auth.login(req)
        if (res.ok) {
          let operatorId = "operator"
          let roleDetail = ""
          try {
            const payload = (await res.clone().json()) as {
              operatorId?: unknown
              role?: unknown
              session?: { operatorId?: unknown; role?: unknown } | undefined
            }
            const rawOp = payload?.operatorId ?? payload?.session?.operatorId
            if (typeof rawOp === "string") {
              operatorId = sanitizeShiftLogText(rawOp, 64, "operator")
            }
            const rawRole = payload?.role ?? payload?.session?.role
            if (typeof rawRole === "string") {
              const safeRole = sanitizeShiftLogText(rawRole, 32, "")
              if (safeRole) roleDetail = `Role: ${safeRole}`
            }
          } catch {
            // Non-JSON or empty login response body; keep fallback operatorId
          }
          shiftLogStore.record({
            action: "login",
            operatorId,
            summary: `Operator ${operatorId} signed in`,
            ...(roleDetail ? { detail: roleDetail } : {}),
            source: "server",
          })
        }
        return res
      },
    },
    "/api/auth/logout": {
      POST: async (req: Request): Promise<Response> => {
        const res = await deps.auth.logout(req)
        if (res.ok) {
          const headerOp = sanitizeShiftLogText(req.headers.get("x-operator-id"), 64, "operator")
          shiftLogStore.record({
            action: "logout",
            operatorId: headerOp,
            summary: `Operator ${headerOp} signed out`,
            source: "server",
          })
        }
        return res
      },
    },
    "/api/auth/me": {
      GET: (req: Request) => deps.auth.me(req),
    },
  } satisfies Record<string, SimpleMethodHandlers>

  /**
   * All protected static API & MCP route families, uniformly wrapped in `requireSession`.
   */
  const protectedStaticRoutes = protectRouteFamily<
    Request,
    SimpleMethodHandlers,
    Record<string, SimpleMethodHandlers>
  >(sessionAuthHook, {
    "/api/auth/fast-signin": {
      GET: async (req: Request): Promise<Response> =>
        deps.auth.fastSignInList
          ? deps.auth.fastSignInList(req)
          : Response.json(
              { ok: false, error: "Fast Sign-In management unavailable" },
              { status: 501, headers: { "Cache-Control": "no-store" } },
            ),
      POST: async (req: Request): Promise<Response> =>
        deps.auth.fastSignInCreate
          ? deps.auth.fastSignInCreate(req)
          : Response.json(
              { ok: false, error: "Fast Sign-In management unavailable" },
              { status: 501, headers: { "Cache-Control": "no-store" } },
            ),
      DELETE: async (req: Request): Promise<Response> =>
        deps.auth.fastSignInRevoke
          ? deps.auth.fastSignInRevoke(req)
          : Response.json(
              { ok: false, error: "Fast Sign-In management unavailable" },
              { status: 501, headers: { "Cache-Control": "no-store" } },
            ),
    },

    "/api/health/detail": {
      GET: async (): Promise<Response> => {
        return Response.json(await deps.getHealthPayload(), {
          headers: { "Cache-Control": "no-store" },
        })
      },
    },

    "/mcp": {
      GET: handleMcp,
      HEAD: handleMcp,
      POST: handleMcp,
      PUT: handleMcp,
      PATCH: handleMcp,
      DELETE: handleMcp,
      OPTIONS: async (req: Request) => {
        return deps.handleMcp ? deps.handleMcp(req) : new Response(null, { status: 204 })
      },
    },

    "/api/surveillance/brief": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        const rendered = await deps.loadDashboardMarkdown()
        if (rendered === null) {
          return Response.json(
            { error: "dashboard.md not found", code: "BRIEF_NOT_FOUND" },
            {
              status: 404,
              headers: buildAlignedApiHeaders(req, {
                endpoint: "/api/surveillance/brief",
                tab: "surveillance",
                timer,
              }),
            },
          )
        }

        const payload = {
          markdown: rendered.markdown,
          html: rendered.html,
          ...(rendered.renderDurationMs !== undefined
            ? { renderDurationMs: rendered.renderDurationMs }
            : {}),
          ...(rendered.markdownBytes !== undefined
            ? { markdownBytes: rendered.markdownBytes }
            : {}),
          ...(rendered.htmlBytes !== undefined ? { htmlBytes: rendered.htmlBytes } : {}),
          ...(rendered.nonAsciiChars !== undefined
            ? { nonAsciiChars: rendered.nonAsciiChars }
            : {}),
          updatedAt: new Date().toISOString(),
        }
        return encodeResponse(req, {
          version: `dev-dashboard-md|${rendered.stamp}`,
          contentType: "application/json; charset=utf-8",
          produce: () => textEncoder.encode(JSON.stringify(payload)),
          headers: buildAlignedApiHeaders(req, {
            endpoint: "/api/surveillance/brief",
            tab: "surveillance",
            timer,
          }),
        })
      },
    },

    "/api/dashboard": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        const rendered = await deps.loadDashboardMarkdown()
        if (rendered === null) {
          return Response.json(
            { error: "dashboard.md not found", code: "BRIEF_NOT_FOUND" },
            {
              status: 404,
              headers: buildAlignedApiHeaders(req, {
                endpoint: "/api/surveillance/brief",
                tab: "surveillance",
                timer,
              }),
            },
          )
        }

        const payload = {
          markdown: rendered.markdown,
          html: rendered.html,
          ...(rendered.renderDurationMs !== undefined
            ? { renderDurationMs: rendered.renderDurationMs }
            : {}),
          ...(rendered.markdownBytes !== undefined
            ? { markdownBytes: rendered.markdownBytes }
            : {}),
          ...(rendered.htmlBytes !== undefined ? { htmlBytes: rendered.htmlBytes } : {}),
          ...(rendered.nonAsciiChars !== undefined
            ? { nonAsciiChars: rendered.nonAsciiChars }
            : {}),
          updatedAt: new Date().toISOString(),
        }
        return encodeResponse(req, {
          version: `dev-dashboard-md|${rendered.stamp}`,
          contentType: "application/json; charset=utf-8",
          produce: () => textEncoder.encode(JSON.stringify(payload)),
          headers: buildAlignedApiHeaders(req, {
            endpoint: "/api/surveillance/brief",
            tab: "surveillance",
            timer,
          }),
        })
      },
    },

    "/api/surveillance/dns": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        return Response.json(deps.dns.getTelemetryPayload(), {
          headers: buildAlignedApiHeaders(req, {
            endpoint: "/api/surveillance/dns",
            tab: "surveillance",
            timer,
          }),
        })
      },
    },
    "/api/dns": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        return Response.json(deps.dns.getTelemetryPayload(), {
          headers: buildAlignedApiHeaders(req, {
            endpoint: "/api/surveillance/dns",
            tab: "surveillance",
            timer,
          }),
        })
      },
    },
    "/api/dns/telemetry": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        return Response.json(deps.dns.getTelemetryPayload(), {
          headers: buildAlignedApiHeaders(req, {
            endpoint: "/api/surveillance/dns",
            tab: "surveillance",
            timer,
          }),
        })
      },
    },
    "/api/surveillance/dns/benchmark": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        const reqUrl = new URL(req.url)
        const host = reqUrl.searchParams.get("host")?.trim() || "fantasy402.com"
        try {
          return Response.json(await deps.dns.benchmark(host), {
            headers: buildAlignedApiHeaders(req, {
              endpoint: "/api/surveillance/dns/benchmark",
              tab: "surveillance",
              timer,
            }),
          })
        } catch (err) {
          if (err instanceof DnsBoundaryError) {
            return Response.json(
              { error: err.message, code: err.code },
              {
                status: 400,
                headers: buildAlignedApiHeaders(req, {
                  endpoint: "/api/surveillance/dns/benchmark",
                  tab: "surveillance",
                  timer,
                }),
              },
            )
          }
          throw err
        }
      },
    },
    "/api/dns/benchmark": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        const reqUrl = new URL(req.url)
        const host = reqUrl.searchParams.get("host")?.trim() || "fantasy402.com"
        try {
          return Response.json(await deps.dns.benchmark(host), {
            headers: buildAlignedApiHeaders(req, {
              endpoint: "/api/surveillance/dns/benchmark",
              tab: "surveillance",
              timer,
            }),
          })
        } catch (err) {
          if (err instanceof DnsBoundaryError) {
            return Response.json(
              { error: err.message, code: err.code },
              {
                status: 400,
                headers: buildAlignedApiHeaders(req, {
                  endpoint: "/api/surveillance/dns/benchmark",
                  tab: "surveillance",
                  timer,
                }),
              },
            )
          }
          throw err
        }
      },
    },
    "/api/surveillance/dns/reverse": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        const reqUrl = new URL(req.url)
        const ip = reqUrl.searchParams.get("ip")?.trim() || "1.1.1.1"
        try {
          return Response.json(await deps.dns.classifyIp(ip), {
            headers: buildAlignedApiHeaders(req, {
              endpoint: "/api/surveillance/dns/reverse",
              tab: "surveillance",
              timer,
            }),
          })
        } catch (err) {
          if (err instanceof DnsBoundaryError) {
            return Response.json(
              { error: err.message, code: err.code },
              {
                status: 400,
                headers: buildAlignedApiHeaders(req, {
                  endpoint: "/api/surveillance/dns/reverse",
                  tab: "surveillance",
                  timer,
                }),
              },
            )
          }
          throw err
        }
      },
    },
    "/api/dns/reverse": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        const reqUrl = new URL(req.url)
        const ip = reqUrl.searchParams.get("ip")?.trim() || "1.1.1.1"
        try {
          return Response.json(await deps.dns.classifyIp(ip), {
            headers: buildAlignedApiHeaders(req, {
              endpoint: "/api/surveillance/dns/reverse",
              tab: "surveillance",
              timer,
            }),
          })
        } catch (err) {
          if (err instanceof DnsBoundaryError) {
            return Response.json(
              { error: err.message, code: err.code },
              {
                status: 400,
                headers: buildAlignedApiHeaders(req, {
                  endpoint: "/api/surveillance/dns/reverse",
                  tab: "surveillance",
                  timer,
                }),
              },
            )
          }
          throw err
        }
      },
    },

    "/api/customers": {
      GET: async (req: Request): Promise<Response> => {
        const report = await deps.customers.getCohortReport()
        return encodeResponse(req, {
          version: report.versionStamp,
          contentType: "application/json; charset=utf-8",
          produce: () => textEncoder.encode(JSON.stringify(report.payload)),
        })
      },
    },

    "/api/customer/profile": {
      GET: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        const id = (url.searchParams.get("id") ?? "").trim()
        if (!id) {
          return Response.json(
            { success: false, error: "Missing required parameter 'id'" },
            { status: 400 },
          )
        }
        const profile = await deps.customers.getProfile(id)
        if (!profile) {
          return Response.json(
            { success: false, error: `Customer '${id}' not found` },
            { status: 404 },
          )
        }
        return Response.json(
          {
            success: true,
            profile,
            generatedAt: new Date().toISOString(),
          },
          { headers: { "Cache-Control": "no-store" } },
        )
      },
    },

    "/api/customer/rating": {
      GET: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        const id = (url.searchParams.get("id") ?? "").trim()
        if (!id) {
          return Response.json(
            { success: false, error: "Missing required parameter 'id'" },
            { status: 400 },
          )
        }
        const rating = await deps.customers.getRating(id)
        if (!rating) {
          return Response.json(
            { success: false, error: `Customer '${id}' not found` },
            { status: 404 },
          )
        }
        return Response.json(
          {
            success: true,
            rating,
            generatedAt: new Date().toISOString(),
          },
          { headers: { "Cache-Control": "no-store" } },
        )
      },
    },

    "/api/terminal/exec": {
      POST: adminGuard(
        deps.enforceAdminAuth,
        async (req: Request): Promise<Response> => {
          try {
            const body = (await req.json()) as {
              command?: unknown
              cols?: number
              rows?: number
            }
            const validate = deps.validateTerminalCommand ?? defaultValidateTerminalCommand
            const validation = validate(body.command ?? "help")
            if (!validation.ok) {
              return Response.json(
                { error: validation.error, code: "TERMINAL_COMMAND_REJECTED" },
                { status: 400, headers: { "Cache-Control": "no-store" } },
              )
            }
            const profileTheme = deps.resolveTerminalProfile?.(req)
            const bounded = resolveProfileTerminalOptions(profileTheme, {
              cols: typeof body.cols === "number" ? body.cols : undefined,
              rows: typeof body.rows === "number" ? body.rows : undefined,
            })
            const result = await deps.execTerminal(
              validation.command,
              {
                cols: bounded.cols,
                rows: bounded.rows,
                ...(profileTheme ? { profileTheme } : {}),
              },
              req,
            )
            return Response.json(result, {
              headers: { "Cache-Control": "no-store" },
            })
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : String(err) },
              { status: 500, headers: { "Cache-Control": "no-store" } },
            )
          }
        },
        { env: deps.env },
      ),
    },

    "/api/rankings/all": {
      GET: async (req: Request): Promise<Response> => {
        try {
          const url = new URL(req.url)
          const limit = Number(url.searchParams.get("limit")) || 100
          const { generatedAtIso, payload } = await deps.rankings.getAll(limit)
          return await encodeResponse(req, {
            version: `dev-rankings|${generatedAtIso}|${limit}`,
            contentType: "application/json; charset=utf-8",
            produce: () => textEncoder.encode(JSON.stringify(payload)),
          })
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },

    "/api/agency/conduits": {
      GET: async (): Promise<Response> => {
        try {
          const conduits = await deps.rankings.getConduits()
          return Response.json({ conduits })
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },

    "/api/wagers": {
      GET: async (): Promise<Response> => {
        return Response.json(await withWagersTabPolicy(deps, await deps.getLiveWagersPayload()))
      },
    },
    "/api/live-wagers": {
      GET: async (): Promise<Response> => {
        return Response.json(await withWagersTabPolicy(deps, await deps.getLiveWagersPayload()))
      },
    },

    "/api/config/tiers": {
      GET: async (): Promise<Response> => {
        try {
          return Response.json(await deps.getTiersConfig())
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },

    "/api/alerts/sweep": {
      POST: async (req: Request): Promise<Response> => {
        if (!deps.alerts) {
          return Response.json({ error: "Alerts service unavailable" }, { status: 503 })
        }
        const sweep = await deps.alerts.sweepOnce()
        const op = sanitizeShiftLogText(req.headers.get("x-operator-id"), 64, "operator")
        const sweepRecord =
          sweep && typeof sweep === "object"
            ? (sweep as { sent?: unknown; failed?: unknown; dead?: unknown })
            : null
        const sent = typeof sweepRecord?.sent === "number" ? sweepRecord.sent : 0
        const failed = typeof sweepRecord?.failed === "number" ? sweepRecord.failed : 0
        const dead = typeof sweepRecord?.dead === "number" ? sweepRecord.dead : 0
        shiftLogStore.record({
          action: "alert_sweep",
          operatorId: op,
          summary: `Alert queue swept (${sent} sent, ${failed} failed, ${dead} dead)`,
          source: "server",
        })
        emitAlertsUpdated()
        return Response.json({ ok: true, sweep })
      },
    },

    "/api/alerts": {
      GET: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        const statusParam = (url.searchParams.get("status") ?? "all").toLowerCase()
        const alerts = deps.alerts ? deps.alerts.list(statusParam) : []
        return Response.json({
          alerts,
          total: alerts.length,
          status: statusParam,
          timestamp: new Date().toISOString(),
        })
      },
    },

    "/api/shift/summary": {
      GET: async (req: Request): Promise<Response> => {
        if (!deps.alerts) {
          return Response.json({ error: "Alerts service unavailable" }, { status: 503 })
        }
        const url = new URL(req.url)
        const operatorId = url.searchParams.get("operatorId") ?? "operator"
        return Response.json(deps.alerts.getShiftSummary(operatorId))
      },
    },

    "/api/shift/logs": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        const url = new URL(req.url)
        const sinceMs = parseShiftSinceMs(url.searchParams.get("since"))
        const operatorIdParam = url.searchParams.get("operatorId") ?? undefined
        const actionParam = url.searchParams.get("action")
        if (actionParam && !isShiftSessionAction(actionParam)) {
          return Response.json(
            {
              error: "Invalid shift session log action filter",
              code: "INVALID_ACTION",
            },
            {
              status: 400,
              headers: buildAlignedApiHeaders(req, {
                endpoint: "/api/shift/logs",
                tab: "alerts",
                timer,
              }),
            },
          )
        }
        const limitRaw = url.searchParams.get("limit")
        const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined
        const payload = shiftLogStore.list({
          operatorId: operatorIdParam,
          sinceMs,
          action: actionParam && isShiftSessionAction(actionParam) ? actionParam : undefined,
          limit:
            parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
        })
        return Response.json(payload, {
          headers: buildAlignedApiHeaders(req, {
            endpoint: "/api/shift/logs",
            tab: "alerts",
            timer,
          }),
        })
      },
      POST: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        let body: Record<string, unknown>
        try {
          const parsed = (await req.json()) as unknown
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return Response.json(
              {
                error: "Shift session log payload must be a JSON object",
                code: "INVALID_JSON",
              },
              {
                status: 400,
                headers: buildAlignedApiHeaders(req, {
                  endpoint: "/api/shift/logs",
                  tab: "alerts",
                  timer,
                }),
              },
            )
          }
          body = parsed as Record<string, unknown>
        } catch {
          return Response.json(
            { error: "Invalid JSON payload", code: "INVALID_JSON" },
            {
              status: 400,
              headers: buildAlignedApiHeaders(req, {
                endpoint: "/api/shift/logs",
                tab: "alerts",
                timer,
              }),
            },
          )
        }

        if (!isShiftSessionAction(body.action)) {
          return Response.json(
            {
              error: "Unsupported or missing shift session log action",
              code: "INVALID_ACTION",
            },
            {
              status: 400,
              headers: buildAlignedApiHeaders(req, {
                endpoint: "/api/shift/logs",
                tab: "alerts",
                timer,
              }),
            },
          )
        }

        const entry = shiftLogStore.record({
          action: body.action,
          operatorId: typeof body.operatorId === "string" ? body.operatorId : undefined,
          summary: typeof body.summary === "string" ? body.summary : "",
          detail: typeof body.detail === "string" ? body.detail : undefined,
          targetId: typeof body.targetId === "string" ? body.targetId : undefined,
          timestamp:
            typeof body.timestamp === "string" || typeof body.timestamp === "number"
              ? body.timestamp
              : undefined,
          source: "client",
        })

        return Response.json(
          { ok: true, entry },
          {
            status: 201,
            headers: buildAlignedApiHeaders(req, {
              endpoint: "/api/shift/logs",
              tab: "alerts",
              timer,
            }),
          },
        )
      },
    },

    "/api/config/status": {
      GET: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        return Response.json(configStatusStore.getSnapshot(), {
          headers: buildAlignedApiHeaders(req, {
            endpoint: "/api/config/status",
            tab: "status-dashboard",
            timer,
          }),
        })
      },
      POST: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        let body: Record<string, unknown>
        try {
          const parsed = (await req.json()) as unknown
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return Response.json(
              {
                ok: false,
                code: "INVALID_JSON",
                error: "Configuration payload must be a JSON object",
              },
              {
                status: 400,
                headers: buildAlignedApiHeaders(req, {
                  endpoint: "/api/config/status",
                  tab: "status-dashboard",
                  timer,
                }),
              },
            )
          }
          body = parsed as Record<string, unknown>
        } catch {
          return Response.json(
            {
              ok: false,
              code: "INVALID_JSON",
              error: "Invalid JSON payload",
            },
            {
              status: 400,
              headers: buildAlignedApiHeaders(req, {
                endpoint: "/api/config/status",
                tab: "status-dashboard",
                timer,
              }),
            },
          )
        }

        const rawOverrides = body.overrides
        if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) {
          return Response.json(
            {
              ok: false,
              code: "INVALID_JSON",
              error: "Expected an `overrides` object mapping key -> value",
            },
            {
              status: 400,
              headers: buildAlignedApiHeaders(req, {
                endpoint: "/api/config/status",
                tab: "status-dashboard",
                timer,
              }),
            },
          )
        }

        const result = configStatusStore.saveOverrides(rawOverrides as Record<string, unknown>)
        if (!result.ok) {
          return Response.json(result, {
            status: 400,
            headers: buildAlignedApiHeaders(req, {
              endpoint: "/api/config/status",
              tab: "status-dashboard",
              timer,
            }),
          })
        }

        return Response.json(result, {
          status: 200,
          headers: buildAlignedApiHeaders(req, {
            endpoint: "/api/config/status",
            tab: "status-dashboard",
            timer,
          }),
        })
      },
      DELETE: async (req: Request): Promise<Response> => {
        const timer = startApiTimer()
        const url = new URL(req.url)
        const keyParam = url.searchParams.get("key")?.trim()
        let keys: string[] | undefined = keyParam ? [keyParam] : undefined
        if (!keys) {
          try {
            const parsed = (await req.json()) as { keys?: unknown }
            if (Array.isArray(parsed?.keys)) {
              keys = parsed.keys.filter((k): k is string => typeof k === "string")
            }
          } catch {
            // Optional JSON body; omit to reset all saved overrides
          }
        }
        const snapshot = configStatusStore.resetOverrides(keys)
        return Response.json(
          { ok: true, snapshot },
          {
            headers: buildAlignedApiHeaders(req, {
              endpoint: "/api/config/status",
              tab: "status-dashboard",
              timer,
            }),
          },
        )
      },
    },

    "/api/taxonomy-catalog": {
      GET: async (): Promise<Response> => {
        return Response.json({
          schemaVersion: 1,
          catalog: deps.getTaxonomyCatalog(),
        })
      },
    },

    "/api/shadow-pricing": {
      GET: async (req: Request): Promise<Response> => {
        try {
          if (!deps.runShadowPricing) {
            return Response.json({ error: "Shadow pricing service unavailable" }, { status: 503 })
          }
          const url = new URL(req.url)
          const forceFixture =
            deps.forceShadowFixture === true || url.searchParams.get("source") === "fixture"
          const sportParam = url.searchParams.get("sport")
          const subSportParam = url.searchParams.get("subSport")
          const periodParam = url.searchParams.get("period")
          const marketParam = url.searchParams.get("market")
          const regimeParam = url.searchParams.get("regime")
          const payload = await deps.runShadowPricing({
            dbPath: deps.shadowDbPath,
            forceFixture,
            ladderKey3: parseFiniteNumber(url.searchParams.get("ladder3")),
            ladderKey7: parseFiniteNumber(url.searchParams.get("ladder7")),
            ladderKey14_21: parseFiniteNumber(url.searchParams.get("ladderOther")),
            minVolume: parseFiniteNumber(url.searchParams.get("minVolume")),
            retailElasticity: parseFiniteNumber(url.searchParams.get("elasticity")),
            repriceMode: parseRepriceMode(url.searchParams.get("mode")),
            sport: (sportParam ?? undefined) as SportFilter | undefined,
            subSport: (subSportParam ?? undefined) as SubSportFilter | undefined,
            period: (periodParam ?? undefined) as PeriodFilter | undefined,
            market: (marketParam ?? undefined) as MarketFilter | undefined,
            regime: (regimeParam ?? undefined) as RegimeFilter | undefined,
            routerAuditMode: parseRouterAuditMode(url.searchParams.get("routerAudit")),
          })
          return Response.json(payload)
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
      POST: async (req: Request): Promise<Response> => {
        try {
          if (!deps.runShadowPricing) {
            return Response.json({ error: "Shadow pricing service unavailable" }, { status: 503 })
          }
          const body = (await req.json()) as {
            ladderKey3?: number
            ladderKey7?: number
            ladderKey14_21?: number
            minVolume?: number
            retailElasticity?: number
            repriceMode?: ShadowRepriceMode
            sport?: SportFilter
            subSport?: SubSportFilter
            period?: PeriodFilter
            market?: MarketFilter
            regime?: RegimeFilter
            routerAuditMode?: RouterAuditMode
            source?: string
          }
          const forceFixture = deps.forceShadowFixture === true || body.source === "fixture"
          const payload = await deps.runShadowPricing({
            dbPath: deps.shadowDbPath,
            forceFixture,
            ladderKey3: body.ladderKey3,
            ladderKey7: body.ladderKey7,
            ladderKey14_21: body.ladderKey14_21,
            minVolume: body.minVolume,
            retailElasticity: body.retailElasticity,
            repriceMode: parseRepriceMode(body.repriceMode),
            sport: body.sport,
            subSport: body.subSport,
            period: body.period,
            market: body.market,
            regime: body.regime,
            routerAuditMode: parseRouterAuditMode(body.routerAuditMode),
          })
          return Response.json(payload)
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 400 },
          )
        }
      },
    },

    "/api/build-matrix": {
      GET: async (req: Request): Promise<Response> => {
        try {
          const refresh = new URL(req.url).searchParams.get("refresh") === "1"
          const probe = await deps.getBuildMatrix(refresh)
          return Response.json({
            schemaVersion: 1,
            targets: probe.targets,
            generatedAt: probe.generatedAt,
            ...(probe.staticDir !== undefined ? { staticDir: probe.staticDir } : {}),
          })
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },

    "/api/ws/status": {
      GET: async (): Promise<Response> => {
        return Response.json(buildWsStatusPayload())
      },
    },

    "/api/bet-ticker": {
      GET: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        const writer = url.searchParams.get("writer") ?? undefined
        const wagerType =
          url.searchParams.get("type") ?? url.searchParams.get("wagerType") ?? undefined
        if (!deps.getBetTickerPayload) {
          const observedAt = new Date().toISOString()
          return Response.json({
            schemaVersion: 1,
            observedAt,
            autoExecute: false,
            provenance: {
              kind: "unavailable",
              label: "Bet-Ticker loader not configured",
              sourcePath: null,
              observedAt,
            },
            localFeed: {
              rawRowCount: 0,
              actionableTicketCount: 0,
              sentinelNoiseCount: 0,
              totalWageredCents: 0,
              totalVolumeCents: 0,
              totalToWinCents: 0,
              volumeDiffersCount: 0,
              vipCount: 0,
              liveCount: 0,
              flagCount: 0,
              byRule: {},
              byWriter: [],
              byWagerType: [],
              tickets: [],
            },
            bridge3aR2: {
              available: false,
              publicUrl: "",
              state: "error",
              lastModified: null,
              ageSeconds: null,
              generatedAt: null,
              deskDate: null,
              deskHour: null,
              watermark: null,
              rowCount: 0,
              ticketCount: 0,
              legCount: 0,
              alertTwinCount: 0,
              orphanCount: 0,
              byChannel: {},
              byWagerType: {},
            },
            pendingGames: {
              available: false,
              gameCount: 0,
              pendingCount: 0,
              totalWageredCents: 0,
              totalToWinCents: 0,
              capturedAt: null,
              dataSource: null,
              sourcePath: null,
            },
            captureHealth: {
              available: false,
              status: null,
              capturedAt: null,
              ageSeconds: null,
              rowCount: null,
              sourcePath: null,
            },
          })
        }
        return Response.json(await deps.getBetTickerPayload({ writer, wagerType }))
      },
    },

    "/api/r2/pipeline": {
      GET: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        const refresh = url.searchParams.get("refresh") === "1"
        if (!deps.getR2PipelinePayload) {
          const observedAt = new Date().toISOString()
          return Response.json({
            schemaVersion: 1,
            bucketPublicBase: "",
            observedAt,
            overallStatus: "degraded",
            freshCount: 0,
            totalCount: 0,
            staleKeys: [],
            dataStaleKeys: [],
            sinks: [],
            daemon4020: {
              online: false,
              url: "http://127.0.0.1:4020/health",
              status: null,
              latencyMs: null,
              checkedAt: observedAt,
              reason: "R2 pipeline probe not configured",
            },
          })
        }
        return Response.json(await deps.getR2PipelinePayload({ refresh }))
      },
    },

    "/api/r2/pipeline/history": {
      GET: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        const refresh = url.searchParams.get("refresh") === "1"
        const rawLimit = url.searchParams.get("limit")
        const parsedLimit = rawLimit === null ? Number.NaN : Number(rawLimit)
        const limit = Number.isFinite(parsedLimit)
          ? Math.min(200, Math.max(1, Math.floor(parsedLimit)))
          : undefined
        if (!deps.getR2PipelineHistoryPayload) {
          return Response.json({
            schemaVersion: 1,
            observedAt: new Date().toISOString(),
            source: "process-memory",
            sampledSince: null,
            minSampleIntervalSeconds: 0,
            sinks: [],
          })
        }
        return Response.json(
          await deps.getR2PipelineHistoryPayload({
            refresh,
            ...(limit === undefined ? {} : { limit }),
          }),
        )
      },
    },

    "/api/r2/image-provenance": {
      GET: async (req: Request): Promise<Response> => {
        const url = new URL(req.url)
        const key = (url.searchParams.get("key") ?? "").trim()
        if (!isSafeImageProvenanceKey(key)) {
          return Response.json(
            {
              error:
                "key must be a relative R2 PNG/WebP key (no scheme, no '..', .png/.webp suffix)",
            },
            { status: 400 },
          )
        }
        if (!deps.getR2ImageProvenancePayload) {
          return Response.json({
            schemaVersion: 1,
            key,
            publicUrl: "",
            fetchedBytes: 0,
            report: {
              available: false,
              format: null,
              width: null,
              height: null,
              byteLength: 0,
              channels: [],
              fields: { streamId: null, genU32: null, merkleRoot: null },
              raw: {},
              issues: ["provenance_probe_not_configured"],
            },
          })
        }
        try {
          return Response.json(await deps.getR2ImageProvenancePayload({ key }))
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 502 },
          )
        }
      },
    },

    "/api/daemon/status": {
      GET: async (): Promise<Response> => {
        if (!deps.getDaemonStatusPayload) {
          return Response.json({
            online: false,
            url: "http://127.0.0.1:4020/health",
            status: null,
            latencyMs: null,
            checkedAt: new Date().toISOString(),
            reason: "Daemon probe not configured",
          })
        }
        return Response.json(await deps.getDaemonStatusPayload())
      },
    },

    "/api/automations": {
      GET: async (): Promise<Response> => {
        if (!deps.getAutomationsPayload) {
          return Response.json({
            observedAt: new Date().toISOString(),
            bridgeRollupUpdatedAt: null,
            bridgeJobs: [],
            schedules: [],
            ticketVerification: null,
          })
        }
        return Response.json(await deps.getAutomationsPayload())
      },
    },

    "/api/gslive/verify-tickets": {
      POST: async (req: Request): Promise<Response> => {
        if (!deps.runGsliveTicketVerify) {
          return Response.json(
            { ok: false, error: "GSLive ticket verification not configured" },
            { status: 503 },
          )
        }
        let dryRun = true
        try {
          const body = (await req.json()) as { dryRun?: unknown }
          if (typeof body.dryRun === "boolean") {
            dryRun = body.dryRun
          }
        } catch {
          // signal-honesty: intentional-empty-json-body-allowed
        }
        const summary = await deps.runGsliveTicketVerify({ dryRun })
        publishTopic(
          "dashboard",
          JSON.stringify({
            type: "topic-event",
            topic: "dashboard",
            event: "automations-updated",
            timestamp: new Date().toISOString(),
          }),
        )
        return Response.json({ ok: true, summary })
      },
    },
  })

  const staticRoutes: Record<string, SimpleMethodHandlers> = {
    ...publicStaticRoutes,
    ...protectedStaticRoutes,
  }

  /**
   * All parameterized API route families, uniformly wrapped in `requireSession`.
   * Each handler single-decodes `req.params.id` via `safeDecodeRouteParam` so
   * Bun's native Zig radix-tree router (raw slice) and in-memory `fetch()`
   * behave identically without double-decoding or unhandled `URIError`s.
   */
  const paramRoutes = protectRouteFamily<
    RouteRequestWithParams<{ readonly id: string }>,
    IdParamMethodHandlers,
    Record<
      | typeof DASHBOARD_ROUTES.alertAck
      | typeof DASHBOARD_ROUTES.alertRetry
      | typeof DASHBOARD_ROUTES.agentById
      | typeof DASHBOARD_ROUTES.agentsById,
      IdParamMethodHandlers
    >
  >(sessionAuthHook, {
    [DASHBOARD_ROUTES.alertAck]: {
      POST: async (req: TypedRouteRequest<typeof DASHBOARD_ROUTES.alertAck>): Promise<Response> => {
        const rawId = extractRawRouteParam(req, /^\/api\/alerts\/([^/]+)\/ack$/, req.params.id)
        const decodedId = safeDecodeRouteParam(rawId)
        if (!decodedId.ok) {
          return Response.json(
            { error: decodedId.error, code: "INVALID_ROUTE_PARAM" },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          )
        }
        const deliveryId = decodedId.value
        let body: { operatorId?: string; notes?: string } = {}
        try {
          body = (await req.json()) as {
            operatorId?: string
            notes?: string
          }
        } catch {
          // signal-honesty: intentional-empty-json-body-allowed
        }
        if (!deps.alerts) {
          return Response.json({ error: "Alerts service unavailable" }, { status: 503 })
        }
        const ok = await deps.alerts.ack({
          deliveryId,
          operatorId: body.operatorId ?? "operator",
          notes: body.notes,
        })
        if (ok) {
          const op = sanitizeShiftLogText(body.operatorId, 64, "operator")
          const noteDetail = sanitizeShiftLogText(body.notes, 200, "")
          shiftLogStore.record({
            action: "alert_ack",
            operatorId: op,
            summary: `Acknowledged alert ${deliveryId.slice(0, 12)}`,
            ...(noteDetail ? { detail: noteDetail } : {}),
            targetId: deliveryId,
            source: "server",
          })
          emitAlertsUpdated()
        }
        return Response.json({ ok, deliveryId })
      },
    },

    [DASHBOARD_ROUTES.alertRetry]: {
      POST: async (
        req: TypedRouteRequest<typeof DASHBOARD_ROUTES.alertRetry>,
      ): Promise<Response> => {
        const rawId = extractRawRouteParam(req, /^\/api\/alerts\/([^/]+)\/retry$/, req.params.id)
        const decodedId = safeDecodeRouteParam(rawId)
        if (!decodedId.ok) {
          return Response.json(
            { error: decodedId.error, code: "INVALID_ROUTE_PARAM" },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          )
        }
        const deliveryId = decodedId.value
        let body: { operatorId?: string } = {}
        try {
          body = (await req.json()) as { operatorId?: string }
        } catch {
          // signal-honesty: intentional-empty-json-body-allowed
        }
        if (!deps.alerts) {
          return Response.json({ error: "Alerts service unavailable" }, { status: 503 })
        }
        const newDeliveryId = await deps.alerts.retry({
          deliveryId,
          operatorId: body.operatorId ?? "operator",
        })
        if (!newDeliveryId) {
          return Response.json({ error: "Alert not found in dead-letter state" }, { status: 404 })
        }
        const op = sanitizeShiftLogText(body.operatorId, 64, "operator")
        shiftLogStore.record({
          action: "alert_retry",
          operatorId: op,
          summary: `Replayed dead-letter alert ${deliveryId.slice(0, 12)}`,
          detail: `Replacement delivery: ${newDeliveryId.slice(0, 12)}`,
          targetId: deliveryId,
          source: "server",
        })
        emitAlertsUpdated()
        return Response.json({
          ok: true,
          originalDeliveryId: deliveryId,
          newDeliveryId,
        })
      },
    },

    [DASHBOARD_ROUTES.agentById]: {
      GET: async (req: TypedRouteRequest<typeof DASHBOARD_ROUTES.agentById>): Promise<Response> => {
        const rawId = extractRawRouteParam(req, /^\/api\/agent\/([^/]+)$/, req.params.id)
        const decodedId = safeDecodeRouteParam(rawId)
        if (!decodedId.ok) {
          return Response.json(
            { error: decodedId.error, code: "INVALID_ROUTE_PARAM" },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          )
        }
        const agentId = decodedId.value
        if (!deps.getAgentDetailPayload) {
          return Response.json({
            schemaVersion: 1,
            agentId: agentId.trim().toUpperCase(),
            found: false,
            masterAgent: null,
            level: null,
            agentType: null,
            childAgents: [],
            conduit30d: null,
            customers: [],
            recentWagers: [],
            observedAt: new Date().toISOString(),
            autoExecute: false,
          })
        }
        return Response.json(await deps.getAgentDetailPayload(agentId))
      },
    },

    [DASHBOARD_ROUTES.agentsById]: {
      GET: async (
        req: TypedRouteRequest<typeof DASHBOARD_ROUTES.agentsById>,
      ): Promise<Response> => {
        const rawId = extractRawRouteParam(req, /^\/api\/agents\/([^/]+)$/, req.params.id)
        const decodedId = safeDecodeRouteParam(rawId)
        if (!decodedId.ok) {
          return Response.json(
            { error: decodedId.error, code: "INVALID_ROUTE_PARAM" },
            { status: 400, headers: { "Cache-Control": "no-store" } },
          )
        }
        const agentId = decodedId.value
        if (!deps.getAgentDetailPayload) {
          return Response.json({
            schemaVersion: 1,
            agentId: agentId.trim().toUpperCase(),
            found: false,
            masterAgent: null,
            level: null,
            agentType: null,
            childAgents: [],
            conduit30d: null,
            customers: [],
            recentWagers: [],
            observedAt: new Date().toISOString(),
            autoExecute: false,
          })
        }
        return Response.json(await deps.getAgentDetailPayload(agentId))
      },
    },
  })

  const apiFallbackResponse = () =>
    Response.json({ error: "Dashboard API route not found" }, { status: 404 })

  const guardedApiFallback = requireSession(sessionAuthHook, () => apiFallbackResponse())

  const guardedMethodNotAllowed = requireSession(sessionAuthHook, () =>
    Response.json({ error: "Method Not Allowed" }, { status: 405 }),
  )

  const routes = {
    ...staticRoutes,
    ...paramRoutes,
    "/api/*": guardedApiFallback,
  }

  /** Dispatch a dashboard API/health `Request` completely in-memory with zero port bind. */
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const method = req.method.toUpperCase() as HttpMethod

    const exactPublic = (publicStaticRoutes as Record<string, SimpleMethodHandlers>)[url.pathname]
    if (exactPublic !== undefined) {
      const handler = exactPublic[method]
      if (!handler) {
        return Response.json({ error: "Method Not Allowed" }, { status: 405 })
      }
      return handler(req)
    }

    const exactProtected = protectedStaticRoutes[url.pathname]
    if (exactProtected !== undefined) {
      const handler = exactProtected[method]
      if (!handler) {
        return guardedMethodNotAllowed(req)
      }
      return handler(req)
    }

    const alertActionMatch = /^\/api\/alerts\/([^/]+)\/(ack|retry)$/.exec(url.pathname)
    if (alertActionMatch?.[1] && alertActionMatch[2]) {
      const routeKey =
        alertActionMatch[2] === "ack" ? DASHBOARD_ROUTES.alertAck : DASHBOARD_ROUTES.alertRetry
      const handlers = paramRoutes[routeKey]
      const handler = handlers[method]
      if (!handler) {
        return guardedMethodNotAllowed(req)
      }
      // Pass raw URL segment to match Bun.serve({ routes }) zero-copy slice behavior
      const reqWithParams = Object.assign(req, {
        params: { id: alertActionMatch[1] },
      }) as RouteRequestWithParams<{ readonly id: string }>
      return handler(reqWithParams)
    }

    const agentDetailMatch = /^\/api\/agents?\/([^/]+)$/.exec(url.pathname)
    if (agentDetailMatch?.[1]) {
      const routeKey = url.pathname.startsWith("/api/agents/")
        ? DASHBOARD_ROUTES.agentsById
        : DASHBOARD_ROUTES.agentById
      const handlers = paramRoutes[routeKey]
      const handler = handlers[method]
      if (!handler) {
        return guardedMethodNotAllowed(req)
      }
      // Pass raw URL segment to match Bun.serve({ routes }) zero-copy slice behavior
      const reqWithParams = Object.assign(req, {
        params: { id: agentDetailMatch[1] },
      }) as RouteRequestWithParams<{ readonly id: string }>
      return handler(reqWithParams)
    }

    if (url.pathname.startsWith("/api/")) {
      return guardedApiFallback(req)
    }

    return new Response("Not Found", { status: 404 })
  }

  return {
    routes,
    fetch,
    websocket,
    clients,
    publishTopic,
    shiftLogs: shiftLogStore,
    configStatus: configStatusStore,
  }
}
