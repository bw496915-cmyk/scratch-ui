import { randomBytes, timingSafeEqual } from "node:crypto"

import type { BunRequest } from "bun"

import {
  type AgentDetailApiResponse,
  API_TELEMETRY_INSPECT_PATH,
  API_TELEMETRY_PATH,
  type ApiTelemetryInspection,
  type ApiTelemetryRow,
  type ApiTelemetrySnapshot,
  formatApiTelemetryCookieAttributes,
  formatApiTelemetryLatencyBand,
  formatApiTelemetryParams,
  formatApiTelemetryProtocol,
} from "@sportsdesk-ops/contracts"

import { SESSION_COOKIE_NAME } from "../lib/http_auth.ts"
import {
  AGENT_DETAIL_ROUTE,
  AGENT_DETAILS_ROUTE,
  type AgentDetailRoute,
  decodeAgentRouteId,
  invalidAgentRouteIdResponse,
  matchAgentDetailRoute,
} from "../packages/api/src/router.ts"
import { PROFILE_ROUTE, PROFILE_THEME_ROUTE } from "../src/http/profile_routes.ts"
import type { ApiTelemetry } from "./api_telemetry.ts"
import {
  ANSI,
  type BunInspectOptions,
  DeskView,
  formatInspectNumber,
  inspectDeskValue,
  inspectTable,
  paint,
  parseInspectOptionsFromQuery,
  renderInspectOptionsBanner,
  resolveInspectOptions,
  stripAnsi,
} from "./desk_inspect.ts"

declare const Bun: Pick<typeof import("bun"), "inspect" | "serve">

export const AGENT_INSPECTOR_ROUTE = "/agent/:id"

export class ApiTelemetryView extends DeskView<ApiTelemetryRow> {
  constructor(
    private readonly snapshot: ApiTelemetrySnapshot,
    private readonly inspectOptions: BunInspectOptions = {},
  ) {
    super(snapshot.rows)
  }

  render(options?: BunInspectOptions): string {
    const opts = resolveInspectOptions({ ...options, ...this.inspectOptions })
    const count = (value: number | null) =>
      value === null ? "—" : formatInspectNumber(value, opts)
    const { snapshot } = this
    const lines = [
      paint("ApiTelemetryView [Bun.inspect.custom]", ANSI.boldCyan, opts.colors),
      `${count(snapshot.completed)} finished · ${count(snapshot.inFlight)} in flight · ${count(snapshot.aborted)} aborted`,
      `${count(snapshot.clientErrors)} HTTP 4xx · ${count(snapshot.serverErrors)} HTTP 5xx · ${count(snapshot.redirects)} HTTP 3xx`,
      `Avg ${count(snapshot.avgMs)} ms · p95 upper bound ${count(snapshot.p95UpperMs)} ms`,
    ]
    if (opts.depth === 0) return lines.join("\n")
    if (this.rows.length === 0) return [...lines, "No requests recorded in this window."].join("\n")

    const details = opts.depth >= 2 && opts.breakLength >= 92 && !opts.compact
    const ordered = opts.sorted
      ? [...this.rows].sort(
          (a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method),
        )
      : this.rows
    const rows = ordered.map((row) => ({
      Method: row.method,
      Route: row.route,
      Calls: row.completed,
      "2xx": row.success,
      "3xx": row.redirects,
      "4xx": row.clientErrors,
      "5xx": row.serverErrors,
      Aborted: row.aborted,
      Active: row.inFlight,
      Avg: row.avgMs ?? "—",
      "p95 ≤": row.p95UpperMs ?? "—",
      Max: row.maxMs ?? "—",
      Last: row.lastAtMs === null ? "—" : (row.lastStatus ?? "Aborted"),
    }))
    const columns = details
      ? [
          "Method",
          "Route",
          "Calls",
          "2xx",
          "3xx",
          "4xx",
          "5xx",
          "Aborted",
          "Active",
          "Avg",
          "p95 ≤",
          "Max",
          "Last",
        ]
      : ["Method", "Route", "Calls", "4xx", "5xx", "p95 ≤", "Last"]
    const tableOptions = {
      ...opts,
      maxColWidth: Math.min(opts.maxStringLength, opts.breakLength >= 120 ? 48 : 30),
    }
    lines.push(inspectTable(rows, columns, tableOptions))
    if (details) {
      const metadata = ordered.map((row) => ({
        Method: row.method,
        Route: row.route,
        "Path Params": formatApiTelemetryParams(row.lastParams, "path") || "—",
        "Query Params": formatApiTelemetryParams(row.lastParams, "query") || "—",
        ETag: row.lastResponse?.etag ?? "—",
        "Content Type": row.lastResponse?.contentType ?? "—",
        "Response Type": row.lastResponse?.type ?? "—",
        "Response cookies":
          row.lastResponse?.cookies
            ?.map((cookie) => `${cookie.name} ${formatApiTelemetryCookieAttributes(cookie)}`)
            .join(", ") || "—",
      }))
      lines.push(
        paint("Latest parameters and response metadata", ANSI.boldCyan, opts.colors),
        inspectTable(metadata, undefined, { ...tableOptions, sorted: false }),
      )
      const transport = ordered.map((row) => ({
        Method: row.method,
        Route: row.route,
        Protocol: formatApiTelemetryProtocol(row.lastRequest) || "—",
        "Request cookies": row.lastRequest?.cookieNames?.join(", ") || "—",
        "Request body": row.lastRequest?.body.framing ?? "—",
        "Declared B": row.lastRequest?.body.declaredBytes ?? "—",
        "Response B": row.lastResponse?.body?.bytes ?? "—",
        Stream: row.lastResponse?.body?.delivery ?? "—",
        Chunks: row.lastResponse?.body?.chunks ?? "—",
      }))
      lines.push(
        paint("Latest transport and bodies", ANSI.boldCyan, opts.colors),
        inspectTable(transport, undefined, { ...tableOptions, sorted: false }),
      )
    }
    if (opts.depth >= 3) {
      const statusCounts = ordered.flatMap(({ method, route, statusCounts }) =>
        statusCounts.map(({ status, count }) => ({
          Method: method,
          Route: route,
          Status: status,
          Responses: count,
        })),
      )
      const latencyBands = ordered.flatMap(({ method, route, latencyBands }) =>
        latencyBands.map((band) => ({
          Method: method,
          Route: route,
          Latency: formatApiTelemetryLatencyBand(band),
          Responses: band.count,
        })),
      )
      lines.push(
        paint("HTTP status counts", ANSI.boldCyan, opts.colors),
        inspectTable(statusCounts, undefined, { ...tableOptions, sorted: false }),
        paint("Response latency distribution", ANSI.boldCyan, opts.colors),
        inspectTable(latencyBands, undefined, { ...tableOptions, sorted: false }),
      )
    }
    return lines.join("\n")
  }
}

interface PrivateDashboardRouteOptions {
  readonly loadAgentDetail?: (id: string) => Promise<AgentDetailApiResponse>
  readonly readAgentInspector?: (id: string) => Promise<Response>
  readonly publicStaticResponses?: Readonly<Record<`/static/${string}`, Response>>
  readonly profile?: {
    readonly read: (request: Request) => Response
    readonly write?: (request: Request) => Promise<Response>
    readonly resolveSessionId: (request: Request) => string | null
  }
}

const PROFILE_WRITE_HEADERS = ["content-type", "origin", "x-csrf-token"]
const PROFILE_PUBLIC_ORIGIN = "x-sportsdesk-profile-origin"

function profileWriteHeaders(request: Request): Headers {
  const headers = new Headers()
  for (const name of PROFILE_WRITE_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  return headers
}

function formatSessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`
}

export function createPrivateDashboardRoutes(
  telemetry: ApiTelemetry,
  {
    loadAgentDetail,
    readAgentInspector,
    publicStaticResponses = {},
    profile,
  }: PrivateDashboardRouteOptions = {},
) {
  const router = typeof Bun === "undefined" ? "express" : "bun-native"
  const readSnapshot = () => Response.json(telemetry.snapshot(router))
  const readInspection = (request: Request) => {
    const query = new URL(request.url).searchParams
    const method = query.get("method")?.trim().toUpperCase()
    const route = query.get("route")?.trim()
    if ((query.has("method") || query.has("route")) && (!method || !route)) {
      return Response.json(
        { error: "Supply both method and route to select telemetry." },
        { status: 400 },
      )
    }
    const selection = method && route ? { method, route } : undefined
    const { options, showOptions } = parseInspectOptionsFromQuery(Object.fromEntries(query))
    const opts = resolveInspectOptions({ ...options, colors: options.colors ?? false })
    const view = new ApiTelemetryView(telemetry.snapshot(router, selection), opts)
    const inspected =
      router === "bun-native" ? Bun.inspect(view, opts) : inspectDeskValue(view, opts)
    const output = showOptions
      ? `${inspected}\n${renderInspectOptionsBanner(opts, "Bun.inspect.options", { showOptions: true })}`
      : inspected
    return Response.json({ output, plain: stripAnsi(output) } satisfies ApiTelemetryInspection)
  }

  const handlers = {
    [API_TELEMETRY_PATH]: readSnapshot,
    [API_TELEMETRY_INSPECT_PATH]: readInspection,
  }
  if (router === "express") {
    return {
      dispatch: (path: keyof typeof handlers, search: string) =>
        handlers[path](new Request(`http://127.0.0.1${path}${search}`)),
      dispatchAgent: (_request: Request): Promise<Response> | null => null,
      dispatchAgentInspector: (_id: string): Promise<Response> | null => null,
      dispatchPublicStatic: (_path: string, _init: RequestInit): Promise<Response> | null => null,
      dispatchProfile: (_request: Request): Promise<Response> | null => null,
      dispatchProfileTheme: (_request: Request): Promise<Response> | null => null,
      stop() {},
    }
  }

  // Express authorizes the public request first. Only the profile route receives
  // the validated session cookie, on the direct, nonce-protected loopback hop.
  const secret = randomBytes(32).toString("hex")
  const secretBytes = Buffer.from(secret)
  const authorize =
    <TRequest extends Request>(handler: (request: TRequest) => Response | Promise<Response>) =>
    (request: TRequest) => {
      const supplied = request.headers.get("x-sportsdesk-internal") ?? ""
      if (supplied.length === secret.length) {
        const bytes = Buffer.from(supplied)
        if (bytes.length === secretBytes.length && timingSafeEqual(bytes, secretBytes)) {
          return handler(request)
        }
      }
      return new Response(null, { status: 404 })
    }
  const readAgentDetail = async (request: BunRequest<AgentDetailRoute>) => {
    const match = matchAgentDetailRoute(new URL(request.url).pathname)
    // Bun substitutes replacement characters for malformed escapes. Match the
    // compatibility router's validation while using Bun's decoded parameter.
    if (!match || decodeAgentRouteId(match.encodedId) === null) return invalidAgentRouteIdResponse()
    if (!loadAgentDetail) return new Response(null, { status: 404 })
    server.timeout(request, 0)
    try {
      return Response.json(await loadAgentDetail(request.params.id))
    } catch (error) {
      console.error("[SportsDesk API Error]", error)
      return Response.json(
        { error: error instanceof Error ? error.message : "Internal Server Error" },
        { status: 500 },
      )
    }
  }
  const readNativeProfile = (request: BunRequest<typeof PROFILE_ROUTE>) => {
    if (!profile) return new Response(null, { status: 404 })
    const sessionId = request.cookies.get(SESSION_COOKIE_NAME)
    const headers = sessionId ? { cookie: formatSessionCookie(sessionId) } : undefined
    return profile.read(new Request(request.url, { headers }))
  }
  const writeNativeProfileTheme = (request: BunRequest<typeof PROFILE_THEME_ROUTE>) => {
    const publicOrigin = request.headers.get(PROFILE_PUBLIC_ORIGIN)
    if (!profile?.write || !publicOrigin) return new Response(null, { status: 404 })
    const headers = profileWriteHeaders(request)
    const sessionId = request.cookies.get(SESSION_COOKIE_NAME)
    if (sessionId) headers.set("cookie", formatSessionCookie(sessionId))
    const init = {
      method: "POST",
      headers,
      body: request.body,
      duplex: "half",
    } satisfies RequestInit & { duplex: "half" }
    return profile.write(new Request(new URL(PROFILE_THEME_ROUTE, publicOrigin), init))
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    routes: {
      ...publicStaticResponses,
      [API_TELEMETRY_PATH]: { GET: authorize(readSnapshot) },
      [API_TELEMETRY_INSPECT_PATH]: { GET: authorize(readInspection) },
      [AGENT_DETAIL_ROUTE]: { GET: authorize(readAgentDetail) },
      [AGENT_DETAILS_ROUTE]: { GET: authorize(readAgentDetail) },
      [AGENT_INSPECTOR_ROUTE]: {
        GET: authorize((request: BunRequest<typeof AGENT_INSPECTOR_ROUTE>) => {
          if (!readAgentInspector) return new Response(null, { status: 404 })
          const { id } = request.params
          server.timeout(request, 0)
          return readAgentInspector(id)
        }),
      },
      [PROFILE_ROUTE]: { GET: authorize(readNativeProfile) },
      [PROFILE_THEME_ROUTE]: { POST: authorize(writeNativeProfileTheme) },
    },
    fetch: () => new Response(null, { status: 404 }),
  })
  const fetchPrivateRoute = (
    path: string,
    { sessionId, ...init }: RequestInit & { sessionId?: string; duplex?: "half" } = {},
  ) => {
    const headers = new Headers(init.headers)
    headers.set("x-sportsdesk-internal", secret)
    if (sessionId) headers.set("cookie", formatSessionCookie(sessionId))
    const options = {
      ...init,
      headers,
      proxy: false,
      redirect: "error",
    } satisfies RequestInit & { proxy: false }
    return fetch(new URL(path, server.url), options)
  }
  return {
    dispatch: (path: keyof typeof handlers, search: string) =>
      fetchPrivateRoute(`${path}${search}`, { signal: AbortSignal.timeout(3000) }),
    dispatchAgent: (request: Request): Promise<Response> | null => {
      if (!loadAgentDetail || request.method !== "GET") return null
      const pathname = new URL(request.url).pathname
      return matchAgentDetailRoute(pathname) ? fetchPrivateRoute(pathname) : null
    },
    dispatchAgentInspector: (id: string): Promise<Response> | null => {
      // Fetch normalizes dot segments, which Express accepts as literal IDs.
      if (!readAgentInspector || id === "." || id === "..") return null
      return fetchPrivateRoute(AGENT_INSPECTOR_ROUTE.replace(":id", encodeURIComponent(id)))
    },
    dispatchPublicStatic: (path: string, init: RequestInit): Promise<Response> | null =>
      Object.hasOwn(publicStaticResponses, path)
        ? fetchPrivateRoute(path, { ...init, signal: AbortSignal.timeout(3000) })
        : null,
    dispatchProfile: (request: Request): Promise<Response> | null => {
      if (request.method !== "GET" && request.method !== "HEAD") return null
      const sessionId = profile?.resolveSessionId(request)
      return sessionId ? fetchPrivateRoute(PROFILE_ROUTE, { sessionId }) : null
    },
    dispatchProfileTheme: (request: Request): Promise<Response> | null => {
      if (request.method !== "POST" || !profile?.write) return null
      const sessionId = profile.resolveSessionId(request)
      if (!sessionId) return null
      const headers = profileWriteHeaders(request)
      headers.set(PROFILE_PUBLIC_ORIGIN, new URL(request.url).origin)
      return fetchPrivateRoute(PROFILE_THEME_ROUTE, {
        method: "POST",
        headers,
        sessionId,
        body: request.body,
        duplex: "half",
      })
    },
    stop: () => server.stop(true),
  }
}
