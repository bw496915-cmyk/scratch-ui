/**
 * @file packages/api/src/bun_runtime_surface_loader.ts
 * @description Server-side read-only Bun Runtime Surface Audit loader.
 *
 * - Under Bun: executes `runBunSurfaceAudit()` directly in-process.
 * - Under Node.js (`tsx server.ts`): probes the installed `bun` binary using
 *   a fixed, read-only `execFileSync("bun", ["-e", ...])` call with a scrubbed
 *   environment (no shell, no user input, no secrets forwarded), falling back
 *   cleanly to `runBunSurfaceAudit()` if `bun` is not installed on PATH.
 */

import { execFileSync } from "node:child_process"
import {
  BUN_GLOBAL_TIERS,
  buildAuditSnapshotFromBinaryProbe,
  runBunSurfaceAudit,
  type BunNamespaceExportEntry,
  type BunRuntimeSurfaceAuditSnapshot,
  type LiveGlobalProbeEntry,
} from "../../contracts/src/bun_runtime_surface.ts"

const CACHE_TTL_MS = 60_000

let cachedBinaryAudit: {
  readonly expiresAt: number
  readonly snapshot: BunRuntimeSurfaceAuditSnapshot
} | null = null

const SERIALIZED_TIERS = JSON.stringify(
  BUN_GLOBAL_TIERS.map((t) => ({ id: t.id, globals: t.globals })),
)

/**
 * Fixed, hardcoded read-only probe script matching Section 4 of the Bun Runtime
 * Surface Audit specification. Never reads or prints `Bun.env` or `process.env`
 * values — only inspects property names and `typeof`.
 */
const FIXED_BUN_BINARY_PROBE_SCRIPT = `
const tiers = ${SERIALIZED_TIERS};
const g = globalThis;
const bunKeys = Object.getOwnPropertyNames(Bun)
  .map((key) => {
    let t = "unknown";
    try { t = typeof Bun[key]; } catch { t = "getter"; }
    return { key, type: t };
  })
  .sort((a, b) => a.key.localeCompare(b.key));
const globalProbes = [];
for (const tier of tiers) {
  for (const name of tier.globals) {
    let present = false;
    let valueType = "undefined";
    try {
      if (name === "__dirname") {
        present = typeof __dirname !== "undefined";
        valueType = typeof __dirname;
      } else if (name === "__filename") {
        present = typeof __filename !== "undefined";
        valueType = typeof __filename;
      } else if (name === "require") {
        present = typeof require !== "undefined";
        valueType = typeof require;
      } else {
        present = g[name] !== undefined;
        valueType = typeof g[name];
      }
    } catch {
      present = false;
      valueType = "inaccessible";
    }
    globalProbes.push({ name, tier: tier.id, present, valueType });
  }
}
const inspectTableText = Bun.inspect.table(bunKeys, ["key", "type"], { colors: false });
process.stdout.write(JSON.stringify({
  bunVersion: String(Bun.version ?? ""),
  bunRevision: String(Bun.revision ?? ""),
  isMainThread: Boolean(Bun.isMainThread),
  processEnvEqualsBunEnv: process.env === Bun.env,
  exports: bunKeys,
  globalProbes,
  inspectTableText,
}));
`

interface RawBinaryProbePayload {
  readonly bunVersion: string
  readonly bunRevision: string
  readonly isMainThread: boolean
  readonly processEnvEqualsBunEnv: boolean
  readonly exports: readonly BunNamespaceExportEntry[]
  readonly globalProbes?: readonly LiveGlobalProbeEntry[] | undefined
  readonly inspectTableText?: string | undefined
}

export interface LoadBunRuntimeSurfaceOptions {
  readonly forceRefresh?: boolean | undefined
  readonly disableBinaryProbe?: boolean | undefined
}

export function loadBunRuntimeSurfaceAudit(
  options: LoadBunRuntimeSurfaceOptions = {},
): BunRuntimeSurfaceAuditSnapshot {
  const inProcess = runBunSurfaceAudit()
  if (inProcess.bunDetected || options.disableBinaryProbe) {
    return inProcess
  }

  const now = Date.now()
  if (!options.forceRefresh && cachedBinaryAudit && cachedBinaryAudit.expiresAt > now) {
    return cachedBinaryAudit.snapshot
  }

  const startedMs = performance.now()
  try {
    const rawStdout = execFileSync("bun", ["-e", FIXED_BUN_BINARY_PROBE_SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      },
      timeout: 2_500,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })

    const parsed = JSON.parse(rawStdout) as RawBinaryProbePayload
    if (parsed && typeof parsed.bunVersion === "string" && Array.isArray(parsed.exports)) {
      const snapshot = buildAuditSnapshotFromBinaryProbe(
        parsed,
        Math.max(0, performance.now() - startedMs),
      )
      cachedBinaryAudit = {
        expiresAt: now + CACHE_TTL_MS,
        snapshot,
      }
      return snapshot
    }
  } catch {
    // Bun binary not installed or timed out — fall back gracefully to host Node snapshot
  }

  return inProcess
}
