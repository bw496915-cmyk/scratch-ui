export const API_TELEMETRY_PATH = "/api/telemetry"
export const API_TELEMETRY_INSPECT_PATH = "/api/telemetry/inspect"

export type ApiResponseType =
  | "JSON"
  | "NDJSON"
  | "JSON sequence"
  | "HTML"
  | "Text"
  | "CSV"
  | "XML"
  | "Event stream"
  | "Multipart"
  | "Image"
  | "Audio"
  | "Video"
  | "Binary"
  | "No body"
  | "Unknown"

export interface ApiTelemetryResponse {
  readonly etag: string | null
  readonly contentType: string | null
  readonly type: ApiResponseType
  readonly body: ApiTelemetryResponseBody | null
  readonly cookies: readonly ApiTelemetryResponseCookie[]
}

export interface ApiTelemetryResponseCookie {
  readonly name: string
  readonly expired: boolean
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite: "Lax" | "Strict" | "None" | null
  readonly maxAgeSeconds: number | null
}

export function formatApiTelemetryCookieAttributes(cookie: ApiTelemetryResponseCookie): string {
  return [
    cookie.expired ? "Expired" : "Set",
    cookie.secure && "Secure",
    cookie.httpOnly && "HttpOnly",
    cookie.sameSite && `SameSite=${cookie.sameSite}`,
    cookie.maxAgeSeconds !== null && `Max-Age=${cookie.maxAgeSeconds}s`,
  ]
    .filter(Boolean)
    .join(" · ")
}

export type ApiTelemetryResponseBody =
  | { readonly delivery: "Buffered" | "Streamed"; readonly bytes: number; readonly chunks: number }
  | { readonly delivery: "No body"; readonly bytes: 0; readonly chunks: 0 }

export type ApiTelemetryRequestBody =
  | { readonly framing: "Content-Length"; readonly declaredBytes: number }
  | { readonly framing: "No body"; readonly declaredBytes: 0 }
  | { readonly framing: "Chunked" | "Unknown length"; readonly declaredBytes: null }

export interface ApiTelemetryRequest {
  readonly scheme: "http" | "https"
  readonly httpVersion: string | null
  readonly tlsVersion: string | null
  readonly contentType: string | null
  readonly cookieNames: readonly string[]
  readonly body: ApiTelemetryRequestBody
}

export function formatApiTelemetryProtocol(request: ApiTelemetryRequest | null): string {
  if (!request) return ""
  return [
    request.scheme.toUpperCase(),
    request.httpVersion && `HTTP/${request.httpVersion}`,
    request.tlsVersion,
  ]
    .filter(Boolean)
    .join(" · ")
}

export interface ApiTelemetryParams {
  readonly path: readonly string[]
  readonly query: readonly string[]
}

export interface ApiTelemetryCounts {
  readonly completed: number
  readonly success: number
  readonly redirects: number
  readonly clientErrors: number
  readonly serverErrors: number
  readonly aborted: number
  readonly inFlight: number
  readonly avgMs: number | null
  readonly p95UpperMs: number | null
}

export interface ApiTelemetryStatusCount {
  readonly status: number
  readonly count: number
}

export interface ApiTelemetryLatencyBand {
  readonly lowerExclusiveMs: number | null
  readonly upperInclusiveMs: number | null
  readonly count: number
}

export function formatApiTelemetryLatencyBand(band: ApiTelemetryLatencyBand): string {
  const { lowerExclusiveMs, upperInclusiveMs } = band
  if (lowerExclusiveMs === null) return `≤${upperInclusiveMs} ms`
  if (upperInclusiveMs === null) return `>${lowerExclusiveMs} ms`
  return `>${lowerExclusiveMs} to ≤${upperInclusiveMs} ms`
}

export interface ApiTelemetryRow extends ApiTelemetryCounts {
  readonly route: string
  readonly method: string
  readonly statusCounts: readonly ApiTelemetryStatusCount[]
  readonly latencyBands: readonly ApiTelemetryLatencyBand[]
  readonly maxMs: number | null
  readonly lastStatus: number | null
  readonly lastMs: number | null
  readonly lastAtMs: number | null
  readonly lastResponse: ApiTelemetryResponse | null
  readonly lastRequest: ApiTelemetryRequest | null
  readonly lastParams: ApiTelemetryParams | null
}

export function formatApiTelemetryParams(
  params: ApiTelemetryParams | null,
  location: keyof ApiTelemetryParams,
): string {
  const prefix = location === "path" ? ":" : "?"
  return params?.[location].map((name) => `${prefix}${name}`).join(", ") ?? ""
}

export interface ApiTelemetrySnapshot extends ApiTelemetryCounts {
  readonly router: "bun-native" | "express"
  readonly startedAtMs: number
  readonly windowStartMs: number
  readonly sampledAtMs: number
  readonly rows: readonly ApiTelemetryRow[]
}

export interface ApiTelemetryInspection {
  readonly output: string
  readonly plain: string
}
