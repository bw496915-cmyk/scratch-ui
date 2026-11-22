/**
 * @file packages/contracts/src/bun_runtime_surface.ts
 * @description Canonical Bun Runtime Surface catalog & cross-runtime live surface
 * audit engine covering:
 *  1. Globals (Bun-Specific, Node.js Compat, Web Standards)
 *  2. Bun Utilities (`Bun.*` across Timing/Memory, Paths/Inspection, Strings/Terminal/IDs, Compression/Buffers)
 *  3. Core Bun APIs (`Bun.*` & `bun:*` across 7 domains)
 *  4. Live Surface Audit (`Object.getOwnPropertyNames(Bun)` + `Bun.inspect.table`)
 *
 * Security invariant:
 * - Strictly read-only metadata introspection (`typeof` and property names only).
 * - NEVER reads, serializes, or transmits `Bun.env`, `process.env`, or `Bun.secrets` values.
 */

import type { BunFileLoaderLiveProbe } from "./bun_file_loader.ts"
import { bunColorCss, bunEscapeHtml, bunStringWidth, bunStripAnsi } from "./bun_syntax_highlight.ts"

export type GlobalTierId = "bun-specific" | "node-compat" | "web-standards"

export interface RuntimeGlobalTierSpec {
  readonly id: GlobalTierId
  readonly label: string
  readonly globals: readonly string[]
  readonly notes: string
}

export type BunUtilityCategoryId =
  "timing-memory" | "paths-inspection" | "strings-terminal" | "compression-buffers"

export interface BunUtilitySpec {
  readonly id: string
  readonly category: BunUtilityCategoryId
  readonly categoryLabel: string
  readonly signature: string
  readonly purpose: string
  readonly runtimeNotes?: string | undefined
  /** Property names on `Bun` to probe for live availability. */
  readonly probeKeys: readonly string[]
}

export type BunCoreApiDomainId =
  | "http-networking"
  | "file-object-io"
  | "databases-caches"
  | "parsers-formats"
  | "subprocesses-shell"
  | "crypto-hashing"
  | "build-ffi-ui"

export interface BunCoreApiDomainSpec {
  readonly id: BunCoreApiDomainId
  readonly domain: string
  readonly apis: readonly string[]
  readonly capabilities: string
  /** Property names on `Bun` (without `Bun.` prefix) to probe for live availability. */
  readonly probeBunKeys: readonly string[]
  /** Built-in `bun:*` module specifiers belonging to this domain. */
  readonly builtinModules: readonly string[]
}

export type BunCapabilityPillarId =
  "http-websockets" | "data" | "files-processes" | "security" | "formats" | "low-level"

export type BunCapabilityActionTarget =
  "globals" | "sandbox" | "modules-classes" | "live-audit" | "file-loader"

export interface BunCapabilityItemSpec {
  readonly id: string
  readonly api: string
  readonly summary: string
  readonly probeBunKeys: readonly string[]
  readonly probeGlobals?: readonly string[] | undefined
  readonly probeDeepIds?: readonly string[] | undefined
  readonly inspectSubTab?: BunCapabilityActionTarget | undefined
  readonly inspectQuery?: string | undefined
}

export interface BunCapabilityPillarSpec {
  readonly id: BunCapabilityPillarId
  readonly title: string
  readonly items: readonly BunCapabilityItemSpec[]
}

export interface LiveCapabilityItemProbe {
  readonly id: string
  readonly api: string
  readonly summary: string
  readonly available: boolean
  readonly matchedSymbols: readonly string[]
  readonly inspectSubTab?: BunCapabilityActionTarget | undefined
  readonly inspectQuery?: string | undefined
}

export interface LiveCapabilityPillarProbe {
  readonly id: BunCapabilityPillarId
  readonly title: string
  readonly availableCount: number
  readonly totalCount: number
  readonly items: readonly LiveCapabilityItemProbe[]
}

export type BunExportKind = "class" | "namespace" | "function" | "constant" | "object"

export type BunDeepInspectionCategory = "builtin-module" | "bun-namespace" | "bun-class"

export interface BunKindCounts {
  readonly class: number
  readonly namespace: number
  readonly function: number
  readonly constant: number
  readonly object: number
}

export interface BunNamespaceExportEntry {
  readonly key: string
  readonly type: string
  readonly kind: BunExportKind
  readonly memberCount?: number | undefined
  readonly staticMemberCount?: number | undefined
  readonly prototypeMethodCount?: number | undefined
  readonly safePreview?: string | undefined
  readonly redacted?: boolean | undefined
}

export interface BunDeepSymbolMember {
  readonly name: string
  readonly kind: BunExportKind
  readonly type: string
  readonly scope: "export" | "static" | "prototype" | "constant"
  readonly safePreview?: string | undefined
}

export interface BunDeepInspectionEntry {
  readonly id: string
  readonly label: string
  readonly category: BunDeepInspectionCategory
  readonly domain: string
  readonly available: boolean
  readonly memberCount: number
  readonly classCount: number
  readonly functionCount: number
  readonly constantCount: number
  readonly namespaceCount: number
  readonly members: readonly BunDeepSymbolMember[]
  readonly notes: string
}

export interface LiveGlobalProbeEntry {
  readonly name: string
  readonly tier: GlobalTierId
  readonly present: boolean
  readonly valueType: string
}

export interface LiveUtilityProbeEntry {
  readonly id: string
  readonly signature: string
  readonly category: BunUtilityCategoryId
  readonly available: boolean
  readonly matchedKeys: readonly string[]
}

export interface LiveCoreApiDomainProbeEntry {
  readonly id: BunCoreApiDomainId
  readonly domain: string
  readonly availableCount: number
  readonly totalProbed: number
  readonly availableKeys: readonly string[]
  readonly missingKeys: readonly string[]
}

export interface BunRuntimeSurfaceAuditSnapshot {
  /** Whether the snapshot was gathered directly from a live Bun runtime, via the installed Bun binary, or Node/browser fallback. */
  readonly source: "bun-in-process" | "bun-binary-probe" | "node-fallback" | "browser-fallback"
  readonly hostRuntime: string
  readonly bunDetected: boolean
  readonly bunVersion: string | null
  readonly bunRevision: string | null
  readonly bunRevisionShort: string | null
  readonly isMainThread: boolean | null
  readonly enableAnsiColors: boolean | null
  readonly processEnvEqualsBunEnv: boolean | null
  readonly memoryPressureSupported: boolean
  readonly exportCount: number
  readonly exports: readonly BunNamespaceExportEntry[]
  readonly exportTypeCounts: Readonly<Record<string, number>>
  readonly kindCounts: BunKindCounts
  readonly deepInspections: readonly BunDeepInspectionEntry[]
  readonly inspectTableText: string
  readonly globalProbes: readonly LiveGlobalProbeEntry[]
  readonly utilityProbes: readonly LiveUtilityProbeEntry[]
  readonly coreDomainProbes: readonly LiveCoreApiDomainProbeEntry[]
  readonly fileLoaderProbe?: BunFileLoaderLiveProbe | undefined
  readonly auditedAt: string
  readonly auditDurationMs: number
}

/** Section 1: Three tiers of globals exposed by Bun without imports. */
export const BUN_GLOBAL_TIERS: readonly RuntimeGlobalTierSpec[] = [
  {
    id: "bun-specific",
    label: "Bun-Specific",
    globals: ["Bun", "HTMLRewriter", "ShadowRealm", "WebSocket"],
    notes:
      "Bun is the root namespace for native runtime APIs; WebSocket includes native pub/sub & compression.",
  },
  {
    id: "node-compat",
    label: "Node.js Compat",
    globals: [
      "process",
      "Buffer",
      "global",
      "__dirname",
      "__filename",
      "setImmediate",
      "clearImmediate",
      "require",
    ],
    notes: 'process.env === Bun.env; process.on("memoryPressure") supported in v1.4+.',
  },
  {
    id: "web-standards",
    label: "Web Standards",
    globals: [
      "fetch",
      "Request",
      "Response",
      "Headers",
      "URL",
      "URLPattern",
      "URLSearchParams",
      "Blob",
      "File",
      "FormData",
      "ReadableStream",
      "WritableStream",
      "TransformStream",
      "CompressionStream",
      "DecompressionStream",
      "TextEncoder",
      "TextDecoder",
      "crypto",
      "SubtleCrypto",
      "Worker",
      "Event",
      "EventTarget",
      "AbortController",
      "structuredClone",
      "performance",
      "queueMicrotask",
      "atob",
      "btoa",
      "alert",
      "confirm",
      "prompt",
    ],
    notes:
      "Streams and CompressionStream/DecompressionStream are native in v1.4+; alert/confirm/prompt map to CLI stdio.",
  },
]

export const BUN_UTILITY_CATEGORIES: readonly {
  readonly id: BunUtilityCategoryId
  readonly label: string
}[] = [
  { id: "timing-memory", label: "Timing, Memory & Runtime Control" },
  { id: "paths-inspection", label: "Paths, Inspection & Comparison" },
  { id: "strings-terminal", label: "Strings, Terminal & IDs" },
  { id: "compression-buffers", label: "Compression & Buffer/Stream Conversion" },
]

/** Section 2: Native Zig/C++ `Bun.*` utility helpers. */
export const BUN_UTILITIES_CATALOG: readonly BunUtilitySpec[] = [
  // Timing, Memory & Runtime Control
  {
    id: "nanoseconds",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.nanoseconds()",
    purpose: "Returns monotonic number (ns since process start)",
    runtimeNotes: "Monotonic clock; use for latency/intervals, not wall time",
    probeKeys: ["nanoseconds"],
  },
  {
    id: "sleep",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.sleep(ms | Date)",
    purpose: "Async non-blocking sleep",
    runtimeNotes: "Returns Promise<void>",
    probeKeys: ["sleep"],
  },
  {
    id: "sleepSync",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.sleepSync(ms)",
    purpose: "Blocks current thread",
    runtimeNotes: "CLI / worker backoff only",
    probeKeys: ["sleepSync"],
  },
  {
    id: "gc",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.gc(force?)",
    purpose: "Triggers JSC garbage collection",
    runtimeNotes: "Pass true for synchronous full sweep",
    probeKeys: ["gc"],
  },
  {
    id: "shrink",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.shrink()",
    purpose: "Releases unused heap pages back to OS",
    runtimeNotes: "Pairs with v1.4 mimalloc scavenger",
    probeKeys: ["shrink"],
  },
  {
    id: "generateHeapSnapshot",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.generateHeapSnapshot()",
    purpose: "Returns V8-compatible heap snapshot",
    runtimeNotes: "Loadable in Chrome DevTools",
    probeKeys: ["generateHeapSnapshot"],
  },
  {
    id: "peek",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.peek(promise)",
    purpose: "Reads settled promise value without await",
    runtimeNotes: "Avoids microtask tick when already resolved",
    probeKeys: ["peek"],
  },
  {
    id: "version-revision",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.version / Bun.revision",
    purpose: "Semver string / exact git commit SHA",
    runtimeNotes: "Useful for telemetry & build pinning",
    probeKeys: ["version", "revision"],
  },
  {
    id: "main-isMainThread",
    category: "timing-memory",
    categoryLabel: "Timing, Memory & Runtime Control",
    signature: "Bun.main / Bun.isMainThread",
    purpose: "Entrypoint absolute path / worker check",
    runtimeNotes: "import.meta.main is the module-local equivalent",
    probeKeys: ["main", "isMainThread"],
  },

  // Paths, Inspection & Comparison
  {
    id: "which",
    category: "paths-inspection",
    categoryLabel: "Paths, Inspection & Comparison",
    signature: "Bun.which(bin, { PATH?, cwd? })",
    purpose: "Resolves executable path (native which)",
    probeKeys: ["which"],
  },
  {
    id: "resolveSync",
    category: "paths-inspection",
    categoryLabel: "Paths, Inspection & Comparison",
    signature: "Bun.resolveSync(specifier, root)",
    purpose: "Runs Bun's module resolver synchronously",
    probeKeys: ["resolveSync"],
  },
  {
    id: "fileURL-pathToFileURL",
    category: "paths-inspection",
    categoryLabel: "Paths, Inspection & Comparison",
    signature: "Bun.fileURLToPath(url) / Bun.pathToFileURL(path)",
    purpose: "Fast file:// URL conversion",
    probeKeys: ["fileURLToPath", "pathToFileURL"],
  },
  {
    id: "inspect",
    category: "paths-inspection",
    categoryLabel: "Paths, Inspection & Comparison",
    signature: "Bun.inspect(val, opts?)",
    purpose: "Formats any value to string; supports [Bun.inspect.custom] symbol",
    probeKeys: ["inspect"],
  },
  {
    id: "inspect-table",
    category: "paths-inspection",
    categoryLabel: "Paths, Inspection & Comparison",
    signature: "Bun.inspect.table(data, cols?, opts?)",
    purpose: "Renders formatted ASCII/Unicode tables",
    probeKeys: ["inspect"],
  },
  {
    id: "deepEquals",
    category: "paths-inspection",
    categoryLabel: "Paths, Inspection & Comparison",
    signature: "Bun.deepEquals(a, b, strict?)",
    purpose: "Native deep structural equality (faster than node:assert)",
    probeKeys: ["deepEquals"],
  },
  {
    id: "openInEditor",
    category: "paths-inspection",
    categoryLabel: "Paths, Inspection & Comparison",
    signature: "Bun.openInEditor(path, { editor?, line?, column? })",
    purpose: "Opens file in configured $EDITOR",
    probeKeys: ["openInEditor"],
  },

  // Strings, Terminal & IDs
  {
    id: "stringWidth",
    category: "strings-terminal",
    categoryLabel: "Strings, Terminal & IDs",
    signature: "Bun.stringWidth(str, opts?)",
    purpose: "Terminal display width (ANSI-aware, handles emoji/CJK)",
    probeKeys: ["stringWidth"],
  },
  {
    id: "stripANSI",
    category: "strings-terminal",
    categoryLabel: "Strings, Terminal & IDs",
    signature: "Bun.stripANSI(str)",
    purpose: "SIMD-accelerated ANSI escape removal",
    probeKeys: ["stripANSI"],
  },
  {
    id: "wrapAnsi",
    category: "strings-terminal",
    categoryLabel: "Strings, Terminal & IDs",
    signature: "Bun.wrapAnsi(str, cols, opts?)",
    purpose: "ANSI-preserving terminal line wrapping",
    probeKeys: ["wrapAnsi"],
  },
  {
    id: "escapeHTML",
    category: "strings-terminal",
    categoryLabel: "Strings, Terminal & IDs",
    signature: "Bun.escapeHTML(val)",
    purpose: "SIMD-accelerated HTML entity escaping",
    probeKeys: ["escapeHTML"],
  },
  {
    id: "color",
    category: "strings-terminal",
    categoryLabel: "Strings, Terminal & IDs",
    signature: "Bun.color(input, format?)",
    purpose: "Parses/converts CSS colors to ansi, hex, rgb, rgba, number, etc.",
    probeKeys: ["color"],
  },
  {
    id: "randomUUIDv7",
    category: "strings-terminal",
    categoryLabel: "Strings, Terminal & IDs",
    signature: "Bun.randomUUIDv7(encoding?, timestamp?)",
    purpose: 'Time-ordered monotonic UUIDv7 ("hex", "base64", "buffer")',
    probeKeys: ["randomUUIDv7"],
  },

  // Compression & Buffer/Stream Conversion
  {
    id: "gzipSync",
    category: "compression-buffers",
    categoryLabel: "Compression & Buffer/Stream Conversion",
    signature: "Bun.gzipSync / Bun.gunzipSync",
    purpose: "Sync zlib gzip compression/decompression",
    probeKeys: ["gzipSync", "gunzipSync"],
  },
  {
    id: "deflateSync",
    category: "compression-buffers",
    categoryLabel: "Compression & Buffer/Stream Conversion",
    signature: "Bun.deflateSync / Bun.inflateSync",
    purpose: "Raw deflate/inflate (no zlib header by default)",
    probeKeys: ["deflateSync", "inflateSync"],
  },
  {
    id: "zstd",
    category: "compression-buffers",
    categoryLabel: "Compression & Buffer/Stream Conversion",
    signature: "Bun.zstdCompress / Bun.zstdDecompress (+ Sync)",
    purpose: "Native Zstandard compression",
    probeKeys: ["zstdCompress", "zstdDecompress", "zstdCompressSync", "zstdDecompressSync"],
  },
  {
    id: "readableStreamTo",
    category: "compression-buffers",
    categoryLabel: "Compression & Buffer/Stream Conversion",
    signature: "Bun.readableStreamToArrayBuffer(stream)",
    purpose:
      "Zero-overhead stream drain to ArrayBuffer (also ...ToBytes, ...ToText, ...ToJSON, ...ToBlob)",
    probeKeys: [
      "readableStreamToArrayBuffer",
      "readableStreamToBytes",
      "readableStreamToText",
      "readableStreamToJSON",
      "readableStreamToBlob",
    ],
  },
  {
    id: "concatArrayBuffers",
    category: "compression-buffers",
    categoryLabel: "Compression & Buffer/Stream Conversion",
    signature: "Bun.concatArrayBuffers(chunks)",
    purpose: "Single-allocation concatenation of ArrayBufferView[]",
    probeKeys: ["concatArrayBuffers"],
  },
  {
    id: "allocUnsafe",
    category: "compression-buffers",
    categoryLabel: "Compression & Buffer/Stream Conversion",
    signature: "Bun.allocUnsafe(size)",
    purpose: "Uninitialized Uint8Array allocation",
    probeKeys: ["allocUnsafe"],
  },
]

/** Section 3: Core Bun APIs (`Bun.*` & `bun:*`) grouped across 7 domains. */
export const BUN_CORE_API_DOMAINS: readonly BunCoreApiDomainSpec[] = [
  {
    id: "http-networking",
    domain: "HTTP & Networking",
    apis: [
      "Bun.serve()",
      "Bun.listen()",
      "Bun.connect()",
      "Bun.udpSocket()",
      "Bun.dns",
      "Bun.CookieMap",
      "Bun.CSRF",
    ],
    capabilities:
      "Native HTTP/WebSocket server with route tables & backpressure; raw TCP/TLS/UDP sockets (rejectUnauthorized: true default in v1.4+); cached DNS (Bun.dns.lookup, prefetch, getCacheStats)",
    probeBunKeys: ["serve", "listen", "connect", "udpSocket", "dns", "CookieMap", "CSRF"],
    builtinModules: [],
  },
  {
    id: "file-object-io",
    domain: "File & Object I/O",
    apis: [
      "Bun.file()",
      "Bun.write()",
      "Bun.embeddedFiles",
      "Bun.s3 / S3Client",
      "Bun.Glob",
      "Bun.Archive",
    ],
    capabilities:
      "Lazy Blob-compatible BunFile / S3File handles (file loader -> Bun.file(), --compile embeddedFiles table); sendfile/copy_file_range zero-copy writes; native globbing and tar/archive handling",
    probeBunKeys: ["file", "write", "embeddedFiles", "s3", "S3Client", "Glob", "Archive"],
    builtinModules: [],
  },
  {
    id: "databases-caches",
    domain: "Databases & Caches",
    apis: ["Bun.sql / SQL", "bun:sqlite", "Bun.redis / RedisClient"],
    capabilities:
      "Built-in Postgres/MySQL/SQLite tagged-template SQL client, synchronous Database for SQLite, native RESP3 Redis client",
    probeBunKeys: ["sql", "SQL", "redis", "RedisClient"],
    builtinModules: ["bun:sqlite"],
  },
  {
    id: "parsers-formats",
    domain: "Parsers & Formats",
    apis: [
      "Bun.YAML",
      "Bun.TOML",
      "Bun.XML",
      "Bun.JSON5",
      "Bun.JSONC",
      "Bun.JSONL",
      "Bun.markdown (html, ansi, render, react)",
      "Bun.semver",
    ],
    capabilities:
      "Native Zig/C parsers (strict YAML 1.2, TOML, JSON5/JSONC/JSONL, XML); Bun.markdown exposes html(), ansi(md, AnsiTheme), render(md, callbacks), and react()",
    probeBunKeys: ["YAML", "TOML", "XML", "JSON5", "JSONC", "JSONL", "markdown", "semver"],
    builtinModules: [],
  },
  {
    id: "subprocesses-shell",
    domain: "Subprocesses & Shell",
    apis: ["Bun.spawn()", "Bun.spawnSync()", "Bun.$", "Bun.Terminal"],
    capabilities:
      "Deadlock-free piped stdio, ReadableStream stdout/stderr, cross-platform shell templates ($), PTY support",
    probeBunKeys: ["spawn", "spawnSync", "$", "Terminal"],
    builtinModules: [],
  },
  {
    id: "crypto-hashing",
    domain: "Crypto & Hashing",
    apis: ["Bun.hash()", "Bun.CryptoHasher", "Bun.password", "Bun.secrets"],
    capabilities:
      "Non-crypto fast hashes (wyhash, xxHash64, crc32, adler32, cityHash64, murmur64); streaming SHA/BLAKE2/HMAC via CryptoHasher; Argon2id/bcrypt via Bun.password; OS keychain via Bun.secrets",
    probeBunKeys: ["hash", "CryptoHasher", "password", "secrets"],
    builtinModules: [],
  },
  {
    id: "build-ffi-ui",
    domain: "Build, FFI & UI",
    apis: [
      "Bun.build()",
      "Bun.Transpiler",
      "Bun.plugin()",
      "bun:ffi",
      "bun:jsc",
      "bun:test",
      "bun:bundle",
      "Bun.Image",
      "Bun.WebView",
    ],
    capabilities:
      "Programmatic bundler & --compile, runtime loader plugins, C/Zig FFI (dlopen/cc/FFIType), JSC heap/GC telemetry (bun:jsc), built-in test runner, compile-time feature() DCE, native Image & WebView APIs (v1.4+)",
    probeBunKeys: ["build", "Transpiler", "plugin", "Image", "WebView", "ModuleGraph"],
    builtinModules: ["bun:ffi", "bun:jsc", "bun:test", "bun:bundle"],
  },
]

/** Targets for deep nested introspection of `Bun.*` namespaces, classes, and `bun:*` modules. */
export const BUN_DEEP_NAMESPACE_TARGETS: readonly {
  readonly key: string
  readonly label: string
  readonly domain: string
  readonly notes: string
}[] = [
  {
    key: "markdown",
    label: "Bun.markdown",
    domain: "Parsers & Formats",
    notes:
      "Native GFM Markdown engine: html(), ansi(md, AnsiTheme), render(md, callbacks), react()",
  },
  {
    key: "YAML",
    label: "Bun.YAML",
    domain: "Parsers & Formats",
    notes: "Native YAML 1.2 parse() and stringify() with alias & anchor support",
  },
  {
    key: "TOML",
    label: "Bun.TOML",
    domain: "Parsers & Formats",
    notes:
      "Native TOML v1.1.0 parse() & stringify() with Temporal date/time round-tripping and direct .toml module imports",
  },
  {
    key: "JSON5",
    label: "Bun.JSON5",
    domain: "Parsers & Formats",
    notes: "Native JSON5 parser & serializer supporting comments and trailing commas",
  },
  {
    key: "JSONC",
    label: "Bun.JSONC",
    domain: "Parsers & Formats",
    notes: "Native JSON-with-Comments parser (wrangler.jsonc, tsconfig.json)",
  },
  {
    key: "JSONL",
    label: "Bun.JSONL",
    domain: "Parsers & Formats",
    notes: "Streaming newline-delimited JSON parser for logs and ticker tapes",
  },
  {
    key: "XML",
    label: "Bun.XML",
    domain: "Parsers & Formats",
    notes: "Native XML parser namespace in Bun v1.4+",
  },
  {
    key: "semver",
    label: "Bun.semver",
    domain: "Parsers & Formats",
    notes: "Native semver satisfies() and order() comparison engine",
  },
  {
    key: "dns",
    label: "Bun.dns",
    domain: "HTTP & Networking",
    notes: "Cached DNS resolver (lookup, prefetch, getCacheStats)",
  },
  {
    key: "CSRF",
    label: "Bun.CSRF",
    domain: "HTTP & Networking",
    notes: "Stateless HMAC-signed CSRF token generate() and verify()",
  },
  {
    key: "password",
    label: "Bun.password",
    domain: "Crypto & Hashing",
    notes: "Native Argon2id & bcrypt password hash/verify helpers",
  },
  {
    key: "secrets",
    label: "Bun.secrets",
    domain: "Crypto & Hashing",
    notes:
      "OS keychain credential interface (get/set/delete; symbol metadata only, values never read)",
  },
  {
    key: "FFI",
    label: "Bun.FFI",
    domain: "Build, FFI & UI",
    notes: "Namespace alias exposing native C/Zig FFI helpers directly on Bun",
  },
  {
    key: "inspect",
    label: "Bun.inspect",
    domain: "Paths, Inspection & Comparison",
    notes: "Formatter function with table() and [Bun.inspect.custom] symbol",
  },
  {
    key: "unsafe",
    label: "Bun.unsafe",
    domain: "Build, FFI & UI",
    notes: "Low-level buffer/pointer utilities for zero-copy native bridges",
  },
]

export const BUN_DEEP_CLASS_TARGETS: readonly {
  readonly key: string
  readonly label: string
  readonly domain: string
  readonly notes: string
}[] = [
  {
    key: "S3Client",
    label: "Bun.S3Client",
    domain: "File & Object I/O",
    notes: "Zero-dependency S3/R2 object storage client (file, list, stat, presign, write)",
  },
  {
    key: "CookieMap",
    label: "Bun.CookieMap",
    domain: "HTTP & Networking",
    notes: "Mutable HTTP cookie jar used by Bun.serve requests & responses",
  },
  {
    key: "Cookie",
    label: "Bun.Cookie",
    domain: "HTTP & Networking",
    notes: "Structured Set-Cookie parser & serializer with SameSite/HttpOnly/Secure attributes",
  },
  {
    key: "Glob",
    label: "Bun.Glob",
    domain: "File & Object I/O",
    notes: "Native filesystem glob matcher with scan() / scanSync() / match()",
  },
  {
    key: "Archive",
    label: "Bun.Archive",
    domain: "File & Object I/O",
    notes: "Native tar/gzip archive reader, writer, and file extractor",
  },
  {
    key: "CryptoHasher",
    label: "Bun.CryptoHasher",
    domain: "Crypto & Hashing",
    notes: "Streaming cryptographic hash & HMAC engine (SHA-256, SHA-512, BLAKE2b)",
  },
  {
    key: "Transpiler",
    label: "Bun.Transpiler",
    domain: "Build, FFI & UI",
    notes: "Native TypeScript/JSX transpiler & static import scanner",
  },
  {
    key: "FileSystemRouter",
    label: "Bun.FileSystemRouter",
    domain: "HTTP & Networking",
    notes: "File-based route matcher for Next.js / page directory layouts",
  },
  {
    key: "RedisClient",
    label: "Bun.RedisClient",
    domain: "Databases & Caches",
    notes: "Native RESP3 Redis/Valkey client with pipelining & pub/sub",
  },
  {
    key: "SQL",
    label: "Bun.SQL",
    domain: "Databases & Caches",
    notes: "Unified Postgres, MySQL & SQLite client class backing Bun.sql",
  },
  {
    key: "Terminal",
    label: "Bun.Terminal",
    domain: "Subprocesses & Shell",
    notes: "Native PTY handle for interactive subprocesses and ANSI resizing",
  },
  {
    key: "Image",
    label: "Bun.Image",
    domain: "Build, FFI & UI",
    notes: "Native image inspection, resize, crop, and format transcoding class (v1.4+)",
  },
  {
    key: "ModuleGraph",
    label: "Bun.ModuleGraph",
    domain: "Build, FFI & UI",
    notes: "Module dependency graph analyzer for bundler & tooling introspection",
  },
  {
    key: "WebView",
    label: "Bun.WebView",
    domain: "Build, FFI & UI",
    notes: "Native embedded WebView desktop/UI bridge class (v1.4+)",
  },
  {
    key: "FetchSession",
    label: "Bun.FetchSession",
    domain: "HTTP & Networking",
    notes: "Stateful HTTP client session with persistent connection pool & cookies",
  },
]

export const BUN_BUILTIN_MODULE_TARGETS: readonly {
  readonly specifier: string
  readonly domain: string
  readonly notes: string
}[] = [
  {
    specifier: "bun:sqlite",
    domain: "Databases & Caches",
    notes:
      "Synchronous SQLite3 engine: Database, Statement, SQLiteError, and 60+ SQLITE_* constants",
  },
  {
    specifier: "bun:ffi",
    domain: "Build, FFI & UI",
    notes:
      "Native C/Zig foreign function interface: dlopen, cc, ptr, CString, JSCallback, FFIType constants",
  },
  {
    specifier: "bun:jsc",
    domain: "Timing, Memory & Runtime Control",
    notes: "JavaScriptCore diagnostics: heapStats, memoryUsage, fullGC, edenGC, serialize, profile",
  },
  {
    specifier: "bun:test",
    domain: "Build, FFI & UI",
    notes: "Built-in Jest/Vitest-compatible test runner: describe, test, expect, mock, spyOn, vi",
  },
  {
    specifier: "bun:bundle",
    domain: "Build, FFI & UI",
    notes: "Compile-time dead-code elimination feature(flag) intrinsic",
  },
]

export const BUN_CAPABILITY_PILLARS: readonly BunCapabilityPillarSpec[] = [
  {
    id: "http-websockets",
    title: "HTTP & WEBSOCKETS",
    items: [
      {
        id: "bun-serve",
        api: "Bun.serve()",
        summary: "HTTP, routing & WebSockets",
        probeBunKeys: ["serve"],
        inspectSubTab: "live-audit",
        inspectQuery: "serve",
      },
      {
        id: "request-cookies",
        api: "request.cookies",
        summary: "Zero-overhead cookies",
        probeBunKeys: ["CookieMap", "Cookie"],
        probeDeepIds: ["Bun.CookieMap"],
        inspectSubTab: "modules-classes",
        inspectQuery: "CookieMap",
      },
      {
        id: "fetch-http2",
        api: "fetch",
        summary: "HTTP/2, proxies, unix sockets",
        probeBunKeys: ["FetchSession"],
        probeGlobals: ["fetch"],
        inspectSubTab: "modules-classes",
        inspectQuery: "FetchSession",
      },
    ],
  },
  {
    id: "data",
    title: "DATA",
    items: [
      {
        id: "bun-sql",
        api: "Bun.sql",
        summary: "Postgres, MySQL, SQLite",
        probeBunKeys: ["sql", "SQL"],
        probeDeepIds: ["bun:sqlite", "Bun.SQL"],
        inspectSubTab: "modules-classes",
        inspectQuery: "SQL",
      },
      {
        id: "bun-redis",
        api: "Bun.redis",
        summary: "Redis client & Pub/Sub",
        probeBunKeys: ["redis", "RedisClient"],
        probeDeepIds: ["Bun.RedisClient"],
        inspectSubTab: "modules-classes",
        inspectQuery: "RedisClient",
      },
      {
        id: "bun-s3",
        api: "Bun.s3",
        summary: "S3-compatible storage",
        probeBunKeys: ["s3", "S3Client"],
        probeDeepIds: ["Bun.S3Client"],
        inspectSubTab: "modules-classes",
        inspectQuery: "S3Client",
      },
    ],
  },
  {
    id: "files-processes",
    title: "FILES & PROCESSES",
    items: [
      {
        id: "bun-file",
        api: "Bun.file()",
        summary: "Lazy, fast file I/O (Blob + file loader)",
        probeBunKeys: ["file", "write", "embeddedFiles"],
        inspectSubTab: "file-loader",
      },
      {
        id: "bun-shell",
        api: "Bun.$",
        summary: "Cross-platform shell",
        probeBunKeys: ["$"],
        inspectSubTab: "live-audit",
        inspectQuery: "$",
      },
      {
        id: "bun-spawn",
        api: "Bun.spawn()",
        summary: "Child processes & IPC",
        probeBunKeys: ["spawn", "spawnSync", "Terminal"],
        probeDeepIds: ["Bun.Terminal"],
        inspectSubTab: "modules-classes",
        inspectQuery: "Terminal",
      },
    ],
  },
  {
    id: "security",
    title: "SECURITY",
    items: [
      {
        id: "bun-password",
        api: "Bun.password",
        summary: "argon2 & bcrypt",
        probeBunKeys: ["password"],
        probeDeepIds: ["Bun.password"],
        inspectSubTab: "modules-classes",
        inspectQuery: "password",
      },
      {
        id: "bun-csrf",
        api: "Bun.CSRF",
        summary: "CSRF tokens",
        probeBunKeys: ["CSRF"],
        probeDeepIds: ["Bun.CSRF"],
        inspectSubTab: "modules-classes",
        inspectQuery: "CSRF",
      },
      {
        id: "bun-secrets",
        api: "Bun.secrets",
        summary: "OS keychain",
        probeBunKeys: ["secrets"],
        probeDeepIds: ["Bun.secrets"],
        inspectSubTab: "modules-classes",
        inspectQuery: "secrets",
      },
    ],
  },
  {
    id: "formats",
    title: "FORMATS",
    items: [
      {
        id: "bun-yaml",
        api: "Bun.YAML",
        summary: "YAML & TOML imports",
        probeBunKeys: ["YAML", "TOML"],
        probeDeepIds: ["Bun.YAML", "Bun.TOML"],
        inspectSubTab: "modules-classes",
        inspectQuery: "YAML",
      },
      {
        id: "bun-markdown",
        api: "Bun.markdown",
        summary: "CommonMark → HTML",
        probeBunKeys: ["markdown"],
        probeDeepIds: ["Bun.markdown"],
        inspectSubTab: "sandbox",
      },
      {
        id: "bun-escape-html",
        api: "Bun.escapeHTML()",
        summary: "and 40+ utilities",
        probeBunKeys: ["escapeHTML"],
        inspectSubTab: "sandbox",
      },
    ],
  },
  {
    id: "low-level",
    title: "LOW LEVEL",
    items: [
      {
        id: "bun-ffi",
        api: "bun:ffi",
        summary: "Call C, Rust, Zig",
        probeBunKeys: ["FFI"],
        probeDeepIds: ["bun:ffi", "Bun.FFI"],
        inspectSubTab: "modules-classes",
        inspectQuery: "bun:ffi",
      },
      {
        id: "worker-threads",
        api: "Worker",
        summary: "Threads & structuredClone",
        probeBunKeys: [],
        probeGlobals: ["Worker", "structuredClone"],
        inspectSubTab: "globals",
        inspectQuery: "Worker",
      },
      {
        id: "bun-glob",
        api: "Bun.Glob",
        summary: "Fast glob matching",
        probeBunKeys: ["Glob"],
        probeDeepIds: ["Bun.Glob"],
        inspectSubTab: "modules-classes",
        inspectQuery: "Glob",
      },
    ],
  },
]

export function probeBunCapabilityMatrix(
  audit: BunRuntimeSurfaceAuditSnapshot,
): readonly LiveCapabilityPillarProbe[] {
  const bunExports = new Set(audit.exports.map((e) => e.key))
  const presentGlobals = new Set(audit.globalProbes.filter((g) => g.present).map((g) => g.name))
  const availableDeepIds = new Set(
    audit.deepInspections.filter((d) => d.available).map((d) => d.id),
  )

  return BUN_CAPABILITY_PILLARS.map((pillar) => {
    const items = pillar.items.map((item): LiveCapabilityItemProbe => {
      const matchedSymbols: string[] = []
      for (const k of item.probeBunKeys) {
        if (bunExports.has(k)) {
          matchedSymbols.push(`Bun.${k}`)
        }
      }
      for (const g of item.probeGlobals ?? []) {
        if (presentGlobals.has(g)) {
          matchedSymbols.push(g)
        }
      }
      for (const id of item.probeDeepIds ?? []) {
        if (availableDeepIds.has(id) && !matchedSymbols.includes(id)) {
          matchedSymbols.push(id)
        }
      }
      return {
        id: item.id,
        api: item.api,
        summary: item.summary,
        available: matchedSymbols.length > 0,
        matchedSymbols,
        inspectSubTab: item.inspectSubTab,
        inspectQuery: item.inspectQuery,
      }
    })
    return {
      id: pillar.id,
      title: pillar.title,
      availableCount: items.filter((i) => i.available).length,
      totalCount: items.length,
      items,
    }
  })
}

/** Section 4: Exact Live Surface Audit Snippet for inspecting installed Bun binary exports. */
export const LIVE_SURFACE_AUDIT_SNIPPET = `const bunKeys = Object.getOwnPropertyNames(Bun)
  .map((key) => ({
    key,
    type: typeof (Bun as Record<string, unknown>)[key],
  }))
  .sort((a, b) => a.key.localeCompare(b.key));

console.log(\`Bun \${Bun.version} (\${Bun.revision.slice(0, 8)}) — \${bunKeys.length} exports\`);
console.log(Bun.inspect.table(bunKeys, ["key", "type"]));`

/** Deep module/namespace/class/kind audit snippet (strictly omits Bun.env and Bun.secrets values). */
export const DEEP_SURFACE_AUDIT_SNIPPET = `const classify = (val: unknown, key?: string) => {
  if (key === "env" || key === "secrets") return "namespace";
  if (val === null || typeof val !== "object" && typeof val !== "function") return "constant";
  if (typeof val === "function") {
    const proto = (val as { prototype?: object }).prototype;
    return proto && Object.getOwnPropertyNames(proto).some((k) => k !== "constructor") ? "class" : "function";
  }
  return Object.getOwnPropertyNames(val).some((k) => typeof (val as Record<string, unknown>)[k] === "function")
    ? "namespace" : "object";
};
const rows = Object.getOwnPropertyNames(Bun)
  .map((key) => ({ key, kind: classify((Bun as Record<string, unknown>)[key], key), type: typeof (Bun as Record<string, unknown>)[key] }))
  .sort((a, b) => a.key.localeCompare(b.key));
console.log(Bun.inspect.table(rows, ["key", "kind", "type"]));
console.log("Bun.markdown:", Object.getOwnPropertyNames(Bun.markdown));
console.log("bun:sqlite:", Object.getOwnPropertyNames(await import("bun:sqlite")));
console.log("bun:ffi:", Object.getOwnPropertyNames(await import("bun:ffi")));`

/**
 * Deterministic Unicode table renderer matching `Bun.inspect.table(rows, columns)`.
 * Uses native `Bun.inspect.table` when available on Bun; falls back to an identical
 * box-drawing renderer in Node.js and browser contexts.
 */
export function formatInspectTable(
  rows: readonly object[],
  columns?: readonly string[] | undefined,
): string {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    | {
        readonly inspect?: {
          readonly table?: (
            data: readonly object[],
            cols?: readonly string[],
            opts?: { readonly colors?: boolean },
          ) => string
        }
      }
    | undefined

  if (bunObj?.inspect && typeof bunObj.inspect.table === "function") {
    try {
      const cols = columns ? [...columns] : undefined
      return bunObj.inspect.table(rows, cols, { colors: false }).trimEnd()
    } catch {
      // Fall through to pure-TS box renderer
    }
  }

  const recordRows = rows as readonly Readonly<Record<string, unknown>>[]
  const cols =
    columns && columns.length > 0
      ? [...columns]
      : Array.from(
          recordRows.reduce<Set<string>>((acc, row) => {
            for (const k of Object.keys(row)) acc.add(k)
            return acc
          }, new Set<string>()),
        )

  if (cols.length === 0) {
    return "┌───┐\n│   │\n└───┘"
  }

  const allCols = ["", ...cols]
  const cellRows: string[][] = recordRows.map((row, idx) => [
    String(idx),
    ...cols.map((col) => {
      const val = row[col]
      if (val === null) return "null"
      if (val === undefined) return ""
      return typeof val === "string" ? val : String(val)
    }),
  ])

  const widths = allCols.map((header, colIdx) => {
    let maxW = bunStringWidth(header)
    for (const r of cellRows) {
      const w = bunStringWidth(r[colIdx] ?? "")
      if (w > maxW) maxW = w
    }
    return Math.max(1, maxW)
  })

  const pad = (val: string, width: number, rightAlign = false): string => {
    const w = bunStringWidth(val)
    const diff = Math.max(0, width - w)
    return rightAlign ? `${" ".repeat(diff)}${val}` : `${val}${" ".repeat(diff)}`
  }

  const makeBorder = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`

  const lines: string[] = []
  lines.push(makeBorder("┌", "┬", "┐"))
  lines.push(`│ ${allCols.map((h, i) => pad(h, widths[i]!)).join(" │ ")} │`)
  lines.push(makeBorder("├", "┼", "┤"))
  for (const r of cellRows) {
    lines.push(`│ ${r.map((cell, i) => pad(cell, widths[i]!, i === 0)).join(" │ ")} │`)
  }
  lines.push(makeBorder("└", "┴", "┘"))
  return lines.join("\n")
}

function resolveHostRuntimeLabel(): string {
  const g = globalThis as Record<string, unknown>
  const bunObj = g.Bun as { readonly version?: unknown } | undefined
  if (bunObj && typeof bunObj === "object" && typeof bunObj.version === "string") {
    return `bun/${bunObj.version}`
  }
  const proc = g.process as { readonly versions?: { readonly node?: string } } | undefined
  if (proc?.versions?.node) {
    return `node/${proc.versions.node}`
  }
  return "browser"
}

function buildGlobalProbes(scope: Record<string, unknown>): readonly LiveGlobalProbeEntry[] {
  const results: LiveGlobalProbeEntry[] = []
  for (const tier of BUN_GLOBAL_TIERS) {
    for (const name of tier.globals) {
      let present = false
      let valueType = "undefined"
      if (name === "__dirname" || name === "__filename" || name === "require") {
        // CommonJS module-scoped bindings: probe on globalThis safely without throwing
        const val = scope[name]
        present = val !== undefined
        valueType = typeof val
      } else {
        try {
          const val = scope[name]
          present = val !== undefined
          valueType = typeof val
        } catch {
          present = false
          valueType = "inaccessible"
        }
      }
      results.push({
        name,
        tier: tier.id,
        present,
        valueType,
      })
    }
  }
  return results
}

function buildUtilityProbes(bunExportSet: ReadonlySet<string>): readonly LiveUtilityProbeEntry[] {
  return BUN_UTILITIES_CATALOG.map((spec) => {
    const matchedKeys = spec.probeKeys.filter((k) => bunExportSet.has(k))
    return {
      id: spec.id,
      signature: spec.signature,
      category: spec.category,
      available: matchedKeys.length > 0,
      matchedKeys,
    }
  })
}

function buildCoreDomainProbes(
  bunExportSet: ReadonlySet<string>,
): readonly LiveCoreApiDomainProbeEntry[] {
  return BUN_CORE_API_DOMAINS.map((spec) => {
    const availableKeys = spec.probeBunKeys.filter((k) => bunExportSet.has(k))
    const missingKeys = spec.probeBunKeys.filter((k) => !bunExportSet.has(k))
    return {
      id: spec.id,
      domain: spec.domain,
      availableCount: availableKeys.length,
      totalProbed: spec.probeBunKeys.length,
      availableKeys,
      missingKeys,
    }
  })
}

const REDACTED_BUN_KEYS = new Set(["env", "secrets"])
const SAFE_CONSTANT_PREVIEW_KEYS = new Set([
  "version",
  "revision",
  "version_with_sha",
  "enableANSIColors",
  "isMainThread",
  "isStandaloneExecutable",
  "origin",
])
const KNOWN_CLASS_CONSTRUCTORS = new Set([
  "SQL",
  "ArrayBufferSink",
  "S3Client",
  "RedisClient",
  "CookieMap",
  "Cookie",
  "Glob",
  "Archive",
  "CryptoHasher",
  "Transpiler",
  "FileSystemRouter",
  "Terminal",
  "Image",
  "ModuleGraph",
  "WebView",
  "FetchSession",
  "Database",
  "Statement",
  "SQLiteError",
  "CFunction",
  "CString",
  "JSCallback",
])
const FUNCTION_OWN_IGNORED = new Set(["length", "name", "prototype", "arguments", "caller"])

/**
 * Classifies a runtime export into its semantic symbol kind without executing
 * or leaking secret values.
 */
export function classifyBunSymbolKind(value: unknown, key?: string): BunExportKind {
  if (key && REDACTED_BUN_KEYS.has(key)) return "namespace"
  if (value === null) return "constant"
  const t = typeof value
  if (
    t === "string" ||
    t === "number" ||
    t === "boolean" ||
    t === "bigint" ||
    t === "symbol" ||
    t === "undefined"
  ) {
    return "constant"
  }
  if (t === "function") {
    if (key && KNOWN_CLASS_CONSTRUCTORS.has(key)) return "class"
    try {
      const src = Function.prototype.toString.call(value)
      if (/^\s*class\b/.test(src)) return "class"
    } catch {
      // ignore native toString errors
    }
    try {
      const proto = (value as { readonly prototype?: unknown }).prototype
      if (
        proto &&
        typeof proto === "object" &&
        Object.getOwnPropertyNames(proto).some((p) => p !== "constructor")
      ) {
        return "class"
      }
    } catch {
      // ignore
    }
    return "function"
  }
  if (t === "object") {
    try {
      const keys = Object.getOwnPropertyNames(value)
      const hasFn = keys.some((k) => {
        try {
          return typeof (value as Record<string, unknown>)[k] === "function"
        } catch {
          return false
        }
      })
      return hasFn ? "namespace" : "object"
    } catch {
      return "object"
    }
  }
  return "object"
}

function formatSafeConstantPreview(value: unknown): string | undefined {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    return String(value)
  }
  if (typeof value === "string") {
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, "")
    return clean.length > 48 ? `${clean.slice(0, 45)}...` : clean
  }
  return undefined
}

function summarizeKindCounts(exportsList: readonly BunNamespaceExportEntry[]): BunKindCounts {
  let classCount = 0
  let namespaceCount = 0
  let functionCount = 0
  let constantCount = 0
  let objectCount = 0
  for (const entry of exportsList) {
    switch (entry.kind) {
      case "class":
        classCount += 1
        break
      case "namespace":
        namespaceCount += 1
        break
      case "function":
        functionCount += 1
        break
      case "constant":
        constantCount += 1
        break
      case "object":
        objectCount += 1
        break
    }
  }
  return {
    class: classCount,
    namespace: namespaceCount,
    function: functionCount,
    constant: constantCount,
    object: objectCount,
  }
}

/**
 * Inspects a single Bun namespace, class, or built-in module into structured
 * member entries (`export`, `static`, `prototype`, `constant`). Strictly read-only.
 */
export function inspectBunDeepTarget(
  target: unknown,
  meta: {
    readonly id: string
    readonly label: string
    readonly category: BunDeepInspectionCategory
    readonly domain: string
    readonly notes: string
  },
): BunDeepInspectionEntry {
  if (
    target === null ||
    target === undefined ||
    (typeof target !== "object" && typeof target !== "function")
  ) {
    return {
      id: meta.id,
      label: meta.label,
      category: meta.category,
      domain: meta.domain,
      available: false,
      memberCount: 0,
      classCount: 0,
      functionCount: 0,
      constantCount: 0,
      namespaceCount: 0,
      members: [],
      notes: meta.notes,
    }
  }

  const members: BunDeepSymbolMember[] = []
  const seen = new Set<string>()
  const record = target as Record<string, unknown>

  const ownKeys = Object.getOwnPropertyNames(target)
    .filter((k) => {
      if (k === "__esModule" || k === "default") return false
      if (typeof target === "function" && FUNCTION_OWN_IGNORED.has(k)) return false
      return true
    })
    .sort((a, b) => a.localeCompare(b))

  for (const name of ownKeys) {
    let val: unknown
    let valType = "unknown"
    try {
      val = record[name]
      valType = typeof val
    } catch {
      valType = "getter"
    }
    const kind = classifyBunSymbolKind(val, name)
    const scope: BunDeepSymbolMember["scope"] =
      meta.category === "bun-class" ? "static" : kind === "constant" ? "constant" : "export"

    const isRedactedTarget = meta.id === "Bun.secrets" || meta.id === "Bun.env"
    const safePreview =
      kind === "constant" && !isRedactedTarget && !REDACTED_BUN_KEYS.has(name)
        ? formatSafeConstantPreview(val)
        : undefined

    const dedupeKey = `${scope}:${name}`
    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey)
      members.push({
        name,
        kind,
        type: valType,
        scope,
        ...(safePreview !== undefined ? { safePreview } : {}),
      })
    }

    // Expand nested constant enums like `bun:sqlite.constants` or `bun:ffi.FFIType`
    if ((name === "constants" || name === "FFIType") && val && typeof val === "object") {
      const subObj = val as Record<string, unknown>
      const subKeys = Object.getOwnPropertyNames(subObj)
        .filter((sk) => !/^\d+$/.test(sk))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 28)
      for (const sk of subKeys) {
        let subVal: unknown
        try {
          subVal = subObj[sk]
        } catch {
          subVal = undefined
        }
        const subName = `${name}.${sk}`
        if (!seen.has(`constant:${subName}`)) {
          seen.add(`constant:${subName}`)
          members.push({
            name: subName,
            kind: "constant",
            type: typeof subVal,
            scope: "constant",
            ...(formatSafeConstantPreview(subVal) !== undefined
              ? { safePreview: formatSafeConstantPreview(subVal) }
              : {}),
          })
        }
      }
    }
  }

  // Prototype methods for classes
  if (typeof target === "function") {
    try {
      const proto = (target as { readonly prototype?: unknown }).prototype
      if (proto && typeof proto === "object") {
        const protoKeys = Object.getOwnPropertyNames(proto)
          .filter((k) => k !== "constructor")
          .sort((a, b) => a.localeCompare(b))
        for (const pName of protoKeys) {
          let pType = "function"
          let pKind: BunExportKind = "function"
          try {
            const desc = Object.getOwnPropertyDescriptor(proto, pName)
            if (desc && ("get" in desc || "set" in desc) && !("value" in desc)) {
              pType = "accessor"
              pKind = "constant"
            } else if (desc) {
              pType = typeof desc.value
              pKind = classifyBunSymbolKind(desc.value, pName)
            }
          } catch {
            pType = "accessor"
          }
          const dedupeKey = `prototype:${pName}`
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey)
            members.push({
              name: pName,
              kind: pKind,
              type: pType,
              scope: "prototype",
            })
          }
        }
      }
    } catch {
      // ignore non-inspectable prototype
    }
  }

  return {
    id: meta.id,
    label: meta.label,
    category: meta.category,
    domain: meta.domain,
    available: true,
    memberCount: members.length,
    classCount: members.filter((m) => m.kind === "class").length,
    functionCount: members.filter((m) => m.kind === "function").length,
    constantCount: members.filter((m) => m.kind === "constant").length,
    namespaceCount: members.filter((m) => m.kind === "namespace").length,
    members,
    notes: meta.notes,
  }
}

/**
 * Inspects nested `Bun.*` namespaces and core `Bun.*` classes from a live `Bun`
 * object, and merges optional `bun:*` built-in module inspections.
 */
export function inspectBunDeepSurface(
  bunObj: Record<string, unknown> | null,
  builtinModuleObjects: Readonly<Record<string, unknown>> = {},
): readonly BunDeepInspectionEntry[] {
  const results: BunDeepInspectionEntry[] = []

  for (const mod of BUN_BUILTIN_MODULE_TARGETS) {
    const resolved = builtinModuleObjects[mod.specifier]
    results.push(
      inspectBunDeepTarget(resolved, {
        id: mod.specifier,
        label: mod.specifier,
        category: "builtin-module",
        domain: mod.domain,
        notes: mod.notes,
      }),
    )
  }

  for (const ns of BUN_DEEP_NAMESPACE_TARGETS) {
    let target: unknown = undefined
    if (bunObj) {
      try {
        target = bunObj[ns.key]
      } catch {
        target = undefined
      }
    }
    results.push(
      inspectBunDeepTarget(target, {
        id: `Bun.${ns.key}`,
        label: ns.label,
        category: "bun-namespace",
        domain: ns.domain,
        notes: ns.notes,
      }),
    )
  }

  for (const cls of BUN_DEEP_CLASS_TARGETS) {
    let target: unknown = undefined
    if (bunObj) {
      try {
        target = bunObj[cls.key]
      } catch {
        target = undefined
      }
    }
    results.push(
      inspectBunDeepTarget(target, {
        id: `Bun.${cls.key}`,
        label: cls.label,
        category: "bun-class",
        domain: cls.domain,
        notes: cls.notes,
      }),
    )
  }

  return results
}

/**
 * Executes a read-only Live Surface Audit against the current JS runtime
 * (`globalThis` and `globalThis.Bun`). Never accesses secret values.
 */
export function runBunSurfaceAudit(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
  builtinModuleObjects: Readonly<Record<string, unknown>> = {},
): BunRuntimeSurfaceAuditSnapshot {
  const startedMs = performance.now()
  const bunRaw = scope.Bun
  const bunObj = bunRaw && typeof bunRaw === "object" ? (bunRaw as Record<string, unknown>) : null

  const exportsList: BunNamespaceExportEntry[] = bunObj
    ? Object.getOwnPropertyNames(bunObj)
        .map((key): BunNamespaceExportEntry => {
          if (REDACTED_BUN_KEYS.has(key)) {
            return {
              key,
              type: "object",
              kind: "namespace",
              redacted: true,
              safePreview: "[REDACTED — values never serialized]",
            }
          }
          let val: unknown
          let valueType = "unknown"
          try {
            val = bunObj[key]
            valueType = typeof val
          } catch {
            valueType = "getter"
          }
          const kind = classifyBunSymbolKind(val, key)
          let memberCount: number | undefined
          let staticMemberCount: number | undefined
          let prototypeMethodCount: number | undefined
          if (kind === "namespace" && val && typeof val === "object") {
            try {
              memberCount = Object.getOwnPropertyNames(val).length
            } catch {
              memberCount = undefined
            }
          } else if (kind === "class" && typeof val === "function") {
            try {
              staticMemberCount = Object.getOwnPropertyNames(val).filter(
                (k) => !FUNCTION_OWN_IGNORED.has(k),
              ).length
              const proto = (val as { readonly prototype?: unknown }).prototype
              if (proto && typeof proto === "object") {
                prototypeMethodCount = Object.getOwnPropertyNames(proto).filter(
                  (k) => k !== "constructor",
                ).length
              }
              memberCount = (staticMemberCount ?? 0) + (prototypeMethodCount ?? 0)
            } catch {
              memberCount = undefined
            }
          }
          const safePreview =
            kind === "constant" && SAFE_CONSTANT_PREVIEW_KEYS.has(key)
              ? formatSafeConstantPreview(val)
              : undefined

          return {
            key,
            type: valueType,
            kind,
            ...(memberCount !== undefined ? { memberCount } : {}),
            ...(staticMemberCount !== undefined ? { staticMemberCount } : {}),
            ...(prototypeMethodCount !== undefined ? { prototypeMethodCount } : {}),
            ...(safePreview !== undefined ? { safePreview } : {}),
          }
        })
        .sort((a, b) => a.key.localeCompare(b.key))
    : []

  const exportTypeCounts: Record<string, number> = {}
  for (const item of exportsList) {
    exportTypeCounts[item.type] = (exportTypeCounts[item.type] ?? 0) + 1
  }
  const kindCounts = summarizeKindCounts(exportsList)

  const bunExportSet = new Set(exportsList.map((e) => e.key))
  const bunVersion = bunObj && typeof bunObj.version === "string" ? bunObj.version : null
  const bunRevision = bunObj && typeof bunObj.revision === "string" ? bunObj.revision : null
  const isMainThread =
    bunObj && typeof bunObj.isMainThread === "boolean" ? bunObj.isMainThread : null
  const enableAnsiColors =
    bunObj && typeof bunObj.enableANSIColors === "boolean" ? bunObj.enableANSIColors : null

  const proc = scope.process as
    | {
        readonly env?: unknown
        readonly on?: unknown
        readonly versions?: { readonly node?: string }
      }
    | undefined
  const processEnvEqualsBunEnv =
    bunObj && proc && typeof proc === "object" ? proc.env === bunObj.env : null
  const memoryPressureSupported = Boolean(bunObj && typeof proc?.on === "function")

  const source: BunRuntimeSurfaceAuditSnapshot["source"] = bunObj
    ? "bun-in-process"
    : proc?.versions?.node
      ? "node-fallback"
      : "browser-fallback"

  const headerLine =
    bunObj && bunVersion
      ? `Bun ${bunVersion} (${(bunRevision ?? "").slice(0, 8)}) — ${exportsList.length} exports (${kindCounts.class} classes · ${kindCounts.namespace} namespaces · ${kindCounts.function} functions · ${kindCounts.constant} constants)`
      : `${resolveHostRuntimeLabel()} — Bun namespace not active in host process`

  const inspectTableText =
    exportsList.length > 0
      ? `${headerLine}\n${formatInspectTable(exportsList, ["key", "kind", "type"])}`
      : headerLine

  const embeddedRaw = bunObj?.embeddedFiles
  const embeddedList = Array.isArray(embeddedRaw)
    ? embeddedRaw.slice(0, 24).map((entry) => {
        const rec = entry as {
          readonly name?: unknown
          readonly type?: unknown
          readonly size?: unknown
        }
        return {
          name: typeof rec?.name === "string" ? rec.name : "embedded-asset",
          type: typeof rec?.type === "string" ? rec.type : "application/octet-stream",
          size: typeof rec?.size === "number" && Number.isFinite(rec.size) ? rec.size : 0,
        }
      })
    : []

  const fileLoaderProbe: BunFileLoaderLiveProbe = {
    source,
    bunVersion,
    bunFileAvailable: typeof bunObj?.file === "function",
    bunWriteAvailable: typeof bunObj?.write === "function",
    bunBuildAvailable: typeof bunObj?.build === "function",
    isStandaloneExecutable: Boolean(bunObj?.isStandaloneExecutable),
    embeddedFilesAvailable: Array.isArray(embeddedRaw),
    embeddedFilesCount: Array.isArray(embeddedRaw) ? embeddedRaw.length : 0,
    embeddedFiles: embeddedList,
    sampleAsset: null,
  }

  return {
    source,
    hostRuntime: resolveHostRuntimeLabel(),
    bunDetected: Boolean(bunObj),
    bunVersion,
    bunRevision,
    bunRevisionShort: bunRevision ? bunRevision.slice(0, 8) : null,
    isMainThread,
    enableAnsiColors,
    processEnvEqualsBunEnv,
    memoryPressureSupported,
    exportCount: exportsList.length,
    exports: exportsList,
    exportTypeCounts,
    kindCounts,
    deepInspections: inspectBunDeepSurface(bunObj, builtinModuleObjects),
    inspectTableText,
    globalProbes: buildGlobalProbes(scope),
    utilityProbes: buildUtilityProbes(bunExportSet),
    coreDomainProbes: buildCoreDomainProbes(bunExportSet),
    fileLoaderProbe,
    auditedAt: new Date().toISOString(),
    auditDurationMs: Math.max(0, Number((performance.now() - startedMs).toFixed(2))),
  }
}

/**
 * Hydrates a `BunRuntimeSurfaceAuditSnapshot` from raw Bun binary probe JSON
 * (used when the Express server runs under Node.js and invokes the installed
 * `bun` binary read-only with a scrubbed environment).
 */
export function buildAuditSnapshotFromBinaryProbe(
  probe: {
    readonly bunVersion: string
    readonly bunRevision: string
    readonly isMainThread: boolean
    readonly enableAnsiColors?: boolean | null | undefined
    readonly processEnvEqualsBunEnv: boolean
    readonly exports: readonly (Omit<BunNamespaceExportEntry, "kind"> & {
      readonly kind?: BunExportKind | undefined
    })[]
    readonly deepInspections?: readonly BunDeepInspectionEntry[] | undefined
    readonly globalProbes?: readonly LiveGlobalProbeEntry[] | undefined
    readonly inspectTableText?: string | undefined
    readonly fileLoaderProbe?: BunFileLoaderLiveProbe | undefined
  },
  durationMs: number,
): BunRuntimeSurfaceAuditSnapshot {
  const normalizedExports: BunNamespaceExportEntry[] = [...probe.exports]
    .map((entry) => ({
      ...entry,
      kind:
        entry.kind ??
        (entry.type === "function"
          ? KNOWN_CLASS_CONSTRUCTORS.has(entry.key)
            ? "class"
            : "function"
          : entry.type === "object"
            ? "object"
            : "constant"),
    }))
    .sort((a, b) => a.key.localeCompare(b.key))

  const exportTypeCounts: Record<string, number> = {}
  for (const item of normalizedExports) {
    exportTypeCounts[item.type] = (exportTypeCounts[item.type] ?? 0) + 1
  }
  const kindCounts = summarizeKindCounts(normalizedExports)
  const bunExportSet = new Set(normalizedExports.map((e) => e.key))
  const headerLine = `Bun ${probe.bunVersion} (${probe.bunRevision.slice(0, 8)}) — ${normalizedExports.length} exports (${kindCounts.class} classes · ${kindCounts.namespace} namespaces · ${kindCounts.function} functions · ${kindCounts.constant} constants)`
  const tableText =
    probe.inspectTableText && probe.inspectTableText.trim().length > 0
      ? `${headerLine}\n${probe.inspectTableText.trimEnd()}`
      : `${headerLine}\n${formatInspectTable(normalizedExports, ["key", "kind", "type"])}`

  return {
    source: "bun-binary-probe",
    hostRuntime: resolveHostRuntimeLabel(),
    bunDetected: true,
    bunVersion: probe.bunVersion,
    bunRevision: probe.bunRevision,
    bunRevisionShort: probe.bunRevision.slice(0, 8),
    isMainThread: probe.isMainThread,
    enableAnsiColors: probe.enableAnsiColors ?? null,
    processEnvEqualsBunEnv: probe.processEnvEqualsBunEnv,
    memoryPressureSupported: true,
    exportCount: normalizedExports.length,
    exports: normalizedExports,
    exportTypeCounts,
    kindCounts,
    deepInspections: probe.deepInspections ?? [],
    inspectTableText: tableText,
    globalProbes:
      probe.globalProbes && probe.globalProbes.length > 0
        ? probe.globalProbes
        : buildGlobalProbes(globalThis as unknown as Record<string, unknown>),
    utilityProbes: buildUtilityProbes(bunExportSet),
    coreDomainProbes: buildCoreDomainProbes(bunExportSet),
    ...(probe.fileLoaderProbe ? { fileLoaderProbe: probe.fileLoaderProbe } : {}),
    auditedAt: new Date().toISOString(),
    auditDurationMs: Math.max(0, Number(durationMs.toFixed(2))),
  }
}

// ── Cross-Runtime Interactive Utility Helpers (for the Live Utility Sandbox) ──

/**
 * Generates an RFC 9562 time-ordered UUIDv7.
 * Delegates to native `Bun.randomUUIDv7()` when running under Bun, and uses
 * a cryptographically random RFC 9562 v7 implementation in browser/Node.
 */
export function generateBunUuidV7(timestampMs: number = Date.now()): string {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    { readonly randomUUIDv7?: (encoding?: "hex", timestamp?: number) => string } | undefined
  if (bunObj && typeof bunObj.randomUUIDv7 === "function") {
    try {
      return bunObj.randomUUIDv7("hex", timestampMs)
    } catch {
      // Fallback below
    }
  }

  const bytes = new Uint8Array(16)
  const ts = BigInt(Math.max(0, Math.floor(timestampMs)))
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)

  const rand = new Uint8Array(10)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(rand)
  } else {
    for (let i = 0; i < rand.length; i += 1) {
      rand[i] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = 0x70 | (rand[0]! & 0x0f) // version 7
  bytes[7] = rand[1]!
  bytes[8] = 0x80 | (rand[2]! & 0x3f) // RFC 4122/9562 variant 10
  for (let i = 0; i < 7; i += 1) {
    bytes[9 + i] = rand[3 + i]!
  }

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Extracts the embedded 48-bit Unix millisecond timestamp from a UUIDv7 string.
 */
export function decodeUuidV7TimestampIso(uuid: string): string | null {
  const clean = uuid.replace(/-/g, "")
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) return null
  if (clean[12] !== "7") return null
  const ms = Number.parseInt(clean.slice(0, 12), 16)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

/**
 * Structural deep equality matching `Bun.deepEquals(a, b, strict?)`.
 */
export function bunDeepEquals(a: unknown, b: unknown, strict = false): boolean {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    { readonly deepEquals?: (x: unknown, y: unknown, strict?: boolean) => boolean } | undefined
  if (bunObj && typeof bunObj.deepEquals === "function") {
    try {
      return bunObj.deepEquals(a, b, strict)
    } catch {
      // Fall through to pure-TS structural equality
    }
  }

  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (strict && i in a !== i in b) return false
      if (!bunDeepEquals(a[i], b[i], strict)) return false
    }
    return true
  }

  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA).filter((k) => strict || objA[k] !== undefined)
  const keysB = Object.keys(objB).filter((k) => strict || objB[k] !== undefined)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key) && (strict || objA[key] !== undefined)) {
      return false
    }
    if (!bunDeepEquals(objA[key], objB[key], strict)) return false
  }
  return true
}

export interface BunStringUtilityProbeResult {
  readonly rawLength: number
  readonly stripped: string
  readonly displayWidth: number
  readonly escapedHtml: string
}

export function evaluateBunStringUtilities(input: string): BunStringUtilityProbeResult {
  return {
    rawLength: input.length,
    stripped: bunStripAnsi(input),
    displayWidth: bunStringWidth(input),
    escapedHtml: bunEscapeHtml(input),
  }
}

export interface BunColorConversionResult {
  readonly valid: boolean
  readonly input: string
  readonly hex: string | null
  readonly rgb: string | null
  readonly rgba: string | null
  readonly number: number | null
  readonly ansi16m: string | null
}

/**
 * Parses hex (`#rgb`, `#rrggbb`) or `rgb(r, g, b)` inputs into Bun.color formats.
 */
export function evaluateBunColorConversions(input: string): BunColorConversionResult {
  const trimmed = input.trim()
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    { readonly color?: (val: string, format: string) => string | number | null } | undefined

  if (bunObj && typeof bunObj.color === "function") {
    try {
      const hex = bunObj.color(trimmed, "hex")
      if (typeof hex === "string") {
        const rgb = bunObj.color(trimmed, "rgb")
        const rgba = bunObj.color(trimmed, "rgba")
        const num = bunObj.color(trimmed, "number")
        const ansi16m = bunObj.color(trimmed, "ansi-16m")
        return {
          valid: true,
          input: trimmed,
          hex,
          rgb: typeof rgb === "string" ? rgb : null,
          rgba: typeof rgba === "string" ? rgba : null,
          number: typeof num === "number" ? num : null,
          ansi16m: typeof ansi16m === "string" ? ansi16m : null,
        }
      }
    } catch {
      // Fall through to pure-TS converter
    }
  }

  let r: number | null = null
  let g: number | null = null
  let b: number | null = null

  const shortHex = /^#([0-9a-f]{3})$/i.exec(trimmed)
  const fullHex = /^#([0-9a-f]{6})$/i.exec(trimmed)
  const rgbMatch =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[0-9.]+)?\s*\)$/i.exec(trimmed)

  if (shortHex?.[1]) {
    r = Number.parseInt(shortHex[1][0]! + shortHex[1][0]!, 16)
    g = Number.parseInt(shortHex[1][1]! + shortHex[1][1]!, 16)
    b = Number.parseInt(shortHex[1][2]! + shortHex[1][2]!, 16)
  } else if (fullHex?.[1]) {
    r = Number.parseInt(fullHex[1].slice(0, 2), 16)
    g = Number.parseInt(fullHex[1].slice(2, 4), 16)
    b = Number.parseInt(fullHex[1].slice(4, 6), 16)
  } else if (rgbMatch) {
    r = Math.min(255, Number.parseInt(rgbMatch[1]!, 10))
    g = Math.min(255, Number.parseInt(rgbMatch[2]!, 10))
    b = Math.min(255, Number.parseInt(rgbMatch[3]!, 10))
  }

  if (r === null || g === null || b === null) {
    return {
      valid: false,
      input: trimmed,
      hex: null,
      rgb: null,
      rgba: null,
      number: null,
      ansi16m: null,
    }
  }

  const hex = bunColorCss(
    `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
  )
  return {
    valid: true,
    input: trimmed,
    hex,
    rgb: `rgb(${r}, ${g}, ${b})`,
    rgba: `rgba(${r}, ${g}, ${b}, 1)`,
    number: (r << 16) | (g << 8) | b,
    ansi16m: `\u001b[38;2;${r};${g};${b}m`,
  }
}

// ── Bun.markdown.render & AnsiTheme Cross-Runtime Studio Engine ───────────────

/** Mirrors `import("bun").markdown.AnsiTheme` across Bun, Node.js, and browser runtimes. */
export interface BunAnsiThemeConfig {
  readonly colors: boolean
  readonly columns: number
  readonly hyperlinks: boolean
  readonly light: boolean
  readonly kittyGraphics: boolean
}

export interface BunAnsiSemanticPaletteHex {
  readonly heading: string
  readonly key: string
  readonly code: string
  readonly ok: string
  readonly warn: string
  readonly redacted: string
  readonly quote: string
  readonly link: string
}

export type BunMarkdownRenderPresetId =
  "obsidian-desk" | "amber-surveillance" | "emerald-audit" | "light-paper"

export type BunMarkdownRenderMode = "render-callbacks" | "ansi-theme" | "html"

export interface BunMarkdownRenderPreset {
  readonly id: BunMarkdownRenderPresetId
  readonly label: string
  readonly description: string
  readonly defaultTheme: BunAnsiThemeConfig
  readonly paletteHex: BunAnsiSemanticPaletteHex
}

export const BUN_ANSI_THEME_PRESETS: readonly BunMarkdownRenderPreset[] = [
  {
    id: "obsidian-desk",
    label: "Obsidian Desk",
    description: "TrueColor dark ops palette matching src/theme/ansi_tokens.ts",
    defaultTheme: {
      colors: true,
      columns: 76,
      hyperlinks: true,
      light: false,
      kittyGraphics: false,
    },
    paletteHex: {
      heading: "#38bdf8",
      key: "#94a3b8",
      code: "#f59e0b",
      ok: "#22c55e",
      warn: "#eab308",
      redacted: "#ef4444",
      quote: "#64748b",
      link: "#60a5fa",
    },
  },
  {
    id: "amber-surveillance",
    label: "Amber Surveillance",
    description: "High-visibility risk desk palette for sharp-action & alert digests",
    defaultTheme: {
      colors: true,
      columns: 76,
      hyperlinks: true,
      light: false,
      kittyGraphics: false,
    },
    paletteHex: {
      heading: "#fbbf24",
      key: "#cbd5e1",
      code: "#fb923c",
      ok: "#4ade80",
      warn: "#facc15",
      redacted: "#f87171",
      quote: "#94a3b8",
      link: "#38bdf8",
    },
  },
  {
    id: "emerald-audit",
    label: "Emerald Audit",
    description: "Terminal telemetry palette tuned for live runtime & SQLite audits",
    defaultTheme: {
      colors: true,
      columns: 80,
      hyperlinks: true,
      light: false,
      kittyGraphics: false,
    },
    paletteHex: {
      heading: "#34d399",
      key: "#a7f3d0",
      code: "#38bdf8",
      ok: "#22c55e",
      warn: "#fbbf24",
      redacted: "#fb7185",
      quote: "#6ee7b7",
      link: "#7dd3fc",
    },
  },
  {
    id: "light-paper",
    label: "Light Paper",
    description: "Light-background AnsiTheme (light: true) with accessible contrast",
    defaultTheme: {
      colors: true,
      columns: 76,
      hyperlinks: true,
      light: true,
      kittyGraphics: false,
    },
    paletteHex: {
      heading: "#0369a1",
      key: "#334155",
      code: "#b45309",
      ok: "#15803d",
      warn: "#a16207",
      redacted: "#b91c1c",
      quote: "#475569",
      link: "#1d4ed8",
    },
  },
]

export interface BunMarkdownCallbackSpec {
  readonly hook: string
  readonly signature: string
  readonly role: string
}

export const BUN_MARKDOWN_CALLBACK_SPECS: readonly BunMarkdownCallbackSpec[] = [
  {
    hook: "heading",
    signature: "(children, { level }) => string",
    role: "Bold TrueColor heading + level accent prefix",
  },
  {
    hook: "paragraph",
    signature: "(children) => string",
    role: "Column-wrapped prose block via Bun.wrapAnsi",
  },
  {
    hook: "strong",
    signature: "(children) => string",
    role: "Bold + semantic key color SGR sequence",
  },
  {
    hook: "emphasis",
    signature: "(children) => string",
    role: "Italic SGR (\\x1b[3m ... \\x1b[23m)",
  },
  {
    hook: "codespan",
    signature: "(children) => string",
    role: "Tints [REDACTED*] red; inline symbols in code accent",
  },
  {
    hook: "code",
    signature: "(children, { language }) => string",
    role: "Dimmed fenced block with control-character stripping",
  },
  {
    hook: "blockquote",
    signature: "(children) => string",
    role: "Prefixed │ rail in semantic quote color",
  },
  {
    hook: "listItem",
    signature: "(children, { ordered, index, start }) => string",
    role: "Bullet/numbered list formatting with task indicators",
  },
  {
    hook: "link",
    signature: "(children, { href }) => string",
    role: "Safe http(s)/mailto OSC-8 hyperlink (blocks javascript: & signed S3 params)",
  },
  {
    hook: "strikethrough",
    signature: "(children) => string",
    role: "Strikethrough SGR (\\x1b[9m ... \\x1b[29m)",
  },
  {
    hook: "hr",
    signature: "() => string",
    role: "Horizontal rule scaled to AnsiTheme.columns",
  },
  {
    hook: "text / html",
    signature: "(text) => string",
    role: "Leaf sanitizer stripping raw C0/C1 terminal control codes",
  },
]

export const DEFAULT_BUN_MARKDOWN_STUDIO_SAMPLE = `# SportsDesk Ops — Live Surface Brief

**Runtime**: \`Bun.markdown.render\` + \`AnsiTheme\` · Secret posture: \`[REDACTED:TOKEN]\`

- **Sharp Ticket**: \`T-9041\` on [NFL Markets](https://fantasy402.com)
- ~~Stale line -3.5~~ → *Repriced -4.0* (hold > 4.2%)
- Unsafe link neutralized: [Blocked Script](javascript:alert(1))

> Use \`Bun.markdown.render(md, callbacks)\` for custom SGR themes and \`Bun.markdown.ansi(md, theme)\` for built-in terminal layout.

---`

export interface BunMarkdownStudioOptions {
  readonly mode?: BunMarkdownRenderMode | undefined
  readonly presetId?: BunMarkdownRenderPresetId | undefined
  readonly theme?: Partial<BunAnsiThemeConfig> | undefined
}

export interface BunMarkdownStudioResult {
  readonly engine: "bun-native" | "ts-fallback"
  readonly mode: BunMarkdownRenderMode
  readonly presetId: BunMarkdownRenderPresetId
  readonly ansiTheme: BunAnsiThemeConfig
  readonly paletteHex: BunAnsiSemanticPaletteHex
  readonly resolvedPaletteAnsi: Readonly<Record<keyof BunAnsiSemanticPaletteHex, string>>
  readonly ansi: string
  readonly plain: string
  readonly html: string
  readonly lineCount: number
  readonly maxColumns: number
  readonly ansiByteLength: number
  readonly callbacksInvoked: readonly string[]
}

const STUDIO_TERMINAL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
const STUDIO_SIGNED_S3_PARAMS = new Set([
  "x-amz-credential",
  "x-amz-signature",
  "x-amz-security-token",
])

function stripTerminalControls(text: string): string {
  return text.replace(STUDIO_TERMINAL_CONTROLS, "")
}

function validateSafeStudioHref(href: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\t\n]/.test(href)) return null
  try {
    const parsed = new URL(href.trim())
    if (
      parsed.protocol !== "https:" &&
      parsed.protocol !== "http:" &&
      parsed.protocol !== "mailto:"
    ) {
      return null
    }
    for (const key of parsed.searchParams.keys()) {
      if (STUDIO_SIGNED_S3_PARAMS.has(key.toLowerCase())) return null
    }
    return parsed.href
  } catch {
    return null
  }
}

function buildOsc8Link(
  label: string,
  href: string,
  enabled: boolean,
  linkColor: string,
  reset: string,
): string {
  const safe = validateSafeStudioHref(href)
  const cleanLabel = stripTerminalControls(label).replace(/[\t\n]/g, " ")
  if (!safe) return cleanLabel
  if (!enabled) return `${linkColor}${cleanLabel}${reset} (${safe})`
  return `\u001b]8;;${safe}\u001b\\${linkColor}\u001b[4m${cleanLabel}\u001b[24m${reset}\u001b]8;;\u001b\\`
}

function wrapTextToColumns(text: string, columns: number): string {
  if (!Number.isFinite(columns) || columns <= 0) return text
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    { readonly wrapAnsi?: (input: string, cols: number) => string } | undefined
  if (typeof bunObj?.wrapAnsi === "function") {
    try {
      return bunObj.wrapAnsi(text, columns)
    } catch {
      // fall through
    }
  }
  const lines = text.split("\n")
  const out: string[] = []
  for (const line of lines) {
    if (bunStringWidth(line) <= columns) {
      out.push(line)
      continue
    }
    const words = line.split(" ")
    let current = ""
    for (const word of words) {
      if (!current) {
        current = word
      } else if (bunStringWidth(current) + 1 + bunStringWidth(word) <= columns) {
        current = `${current} ${word}`
      } else {
        out.push(current)
        current = word
      }
    }
    if (current) out.push(current)
  }
  return out.join("\n")
}

function resolveSemanticPaletteAnsi(
  paletteHex: BunAnsiSemanticPaletteHex,
  colorsEnabled: boolean,
): Record<keyof BunAnsiSemanticPaletteHex, string> {
  const keys = Object.keys(paletteHex) as (keyof BunAnsiSemanticPaletteHex)[]
  const resolved = {} as Record<keyof BunAnsiSemanticPaletteHex, string>
  for (const k of keys) {
    if (!colorsEnabled) {
      resolved[k] = ""
    } else {
      const converted = evaluateBunColorConversions(paletteHex[k])
      resolved[k] = converted.ansi16m ?? ""
    }
  }
  return resolved
}

function fallbackMarkdownRenderToAnsi(
  markdown: string,
  mode: "render-callbacks" | "ansi-theme",
  theme: BunAnsiThemeConfig,
  paletteAnsi: Readonly<Record<keyof BunAnsiSemanticPaletteHex, string>>,
  callbacksInvoked: Set<string>,
): string {
  const useColor = theme.colors
  const reset = useColor ? "\u001b[0m" : ""
  const boldOn = useColor ? "\u001b[1m" : ""
  const boldOff = useColor ? "\u001b[22m" : ""
  const dimOn = useColor ? "\u001b[2m" : ""
  const italicOn = useColor ? "\u001b[3m" : ""
  const italicOff = useColor ? "\u001b[23m" : ""
  const strikeOn = useColor ? "\u001b[9m" : ""
  const strikeOff = useColor ? "\u001b[29m" : ""
  const cols = Math.max(24, Math.min(200, Math.floor(theme.columns || 76)))

  const hColor =
    mode === "ansi-theme"
      ? useColor
        ? theme.light
          ? "\u001b[1;34m"
          : "\u001b[1;35m"
        : ""
      : `${boldOn}${paletteAnsi.heading}`
  const codeDefault =
    mode === "ansi-theme"
      ? useColor
        ? theme.light
          ? "\u001b[48;5;254m\u001b[38;5;124m"
          : "\u001b[48;5;236m\u001b[38;5;215m"
        : ""
      : paletteAnsi.code
  const linkColor = mode === "ansi-theme" ? (useColor ? "\u001b[34m" : "") : paletteAnsi.link

  const formatInline = (raw: string): string => {
    let s = stripTerminalControls(raw)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
      callbacksInvoked.add("link")
      return buildOsc8Link(label, href, useColor && theme.hyperlinks, linkColor, reset)
    })
    s = s.replace(/`([^`]+)`/g, (_m, code: string) => {
      callbacksInvoked.add("codespan")
      const isRedacted = code.startsWith("[REDACTED")
      const tint = isRedacted && mode === "render-callbacks" ? paletteAnsi.redacted : codeDefault
      return `${tint}${code}${reset}`
    })
    s = s.replace(/\*\*([^*]+)\*\*/g, (_m, inner: string) => {
      callbacksInvoked.add("strong")
      return mode === "render-callbacks"
        ? `${boldOn}${paletteAnsi.key}${inner}${reset}`
        : `${boldOn}${inner}${boldOff}`
    })
    s = s.replace(/~~([^~]+)~~/g, (_m, inner: string) => {
      callbacksInvoked.add("strikethrough")
      return `${strikeOn}${inner}${strikeOff}`
    })
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, (_m, prefix: string, inner: string) => {
      callbacksInvoked.add("emphasis")
      return `${prefix}${italicOn}${inner}${italicOff}`
    })
    return s
  }

  let inFence = false
  const lines: string[] = []
  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith("```")) {
      inFence = !inFence
      callbacksInvoked.add("code")
      continue
    }
    if (inFence) {
      lines.push(`${dimOn}${stripTerminalControls(rawLine)}${reset}`)
      continue
    }
    if (/^(?:---+|\*\*\*+|___+)$/.test(trimmed)) {
      callbacksInvoked.add("hr")
      lines.push(`${dimOn}${"─".repeat(Math.min(cols, 56))}${reset}`)
      continue
    }
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(rawLine)
    if (headingMatch) {
      callbacksInvoked.add("heading")
      const level = headingMatch[1]!.length
      const body = formatInline(headingMatch[2] ?? "")
      if (mode === "ansi-theme" && level === 1) {
        lines.push(`${hColor}${body}${reset}`)
        lines.push(
          `${dimOn}${"═".repeat(Math.min(cols, Math.max(8, bunStringWidth(body))))}${reset}`,
        )
      } else {
        const prefix = level > 1 ? `${"#".repeat(level)} ` : ""
        lines.push(`${hColor}${prefix}${body}${reset}`)
      }
      continue
    }
    const quoteMatch = /^>\s?(.*)$/.exec(rawLine)
    if (quoteMatch) {
      callbacksInvoked.add("blockquote")
      const bar = useColor ? `${paletteAnsi.quote}│ ${reset}` : "| "
      lines.push(`${bar}${formatInline(quoteMatch[1] ?? "")}`)
      continue
    }
    const listMatch = /^(\s*[-*+]|\s*\d+\.)\s+(.*)$/.exec(rawLine)
    if (listMatch) {
      callbacksInvoked.add("listItem")
      const marker = listMatch[1]!.trim()
      const bullet = /^\d+\./.test(marker)
        ? `${paletteAnsi.key}${marker}${reset}`
        : `${paletteAnsi.ok}•${reset}`
      lines.push(`  ${bullet} ${formatInline(listMatch[2] ?? "")}`)
      continue
    }
    if (trimmed === "") {
      lines.push("")
      continue
    }
    callbacksInvoked.add("paragraph")
    lines.push(wrapTextToColumns(formatInline(rawLine), cols))
  }
  return `${lines.join("\n").trimEnd()}\n`
}

function fallbackMarkdownToSafeHtml(markdown: string): string {
  const escaped = bunEscapeHtml(stripTerminalControls(markdown))
  return `<pre>${escaped}</pre>`
}

/**
 * Evaluates Markdown through `Bun.markdown.render(md, callbacks)`,
 * `Bun.markdown.ansi(md, AnsiTheme)`, or `Bun.markdown.html(md)` natively under
 * Bun 1.4+, with a faithful, control-char-safe cross-runtime fallback for
 * browser and Node.js contexts.
 */
export function renderBunMarkdownStudio(
  markdown: string,
  options: BunMarkdownStudioOptions = {},
): BunMarkdownStudioResult {
  const mode: BunMarkdownRenderMode = options.mode ?? "render-callbacks"
  const preset =
    BUN_ANSI_THEME_PRESETS.find((p) => p.id === options.presetId) ?? BUN_ANSI_THEME_PRESETS[0]!
  const ansiTheme: BunAnsiThemeConfig = {
    colors: options.theme?.colors ?? preset.defaultTheme.colors,
    columns: Math.max(
      24,
      Math.min(200, Math.floor(options.theme?.columns ?? preset.defaultTheme.columns)),
    ),
    hyperlinks: options.theme?.hyperlinks ?? preset.defaultTheme.hyperlinks,
    light: options.theme?.light ?? preset.defaultTheme.light,
    kittyGraphics: options.theme?.kittyGraphics ?? preset.defaultTheme.kittyGraphics,
  }
  const resolvedPaletteAnsi = resolveSemanticPaletteAnsi(preset.paletteHex, ansiTheme.colors)
  const cleanSource = stripTerminalControls(markdown.replace(/\r\n?/g, "\n"))
  const callbacksInvoked = new Set<string>()

  const bunMd = (
    (globalThis as Record<string, unknown>).Bun as
      | {
          readonly markdown?: {
            readonly html?: (input: string, opts?: Record<string, unknown>) => string
            readonly ansi?: (input: string, theme?: BunAnsiThemeConfig) => string
            readonly render?: (
              input: string,
              callbacks: Record<string, (...args: unknown[]) => string>,
              opts?: Record<string, unknown>,
            ) => string
          }
        }
      | undefined
  )?.markdown

  let engine: "bun-native" | "ts-fallback" = "ts-fallback"
  let ansi = ""
  let html = ""

  if (typeof bunMd?.html === "function") {
    try {
      html = bunMd.html(cleanSource, {
        tables: true,
        strikethrough: true,
        tasklists: true,
        autolinks: true,
        tagFilter: true,
        noHtmlBlocks: true,
        noHtmlSpans: true,
      })
      if (mode === "html") engine = "bun-native"
    } catch {
      html = fallbackMarkdownToSafeHtml(cleanSource)
    }
  } else {
    html = fallbackMarkdownToSafeHtml(cleanSource)
  }

  if (mode === "ansi-theme" && typeof bunMd?.ansi === "function") {
    try {
      const rawAnsi = bunMd.ansi(cleanSource, ansiTheme)
      // Sanitize any OSC-8 hyperlink emitted by Bun.markdown.ansi
      ansi = rawAnsi.replace(/\u001b\]8;;([^\u001b]*)\u001b\\/g, (seq, href: string) =>
        href === "" || validateSafeStudioHref(href) !== null ? seq : "",
      )
      engine = "bun-native"
      callbacksInvoked.add("Bun.markdown.ansi(AnsiTheme)")
    } catch {
      ansi = fallbackMarkdownRenderToAnsi(
        cleanSource,
        "ansi-theme",
        ansiTheme,
        resolvedPaletteAnsi,
        callbacksInvoked,
      )
    }
  } else if (mode === "render-callbacks" && typeof bunMd?.render === "function") {
    try {
      const reset = ansiTheme.colors ? "\u001b[0m" : ""
      const bold = ansiTheme.colors ? "\u001b[1m" : ""
      const dim = ansiTheme.colors ? "\u001b[2m" : ""
      const italic = ansiTheme.colors ? "\u001b[3m" : ""
      const italicOff = ansiTheme.colors ? "\u001b[23m" : ""
      const strike = ansiTheme.colors ? "\u001b[9m" : ""
      const strikeOff = ansiTheme.colors ? "\u001b[29m" : ""
      const cols = ansiTheme.columns

      ansi = bunMd.render(
        cleanSource,
        {
          text: (t: unknown) => {
            callbacksInvoked.add("text")
            return stripTerminalControls(String(t ?? ""))
          },
          html: (h: unknown) => {
            callbacksInvoked.add("html")
            return stripTerminalControls(String(h ?? ""))
          },
          heading: (children: unknown, meta?: unknown) => {
            callbacksInvoked.add("heading")
            const level =
              meta && typeof meta === "object" && "level" in meta
                ? Number((meta as { level?: unknown }).level ?? 1)
                : 1
            const prefix = level > 1 ? `${"#".repeat(level)} ` : ""
            const line = wrapTextToColumns(`${prefix}${String(children ?? "")}`, cols)
            return `${bold}${resolvedPaletteAnsi.heading}${line}${reset}\n`
          },
          paragraph: (children: unknown) => {
            callbacksInvoked.add("paragraph")
            return `${wrapTextToColumns(String(children ?? ""), cols)}\n\n`
          },
          strong: (children: unknown) => {
            callbacksInvoked.add("strong")
            return `${bold}${resolvedPaletteAnsi.key}${String(children ?? "")}${reset}`
          },
          emphasis: (children: unknown) => {
            callbacksInvoked.add("emphasis")
            return `${italic}${String(children ?? "")}${italicOff}`
          },
          strikethrough: (children: unknown) => {
            callbacksInvoked.add("strikethrough")
            return `${strike}${String(children ?? "")}${strikeOff}`
          },
          codespan: (children: unknown) => {
            callbacksInvoked.add("codespan")
            const clean = stripTerminalControls(String(children ?? ""))
            const color = clean.startsWith("[REDACTED")
              ? resolvedPaletteAnsi.redacted
              : resolvedPaletteAnsi.code
            return `${color}${clean}${reset}`
          },
          code: (children: unknown) => {
            callbacksInvoked.add("code")
            return `${dim}${stripTerminalControls(String(children ?? ""))}${reset}\n`
          },
          blockquote: (children: unknown) => {
            callbacksInvoked.add("blockquote")
            const body = String(children ?? "").trimEnd()
            const prefix = ansiTheme.colors ? `${resolvedPaletteAnsi.quote}│ ${reset}` : "| "
            return `${body
              .split("\n")
              .map((l) => `${prefix}${l}`)
              .join("\n")}\n\n`
          },
          list: (children: unknown) => {
            callbacksInvoked.add("list")
            return `${String(children ?? "")}\n`
          },
          listItem: (children: unknown, meta?: unknown) => {
            callbacksInvoked.add("listItem")
            const m = (meta ?? {}) as { ordered?: boolean; index?: number; start?: number }
            const bullet = m.ordered
              ? `${resolvedPaletteAnsi.key}${(m.start ?? 1) + (m.index ?? 0)}.${reset}`
              : `${resolvedPaletteAnsi.ok}•${reset}`
            return `  ${bullet} ${String(children ?? "").trimEnd()}\n`
          },
          hr: () => {
            callbacksInvoked.add("hr")
            return `${dim}${"─".repeat(Math.min(cols, 56))}${reset}\n`
          },
          link: (children: unknown, meta?: unknown) => {
            callbacksInvoked.add("link")
            const href =
              meta && typeof meta === "object" && "href" in meta
                ? String((meta as { href?: unknown }).href ?? "")
                : ""
            return buildOsc8Link(
              String(children ?? ""),
              href,
              ansiTheme.colors && ansiTheme.hyperlinks,
              resolvedPaletteAnsi.link,
              reset,
            )
          },
          image: (alt: unknown) => {
            callbacksInvoked.add("image")
            return stripTerminalControls(String(alt ?? ""))
          },
        },
        { tables: true, strikethrough: true, tasklists: true, autolinks: true },
      )
      engine = "bun-native"
    } catch {
      ansi = fallbackMarkdownRenderToAnsi(
        cleanSource,
        "render-callbacks",
        ansiTheme,
        resolvedPaletteAnsi,
        callbacksInvoked,
      )
    }
  } else if (mode === "html") {
    ansi = html
    callbacksInvoked.add("Bun.markdown.html")
  } else {
    ansi = fallbackMarkdownRenderToAnsi(
      cleanSource,
      mode,
      ansiTheme,
      resolvedPaletteAnsi,
      callbacksInvoked,
    )
  }

  const plain = bunStripAnsi(ansi)
  const splitLines = plain.replace(/\n$/, "").split("\n")
  let maxColumns = 0
  for (const line of splitLines) {
    const w = bunStringWidth(line)
    if (w > maxColumns) maxColumns = w
  }

  return {
    engine,
    mode,
    presetId: preset.id,
    ansiTheme,
    paletteHex: preset.paletteHex,
    resolvedPaletteAnsi,
    ansi,
    plain,
    html,
    lineCount: plain.trim().length === 0 ? 0 : splitLines.length,
    maxColumns,
    ansiByteLength: new TextEncoder().encode(ansi).length,
    callbacksInvoked: Array.from(callbacksInvoked),
  }
}
