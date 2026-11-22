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
  BUN_FILE_BLOB_CONSUMERS,
  BUN_FILE_PROPERTIES,
  deterministicAssetHash8,
  simulateFileLoaderEmissions,
} from "../../packages/contracts/src/bun_file_loader.ts"
import { BunFileLoaderSection } from "../../packages/ui/src/panels/BunFileLoaderSection.tsx"
import { BunRuntimeSurfaceSection } from "../../packages/ui/src/panels/BunRuntimeSurfaceSection.tsx"

const SAMPLE_PNG_SOURCE = resolve("public/assets/branding/sportsdesk-emblem-64.png")

function makeTempWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe("Bun file loader contracts & pipeline generator", () => {
  test("exposes complete loader specs, BunFile Blob properties, consumers, and napi/yaml comparison", () => {
    expect(BUN_ASSET_LOADER_SPECS.map((s) => s.extension)).toEqual([
      ".png",
      ".svg",
      ".woff2",
      ".bin",
      ".yaml",
      ".node",
    ])
    expect(BUN_FILE_PROPERTIES.map((p) => p.feature)).toEqual([
      "Lazy",
      "Blob-compatible",
      "Streamable",
      "Response-ready",
      "Bun.write-ready",
      "MIME inferred",
    ])
    expect(BUN_FILE_BLOB_CONSUMERS).toHaveLength(4)
    expect(BUN_ASSET_LOADER_COMPARISON.map((r) => r.loader)).toEqual(["file", "napi", "yaml"])

    const h1 = deterministicAssetHash8("logo.png:image/png:v1.4")
    const h2 = deterministicAssetHash8("logo.png:image/png:v1.4")
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{8}$/)
  })

  test("simulates content-hashed file emissions and generates CLI, JS API, --compile, and CI snippets", () => {
    const bunEmissions = simulateFileLoaderEmissions({
      enabledLoaderIds: ["png", "svg", "yaml", "node"],
      target: "bun",
      compileMode: false,
      outdir: "./dist",
    })
    expect(bunEmissions).toHaveLength(4)
    expect(bunEmissions.find((e) => e.id === "png")?.emittedPath).toMatch(
      /^\.\/dist\/assets\/logo-[0-9a-f]{8}\.png$/,
    )
    expect(bunEmissions.find((e) => e.id === "png")?.runtimeValueType).toBe("string")
    expect(bunEmissions.find((e) => e.id === "node")?.emittedPath).toBe("./dist/addon.node")
    expect(bunEmissions.find((e) => e.id === "node")?.runtimeValueType).toBe("module")
    expect(bunEmissions.find((e) => e.id === "yaml")?.runtimeValueType).toBe("object")

    const compileSnippets = buildBunAssetPipelineSnippets({
      enabledLoaderIds: ["png", "bin", "yaml", "node"],
      target: "bun",
      compileMode: true,
      includeMetafile: true,
      externalSourcemap: true,
    })
    expect(compileSnippets.cliCommand).toContain("--loader:.png=file")
    expect(compileSnippets.cliCommand).toContain("--loader:.bin=file")
    expect(compileSnippets.cliCommand).toContain("--loader:.yaml=yaml")
    expect(compileSnippets.cliCommand).toContain("--loader:.node=napi")
    expect(compileSnippets.cliCommand).toContain("--metafile=./dist/meta.json")
    expect(compileSnippets.cliCommand).toContain("--metafile-md=./dist/meta.md")
    expect(compileSnippets.compileCommand).toContain("--compile --outfile ./dist/app")
    expect(compileSnippets.buildApiTs).toContain("await Bun.build(")
    expect(compileSnippets.buildApiTs).toContain('".png": "file"')
    expect(compileSnippets.buildApiTs).toContain('".node": "napi"')
    expect(compileSnippets.runtimeAppTs).toContain("Bun.file(logoUrl)")
    expect(compileSnippets.runtimeAppTs).toContain("addon.loadModel(await model.arrayBuffer())")
    expect(compileSnippets.runtimeAppTs).toContain("for (const f of Bun.embeddedFiles)")
    expect(compileSnippets.ciPackageJson).toContain("bun fmt --check --log-level error --threads 2")
    expect(compileSnippets.distTree).toContain("Bun.embeddedFiles")
  })
})

describe("Bun.file() -> BunFile -> Blob real runtime behavior", () => {
  test("verifies lazy BunFile Blob subclass, MIME inference, slicing, streaming, Response, FormData, and zero-copy Bun.write", async () => {
    const workDir = makeTempWorkspace("bun-file-blob-")
    try {
      const pngCopyDest = join(workDir, "emblem-copy.png")
      const svgPath = join(workDir, "mark.svg")
      const unknownPath = join(workDir, "blob.custombin999")
      writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>')
      writeFileSync(unknownPath, new Uint8Array([1, 2, 3, 4]))

      const logo = Bun.file(SAMPLE_PNG_SOURCE)
      expect(logo instanceof Blob).toBe(true)
      expect(logo.type).toBe("image/png")
      expect(await logo.exists()).toBe(true)
      expect(logo.size).toBeGreaterThan(100)

      // ArrayBuffer & slice()
      const buf = await logo.arrayBuffer()
      expect(buf.byteLength).toBe(logo.size)
      const headSlice = logo.slice(0, 64)
      expect(headSlice instanceof Blob).toBe(true)
      expect(headSlice.size).toBe(64)
      const headBytes = new Uint8Array(await headSlice.arrayBuffer())
      // PNG magic header: 0x89 0x50 0x4E 0x47
      expect(Array.from(headBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])

      // ReadableStream via .stream()
      const stream = logo.stream()
      expect(stream).toBeInstanceOf(ReadableStream)
      const reader = stream.getReader()
      let streamedBytes = 0
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        streamedBytes += chunk.value.byteLength
      }
      expect(streamedBytes).toBe(logo.size)

      // Response-ready
      const resp = new Response(logo, { headers: { "Content-Type": logo.type } })
      expect(resp.headers.get("Content-Type")).toBe("image/png")
      expect((await resp.arrayBuffer()).byteLength).toBe(logo.size)

      // FormData-ready
      const form = new FormData()
      form.append("logo", logo, "logo.png")
      const uploaded = form.get("logo")
      expect(uploaded).not.toBeNull()
      expect((uploaded as Blob).size).toBe(logo.size)

      // Bun.write zero-copy fast path
      const written = await Bun.write(pngCopyDest, logo)
      expect(written).toBe(logo.size)
      const copyFile = Bun.file(pngCopyDest)
      expect(await copyFile.exists()).toBe(true)
      expect(copyFile.size).toBe(logo.size)

      // SVG text + MIME & unknown extension fallback
      const svgFile = Bun.file(svgPath)
      expect(svgFile.type).toContain("image/svg+xml")
      expect(await svgFile.text()).toContain("<svg")

      const unknownFile = Bun.file(unknownPath)
      expect(unknownFile.type).toBe("application/octet-stream")

      // Normal bun run/test has empty Bun.embeddedFiles
      expect(Array.isArray(Bun.embeddedFiles)).toBe(true)
      expect(Bun.embeddedFiles.length).toBe(0)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})

describe("Bun build file loader, CLI metafiles, and --compile embeddedFiles", () => {
  test("Bun.build JS API and CLI emit hashed assets, rewrite imports to strings, inline YAML, and write metafiles", async () => {
    const workDir = makeTempWorkspace("bun-file-loader-build-")
    try {
      const srcDir = join(workDir, "src")
      const jsApiOut = join(workDir, "dist-api")
      const cliOut = join(workDir, "dist-cli")
      mkdirSync(srcDir, { recursive: true })

      copyFileSync(SAMPLE_PNG_SOURCE, join(srcDir, "logo.png"))
      writeFileSync(
        join(srcDir, "emblem.svg"),
        '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>',
      )
      writeFileSync(join(srcDir, "config.yaml"), "name: sportsdesk-ops\nmode: live\n")
      writeFileSync(
        join(srcDir, "index.ts"),
        [
          'import logoUrl from "./logo.png";',
          'import emblemUrl from "./emblem.svg";',
          'import config from "./config.yaml";',
          "export const bundleInfo = {",
          "  logoUrl,",
          "  logoType: typeof logoUrl,",
          "  emblemUrl,",
          "  emblemType: typeof emblemUrl,",
          "  config,",
          "};",
        ].join("\n"),
      )

      // 1. Bun.build JS API
      const buildResult = await Bun.build({
        entrypoints: [join(srcDir, "index.ts")],
        outdir: jsApiOut,
        target: "bun",
        naming: {
          asset: "assets/[name]-[hash].[ext]",
        },
        loaders: {
          ".png": "file",
          ".svg": "file",
          ".yaml": "yaml",
        },
      })
      expect(buildResult.success).toBe(true)
      const assetOutputs = buildResult.outputs.filter((o) => o.kind === "asset")
      expect(assetOutputs.length).toBeGreaterThanOrEqual(2)
      expect(assetOutputs.some((o) => o.path.endsWith(".png"))).toBe(true)
      expect(assetOutputs.some((o) => o.path.endsWith(".svg"))).toBe(true)

      const builtModule = await import(join(jsApiOut, "index.js"))
      expect(builtModule.bundleInfo.logoType).toBe("string")
      expect(builtModule.bundleInfo.emblemType).toBe("string")
      expect(builtModule.bundleInfo.logoUrl).toMatch(/logo-[a-z0-9]+\.png$/i)
      expect(builtModule.bundleInfo.config).toEqual({ name: "sportsdesk-ops", mode: "live" })

      // 2. CLI `bun build` with --loader:* and --metafile / --metafile-md
      const metaJsonPath = join(cliOut, "meta.json")
      const metaMdPath = join(cliOut, "meta.md")
      const proc = Bun.spawnSync(
        [
          process.execPath,
          "build",
          join(srcDir, "index.ts"),
          "--outdir",
          cliOut,
          "--target",
          "bun",
          `--asset-naming=assets/[name]-[hash].[ext]`,
          "--loader:.png=file",
          "--loader:.svg=file",
          "--loader:.yaml=yaml",
          `--metafile=${metaJsonPath}`,
          `--metafile-md=${metaMdPath}`,
        ],
        { cwd: workDir, stdout: "pipe", stderr: "pipe" },
      )
      expect(proc.exitCode).toBe(0)
      expect(existsSync(metaJsonPath)).toBe(true)
      expect(existsSync(metaMdPath)).toBe(true)

      const metaJson = JSON.parse(await Bun.file(metaJsonPath).text()) as {
        inputs?: Record<string, unknown>
        outputs?: Record<string, unknown>
      }
      expect(Object.keys(metaJson.inputs ?? {}).length).toBeGreaterThan(0)
      expect(Object.keys(metaJson.outputs ?? {}).length).toBeGreaterThan(0)
      expect(await Bun.file(metaMdPath).text()).toContain("index.js")
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })

  test("--compile embeds file-loader assets so Bun.file() and Bun.embeddedFiles work without dist/ on disk", async () => {
    const workDir = makeTempWorkspace("bun-compile-embed-")
    const emptyRunCwd = makeTempWorkspace("bun-compile-empty-cwd-")
    try {
      const srcDir = join(workDir, "src")
      mkdirSync(srcDir, { recursive: true })
      const pngPath = join(srcDir, "logo.png")
      copyFileSync(SAMPLE_PNG_SOURCE, pngPath)
      const originalSize = Bun.file(pngPath).size

      writeFileSync(join(srcDir, "config.yaml"), "name: sportsdesk-ops\ncompile: true\n")
      writeFileSync(
        join(srcDir, "app.ts"),
        [
          'import logoUrl from "./logo.png";',
          'import config from "./config.yaml";',
          "const logo = Bun.file(logoUrl);",
          "const exists = await logo.exists();",
          "const embedded = Bun.embeddedFiles.map((f) => ({ name: f.name, type: f.type, size: f.size }));",
          "console.log(JSON.stringify({",
          "  logoUrl,",
          "  logoTypeOf: typeof logoUrl,",
          "  isBlob: logo instanceof Blob,",
          "  exists,",
          "  size: logo.size,",
          "  type: logo.type,",
          "  embeddedCount: embedded.length,",
          "  embedded,",
          "  config,",
          "}));",
        ].join("\n"),
      )

      const binPath = join(workDir, "compiled-asset-probe")
      const compileProc = Bun.spawnSync(
        [
          process.execPath,
          "build",
          join(srcDir, "app.ts"),
          "--compile",
          "--outfile",
          binPath,
          "--loader:.png=file",
          "--loader:.yaml=yaml",
        ],
        { cwd: workDir, stdout: "pipe", stderr: "pipe" },
      )
      expect(compileProc.exitCode).toBe(0)
      expect(existsSync(binPath)).toBe(true)

      // Execute standalone binary from an empty working directory (no dist/ or src/ present)
      const runProc = Bun.spawnSync([binPath], {
        cwd: emptyRunCwd,
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(runProc.exitCode).toBe(0)

      const payload = JSON.parse(runProc.stdout.toString().trim()) as {
        logoUrl: string
        logoTypeOf: string
        isBlob: boolean
        exists: boolean
        size: number
        type: string
        embeddedCount: number
        embedded: Array<{ name: string; type: string; size: number }>
        config: { name: string; compile: boolean }
      }
      expect(payload.logoTypeOf).toBe("string")
      expect(payload.isBlob).toBe(true)
      expect(payload.exists).toBe(true)
      expect(payload.size).toBe(originalSize)
      expect(payload.type).toBe("image/png")
      expect(payload.embeddedCount).toBeGreaterThanOrEqual(1)
      expect(payload.embedded.some((e) => e.size === originalSize)).toBe(true)
      expect(payload.config).toEqual({ name: "sportsdesk-ops", compile: true })
    } finally {
      rmSync(workDir, { recursive: true, force: true })
      rmSync(emptyRunCwd, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("API loader, ConfigStatusStore, and BunFileLoaderSection SSR integration", () => {
  test("attaches live fileLoaderProbe, registers BUN_BUNDLER.fileLoader, and renders 07. file Loader tab cleanly", () => {
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
    expect(sectionHtml).toContain("Bun.file()")
    expect(sectionHtml).toContain("Bun.embeddedFiles")
    expect(sectionHtml).toContain("image/png")

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
