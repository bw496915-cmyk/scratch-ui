import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { renderToStaticMarkup } from "react-dom/server"

import {
  createR2PipelineService,
  probeDaemon4020Status,
} from "../packages/backend/src/r2_pipeline.ts"
import { R2PipelineTabPanel } from "../packages/ui/src/panels/R2PipelineTabPanel.tsx"
import {
  buildNodeAutomationsSnapshot,
  buildUnmeasuredTicketVerification,
} from "../server/collector_status.ts"

const now = () => new Date("2026-11-19T23:45:00.000Z")
const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function writeReceipt(value: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "sportsdesk-collector-"))
  directories.push(directory)
  const statePath = join(directory, "state.json")
  await writeFile(statePath, JSON.stringify(value))
  return statePath
}

describe("explicit companion daemon configuration", () => {
  test("unset, blank and invalid origins do not probe loopback or leak URL credentials", async () => {
    let requests = 0
    for (const origin of [
      undefined,
      " ",
      "ftp://daemon",
      "https://user:secret@daemon",
      "invalid",
    ]) {
      const result = await probeDaemon4020Status({
        origin,
        now,
        fetchImpl: async () => {
          requests++
          return Response.json({})
        },
      })
      expect(result.state).toBe("unconfigured")
      expect(result.online).toBe(false)
      expect(result.url).toBe("")
      expect(JSON.stringify(result)).not.toContain("secret")
    }
    expect(requests).toBe(0)
  })

  test("configured URL is probed and a reachable auth-down daemon is degraded", async () => {
    const requests: string[] = []
    const result = await probeDaemon4020Status({
      origin: " https://daemon.internal/desk/ ",
      now,
      fetchImpl: async (url) => {
        requests.push(url)
        return Response.json({ operationalStatus: "down" }, { status: 503 })
      },
    })
    expect(requests).toEqual(["https://daemon.internal/desk/health"])
    expect(result.online).toBe(true)
    expect(result.state).toBe("degraded")
  })

  test("network failure remains offline with its actionable cause code", async () => {
    const result = await probeDaemon4020Status({
      origin: "http://127.0.0.1:4020",
      now,
      fetchImpl: async () => {
        throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } })
      },
    })
    expect(result.state).toBe("offline")
    expect(result.reason).toContain("ECONNREFUSED")
  })
})

describe("measured collector receipts", () => {
  test("missing or malformed receipts do not invent jobs, schedules or ticket verification", async () => {
    for (const statePath of [
      join(tmpdir(), "missing-sportsdesk-receipt.json"),
      await writeReceipt({ jobs: [] }),
    ]) {
      const result = await buildNodeAutomationsSnapshot({ statePath, now })
      expect(result.source).toBe("unavailable")
      expect(result.bridgeRollupUpdatedAt).toBeNull()
      expect(result.bridgeJobs).toEqual([])
      expect(result.schedules).toEqual([])
      expect(result.ticketVerification).toBeNull()
    }
    expect(buildUnmeasuredTicketVerification()).toMatchObject({
      available: false,
      mode: "unmeasured",
      verifiedAt: null,
      canaryPassed: false,
    })
  })

  test("preserves the actual cycle time, failed capture and successful cached publication", async () => {
    const receipt = {
      updatedAt: "2026-11-19T23:30:00.000Z",
      jobs: [
        {
          id: "wagers-by-state",
          label: "Capture",
          ok: false,
          durationMs: 0,
          error: "GSLive expired",
        },
        { id: "wagers-publish", label: "Publication", ok: true, durationMs: 123 },
      ],
    }
    const result = await buildNodeAutomationsSnapshot({
      statePath: await writeReceipt(receipt),
      now,
    })
    expect(result.source).toBe("collector-state")
    expect(result.bridgeRollupUpdatedAt).toBe(receipt.updatedAt)
    expect(result.bridgeJobs).toEqual(receipt.jobs)
    expect(result.schedules).toEqual([])
  })

  test("future receipts and coerced success strings are unavailable", async () => {
    for (const receipt of [
      { updatedAt: "2099-01-01T00:00:00.000Z", jobs: [] },
      {
        updatedAt: now().toISOString(),
        jobs: [{ id: "bridge3c", label: "Capture", ok: "true", durationMs: 42 }],
      },
    ]) {
      expect(
        (await buildNodeAutomationsSnapshot({ statePath: await writeReceipt(receipt), now }))
          .source,
      ).toBe("unavailable")
    }
  })
})

describe("pipeline publication versus data freshness", () => {
  function createPipeline(data: unknown, publishedAt = now().toUTCString()) {
    return createR2PipelineService({
      now,
      fetchImpl: async () => Response.json(data, { headers: { "last-modified": publishedAt } }),
    })
  }

  test("new publication of old capture remains stale", async () => {
    const result = await createPipeline({
      window: { toMs: now().getTime() - 10 * 86400000 },
      generatedAt: now().toISOString(),
    }).probeAll()
    expect(result.publishFreshCount).toBe(4)
    expect(result.freshCount).toBe(0)
    expect(result.overallStatus).toBe("stale")
    expect(result.dataStaleKeys).toHaveLength(4)
    expect(
      result.sinks.every((sink) => sink.diagnostic?.blockerClass === "upstream_capture_stale"),
    ).toBe(true)
  })

  test("ticker event watermark clock establishes data freshness without trusting publication", async () => {
    const result = await createPipeline({
      data_window_max_epoch_ms: now().getTime() - 300_000,
      generatedAt: now().toISOString(),
    }).probeAll()
    expect(result.sinks.every((sink) => sink.dataAgeSeconds === 300)).toBe(true)
    expect(result.freshCount).toBe(4)
  })

  test("generation timestamp alone never establishes data freshness", async () => {
    const result = await createPipeline({ generatedAt: now().toISOString() }).probeAll()
    expect(result.publishFreshCount).toBe(4)
    expect(result.freshCount).toBe(0)
    expect(result.overallStatus).toBe("degraded")
    expect(result.sinks.every((sink) => sink.dataAgeSeconds === null)).toBe(true)
  })

  test("future data timestamps are unmeasured rather than fresh", async () => {
    const result = await createPipeline({ capturedAt: "2099-01-01T00:00:00.000Z" }).probeAll()
    expect(result.freshCount).toBe(0)
    expect(result.overallStatus).toBe("degraded")
  })

  test("fresh capture and publication are fresh; overdue publication remains stale", async () => {
    const body = { capturedAt: new Date(now().getTime() - 60000).toISOString() }
    expect((await createPipeline(body).probeAll()).overallStatus).toBe("fresh")
    const result = await createPipeline(
      body,
      new Date(now().getTime() - 86400000).toUTCString(),
    ).probeAll()
    expect(result.freshCount).toBe(0)
    expect(result.overallStatus).toBe("stale")
  })

  test("recorded collector failure degrades even currently fresh artifacts", async () => {
    const automations = await buildNodeAutomationsSnapshot({
      now,
      statePath: await writeReceipt({
        updatedAt: now().toISOString(),
        jobs: [
          { id: "bridge3c", label: "Capture", ok: false, durationMs: 0, error: "GSLive expired" },
        ],
      }),
    })
    const service = createR2PipelineService({
      now,
      getAutomationsSnapshot: () => automations,
      fetchImpl: async () =>
        Response.json(
          { capturedAt: now().toISOString() },
          { headers: { "last-modified": now().toUTCString() } },
        ),
    })
    const result = await service.probeAll()
    expect(result.freshCount).toBe(4)
    expect(result.overallStatus).toBe("degraded")
    expect(result.sinks.find((sink) => sink.id === "gslive-tally")?.diagnostic?.blockerClass).toBe(
      "gslive_auth_expired",
    )
  })

  test("rendered monitor distinguishes unconfigured daemon and unavailable execution evidence", async () => {
    const result = await createPipeline({ capturedAt: now().toISOString() }).probeAll()
    const automations = await buildNodeAutomationsSnapshot({
      statePath: await writeReceipt({}),
      now,
    })
    const html = renderToStaticMarkup(
      <R2PipelineTabPanel
        data={{ ...result, automations }}
        loading={false}
        error={null}
        onRefresh={() => {}}
      />,
    )
    expect(html).toContain("Companion daemon not configured")
    expect(html).toContain("No valid collector receipt")
    expect(html).toContain("fresh publication &amp; data")
    expect(html).not.toContain("fallback active")
    expect(html).not.toContain("CANARY PASS")
  })
})
