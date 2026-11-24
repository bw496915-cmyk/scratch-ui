import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDevLiveWagersLoader } from "../packages/backend/src/wagers.ts"
import { parseDeskClock } from "../packages/ui/src/gslive_game_log.ts"
import { normalizeLiveWagersResponse } from "../packages/ui/src/hydration.ts"
import { quickJumpFeedState } from "../packages/ui/src/quick_jump_feed.ts"

async function withWagerCapture(run: (path: string, load: () => Promise<unknown>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "sportsdesk-wager-capture-"))
  const path = join(directory, "live-wagers.json")
  const { buildLiveWagersPayload } = createDevLiveWagersLoader({
    cwd: directory,
    candidatePaths: [path],
    loadSharpDeps: async () => ({
      parseShortDesc: () => ({ legs: [] }),
      sharpCustomerIds: new Set(),
    }),
  })
  try {
    await run(path, buildLiveWagersPayload)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const observedAt = "2025-11-20T05:00:00.000Z"
const source = `live:/cloud/api/Manager/getBetTicker@${observedAt}`

describe("wager ticker capture evidence", () => {
  test("repolling a stale capture keeps its timestamp and excludes unmeasured amounts", async () => {
    await withWagerCapture(async (path, load) => {
      await writeFile(
        path,
        JSON.stringify({
          observedAt,
          source,
          partial: true,
          LIST: [
            {
              WagerNumber: 1,
              AmountWagered: 100,
              ToWinAmount: 90,
              InsertDateTime: "2025-11-20 00:00:00.000",
            },
            { WagerNumber: 2, AmountWagered: " ", ToWinAmount: 100 },
            { WagerNumber: 3, AmountWagered: 900, ToWinAmount: 800, TicketWriter: "ALERT" },
          ],
        }),
      )
      for (const capture of [await load(), await load()]) {
        const normalized = normalizeLiveWagersResponse(capture)
        expect(normalized?.totalRiskUsd).toBe(100)
        expect(normalized?.wagers).toHaveLength(1)
        expect(normalized?.wagers[0]).toMatchObject({ oddsAmerican: "—", toWinUsd: 90 })
        expect(parseDeskClock(normalized?.wagers[0]?.timestamp ?? "")).toBe(0)
        expect(normalized?.provenance).toMatchObject({
          kind: "live",
          observedAt,
          partial: true,
          omittedRowCount: 1,
          latestTicketTime: "2025-11-20 00:00:00.000",
        })
        expect(
          quickJumpFeedState(Date.parse(normalized?.provenance.observedAt ?? ""), Date.parse(observedAt) + 120_000)
            .stale,
        ).toBe(true)
      }
    })
  })

  test("distinguishes missing data, a measured empty list, and an all-invalid list", async () => {
    await withWagerCapture(async (path, load) => {
      expect(normalizeLiveWagersResponse(await load())?.provenance).toMatchObject({
        kind: "unavailable",
        observedAt: "",
      })
      await writeFile(path, JSON.stringify({ observedAt, source, LIST: [] }))
      const empty = normalizeLiveWagersResponse(await load())
      expect(empty?.wagers).toEqual([])
      expect(empty?.provenance).toMatchObject({ kind: "live", observedAt })
      await writeFile(path, JSON.stringify({ observedAt, source, LIST: [{ WagerNumber: 1 }] }))
      expect(normalizeLiveWagersResponse(await load())?.provenance).toMatchObject({
        kind: "unavailable",
        omittedRowCount: 1,
      })
    })
  })
})
