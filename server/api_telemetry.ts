import type { IncomingMessage, ServerResponse } from "node:http"
import { TLSSocket } from "node:tls"
import { DASHBOARD_COOKIE_NAMES, readDashboardCookieNames } from "../lib/http_auth.ts"
import type {
  ApiResponseType,
  ApiTelemetryCounts,
  ApiTelemetryLatencyBand,
  ApiTelemetryParams,
  ApiTelemetryRequest,
  ApiTelemetryRequestBody,
  ApiTelemetryResponse,
  ApiTelemetryResponseBody,
  ApiTelemetryResponseCookie,
  ApiTelemetryRow,
  ApiTelemetrySnapshot,
} from "@sportsdesk-ops/contracts"

declare const Bun: Pick<typeof import("bun"), "Cookie">

const BUCKET_MS = 15_000
const WINDOW_BUCKETS = 60
const LATENCY_BOUNDS_MS = [
  0.5, 1, 2, 5, 10, 20, 35, 50, 75, 100, 150, 250, 500, 750, 1000, 1500, 2500, 5000, 10000, 30000,
  60000,
]
const API_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
const UNMATCHED_ROUTE = "/api/:unmatched"
const INSPECT_QUERY_PARAMS = [
  "options",
  "colors",
  "compact",
  "sorted",
  "depth",
  "showHidden",
  "show_hidden",
  "maxArrayLength",
  "maxArray",
  "max_array",
  "maxStringLength",
  "maxString",
  "max_string",
  "breakLength",
  "width",
  "break_length",
  "numericSeparator",
  "numeric_separator",
  "getters",
  "showOptions",
  "show_options",
]
// Request keys may themselves contain private data. Retain only names the matched route recognizes.
const ROUTE_QUERY_PARAMS = new Map<string, readonly string[]>([
  ["/api/diagnostics/image-assets", ["refresh", "root"]],
  ["/api/diagnostics/image-assets/raw", ["source"]],
  ["/api/weblogs/parlay-comparison", ["day", "source", "account"]],
  [
    "/api/weblogs",
    [
      "sort",
      "dir",
      "ip",
      "ipFamily",
      "limit",
      "offset",
      "kind",
      "site",
      "version",
      "market",
      "account",
      "severity",
      "q",
      ...INSPECT_QUERY_PARAMS,
    ],
  ],
  ["/api/profiles/inspect", ["tier", "q", "id", "sort", "dir", ...INSPECT_QUERY_PARAMS]],
  ["/api/dns/benchmark", ["host"]],
  ["/api/dns/reverse", ["ip"]],
  ["/api/customer/profile", ["id"]],
  ["/api/customer/rating", ["id"]],
  ["/api/rankings/all", ["limit"]],
  ["/api/alerts", ["status"]],
  ["/api/shift/summary", ["operatorId"]],
  [
    "/api/shadow-pricing",
    [
      "source",
      "sport",
      "subSport",
      "period",
      "market",
      "regime",
      "ladder3",
      "ladder7",
      "ladderOther",
      "minVolume",
      "elasticity",
      "mode",
      "routerAudit",
    ],
  ],
  ["/api/build-matrix", ["refresh"]],
  ["/api/bet-ticker", ["writer", "type", "wagerType"]],
  ["/api/r2/pipeline", ["refresh"]],
  ["/api/r2/client/inspect", [...INSPECT_QUERY_PARAMS, "s3Check"]],
  ["/api/r2/pipeline/history", ["refresh", "limit"]],
  ["/api/r2/image-provenance", ["key"]],
])
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i
const CHARSET =
  /^charset\s*=\s*(?:"(utf-8|us-ascii|iso-8859-1|utf-16(?:le|be)?)"|(utf-8|us-ascii|iso-8859-1|utf-16(?:le|be)?))$/i
const ENTITY_TAG = /^(?:W\/)?"[\x21\x23-\x7e]{0,256}"$/

type HeaderValue = string | number | readonly string[] | undefined
interface ResponseHeaders {
  readonly etag?: HeaderValue
  readonly contentType?: HeaderValue
  readonly contentLength?: HeaderValue
  readonly body?: ApiTelemetryResponseBody
  readonly setCookie?: HeaderValue
}

function readResponseCookies(header: HeaderValue): readonly ApiTelemetryResponseCookie[] {
  const values = typeof header === "string" ? [header] : (header ?? [])
  if (typeof values === "number") return []
  const cookies: ApiTelemetryResponseCookie[] = []
  for (const value of values) {
    const firstEquals = value.indexOf("=")
    const name = value.slice(0, firstEquals).trim()
    if (firstEquals < 1 || !DASHBOARD_COOKIE_NAMES.includes(name)) continue
    const attributes = value
      .split(";")
      .slice(1)
      .map((part) => part.trim().toLowerCase())
    const sameSiteRaw = attributes.find((part) => part.startsWith("samesite="))?.slice(9)
    const maxAgeRaw = attributes.find((part) => part.startsWith("max-age="))?.slice(8)
    const fallbackAge = maxAgeRaw && /^-?\d+$/.test(maxAgeRaw) ? Number(maxAgeRaw) : null
    let native: InstanceType<typeof Bun.Cookie> | undefined
    if (typeof Bun !== "undefined") {
      try {
        native = new Bun.Cookie(value)
      } catch {
        // Keep the allowlisted attributes available when a header is malformed.
      }
    }
    const sameSite =
      sameSiteRaw === "lax"
        ? "Lax"
        : sameSiteRaw === "strict"
          ? "Strict"
          : sameSiteRaw === "none"
            ? "None"
            : null
    const age = fallbackAge === null ? null : (native?.maxAge ?? fallbackAge)
    const maxAgeSeconds = age !== null && Number.isSafeInteger(age) ? age : null
    const expiresAt =
      native?.expires?.getTime() ??
      Date.parse(attributes.find((part) => part.startsWith("expires="))?.slice(8) ?? "")
    const expired = maxAgeSeconds === null ? expiresAt <= Date.now() : maxAgeSeconds <= 0
    cookies.push({
      name,
      expired,
      maxAgeSeconds,
      sameSite,
      secure: native?.secure ?? attributes.includes("secure"),
      httpOnly: native?.httpOnly ?? attributes.includes("httponly"),
    })
  }
  return cookies
}

function readMediaType(value: HeaderValue) {
  const [media, ...parameters] =
    typeof value === "string" && value.length <= 512
      ? value
          .toLowerCase()
          .split(";")
          .map((part) => part.trim())
      : []
  const mimeType = media && MIME_TYPE.test(media) ? media : null
  const charset = parameters.map((part) => CHARSET.exec(part)).find((match) => match !== null)
  return {
    mimeType,
    contentType:
      mimeType && charset ? `${mimeType}; charset=${charset[1] ?? charset[2]}` : mimeType,
  }
}

function readRequestBody(request: IncomingMessage): ApiTelemetryRequestBody {
  const transfer = request.headers["transfer-encoding"]
  if (typeof transfer === "string") {
    return {
      framing: transfer
        .toLowerCase()
        .split(",")
        .some((item) => item.trim() === "chunked")
        ? "Chunked"
        : "Unknown length",
      declaredBytes: null,
    }
  }
  const length = request.headers["content-length"]
  if (length === undefined) {
    return request.httpVersionMajor === 1
      ? { framing: "No body", declaredBytes: 0 }
      : { framing: "Unknown length", declaredBytes: null }
  }
  const bytes = Number(length)
  return /^\d+$/.test(length) && Number.isSafeInteger(bytes)
    ? { framing: "Content-Length", declaredBytes: bytes }
    : { framing: "Unknown length", declaredBytes: null }
}

function readRequest(request: IncomingMessage, ingress?: "bun-tls"): ApiTelemetryRequest {
  const { socket } = request
  const encrypted = "encrypted" in socket && socket.encrypted === true
  const body = readRequestBody(request)
  return {
    scheme: ingress || encrypted ? "https" : "http",
    httpVersion: !ingress && /^\d+\.\d+$/.test(request.httpVersion) ? request.httpVersion : null,
    tlsVersion: socket instanceof TLSSocket ? socket.getProtocol() : null,
    contentType: readMediaType(request.headers["content-type"]).contentType,
    cookieNames: readDashboardCookieNames(request.headers.cookie),
    body:
      ingress && body.framing === "Chunked"
        ? { framing: "Unknown length", declaredBytes: null }
        : body,
  }
}

function responseHasNoBody(method: string, status: number): boolean {
  return method === "HEAD" || status < 200 || status === 204 || status === 205 || status === 304
}

function payloadBytes(chunk: unknown, encoding: BufferEncoding | undefined): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk, encoding)
  return chunk instanceof Uint8Array ? chunk.byteLength : 0
}

function observeResponseBody(response: ServerResponse) {
  let bytes = 0
  let chunks = 0
  let streamed = false
  const write = response.write.bind(response)
  const end = response.end.bind(response)

  function countChunk(chunk: unknown, encoding: BufferEncoding | undefined) {
    const length = payloadBytes(chunk, encoding)
    if (length > 0) {
      bytes += length
      chunks++
    }
    return length
  }

  // Observe writes without consuming a stream, buffering a payload, or altering backpressure.
  response.write = (
    chunk: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (countChunk(chunk, typeof encoding === "string" ? encoding : undefined) > 0) streamed = true
    return typeof encoding === "string" ? write(chunk, encoding, callback) : write(chunk, encoding)
  }
  response.end = (
    chunk?: unknown,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    countChunk(chunk, typeof encoding === "string" ? encoding : undefined)
    return typeof encoding === "string" ? end(chunk, encoding, callback) : end(chunk, encoding)
  }

  return (method: string): ApiTelemetryResponseBody =>
    responseHasNoBody(method, response.statusCode) || bytes === 0
      ? { delivery: "No body", bytes: 0, chunks: 0 }
      : { delivery: streamed ? "Streamed" : "Buffered", bytes, chunks }
}

function readParameterNames(route: string, search: string): ApiTelemetryParams {
  const allowed = ROUTE_QUERY_PARAMS.get(route)
  const query = search && allowed ? new URLSearchParams(search) : null
  return {
    path:
      route === UNMATCHED_ROUTE
        ? []
        : route
            .split("/")
            .filter((part) => part.startsWith(":"))
            .map((part) => part.slice(1)),
    query: query && allowed ? allowed.filter((name) => query.has(name)) : [],
  }
}

function classifyResponseType(
  method: string,
  status: number,
  mimeType: string | null,
  length: HeaderValue,
): ApiResponseType {
  if (responseHasNoBody(method, status) || length === 0 || length === "0") return "No body"
  if (!mimeType) return "Unknown"
  if (mimeType === "application/x-ndjson" || mimeType === "application/ndjson") return "NDJSON"
  if (mimeType === "application/json-seq") return "JSON sequence"
  if (mimeType === "application/json" || mimeType.endsWith("+json")) return "JSON"
  if (mimeType === "text/html" || mimeType === "application/xhtml+xml") return "HTML"
  if (mimeType === "text/event-stream") return "Event stream"
  if (mimeType === "text/csv") return "CSV"
  if (mimeType.startsWith("multipart/")) return "Multipart"
  if (mimeType.startsWith("image/")) return "Image"
  if (mimeType.startsWith("audio/")) return "Audio"
  if (mimeType.startsWith("video/")) return "Video"
  if (mimeType.endsWith("/xml") || mimeType.endsWith("+xml")) return "XML"
  if (mimeType.startsWith("text/") || mimeType === "application/javascript") return "Text"
  return "Binary"
}

function readResponse(
  method: string,
  status: number,
  headers?: ResponseHeaders,
): ApiTelemetryResponse {
  const { etag, contentLength, body } = headers ?? {}
  const { mimeType, contentType } = readMediaType(headers?.contentType)
  return {
    etag: typeof etag === "string" && ENTITY_TAG.test(etag) ? etag : null,
    contentType,
    type: classifyResponseType(method, status, mimeType, body?.bytes ?? contentLength),
    body: body ?? null,
    cookies: readResponseCookies(headers?.setCookie),
  }
}

function createTotals() {
  return {
    success: 0,
    redirects: 0,
    clientErrors: 0,
    serverErrors: 0,
    aborted: 0,
    responses: 0,
    totalMs: 0,
    maxMs: 0,
    histogram: new Uint32Array(LATENCY_BOUNDS_MS.length + 1),
  }
}

type Totals = ReturnType<typeof createTotals>
type LastRequest = Pick<
  ApiTelemetryRow,
  "lastStatus" | "lastMs" | "lastAtMs" | "lastResponse" | "lastRequest" | "lastParams"
>
type BucketRow = Totals & { statusCounts: Map<number, number>; last: LastRequest | null }
type TimeBucket = { epoch: number; rows: Map<string, BucketRow> }

function createBucketRow(): BucketRow {
  return { ...createTotals(), statusCounts: new Map(), last: null }
}

function readLatencyBands(histogram: Uint32Array): ApiTelemetryLatencyBand[] {
  const bands: ApiTelemetryLatencyBand[] = []
  histogram.forEach((count, index) => {
    if (count > 0) {
      bands.push({
        lowerExclusiveMs: LATENCY_BOUNDS_MS[index - 1] ?? null,
        upperInclusiveMs: LATENCY_BOUNDS_MS[index] ?? null,
        count,
      })
    }
  })
  return bands
}

function mergeTotals(target: Totals, source: Totals) {
  target.success += source.success
  target.redirects += source.redirects
  target.clientErrors += source.clientErrors
  target.serverErrors += source.serverErrors
  target.aborted += source.aborted
  target.responses += source.responses
  target.totalMs += source.totalMs
  target.maxMs = Math.max(target.maxMs, source.maxMs)
  source.histogram.forEach((count, index) => {
    target.histogram[index] += count
  })
}

function summarize(totals: Totals, inFlight: number): ApiTelemetryCounts {
  const { success, redirects, clientErrors, serverErrors, aborted, responses } = totals
  let p95UpperMs = null
  if (responses > 0) {
    const rank = Math.ceil(responses * 0.95)
    let count = 0
    const index = totals.histogram.findIndex((size) => (count += size) >= rank)
    p95UpperMs = LATENCY_BOUNDS_MS[index] ?? Math.ceil(totals.maxMs)
  }
  return {
    completed: responses + aborted,
    success,
    redirects,
    clientErrors,
    serverErrors,
    aborted,
    inFlight,
    avgMs: responses ? Math.round((totals.totalMs / responses) * 10) / 10 : null,
    p95UpperMs,
  }
}

export class ApiTelemetry {
  private readonly exactRoutes = new Map<string, string>()
  private readonly parameterRoutes: { path: string; pattern: RegExp }[] = []
  private readonly inFlight = new Map<string, number>()
  private readonly buckets: (TimeBucket | undefined)[] = Array(WINDOW_BUCKETS)
  private readonly startedAtMs: number

  constructor(private readonly clock = () => performance.timeOrigin + performance.now()) {
    this.startedAtMs = clock()
  }

  /** Source paths come from route registration. Only these labels can reach the meter. */
  declareRoute(path: string): string {
    if (!path.startsWith("/api/") || path.includes("*")) return path
    if (path.includes(":")) {
      const pattern = path
        .split("/")
        .map((part) =>
          part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("/")
      this.parameterRoutes.push({ path, pattern: new RegExp(`^${pattern}$`, "i") })
    } else {
      this.exactRoutes.set(path.toLowerCase(), path)
    }
    return path
  }

  resolveRoute(pathname: string): string {
    const path = pathname.replace(/\/+$/, "")
    return (
      this.exactRoutes.get(path.toLowerCase()) ??
      this.parameterRoutes.find(({ pattern }) => pattern.test(path))?.path ??
      UNMATCHED_ROUTE
    )
  }

  start(
    method: string,
    route: string,
    search = "",
    request: ApiTelemetryRequest | null = null,
  ): (status: number | null, headers?: ResponseHeaders) => void {
    const key = `${API_METHODS.has(method) ? method : "OTHER"} ${route}`
    const params = readParameterNames(route, search)
    const startedAt = this.clock()
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1)
    let completed = false
    return (status, headers) => {
      if (completed) return
      completed = true
      const active = this.inFlight.get(key) ?? 0
      if (active <= 1) this.inFlight.delete(key)
      else this.inFlight.set(key, active - 1)

      const now = this.clock()
      const epoch = Math.floor(now / BUCKET_MS)
      const index = epoch % WINDOW_BUCKETS
      let bucket = this.buckets[index]
      if (bucket?.epoch !== epoch) {
        bucket = { epoch, rows: new Map() }
        this.buckets[index] = bucket
      }
      let row = bucket.rows.get(key)
      if (!row) {
        row = createBucketRow()
        bucket.rows.set(key, row)
      }
      const duration = Math.max(0, now - startedAt)
      row.last = {
        lastStatus: status,
        lastMs: Math.round(duration * 10) / 10,
        lastAtMs: now,
        lastResponse: status === null ? null : readResponse(method, status, headers),
        lastRequest: request,
        lastParams: params,
      }
      if (status === null) {
        row.aborted++
        return
      }
      row.statusCounts.set(status, (row.statusCounts.get(status) ?? 0) + 1)
      if (status >= 500) row.serverErrors++
      else if (status >= 400) row.clientErrors++
      else if (status >= 300) row.redirects++
      else row.success++
      row.responses++
      row.totalMs += duration
      row.maxMs = Math.max(row.maxMs, duration)
      const bin = LATENCY_BOUNDS_MS.findIndex((upper) => duration <= upper)
      row.histogram[bin === -1 ? LATENCY_BOUNDS_MS.length : bin]++
    }
  }

  snapshot(
    router: ApiTelemetrySnapshot["router"],
    selection?: Pick<ApiTelemetryRow, "method" | "route">,
  ): ApiTelemetrySnapshot {
    const sampledAtMs = this.clock()
    const epoch = Math.floor(sampledAtMs / BUCKET_MS)
    const firstEpoch = epoch - WINDOW_BUCKETS + 1
    const windowStartMs = Math.max(this.startedAtMs, firstEpoch * BUCKET_MS)
    const selectedKey = selection && `${selection.method} ${selection.route}`
    const combined = new Map<string, BucketRow>()
    for (const bucket of this.buckets) {
      if (!bucket || bucket.epoch < firstEpoch) continue
      for (const [key, row] of bucket.rows) {
        if (selectedKey !== undefined && key !== selectedKey) continue
        let aggregate = combined.get(key)
        if (!aggregate) {
          aggregate = createBucketRow()
          combined.set(key, aggregate)
        }
        mergeTotals(aggregate, row)
        for (const [status, count] of row.statusCounts) {
          aggregate.statusCounts.set(status, (aggregate.statusCounts.get(status) ?? 0) + count)
        }
        if (!aggregate.last || (row.last?.lastAtMs ?? 0) >= (aggregate.last.lastAtMs ?? 0)) {
          aggregate.last = row.last
        }
      }
    }
    const totals = createTotals()
    let active = 0
    const rows: ApiTelemetryRow[] = []
    for (const key of new Set([...combined.keys(), ...this.inFlight.keys()])) {
      if (selectedKey !== undefined && key !== selectedKey) continue
      const aggregate = combined.get(key)
      const inFlight = this.inFlight.get(key) ?? 0
      const [method, route] = key.split(" ")
      if (aggregate) mergeTotals(totals, aggregate)
      active += inFlight
      rows.push({
        method,
        route,
        ...summarize(aggregate ?? createTotals(), inFlight),
        statusCounts: aggregate
          ? [...aggregate.statusCounts]
              .sort(([a], [b]) => a - b)
              .map(([status, count]) => ({ status, count }))
          : [],
        latencyBands: aggregate ? readLatencyBands(aggregate.histogram) : [],
        maxMs: aggregate?.responses ? Math.round(aggregate.maxMs * 10) / 10 : null,
        lastStatus: aggregate?.last?.lastStatus ?? null,
        lastMs: aggregate?.last?.lastMs ?? null,
        lastAtMs: aggregate?.last?.lastAtMs ?? null,
        lastResponse: aggregate?.last?.lastResponse ?? null,
        lastRequest: aggregate?.last?.lastRequest ?? null,
        lastParams: aggregate?.last?.lastParams ?? null,
      })
    }
    rows.sort((a, b) => b.completed - a.completed || a.route.localeCompare(b.route))
    return {
      ...summarize(totals, active),
      router,
      startedAtMs: this.startedAtMs,
      windowStartMs,
      sampledAtMs,
      rows,
    }
  }
}

export function observeApiExchange(
  telemetry: ApiTelemetry,
  route: string,
  request: IncomingMessage,
  response: ServerResponse,
  ingress?: "bun-tls",
) {
  const queryIndex = request.url?.indexOf("?") ?? -1
  const search = queryIndex === -1 ? "" : request.url?.slice(queryIndex + 1)
  const method = request.method ?? ""
  const finish = telemetry.start(method, route, search, readRequest(request, ingress))
  const readBody = observeResponseBody(response)
  const recordResponse = () =>
    finish(response.statusCode, {
      etag: response.getHeader("etag"),
      contentType: response.getHeader("content-type"),
      setCookie: response.getHeader("set-cookie"),
      body: readBody(method),
    })
  response.once("finish", recordResponse)
  response.once("close", () => {
    if (response.writableFinished) recordResponse()
    else finish(null)
  })
}
