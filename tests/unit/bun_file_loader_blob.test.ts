import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import React from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { loadBunRuntimeSurfaceAudit } from "../../packages/api/src/bun_runtime_surface_loader.ts"
import { createConfigStatusStore } from "../../packages/api/src/config_status.ts"
import {
  buildBunAssetPipelineSnippets,
  BUN_ASSET_LOADER_COMPARISON,
  BUN_ASSET_LOADER_SPECS,
  BUN_ASSET_RUNTIME_EDGES,
  BUN_FILE_BLOB_CONSUMERS,
  BUN_FILE_LOADER_DASHBOARD_CONTRACT,
  BUN_FILE_PROPERTIES,
  deterministicAssetHash8,
  simulateFileLoaderEmissions,
} from "../../packages/contracts/src/bun_file_loader.ts"
import { BunFileLoaderSection } from "../../packages/ui/src/panels/BunFileLoaderSection.tsx"
import { BunRuntimeSurfaceSection } from "../../packages/ui/src/panels/BunRuntimeSurfaceSection.tsx"

const SAMPLE_PNG_SOURCE = resolve("public/assets/branding/sportsdesk-emblem-64.png")
const NODE_INCLUDE_DIR = "/usr/local/include/node"

/**
 * Minimal valid WebAssembly module exporting `add(i32, i32) -> i32`.
 */
const MINIMAL_ADD_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01,
  0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00, 0x0a, 0x09,
  0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
])

/**
 * Minimal C N-API v4 addon using `pthread` + `napi_create_threadsafe_function`
 * (`startWorkerThread(input, callback)`) + `addonVersion()`.
 */
const NAPI_TSFN_ADDON_C = `
#define NAPI_VERSION 4
#include <node_api.h>
#include <pthread.h>
#include <stdlib.h>

typedef struct {
  napi_threadsafe_function tsfn;
  int value;
} WorkerCtx;

static void call_js(napi_env env, napi_value js_cb, void *context, void *data) {
  (void)context;
  int *val = (int *)data;
  if (env != NULL && js_cb != NULL) {
    napi_value undefined_val, arg;
    napi_get_undefined(env, &undefined_val);
    napi_create_int32(env, *val, &arg);
    napi_call_function(env, undefined_val, js_cb, 1, &arg, NULL);
  }
  free(val);
}

static void *worker_main(void *arg) {
  WorkerCtx *ctx = (WorkerCtx *)arg;
  int *payload = (int *)malloc(sizeof(int));
  *payload = ctx->value * 2;
  napi_call_threadsafe_function(ctx->tsfn, payload, napi_tsfn_blocking);
  napi_release_threadsafe_function(ctx->tsfn, napi_tsfn_release);
  free(ctx);
  return NULL;
}

static napi_value StartWorkerThread(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, NULL, NULL);
  int32_t input = 21;
  if (argc >= 1) napi_get_value_int32(env, args[0], &input);
  napi_value cb = args[1];

  napi_value resource_name;
  napi_create_string_utf8(env, "tsfn_probe", NAPI_AUTO_LENGTH, &resource_name);

  napi_threadsafe_function tsfn;
  napi_create_threadsafe_function(env, cb, NULL, resource_name, 0, 1, NULL, NULL, NULL, call_js, &tsfn);

  WorkerCtx *ctx = (WorkerCtx *)malloc(sizeof(WorkerCtx));
  ctx->tsfn = tsfn;
  ctx->value = input;

  pthread_t tid;
  pthread_create(&tid, NULL, worker_main, ctx);
  pthread_detach(tid);

  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
}

static napi_value AddonVersion(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value str;
  napi_create_string_utf8(env, "tsfn-probe-1.0", NAPI_AUTO_LENGTH, &str);
  return str;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn1, fn2;
  napi_create_function(env, "startWorkerThread", NAPI_AUTO_LENGTH, StartWorkerThread, NULL, &fn1);
  napi_create_function(env, "addonVersion", NAPI_AUTO_LENGTH, AddonVersion, NULL, &fn2);
  napi_set_named_property(env, exports, "startWorkerThread", fn1);
  napi_set_named_property(env, exports, "addonVersion", fn2);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
`

function makeTempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function compileTsfnAddon(dir: string): string {
  const cPath = join(dir, "addon.c")
  const outPath = join(dir, "addon.node")
  writeFileSync(cPath, NAPI_TSFN_ADDON_C)
  const res = Bun.spawnSync([
    "cc",
    "-shared",
    "-fPIC",
    "-pthread",
    `-I${NODE_INCLUDE_DIR}`,
    cPath,
    "-o",
    outPath,
  ])
  if (res.exitCode !== 0) {
    throw new Error(`Failed to compile N-API TSFN addon: ${res.stderr.toString()}`)
  }
  return outPath
}

function createSeedSqliteDb(dbPath: string): void {
  const db = new Database(dbPath)
  db.exec(
    "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items (name) VALUES ('alpha');",
  )
  db.close()
}

describe("1. Contracts, Dashboard Schema & Pipeline Snippet Generator", () => {
  test("exposes complete loader specs, BunFile Blob properties, runtime edge specs, and dashboard contract", () => {
    expect(BUN_ASSET_LOADER_SPECS.map((s) => s.extension)).toEqual([
      ".png",
      ".svg",
      ".wasm",
      ".woff2",
      ".bin",
      ".yaml",
      ".node",
      ".db",
    ])
    expect(BUN_FILE_PROPERTIES.map((p) => p.feature)).toEqual([
      "Lazy",
      "Blob-compatible",
      "Streamable",
      "Response-ready",
      "Bun.write-ready",
      "MIME inferred",
    ])
    expect(BUN_ASSET_RUNTIME_EDGES.map((e) => e.id)).toEqual([
      "wasm-bytes-vs-fetch",
      "sqlite-embed-readonly",
      "napi-require-vs-import",
      "metafile-byte-attribution",
      "unknown-ext-compile-mime",
    ])
    expect(BUN_FILE_BLOB_CONSUMERS).toHaveLength(6)
    expect(BUN_ASSET_LOADER_COMPARISON.map((r) => r.loader)).toEqual([
      "file",
      "napi",
      "yaml",
      "sqlite",
    ])
    expect(BUN_FILE_LOADER_DASHBOARD_CONTRACT.subTabId).toBe("file-loader")
    expect(BUN_FILE_LOADER_DASHBOARD_CONTRACT.probeStripFields).toHaveLength(4)
    expect(BUN_FILE_LOADER_DASHBOARD_CONTRACT.workbenchCodeTabs).toEqual([
      "runtime",
      "build-api",
      "cli",
      "ci",
      "dist-tree",
    ])

    const h1 = deterministicAssetHash8("logo.png:image/png:v1.4")
    const h2 = deterministicAssetHash8("logo.png:image/png:v1.4")
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{8}$/)
  })

  test("simulates content-hashed emissions and generates portable CLI, JS API, --compile, and JUnit CI snippets", () => {
    const bunEmissions = simulateFileLoaderEmissions({
      enabledLoaderIds: ["png", "wasm", "yaml", "node", "sqlite"],
      target: "bun",
      compileMode: false,
      outdir: "./dist",
    })
    expect(bunEmissions).toHaveLength(5)
    expect(bunEmissions.find((e) => e.id === "png")?.emittedPath).toMatch(
      /^\.\/dist\/assets\/logo-[0-9a-f]{8}\.png$/,
    )
    expect(bunEmissions.find((e) => e.id === "wasm")?.inferredMime).toBe("application/wasm")
    expect(bunEmissions.find((e) => e.id === "node")?.emittedPath).toBe("./dist/addon.node")
    expect(bunEmissions.find((e) => e.id === "sqlite")?.runtimeValueType).toBe("database")

    const snippets = buildBunAssetPipelineSnippets({
      enabledLoaderIds: ["png", "wasm", "bin", "yaml", "node", "sqlite"],
      target: "bun",
      compileMode: true,
      includeMetafile: true,
      externalSourcemap: true,
    })
    expect(snippets.cliCommand).toContain("--loader:.png=file")
    expect(snippets.cliCommand).toContain("--loader:.wasm=file")
    expect(snippets.cliCommand).toContain("--loader:.yaml=yaml")
    expect(snippets.cliCommand).toContain("--loader:.node=napi")
    expect(snippets.cliCommand).toContain("--metafile=./dist/meta.json")
    expect(snippets.cliCommand).toContain("--metafile-md=./dist/meta.md")
    expect(snippets.compileCommand).toContain("--compile --outfile ./dist/app")
    expect(snippets.buildApiTs).toContain("metafile: true")
    expect(snippets.runtimeAppTs).toContain('require("./addon.node")')
    expect(snippets.runtimeAppTs).toContain(
      "WebAssembly.instantiate(await Bun.file(wasmUrl).bytes())",
    )
    expect(snippets.runtimeAppTs).toContain('seedDb.exec("PRAGMA query_only = ON")')
    expect(snippets.ciPackageJson).toContain(
      "bun test --reporter=junit --reporter-outfile=reports/junit.xml",
    )
  })
})

describe("2. Loaders / Hashing & Bun.build({ metafile: true }) Byte Attribution", () => {
  test("Bun.build({ metafile: true }) emits assets/<name>-<hash>.<ext> and attributes bytes per input", async () => {
    const workDir = makeTempWorkspace("bun-metafile-spec-")
    try {
      const srcDir = join(workDir, "src")
      const outDir = join(workDir, "dist")
      mkdirSync(srcDir, { recursive: true })

      copyFileSync(SAMPLE_PNG_SOURCE, join(srcDir, "logo.png"))
      writeFileSync(join(srcDir, "payload.weird"), new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
      writeFileSync(join(srcDir, "kernel.wasm"), MINIMAL_ADD_WASM)
      writeFileSync(join(srcDir, "config.yaml"), "name: sportsdesk-ops\nmode: live\n")
      writeFileSync(
        join(srcDir, "index.ts"),
        [
          'import logoUrl from "./logo.png";',
          'import weirdUrl from "./payload.weird";',
          'import wasmUrl from "./kernel.wasm";',
          'import config from "./config.yaml";',
          "export const manifest = { logoUrl, weirdUrl, wasmUrl, config };",
        ].join("\n"),
      )

      const result = await Bun.build({
        entrypoints: [join(srcDir, "index.ts")],
        outdir: outDir,
        target: "bun",
        naming: { asset: "assets/[name]-[hash].[ext]" },
        loaders: {
          ".png": "file",
          ".weird": "file",
          ".wasm": "file",
          ".yaml": "yaml",
        },
        metafile: true,
      })

      expect(result.success).toBe(true)

      // Assert emitted asset output paths match assets/<name>-<hash>.<ext>
      const assetOutputs = result.outputs.filter((o) => o.kind === "asset")
      expect(assetOutputs).toHaveLength(3)
      for (const asset of assetOutputs) {
        expect(asset.path).toMatch(/\/assets\/[a-z0-9_-]+-[a-z0-9]+\.(png|weird|wasm)$/i)
        expect(existsSync(asset.path)).toBe(true)
      }

      // Assert metafile.outputs[*].inputs attributes bytes
      const metafile = (
        result as unknown as {
          metafile?: {
            inputs: Record<string, { bytes: number }>
            outputs: Record<
              string,
              { bytes: number; inputs: Record<string, { bytesInOutput: number }> }
            >
          }
        }
      ).metafile
      expect(metafile).toBeDefined()
      const outputEntries = Object.entries(metafile?.outputs ?? {})
      expect(outputEntries.length).toBeGreaterThanOrEqual(1)

      const jsOutput = outputEntries.find(([k]) => k.endsWith("index.js"))?.[1]
      expect(jsOutput).toBeDefined()
      expect(jsOutput!.bytes).toBeGreaterThan(0)
      const attributedInputs = Object.entries(jsOutput!.inputs)
      expect(attributedInputs.length).toBeGreaterThanOrEqual(4)
      expect(attributedInputs.some(([k, v]) => k.endsWith("logo.png") && v.bytesInOutput > 0)).toBe(
        true,
      )
      expect(
        attributedInputs.some(([k, v]) => k.endsWith("payload.weird") && v.bytesInOutput > 0),
      ).toBe(true)
      expect(
        attributedInputs.some(([k, v]) => k.endsWith("kernel.wasm") && v.bytesInOutput > 0),
      ).toBe(true)
      expect(
        attributedInputs.some(([k, v]) => k.endsWith("config.yaml") && v.bytesInOutput > 0),
      ).toBe(true)

      // Assert CLI --metafile=<path> and --metafile-md=<path> parity
      const cliOut = join(workDir, "dist-cli")
      const metaJsonPath = join(cliOut, "meta.json")
      const metaMdPath = join(cliOut, "meta.md")
      const cli = Bun.spawnSync(
        [
          process.execPath,
          "build",
          join(srcDir, "index.ts"),
          "--outdir",
          cliOut,
          "--target",
          "bun",
          "--asset-naming=assets/[name]-[hash].[ext]",
          "--loader:.png=file",
          "--loader:.weird=file",
          "--loader:.wasm=file",
          "--loader:.yaml=yaml",
          `--metafile=${metaJsonPath}`,
          `--metafile-md=${metaMdPath}`,
        ],
        { cwd: workDir, stdout: "pipe", stderr: "pipe" },
      )
      expect(cli.exitCode).toBe(0)
      expect(existsSync(metaJsonPath)).toBe(true)
      expect(existsSync(metaMdPath)).toBe(true)
      const parsedCliMeta = JSON.parse(await Bun.file(metaJsonPath).text()) as {
        outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>
      }
      expect(Object.keys(parsedCliMeta.outputs).length).toBeGreaterThan(0)
      expect(await Bun.file(metaMdPath).text()).toContain("index.js")
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe("3. BunFile Blob Identity, .weird MIME Fallback & YAML Loader", () => {
  test("verifies BunFile Blob contract, unknown .weird MIME fallback, and YAML object import", async () => {
    const workDir = makeTempWorkspace("bun-file-blob-spec-")
    try {
      const pngPath = join(workDir, "x.png")
      const weirdPath = join(workDir, "mystery.weird")
      const yamlPath = join(workDir, "config.yaml")
      const copyDest = join(workDir, "copy.png")

      copyFileSync(SAMPLE_PNG_SOURCE, pngPath)
      writeFileSync(weirdPath, new Uint8Array([1, 2, 3, 4, 5, 6]))
      writeFileSync(yamlPath, "service: sportsdesk\nretries: 3\nactive: true\n")

      // Real dynamic import of file-loader-like / yaml assets under Bun runtime
      const yamlMod = (await import(yamlPath)) as { default: unknown }
      expect(typeof yamlMod.default).toBe("object")
      expect(typeof yamlMod.default).not.toBe("string")
      expect(yamlMod.default).toEqual({ service: "sportsdesk", retries: 3, active: true })

      // BunFile is a Blob
      const pngFile = Bun.file(pngPath)
      expect(pngFile instanceof Blob).toBe(true)
      expect(typeof pngFile.type).toBe("string")
      expect(pngFile.type).toBe("image/png")
      expect(pngFile.size).toBeGreaterThan(0)
      expect(await pngFile.exists()).toBe(true)
      expect(pngFile.slice(0, 64).size).toBe(64)
      expect(pngFile.stream()).toBeInstanceOf(ReadableStream)

      // Unknown extension MIME: .weird -> application/octet-stream
      const weirdFile = Bun.file(weirdPath)
      expect(weirdFile instanceof Blob).toBe(true)
      expect(weirdFile.type).toBe("application/octet-stream")
      expect(weirdFile.size).toBe(6)

      // Response, FormData, and zero-copy Bun.write
      const resp = new Response(pngFile, { headers: { "Content-Type": pngFile.type } })
      expect((await resp.arrayBuffer()).byteLength).toBe(pngFile.size)

      const form = new FormData()
      form.append("asset", pngFile, "x.png")
      expect((form.get("asset") as Blob).size).toBe(pngFile.size)

      expect(await Bun.write(copyDest, pngFile)).toBe(pngFile.size)
      expect(Bun.file(copyDest).size).toBe(pngFile.size)

      // Normal bun test runtime is not standalone and has empty Bun.embeddedFiles
      expect(Bun.isStandaloneExecutable).toBe(false)
      expect(Array.isArray(Bun.embeddedFiles)).toBe(true)
      expect(Bun.embeddedFiles.length).toBe(0)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe("4. WASM Edge Case Across dev, dist/, and --compile (Copied to Empty CWD)", () => {
  test("WebAssembly.instantiate(await Bun.file(wasmUrl).bytes()) succeeds while fetch(wasmUrl) fails in all 3 modes", () => {
    const workDir = makeTempWorkspace("bun-wasm-matrix-")
    const emptyDir = makeTempWorkspace("bun-wasm-empty-")
    try {
      writeFileSync(join(workDir, "add.wasm"), MINIMAL_ADD_WASM)
      writeFileSync(
        join(workDir, "wasm_entry.ts"),
        [
          'import wasmUrl from "./add.wasm" with { type: "file" };',
          "const bytes = await Bun.file(wasmUrl).bytes();",
          "const { instance } = await WebAssembly.instantiate(bytes);",
          "const sum = (instance.exports.add as (a: number, b: number) => number)(19, 23);",
          "let fetchFailed = false;",
          "let fetchErrMsg = '';",
          "try {",
          "  await fetch(wasmUrl);",
          "} catch (err) {",
          "  fetchFailed = true;",
          "  fetchErrMsg = err instanceof Error ? err.message : String(err);",
          "}",
          "console.log(JSON.stringify({ wasmUrl, sum, fetchFailed, fetchErrMsg, standalone: Bun.isStandaloneExecutable }));",
        ].join("\n"),
      )

      type WasmProbeOut = {
        wasmUrl: string
        sum: number
        fetchFailed: boolean
        fetchErrMsg: string
        standalone: boolean
      }

      // Mode 1: dev (bun run)
      const devRun = Bun.spawnSync([process.execPath, "run", join(workDir, "wasm_entry.ts")], {
        cwd: workDir,
      })
      expect(devRun.exitCode).toBe(0)
      const devOut = JSON.parse(devRun.stdout.toString().trim()) as WasmProbeOut
      expect(devOut.sum).toBe(42)
      expect(devOut.fetchFailed).toBe(true)
      expect(devOut.fetchErrMsg).toContain("URL is invalid")
      expect(devOut.standalone).toBe(false)

      // Mode 2: dist/ (bun build --outdir)
      const distDir = join(workDir, "dist")
      const distBuild = Bun.spawnSync(
        [
          process.execPath,
          "build",
          join(workDir, "wasm_entry.ts"),
          "--outdir",
          distDir,
          "--target",
          "bun",
          "--asset-naming=assets/[name]-[hash].[ext]",
          "--loader:.wasm=file",
        ],
        { cwd: workDir },
      )
      expect(distBuild.exitCode).toBe(0)
      const distRun = Bun.spawnSync([process.execPath, "run", join(distDir, "wasm_entry.js")], {
        cwd: distDir,
      })
      expect(distRun.exitCode).toBe(0)
      const distOut = JSON.parse(distRun.stdout.toString().trim()) as WasmProbeOut
      expect(distOut.wasmUrl).toMatch(/assets\/add-[a-z0-9]+\.wasm$/i)
      expect(distOut.sum).toBe(42)
      expect(distOut.fetchFailed).toBe(true)
      expect(distOut.standalone).toBe(false)

      // Mode 3: --compile copied to an isolated empty CWD
      const compiledBin = join(workDir, "wasm-app")
      const compBuild = Bun.spawnSync(
        [
          process.execPath,
          "build",
          join(workDir, "wasm_entry.ts"),
          "--compile",
          "--outfile",
          compiledBin,
          "--loader:.wasm=file",
        ],
        { cwd: workDir },
      )
      expect(compBuild.exitCode).toBe(0)
      const copiedBin = join(emptyDir, "wasm-app")
      copyFileSync(compiledBin, copiedBin)
      const compRun = Bun.spawnSync([copiedBin], { cwd: emptyDir })
      expect(compRun.exitCode).toBe(0)
      const compOut = JSON.parse(compRun.stdout.toString().trim()) as WasmProbeOut
      expect(compOut.wasmUrl).toContain("/$bunfs/")
      expect(compOut.sum).toBe(42)
      expect(compOut.fetchFailed).toBe(true)
      expect(compOut.standalone).toBe(true)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
      rmSync(emptyDir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("5. SQLite Embed Edge Case in --compile (Ephemeral :memory: vs SQLITE_READONLY)", () => {
  test("documents Bun 1.4.4 ephemeral :memory: embed behavior and verifies SQLITE_READONLY enforcement", () => {
    const workDir = makeTempWorkspace("bun-sqlite-embed-")
    const emptyDir = makeTempWorkspace("bun-sqlite-empty-")
    try {
      const embedDbPath = join(workDir, "seed_embed.db")
      const roFileDbPath = join(workDir, "seed_ro.db")
      createSeedSqliteDb(embedDbPath)
      createSeedSqliteDb(roFileDbPath)

      writeFileSync(
        join(workDir, "sqlite_entry.ts"),
        [
          'import embeddedDb from "./seed_embed.db" with { type: "sqlite", embed: "true" };',
          'import rawDbUrl from "./seed_ro.db" with { type: "file" };',
          'import { Database } from "bun:sqlite";',
          "",
          "// 1. Default with { type: 'sqlite', embed: 'true' } in Bun 1.4.4 opens ephemeral :memory:",
          'const initialRows = embeddedDb.query("SELECT name FROM items ORDER BY id").all();',
          "const filename = embeddedDb.filename;",
          "embeddedDb.exec(\"INSERT INTO items (name) VALUES ('ephemeral')\");",
          'const afterEphemeralInsert = embeddedDb.query("SELECT name FROM items ORDER BY id").all();',
          "",
          "// 2. Locking embedded DB with PRAGMA query_only = ON enforces SQLITE_READONLY",
          'embeddedDb.exec("PRAGMA query_only = ON");',
          "let pragmaReadonlyCode: string | null = null;",
          "try {",
          "  embeddedDb.exec(\"INSERT INTO items (name) VALUES ('blocked')\");",
          "} catch (e: unknown) {",
          "  pragmaReadonlyCode = (e as { code?: string })?.code ?? String(e);",
          "}",
          "",
          "// 3. Loading embedded file bytes via Database.deserialize(..., { readonly: true }) enforces SQLITE_READONLY",
          "const roDb = Database.deserialize(await Bun.file(rawDbUrl).bytes(), { readonly: true });",
          "let deserializeReadonlyCode: string | null = null;",
          "try {",
          "  roDb.exec(\"INSERT INTO items (name) VALUES ('blocked2')\");",
          "} catch (e: unknown) {",
          "  deserializeReadonlyCode = (e as { code?: string })?.code ?? String(e);",
          "}",
          "roDb.close();",
          "",
          "console.log(JSON.stringify({",
          "  standalone: Bun.isStandaloneExecutable,",
          "  filename,",
          "  initialRows,",
          "  afterEphemeralInsert,",
          "  pragmaReadonlyCode,",
          "  deserializeReadonlyCode,",
          "}));",
        ].join("\n"),
      )

      const binPath = join(workDir, "sqlite-app")
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          join(workDir, "sqlite_entry.ts"),
          "--compile",
          "--outfile",
          binPath,
        ],
        { cwd: workDir },
      )
      expect(build.exitCode).toBe(0)

      const copiedBin = join(emptyDir, "sqlite-app")
      copyFileSync(binPath, copiedBin)
      rmSync(workDir, { recursive: true, force: true })

      const run1 = Bun.spawnSync([copiedBin], { cwd: emptyDir })
      const run2 = Bun.spawnSync([copiedBin], { cwd: emptyDir })
      expect(run1.exitCode).toBe(0)
      expect(run2.exitCode).toBe(0)

      type SqliteProbeOut = {
        standalone: boolean
        filename: string
        initialRows: Array<{ name: string }>
        afterEphemeralInsert: Array<{ name: string }>
        pragmaReadonlyCode: string | null
        deserializeReadonlyCode: string | null
      }
      const out1 = JSON.parse(run1.stdout.toString().trim()) as SqliteProbeOut
      const out2 = JSON.parse(run2.stdout.toString().trim()) as SqliteProbeOut

      expect(out1.standalone).toBe(true)
      expect(out1.filename).toBe(":memory:")
      // Ephemeral insert works within run1, but run2 starts clean with only 'alpha'
      expect(out1.initialRows).toEqual([{ name: "alpha" }])
      expect(out1.afterEphemeralInsert).toEqual([{ name: "alpha" }, { name: "ephemeral" }])
      expect(out2.initialRows).toEqual([{ name: "alpha" }])
      // Both explicit readonly guards throw SQLITE_READONLY
      expect(out1.pragmaReadonlyCode).toBe("SQLITE_READONLY")
      expect(out1.deserializeReadonlyCode).toBe("SQLITE_READONLY")
    } finally {
      rmSync(workDir, { recursive: true, force: true })
      rmSync(emptyDir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("6. Unified --compile Matrix (PNG + .weird + YAML + WASM + Real N-API TSFN .node in Empty CWD)", () => {
  test("verifies N-API TSFN require() across dev/dist/--compile and proves full standalone binary in isolated empty CWD", () => {
    const workDir = makeTempWorkspace("bun-full-compile-matrix-")
    const emptyDir = makeTempWorkspace("bun-full-compile-empty-")
    try {
      const srcDir = join(workDir, "src")
      mkdirSync(srcDir, { recursive: true })

      // 1. Prepare all fixture assets: real PNG, .weird unknown ext, YAML, WASM, compiled real N-API TSFN .node
      const pngPath = join(srcDir, "x.png")
      copyFileSync(SAMPLE_PNG_SOURCE, pngPath)
      const originalPngSize = Bun.file(pngPath).size
      writeFileSync(join(srcDir, "payload.weird"), new Uint8Array([9, 8, 7, 6]))
      writeFileSync(join(srcDir, "config.yaml"), "desk: sportsdesk-ops\nversion: 144\n")
      writeFileSync(join(srcDir, "add.wasm"), MINIMAL_ADD_WASM)
      compileTsfnAddon(srcDir)

      // 2. Verify unbundled ESM `import` of .node throws documented Bun TypeError while `require()` succeeds
      writeFileSync(
        join(srcDir, "esm_napi_edge.ts"),
        'import addon from "./addon.node"; console.log(addon.addonVersion());',
      )
      const esmNapiDev = Bun.spawnSync(
        [process.execPath, "run", join(srcDir, "esm_napi_edge.ts")],
        {
          cwd: srcDir,
        },
      )
      expect(esmNapiDev.exitCode).not.toBe(0)
      expect(esmNapiDev.stderr.toString()).toContain("use require() or process.dlopen")

      // 3. Unified entrypoint combining all 5 asset pipelines
      const entryPath = join(srcDir, "unified.ts")
      writeFileSync(
        entryPath,
        [
          'import pngUrl from "./x.png" with { type: "file" };',
          'import weirdUrl from "./payload.weird" with { type: "file" };',
          'import wasmUrl from "./add.wasm" with { type: "file" };',
          'import config from "./config.yaml";',
          'const addon = require("./addon.node") as {',
          "  addonVersion: () => string;",
          "  startWorkerThread: (input: number, cb: (value: number) => void) => boolean;",
          "};",
          "",
          "const png = Bun.file(pngUrl);",
          "const weird = Bun.file(weirdUrl);",
          "const { instance } = await WebAssembly.instantiate(await Bun.file(wasmUrl).bytes());",
          "const wasmSum = (instance.exports.add as (a: number, b: number) => number)(19, 23);",
          "let wasmFetchFailed = false;",
          "try { await fetch(wasmUrl); } catch { wasmFetchFailed = true; }",
          "",
          "const tsfnResult = await new Promise<number>((resolve) => {",
          "  addon.startWorkerThread(21, (val) => resolve(val));",
          "});",
          "",
          "console.log(JSON.stringify({",
          "  isStandaloneExecutable: Bun.isStandaloneExecutable,",
          "  embeddedFilesCount: Bun.embeddedFiles.length,",
          "  png: {",
          "    url: pngUrl,",
          "    isBlob: png instanceof Blob,",
          "    type: png.type,",
          "    size: png.size,",
          "    exists: await png.exists(),",
          "    slice64: png.slice(0, 64).size,",
          "    hasStream: png.stream() instanceof ReadableStream,",
          "  },",
          "  weird: {",
          "    url: weirdUrl,",
          "    type: weird.type,",
          "    size: weird.size,",
          "  },",
          "  yaml: {",
          "    typeOf: typeof config,",
          "    value: config,",
          "  },",
          "  wasm: {",
          "    sum: wasmSum,",
          "    fetchFailed: wasmFetchFailed,",
          "  },",
          "  napi: {",
          "    typeOf: typeof addon,",
          "    version: addon.addonVersion(),",
          "    tsfnResult,",
          "  },",
          "}));",
        ].join("\n"),
      )

      type UnifiedOut = {
        isStandaloneExecutable: boolean
        embeddedFilesCount: number
        png: {
          url: string
          isBlob: boolean
          type: string
          size: number
          exists: boolean
          slice64: number
          hasStream: boolean
        }
        weird: { url: string; type: string; size: number }
        yaml: { typeOf: string; value: { desk: string; version: number } }
        wasm: { sum: number; fetchFailed: boolean }
        napi: { typeOf: string; version: string; tsfnResult: number }
      }

      // 3a. Verify in dev (bun run)
      const devRun = Bun.spawnSync([process.execPath, "run", entryPath], { cwd: srcDir })
      expect(devRun.exitCode).toBe(0)
      const devOut = JSON.parse(devRun.stdout.toString().trim()) as UnifiedOut
      expect(devOut.isStandaloneExecutable).toBe(false)
      expect(devOut.napi.tsfnResult).toBe(42)
      expect(devOut.wasm.sum).toBe(42)
      expect(devOut.wasm.fetchFailed).toBe(true)

      // 3b. Verify in dist/ (bun build --outdir)
      const distDir = join(workDir, "dist")
      const distBuild = Bun.spawnSync(
        [
          process.execPath,
          "build",
          entryPath,
          "--outdir",
          distDir,
          "--target",
          "bun",
          "--loader:.png=file",
          "--loader:.weird=file",
          "--loader:.wasm=file",
          "--loader:.yaml=yaml",
          "--loader:.node=napi",
        ],
        { cwd: workDir },
      )
      expect(distBuild.exitCode).toBe(0)
      const distRun = Bun.spawnSync([process.execPath, "run", join(distDir, "unified.js")], {
        cwd: distDir,
      })
      expect(distRun.exitCode).toBe(0)
      const distOut = JSON.parse(distRun.stdout.toString().trim()) as UnifiedOut
      expect(distOut.isStandaloneExecutable).toBe(false)
      expect(distOut.napi.tsfnResult).toBe(42)
      expect(distOut.wasm.sum).toBe(42)

      // 3c. Verify in --compile: copy ONLY the compiled binary into an empty directory and run it!
      const compiledBin = join(workDir, "unified-app")
      const compile = Bun.spawnSync(
        [
          process.execPath,
          "build",
          entryPath,
          "--compile",
          "--outfile",
          compiledBin,
          "--loader:.png=file",
          "--loader:.weird=file",
          "--loader:.wasm=file",
          "--loader:.yaml=yaml",
          "--loader:.node=napi",
        ],
        { cwd: workDir },
      )
      expect(compile.exitCode).toBe(0)

      const isolatedBin = join(emptyDir, "unified-app")
      copyFileSync(compiledBin, isolatedBin)
      // Remove original workDir before running isolatedBin to prove zero external disk dependency!
      rmSync(workDir, { recursive: true, force: true })

      const standaloneRun = Bun.spawnSync([isolatedBin], { cwd: emptyDir })
      expect(standaloneRun.exitCode).toBe(0)
      const out = JSON.parse(standaloneRun.stdout.toString().trim()) as UnifiedOut

      expect(out.isStandaloneExecutable).toBe(true)
      expect(out.embeddedFilesCount).toBeGreaterThanOrEqual(3)
      expect(out.png.url).toContain("/$bunfs/")
      expect(out.png.isBlob).toBe(true)
      expect(out.png.type).toBe("image/png")
      expect(out.png.size).toBe(originalPngSize)
      expect(out.png.exists).toBe(true)
      expect(out.png.slice64).toBe(64)
      expect(out.png.hasStream).toBe(true)
      // On disk (dev/dist), Bun.file(".weird").type === "application/octet-stream".
      // Inside --compile (/$bunfs/root/), Bun 1.4.4 returns "" for unknown extensions.
      expect(devOut.weird.type).toBe("application/octet-stream")
      expect(distOut.weird.type).toBe("application/octet-stream")
      expect(out.weird.type).toBe("")
      expect(out.weird.type || "application/octet-stream").toBe("application/octet-stream")
      expect(out.weird.size).toBe(4)
      expect(out.yaml.typeOf).toBe("object")
      expect(out.yaml.value).toEqual({ desk: "sportsdesk-ops", version: 144 })
      expect(out.wasm.sum).toBe(42)
      expect(out.wasm.fetchFailed).toBe(true)
      expect(out.napi.typeOf).toBe("object")
      expect(out.napi.version).toBe("tsfn-probe-1.0")
      expect(out.napi.tsfnResult).toBe(42)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
      rmSync(emptyDir, { recursive: true, force: true })
    }
  }, 25_000)
})

describe("7. API Loader, ConfigStatusStore & 07. file Loader Dashboard Contract SSR", () => {
  test("attaches live fileLoaderProbe, registers BUN_BUNDLER.fileLoader, and renders dashboard contract sections", () => {
    const audit = loadBunRuntimeSurfaceAudit()
    expect(audit.fileLoaderProbe).toBeDefined()
    expect(audit.fileLoaderProbe?.bunFileAvailable).toBe(true)
    expect(audit.fileLoaderProbe?.bunWriteAvailable).toBe(true)
    expect(audit.fileLoaderProbe?.bunBuildAvailable).toBe(true)
    expect(audit.fileLoaderProbe?.embeddedFilesAvailable).toBe(true)
    expect(audit.fileLoaderProbe?.embeddedFilesCount).toBe(0)
    expect(audit.fileLoaderProbe?.sampleAsset?.instanceofBlob).toBe(true)
    expect(audit.fileLoaderProbe?.sampleAsset?.exists).toBe(true)
    expect(audit.fileLoaderProbe?.sampleAsset?.type).toBe("image/png")
    expect(audit.fileLoaderProbe?.sampleAsset?.sliceByteLength).toBe(64)
    expect(audit.fileLoaderProbe?.sampleAsset?.unknownExtFallbackMime).toBe(
      "application/octet-stream",
    )

    const store = createConfigStatusStore({
      env: {
        PORT: "3000",
        SPORTSDESK_ADMIN_TOKEN: "secret-file-loader-token-do-not-leak",
      },
    })
    const snapshot = store.getSnapshot()
    expect(JSON.stringify(snapshot)).not.toContain("secret-file-loader-token-do-not-leak")
    expect(snapshot.items.some((i) => i.key === "BUN_BUNDLER.fileLoader")).toBe(true)
    expect(snapshot.runtimeSurface?.fileLoaderProbe?.sampleAsset?.instanceofBlob).toBe(true)

    const sectionHtml = renderToStaticMarkup(
      React.createElement(BunFileLoaderSection, {
        probe: audit.fileLoaderProbe,
      }),
    )
    expect(sectionHtml).toContain('data-file-loader-live-probe="true"')
    expect(sectionHtml).toContain('data-file-loader-workbench="true"')
    expect(sectionHtml).toContain('data-file-loader-runtime-edges="true"')
    expect(sectionHtml).toContain('data-runtime-edge-id="wasm-bytes-vs-fetch"')
    expect(sectionHtml).toContain('data-runtime-edge-id="sqlite-embed-readonly"')
    expect(sectionHtml).toContain('data-runtime-edge-id="napi-require-vs-import"')
    expect(sectionHtml).toContain("SQLITE_READONLY")
    expect(sectionHtml).toContain("Bun.embeddedFiles")

    const tabbedHtml = renderToStaticMarkup(
      React.createElement(BunRuntimeSurfaceSection, {
        audit,
        initialSubTab: "file-loader",
      }),
    )
    expect(tabbedHtml).toContain('data-runtime-view="file-loader"')
    expect(tabbedHtml).toContain("07. file Loader")
    expect(tabbedHtml).toContain("napi")
  })
})
