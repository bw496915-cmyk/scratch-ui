import { describe, expect, test } from "bun:test"
import {
  buildFantasy402CustomerUrl,
  buildFantasy402PortalEntryUrl,
  FANTASY402_PORTAL_WINDOW_TARGET,
  getFantasy402PortalLinkProps,
} from "../../packages/ui/src/portal_link.ts"
import { evaluateRiskExposureThreshold } from "../../packages/ui/src/risk_threshold_alert.ts"
import { buildSharpestOnChainXrefReport } from "../../packages/ui/src/sharpest_onchain_xref.ts"
import type { LiveWager, ShowcaseCustomer } from "../../packages/ui/src/types.ts"
import {
  registerSportsDeskWebMcpTools,
  type SportsDeskWebMcpActions,
  type SportsDeskWebMcpSnapshot,
  type WebMcpModelContext,
  type WebMcpToolRegistration,
} from "../../packages/ui/src/web_mcp.ts"
import {
  archiveWebLogsToR2,
  buildRedactedWebLogsNdjson,
  getBunS3Capabilities,
} from "../../server/bun_r2_inspect.ts"
import { createWebLogStore } from "../../server/weblog_inspect.ts"
import {
  isAllowedS3StorageClass,
  isR2ObjectPrefix,
  sanitizeContentDispositionFilename,
  SealedR2Handle,
  withInspectRole,
} from "../../src/s3/sealed_r2_handle.ts"

function makeSampleSnapshot(): SportsDeskWebMcpSnapshot {
  const nowMs = Date.now()
  const wagers: LiveWager[] = []
  const customers: ShowcaseCustomer[] = []
  return {
    activeTab: "system-logs",
    hasLiveWagerSnapshot: false,
    liveWagers: wagers,
    profileCustomers: customers,
    alertRecords: [],
    riskThresholds: { warningLimitUsd: 20_000, breachLimitUsd: 25_000 },
    riskThresholdEvaluation: evaluateRiskExposureThreshold(0, 25_000, {
      warningLimitUsd: 20_000,
      hasData: false,
    }),
    rolling60mIncludedTickets: 0,
    rolling60mAnchorMs: nowMs,
    sharpestOnChainXref: buildSharpestOnChainXrefReport({
      profiles: customers,
      rawGraphFeed: null,
      bridgeSnapshot: null,
    }),
    wsConnected: true,
    wsLastPongAt: new Date(nowMs - 1_000).toISOString(),
    wsLastSyncAt: nowMs - 1_000,
    wsLatencyMs: 25,
    wagersUpdatedAt: null,
    lastTelemetryProbeAt: null,
  }
}

describe("Fantasy402 Portal Session Tab Reuse (portal_link.ts)", () => {
  test("builds encoded DF8821 manager URL and reuses named session tab without noreferrer isolation", () => {
    const props = getFantasy402PortalLinkProps("DF8821")
    expect(props.href).toBe("https://fantasy402.com/manager.html?customer=DF8821")
    expect(props.target).toBe(FANTASY402_PORTAL_WINDOW_TARGET)
    expect("rel" in props).toBe(false)

    expect(buildFantasy402CustomerUrl("  DF8821  ")).toBe(
      "https://fantasy402.com/manager.html?customer=DF8821",
    )
    expect(buildFantasy402CustomerUrl("DF 88&21")).toBe(
      "https://fantasy402.com/manager.html?customer=DF%2088%2621",
    )
    expect(buildFantasy402CustomerUrl("   ")).toBe(buildFantasy402PortalEntryUrl())
  })
})

describe("Bun 1.4.4 New S3Client Enhancements & Weblogs Archival", () => {
  test("validates S3 prefixes, storage classes, and Content-Disposition filenames fail-closed", () => {
    expect(isR2ObjectPrefix("")).toBe(true)
    expect(isR2ObjectPrefix("weblogs/archives/2026-11-21/")).toBe(true)
    expect(isR2ObjectPrefix("weblogs/../secret/")).toBe(false)
    expect(isR2ObjectPrefix("weblogs\\bad")).toBe(false)

    expect(isAllowedS3StorageClass("STANDARD")).toBe(true)
    expect(isAllowedS3StorageClass("STANDARD_IA")).toBe(true)
    expect(isAllowedS3StorageClass("GLACIER")).toBe(true)
    expect(isAllowedS3StorageClass("INVALID_CLASS")).toBe(false)

    expect(sanitizeContentDispositionFilename('report"\r\nX-Inject: 1.csv')).toBe(
      "reportX-Inject: 1.csv",
    )
    expect(sanitizeContentDispositionFilename('""\r\n')).toBe("export.bin")
  })

  test("SealedR2Handle presignDownload emits Bun 1.3.7+ response-content-disposition and response-content-type with admin scope", () => {
    const handle = new SealedR2Handle({
      bucket: "desk-archive",
      endpoint: "https://example.r2.cloudflarestorage.com",
      accessKeyId: "test-r2-access-key",
      secretAccessKey: "test-r2-secret-key",
    })

    // Non-admin viewer denied fail-closed
    expect(() => handle.presignDownload("weblogs/archives/2026-11-21/weblogs.ndjson")).toThrow(
      "ERR_INSP_ROLE_DENIED",
    )

    const signed = withInspectRole("ROLE_OPS_ADMIN", () =>
      handle.presignDownload("weblogs/archives/2026-11-21/weblogs.ndjson", {
        method: "GET",
        expiresInSec: 9_999, // clamped to 900s max
        contentType: "application/x-ndjson",
        filename: 'weblogs-2026-11-21"\r\n.ndjson',
      }),
    )

    expect(signed.bucket).toBe("desk-archive")
    expect(signed.expiresInSec).toBe(900)
    const url = new URL(signed.url)
    expect(url.origin).toBe("https://example.r2.cloudflarestorage.com")
    expect(url.pathname).toBe("/desk-archive/weblogs/archives/2026-11-21/weblogs.ndjson")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900")
    expect(url.searchParams.get("response-content-type")).toBe("application/x-ndjson")
    expect(url.searchParams.get("response-content-disposition")).toBe(
      'attachment; filename="weblogs-2026-11-21.ndjson"',
    )

    // Key traversal rejected
    expect(() =>
      withInspectRole("ROLE_OPS_ADMIN", () => handle.presignDownload("weblogs/../secret.ndjson")),
    ).toThrow("ERR_S3_INVALID_KEY")
  })

  test("getBunS3Capabilities reports Bun S3 features cleanly with zero credentials, and archiveWebLogsToR2 builds redacted NDJSON", async () => {
    const caps = getBunS3Capabilities({ state: "not-configured" })
    expect(caps.runtime).toBe("bun")
    expect(caps.bunVersion).toBe(Bun.version)
    expect(caps.supportedFeatures).toContain("list")
    expect(caps.supportedFeatures).toContain("stat")
    expect(caps.supportedFeatures).toContain("write")
    expect(caps.supportedFeatures).toContain("presign")
    expect(caps.supportedFeatures).toContain("storageClass")
    expect(caps.supportedFeatures).toContain("requestPayer")
    expect(caps.supportedFeatures).toContain("contentDisposition")

    const store = createWebLogStore()
    const { result } = store.ingest(
      "November 21, 2026\n" +
        '08:25:12 AM\t198.51.100.42\tAPI LOG | BLOCK BET | BOT BLOCK LINE ST | #[{"key":"bot_619137349_0_L_U_0","val":"DF8821"}]\n' +
        "08:25:04 AM\t198.51.100.42\tLogin successful [ v43.0.27 | www.fantasy402.com ]",
    )
    const ndjsonPayload = buildRedactedWebLogsNdjson(result)
    expect(ndjsonPayload.entryCount).toBeGreaterThanOrEqual(2)
    expect(ndjsonPayload.ndjson).not.toContain("198.51.100.42") // raw IP never emitted
    const lines = ndjsonPayload.ndjson
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    expect(lines[0].recordType).toBe("weblog_archive_header")
    expect(lines[1].recordType).toBe("weblog_entry")

    // Archive fails closed when unconfigured
    await expect(
      withInspectRole("ROLE_OPS_ADMIN", () =>
        archiveWebLogsToR2({ state: "not-configured" }, result),
      ),
    ).rejects.toThrow("ERR_R2_CLIENT_UNAVAILABLE")
  })
})

describe("Enhanced WebMCP Weblogs & Bun S3 Tools", () => {
  test("executes desk_query_weblogs, desk_get_weblog_vectors, desk_inspect_bun_s3, and human-gated desk_archive_weblogs_to_s3", async () => {
    const tools = new Map<string, WebMcpToolRegistration>()
    const modelContext: WebMcpModelContext = {
      registerTool(tool) {
        tools.set(tool.name, tool)
      },
    }

    const fetchedRequests: Array<{ path: string; method: string; body?: string }> = []
    const actions: SportsDeskWebMcpActions = {
      setActiveTab: () => {},
      applyWagerFilters: () => {},
      focusCustomer: () => {},
      updateRiskThresholds: () => {},
      refreshTelemetry: () => {},
      fetchApi: async (path, init) => {
        fetchedRequests.push({
          path,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : undefined,
        })
        if (path.startsWith("/api/weblogs?")) {
          return new Response(
            JSON.stringify({
              source: "operator-import",
              generatedAt: "2026-11-21T18:45:00.000Z",
              summary: { totalEntries: 2, filteredEntries: 1, peakBotScore: 84 },
              entries: [
                {
                  id: "wl-1",
                  dateLabel: "2026-11-21",
                  timeEst: "08:25:05 AM",
                  ip: "198.51.100.0/24#a1b2c3d4",
                  ipMeta: {
                    ip: "198.51.100.0/24#a1b2c3d4",
                    family: "IPv4",
                    subnet24: "198.51.100.0/24",
                  },
                  accountId: "DF8821",
                  eventKind: "BLOCK",
                  severity: "CRITICAL",
                  vectorScore: 84,
                  interArrivalSec: 1.0,
                  clusterLabel: "BURST_BOT",
                  ticketId: "TKT-77",
                  gameId: "912345",
                },
              ],
              vectors: [
                {
                  vectorId: "vec-1",
                  accountId: "DF8821",
                  ip: "198.51.100.0/24#a1b2c3d4",
                  subnet24: "198.51.100.0/24",
                  eventCount: 12,
                  blockCount: 5,
                  medianCadenceSec: 1.1,
                  botScore: 84,
                  axes: { blockRatio: 0.42 },
                },
              ],
              cosinePairs: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (path === "/api/r2/client/inspect") {
          return new Response(
            JSON.stringify({
              runtime: "bun",
              bunVersion: "1.4.4",
              sealedGlobalS3: true,
              clientState: "configured",
              bucket: "desk-archive",
              supportedFeatures: ["list", "stat", "write", "presign", "storageClass"],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        if (path === "/api/weblogs/archive-s3") {
          return new Response(
            JSON.stringify({
              archived: true,
              bucket: "desk-archive",
              key: "weblogs/archives/2026-11-21/weblogs-1.ndjson",
              entryCount: 1,
              bytesWritten: 256,
              storageClass: "GLACIER",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        }
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 })
      },
    }

    registerSportsDeskWebMcpTools(modelContext, () => makeSampleSnapshot(), actions)

    // 1. desk_query_weblogs
    const wlRes = await tools.get("desk_query_weblogs")!.execute({
      account: "DF8821",
      severity: "CRITICAL",
      sort: "score",
      limit: 10,
    })
    expect(wlRes.isError).toBeUndefined()
    const wl = JSON.parse(wlRes.content[0]!.text) as {
      returned: number
      entries: Array<{ accountId: string; ipRedacted: string }>
    }
    expect(wl.returned).toBe(1)
    expect(wl.entries[0]?.accountId).toBe("DF8821")
    expect(wl.entries[0]?.ipRedacted).toContain("/24#")

    // 2. desk_get_weblog_vectors
    const vecRes = await tools.get("desk_get_weblog_vectors")!.execute({
      minBotScore: 70,
      account: "DF8821",
    })
    expect(vecRes.isError).toBeUndefined()
    const vec = JSON.parse(vecRes.content[0]!.text) as { vectorCount: number }
    expect(vec.vectorCount).toBe(1)

    // 3. desk_inspect_bun_s3 (capabilities + invalid traversal stat fails closed)
    const s3CapRes = await tools.get("desk_inspect_bun_s3")!.execute({ action: "capabilities" })
    expect(s3CapRes.isError).toBeUndefined()
    const s3BadStat = await tools.get("desk_inspect_bun_s3")!.execute({
      action: "stat",
      key: "../etc/passwd",
    })
    expect(s3BadStat.isError).toBe(true)

    // 4. desk_archive_weblogs_to_s3 — cancelled by user blocks POST
    const cancelled = await tools
      .get("desk_archive_weblogs_to_s3")!
      .execute(
        { account: "DF8821", storageClass: "GLACIER" },
        { requestUserInteraction: async () => false as never },
      )
    expect(cancelled.isError).toBe(true)
    expect(fetchedRequests.some((r) => r.path === "/api/weblogs/archive-s3")).toBe(false)

    // Approved by user triggers POST with storageClass
    const archived = await tools
      .get("desk_archive_weblogs_to_s3")!
      .execute(
        { account: "DF8821", storageClass: "GLACIER" },
        { requestUserInteraction: async (cb) => cb() },
      )
    expect(archived.isError).toBeUndefined()
    const archData = JSON.parse(archived.content[0]!.text) as {
      archived: boolean
      storageClass: string
    }
    expect(archData.archived).toBe(true)
    expect(archData.storageClass).toBe("GLACIER")
  })
})
