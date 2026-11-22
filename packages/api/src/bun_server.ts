/**
 * @file packages/api/src/bun_server.ts
 * @description Testable `Bun.serve` factory wrapping `createDashboardApi(deps)`
 * with pre-serialized static route support, native Zig radix-tree `routes`,
 * and ephemeral `port: 0` binding with resolved `server.url`.
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
    readonly routes?: Record<string, unknown> | undefined
    readonly fetch?: ((req: Request) => Response | Promise<Response>) | undefined
  }): BunServerLike
}

export interface CreateDashboardBunServerOptions<TWs extends WsLike = WsLike> {
  /** Port to bind (`0` allocates an ephemeral OS port for isolated tests). */
  readonly port?: number | undefined
  /** Bind interface (defaults to `127.0.0.1` when `port === 0`). */
  readonly hostname?: string | undefined
  /**
   * Pre-serialized static response mounted directly at `GET /` in Bun's native
   * Zig router (zero JS execution per request, bypassing `fetch()`).
   */
  readonly rootResponse?: Response | string | undefined
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
 * Uses `globalThis.Bun.serve` so Node/esbuild production builds remain portable
 * while Bun runtime executions and `bun test` ephemeral `port: 0` smoke tests
 * run directly on Bun's native Zig radix-tree router.
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

  const { [DASHBOARD_ROUTES.apiWildcard]: _wildcard, ...exactAndParamRoutes } =
    api.routes as Record<string, unknown>

  const server = bunRuntime.serve({
    port,
    ...(hostname ? { hostname } : {}),
    routes: {
      [DASHBOARD_ROUTES.root]: staticRootResponse,
      ...exactAndParamRoutes,
    },
    fetch: api.fetch,
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
