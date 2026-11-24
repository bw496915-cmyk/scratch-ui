/**
 * Node.js/Vite runtime shim for `import { feature } from "bun:bundle"`.
 *
 * @file Src/shims/bun_bundle.ts
 */

const ACTIVE_FEATURES = new Set<string>(
  import.meta.env?.PROD ? ["PROD", "ANALYTICS"] : ["DEBUG", "EXPERIMENTAL"],
)

export function feature(name: string): boolean {
  return ACTIVE_FEATURES.has(name)
}
