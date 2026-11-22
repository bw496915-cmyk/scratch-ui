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

import {
  bunColorCss,
  bunEscapeHtml,
  bunStringWidth,
  bunStripAnsi,
} from "./bun_syntax_highlight.ts";

export type GlobalTierId = "bun-specific" | "node-compat" | "web-standards";

export interface RuntimeGlobalTierSpec {
  readonly id: GlobalTierId;
  readonly label: string;
  readonly globals: readonly string[];
  readonly notes: string;
}

export type BunUtilityCategoryId =
  | "timing-memory"
  | "paths-inspection"
  | "strings-terminal"
  | "compression-buffers";

export interface BunUtilitySpec {
  readonly id: string;
  readonly category: BunUtilityCategoryId;
  readonly categoryLabel: string;
  readonly signature: string;
  readonly purpose: string;
  readonly runtimeNotes?: string | undefined;
  /** Property names on `Bun` to probe for live availability. */
  readonly probeKeys: readonly string[];
}

export type BunCoreApiDomainId =
  | "http-networking"
  | "file-object-io"
  | "databases-caches"
  | "parsers-formats"
  | "subprocesses-shell"
  | "crypto-hashing"
  | "build-ffi-ui";

export interface BunCoreApiDomainSpec {
  readonly id: BunCoreApiDomainId;
  readonly domain: string;
  readonly apis: readonly string[];
  readonly capabilities: string;
  /** Property names on `Bun` (without `Bun.` prefix) to probe for live availability. */
  readonly probeBunKeys: readonly string[];
  /** Built-in `bun:*` module specifiers belonging to this domain. */
  readonly builtinModules: readonly string[];
}

export interface BunNamespaceExportEntry {
  readonly key: string;
  readonly type: string;
}

export interface LiveGlobalProbeEntry {
  readonly name: string;
  readonly tier: GlobalTierId;
  readonly present: boolean;
  readonly valueType: string;
}

export interface LiveUtilityProbeEntry {
  readonly id: string;
  readonly signature: string;
  readonly category: BunUtilityCategoryId;
  readonly available: boolean;
  readonly matchedKeys: readonly string[];
}

export interface LiveCoreApiDomainProbeEntry {
  readonly id: BunCoreApiDomainId;
  readonly domain: string;
  readonly availableCount: number;
  readonly totalProbed: number;
  readonly availableKeys: readonly string[];
  readonly missingKeys: readonly string[];
}

export interface BunRuntimeSurfaceAuditSnapshot {
  /** Whether the snapshot was gathered directly from a live Bun runtime, via the installed Bun binary, or Node/browser fallback. */
  readonly source: "bun-in-process" | "bun-binary-probe" | "node-fallback" | "browser-fallback";
  readonly hostRuntime: string;
  readonly bunDetected: boolean;
  readonly bunVersion: string | null;
  readonly bunRevision: string | null;
  readonly bunRevisionShort: string | null;
  readonly isMainThread: boolean | null;
  readonly processEnvEqualsBunEnv: boolean | null;
  readonly memoryPressureSupported: boolean;
  readonly exportCount: number;
  readonly exports: readonly BunNamespaceExportEntry[];
  readonly exportTypeCounts: Readonly<Record<string, number>>;
  readonly inspectTableText: string;
  readonly globalProbes: readonly LiveGlobalProbeEntry[];
  readonly utilityProbes: readonly LiveUtilityProbeEntry[];
  readonly coreDomainProbes: readonly LiveCoreApiDomainProbeEntry[];
  readonly auditedAt: string;
  readonly auditDurationMs: number;
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
];

export const BUN_UTILITY_CATEGORIES: readonly {
  readonly id: BunUtilityCategoryId;
  readonly label: string;
}[] = [
  { id: "timing-memory", label: "Timing, Memory & Runtime Control" },
  { id: "paths-inspection", label: "Paths, Inspection & Comparison" },
  { id: "strings-terminal", label: "Strings, Terminal & IDs" },
  { id: "compression-buffers", label: "Compression & Buffer/Stream Conversion" },
];

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
    probeKeys: [
      "zstdCompress",
      "zstdDecompress",
      "zstdCompressSync",
      "zstdDecompressSync",
    ],
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
];

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
    apis: ["Bun.file()", "Bun.write()", "Bun.s3 / S3Client", "Bun.Glob", "Bun.Archive"],
    capabilities:
      "Lazy BunFile / S3File handles (s3:// URLs for R2/S3); sendfile/copy_file_range zero-copy writes; native globbing and tar/archive handling",
    probeBunKeys: ["file", "write", "s3", "S3Client", "Glob", "Archive"],
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
      "Bun.JSONL",
      "Bun.Markdown",
      "Bun.semver",
    ],
    capabilities:
      "Native Zig/C parsers (strict YAML 1.2 & TOML in v1.4+); Bun.Markdown renders to HTML, React, or custom terminal callbacks",
    probeBunKeys: ["YAML", "TOML", "XML", "JSON5", "JSONL", "Markdown", "semver"],
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
      "bun:test",
      "Bun.Image",
      "Bun.WebView",
    ],
    capabilities:
      "Programmatic bundler & --compile, runtime loader plugins, C/Zig FFI (dlopen), built-in test runner, native image & webview APIs (v1.4+)",
    probeBunKeys: ["build", "Transpiler", "plugin", "Image", "WebView"],
    builtinModules: ["bun:ffi", "bun:test"],
  },
];

/** Section 4: Exact Live Surface Audit Snippet for inspecting installed Bun binary exports. */
export const LIVE_SURFACE_AUDIT_SNIPPET = `const bunKeys = Object.getOwnPropertyNames(Bun)
  .map((key) => ({
    key,
    type: typeof (Bun as Record<string, unknown>)[key],
  }))
  .sort((a, b) => a.key.localeCompare(b.key));

console.log(\`Bun \${Bun.version} (\${Bun.revision.slice(0, 8)}) — \${bunKeys.length} exports\`);
console.log(Bun.inspect.table(bunKeys, ["key", "type"]));`;

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
          ) => string;
        };
      }
    | undefined;

  if (bunObj?.inspect && typeof bunObj.inspect.table === "function") {
    try {
      const cols = columns ? [...columns] : undefined;
      return bunObj.inspect.table(rows, cols, { colors: false }).trimEnd();
    } catch {
      // Fall through to pure-TS box renderer
    }
  }

  const recordRows = rows as readonly Readonly<Record<string, unknown>>[];
  const cols =
    columns && columns.length > 0
      ? [...columns]
      : Array.from(
          recordRows.reduce<Set<string>>((acc, row) => {
            for (const k of Object.keys(row)) acc.add(k);
            return acc;
          }, new Set<string>()),
        );

  if (cols.length === 0) {
    return "┌───┐\n│   │\n└───┘";
  }

  const allCols = ["", ...cols];
  const cellRows: string[][] = recordRows.map((row, idx) => [
    String(idx),
    ...cols.map((col) => {
      const val = row[col];
      if (val === null) return "null";
      if (val === undefined) return "";
      return typeof val === "string" ? val : String(val);
    }),
  ]);

  const widths = allCols.map((header, colIdx) => {
    let maxW = bunStringWidth(header);
    for (const r of cellRows) {
      const w = bunStringWidth(r[colIdx] ?? "");
      if (w > maxW) maxW = w;
    }
    return Math.max(1, maxW);
  });

  const pad = (val: string, width: number, rightAlign = false): string => {
    const w = bunStringWidth(val);
    const diff = Math.max(0, width - w);
    return rightAlign ? `${" ".repeat(diff)}${val}` : `${val}${" ".repeat(diff)}`;
  };

  const makeBorder = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`;

  const lines: string[] = [];
  lines.push(makeBorder("┌", "┬", "┐"));
  lines.push(
    `│ ${allCols.map((h, i) => pad(h, widths[i]!)).join(" │ ")} │`,
  );
  lines.push(makeBorder("├", "┼", "┤"));
  for (const r of cellRows) {
    lines.push(
      `│ ${r.map((cell, i) => pad(cell, widths[i]!, i === 0)).join(" │ ")} │`,
    );
  }
  lines.push(makeBorder("└", "┴", "┘"));
  return lines.join("\n");
}

function resolveHostRuntimeLabel(): string {
  const g = globalThis as Record<string, unknown>;
  const bunObj = g.Bun as { readonly version?: unknown } | undefined;
  if (bunObj && typeof bunObj === "object" && typeof bunObj.version === "string") {
    return `bun/${bunObj.version}`;
  }
  const proc = g.process as { readonly versions?: { readonly node?: string } } | undefined;
  if (proc?.versions?.node) {
    return `node/${proc.versions.node}`;
  }
  return "browser";
}

function buildGlobalProbes(scope: Record<string, unknown>): readonly LiveGlobalProbeEntry[] {
  const results: LiveGlobalProbeEntry[] = [];
  for (const tier of BUN_GLOBAL_TIERS) {
    for (const name of tier.globals) {
      let present = false;
      let valueType = "undefined";
      if (name === "__dirname" || name === "__filename" || name === "require") {
        // CommonJS module-scoped bindings: probe on globalThis safely without throwing
        const val = scope[name];
        present = val !== undefined;
        valueType = typeof val;
      } else {
        try {
          const val = scope[name];
          present = val !== undefined;
          valueType = typeof val;
        } catch {
          present = false;
          valueType = "inaccessible";
        }
      }
      results.push({
        name,
        tier: tier.id,
        present,
        valueType,
      });
    }
  }
  return results;
}

function buildUtilityProbes(
  bunExportSet: ReadonlySet<string>,
): readonly LiveUtilityProbeEntry[] {
  return BUN_UTILITIES_CATALOG.map((spec) => {
    const matchedKeys = spec.probeKeys.filter((k) => bunExportSet.has(k));
    return {
      id: spec.id,
      signature: spec.signature,
      category: spec.category,
      available: matchedKeys.length > 0,
      matchedKeys,
    };
  });
}

function buildCoreDomainProbes(
  bunExportSet: ReadonlySet<string>,
): readonly LiveCoreApiDomainProbeEntry[] {
  return BUN_CORE_API_DOMAINS.map((spec) => {
    const availableKeys = spec.probeBunKeys.filter((k) => bunExportSet.has(k));
    const missingKeys = spec.probeBunKeys.filter((k) => !bunExportSet.has(k));
    return {
      id: spec.id,
      domain: spec.domain,
      availableCount: availableKeys.length,
      totalProbed: spec.probeBunKeys.length,
      availableKeys,
      missingKeys,
    };
  });
}

/**
 * Executes a read-only Live Surface Audit against the current JS runtime
 * (`globalThis` and `globalThis.Bun`). Never accesses secret values.
 */
export function runBunSurfaceAudit(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): BunRuntimeSurfaceAuditSnapshot {
  const startedMs = performance.now();
  const bunRaw = scope.Bun;
  const bunObj =
    bunRaw && typeof bunRaw === "object" ? (bunRaw as Record<string, unknown>) : null;

  const exportsList: BunNamespaceExportEntry[] = bunObj
    ? Object.getOwnPropertyNames(bunObj)
        .map((key) => {
          let valueType = "unknown";
          try {
            valueType = typeof bunObj[key];
          } catch {
            valueType = "getter";
          }
          return { key, type: valueType };
        })
        .sort((a, b) => a.key.localeCompare(b.key))
    : [];

  const exportTypeCounts: Record<string, number> = {};
  for (const item of exportsList) {
    exportTypeCounts[item.type] = (exportTypeCounts[item.type] ?? 0) + 1;
  }

  const bunExportSet = new Set(exportsList.map((e) => e.key));
  const bunVersion =
    bunObj && typeof bunObj.version === "string" ? bunObj.version : null;
  const bunRevision =
    bunObj && typeof bunObj.revision === "string" ? bunObj.revision : null;
  const isMainThread =
    bunObj && typeof bunObj.isMainThread === "boolean" ? bunObj.isMainThread : null;

  const proc = scope.process as
    | { readonly env?: unknown; readonly on?: unknown; readonly versions?: { readonly node?: string } }
    | undefined;
  const processEnvEqualsBunEnv =
    bunObj && proc && typeof proc === "object" ? proc.env === bunObj.env : null;
  const memoryPressureSupported = Boolean(bunObj && typeof proc?.on === "function");

  const source: BunRuntimeSurfaceAuditSnapshot["source"] = bunObj
    ? "bun-in-process"
    : proc?.versions?.node
      ? "node-fallback"
      : "browser-fallback";

  const headerLine =
    bunObj && bunVersion
      ? `Bun ${bunVersion} (${(bunRevision ?? "").slice(0, 8)}) — ${exportsList.length} exports`
      : `${resolveHostRuntimeLabel()} — Bun namespace not active in host process`;

  const inspectTableText =
    exportsList.length > 0
      ? `${headerLine}\n${formatInspectTable(exportsList, ["key", "type"])}`
      : headerLine;

  return {
    source,
    hostRuntime: resolveHostRuntimeLabel(),
    bunDetected: Boolean(bunObj),
    bunVersion,
    bunRevision,
    bunRevisionShort: bunRevision ? bunRevision.slice(0, 8) : null,
    isMainThread,
    processEnvEqualsBunEnv,
    memoryPressureSupported,
    exportCount: exportsList.length,
    exports: exportsList,
    exportTypeCounts,
    inspectTableText,
    globalProbes: buildGlobalProbes(scope),
    utilityProbes: buildUtilityProbes(bunExportSet),
    coreDomainProbes: buildCoreDomainProbes(bunExportSet),
    auditedAt: new Date().toISOString(),
    auditDurationMs: Math.max(0, Number((performance.now() - startedMs).toFixed(2))),
  };
}

/**
 * Hydrates a `BunRuntimeSurfaceAuditSnapshot` from raw Bun binary probe JSON
 * (used when the Express server runs under Node.js and invokes the installed
 * `bun` binary read-only with a scrubbed environment).
 */
export function buildAuditSnapshotFromBinaryProbe(
  probe: {
    readonly bunVersion: string;
    readonly bunRevision: string;
    readonly isMainThread: boolean;
    readonly processEnvEqualsBunEnv: boolean;
    readonly exports: readonly BunNamespaceExportEntry[];
    readonly globalProbes?: readonly LiveGlobalProbeEntry[] | undefined;
    readonly inspectTableText?: string | undefined;
  },
  durationMs: number,
): BunRuntimeSurfaceAuditSnapshot {
  const sortedExports = [...probe.exports].sort((a, b) => a.key.localeCompare(b.key));
  const exportTypeCounts: Record<string, number> = {};
  for (const item of sortedExports) {
    exportTypeCounts[item.type] = (exportTypeCounts[item.type] ?? 0) + 1;
  }
  const bunExportSet = new Set(sortedExports.map((e) => e.key));
  const headerLine = `Bun ${probe.bunVersion} (${probe.bunRevision.slice(0, 8)}) — ${sortedExports.length} exports`;
  const tableText =
    probe.inspectTableText && probe.inspectTableText.trim().length > 0
      ? `${headerLine}\n${probe.inspectTableText.trimEnd()}`
      : `${headerLine}\n${formatInspectTable(sortedExports, ["key", "type"])}`;

  return {
    source: "bun-binary-probe",
    hostRuntime: resolveHostRuntimeLabel(),
    bunDetected: true,
    bunVersion: probe.bunVersion,
    bunRevision: probe.bunRevision,
    bunRevisionShort: probe.bunRevision.slice(0, 8),
    isMainThread: probe.isMainThread,
    processEnvEqualsBunEnv: probe.processEnvEqualsBunEnv,
    memoryPressureSupported: true,
    exportCount: sortedExports.length,
    exports: sortedExports,
    exportTypeCounts,
    inspectTableText: tableText,
    globalProbes:
      probe.globalProbes && probe.globalProbes.length > 0
        ? probe.globalProbes
        : buildGlobalProbes(globalThis as unknown as Record<string, unknown>),
    utilityProbes: buildUtilityProbes(bunExportSet),
    coreDomainProbes: buildCoreDomainProbes(bunExportSet),
    auditedAt: new Date().toISOString(),
    auditDurationMs: Math.max(0, Number(durationMs.toFixed(2))),
  };
}

// ── Cross-Runtime Interactive Utility Helpers (for the Live Utility Sandbox) ──

/**
 * Generates an RFC 9562 time-ordered UUIDv7.
 * Delegates to native `Bun.randomUUIDv7()` when running under Bun, and uses
 * a cryptographically random RFC 9562 v7 implementation in browser/Node.
 */
export function generateBunUuidV7(timestampMs: number = Date.now()): string {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    | { readonly randomUUIDv7?: (encoding?: "hex", timestamp?: number) => string }
    | undefined;
  if (bunObj && typeof bunObj.randomUUIDv7 === "function") {
    try {
      return bunObj.randomUUIDv7("hex", timestampMs);
    } catch {
      // Fallback below
    }
  }

  const bytes = new Uint8Array(16);
  const ts = BigInt(Math.max(0, Math.floor(timestampMs)));
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  const rand = new Uint8Array(10);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(rand);
  } else {
    for (let i = 0; i < rand.length; i += 1) {
      rand[i] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = 0x70 | (rand[0]! & 0x0f); // version 7
  bytes[7] = rand[1]!;
  bytes[8] = 0x80 | (rand[2]! & 0x3f); // RFC 4122/9562 variant 10
  for (let i = 0; i < 7; i += 1) {
    bytes[9 + i] = rand[3 + i]!;
  }

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Extracts the embedded 48-bit Unix millisecond timestamp from a UUIDv7 string.
 */
export function decodeUuidV7TimestampIso(uuid: string): string | null {
  const clean = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) return null;
  if (clean[12] !== "7") return null;
  const ms = Number.parseInt(clean.slice(0, 12), 16);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Structural deep equality matching `Bun.deepEquals(a, b, strict?)`.
 */
export function bunDeepEquals(a: unknown, b: unknown, strict = false): boolean {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    | { readonly deepEquals?: (x: unknown, y: unknown, strict?: boolean) => boolean }
    | undefined;
  if (bunObj && typeof bunObj.deepEquals === "function") {
    try {
      return bunObj.deepEquals(a, b, strict);
    } catch {
      // Fall through to pure-TS structural equality
    }
  }

  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (strict && (i in a) !== (i in b)) return false;
      if (!bunDeepEquals(a[i], b[i], strict)) return false;
    }
    return true;
  }

  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => strict || objA[k] !== undefined);
  const keysB = Object.keys(objB).filter((k) => strict || objB[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, key) && (strict || objA[key] !== undefined)) {
      return false;
    }
    if (!bunDeepEquals(objA[key], objB[key], strict)) return false;
  }
  return true;
}

export interface BunStringUtilityProbeResult {
  readonly rawLength: number;
  readonly stripped: string;
  readonly displayWidth: number;
  readonly escapedHtml: string;
}

export function evaluateBunStringUtilities(input: string): BunStringUtilityProbeResult {
  return {
    rawLength: input.length,
    stripped: bunStripAnsi(input),
    displayWidth: bunStringWidth(input),
    escapedHtml: bunEscapeHtml(input),
  };
}

export interface BunColorConversionResult {
  readonly valid: boolean;
  readonly input: string;
  readonly hex: string | null;
  readonly rgb: string | null;
  readonly rgba: string | null;
  readonly number: number | null;
  readonly ansi16m: string | null;
}

/**
 * Parses hex (`#rgb`, `#rrggbb`) or `rgb(r, g, b)` inputs into Bun.color formats.
 */
export function evaluateBunColorConversions(input: string): BunColorConversionResult {
  const trimmed = input.trim();
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    | { readonly color?: (val: string, format: string) => string | number | null }
    | undefined;

  if (bunObj && typeof bunObj.color === "function") {
    try {
      const hex = bunObj.color(trimmed, "hex");
      if (typeof hex === "string") {
        const rgb = bunObj.color(trimmed, "rgb");
        const rgba = bunObj.color(trimmed, "rgba");
        const num = bunObj.color(trimmed, "number");
        const ansi16m = bunObj.color(trimmed, "ansi-16m");
        return {
          valid: true,
          input: trimmed,
          hex,
          rgb: typeof rgb === "string" ? rgb : null,
          rgba: typeof rgba === "string" ? rgba : null,
          number: typeof num === "number" ? num : null,
          ansi16m: typeof ansi16m === "string" ? ansi16m : null,
        };
      }
    } catch {
      // Fall through to pure-TS converter
    }
  }

  let r: number | null = null;
  let g: number | null = null;
  let b: number | null = null;

  const shortHex = /^#([0-9a-f]{3})$/i.exec(trimmed);
  const fullHex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  const rgbMatch = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*[0-9.]+)?\s*\)$/i.exec(
    trimmed,
  );

  if (shortHex?.[1]) {
    r = Number.parseInt(shortHex[1][0]! + shortHex[1][0]!, 16);
    g = Number.parseInt(shortHex[1][1]! + shortHex[1][1]!, 16);
    b = Number.parseInt(shortHex[1][2]! + shortHex[1][2]!, 16);
  } else if (fullHex?.[1]) {
    r = Number.parseInt(fullHex[1].slice(0, 2), 16);
    g = Number.parseInt(fullHex[1].slice(2, 4), 16);
    b = Number.parseInt(fullHex[1].slice(4, 6), 16);
  } else if (rgbMatch) {
    r = Math.min(255, Number.parseInt(rgbMatch[1]!, 10));
    g = Math.min(255, Number.parseInt(rgbMatch[2]!, 10));
    b = Math.min(255, Number.parseInt(rgbMatch[3]!, 10));
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
    };
  }

  const hex = bunColorCss(
    `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
  );
  return {
    valid: true,
    input: trimmed,
    hex,
    rgb: `rgb(${r}, ${g}, ${b})`,
    rgba: `rgba(${r}, ${g}, ${b}, 1)`,
    number: (r << 16) | (g << 8) | b,
    ansi16m: `\u001b[38;2;${r};${g};${b}m`,
  };
}
