/**
 * Stat-stamped bounded caches and JSON readers for the SportsDesk dashboard backend.
 *
 * @file Packages/backend/src/cache.ts
 */

import { readFile, stat } from "node:fs/promises"

/** Return a compact mtime+size cache stamp for a file, or `null` if unavailable. */
export async function statStamp(filePath: string): Promise<string | null> {
  const st = await stat(filePath).catch(() => null)
  return st === null ? null : `${st.mtimeMs}:${st.size}`
}

/** Bounded key-value cache keyed by file stamp (`mtimeMs:size`). */
export class BoundedStampCache<T> {
  private readonly store = new Map<string, { readonly stamp: string; readonly value: T }>()
  private readonly maxEntries: number

  constructor(maxEntries = 24) {
    this.maxEntries = Math.max(1, maxEntries)
  }

  get size(): number {
    return this.store.size
  }

  getIfFresh(key: string, stamp: string): T | undefined {
    const hit = this.store.get(key)
    if (hit !== undefined && hit.stamp === stamp) {
      return hit.value
    }
    return undefined
  }

  set(key: string, stamp: string, value: T): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      this.store.clear()
    }
    this.store.set(key, { stamp, value })
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }
}

type BunPeekFn = (<T>(promise: Promise<T> | T) => T | Promise<T>) & {
  readonly status?: (promise: Promise<unknown>) => "fulfilled" | "pending" | "rejected"
}

function getBunPeek(): BunPeekFn | undefined {
  const bun = (globalThis as unknown as { readonly Bun?: { readonly peek?: BunPeekFn } }).Bun
  return typeof bun?.peek === "function" ? bun.peek : undefined
}

export interface CachedJsonReader {
  readCachedJson: <T>(filePath: string) => Promise<{ stamp: string; value: T } | null>
  /**
   * Synchronous zero-microtask read of the most recently cached or already-settled in-flight JSON
   * payload (leverages `Bun.peek` / `Bun.peek.status` under Bun).
   */
  peekCachedJson: <T>(filePath: string) => { stamp: string; value: T } | null
  clear: () => void
}

/**
 * Create a stat-stamped JSON file reader bounded to `maxEntries` paths with in-flight dedup &
 * `Bun.peek` fast path.
 */
export function createCachedJsonReader(maxEntries = 24): CachedJsonReader {
  const cache = new BoundedStampCache<unknown>(maxEntries)
  const latestStamps = new Map<string, string>()
  const inFlight = new Map<string, Promise<{ stamp: string; value: unknown } | null>>()

  return {
    async readCachedJson<T>(filePath: string): Promise<{ stamp: string; value: T } | null> {
      const stamp = await statStamp(filePath)
      if (stamp === null) {
        cache.delete(filePath)
        latestStamps.delete(filePath)
        return null
      }
      const hit = cache.getIfFresh(filePath, stamp)
      if (hit !== undefined) {
        return { stamp, value: hit as T }
      }

      const inflightKey = `${filePath}\0${stamp}`
      const existing = inFlight.get(inflightKey)
      if (existing) {
        // Zero-microtask fast-path under Bun if the shared promise already settled
        const peek = getBunPeek()
        if (peek && typeof peek.status === "function" && peek.status(existing) === "fulfilled") {
          return peek(existing) as { stamp: string; value: T } | null
        }
        return (await existing) as { stamp: string; value: T } | null
      }

      const loadPromise: Promise<{ stamp: string; value: unknown } | null> = readFile(
        filePath,
        "utf8",
      )
        .then((raw) => {
          const parsed = JSON.parse(raw) as unknown
          cache.set(filePath, stamp, parsed)
          latestStamps.set(filePath, stamp)
          return { stamp, value: parsed }
        })
        .finally(() => {
          if (inFlight.get(inflightKey) === loadPromise) {
            inFlight.delete(inflightKey)
          }
        })

      inFlight.set(inflightKey, loadPromise)
      return (await loadPromise) as { stamp: string; value: T } | null
    },

    peekCachedJson<T>(filePath: string): { stamp: string; value: T } | null {
      const stamp = latestStamps.get(filePath)
      if (stamp !== undefined) {
        const hit = cache.getIfFresh(filePath, stamp)
        if (hit !== undefined) {
          return { stamp, value: hit as T }
        }
      }
      const peek = getBunPeek()
      if (peek && typeof peek.status === "function") {
        const prefix = `${filePath}\0`
        for (const [key, promise] of inFlight.entries()) {
          if (key.startsWith(prefix) && peek.status(promise) === "fulfilled") {
            return peek(promise) as { stamp: string; value: T } | null
          }
        }
      }
      return null
    },

    clear() {
      cache.clear()
      latestStamps.clear()
      inFlight.clear()
    },
  }
}
