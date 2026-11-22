/**
 * @file packages/contracts/src/bun_file_loader.ts
 * @description Canonical contracts, loader matrices, BunFile/Blob specifications,
 * hashed asset emission simulator, and end-to-end `Bun.build` / `--compile` pipeline
 * snippet generator for Bun's `file` loader -> `Bun.file()` -> `BunFile` (Blob) &
 * `napi` sibling loader architecture.
 */

export type BunAssetLoaderKind = "file" | "yaml" | "napi"

export type BunAssetBuildTarget = "bun" | "browser"

export interface BunAssetLoaderSpec {
  readonly id: string
  readonly extension: string
  readonly loader: BunAssetLoaderKind
  readonly sampleFile: string
  readonly importVar: string
  readonly inferredMime: string
  readonly emitsPattern: string
  readonly importResolvesTo: string
  readonly runtimeApi: string
  readonly compileEmbedding: string
  readonly enabledByDefault: boolean
}

export interface BunFilePropertySpec {
  readonly id: string
  readonly feature: string
  readonly behavior: string
  readonly apiExample: string
}

export interface BunFileConsumerSpec {
  readonly id: string
  readonly label: string
  readonly summary: string
  readonly code: string
}

export interface BunLoaderComparisonRow {
  readonly loader: BunAssetLoaderKind
  readonly emitsToOutdir: string
  readonly importResolvesTo: string
  readonly runtimeApi: string
  readonly compileBehavior: string
}

export interface BunFileSampleAssetProbe {
  readonly assetPath: string
  readonly instanceofBlob: boolean
  readonly type: string
  readonly size: number
  readonly exists: boolean
  readonly sliceByteLength: number
  readonly streamSupported: boolean
  readonly responseReady: boolean
  readonly formDataReady: boolean
  readonly unknownExtFallbackMime: string
}

export interface BunEmbeddedFileEntry {
  readonly name: string
  readonly type: string
  readonly size: number
}

export interface BunFileLoaderLiveProbe {
  readonly source: "bun-in-process" | "bun-binary-probe" | "node-fallback" | "browser-fallback"
  readonly bunVersion: string | null
  readonly bunFileAvailable: boolean
  readonly bunWriteAvailable: boolean
  readonly bunBuildAvailable: boolean
  readonly isStandaloneExecutable: boolean
  readonly embeddedFilesAvailable: boolean
  readonly embeddedFilesCount: number
  readonly embeddedFiles: readonly BunEmbeddedFileEntry[]
  readonly sampleAsset: BunFileSampleAssetProbe | null
}

export interface BunFileLoaderPipelineConfig {
  readonly enabledLoaderIds: readonly string[]
  readonly target: BunAssetBuildTarget
  readonly compileMode: boolean
  readonly includeMetafile: boolean
  readonly externalSourcemap: boolean
  readonly entrypoint: string
  readonly outdir: string
  readonly outfile: string
  readonly port: number
}

export interface SimulatedAssetEmission {
  readonly id: string
  readonly extension: string
  readonly loader: BunAssetLoaderKind
  readonly sampleFile: string
  readonly importVar: string
  readonly contentHash8: string
  readonly emittedPath: string
  readonly runtimeImportValue: string
  readonly runtimeValueType: "string" | "object" | "module"
  readonly inferredMime: string
  readonly embeddedInCompile: boolean
}

export interface BunAssetPipelineSnippets {
  readonly runtimeAppTs: string
  readonly buildApiTs: string
  readonly cliCommand: string
  readonly compileCommand: string
  readonly ciPackageJson: string
  readonly distTree: string
  readonly emissions: readonly SimulatedAssetEmission[]
}

export const BUN_ASSET_LOADER_SPECS: readonly BunAssetLoaderSpec[] = [
  {
    id: "png",
    extension: ".png",
    loader: "file",
    sampleFile: "./logo.png",
    importVar: "logoUrl",
    inferredMime: "image/png",
    emitsPattern: "assets/logo-<hash>.png",
    importResolvesTo: 'URL/path string (typeof === "string")',
    runtimeApi: "Bun.file(logoUrl) -> BunFile (Blob)",
    compileEmbedding: "Embedded in binary; Bun.file() resolves via embedded table",
    enabledByDefault: true,
  },
  {
    id: "svg",
    extension: ".svg",
    loader: "file",
    sampleFile: "./emblem.svg",
    importVar: "emblemUrl",
    inferredMime: "image/svg+xml",
    emitsPattern: "assets/emblem-<hash>.svg",
    importResolvesTo: 'URL/path string (typeof === "string")',
    runtimeApi: "Bun.file(emblemUrl) -> BunFile (Blob)",
    compileEmbedding: "Embedded in binary; listed in Bun.embeddedFiles",
    enabledByDefault: true,
  },
  {
    id: "woff2",
    extension: ".woff2",
    loader: "file",
    sampleFile: "./mono.woff2",
    importVar: "fontUrl",
    inferredMime: "font/woff2",
    emitsPattern: "assets/mono-<hash>.woff2",
    importResolvesTo: 'URL/path string (typeof === "string")',
    runtimeApi: "Bun.file(fontUrl) -> BunFile (Blob)",
    compileEmbedding: "Embedded in binary; streams directly in new Response()",
    enabledByDefault: false,
  },
  {
    id: "bin",
    extension: ".bin",
    loader: "file",
    sampleFile: "./model.bin",
    importVar: "modelUrl",
    inferredMime: "application/octet-stream",
    emitsPattern: "assets/model-<hash>.bin",
    importResolvesTo: 'URL/path string (typeof === "string")',
    runtimeApi: "await Bun.file(modelUrl).arrayBuffer()",
    compileEmbedding: "Embedded in binary; zero-copy feed into native addon",
    enabledByDefault: false,
  },
  {
    id: "yaml",
    extension: ".yaml",
    loader: "yaml",
    sampleFile: "./config.yaml",
    importVar: "config",
    inferredMime: "application/yaml",
    emitsPattern: "inlined into bundle JS",
    importResolvesTo: "Parsed JS object (Bun.YAML)",
    runtimeApi: "Direct property access (config.name)",
    compileEmbedding: "Inlined as parsed module export in standalone binary",
    enabledByDefault: true,
  },
  {
    id: "node",
    extension: ".node",
    loader: "napi",
    sampleFile: "./addon.node",
    importVar: "addon",
    inferredMime: "application/octet-stream",
    emitsPattern: "addon.node (verbatim copy)",
    importResolvesTo: "Loaded native N-API addon exports object",
    runtimeApi: "addon.startWorkerThread() (TSFN safe)",
    compileEmbedding: "Embedded in binary; extracted & dlopen'd at runtime",
    enabledByDefault: true,
  },
]

export const BUN_FILE_PROPERTIES: readonly BunFilePropertySpec[] = [
  {
    id: "lazy",
    feature: "Lazy",
    behavior: "File is not opened until first read; Bun.file(path) performs no upfront I/O.",
    apiExample: "const logo = Bun.file(logoUrl)",
  },
  {
    id: "blob-compatible",
    feature: "Blob-compatible",
    behavior:
      "instanceof Blob === true; .text(), .arrayBuffer(), .stream(), .slice(), .size, and .type all work.",
    apiExample: "logo instanceof Blob && logo.slice(0, 1024)",
  },
  {
    id: "streamable",
    feature: "Streamable",
    behavior: ".stream() returns a ReadableStream<Uint8Array> with no full in-memory buffering.",
    apiExample: "const stream = logo.stream()",
  },
  {
    id: "response-ready",
    feature: "Response-ready",
    behavior:
      "new Response(Bun.file(p)) streams directly from disk or the --compile embedded table.",
    apiExample: 'new Response(Bun.file(logoUrl), { headers: { "Content-Type": "image/png" } })',
  },
  {
    id: "bun-write-ready",
    feature: "Bun.write-ready",
    behavior:
      "Bun.write(dest, Bun.file(src)) uses kernel zero-copy fast paths when writing to disk.",
    apiExample: 'await Bun.write("./dist/copy.png", Bun.file(logoUrl))',
  },
  {
    id: "mime-inferred",
    feature: "MIME inferred",
    behavior:
      ".type is inferred from the file extension and falls back to application/octet-stream.",
    apiExample: 'logo.type // "image/png"',
  },
]

export const BUN_FILE_BLOB_CONSUMERS: readonly BunFileConsumerSpec[] = [
  {
    id: "http-response",
    label: "HTTP Response Body (Bun.serve)",
    summary:
      "Streams directly from disk or embedded --compile asset table without manual buffering.",
    code: `Bun.serve({
  fetch(req) {
    if (new URL(req.url).pathname === "/logo.png")
      return new Response(Bun.file(logoUrl), {
        headers: { "Content-Type": "image/png" },
      });
  },
});`,
  },
  {
    id: "form-data",
    label: "FormData Upload",
    summary:
      "Passes lazy BunFile straight into FormData as a standard Blob without reading into RAM.",
    code: `const form = new FormData();
form.append("logo", Bun.file(logoUrl), "logo.png");`,
  },
  {
    id: "bun-write",
    label: "Zero-Copy Disk Write",
    summary: "Delegates to OS kernel fast paths (copy_file_range / clonefile / sendfile).",
    code: `await Bun.write("./dist/copy.png", Bun.file(logoUrl));`,
  },
  {
    id: "compile-embedded",
    label: "--compile Embedded Asset Enumeration",
    summary:
      "Populated in standalone --compile executables; empty in normal bun run / bun build deployments.",
    code: `import logoUrl from "./logo.png";

const logo = Bun.file(logoUrl);
await logo.exists(); // true — backed by embedded table

for (const f of Bun.embeddedFiles) {
  console.log(f.name, f.type, f.size);
}`,
  },
]

export const BUN_ASSET_LOADER_COMPARISON: readonly BunLoaderComparisonRow[] = [
  {
    loader: "file",
    emitsToOutdir: "assets/<name>-<hash>.<ext>",
    importResolvesTo: "URL/path string",
    runtimeApi: "Bun.file(str) -> BunFile (Blob)",
    compileBehavior:
      "Embedded into single executable; Bun.file(str) resolves to embedded copy and Bun.embeddedFiles lists it.",
  },
  {
    loader: "napi",
    emitsToOutdir: "<name>.node (verbatim copy)",
    importResolvesTo: "Loaded native addon exports object",
    runtimeApi: "addon.startWorkerThread() (N-API / TSFN)",
    compileBehavior:
      "Embedded .node binary extracted & loaded at runtime; napi_create_threadsafe_function cross-thread calls work unchanged.",
  },
  {
    loader: "yaml",
    emitsToOutdir: "Inlined parsed module in JS bundle",
    importResolvesTo: "Parsed YAML 1.2 JS object",
    runtimeApi: "Direct object property access",
    compileBehavior: "Compiled into the standalone bundle with zero runtime disk dependency.",
  },
]

export const DEFAULT_BUN_FILE_LOADER_PIPELINE: BunFileLoaderPipelineConfig = {
  enabledLoaderIds: ["png", "yaml", "node"],
  target: "bun",
  compileMode: false,
  includeMetafile: true,
  externalSourcemap: true,
  entrypoint: "./src/index.ts",
  outdir: "./dist",
  outfile: "./dist/app",
  port: 3000,
}

/**
 * Deterministic 8-hex-char FNV-1a content fingerprint used for illustrating
 * content-hashed `assets/<name>-<hash>.<ext>` emission in pure TS/browser mode.
 */
export function deterministicAssetHash8(seed: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export function simulateFileLoaderEmissions(
  config: Pick<
    BunFileLoaderPipelineConfig,
    "enabledLoaderIds" | "target" | "compileMode" | "outdir"
  >,
): readonly SimulatedAssetEmission[] {
  const activeSet = new Set(config.enabledLoaderIds)
  const cleanOutdir = config.outdir.replace(/\/+$/, "") || "./dist"

  return BUN_ASSET_LOADER_SPECS.filter((spec) => activeSet.has(spec.id)).map((spec) => {
    const cleanFile = spec.sampleFile.replace(/^\.\//, "")
    const dotIdx = cleanFile.lastIndexOf(".")
    const baseName = dotIdx > 0 ? cleanFile.slice(0, dotIdx) : cleanFile
    const hash8 = deterministicAssetHash8(`${cleanFile}:${spec.inferredMime}:v1.4`)

    if (spec.loader === "file") {
      const relAsset = `assets/${baseName}-${hash8}${spec.extension}`
      const runtimePath = config.compileMode
        ? `/$bunfs/root/${baseName}-${hash8}${spec.extension}`
        : config.target === "browser"
          ? `/${relAsset}`
          : `./${relAsset}`
      return {
        id: spec.id,
        extension: spec.extension,
        loader: spec.loader,
        sampleFile: spec.sampleFile,
        importVar: spec.importVar,
        contentHash8: hash8,
        emittedPath: config.compileMode ? `embedded:${relAsset}` : `${cleanOutdir}/${relAsset}`,
        runtimeImportValue: runtimePath,
        runtimeValueType: "string",
        inferredMime: spec.inferredMime,
        embeddedInCompile: true,
      }
    }

    if (spec.loader === "napi") {
      return {
        id: spec.id,
        extension: spec.extension,
        loader: spec.loader,
        sampleFile: spec.sampleFile,
        importVar: spec.importVar,
        contentHash8: hash8,
        emittedPath: config.compileMode ? `embedded:${cleanFile}` : `${cleanOutdir}/${cleanFile}`,
        runtimeImportValue: "[NativeAddon Module Exports]",
        runtimeValueType: "module",
        inferredMime: spec.inferredMime,
        embeddedInCompile: true,
      }
    }

    return {
      id: spec.id,
      extension: spec.extension,
      loader: spec.loader,
      sampleFile: spec.sampleFile,
      importVar: spec.importVar,
      contentHash8: hash8,
      emittedPath: `${cleanOutdir}/index.js (inlined)`,
      runtimeImportValue: '{ name: "sportsdesk-ops", mode: "live" }',
      runtimeValueType: "object",
      inferredMime: spec.inferredMime,
      embeddedInCompile: true,
    }
  })
}

export function buildBunAssetPipelineSnippets(
  partial: Partial<BunFileLoaderPipelineConfig> = {},
): BunAssetPipelineSnippets {
  const config: BunFileLoaderPipelineConfig = {
    ...DEFAULT_BUN_FILE_LOADER_PIPELINE,
    ...partial,
  }
  const activeSpecs = BUN_ASSET_LOADER_SPECS.filter((s) => config.enabledLoaderIds.includes(s.id))
  const effectiveSpecs =
    activeSpecs.length > 0 ? activeSpecs : BUN_ASSET_LOADER_SPECS.filter((s) => s.enabledByDefault)
  const emissions = simulateFileLoaderEmissions({
    enabledLoaderIds: effectiveSpecs.map((s) => s.id),
    target: config.target,
    compileMode: config.compileMode,
    outdir: config.outdir,
  })

  const loaderFlags = effectiveSpecs.map((s) => `--loader:${s.extension}=${s.loader}`)
  const cleanOutdir = config.outdir.replace(/\/+$/, "") || "./dist"

  const cliLines = [
    `bun build ${config.entrypoint} --outdir ${cleanOutdir} --target ${config.target}`,
    ...loaderFlags.map((flag) => `  ${flag}`),
  ]
  if (config.externalSourcemap) {
    cliLines.push("  --sourcemap=external")
  }
  if (config.includeMetafile) {
    cliLines.push(`  --metafile=${cleanOutdir}/meta.json`)
    cliLines.push(`  --metafile-md=${cleanOutdir}/meta.md`)
  }
  const cliCommand = cliLines.join(" \\\n")

  const compileCommand = [
    `bun build ${config.entrypoint} --compile --outfile ${config.outfile}`,
    ...loaderFlags.map((flag) => `  ${flag}`),
  ].join(" \\\n")

  const loadersBlock = effectiveSpecs
    .map((s) => `    ${JSON.stringify(s.extension)}: ${JSON.stringify(s.loader)},`)
    .join("\n")

  const buildApiLines = [
    "await Bun.build({",
    `  entrypoints: [${JSON.stringify(config.entrypoint)}],`,
    `  outdir: ${JSON.stringify(cleanOutdir)},`,
    `  target: ${JSON.stringify(config.target)},`,
    ...(config.externalSourcemap ? ['  sourcemap: "external",'] : []),
    "  loaders: {",
    loadersBlock,
    "  },",
    ...(config.includeMetafile
      ? [
          `  metafile: ${JSON.stringify(`${cleanOutdir}/meta.json`)},`,
          `  metafileMd: ${JSON.stringify(`${cleanOutdir}/meta.md`)},`,
        ]
      : []),
    "});",
  ]
  const buildApiTs = buildApiLines.join("\n")

  const importLines = effectiveSpecs.map((s) => {
    const comment =
      s.loader === "file"
        ? "file loader -> hashed URL/path string"
        : s.loader === "napi"
          ? "napi loader -> native addon exports"
          : "yaml loader -> parsed object"
    return `import ${s.importVar} from ${JSON.stringify(s.sampleFile)}; // ${comment}`
  })

  const fileSpecs = effectiveSpecs.filter((s) => s.loader === "file")
  const hasYaml = effectiveSpecs.some((s) => s.loader === "yaml")
  const hasNapi = effectiveSpecs.some((s) => s.loader === "napi")
  const hasModel = effectiveSpecs.some((s) => s.id === "bin")
  const primaryFileSpec = fileSpecs[0]

  const runtimeBodyLines: string[] = [...importLines, ""]
  for (const fs of fileSpecs) {
    const handleName = fs.importVar.replace(/Url$/, "")
    runtimeBodyLines.push(
      `const ${handleName} = Bun.file(${fs.importVar}); // BunFile (Blob), lazy`,
    )
  }
  if (fileSpecs.length > 0) {
    runtimeBodyLines.push("")
  }

  runtimeBodyLines.push("Bun.serve({")
  runtimeBodyLines.push(`  port: ${config.port},`)
  runtimeBodyLines.push("  fetch(req) {")
  runtimeBodyLines.push("    const { pathname } = new URL(req.url);")
  if (primaryFileSpec) {
    const handleName = primaryFileSpec.importVar.replace(/Url$/, "")
    const routePath = `/${primaryFileSpec.sampleFile.replace(/^\.\//, "")}`
    runtimeBodyLines.push(
      `    if (pathname === ${JSON.stringify(routePath)}) return new Response(${handleName});`,
    )
  }
  runtimeBodyLines.push(
    hasYaml
      ? '    if (pathname === "/health") return Response.json({ ok: true, name: config.name, embedded: Bun.embeddedFiles.length });'
      : '    if (pathname === "/health") return Response.json({ ok: true, embedded: Bun.embeddedFiles.length });',
  )
  runtimeBodyLines.push('    return new Response("not found", { status: 404 });')
  runtimeBodyLines.push("  },")
  runtimeBodyLines.push("});")

  if (hasNapi && hasModel) {
    runtimeBodyLines.push("")
    runtimeBodyLines.push("addon.loadModel(await model.arrayBuffer()); // lazy Blob -> native TSFN")
    runtimeBodyLines.push("addon.startWorkerThread();")
  } else if (hasNapi) {
    runtimeBodyLines.push("")
    runtimeBodyLines.push("addon.startWorkerThread(); // TSFN kicks off from a worker thread")
  }

  if (config.compileMode) {
    runtimeBodyLines.push("")
    runtimeBodyLines.push("// Enumerate assets embedded by --compile")
    runtimeBodyLines.push("for (const f of Bun.embeddedFiles) {")
    runtimeBodyLines.push("  console.log(f.name, f.type, f.size);")
    runtimeBodyLines.push("}")
  }

  const runtimeAppTs = runtimeBodyLines.join("\n")

  const ciCompileInline = `bun build ${config.entrypoint} --compile --outfile ${config.outfile} ${loaderFlags.join(" ")}`
  const ciPackageJson = JSON.stringify(
    {
      scripts: {
        "fmt:check": "bun fmt --check --log-level error --threads 2",
        build: "bun run build.ts",
        compile: ciCompileInline,
        ci: "bun run fmt:check && bun run build",
      },
    },
    null,
    2,
  )

  const distLines: string[] = []
  if (config.compileMode) {
    distLines.push(
      `${config.outfile}                     <- single executable (file + napi embedded)`,
    )
    for (const em of emissions) {
      if (em.loader === "file") {
        distLines.push(
          `  ├── [embedded] ${em.emittedPath.replace(/^embedded:/, "")} (${em.inferredMime})`,
        )
      } else if (em.loader === "napi") {
        distLines.push(
          `  ├── [embedded] ${em.emittedPath.replace(/^embedded:/, "")} (N-API TSFN addon)`,
        )
      }
    }
    distLines.push("  └── Bun.embeddedFiles -> populated at runtime (no dist/ required)")
  } else {
    const fileEmissions = emissions.filter((e) => e.loader === "file")
    const napiEmissions = emissions.filter((e) => e.loader === "napi")
    distLines.push(`${cleanOutdir}/`)
    distLines.push("├── index.js")
    if (config.externalSourcemap) {
      distLines.push("├── index.js.map")
    }
    if (fileEmissions.length > 0) {
      distLines.push("├── assets/")
      fileEmissions.forEach((em, idx) => {
        const branch = idx === fileEmissions.length - 1 ? "└──" : "├──"
        const fileName = em.emittedPath.split("/").pop() ?? em.sampleFile
        distLines.push(`│   ${branch} ${fileName}     <- file loader emitted (${em.inferredMime})`)
      })
    }
    for (const ne of napiEmissions) {
      const fileName = ne.emittedPath.split("/").pop() ?? ne.sampleFile
      distLines.push(`├── ${fileName}                 <- napi loader copied`)
    }
    if (config.includeMetafile) {
      distLines.push("├── meta.json                  <- esbuild-compatible")
      distLines.push("└── meta.md                    <- human-readable")
    }
  }

  return {
    runtimeAppTs,
    buildApiTs,
    cliCommand,
    compileCommand,
    ciPackageJson,
    distTree: distLines.join("\n"),
    emissions,
  }
}
