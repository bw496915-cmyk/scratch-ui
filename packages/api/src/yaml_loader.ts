/**
 * @file packages/api/src/yaml_loader.ts
 * @description Server-side read-only loader for workspace YAML configuration
 * (`config/bet-flags.yml`) powered by `Bun.YAML.parse` (with pure-TS YAML 1.2
 * fallback under Node.js / `tsx`).
 *
 * Security invariants:
 * - Confines filesystem resolution strictly inside `projectRoot` using a
 *   trailing `path.sep` boundary check (`resolved.startsWith(root + sep)`).
 * - Enforces byte-length caps and prototype-pollution stripping via
 *   `parseBunYamlWithMeta`.
 * - Redacts sensitive keys via `redactYamlSensitiveValues` before summarizing
 *   for `/api/config/status`.
 */

import { readFileSync } from "node:fs"
import { resolve, sep } from "node:path"
import {
  isNativeBunYamlAvailable,
  parseBunYamlWithMeta,
  redactYamlSensitiveValues,
  summarizeBetFlagsYamlDocument,
  type WorkspaceYamlConfigSummary,
} from "../../contracts/src/bun_yaml.ts"

export interface LoadWorkspaceYamlConfigOptions {
  readonly projectRoot?: string | undefined
  readonly relativePath?: string | undefined
  readonly forceFallback?: boolean | undefined
}

export function loadWorkspaceYamlConfigSummary(
  options: LoadWorkspaceYamlConfigOptions = {},
): WorkspaceYamlConfigSummary {
  const root = resolve(options.projectRoot ?? process.cwd())
  const relPath = options.relativePath ?? "config/bet-flags.yml"
  const targetPath = resolve(root, relPath)

  if (targetPath !== root && !targetPath.startsWith(`${root}${sep}`)) {
    return {
      filePath: relPath,
      detected: false,
      engine: isNativeBunYamlAvailable() && !options.forceFallback ? "bun-native" : "ts-fallback",
      byteLength: 0,
      schemaVersion: null,
      totalRules: 0,
      enabledRules: 0,
      disabledRules: 0,
      aggregateRules: 0,
      severityCounts: {},
      tags: [],
      rules: [],
      parseError: "Rejected YAML path outside workspace root",
    }
  }

  let rawText: string
  try {
    rawText = readFileSync(targetPath, "utf8")
  } catch {
    return {
      filePath: relPath,
      detected: false,
      engine: isNativeBunYamlAvailable() && !options.forceFallback ? "bun-native" : "ts-fallback",
      byteLength: 0,
      schemaVersion: null,
      totalRules: 0,
      enabledRules: 0,
      disabledRules: 0,
      aggregateRules: 0,
      severityCounts: {},
      tags: [],
      rules: [],
    }
  }

  try {
    const parsedMeta = parseBunYamlWithMeta(rawText, {
      forceFallback: options.forceFallback,
    })
    const redacted = redactYamlSensitiveValues(parsedMeta.value)
    return summarizeBetFlagsYamlDocument(redacted, {
      filePath: relPath,
      engine: parsedMeta.engine,
      byteLength: parsedMeta.byteLength,
    })
  } catch (err) {
    return {
      filePath: relPath,
      detected: true,
      engine: isNativeBunYamlAvailable() && !options.forceFallback ? "bun-native" : "ts-fallback",
      byteLength: Buffer.byteLength(rawText, "utf8"),
      schemaVersion: null,
      totalRules: 0,
      enabledRules: 0,
      disabledRules: 0,
      aggregateRules: 0,
      severityCounts: {},
      tags: [],
      rules: [],
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}
