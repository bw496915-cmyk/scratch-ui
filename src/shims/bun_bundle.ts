/**
 * @file src/shims/bun_bundle.ts
 * @description Node.js/Vite runtime shim for `import { feature } from "bun:bundle"`.
 */

const ACTIVE_FEATURES = new Set<string>(
  import.meta.env?.PROD ? ["PROD", "ANALYTICS"] : ["DEBUG", "EXPERIMENTAL"],
)

export function feature(name: string): boolean {
  return ACTIVE_FEATURES.has(name)
}
