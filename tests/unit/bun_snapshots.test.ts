import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { parseBunLockFile, summarizeBunLockFile } from "../../packages/contracts/src/bun_lockfile.ts"
import { parseBunYaml, stringifyBunYaml, summarizeBetFlagsYamlDocument } from "../../packages/contracts/src/bun_yaml.ts"
import {
  buildRegistryCredentialLookupKeys,
  convertNpmrcToBunfigToml,
  parseBunfigInstallToml,
  parseNpmrc,
  redactResolvedBunPackageConfig,
  resolveBunPackageConfig,
} from "../../packages/contracts/src/npmrc.ts"
import { lintSnapshotTestSource, validateSnapshotFileHeader } from "../../scripts/check_snapshot_hygiene.ts"
import {
  addFileSnapshotSerializer,
  createRedactedSnapshotCredential,
  prepareForSnapshot,
} from "../preload/snapshot_serializers.ts"

interface DeskAgentRecord {
  readonly id: number
  readonly name: string
  readonly handleUsd: number
  readonly active: boolean
}

function generateDeskReport(records: readonly DeskAgentRecord[], fixedTimestamp = "2024-01-01T00:00:00.000Z") {
  const totalHandleUsd = records.reduce((acc, item) => acc + item.handleUsd, 0)
  return {
    total: records.length,
    activeCount: records.filter((item) => item.active).length,
    totalHandleUsd,
    summary: records.map((item) => ({
      id: item.id,
      name: item.name,
      sharePct: totalHandleUsd > 0 ? Number(((item.handleUsd / totalHandleUsd) * 100).toFixed(2)) : 0,
    })),
    timestamp: fixedTimestamp,
  }
}

describe("Bun test snapshots — Complex Objects", () => {
  test("snapshots a deeply nested operator profile object", () => {
    const operator = {
      id: 1,
      name: "John Doe",
      email: "john@example.com",
      profile: {
        age: 30,
        role: "desk-operator",
        preferences: {
          theme: "dark",
          notifications: true,
          heatmapEnabled: true,
        },
      },
      tags: ["developer", "typescript", "bun"],
    }

    expect(operator).toMatchSnapshot()
  })

  test("snapshots a complex multi-layer redacted Bun package & lockfile config", () => {
    const lockfile = parseBunLockFile(
      JSON.stringify({
        lockfileVersion: 2,
        configVersion: 1,
        workspaces: {
          "": { name: "sportsdesk-ops", dependencies: { react: "^19.0.0" } },
          "packages/api": { name: "@sportsdesk-ops/api", version: "1.0.0" },
          "packages/ui": { name: "@sportsdesk-ops/ui", version: "1.0.0" },
        },
        overrides: { ws: "8.18.0" },
        trustedDependencies: ["esbuild"],
        packages: {
          esbuild: ["esbuild@0.25.0", "", { hasInstallScript: true }, "sha512-fixed-esbuild"],
          "@esbuild/linux-x64": [
            "@esbuild/linux-x64@0.25.0",
            "",
            { os: "linux", cpu: "x64", libc: "glibc" },
            "sha512-fixed-native",
          ],
        },
      }),
    )

    const projectNpmrc = parseNpmrc(
      [
        "registry=https://registry.npmjs.org/",
        "@sportsdesk-ops:registry=https://npm.example.com/team/a/",
        "//npm.example.com/team/:_authToken=${NPM_TOKEN}",
        "save-exact=true",
        "ignore-scripts=true",
      ].join("\n"),
      {
        source: "project-npmrc",
        env: { NPM_TOKEN: "redacted-in-snapshot-token" },
      },
    )

    const projectBunfig = parseBunfigInstallToml(
      ["[install]", 'minimumReleaseAge = "3d"', "globalStore = true", "[run]", "noOrphans = true"].join("\n"),
      "project-bunfig",
    )

    const resolved = resolveBunPackageConfig({
      bunLockfile: lockfile,
      projectNpmrc,
      projectBunfig,
    })

    const redacted = redactResolvedBunPackageConfig(resolved, [
      {
        layer: "bun-lockfile",
        label: "0. Project ./bun.lock (BunLockFile)",
        path: "./bun.lock",
        detected: true,
        activeKeys: ["lockfileVersion=2", "configVersion=1", "3 workspaces"],
      },
      {
        layer: "project-npmrc",
        label: "2. Project ./.npmrc",
        path: "./.npmrc",
        detected: true,
        activeKeys: ["registry", "@sportsdesk-ops:registry", "save-exact"],
      },
      {
        layer: "project-bunfig",
        label: "3b. Project ./bunfig.toml",
        path: "./bunfig.toml",
        detected: true,
        activeKeys: ["install.minimumReleaseAge", "install.globalStore", "run.noOrphans"],
      },
    ])

    expect(redacted).toMatchSnapshot()
  })
})

describe("Bun test snapshots — Array Snapshots", () => {
  test("snapshots a deterministic transformed numeric array", () => {
    const numbers = [1, 2, 3, 4, 5].map((n) => n * 2)
    expect(numbers).toMatchSnapshot()
  })

  test("snapshots registry credential path-segment fallback lookup keys", () => {
    const lookupKeys = buildRegistryCredentialLookupKeys(new URL("https://npm.example.com:443/org/team/a/"))
    expect(lookupKeys).toMatchSnapshot()
  })

  test("snapshots parsed YAML bet-flag rules array", () => {
    const yamlDoc = `
schemaVersion: 1
rules:
  - id: stake_over_10k
    title: Single bet stake of $10,000 or more
    severity: high
    enabled: true
    tags: [stake]
    when: { field: stakeUsd, op: gte, value: 10000 }
  - id: rapid_fire_5_in_60s
    title: 5+ live bets in 60s by one customer
    severity: critical
    enabled: false
    tags: [velocity, live]
    when: { field: isLive, op: eq, value: true }
    aggregate: { groupBy: customerId, windowSeconds: 60, countAtLeast: 5 }
`
    const parsed = parseBunYaml(yamlDoc)
    const summary = summarizeBetFlagsYamlDocument(parsed, {
      filePath: "config/bet-flags.yml",
      engine: "bun-native",
      byteLength: yamlDoc.length,
    })

    expect(summary.rules).toMatchSnapshot()
  })
})

describe("Bun test snapshots — Function Output Snapshots", () => {
  test("snapshots deterministic desk report generator output", () => {
    const data: readonly DeskAgentRecord[] = [
      { id: 1, name: "Alice", handleUsd: 60_000, active: true },
      { id: 2, name: "Bob", handleUsd: 40_000, active: true },
      { id: 3, name: "Carlos", handleUsd: 0, active: false },
    ]

    expect(generateDeskReport(data, "2024-01-01T00:00:00.000Z")).toMatchSnapshot()
  })

  test("snapshots summarizeBunLockFile() output for monorepo isolated linker", () => {
    const lockfile = parseBunLockFile(`{
      // Bun text lockfile snapshot fixture
      "lockfileVersion": 2,
      "configVersion": 1,
      "workspaces": {
        "": { "name": "root-app", "dependencies": { "zod": "^3.24.0" }, },
        "packages/contracts": { "name": "@app/contracts", "version": "0.1.0", },
      },
      "packages": {
        "zod": ["zod@3.24.0", "", {}, "sha512-zod"],
      },
    }`)

    expect(summarizeBunLockFile(lockfile)).toMatchSnapshot()
  })

  test("snapshots convertNpmrcToBunfigToml() and stringifyBunYaml() with explicit hints", () => {
    const npmrc = parseNpmrc(
      [
        "registry=https://registry.npmjs.org/",
        "@myorg:registry=https://npm.example.com/team/",
        "//npm.example.com/team/:_authToken=${NPM_TOKEN}",
        "save-exact=true",
        "ignore-scripts=true",
        "node-linker=isolated",
      ].join("\n"),
      {
        source: "project-npmrc",
        env: { NPM_TOKEN: "never-written-to-toml" },
      },
    )

    const resolved = resolveBunPackageConfig({ projectNpmrc: npmrc })
    expect(convertNpmrcToBunfigToml(resolved)).toMatchSnapshot("bunfig-toml-migration")

    const yamlOutput = stringifyBunYaml(
      {
        service: "sportsdesk-ops",
        port: 3000,
        features: ["yaml-1.2", "bun-lockfile", "snapshots"],
      },
      { space: 2, forceFallback: true },
    )
    expect(yamlOutput).toMatchSnapshot("yaml-block-stringify")
  })
})

interface LifoSnapshotMetric {
  readonly __brand: "LifoSnapshotMetric"
  readonly name: string
  readonly value: number
}

describe("Bun test snapshots — Preload Serializers, LIFO Order, Inline & Lint Rules", () => {
  test("applies preload serializers from bunfig.toml across test files to redact secrets & URL credentials", () => {
    const payload = prepareForSnapshot({
      credential: createRedactedSnapshotCredential("registry-auth", "Bearer", "top-secret-never-serialized"),
      registryUrl: new URL("https://operator:secretpass@npm.example.com/team/"),
    })

    expect(payload).toMatchInlineSnapshot(`
      {
        "credential": "RedactedCredential<registry-auth · Bearer · [REDACTED]>",
        "registryUrl": "RedactedURL<https://npm.example.com/team/>",
      }
    `)
  })

  test("applies file-scoped serializers in LIFO order (last serializer added runs first)", () => {
    const isLifoMetric = (val: unknown): val is LifoSnapshotMetric =>
      val !== null &&
      typeof val === "object" &&
      (val as { readonly __brand?: unknown }).__brand === "LifoSnapshotMetric"

    // Earlier serializer
    addFileSnapshotSerializer({
      test: isLifoMetric,
      serialize(val: unknown): string {
        const m = val as LifoSnapshotMetric
        return `EARLY<${m.name}=${m.value}>`
      },
    })

    // Later serializer — MUST run first per Bun LIFO serializer ordering
    addFileSnapshotSerializer({
      test: isLifoMetric,
      serialize(val: unknown): string {
        const m = val as LifoSnapshotMetric
        return `LIFO_LATEST<${m.name}:${m.value}>`
      },
    })

    const metric: LifoSnapshotMetric = {
      __brand: "LifoSnapshotMetric",
      name: "handle_usd",
      value: 25000,
    }

    expect(prepareForSnapshot(metric)).toMatchInlineSnapshot(`"LIFO_LATEST<handle_usd:25000>"`)
  })

  test("verifies Bun snapshot file header and enforces prefer-snapshot-hint, no-large-snapshots, and no-interpolation-in-snapshots", () => {
    const snapPath = resolve(import.meta.dir, "__snapshots__", "bun_snapshots.test.ts.snap")
    const snapContent = readFileSync(snapPath, "utf8")
    expect(snapContent.startsWith("// Bun Snapshot v1")).toBe(true)
    expect(validateSnapshotFileHeader(snapContent, "bun_snapshots.test.ts.snap")).toBeNull()
    expect(
      validateSnapshotFileHeader("// Vitest Snapshot v1, https://vitest.dev/guide/snapshot.html\n", "v.snap"),
    ).toBeNull()
    expect(validateSnapshotFileHeader("// Jest Snapshot v1, https://goo.gl/fbAQLP\n", "j.snap")).toBeNull()
    expect(validateSnapshotFileHeader("exports[`bad`] = `1`;\n", "bad.snap")?.rule).toBe(
      "bun:test/valid-snapshot-header",
    )

    // 1. prefer-snapshot-hint catches multi-snapshot tests missing hints
    const missingHints = lintSnapshotTestSource(
      `
      test("two snaps without hints", () => {
        expect(1).toMatchSnapshot();
        expect(2).toMatchSnapshot();
      });
      `,
      "sample.test.ts",
    )
    expect(missingHints.map((v) => v.rule)).toEqual(["bun:test/prefer-snapshot-hint", "bun:test/prefer-snapshot-hint"])

    // 2. no-large-snapshots catches inline snapshots > 50 lines
    const largeInline = `test("huge", () => {\n  expect(x).toMatchInlineSnapshot(\`${"line\n".repeat(55)}\`);\n});`
    const largeViolations = lintSnapshotTestSource(largeInline, "large.test.ts")
    expect(largeViolations.some((v) => v.rule === "bun:test/no-large-snapshots")).toBe(true)

    // 3. no-interpolation-in-snapshots catches ${...} inside inline snapshots
    const interpolated = 'test("interp", () => {\n  expect(x).toMatchInlineSnapshot(`value: ${dynamic}`);\n});'
    const interpViolations = lintSnapshotTestSource(interpolated, "interp.test.ts")
    expect(interpViolations.some((v) => v.rule === "bun:test/no-interpolation-in-snapshots")).toBe(true)
  })
})
