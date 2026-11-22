export interface Fantasy402BetIngestEnv {
  readonly ANALYTICS: AnalyticsEngineDataset
  readonly BETS_BUCKET: R2Bucket
}

export default {
  async fetch(request: Request, env: Fantasy402BetIngestEnv): Promise<Response> {
    const startMonoMs = performance.now()
    const wallEpochMs = Date.now()
    const url = new URL(request.url)

    if (url.pathname === "/health" && request.method === "GET") {
      env.ANALYTICS.writeDataPoint({
        blobs: ["health", "ok"],
        doubles: [performance.now() - startMonoMs],
        indexes: ["fantasy402-bet-ingest"],
      })
      return Response.json({
        ok: true,
        worker: "fantasy402-bet-ingest",
        bindings: {
          analytics: Boolean(env.ANALYTICS),
          betsBucket: Boolean(env.BETS_BUCKET),
        },
        wallEpochMs,
      })
    }

    return Response.json({ error: "Not Found", path: url.pathname }, { status: 404 })
  },
}
