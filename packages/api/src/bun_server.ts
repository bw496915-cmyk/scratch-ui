/**
 * Testable `Bun.serve` factory wrapping `createDashboardApi(deps)` with pre-serialized static route
 * support, native Zig radix-tree `routes`, and ephemeral `port: 0` binding with resolved
 * `server.url`.
 *
 * @file Packages/api/src/bun_server.ts
 */

import { DASHBOARD_ROUTES } from "./bun_routes.ts"
import { createDashboardApi } from "./router.ts"
import type { DashboardApiDeps } from "./types.ts"
import type { WsLike } from "./ws.ts"

export interface BunServerLike {
  readonly url: URL
  readonly port: number
  readonly hostname: string
  stop(closeActiveConnections?: boolean): void
}

interface BunServeRuntime {
  serve(options: {
    readonly port?: number | undefined
    readonly hostname?: string | undefined
    readonly maxRequestBodySize?: number | undefined
    readonly routes?: Record<string, unknown> | undefined
    readonly fetch?: ((req: Request) => Response | Promise<Response>) | undefined
    readonly error?: ((err: Error) => Response | Promise<Response>) | undefined
  }): BunServerLike
}

export interface CreateDashboardBunServerOptions<TWs extends WsLike = WsLike> {
  /** Port to bind (`0` allocates an ephemeral OS port for isolated tests). */
  readonly port?: number | undefined
  /** Bind interface (defaults to `127.0.0.1` when `port === 0`). */
  readonly hostname?: string | undefined
  /** Maximum request body size in bytes (defaults to 5 MB). */
  readonly maxRequestBodySize?: number | undefined
  /**
   * Pre-serialized static response mounted directly at `GET /` and `GET /app` in Bun's native Zig
   * router (zero JS execution per request).
   */
  readonly rootResponse?: Response | string | undefined
  /** Optional additional Lane A/C/D routes to merge into the explicit routes table. */
  readonly extraRoutes?: Record<string, unknown> | undefined
  readonly clients?: Set<TWs> | undefined
}

export interface DashboardBunServerHandle<TWs extends WsLike = WsLike> {
  readonly server: BunServerLike
  readonly url: URL
  readonly api: ReturnType<typeof createDashboardApi<TWs>>
  stop(closeActiveConnections?: boolean): void
}

/**
 * Create a real `Bun.serve` HTTP server backed by `createDashboardApi(deps)`.
 *
 * The `routes` map IS the inventory:
 *
 * - Lane A: `/`, `/app`, `/live-bets` (308 -> `/wagers`), plus optional `extraRoutes`
 * - Lane B/C/D: exact and `:param` routes from `api.routes`
 * - Deliberately NO `/api/*` catch-all: unmatched paths 404 via `fetch`.
 */
export function createDashboardBunServer<TWs extends WsLike = WsLike>(
  deps: DashboardApiDeps,
  options: CreateDashboardBunServerOptions<TWs> = {},
): DashboardBunServerHandle<TWs> {
  const bunRuntime = (globalThis as { readonly Bun?: BunServeRuntime }).Bun
  if (!bunRuntime || typeof bunRuntime.serve !== "function") {
    throw new Error("createDashboardBunServer requires the Bun runtime (Bun.serve is unavailable)")
  }

  const port = options.port !== undefined ? options.port : Number(process.env.PORT ?? 3000)
  const hostname = options.hostname ?? (port === 0 ? "127.0.0.1" : undefined)

  const api = createDashboardApi<TWs>(deps, {
    clients: options.clients,
  })

  const staticRootResponse =
    options.rootResponse instanceof Response
      ? options.rootResponse
      : new Response(options.rootResponse ?? "SportsDesk Ops API", {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        })

  const routeTable: Record<string, unknown> = {
    // Lane A — dashboard shell & permanent alias redirect
    [DASHBOARD_ROUTES.root]: staticRootResponse,
    [DASHBOARD_ROUTES.dashboardApp]: staticRootResponse,
    [DASHBOARD_ROUTES.dashboardLiveBets]: Response.redirect("/wagers", 308),
    // Lanes B, C, D — explicit API, destructive POST-only, and realtime routes (zero /api/* wildcard)
    ...(api.routes as Record<string, unknown>),
    ...(options.extraRoutes ?? {}),
  }

  const server = bunRuntime.serve({
    port,
    ...(hostname ? { hostname } : {}),
    maxRequestBodySize: options.maxRequestBodySize ?? 5_000_000,
    routes: routeTable,
    // Unmatched paths return 404 directly; known routes hit with an unlisted method return 405.
    fetch: (req) => api.fetch(req),
    error: () =>
      Response.json(
        { error: "internal" },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      ),
  })

  return {
    server,
    url: server.url,
    api,
    stop(closeActiveConnections = true): void {
      server.stop(closeActiveConnections)
    },
  }
}
