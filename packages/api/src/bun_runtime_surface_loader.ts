/**
 * @file packages/api/src/bun_runtime_surface_loader.ts
 * @description Server-side read-only Bun Runtime Surface Audit loader.
 *
 * - Under Bun: executes `runBunSurfaceAudit()` directly in-process and resolves
 *   built-in `bun:*` modules (`bun:sqlite`, `bun:ffi`, `bun:jsc`, `bun:test`,
 *   `bun:bundle`) via dynamic `createRequire(import.meta.url)` so bundlers do
 *   not try to statically bundle Bun-only specifiers for Node builds.
 * - Under Node.js (`tsx server.ts`): probes the installed `bun` binary using
 *   a fixed, read-only `execFileSync("bun", ["-e", ...])` call with a scrubbed
 *   environment (no shell, no user input, no secrets forwarded), falling back
 *   cleanly to `runBunSurfaceAudit()` if `bun` is not installed on PATH.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

import type {
  BunFileLoaderLiveProbe,
  BunFileSampleAssetProbe,
} from "../../contracts/src/bun_file_loader.ts"
import {
  buildAuditSnapshotFromBinaryProbe,
  BUN_BUILTIN_MODULE_TARGETS,
  BUN_DEEP_CLASS_TARGETS,
  BUN_DEEP_NAMESPACE_TARGETS,
  BUN_GLOBAL_TIERS,
  type BunDeepInspectionEntry,
  type BunExportKind,
  type BunNamespaceExportEntry,
  type BunRuntimeSurfaceAuditSnapshot,
  type LiveGlobalProbeEntry,
  runBunSurfaceAudit,
} from "../../contracts/src/bun_runtime_surface.ts"

const SAMPLE_WORKSPACE_ASSET_CANDIDATES = [
  "public/assets/branding/sportsdesk-emblem-64.png",
  "packages/ui/src/logo.svg",
] as const

const CACHE_TTL_MS = 60_000

let cachedBinaryAudit: {
  readonly expiresAt: number
  readonly snapshot: BunRuntimeSurfaceAuditSnapshot
} | null = null

const SERIALIZED_TIERS = JSON.stringify(
  BUN_GLOBAL_TIERS.map((t) => ({ id: t.id, globals: t.globals })),
)
const SERIALIZED_NAMESPACE_TARGETS = JSON.stringify(BUN_DEEP_NAMESPACE_TARGETS)
const SERIALIZED_CLASS_TARGETS = JSON.stringify(BUN_DEEP_CLASS_TARGETS)
const SERIALIZED_MODULE_TARGETS = JSON.stringify(BUN_BUILTIN_MODULE_TARGETS)

/**
 * Fixed, hardcoded read-only probe script matching the Bun Runtime Surface
 * Audit specification + deep module/namespace/class/constant introspection.
 * Never reads or prints `Bun.env`, `process.env`, or `Bun.secrets` values.
 */
const FIXED_BUN_BINARY_PROBE_SCRIPT = `
const tiers = ${SERIALIZED_TIERS};
const nsTargets = ${SERIALIZED_NAMESPACE_TARGETS};
const clsTargets = ${SERIALIZED_CLASS_TARGETS};
const modTargets = ${SERIALIZED_MODULE_TARGETS};
const g = globalThis;
const REDACTED = new Set(["env", "secrets"]);
const SAFE_CONSTS = new Set(["version", "revision", "version_with_sha", "enableANSIColors", "isMainThread", "isStandaloneExecutable", "origin"]);
const KNOWN_CLASSES = new Set(["SQL", "ArrayBufferSink", "S3Client", "RedisClient", "CookieMap", "Cookie", "Glob", "Archive", "CryptoHasher", "Transpiler", "FileSystemRouter", "Terminal", "Image", "ModuleGraph", "WebView", "FetchSession", "Database", "Statement", "SQLiteError", "CFunction", "CString", "JSCallback"]);
const FN_IGNORED = new Set(["length", "name", "prototype", "arguments", "caller"]);

function classify(val, key) {
  if (key && REDACTED.has(key)) return "namespace";
  if (val === null) return "constant";
  const t = typeof val;
  if (t !== "object" && t !== "function") return "constant";
  if (t === "function") {
    if (key && KNOWN_CLASSES.has(key)) return "class";
    try {
      if (/^\\s*class\\b/.test(Function.prototype.toString.call(val))) return "class";
    } catch {}
    try {
      const proto = val.prototype;
      if (proto && typeof proto === "object" && Object.getOwnPropertyNames(proto).some((p) => p !== "constructor")) return "class";
    } catch {}
    return "function";
  }
  try {
    return Object.getOwnPropertyNames(val).some((k) => { try { return typeof val[k] === "function"; } catch { return false; } }) ? "namespace" : "object";
  } catch {
    return "object";
  }
}

function preview(val) {
  if (typeof val === "boolean" || typeof val === "number" || typeof val === "bigint") return String(val);
  if (typeof val === "string") {
    const c = val.replace(/[\\u0000-\\u001f\\u007f]/g, "");
    return c.length > 48 ? c.slice(0, 45) + "..." : c;
  }
  return undefined;
}

function inspectTarget(target, meta) {
  if (target === null || target === undefined || (typeof target !== "object" && typeof target !== "function")) {
    return { ...meta, available: false, memberCount: 0, classCount: 0, functionCount: 0, constantCount: 0, namespaceCount: 0, members: [] };
  }
  const members = [];
  const seen = new Set();
  const ownKeys = Object.getOwnPropertyNames(target)
    .filter((k) => k !== "__esModule" && k !== "default" && !(typeof target === "function" && FN_IGNORED.has(k)))
    .sort((a, b) => a.localeCompare(b));
  for (const name of ownKeys) {
    let val;
    let valType = "unknown";
    try { val = target[name]; valType = typeof val; } catch { valType = "getter"; }
    const kind = classify(val, name);
    const scope = meta.category === "bun-class" ? "static" : kind === "constant" ? "constant" : "export";
    const safePreview = kind === "constant" && !REDACTED.has(name) ? preview(val) : undefined;
    const dk = scope + ":" + name;
    if (!seen.has(dk)) {
      seen.add(dk);
      members.push({ name, kind, type: valType, scope, ...(safePreview !== undefined ? { safePreview } : {}) });
    }
    if ((name === "constants" || name === "FFIType") && val && typeof val === "object") {
      const subKeys = Object.getOwnPropertyNames(val).filter((sk) => !/^\\d+$/.test(sk)).sort((a, b) => a.localeCompare(b)).slice(0, 28);
      for (const sk of subKeys) {
        let sv;
        try { sv = val[sk]; } catch {}
        const sn = name + "." + sk;
        if (!seen.has("constant:" + sn)) {
          seen.add("constant:" + sn);
          const sp = preview(sv);
          members.push({ name: sn, kind: "constant", type: typeof sv, scope: "constant", ...(sp !== undefined ? { safePreview: sp } : {}) });
        }
      }
    }
  }
  if (typeof target === "function") {
    try {
      const proto = target.prototype;
      if (proto && typeof proto === "object") {
        for (const pName of Object.getOwnPropertyNames(proto).filter((k) => k !== "constructor").sort((a, b) => a.localeCompare(b))) {
          let pType = "function";
          let pKind = "function";
          try {
            const desc = Object.getOwnPropertyDescriptor(proto, pName);
            if (desc && ("get" in desc || "set" in desc) && !("value" in desc)) { pType = "accessor"; pKind = "constant"; }
            else if (desc) { pType = typeof desc.value; pKind = classify(desc.value, pName); }
          } catch { pType = "accessor"; }
          if (!seen.has("prototype:" + pName)) {
            seen.add("prototype:" + pName);
            members.push({ name: pName, kind: pKind, type: pType, scope: "prototype" });
          }
        }
      }
    } catch {}
  }
  return {
    ...meta,
    available: true,
    memberCount: members.length,
    classCount: members.filter((m) => m.kind === "class").length,
    functionCount: members.filter((m) => m.kind === "function").length,
    constantCount: members.filter((m) => m.kind === "constant").length,
    namespaceCount: members.filter((m) => m.kind === "namespace").length,
    members,
  };
}

const bunKeys = Object.getOwnPropertyNames(Bun)
  .map((key) => {
    if (REDACTED.has(key)) {
      return { key, type: "object", kind: "namespace", redacted: true, safePreview: "[REDACTED — values never serialized]" };
    }
    let val;
    let t = "unknown";
    try { val = Bun[key]; t = typeof val; } catch { t = "getter"; }
    const kind = classify(val, key);
    let memberCount;
    let staticMemberCount;
    let prototypeMethodCount;
    if (kind === "namespace" && val && typeof val === "object") {
      try { memberCount = Object.getOwnPropertyNames(val).length; } catch {}
    } else if (kind === "class" && typeof val === "function") {
      try {
        staticMemberCount = Object.getOwnPropertyNames(val).filter((k) => !FN_IGNORED.has(k)).length;
        const proto = val.prototype;
        if (proto && typeof proto === "object") {
          prototypeMethodCount = Object.getOwnPropertyNames(proto).filter((k) => k !== "constructor").length;
        }
        memberCount = (staticMemberCount || 0) + (prototypeMethodCount || 0);
      } catch {}
    }
    const safePreview = kind === "constant" && SAFE_CONSTS.has(key) ? preview(val) : undefined;
    return {
      key,
      type: t,
      kind,
      ...(memberCount !== undefined ? { memberCount } : {}),
      ...(staticMemberCount !== undefined ? { staticMemberCount } : {}),
      ...(prototypeMethodCount !== undefined ? { prototypeMethodCount } : {}),
      ...(safePreview !== undefined ? { safePreview } : {}),
    };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

const deepInspections = [];
for (const mod of modTargets) {
  let resolved;
  try { resolved = await import(mod.specifier); } catch { resolved = undefined; }
  deepInspections.push(inspectTarget(resolved, { id: mod.specifier, label: mod.specifier, category: "builtin-module", domain: mod.domain, notes: mod.notes }));
}
for (const ns of nsTargets) {
  let target;
  try { target = Bun[ns.key]; } catch { target = undefined; }
  deepInspections.push(inspectTarget(target, { id: "Bun." + ns.key, label: ns.label, category: "bun-namespace", domain: ns.domain, notes: ns.notes }));
}
for (const cls of clsTargets) {
  let target;
  try { target = Bun[cls.key]; } catch { target = undefined; }
  deepInspections.push(inspectTarget(target, { id: "Bun." + cls.key, label: cls.label, category: "bun-class", domain: cls.domain, notes: cls.notes }));
}

const globalProbes = [];
for (const tier of tiers) {
  for (const name of tier.globals) {
    let present = false;
    let valueType = "undefined";
    try {
      if (name === "__dirname") {
        present = typeof __dirname !== "undefined";
        valueType = typeof __dirname;
      } else if (name === "__filename") {
        present = typeof __filename !== "undefined";
        valueType = typeof __filename;
      } else if (name === "require") {
        present = typeof require !== "undefined";
        valueType = typeof require;
      } else {
        present = g[name] !== undefined;
        valueType = typeof g[name];
      }
    } catch {
      present = false;
      valueType = "inaccessible";
    }
    globalProbes.push({ name, tier: tier.id, present, valueType });
  }
}
const embeddedRaw = Array.isArray(Bun.embeddedFiles) ? Bun.embeddedFiles : [];
const embeddedFiles = embeddedRaw.slice(0, 24).map((f) => ({
  name: typeof f?.name === "string" ? f.name : "embedded-asset",
  type: typeof f?.type === "string" ? f.type : "application/octet-stream",
  size: typeof f?.size === "number" ? f.size : 0,
}));
let sampleAsset = null;
for (const candidate of ${JSON.stringify(SAMPLE_WORKSPACE_ASSET_CANDIDATES)}) {
  try {
    const f = Bun.file(candidate);
    if (await f.exists()) {
      let responseReady = false;
      try {
        const res = new Response(f);
        responseReady = res.body !== null;
      } catch {}
      let formDataReady = false;
      try {
        const fd = new FormData();
        fd.append("asset", f, candidate.split("/").pop() || "asset");
        formDataReady = fd.has("asset");
      } catch {}
      const unknownFallback = Bun.file("probe.unknownext123").type || "application/octet-stream";
      sampleAsset = {
        assetPath: candidate,
        instanceofBlob: f instanceof Blob,
        type: String(f.type || "application/octet-stream"),
        size: Number(f.size || 0),
        exists: true,
        sliceByteLength: Number(f.slice(0, 64).size || 0),
        streamSupported: typeof f.stream === "function",
        responseReady,
        formDataReady,
        unknownExtFallbackMime: String(unknownFallback),
      };
      break;
    }
  } catch {}
}
const fileLoaderProbe = {
  source: "bun-binary-probe",
  bunVersion: String(Bun.version ?? ""),
  bunFileAvailable: typeof Bun.file === "function",
  bunWriteAvailable: typeof Bun.write === "function",
  bunBuildAvailable: typeof Bun.build === "function",
  isStandaloneExecutable: Boolean(Bun.isStandaloneExecutable),
  embeddedFilesAvailable: Array.isArray(Bun.embeddedFiles),
  embeddedFilesCount: embeddedRaw.length,
  embeddedFiles,
  sampleAsset,
};
const inspectTableText = Bun.inspect.table(bunKeys, ["key", "kind", "type"], { colors: false });
process.stdout.write(JSON.stringify({
  bunVersion: String(Bun.version ?? ""),
  bunRevision: String(Bun.revision ?? ""),
  isMainThread: Boolean(Bun.isMainThread),
  enableAnsiColors: Boolean(Bun.enableANSIColors),
  processEnvEqualsBunEnv: process.env === Bun.env,
  exports: bunKeys,
  deepInspections,
  globalProbes,
  inspectTableText,
  fileLoaderProbe,
}));
`

interface RawBinaryProbePayload {
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
}

function loadInProcessBunBuiltinModules(): Readonly<Record<string, unknown>> {
  const g = globalThis as Record<string, unknown>
  if (!g.Bun || typeof g.Bun !== "object") return {}
  const resolved: Record<string, unknown> = {}
  try {
    const req = createRequire(import.meta.url)
    for (const mod of BUN_BUILTIN_MODULE_TARGETS) {
      try {
        resolved[mod.specifier] = req(mod.specifier)
      } catch {
        // Optional built-in specifier unavailable in current context
      }
    }
  } catch {
    // createRequire unavailable
  }
  return resolved
}

function probeInProcessSampleAsset(): BunFileSampleAssetProbe | null {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    | {
        readonly file?: (path: string) => Blob & {
          readonly stream?: () => ReadableStream<Uint8Array>
        }
      }
    | undefined
  if (!bunObj || typeof bunObj.file !== "function") return null

  const cwd = process.cwd()
  for (const relPath of SAMPLE_WORKSPACE_ASSET_CANDIDATES) {
    const absPath = resolve(cwd, relPath)
    if (!existsSync(absPath)) continue
    try {
      const handle = bunObj.file(absPath)
      let responseReady = false
      try {
        const res = new Response(handle)
        responseReady = res.body !== null
      } catch {
        responseReady = false
      }
      let formDataReady = false
      try {
        const fd = new FormData()
        fd.append("asset", handle, relPath.split("/").pop() ?? "asset")
        formDataReady = fd.has("asset")
      } catch {
        formDataReady = false
      }
      const unknownMime = bunObj.file("probe.unknownext123").type || "application/octet-stream"
      return {
        assetPath: relPath,
        instanceofBlob: handle instanceof Blob,
        type: handle.type || "application/octet-stream",
        size: handle.size,
        exists: true,
        sliceByteLength: handle.slice(0, 64).size,
        streamSupported: typeof handle.stream === "function",
        responseReady,
        formDataReady,
        unknownExtFallbackMime: unknownMime,
      }
    } catch {
      // Try next candidate
    }
  }
  return null
}

export interface LoadBunRuntimeSurfaceOptions {
  readonly forceRefresh?: boolean | undefined
  readonly disableBinaryProbe?: boolean | undefined
}

export function loadBunRuntimeSurfaceAudit(
  options: LoadBunRuntimeSurfaceOptions = {},
): BunRuntimeSurfaceAuditSnapshot {
  const builtinModules = loadInProcessBunBuiltinModules()
  const inProcess = runBunSurfaceAudit(
    globalThis as unknown as Record<string, unknown>,
    builtinModules,
  )
  if (inProcess.bunDetected || options.disableBinaryProbe) {
    if (inProcess.bunDetected && inProcess.fileLoaderProbe) {
      const sampleAsset = probeInProcessSampleAsset()
      return {
        ...inProcess,
        fileLoaderProbe: {
          ...inProcess.fileLoaderProbe,
          sampleAsset,
        },
      }
    }
    return inProcess
  }

  const now = Date.now()
  if (!options.forceRefresh && cachedBinaryAudit && cachedBinaryAudit.expiresAt > now) {
    return cachedBinaryAudit.snapshot
  }

  const startedMs = performance.now()
  try {
    const rawStdout = execFileSync("bun", ["-e", FIXED_BUN_BINARY_PROBE_SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      },
      timeout: 3_000,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })

    const parsed = JSON.parse(rawStdout) as RawBinaryProbePayload
    if (parsed && typeof parsed.bunVersion === "string" && Array.isArray(parsed.exports)) {
      const snapshot = buildAuditSnapshotFromBinaryProbe(
        parsed,
        Math.max(0, performance.now() - startedMs),
      )
      cachedBinaryAudit = {
        expiresAt: now + CACHE_TTL_MS,
        snapshot,
      }
      return snapshot
    }
  } catch {
    // Bun binary not installed or timed out — fall back gracefully to host Node snapshot
  }

  return inProcess
}
