import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "zod"
import type {
  AutomationsSnapshot,
  TicketVerificationSummary,
} from "../packages/contracts/src/index.ts"

const collectorReceiptSchema = z.object({
  updatedAt: z.iso.datetime(),
  jobs: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      ok: z.boolean(),
      durationMs: z.number().finite().nonnegative(),
      error: z.string().optional(),
    }),
  ),
})

export async function buildNodeAutomationsSnapshot(
  options: {
    statePath?: string
    now?: () => Date
  } = {},
): Promise<AutomationsSnapshot> {
  const observedAt = (options.now ?? (() => new Date()))().toISOString()
  const statePath =
    options.statePath ??
    (process.env.SPORTSDESK_BRIDGE_STATE_PATH?.trim() ||
      resolve(process.cwd(), "scratch/bridge-rollup-state.json"))
  try {
    const raw: unknown = JSON.parse(await readFile(statePath, "utf8"))
    const receipt = collectorReceiptSchema.parse(raw)
    if (Date.parse(receipt.updatedAt) > Date.parse(observedAt)) throw new Error("Future receipt")
    return {
      source: "collector-state",
      observedAt,
      bridgeRollupUpdatedAt: receipt.updatedAt,
      bridgeJobs: receipt.jobs,
      schedules: [],
      ticketVerification: null,
    }
  } catch {
    return {
      source: "unavailable",
      sourceError:
        "No valid collector receipt. Mount the collector state file and set SPORTSDESK_BRIDGE_STATE_PATH. This dashboard does not run collector schedules.",
      observedAt,
      bridgeRollupUpdatedAt: null,
      bridgeJobs: [],
      schedules: [],
      ticketVerification: null,
    }
  }
}

export function buildUnmeasuredTicketVerification(): TicketVerificationSummary {
  return {
    schemaVersion: 1,
    available: false,
    mode: "unmeasured",
    verifiedAt: null,
    sourcePath: null,
    totalRows: 0,
    actionableTickets: 0,
    sentinelNoiseCount: 0,
    volumeMismatchCount: 0,
    totalWageredCents: 0,
    totalVolumeCents: 0,
    totalToWinCents: 0,
    canaryPassed: false,
    clientSealed: false,
    f402Status: "skipped",
    r2Status: "skipped",
    r2PublishedKey: null,
    error: "Ticket verification is not implemented by the Node dashboard host.",
    remediation: "Run the collector's ticket verification command and inspect its receipt.",
  }
}
