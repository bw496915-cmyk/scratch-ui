import { McpLimiterDO } from "./do/mcp_limiter.ts"
import { handleMcpRequest, MCP_ROUTE_PATH } from "./mcp/handler.ts"
import type { SportsOpsDeskEnv, WorkerExecutionContextLike } from "./types/env.ts"

export { McpLimiterDO }

export default {
  async fetch(
    request: Request,
    env: SportsOpsDeskEnv,
    ctx: WorkerExecutionContextLike,
  ): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === MCP_ROUTE_PATH) {
      return handleMcpRequest(request, env, ctx)
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({
        ok: true,
        worker: "sports-ops-desk",
        r2Bindings: {
          DESK_ARCHIVE: Boolean(env.DESK_ARCHIVE),
          OPS_REPORTS: Boolean(env.OPS_REPORTS),
          BETS_BUCKET: Boolean(env.BETS_BUCKET),
          LEDGER_RECEIPTS: Boolean(env.LEDGER_RECEIPTS),
        },
        mcpLimiterBound: Boolean(env.MCP_LIMITER),
        wallEpochMs: Date.now(),
      })
    }

    return Response.json({ error: "Not Found" }, { status: 404 })
  },
}
