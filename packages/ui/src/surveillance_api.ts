/**
 * @file packages/ui/src/surveillance_api.ts
 * @description Canonical Surveillance API URL builders, header alignment helpers,
 * Bun/Window runtime inspection, and Blob export builders for `/?tab=surveillance`.
 */

import type { ReverseDnsForensicsView } from "../../../lib/reverse_dns_forensics.ts"
import { extractResponseHeaderTelemetry, type ApiHeaderTelemetry } from "./api_usage.ts"
import {
  buildDashboardApiUrlObject,
  DASHBOARD_API,
  readBunGlobals,
  resolveDashboardBaseUrl,
  type BunGlobalSnapshot,
  type DashboardWindowLocationLike,
} from "./config/dashboard.ts"
import type { DashboardData, DnsData } from "./types.ts"
import { SURVEILLANCE_URL_DEFAULTS, type SurveillanceViewMode } from "./url_state.ts"

export const SURVEILLANCE_ENDPOINTS = Object.freeze({
  brief: DASHBOARD_API.surveillance_brief || DASHBOARD_API.dashboard,
  dns: DASHBOARD_API.surveillance_dns || DASHBOARD_API.dns,
  benchmark: DASHBOARD_API.surveillance_dns_benchmark || "/api/surveillance/dns/benchmark",
  reverse: DASHBOARD_API.surveillance_dns_reverse || "/api/surveillance/dns/reverse",
})

export interface SurveillanceEndpointUrls {
  readonly baseUrl: URL
  readonly baseSource: "explicit" | "query-override" | "config" | "window-origin" | "fallback"
  readonly windowUrl: URL | null
  readonly brief: URL
  readonly dns: URL
  readonly benchmark: URL
  readonly reverse: URL
}

export interface SurveillanceWindowLike extends DashboardWindowLocationLike {
  readonly navigator?: {
    readonly userAgent?: string
  }
  readonly document?: {
    createElement(tagName: string): {
      href: string
      download: string
      style: { display: string }
      click(): void
      remove?(): void
    }
    readonly body?: {
      appendChild(node: unknown): unknown
      removeChild?(node: unknown): unknown
    } | null
  }
}

function defaultSurveillanceWindow(): SurveillanceWindowLike | null {
  const g = globalThis as unknown as { window?: SurveillanceWindowLike }
  return g.window ?? null
}

/**
 * Build independent `URL` objects for every Surveillance API endpoint against the
 * resolved Base URL, keeping each endpoint as its own mutable-safe `URL` instance.
 */
export function buildSurveillanceEndpointUrls(
  options: {
    readonly host?: string | undefined
    readonly ip?: string | undefined
    readonly base?: string | null | undefined
    readonly win?: SurveillanceWindowLike | null | undefined
  } = {},
): SurveillanceEndpointUrls {
  const win = options.win === undefined ? defaultSurveillanceWindow() : options.win
  const base = options.base ?? null
  const { baseUrl, source } = resolveDashboardBaseUrl(base, win)
  const host = (options.host ?? "").trim() || SURVEILLANCE_URL_DEFAULTS.host
  const ip = (options.ip ?? "").trim() || SURVEILLANCE_URL_DEFAULTS.ip

  let windowUrl: URL | null = null
  const winHref = win?.location?.href
  if (typeof winHref === "string" && winHref !== "") {
    try {
      windowUrl = new URL(winHref, baseUrl)
    } catch {
      windowUrl = null
    }
  }

  return {
    baseUrl,
    baseSource: source,
    windowUrl,
    brief: buildDashboardApiUrlObject(SURVEILLANCE_ENDPOINTS.brief, undefined, baseUrl.origin, win),
    dns: buildDashboardApiUrlObject(SURVEILLANCE_ENDPOINTS.dns, undefined, baseUrl.origin, win),
    benchmark: buildDashboardApiUrlObject(
      SURVEILLANCE_ENDPOINTS.benchmark,
      { host },
      baseUrl.origin,
      win,
    ),
    reverse: buildDashboardApiUrlObject(
      SURVEILLANCE_ENDPOINTS.reverse,
      { ip },
      baseUrl.origin,
      win,
    ),
  }
}

/**
 * Build a separate `URL` object representing `/?tab=surveillance` state without
 * mutating `Window.location`.
 */
export function buildSurveillanceWindowUrl(
  patch: {
    readonly viewMode?: SurveillanceViewMode | undefined
    readonly reverseIp?: string | undefined
    readonly benchHost?: string | undefined
  } = {},
  win: SurveillanceWindowLike | null = defaultSurveillanceWindow(),
): URL {
  const { baseUrl } = resolveDashboardBaseUrl(null, win)
  const currentHref = win?.location?.href || "/?tab=surveillance"
  const url = new URL(currentHref, baseUrl)
  url.searchParams.set("tab", "surveillance")

  const viewMode = patch.viewMode ?? SURVEILLANCE_URL_DEFAULTS.view
  if (viewMode === "raw") {
    url.searchParams.set("survView", "raw")
  } else {
    url.searchParams.delete("survView")
  }

  const ip = (patch.reverseIp ?? "").trim()
  if (ip && ip !== SURVEILLANCE_URL_DEFAULTS.ip) {
    url.searchParams.set("survIp", ip)
  } else {
    url.searchParams.delete("survIp")
  }

  const host = (patch.benchHost ?? "").trim()
  if (host && host !== SURVEILLANCE_URL_DEFAULTS.host) {
    url.searchParams.set("survHost", host)
  } else {
    url.searchParams.delete("survHost")
  }

  url.searchParams.delete("fast_signin")
  return url
}

export interface SurveillanceRuntimeGlobalsSnapshot {
  readonly bun: BunGlobalSnapshot
  readonly hasWindow: boolean
  readonly hasBlob: boolean
  readonly windowOrigin: string | null
  readonly userAgent: string | null
}

export function inspectSurveillanceRuntimeGlobals(
  win: SurveillanceWindowLike | null = defaultSurveillanceWindow(),
): SurveillanceRuntimeGlobalsSnapshot {
  return {
    bun: readBunGlobals(),
    hasWindow: win !== null,
    hasBlob: typeof Blob !== "undefined",
    windowOrigin: win?.location?.origin ?? null,
    userAgent: win?.navigator?.userAgent ?? null,
  }
}

export interface SurveillanceHeaderSyncRecord extends ApiHeaderTelemetry {
  readonly status: number
  readonly observedAtIso: string
  readonly requestUrl: string
}

export function buildSurveillanceHeaderSyncRecord(
  res: Response,
  requestUrl: URL | string,
): SurveillanceHeaderSyncRecord {
  const parsed = extractResponseHeaderTelemetry(res.headers)
  const urlStr = requestUrl instanceof URL ? requestUrl.toString() : requestUrl
  return {
    requestId: parsed?.requestId ?? null,
    endpointHeader: parsed?.endpointHeader ?? null,
    tabHeader: parsed?.tabHeader ?? null,
    cacheControl: parsed?.cacheControl ?? null,
    runtimeEngine: parsed?.runtimeEngine ?? null,
    responseTimeMs: parsed?.responseTimeMs ?? null,
    contentType: parsed?.contentType ?? null,
    aligned: parsed?.aligned ?? false,
    status: res.status,
    observedAtIso: new Date().toISOString(),
    requestUrl: urlStr,
  }
}

export interface SurveillanceSnapshotExportInput {
  readonly viewMode: SurveillanceViewMode
  readonly benchHost: string
  readonly benchResult: string | null
  readonly reverseIp: string
  readonly reverseForensics: ReverseDnsForensicsView | null
  readonly dnsData: DnsData | null
  readonly briefData: DashboardData | null
  readonly headerSync: SurveillanceHeaderSyncRecord | null
  readonly win?: SurveillanceWindowLike | null | undefined
}

/**
 * Serialize the complete Surveillance URL state, separate endpoint URLs,
 * aligned headers, Bun/Window globals, and telemetry into a `Blob`.
 */
export function buildSurveillanceSnapshotBlob(input: SurveillanceSnapshotExportInput): Blob {
  const urls = buildSurveillanceEndpointUrls({
    host: input.benchHost,
    ip: input.reverseIp,
    win: input.win,
  })
  const windowStateUrl = buildSurveillanceWindowUrl(
    {
      viewMode: input.viewMode,
      reverseIp: input.reverseIp,
      benchHost: input.benchHost,
    },
    input.win,
  )
  const runtime = inspectSurveillanceRuntimeGlobals(input.win)

  const payload = {
    schema: "sportsdesk-surveillance-snapshot/v1",
    exportedAt: new Date().toISOString(),
    urlState: {
      windowUrl: windowStateUrl.toString(),
      baseUrl: urls.baseUrl.toString(),
      baseSource: urls.baseSource,
      viewMode: input.viewMode,
      benchHost: input.benchHost,
      reverseIp: input.reverseIp,
    },
    endpoints: {
      brief: urls.brief.toString(),
      dns: urls.dns.toString(),
      benchmark: urls.benchmark.toString(),
      reverse: urls.reverse.toString(),
    },
    headers: input.headerSync,
    runtimeGlobals: runtime,
    telemetry: {
      dns: input.dnsData,
      benchmarkResult: input.benchResult,
      reverseForensics: input.reverseForensics,
      briefUpdatedAt: input.briefData?.updatedAt ?? null,
      briefRenderDurationMs: input.briefData?.renderDurationMs ?? null,
      briefMarkdownBytes: input.briefData?.markdownBytes ?? null,
      briefHtmlBytes: input.briefData?.htmlBytes ?? null,
    },
  }

  return new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json;charset=utf-8",
  })
}

export function buildSurveillanceMarkdownBlob(markdown: string): Blob {
  return new Blob([markdown], {
    type: "text/markdown;charset=utf-8",
  })
}

export function downloadSurveillanceBlob(
  blob: Blob,
  filename: string,
  win: SurveillanceWindowLike | null = defaultSurveillanceWindow(),
): boolean {
  if (!win?.document || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return false
  }
  const objectUrl = URL.createObjectURL(blob)
  const anchor = win.document.createElement("a")
  anchor.href = objectUrl
  anchor.download = filename
  anchor.style.display = "none"
  win.document.body?.appendChild(anchor)
  anchor.click()
  if (typeof anchor.remove === "function") {
    anchor.remove()
  } else {
    win.document.body?.removeChild?.(anchor)
  }
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, 1000)
  return true
}
