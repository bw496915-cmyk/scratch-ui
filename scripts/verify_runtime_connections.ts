import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { connect as connectHttp2 } from "node:http2"
import { get as getHttps } from "node:https"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { z } from "zod"
import { WebSocket } from "ws"
import { projectRetainedCustomerHistory } from "../packages/backend/src/retained_customer_history.ts"
import type { ApiTelemetrySnapshot } from "../packages/contracts/src/api_telemetry.ts"
import { bookRowsToProfiles } from "../packages/ui/src/profile_rows.ts"
import { createR2ObjectCheck } from "../server/bun_r2_inspect.ts"
import { SealedR2Handle, withInspectRole } from "../src/s3/sealed_r2_handle.ts"
import { DEFAULT_PROFILE_THEME, type ProfileTheme } from "../src/profile/types.ts"
import { type BrowserBackend, verifyBrowserSession } from "./verify_browser_session.ts"

const pipelineSchema = z.object({
  overallStatus: z.enum(["fresh", "stale", "degraded"]),
  freshCount: z.number(),
  publishFreshCount: z.number(),
  bucketPublicBase: z.string(),
  dataStaleKeys: z.array(z.string()),
  daemon4020: z.object({ state: z.string(), online: z.boolean(), url: z.string() }),
  automations: z.object({
    source: z.enum(["collector-state", "unavailable"]),
    bridgeRollupUpdatedAt: z.string().nullable(),
    bridgeJobs: z.array(z.object({ id: z.string(), ok: z.boolean() })),
    schedules: z.array(z.unknown()),
    ticketVerification: z.null(),
  }),
})

function resolveNodeExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = Bun.which("node", { PATH: directory })
    if (!candidate) continue
    const probe = Bun.spawnSync([candidate, "-p", "process.versions.bun ? '' : process.execPath"])
    const executable = probe.stdout.toString().trim()
    if (probe.exitCode === 0 && executable) return executable
  }
  throw new Error("Node.js is required for this check. Use --bun-server to verify the Bun runtime.")
}

async function verifyRuntimeConnections(
  browser: BrowserBackend | undefined,
  serverRuntime: "node" | "bun",
  useTls: boolean,
) {
  assert.equal(Bun.version, "1.4.4", "Run with the repository's pinned Bun 1.4.4")
  assert.ok(await Bun.file("server.mjs").exists(), "Run bun run build first")
  const certificate = process.env.SPORTSDESK_TLS_CERT_PATH
  const privateKey = process.env.SPORTSDESK_TLS_KEY_PATH
  if (useTls) {
    assert.equal(serverRuntime, "bun", "Use --bun-server with --tls")
    assert.ok(
      certificate && privateKey,
      "Configure SPORTSDESK_TLS_CERT_PATH and SPORTSDESK_TLS_KEY_PATH",
    )
  }
  const serverCommand =
    serverRuntime === "bun" ? [process.execPath, "--no-env-file"] : [resolveNodeExecutable()]
  const directory = await mkdtemp(join(tmpdir(), "sportsdesk-runtime-"))
  const statePath = join(directory, "collector-state.json")
  const emptyEnvPath = join(directory, "empty.env")
  await writeFile(emptyEnvPath, "")
  const rosterPath = join(directory, "roster.json")
  const historyPath = join(directory, "history.json")
  await writeFile(
    rosterPath,
    JSON.stringify({
      schemaVersion: 1,
      agents: [],
      players: [{ customerId: "ACCOUNT1" }, { customerId: "IDENTITY_ONLY" }],
    }),
  )
  const retainedProjection = projectRetainedCustomerHistory([
    [10000, 20000].map((stake, index) => ({
      CustomerID: "ACCOUNT1",
      TicketNumber: `T${index}`,
      WagerNumber: `W${index}`,
      AmountWagered: String(stake),
      AmountWon: "0",
      AmountLost: String(stake),
      AmountRefunded: "0",
      FreePlayFlag: "N",
      WagerStatus: "L",
      AcceptedDateTime: "2026-11-10 12:00:00",
      TicketWriter: "Internet",
    })),
  ])
  await writeFile(
    historyPath,
    JSON.stringify({ ...retainedProjection, generatedAt: new Date().toISOString() }),
  )
  const adminToken = crypto.randomUUID()
  const token = crypto.randomUUID()
  const r2ClientFixture = {
    R2_ENDPOINT: "https://runtime-inspect.invalid",
    R2_BUCKET_NAME: "runtime-inspect-fixture",
    R2_ACCESS_KEY_ID: crypto.randomUUID(),
    R2_SECRET_ACCESS_KEY: crypto.randomUUID(),
    R2_SESSION_TOKEN: crypto.randomUUID(),
  }
  const r2HealthcheckKey = "diagnostics/private check étude%25"
  let signedRequestCount = 0
  let s3Status = 200
  const s3Upstream =
    useTls && certificate && privateKey
      ? Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          tls: { cert: Bun.file(certificate), key: Bun.file(privateKey) },
          fetch(request) {
            signedRequestCount++
            const url = new URL(request.url)
            if (
              request.method !== "HEAD" ||
              decodeURIComponent(url.pathname) !==
                `/${r2ClientFixture.R2_BUCKET_NAME}/${r2HealthcheckKey}` ||
              url.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
              !url.searchParams
                .get("X-Amz-Credential")
                ?.startsWith(`${r2ClientFixture.R2_ACCESS_KEY_ID}/`) ||
              url.searchParams.get("X-Amz-Security-Token") !== r2ClientFixture.R2_SESSION_TOKEN ||
              !/^[0-9a-f]{64}$/.test(url.searchParams.get("X-Amz-Signature") ?? "")
            )
              return new Response(null, { status: 400 })
            const headers = new Headers()
            if (s3Status === 200) headers.set("content-length", "23")
            if (s3Status === 302) headers.set("location", "/would-follow-redirect")
            return new Response(null, { status: s3Status, headers })
          },
        })
      : undefined
  const privateR2Endpoint = s3Upstream?.url.origin ?? r2ClientFixture.R2_ENDPOINT
  const scenarios: string[] = []
  let daemonStatus = 200
  let dataAgeMs: number | null = 60_000
  let daemonRequests = 0
  let r2Requests = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/daemon/health") {
        daemonRequests++
        return Response.json(
          { operationalStatus: daemonStatus === 200 ? "ok" : "down" },
          { status: daemonStatus },
        )
      }
      if (url.pathname.startsWith("/r2/")) {
        r2Requests++
        return Response.json(
          dataAgeMs === null
            ? { generatedAt: new Date().toISOString() }
            : { window: { toMs: Date.now() - dataAgeMs } },
          { headers: { "last-modified": new Date().toUTCString() } },
        )
      }
      return new Response("Not found", { status: 404 })
    },
  })
  const reserve = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = reserve.port
  assert.ok(port)
  reserve.stop(true)
  const appUrl = `${useTls ? "https" : "http"}://127.0.0.1:${port}`
  const upstreamUrl = `http://127.0.0.1:${upstream.port}`
  const spawnDashboard = (adminCredential: string) =>
    Bun.spawn([...serverCommand, resolve("server.mjs")], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "production",
        DOTENV_CONFIG_PATH: emptyEnvPath,
        F402_OFFLINE_ONLY: "1",
        PORT: String(port),
        SPORTSDESK_BIND_HOST: "127.0.0.1",
        ...(useTls
          ? { SPORTSDESK_TLS_CERT_PATH: certificate, SPORTSDESK_TLS_KEY_PATH: privateKey }
          : {}),
        SPORTSDESK_DASHBOARD_TOKEN: token,
        SPORTSDESK_ADMIN_TOKEN: adminCredential,
        SPORTSDESK_SESSION_DB_PATH: join(directory, "dashboard-sessions.sqlite"),
        SPORTSDESK_CUSTOMER_ROSTER_JSON: rosterPath,
        SPORTSDESK_CUSTOMER_HISTORY_JSON: historyPath,
        SPORTSDESK_API_ORIGIN: `${upstreamUrl}/daemon`,
        SPORTSDESK_BRIDGE_STATE_PATH: statePath,
        R2_PUBLIC_URL: `${upstreamUrl}/r2`,
        ...r2ClientFixture,
        R2_ENDPOINT: privateR2Endpoint,
        ...(s3Upstream
          ? {
              NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
              R2_HEALTHCHECK_KEY: r2HealthcheckKey,
            }
          : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
  let child = spawnDashboard(adminToken)
  async function stopDashboard() {
    child.kill()
    await child.exited
    await child.stdout.cancel()
    await child.stderr.cancel()
  }
  const headers = { authorization: `Bearer ${token}` }
  const recordedAt = new Date(Date.now() - 60_000).toISOString()
  async function writeCollectorReceipt(ok: boolean) {
    await writeFile(
      statePath,
      JSON.stringify({
        updatedAt: recordedAt,
        jobs: [
          {
            id: "bridge3c",
            label: "Controlled capture",
            ok,
            durationMs: 1,
            ...(ok ? {} : { error: "GSLive expired" }),
          },
        ],
      }),
    )
  }
  async function readPipeline() {
    const response = await fetch(`${appUrl}/api/r2/pipeline?refresh=1`, { headers })
    assert.equal(response.status, 200)
    const raw: unknown = await response.json()
    return pipelineSchema.parse(raw)
  }
  async function waitForDashboard() {
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error("Production server exited before readiness")
      try {
        ready = (await fetch(`${appUrl}/health`, { signal: AbortSignal.timeout(500) })).ok
      } catch {
        /* Waiting for the isolated server to bind. */
      }
      if (ready) break
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
    assert.ok(ready, "Production server must become ready within 10 seconds")
  }
  async function restartDashboard(adminCredential: string) {
    await stopDashboard()
    child = spawnDashboard(adminCredential)
    await waitForDashboard()
  }
  try {
    await writeCollectorReceipt(true)
    await waitForDashboard()
    if (useTls) {
      const session = connectHttp2(appUrl)
      session.setTimeout(5000, () => session.destroy(new Error("HTTP/2 check timed out")))
      try {
        const stream = session.request({ ":path": "/health" })
        const [headers] = await once(stream, "response")
        assert.equal(headers[":status"], 200)
        assert.equal(session.alpnProtocol, "h2")
        stream.resume()
      } finally {
        session.destroy()
      }
      const version = await new Promise<string>((resolve, reject) => {
        const requestOptions = { method: "GET", ALPNProtocols: ["http/1.1"] }
        const request = getHttps(`${appUrl}/health`, requestOptions, (response) => {
          response.resume()
          if (response.statusCode === 200) resolve(response.httpVersion)
          else reject(new Error(`HTTP/1.1 health returned ${response.statusCode}`))
        })
        request.setTimeout(5000, () => request.destroy(new Error("HTTP/1.1 check timed out")))
        request.once("error", reject)
      })
      assert.equal(version, "1.1")
      scenarios.push("trusted Bun HTTPS negotiates HTTP/2 and HTTP/1.1 on the same port")
    }
    assert.equal((await fetch(`${appUrl}/api/r2/pipeline`)).status, 401)
    scenarios.push("production API denies anonymous access")
    for (const path of ["/api/telemetry", "/api/telemetry/inspect"]) {
      assert.equal((await fetch(`${appUrl}${path}`)).status, 401)
    }
    const baselineResponse = await fetch(`${appUrl}/api/telemetry`, { headers })
    assert.equal(baselineResponse.status, 200)
    assert.equal(baselineResponse.headers.get("cache-control"), "no-store")
    const baseline = await baselineResponse.json()
    assert.equal(baseline.router, serverRuntime === "bun" ? "bun-native" : "express")
    assert.equal(
      baseline.rows.find((row: { route: string }) => row.route === "/api/r2/pipeline")?.lastStatus,
      401,
    )
    assert.equal((await fetch(`${appUrl}/api/health?reference=privateValue`)).status, 200)
    const profileResponse = await fetch(
      `${appUrl}/api/customer/profile?id=ACCOUNT1&privateKey=privateValue`,
      { headers },
    )
    assert.equal(profileResponse.status, 200)
    const etag = profileResponse.headers.get("etag")
    assert.ok(etag, "Profile response must supply a real ETag")
    const profileBytes = (await profileResponse.arrayBuffer()).byteLength
    const submitted = JSON.stringify({ sample: "privateRequestBody" })
    const rejectedPost = await fetch(`${appUrl}/api/health`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: submitted,
    })
    assert.equal(rejectedPost.status, 405)
    assert.equal((await fetch(`${appUrl}/api/privateValue`, { headers })).status, 404)
    const measured = await fetch(`${appUrl}/api/telemetry`, { headers }).then((r) => r.json())
    const measuredAgain = await fetch(`${appUrl}/api/telemetry`, { headers }).then((r) => r.json())
    assert.equal(measured.completed, baseline.completed + 4)
    assert.equal(measuredAgain.completed, measured.completed)
    assert.ok(
      measured.rows.some(
        (row: { route: string; lastStatus: number }) =>
          row.route === "/api/:unmatched" && row.lastStatus === 404,
      ),
    )
    const profileSample = measured.rows.find(
      (row: { route: string }) => row.route === "/api/customer/profile",
    )
    assert.deepEqual(profileSample?.lastParams, { path: [], query: ["id"] })
    assert.deepEqual(profileSample?.lastResponse, {
      etag,
      contentType: profileResponse.headers.get("content-type")?.replace(/\s*;\s*/g, "; "),
      type: "JSON",
      body: { delivery: "Buffered", bytes: profileBytes, chunks: 1 },
      cookies: [],
    })
    assert.deepEqual(profileSample?.lastRequest, {
      scheme: useTls ? "https" : "http",
      httpVersion: useTls ? null : "1.1",
      tlsVersion: null,
      contentType: null,
      cookieNames: [],
      body: { framing: "No body", declaredBytes: 0 },
    })
    const postSample = measured.rows.find(
      (row: { method: string; route: string }) =>
        row.method === "POST" && row.route === "/api/health",
    )
    assert.deepEqual(postSample?.lastRequest?.body, {
      framing: "Content-Length",
      declaredBytes: Buffer.byteLength(submitted),
    })
    assert.doesNotMatch(
      JSON.stringify(measured),
      /privateKey|privateValue|ACCOUNT1|privateRequestBody/,
    )
    const inspected = await fetch(`${appUrl}/api/telemetry/inspect?depth=0&showOptions=true`, {
      headers,
    })
    assert.equal(inspected.status, 200)
    const report = await inspected.json()
    assert.match(report.plain, /ApiTelemetryView.*Bun\.inspect\.custom/)
    assert.match(report.plain, /Bun\.inspect\.options/)
    assert.doesNotMatch(report.plain, /\/api\/health/)
    scenarios.push(
      `API telemetry measures response bytes, request lengths, and protocols via ${baseline.router} and excludes payloads and polling`,
    )
    for (const alias of ["agent", "agents"]) {
      const agentUrl = `${appUrl}/api/${alias}/desk%252Fprobe`
      assert.equal((await fetch(agentUrl)).status, 401)
      const response = await fetch(agentUrl, { headers })
      assert.equal(response.status, 200)
      const agent = z.object({ agentId: z.string() }).parse(await response.json())
      assert.equal(agent.agentId, "DESK%2FPROBE")
      const malformed = await fetch(`${appUrl}/api/${alias}/%ZZ`, { headers })
      assert.equal(malformed.status, 400)
      assert.match(malformed.headers.get("content-type") ?? "", /application\/json/)
      assert.equal((await fetch(agentUrl, { headers, method: "HEAD" })).status, 405)
    }
    scenarios.push(
      "protected agent aliases decode IDs once and reject malformed IDs and unsupported methods",
    )
    const inspectorUrl = `${appUrl}/Agent/desk%252Fprobe%26/?privateKey=privateValue`
    assert.equal((await fetch(`${appUrl}/agent/privateAgent`)).status, 401)
    const inspector = await fetch(inspectorUrl, { headers })
    assert.equal(inspector.status, 200)
    assert.match(inspector.headers.get("content-type") ?? "", /text\/html/)
    const inspectorHtml = await inspector.text()
    assert.match(inspectorHtml, /<title>Agent DESK%2FPROBE&amp; · SportsDesk Ops<\/title>/)
    const inspectorHead = await fetch(inspectorUrl, { headers, method: "HEAD" })
    assert.equal(inspectorHead.status, 200)
    assert.equal(await inspectorHead.text(), "")
    assert.equal((await fetch(inspectorUrl, { headers, method: "POST" })).status, 404)
    scenarios.push("agent inspector retains authenticated GET, HTML escaping, and HEAD behavior")
    const inspectorTelemetry: ApiTelemetrySnapshot = await fetch(`${appUrl}/api/telemetry`, {
      headers,
    }).then((response) => response.json())
    const inspectorRows = inspectorTelemetry.rows.filter((row) => row.route === "/agent/:id")
    assert.equal(inspectorRows.length, 2)
    const inspectorGetSample = inspectorRows.find((row) => row.method === "GET")
    assert.equal(inspectorGetSample?.completed, 2)
    assert.equal(inspectorGetSample.clientErrors, 1)
    assert.equal(inspectorGetSample.lastStatus, 200)
    assert.deepEqual(inspectorGetSample.statusCounts, [
      { status: 200, count: 1 },
      { status: 401, count: 1 },
    ])
    assert.equal(
      inspectorGetSample.latencyBands.reduce((sum, band) => sum + band.count, 0),
      2,
    )
    assert.deepEqual(inspectorGetSample.lastParams, { path: ["id"], query: [] })
    assert.deepEqual(inspectorGetSample.lastResponse, {
      etag: inspector.headers.get("etag"),
      contentType: "text/html; charset=utf-8",
      type: "HTML",
      body: { delivery: "Buffered", bytes: Buffer.byteLength(inspectorHtml), chunks: 1 },
      cookies: [],
    })
    const inspectorHeadSample = inspectorRows.find((row) => row.method === "HEAD")
    assert.equal(inspectorHeadSample?.completed, 1)
    assert.deepEqual(inspectorHeadSample.statusCounts, [{ status: 200, count: 1 }])
    assert.equal(inspectorHeadSample.lastResponse?.type, "No body")
    assert.doesNotMatch(
      JSON.stringify(inspectorRows),
      /privateAgent|probe|privateKey|privateValue/i,
    )
    scenarios.push(
      "agent inspector telemetry records exact statuses, latency bands, HTML bytes, and parameter names",
    )
    for (const [path, destination] of [
      ["/graph", "/docs/graph.html"],
      ["/status", "/static/status.html"],
    ]) {
      assert.equal((await fetch(`${appUrl}${path}`, { redirect: "manual" })).status, 401)
      const redirect = await fetch(`${appUrl}${path}`, { headers, redirect: "manual" })
      assert.equal(redirect.status, 302)
      assert.equal(redirect.headers.get("location"), destination)
      assert.equal((await fetch(`${appUrl}${destination}`, { headers })).status, 200)
    }
    const statusPage = await fetch(`${appUrl}/static/status.html`, { headers })
    assert.match(await statusPage.text(), /src="\/static\/status.js"/)
    assert.match(statusPage.headers.get("content-security-policy") ?? "", /script-src 'self'/)
    const statusScript = await fetch(`${appUrl}/static/status.js`, { headers })
    assert.equal(statusScript.status, 200)
    assert.match(statusScript.headers.get("content-type") ?? "", /javascript/)
    const statusBytes = await readFile("static/status.js")
    assert.deepEqual(Buffer.from(await statusScript.arrayBuffer()), statusBytes)
    const statusEtag = statusScript.headers.get("etag")
    assert.ok(statusEtag, "Status script must supply an ETag")
    if (serverRuntime === "bun") {
      assert.equal(statusScript.headers.get("cache-control"), "no-cache")
      assert.match(statusEtag, /^"[^"]+"$/)
    }
    const statusHead = await fetch(`${appUrl}/static/status.js`, { method: "HEAD" })
    assert.equal(statusHead.status, 200)
    assert.equal(statusHead.headers.get("content-length"), String(statusBytes.length))
    assert.equal(statusHead.headers.get("etag"), statusEtag)
    assert.equal(await statusHead.text(), "")
    const statusRevalidated = await fetch(`${appUrl}/static/status.js`, {
      headers: { "If-None-Match": statusEtag },
    })
    assert.equal(statusRevalidated.status, 304)
    assert.equal(await statusRevalidated.text(), "")
    scenarios.push(
      "public status script preserves ETag revalidation, HEAD length, and source bytes",
    )
    for (const { file, protectedFile } of [
      { file: "static/customer-churn-simulation-dashboard.html", protectedFile: false },
      { file: "docs/assets/ARCH-Guide.jpg", protectedFile: true },
    ]) {
      const url = `${appUrl}/${file}`
      const range = { Range: "bytes=0-15" }
      if (protectedFile) assert.equal((await fetch(url, { headers: range })).status, 401)
      const partial = await fetch(url, { headers: { ...headers, ...range } })
      const bytes = await readFile(file)
      assert.equal(partial.status, 206, file)
      assert.equal(partial.headers.get("content-range"), `bytes 0-15/${bytes.byteLength}`, file)
      assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 16), file)
      const lastModified = partial.headers.get("last-modified")
      assert.ok(lastModified, file)
      const revalidated = await fetch(url, {
        headers: { ...headers, "If-Modified-Since": lastModified },
      })
      assert.equal(revalidated.status, 304, file)
      if (useTls) {
        const etag = partial.headers.get("etag")
        assert.ok(etag, file)
        assert.match(etag, /^W\/"[^"]+"$/, file)
        const strongSpelling = etag.slice(2)
        for (const validator of [etag, '"stale,version", ' + strongSpelling, "*"]) {
          const cached = await fetch(url, {
            headers: { ...headers, ...range, "If-None-Match": validator },
          })
          assert.equal(cached.status, 304, file)
          assert.equal(cached.headers.get("etag"), etag, file)
          assert.equal(cached.headers.get("content-range"), null, file)
          assert.equal(await cached.text(), "", file)
        }
        const stale = await fetch(url, {
          headers: { ...headers, "If-None-Match": '"stale"', "If-Modified-Since": lastModified },
        })
        assert.equal(stale.status, 200, file)
        assert.deepEqual(Buffer.from(await stale.arrayBuffer()), bytes, file)
        const head = await fetch(url, {
          method: "HEAD",
          headers: { ...headers, "If-None-Match": etag },
        })
        assert.equal(head.status, 304, file)
        assert.equal(head.headers.get("etag"), etag, file)
        assert.equal(await head.text(), "", file)
        const weakRange = await fetch(url, {
          headers: { ...headers, ...range, "If-Range": etag },
        })
        assert.equal(weakRange.status, 200, file)
        assert.deepEqual(Buffer.from(await weakRange.arrayBuffer()), bytes, file)
        const unsatisfied = await fetch(url, {
          headers: { ...headers, Range: "bytes=" + bytes.length + "-" },
        })
        assert.equal(unsatisfied.status, 416, file)
        assert.equal(unsatisfied.headers.get("content-range"), "bytes */" + bytes.length, file)
        assert.equal(await unsatisfied.text(), "", file)
        if (protectedFile) {
          assert.equal(weakRange.headers.get("cache-control"), "private, no-cache", file)
          const anonymous = await fetch(url, { headers: { "If-None-Match": etag } })
          assert.equal(anonymous.status, 401, file)
          assert.equal(anonymous.headers.get("etag"), null, file)
        }
      }
    }
    assert.equal((await fetch(`${appUrl}/static/runtime-missing-asset.txt`)).status, 404)
    assert.equal((await fetch(`${appUrl}/docs/assets/`, { headers })).status, 404)
    scenarios.push(
      "contained files stream byte ranges and revalidate; protected documents require auth",
    )
    if (useTls) scenarios.push("native files apply weak ETag preconditions before range handling")
    const dnsResponse = await fetch(`${appUrl}/api/dns/telemetry`, { headers })
    const dns = z
      .object({
        telemetry: z.object({ source: z.string(), totalCount: z.literal(0), size: z.literal(0) }),
      })
      .parse(await dnsResponse.json())
    assert.equal(
      dns.telemetry.source,
      serverRuntime === "bun" ? "bun-native-cache" : "node-application-cache",
    )
    const benchmarkResponse = await fetch(`${appUrl}/api/dns/benchmark?host=localhost`, { headers })
    assert.equal(benchmarkResponse.status, 200)
    const benchmark = z
      .object({
        host: z.literal("localhost"),
        fastestBackend: z.string(),
        metrics: z.array(
          z.object({ backend: z.string(), meanMs: z.number().nonnegative().nullable() }),
        ),
      })
      .parse(await benchmarkResponse.json())
    assert.deepEqual(
      benchmark.metrics.map(({ backend }) => backend),
      serverRuntime === "bun" ? ["c-ares", "system", "getaddrinfo"] : ["node-cache", "system"],
    )
    assert.ok(
      benchmark.metrics.some(({ backend, meanMs }) => backend === "system" && meanMs !== null),
    )
    scenarios.push("DNS telemetry and resolver benchmarks use the running server's backend")
    scenarios.push(
      "graph/status navigation authenticates, status script supports production CSP, DNS starts unmeasured",
    )

    for (const [directory, prefix] of [
      ["public", ""],
      ["src/assets", "/src/assets"],
    ]) {
      for (const name of await readdir(directory!, { recursive: true, withFileTypes: true })) {
        if (!name.isFile()) continue
        const filePath = join(name.parentPath, name.name)
        const urlPath = filePath.replace(/\\/g, "/").slice(directory!.length)
        const response = await fetch(`${appUrl}${prefix}${urlPath}`)
        assert.equal(response.status, 200, filePath)
        assert.deepEqual(
          Buffer.from(await response.arrayBuffer()),
          await readFile(filePath),
          filePath,
        )
        assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/html/, filePath)
      }
    }
    await new Promise<void>((resolveProbe, rejectProbe) => {
      const socket = new WebSocket(`${appUrl.replace("http", "ws")}/ws`, { headers })
      const timer = setTimeout(() => {
        socket.terminate()
        rejectProbe(new Error("WebSocket heartbeat timed out"))
      }, 5000)
      socket.on("open", () => socket.send(JSON.stringify({ type: "ping", sentAt: 123 })))
      socket.on("message", (raw) => {
        const result: unknown = JSON.parse(raw.toString())
        const pong = z
          .object({ type: z.literal("pong"), sentAt: z.literal(123), serverTs: z.number() })
          .safeParse(result)
        if (!pong.success) return
        clearTimeout(timer)
        socket.close()
        resolveProbe()
      })
      socket.on("error", (error) => {
        clearTimeout(timer)
        rejectProbe(error)
      })
    })
    scenarios.push(
      "public/source assets match disk bytes and authenticated WebSocket heartbeat responds",
    )
    const loginResponse = await fetch(`${appUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: appUrl },
      body: JSON.stringify({ operatorId: "runtime-check", token }),
    })
    assert.equal(loginResponse.status, 200)
    const cookies = loginResponse.headers.getSetCookie()
    assert.equal(cookies.length, 2, "Node adapter must preserve separate session and CSRF cookies")
    const sessionCookie = cookies.find((cookie) => cookie.startsWith("sd_session="))
    const csrfCookie = cookies.find((cookie) => cookie.startsWith("sd_csrf="))
    assert.ok(sessionCookie)
    assert.ok(csrfCookie)
    assert.ok(
      cookies.every((cookie) => cookie.split("; ").includes("Secure") === useTls),
      "Secure attributes must match the dashboard transport",
    )
    const loginTelemetry = await fetch(`${appUrl}/api/telemetry`, { headers }).then((r) => r.json())
    const issued = loginTelemetry.rows.find(
      (row: { route: string }) => row.route === "/api/auth/login",
    )?.lastResponse?.cookies
    assert.deepEqual(issued, [
      {
        name: "sd_session",
        expired: false,
        secure: useTls,
        httpOnly: true,
        sameSite: "Lax",
        maxAgeSeconds: 28_800,
      },
      {
        name: "sd_csrf",
        expired: false,
        secure: useTls,
        httpOnly: false,
        sameSite: "Lax",
        maxAgeSeconds: 28_800,
      },
    ])
    const serializedLoginTelemetry = JSON.stringify(loginTelemetry)
    for (const cookie of cookies) {
      const value = cookie.split(";")[0]?.split("=")[1]
      assert.ok(value)
      assert.equal(serializedLoginTelemetry.includes(value), false)
    }
    const sessionHeaders = { cookie: sessionCookie.split(";")[0]! }
    if (useTls) {
      const docsUrl = `${appUrl}/docs/graph.html`
      const forged = await fetch(docsUrl, { headers: { cookie: "sd_session=forged-session" } })
      assert.equal(forged.status, 401)
      assert.equal(forged.headers.getSetCookie().length, 0)
      const docs = await fetch(docsUrl, { headers: sessionHeaders })
      assert.equal(docs.status, 200)
      assert.equal(docs.headers.get("cache-control"), "private, no-cache")
      const refreshed = docs.headers.getSetCookie()
      assert.equal(refreshed.length, 1)
      const cookie = new Bun.Cookie(refreshed[0])
      assert.equal(cookie.name, "sd_session")
      assert.equal(`${cookie.name}=${cookie.value}`, sessionHeaders.cookie)
      assert.equal(cookie.path, "/")
      assert.equal(cookie.httpOnly, true)
      assert.equal(cookie.secure, true)
      assert.ok(cookie.maxAge !== undefined && cookie.maxAge > 0 && cookie.maxAge <= 28_800)
      scenarios.push(
        "native docs validate CookieMap sessions and reissue the cookie within its original expiry",
      )
      const http2 = connectHttp2(appUrl)
      http2.setTimeout(5000, () => http2.destroy(new Error("HTTP/2 docs check timed out")))
      try {
        const bytes = await readFile("docs/assets/ARCH-Guide.jpg")
        const stream = http2.request({
          ":path": "/docs/assets/ARCH-Guide.jpg",
          ...sessionHeaders,
          range: "bytes=-16",
        })
        const [response] = await once(stream, "response")
        assert.equal(http2.alpnProtocol, "h2")
        assert.equal(response[":status"], 206)
        assert.equal(
          response["content-range"],
          `bytes ${bytes.length - 16}-${bytes.length - 1}/${bytes.length}`,
        )
        const received: Buffer[] = []
        for await (const chunk of stream) received.push(Buffer.from(chunk))
        assert.deepEqual(Buffer.concat(received), bytes.subarray(-16))
        assert.ok(response.etag)
        const cached = http2.request({
          ":method": "HEAD",
          ":path": "/docs/assets/ARCH-Guide.jpg",
          ...sessionHeaders,
          "if-none-match": response.etag,
        })
        const [cacheHeaders] = await once(cached, "response")
        assert.equal(cacheHeaders[":status"], 304)
        assert.equal(cacheHeaders.etag, response.etag)
        assert.equal(cacheHeaders["cache-control"], "private, no-cache")
        for await (const _ of cached) assert.fail("HTTP/2 HEAD must not return a body")
      } finally {
        http2.destroy()
      }
      scenarios.push("HTTP/2 sends authenticated BunFile suffix ranges and revalidates HEAD")
    }
    const writeHeaders = {
      ...sessionHeaders,
      "x-csrf-token": csrfCookie.split(";")[0]!.slice("sd_csrf=".length),
      "content-type": "application/json",
    }
    assert.equal(writeHeaders["x-csrf-token"].startsWith("bun2."), serverRuntime === "bun")
    const adminLogin = await fetch(`${appUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: appUrl },
      body: JSON.stringify({ operatorId: "runtime-admin", token: adminToken }),
    })
    assert.equal(adminLogin.status, 200)
    z.object({ role: z.literal("ADMIN") }).parse(await adminLogin.json())
    const adminCookies = adminLogin.headers.getSetCookie()
    const adminSession = adminCookies
      .find((cookie) => cookie.startsWith("sd_session="))
      ?.split(";")[0]
    const adminCsrf = adminCookies
      .find((cookie) => cookie.startsWith("sd_csrf="))
      ?.split(";")[0]
      ?.slice("sd_csrf=".length)
    assert.ok(adminSession && adminCsrf)
    const clientInspectUrl = `${appUrl}/api/r2/client/inspect?colors=false`
    assert.equal((await fetch(clientInspectUrl)).status, 401)
    assert.equal((await fetch(clientInspectUrl, { headers: sessionHeaders })).status, 403)
    const reportResponse = await fetch(clientInspectUrl, { headers: { cookie: adminSession } })
    assert.equal(reportResponse.status, 200)
    assert.equal(reportResponse.headers.get("cache-control"), "no-store")
    const dnsCounter = z.number().int().nonnegative()
    const dnsCache = z
      .object({
        cacheHitsCompleted: dnsCounter,
        cacheHitsInflight: dnsCounter,
        cacheMisses: dnsCounter,
        size: dnsCounter,
        errors: dnsCounter,
        totalCount: dnsCounter,
      })
      .strict()
    const r2Client = z
      .object({
        state: z.string(),
        globalS3Sealed: z.boolean(),
        runtimePreflight: z
          .object({
            bunVersion: z.string(),
            sealedGlobalS3: z.literal(true),
            dnsRequestCount: z.number().int().nonnegative(),
            dnsErrorRatioBps: z.number().int().nonnegative(),
            dnsCache,
          })
          .nullable(),
        runtimeDnsCache: dnsCache.nullable(),
        s3Checks: z.object({ signing: z.string(), object: z.object({ state: z.string() }) }),
        output: z.string(),
        plain: z.string(),
      })
      .parse(await reportResponse.json())
    assert.equal(r2Client.globalS3Sealed, serverRuntime === "bun")
    assert.equal(r2Client.state, serverRuntime === "bun" ? "configured" : "unavailable")
    assert.equal(r2Client.output, r2Client.plain)
    if (serverRuntime === "bun") {
      assert.equal(r2Client.runtimePreflight?.bunVersion, Bun.version)
      assert.ok(r2Client.runtimePreflight.dnsErrorRatioBps <= 500)
      assert.equal(
        r2Client.runtimePreflight.dnsRequestCount,
        r2Client.runtimePreflight.dnsCache.totalCount,
      )
      assert.ok(r2Client.runtimeDnsCache)
      assert.ok(
        r2Client.runtimeDnsCache.totalCount >= r2Client.runtimePreflight.dnsCache.totalCount,
      )
      assert.match(r2Client.output, /ROLE_OPS_ADMIN/)
      assert.match(r2Client.output, /runtime-inspect-fixture/)
      assert.ok(r2Client.output.includes(new URL(privateR2Endpoint).host))
      assert.match(r2Client.output, /\[REDACTED_SECRET\]/)
      assert.equal(r2Client.s3Checks.signing, "verified-offline")
      assert.equal(
        r2Client.s3Checks.object.state,
        s3Upstream ? "not-requested" : "key-not-configured",
      )
    } else {
      assert.equal(r2Client.runtimePreflight, null)
      assert.equal(r2Client.runtimeDnsCache, null)
      assert.equal(r2Client.s3Checks.signing, "unavailable")
      assert.equal(r2Client.s3Checks.object.state, "client-unavailable")
    }
    assert.ok(
      [
        r2ClientFixture.R2_ACCESS_KEY_ID,
        r2ClientFixture.R2_SECRET_ACCESS_KEY,
        r2ClientFixture.R2_SESSION_TOKEN,
      ].every((value) => !JSON.stringify(r2Client).includes(value)),
    )
    scenarios.push("R2 client inspection requires admin access and omits explicit credentials")
    if (s3Upstream) {
      const checkedUrl = `${clientInspectUrl}&s3Check=1`
      assert.equal((await fetch(checkedUrl, { headers: sessionHeaders })).status, 403)
      assert.equal(signedRequestCount, 0)
      const inspectAsAdmin = async (url: string) => {
        const response = await fetch(url, { headers: { cookie: adminSession } })
        assert.equal(response.status, 200)
        const body = await response.text()
        assert.ok(!body.includes(r2HealthcheckKey) && !body.includes("X-Amz-"))
        for (const value of [
          r2ClientFixture.R2_ACCESS_KEY_ID,
          r2ClientFixture.R2_SECRET_ACCESS_KEY,
          r2ClientFixture.R2_SESSION_TOKEN,
        ]) {
          assert.ok(!body.includes(value))
        }
        return z
          .object({
            s3Checks: z.object({
              object: z.object({
                state: z.literal("available"),
                httpStatus: z.literal(200),
                sizeBytes: z.literal(23),
                checkedAt: z.string(),
                durationMs: z.number().nonnegative(),
                source: z.enum(["live", "cache"]),
                freshness: z.literal("fresh"),
                ageMs: z.number().nonnegative(),
              }),
            }),
          })
          .parse(JSON.parse(body)).s3Checks.object
      }
      const [first, second] = await Promise.all([
        inspectAsAdmin(checkedUrl),
        inspectAsAdmin(checkedUrl),
      ])
      assert.equal(first.checkedAt, second.checkedAt)
      assert.ok([first.source, second.source].includes("live"))
      const cached = await inspectAsAdmin(clientInspectUrl)
      assert.equal(cached.source, "cache")
      assert.equal(cached.checkedAt, first.checkedAt)
      assert.equal(signedRequestCount, 1)

      const client = new SealedR2Handle({
        bucket: r2ClientFixture.R2_BUCKET_NAME,
        endpoint: privateR2Endpoint,
        accessKeyId: r2ClientFixture.R2_ACCESS_KEY_ID,
        secretAccessKey: r2ClientFixture.R2_SECRET_ACCESS_KEY,
        sessionToken: r2ClientFixture.R2_SESSION_TOKEN,
      })
      for (const [httpStatus, state] of [
        [403, "access-denied"],
        [404, "not-found"],
        [503, "service-error"],
        [302, "redirect"],
      ] as const) {
        s3Status = httpStatus
        assert.deepEqual(
          await withInspectRole("ROLE_OPS_ADMIN", () => client.probeObject(r2HealthcheckKey)),
          {
            state,
            httpStatus,
            sizeBytes: null,
          },
        )
      }
      assert.equal(signedRequestCount, 5)
      let elapsed = 1000
      const readCheck = createR2ObjectCheck(
        { state: "configured", handle: client },
        r2HealthcheckKey,
        () => elapsed,
      )
      const readAsAdmin = (requested: boolean) =>
        withInspectRole("ROLE_OPS_ADMIN", () => readCheck(requested))
      s3Status = 200
      assert.equal((await readAsAdmin(true)).state, "available")
      elapsed += 30_000
      const stale = await readAsAdmin(false)
      assert.equal(stale.state, "available")
      assert.equal(stale.source, "cache")
      assert.equal(stale.freshness, "stale")
      assert.equal(stale.ageMs, 30_000)
      await assert.rejects(readCheck(false), /ERR_INSP_ROLE_DENIED/)
      s3Status = 404
      const updated = await readAsAdmin(true)
      assert.equal(updated.state, "not-found")
      assert.equal(updated.source, "live")
      assert.equal(updated.freshness, "fresh")
      assert.equal(signedRequestCount, 7)
      scenarios.push(
        "S3 object diagnostics share a signed HEAD, guard cached results, and refresh stale outcomes",
      )
    }
    const getTheme = (cookie: string) => fetch(`${appUrl}/api/profile`, { headers: { cookie } })
    assert.equal((await fetch(`${appUrl}/api/profile`)).status, 401)
    assert.equal(
      (await fetch(`${appUrl}/api/profile`, { headers: { ...headers, ...sessionHeaders } })).status,
      401,
    )
    assert.equal((await getTheme("sd_session=forged-session")).status, 401)
    const theme: ProfileTheme = {
      ...DEFAULT_PROFILE_THEME,
      ui: "dark",
      terminal: { ...DEFAULT_PROFILE_THEME.terminal, colors: false, columns: 96 },
    }
    const savedTheme = await fetch(`${appUrl}/api/profile/theme`, {
      method: "POST",
      headers: { ...writeHeaders, origin: appUrl },
      body: JSON.stringify(theme),
    })
    assert.equal(savedTheme.status, 200)
    const savedThemeBody = await savedTheme.json()
    assert.deepEqual(savedThemeBody.theme, theme)
    assert.equal(savedTheme.headers.getSetCookie().length, 0)
    await restartDashboard(adminToken)
    const restoredTheme = await getTheme(
      `${sessionHeaders.cookie}; sd_csrf=cookie-secret-marker; private-cookie-name=private-value`,
    )
    assert.equal(restoredTheme.status, 200)
    assert.equal(restoredTheme.headers.getSetCookie().length, 0)
    assert.deepEqual(await restoredTheme.json(), savedThemeBody)
    const wrongSessionTheme = await fetch(`${appUrl}/api/profile/theme`, {
      method: "POST",
      headers: { ...writeHeaders, origin: appUrl, "x-csrf-token": adminCsrf },
      body: JSON.stringify(theme),
    })
    assert.equal(wrongSessionTheme.status, 403)
    const wrongOriginTheme = await fetch(`${appUrl}/api/profile/theme`, {
      method: "POST",
      headers: {
        ...writeHeaders,
        origin: "https://other.test",
        "x-forwarded-host": "other.test",
        "x-sportsdesk-profile-origin": "https://other.test",
      },
      body: JSON.stringify(theme),
    })
    assert.equal(wrongOriginTheme.status, 403)
    const wrongSchemeTheme = await fetch(`${appUrl}/api/profile/theme`, {
      method: "POST",
      headers: { ...writeHeaders, origin: appUrl.replace(/^https?:/, useTls ? "http:" : "https:") },
      body: JSON.stringify(theme),
    })
    assert.equal(wrongSchemeTheme.status, 403)
    const ownSessionTheme = await fetch(`${appUrl}/api/profile/theme`, {
      method: "POST",
      headers: { ...writeHeaders, origin: appUrl },
      body: JSON.stringify(theme),
    })
    assert.equal(ownSessionTheme.status, 200)
    scenarios.push(
      "CSRF accepts the session's token after restart and rejects a different session or origin",
    )
    const cookieSnapshot = await fetch(`${appUrl}/api/telemetry`, { headers }).then((r) => r.json())
    const profileCookies = cookieSnapshot.rows.find(
      (row: { route: string }) => row.route === "/api/profile",
    )?.lastRequest?.cookieNames
    assert.deepEqual(profileCookies, ["sd_session", "sd_csrf"])
    assert.doesNotMatch(
      JSON.stringify(cookieSnapshot),
      /cookie-secret-marker|private-cookie-name|private-value/,
    )
    const otherTheme = await getTheme(adminSession)
    assert.equal(otherTheme.status, 200)
    assert.deepEqual((await otherTheme.json()).theme, DEFAULT_PROFILE_THEME)
    const renderTheme = await fetch(`${appUrl}/api/profile/render.md`, { headers: sessionHeaders })
    assert.equal(renderTheme.status, 200)
    const preview = await renderTheme.text()
    assert.match(preview, /dark/)
    assert.match(preview, /96/)
    assert.doesNotMatch(preview, /\x1b\[/)
    scenarios.push(
      "SQLite restores the saved theme after restart, isolates sessions, and applies it to the terminal preview",
    )
    const ansiDocUrl = appUrl + "/docs/live-customer-sources/ansi"
    assert.equal((await fetch(ansiDocUrl)).status, 401)
    assert.equal(
      (await fetch(ansiDocUrl, { headers: { cookie: "sd_session=forged-session" } })).status,
      401,
    )
    const ansiDoc = await fetch(ansiDocUrl, { headers: sessionHeaders })
    assert.equal(ansiDoc.status, 200)
    assert.equal(ansiDoc.headers.get("content-type"), "text/plain; charset=utf-8")
    assert.equal(ansiDoc.headers.get("cache-control"), "no-store")
    assert.equal(ansiDoc.headers.get("vary"), "Accept, Cookie")
    assert.equal(
      ansiDoc.headers.get("x-rendered"),
      serverRuntime === "bun" ? "ansi-gfm" : "ansi-compat",
    )
    const ansiText = await ansiDoc.text()
    assert.match(ansiText, /Local live customer identities/)
    assert.doesNotMatch(ansiText, /\x1b/)
    const adminDoc = await fetch(ansiDocUrl, { headers: { cookie: adminSession } })
    assert.equal(adminDoc.status, 200)
    assert.match(await adminDoc.text(), /\x1b\[/)
    const accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    const adminBrowser = await fetch(ansiDocUrl, { headers: { cookie: adminSession, accept } })
    assert.equal(adminBrowser.status, 200)
    assert.equal(adminBrowser.headers.get("content-type"), "text/html; charset=utf-8")
    assert.equal(adminBrowser.headers.get("x-rendered"), "docs-preview")
    const adminPreview = await adminBrowser.text()
    assert.match(adminPreview, /href="\/\?tab=terminal&amp;terminal=profiles">Terminal profiles/)
    assert.match(adminPreview, /href="\?format=ansi"/)
    assert.match(adminPreview, /Local live customer identities/)
    assert.doesNotMatch(adminPreview, /\x1b/)
    const operatorBrowser = await fetch(ansiDocUrl, { headers: { ...sessionHeaders, accept } })
    const operatorPreview = await operatorBrowser.text()
    assert.equal(operatorBrowser.status, 200)
    assert.match(operatorPreview, /href="\/\?tab=customers">Customer profiles/)
    assert.doesNotMatch(operatorPreview, /terminal=profiles/)
    const download = await fetch(ansiDocUrl + "?format=ansi", {
      headers: { cookie: adminSession, accept },
    })
    assert.equal(download.headers.get("content-type"), "text/plain; charset=utf-8")
    assert.match(await download.text(), /\x1b\[/)
    const docHead = await fetch(ansiDocUrl, { method: "HEAD", headers: sessionHeaders })
    assert.equal(docHead.status, 200)
    assert.equal(docHead.headers.get("x-rendered"), ansiDoc.headers.get("x-rendered"))
    assert.equal(await docHead.text(), "")
    for (const name of ["missing-doc", "missing%2Fdocument", "graph"]) {
      const missing = await fetch(appUrl + "/docs/" + name + "/ansi", { headers: sessionHeaders })
      assert.equal(missing.status, 404)
    }
    const sourceDoc = await fetch(appUrl + "/docs/live-customer-sources.md", {
      headers: sessionHeaders,
    })
    assert.equal(sourceDoc.status, 200)
    assert.equal(await sourceDoc.text(), await readFile("docs/live-customer-sources.md", "utf8"))
    scenarios.push(
      "authenticated docs link each role to its profiles and preserve themed ANSI and raw Markdown",
    )
    const terminal = (credentialHeaders: Record<string, string>, command = "help") =>
      fetch(`${appUrl}/api/terminal/exec`, {
        method: "POST",
        headers: { "content-type": "application/json", ...credentialHeaders },
        body: JSON.stringify({ command }),
      })
    const adminHeaders = { cookie: adminSession, "x-csrf-token": adminCsrf }
    assert.equal((await terminal(adminHeaders)).status, 200)
    assert.equal((await terminal({ cookie: adminSession })).status, 403)
    assert.equal((await terminal({ ...writeHeaders, "x-admin-token": adminToken })).status, 403)
    const adminTheme: ProfileTheme = {
      ...DEFAULT_PROFILE_THEME,
      inspect: { ...DEFAULT_PROFILE_THEME.inspect, depth: 1, colors: false },
    }
    assert.equal(
      (
        await fetch(appUrl + "/api/profile/theme", {
          method: "POST",
          headers: { ...adminHeaders, "content-type": "application/json", origin: appUrl },
          body: JSON.stringify(adminTheme),
        })
      ).status,
      200,
    )
    const inspectTerminal = async (command: string) => {
      const response = await terminal(adminHeaders, command)
      assert.equal(response.status, 200)
      return z.object({ stdout: z.string(), exitCode: z.literal(0) }).parse(await response.json())
        .stdout
    }
    const sessionOutput = await inspectTerminal("inspect-options")
    assert.match(sessionOutput, /depth: 1,/)
    assert.match(sessionOutput, /colors: false,/)
    assert.doesNotMatch(sessionOutput, /\x1b/)
    assert.doesNotMatch(await inspectTerminal("help"), /\x1b/)
    const override = await inspectTerminal("inspect-options --depth=3 --colors")
    assert.match(override, /depth: 3,/)
    assert.match(override, /\x1b\[/)
    assert.equal((await terminal(adminHeaders, "harvest")).status, 400)
    assert.deepEqual((await (await getTheme(sessionHeaders.cookie)).json()).theme, theme)
    scenarios.push(
      "terminal commands use their session's saved inspection settings and honor explicit flags",
    )
    const invalidTransform = await fetch(`${appUrl}/api/diagnostics/image-assets/transform`, {
      method: "POST",
      headers: { ...adminHeaders, "content-type": "application/json" },
      body: "{}",
    })
    assert.equal(
      invalidTransform.status,
      400,
      "Admin session passes the Express gate and reaches asset validation",
    )
    scenarios.push(
      "operator and admin sessions survive a server restart; browser admin actions enforce role and CSRF",
    )
    const me = await fetch(`${appUrl}/api/auth/me`, { headers: sessionHeaders })
    assert.equal(me.status, 200)
    z.object({ authenticated: z.literal(true), operatorId: z.literal("runtime-check") }).parse(
      await me.json(),
    )
    scenarios.push(
      `login issues ${useTls ? "Secure HTTPS" : "loopback HTTP"} cookies and identifies the operator`,
    )
    // Keep the fixture client's original cookie across logout to verify server-side revocation.
    const protectedProfile = () =>
      fetch(`${appUrl}/api/profiles/inspect?id=ACCOUNT1`, {
        headers: sessionHeaders,
        redirect: "error",
      })
    const beforeLogout = await protectedProfile()
    assert.equal(beforeLogout.status, 200)
    z.object({ selectedId: z.literal("ACCOUNT1") }).parse(await beforeLogout.json())
    const logoutRequest = (logoutHeaders: Record<string, string>) =>
      fetch(`${appUrl}/api/auth/logout`, {
        method: "POST",
        headers: logoutHeaders,
      })
    assert.equal((await logoutRequest(sessionHeaders)).status, 403)
    assert.equal((await protectedProfile()).status, 200)
    const sessionSocket = new WebSocket(`${appUrl.replace("http", "ws")}/ws`, {
      headers: sessionHeaders,
    })
    const opened = new Promise<void>((resolveOpen, rejectOpen) => {
      sessionSocket.once("open", resolveOpen)
      sessionSocket.once("error", rejectOpen)
    })
    const ended = new Promise<number>((resolveClose) => sessionSocket.once("close", resolveClose))
    try {
      await opened
      const logout = await logoutRequest(writeHeaders)
      assert.equal(logout.status, 200)
      const expiredCookies = logout.headers.getSetCookie()
      assert.equal(expiredCookies.length, 2)
      for (const cookie of expiredCookies) {
        const [value, ...attributes] = cookie.split("; ")
        assert.match(value, /^sd_(session|csrf)=$/)
        assert.ok(attributes.includes("Path=/"))
        assert.ok(attributes.includes("Max-Age=0"))
        assert.ok(attributes.includes("SameSite=Lax"))
        assert.equal(attributes.includes("HttpOnly"), value === "sd_session=")
      }
      const logoutTelemetry = await fetch(`${appUrl}/api/telemetry`, { headers }).then((r) =>
        r.json(),
      )
      const expired = logoutTelemetry.rows.find(
        (row: { route: string }) => row.route === "/api/auth/logout",
      )?.lastResponse?.cookies
      assert.deepEqual(
        expired?.map((cookie: { name: string; expired: boolean; maxAgeSeconds: number }) => [
          cookie.name,
          cookie.expired,
          cookie.maxAgeSeconds,
        ]),
        [
          ["sd_session", true, 0],
          ["sd_csrf", true, 0],
        ],
      )
      z.object({ authenticated: z.literal(false) }).parse(await logout.json())
      const deadline = AbortSignal.timeout(3_000)
      assert.equal(
        await Promise.race([
          ended,
          new Promise((_, reject) =>
            deadline.addEventListener("abort", () => reject(deadline.reason)),
          ),
        ]),
        1008,
      )
    } finally {
      sessionSocket.terminate()
    }
    const afterLogout = await protectedProfile()
    assert.equal((await fetch(ansiDocUrl, { headers: sessionHeaders })).status, 401)
    assert.equal(afterLogout.status, 401)
    assert.equal((await getTheme(sessionHeaders.cookie)).status, 401)
    z.object({ code: z.literal("UNAUTHENTICATED") }).parse(await afterLogout.json())
    await restartDashboard(crypto.randomUUID())
    assert.equal((await protectedProfile()).status, 401)
    if (useTls)
      assert.equal(
        (await fetch(`${appUrl}/docs/graph.html`, { headers: sessionHeaders })).status,
        401,
      )
    assert.equal((await terminal(adminHeaders)).status, 401)
    await restartDashboard(adminToken)
    assert.equal((await terminal(adminHeaders)).status, 401)
    scenarios.push(
      "logout revokes the cookie and WebSocket; restart preserves revocation and rotated admin credentials invalidate old sessions",
    )
    if (browser) {
      const profileDirectory = join(directory, `${browser}-profile`)
      await mkdir(profileDirectory, { mode: 0o700 })
      await verifyBrowserSession(appUrl, token, profileDirectory, browser)
      scenarios.push(
        `${browser} preserves sign-in across profile reopening and denies protected profiles after sign-out, reload and reopening`,
      )
    }
    const inspectionSchema = z.object({
      selectedId: z.string().nullable(),
      summary: z.object({
        avgSharpness: z.null(),
        alertCount: z.null(),
        totalVar95Usd: z.null(),
        totalLimitCapUsd: z.null(),
      }),
      profileAnsi: z.string(),
      cohortAnsi: z.string(),
      tableAnsi: z.string(),
      radarAnsi: z.string(),
    })
    for (const id of ["ACCOUNT1", "IDENTITY_ONLY"]) {
      const response = await fetch(`${appUrl}/api/profiles/inspect?id=${id}&colors=false`, {
        headers,
      })
      assert.equal(response.status, 200)
      const payload = inspectionSchema.parse(await response.json())
      assert.equal(payload.selectedId, id)
      assert.match(payload.profileAnsi, new RegExp(id))
      assert.match(payload.profileAnsi, /unavailable|unmeasured/i)
      assert.doesNotMatch(JSON.stringify(payload), /48,?500|BILLY666|NaN/)
      if (id === "ACCOUNT1") {
        assert.match(payload.profileAnsi, /retained/i)
        assert.match(payload.profileAnsi, /150/)
      }
    }
    const browserRows = bookRowsToProfiles(
      [
        {
          customer_id: "ACCOUNT1",
          provenance: "projected-manager-roster",
          retained_history: retainedProjection.records[0]!.metrics,
        },
        { customer_id: "IDENTITY_ONLY", provenance: "projected-manager-roster" },
      ],
      "book",
    )
    const postInspection = await fetch(`${appUrl}/api/profiles/inspect`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        profiles: browserRows,
        selectedId: "ACCOUNT1",
        options: { colors: false },
      }),
    })
    assert.equal(postInspection.status, 200)
    const browserInspection = inspectionSchema.parse(await postInspection.json())
    assert.match(browserInspection.profileAnsi, /retained/i)
    assert.match(browserInspection.profileAnsi, /150/)
    assert.doesNotMatch(JSON.stringify(browserInspection), /48,?500|BILLY666|NaN/)
    const forgedInspection = await fetch(`${appUrl}/api/profiles/inspect`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        profiles: browserRows.map((row) => ({
          ...row,
          meanStake: 999999,
          score: 10,
          var95Usd: 999999,
        })),
        selectedId: "ACCOUNT1",
        options: { colors: false },
      }),
    })
    assert.equal(forgedInspection.status, 200)
    const canonicalInspection = inspectionSchema.parse(await forgedInspection.json())
    assert.match(canonicalInspection.profileAnsi, /150/)
    assert.doesNotMatch(canonicalInspection.profileAnsi, /999,?999/)
    scenarios.push(
      "live GET and browser POST inspection preserve retained measurements and unavailable risk summaries",
    )
    for (const command of [
      "profile ACCOUNT1 --no-color",
      "profile ACCOUNT1 --json --no-color",
      "profile IDENTITY_ONLY --no-color",
      "profiles --no-color",
    ]) {
      const response = await fetch(`${appUrl}/api/terminal/exec`, {
        method: "POST",
        headers: { ...headers, "x-admin-token": adminToken, "content-type": "application/json" },
        body: JSON.stringify({ command }),
      })
      assert.equal(response.status, 200)
      const result = z
        .object({ stdout: z.string(), exitCode: z.literal(0) })
        .parse(await response.json())
      assert.match(result.stdout, /ACCOUNT1|IDENTITY_ONLY/)
      assert.doesNotMatch(result.stdout, /48,?500|BILLY666|NaN/)
      if (command === "profile ACCOUNT1 --no-color") {
        assert.match(result.stdout, /retained/i)
        assert.match(result.stdout, /150/)
      }
      if (command.includes("--json")) assert.match(result.stdout, /score:\s*null/)
    }
    scenarios.push(
      "production terminal profile, JSON and cohort entrypoints withhold unsupported live values",
    )
    const healthy = await readPipeline()
    assert.equal(healthy.bucketPublicBase, `${upstreamUrl}/r2`)
    assert.equal(healthy.daemon4020.url, `${upstreamUrl}/daemon/health`)
    assert.equal(healthy.daemon4020.state, "online")
    assert.equal(healthy.overallStatus, "fresh")
    assert.equal(healthy.freshCount, 4)
    assert.equal(healthy.automations.bridgeRollupUpdatedAt, recordedAt)
    assert.equal(healthy.automations.source, "collector-state")
    assert.deepEqual(healthy.automations.schedules, [])
    scenarios.push("configured daemon, R2 origin and receipt flow through production HTTP API")
    daemonStatus = 503
    dataAgeMs = 10 * 86_400_000
    await writeCollectorReceipt(false)
    const stale = await readPipeline()
    assert.equal(stale.daemon4020.state, "degraded")
    assert.equal(stale.daemon4020.online, true)
    assert.equal(stale.publishFreshCount, 4)
    assert.equal(stale.freshCount, 0)
    assert.equal(stale.dataStaleKeys.length, 4)
    assert.equal(stale.automations.bridgeJobs[0]?.ok, false)
    assert.equal(stale.overallStatus, "degraded")
    scenarios.push(
      "auth-down daemon and failed capture remain degraded despite recent R2 publication",
    )
    await rm(statePath)
    dataAgeMs = null
    const missing = await readPipeline()
    assert.equal(missing.automations.source, "unavailable")
    assert.deepEqual(missing.automations.bridgeJobs, [])
    assert.equal(missing.freshCount, 0)
    assert.equal(missing.overallStatus, "degraded")
    scenarios.push("missing receipts and generation-only objects never report successful capture")
    const statusResponse = await fetch(`${appUrl}/api/status`, { headers })
    assert.equal(statusResponse.status, 200)
    const status = z
      .object({ daemon4020Online: z.boolean(), daemon4020: z.object({ state: z.string() }) })
      .parse(await statusResponse.json())
    assert.equal(status.daemon4020Online, true)
    assert.equal(status.daemon4020.state, "degraded")
    scenarios.push("status endpoint measures daemon reachability rather than returning a constant")
    assert.ok(daemonRequests >= 4)
    assert.ok(r2Requests >= 12)
    await mkdir(".local", { recursive: true })
    await writeFile(
      ".local/runtime-verification.json",
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          bunVersion: Bun.version,
          mode: "controlled-local-upstreams",
          liveAuthenticationVerified: false,
          scenarios,
          daemonRequests,
          r2Requests,
        },
        null,
        2,
      ),
    )
    for (const scenario of scenarios) console.log(`PASS: ${scenario}`)
    console.log(
      "Evidence: .local/runtime-verification.json (controlled local upstreams; no live API keys used)",
    )
  } finally {
    await stopDashboard()
    upstream.stop(true)
    s3Upstream?.stop(true)
    await rm(directory, { recursive: true, force: true })
  }
}

const args = process.argv.slice(2)
const [option] = args.filter((arg) => arg !== "--bun-server" && arg !== "--tls")
const bunServer = args.includes("--bun-server")
const useTls = args.includes("--tls")
const browsers = new Map<string, BrowserBackend>([
  ["--webkit", "webkit"],
  ["--chrome", "chrome"],
  ["--edge", "edge"],
])
const browser = option === undefined ? undefined : browsers.get(option)
if (option === "--help" && args.length === 1) {
  console.log(
    "Verify the production server against isolated local fixtures.\nUsage: bun run check:runtime [--bun-server [--tls]] [--webkit | --chrome | --edge]\nUse --tls with SPORTSDESK_TLS_CERT_PATH and SPORTSDESK_TLS_KEY_PATH and trust the issuing CA.\nUse --webkit on macOS, --chrome with Google Chrome installed, or --edge on Windows with BUN_CHROME_PATH set to msedge.exe to verify browser session persistence.\nRun bun run build first.",
  )
} else if (args.length !== Number(bunServer) + Number(useTls) + Number(Boolean(browser))) {
  console.error("Unknown argument. Run bun run check:runtime --help.")
  process.exitCode = 2
} else {
  try {
    await verifyRuntimeConnections(browser, bunServer ? "bun" : "node", useTls)
  } catch (error: unknown) {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
