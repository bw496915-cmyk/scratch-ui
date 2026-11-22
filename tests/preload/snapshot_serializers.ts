/**
 * @file tests/preload/snapshot_serializers.ts
 * @description Global `bun test` preload script registered in `bunfig.toml`
 * (`[test].preload`).
 *
 * Semantics (matching Bun Snapshots specification):
 * - Serializers registered during preload apply to every test file after it.
 * - File-scoped serializers registered via `addFileSnapshotSerializer(...)`
 *   apply until that test file ends (cleaned up automatically via `afterAll`).
 * - LIFO precedence: the last serializer added runs first.
 * - Automatically registers with native `expect.addSnapshotSerializer(...)`
 *   when supported by the active Bun runtime, and provides `prepareForSnapshot`
 *   for consistent LIFO serialization on runtimes (e.g. Bun 1.4.4) where native
 *   `expect.addSnapshotSerializer` throws `Not implemented`.
 */

import { afterAll, expect } from "bun:test"

export interface SnapshotSerializerPlugin {
  readonly test: (val: unknown) => boolean
  readonly serialize: (val: unknown) => string
}

export interface RedactedSnapshotCredential {
  readonly __brand: "RedactedSnapshotCredential"
  readonly label: string
  readonly scheme: "Bearer" | "Basic" | "HMAC"
  readonly rawSecret?: string | undefined
}

export function createRedactedSnapshotCredential(
  label: string,
  scheme: "Bearer" | "Basic" | "HMAC",
  rawSecret?: string,
): RedactedSnapshotCredential {
  return {
    __brand: "RedactedSnapshotCredential",
    label,
    scheme,
    rawSecret,
  }
}

function isRedactedSnapshotCredential(val: unknown): val is RedactedSnapshotCredential {
  return (
    val !== null &&
    typeof val === "object" &&
    (val as { readonly __brand?: unknown }).__brand === "RedactedSnapshotCredential"
  )
}

const preloadSerializers: SnapshotSerializerPlugin[] = []
const fileSerializers: SnapshotSerializerPlugin[] = []
let nativeSerializerSupported: boolean | null = null

function tryRegisterNativeSerializer(plugin: SnapshotSerializerPlugin): boolean {
  if (nativeSerializerSupported === false) return false
  if (typeof expect.addSnapshotSerializer !== "function") {
    nativeSerializerSupported = false
    return false
  }
  try {
    expect.addSnapshotSerializer(plugin)
    nativeSerializerSupported = true
    return true
  } catch (err) {
    if (err instanceof Error && /not implemented/i.test(err.message)) {
      nativeSerializerSupported = false
      return false
    }
    throw err
  }
}

export function isNativeSnapshotSerializerSupported(): boolean {
  return nativeSerializerSupported === true
}

/**
 * Register a global preload serializer that applies to every test file after it.
 */
export function addPreloadSnapshotSerializer(plugin: SnapshotSerializerPlugin): void {
  preloadSerializers.push(plugin)
  tryRegisterNativeSerializer(plugin)
}

/**
 * Register a file-scoped serializer that applies until the current test file
 * finishes (`afterAll`), running before earlier serializers (LIFO).
 */
export function addFileSnapshotSerializer(plugin: SnapshotSerializerPlugin): void {
  fileSerializers.push(plugin)
  tryRegisterNativeSerializer(plugin)
  afterAll(() => {
    const idx = fileSerializers.lastIndexOf(plugin)
    if (idx !== -1) {
      fileSerializers.splice(idx, 1)
    }
  })
}

/**
 * Apply active snapshot serializers recursively in strict LIFO order
 * (file-scoped serializers newest-first, then preload serializers newest-first).
 */
export function prepareForSnapshot(root: unknown): unknown {
  const ordered = [...fileSerializers.slice().reverse(), ...preloadSerializers.slice().reverse()]
  const seen = new WeakSet<object>()

  function transform(node: unknown): unknown {
    for (const plugin of ordered) {
      if (plugin.test(node)) {
        return plugin.serialize(node)
      }
    }

    if (node === null || typeof node !== "object") {
      return node
    }
    if (seen.has(node)) {
      return "[Circular]"
    }
    seen.add(node)

    if (Array.isArray(node)) {
      return node.map((item) => transform(item))
    }

    if (node instanceof URL) {
      return node.toString()
    }

    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      out[key] = transform(val)
    }
    return out
  }

  return transform(root)
}

// 1. Preload-level serializer: redacts branded credentials across all test files
addPreloadSnapshotSerializer({
  test(val: unknown): boolean {
    return isRedactedSnapshotCredential(val)
  },
  serialize(val: unknown): string {
    const cred = val as RedactedSnapshotCredential
    return `RedactedCredential<${cred.label} · ${cred.scheme} · [REDACTED]>`
  },
})

// 2. Preload-level serializer: strips embedded user:pass@ from URL instances
addPreloadSnapshotSerializer({
  test(val: unknown): boolean {
    return val instanceof URL && (val.username !== "" || val.password !== "")
  },
  serialize(val: unknown): string {
    const safe = new URL((val as URL).toString())
    safe.username = ""
    safe.password = ""
    return `RedactedURL<${safe.toString()}>`
  },
})
