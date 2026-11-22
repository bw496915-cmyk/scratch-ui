import { spawn } from "node:child_process"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { createInterface } from "node:readline"

import type { ShadowPricingQueryParams } from "../packages/api/src/index.ts"

type ShadowQuery = Omit<ShadowPricingQueryParams, "dbPath">

interface ShadowDatabaseConfig {
  readonly deskRoot: string | undefined
  readonly database: string | undefined
}

// Keep the read-only arena loaded between filter changes. The source engine can
// fall back to a fixture, so both sides of this bridge check provenance.
const workerScript = `
import { runShadowPricingDashboard } from "./lib/shadow_pricing_engine.ts"
for await (const line of console) {
  const { id, query } = JSON.parse(line)
  let payload = null
  try {
    const result = await runShadowPricingDashboard({ ...query, forceFixture: false })
    if (result.provenance === "live_db") payload = result
  } catch (error) {
    console.error("Retained shadow pricing failed:", error.message)
  }
  console.log(JSON.stringify({ id, payload }))
}
`

function launchShadowWorker(deskRoot: string, database: string, databaseStamp: string) {
  const child = spawn(process.env.SPORTSDESK_BUN_BIN?.trim() || "bun", ["-e", workerScript], {
    cwd: deskRoot,
    env: { PATH: process.env.PATH, SHADOW_PRICE_DB: database },
    stdio: ["pipe", "pipe", "inherit"],
  })
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const requests = new Map<number, (payload: unknown) => void>()
  let nextId = 0
  let closed = false

  function close() {
    if (closed) return
    closed = true
    process.off("exit", close)
    child.kill()
    lines.close()
    for (const finish of requests.values()) finish(null)
  }

  process.once("exit", close)
  child.once("error", close)
  child.once("exit", close)
  child.stdin.on("error", close)
  lines.on("line", (line) => {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message !== "object" || message === null || !("id" in message)) return
    if (typeof message.id !== "number" || !("payload" in message)) return
    const { payload } = message
    const measured =
      typeof payload === "object" &&
      payload !== null &&
      "provenance" in payload &&
      payload.provenance === "live_db"
    requests.get(message.id)?.(measured ? payload : null)
  })

  return {
    close,
    isCurrent: (stamp: string) => !closed && stamp === databaseStamp,
    evaluate(query: ShadowQuery): Promise<unknown> {
      if (closed || requests.size >= 8) return Promise.resolve(null)
      const id = ++nextId
      return new Promise((finish) => {
        const timeout = setTimeout(close, 45_000)
        requests.set(id, (payload) => {
          clearTimeout(timeout)
          requests.delete(id)
          finish(payload)
        })
        child.stdin.write(JSON.stringify({ id, query }) + "\n")
      })
    },
  }
}

export function createRetainedShadowPricing(config: ShadowDatabaseConfig) {
  const deskRoot = config.deskRoot ? resolve(config.deskRoot) : null
  const database = config.database ? resolve(config.database) : null
  let worker: ReturnType<typeof launchShadowWorker> | undefined

  return async (query: ShadowPricingQueryParams): Promise<unknown> => {
    if (!deskRoot || !database) return null
    const info = await stat(database).catch(() => null)
    if (!info?.isFile()) {
      worker?.close()
      worker = undefined
      return null
    }
    const stamp = `${info.ino}|${info.size}|${info.mtimeMs}`
    if (!worker?.isCurrent(stamp)) {
      worker?.close()
      worker = launchShadowWorker(deskRoot, database, stamp)
    }
    const { dbPath: _configuredDatabase, ...filters } = query
    return worker.evaluate(filters)
  }
}
