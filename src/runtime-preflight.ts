/**
 * @file src/runtime-preflight.ts
 * @description Runtime security & invariant preflight audit for SportsDesk Ops:
 *  1. `sealGlobalBunS3`: seals the ambient `Bun.s3` singleton (locks methods &
 *     descriptor) so ambient AWS/S3/R2 env vars cannot leak through `Bun.s3`
 *     while leaving explicit `new Bun.S3Client(...)` instances unaffected.
 *  2. TLS 1.3 cipher pinning: enforces AEAD TLS 1.3-only cipher suites
 *     (`TLS_AES_256_GCM_SHA384`, `TLS_CHACHA20_POLY1305_SHA256`,
 *     `TLS_AES_128_GCM_SHA256`), rejects `rejectUnauthorized: false` and legacy
 *     versions/ciphers, and validates `tls.createSecureContext`.
 *  3. Lazy `Bun.file` `TypeError` checks: guards against passing lazy
 *     `Bun.file()` / `Blob` handles into Bun's native text parsers (`TOML`,
 *     `YAML`, `JSON5`, `XML`) and probes the runtime `TypeError` contract.
 *  4. `runRuntimePreflightAudit`: composite audit combining `--env-file`
 *     token-bleed preflight (`assertSafeExecArgv`), `sealGlobalBunS3`, TLS 1.3
 *     cipher pinning, and lazy `Bun.file` `TypeError` checks.
 */

import tls from "node:tls"

import {
  assertSafeExecArgv,
  ERR_CF_TOKEN_BLEED_10000,
  type PreflightGuardOptions,
} from "./cli/preflight_guard.ts"

export { assertSafeExecArgv, ERR_CF_TOKEN_BLEED_10000 }

export const ERR_AMBIENT_BUN_S3_SEALED = "ERR_AMBIENT_BUN_S3_SEALED" as const
export const ERR_TLS_CIPHER_PIN_FAILED = "ERR_TLS_CIPHER_PIN_FAILED" as const
export const ERR_LAZY_BUN_FILE_BLOB = "ERR_LAZY_BUN_FILE_BLOB" as const
export const ERR_RUNTIME_PREFLIGHT_FAILED = "ERR_RUNTIME_PREFLIGHT_FAILED" as const

/** Canonical TLS 1.3 AEAD cipher suites (RFC 8446). */
export const PINNED_TLS13_CIPHERS = [
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256",
] as const

export const PINNED_TLS13_CIPHER_STRING = PINNED_TLS13_CIPHERS.join(":")

const FORBIDDEN_LEGACY_CIPHER_TOKENS = [
  "RC4",
  "DES",
  "3DES",
  "MD5",
  "EXPORT",
  "ANULL",
  "ENULL",
  "NULL",
  "PSK",
  "SRP",
  "CAMELLIA",
  "ECDHE-",
  "AES128-SHA",
  "AES256-SHA",
] as const

export const BUN_S3_CLIENT_METHODS = [
  "delete",
  "exists",
  "file",
  "list",
  "presign",
  "size",
  "stat",
  "unlink",
  "write",
] as const

export const BUN_NATIVE_TEXT_PARSERS = ["TOML", "YAML", "JSON5", "XML"] as const

export type BunNativeTextParserName = (typeof BUN_NATIVE_TEXT_PARSERS)[number]

export interface BunNativeParserLike {
  parse(input: unknown): unknown
}

export interface BunRuntimeLike {
  readonly version?: string
  s3?: Record<string, unknown>
  file?: (path: string) => Blob
  TOML?: BunNativeParserLike
  YAML?: BunNativeParserLike
  JSON5?: BunNativeParserLike
  XML?: BunNativeParserLike
}

function getGlobalBun(): BunRuntimeLike | undefined {
  const g = globalThis as unknown as { Bun?: BunRuntimeLike }
  return g.Bun
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// ── 1. Global Bun.s3 Sealing ──────────────────────────────────────────────────

const sealedS3Instances = new WeakSet<object>()
const sealedS3Methods = new WeakMap<object, readonly string[]>()

export interface SealGlobalBunS3Options {
  /** Override target `Bun` namespace (useful for isolated unit tests). */
  readonly bun?: BunRuntimeLike | null | undefined
  /** Throw when `Bun.s3` is absent (e.g. Node.js runtime). Default: `false`. */
  readonly strict?: boolean | undefined
  /** Replace S3 methods on `Bun.s3` with fail-closed throwers. Default: `true`. */
  readonly blockMethods?: boolean | undefined
  /** Freeze the `Bun.s3` instance via `Object.freeze`. Default: `true`. */
  readonly freezeInstance?: boolean | undefined
  /** Lock `Bun.s3` property `writable: false`. Default: `true`. */
  readonly lockDescriptor?: boolean | undefined
}

export interface SealGlobalBunS3Result {
  readonly status: "pass" | "fail" | "skipped"
  readonly sealed: boolean
  readonly alreadySealed: boolean
  readonly writableLocked: boolean
  readonly frozen: boolean
  readonly lockedMethods: readonly string[]
  readonly reason?: string | undefined
}

export function isGlobalBunS3Sealed(bun?: BunRuntimeLike | null): boolean {
  const targetBun = bun === undefined ? getGlobalBun() : bun
  if (!targetBun || !isObjectRecord(targetBun.s3)) return false
  if (sealedS3Instances.has(targetBun.s3)) return true
  const desc = Object.getOwnPropertyDescriptor(targetBun, "s3")
  return desc?.writable === false && Object.isFrozen(targetBun.s3)
}

/**
 * Seal the ambient `Bun.s3` global singleton so no module can implicitly read
 * ambient AWS/S3/R2 env credentials via `Bun.s3` or reassign `Bun.s3`.
 * Explicit `new Bun.S3Client(...)` instances inherit from `S3Client.prototype`
 * and remain unaffected. Idempotent across repeated calls.
 */
export function sealGlobalBunS3(options: SealGlobalBunS3Options = {}): SealGlobalBunS3Result {
  const targetBun = options.bun === undefined ? getGlobalBun() : options.bun
  if (!targetBun || !isObjectRecord(targetBun.s3)) {
    if (options.strict) {
      throw new Error(
        `${ERR_AMBIENT_BUN_S3_SEALED}: Bun.s3 global singleton is unavailable on this runtime`,
      )
    }
    return {
      status: "skipped",
      sealed: false,
      alreadySealed: false,
      writableLocked: false,
      frozen: false,
      lockedMethods: [],
      reason: "Bun.s3 unavailable on current runtime",
    }
  }

  const s3 = targetBun.s3
  const existingDesc = Object.getOwnPropertyDescriptor(targetBun, "s3")
  if (sealedS3Instances.has(s3) || (existingDesc?.writable === false && Object.isFrozen(s3))) {
    return {
      status: "pass",
      sealed: true,
      alreadySealed: true,
      writableLocked: existingDesc?.writable === false,
      frozen: Object.isFrozen(s3),
      lockedMethods: sealedS3Methods.get(s3) ?? [],
    }
  }

  const blockMethods = options.blockMethods ?? true
  const freezeInstance = options.freezeInstance ?? true
  const lockDescriptor = options.lockDescriptor ?? true
  const lockedMethods: string[] = []

  if (blockMethods) {
    const methodSet = new Set<string>(BUN_S3_CLIENT_METHODS)
    for (const key of Object.getOwnPropertyNames(s3)) {
      if (key !== "constructor" && typeof s3[key] === "function") {
        methodSet.add(key)
      }
    }
    const proto = Object.getPrototypeOf(s3) as Record<string, unknown> | null
    if (proto && proto !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key !== "constructor" && typeof proto[key] === "function") {
          methodSet.add(key)
        }
      }
    }

    for (const methodName of methodSet) {
      const desc = Object.getOwnPropertyDescriptor(s3, methodName)
      if (desc && !desc.configurable) {
        continue
      }
      const blocked = () => {
        throw new Error(
          `${ERR_AMBIENT_BUN_S3_SEALED}: Ambient Bun.s3.${methodName}() is sealed; instantiate an explicit S3Client instead.`,
        )
      }
      Object.defineProperty(s3, methodName, {
        value: blocked,
        writable: false,
        enumerable: true,
        configurable: false,
      })
      lockedMethods.push(methodName)
    }
  }

  if (freezeInstance && !Object.isFrozen(s3)) {
    Object.freeze(s3)
  }

  if (lockDescriptor) {
    if (!existingDesc || existingDesc.configurable || existingDesc.writable) {
      Object.defineProperty(targetBun, "s3", {
        value: s3,
        writable: false,
        enumerable: existingDesc?.enumerable ?? true,
      })
    }
  }

  const afterDesc = Object.getOwnPropertyDescriptor(targetBun, "s3")
  const writableLocked = afterDesc?.writable === false
  const frozen = Object.isFrozen(s3)
  const sealed = (!lockDescriptor || writableLocked) && (!freezeInstance || frozen)

  if (sealed) {
    sealedS3Instances.add(s3)
    sealedS3Methods.set(s3, lockedMethods)
  }

  return {
    status: sealed ? "pass" : "fail",
    sealed,
    alreadySealed: false,
    writableLocked,
    frozen,
    lockedMethods,
  }
}

// ── 2. TLS 1.3 Cipher Pinning ─────────────────────────────────────────────────

export interface Tls13CipherPinOptions {
  /** Allowed TLS 1.3 cipher suites. Defaults to `PINNED_TLS13_CIPHERS`. */
  readonly requiredCiphers?: readonly string[] | undefined
  /** Require `tls.DEFAULT_MAX_VERSION === "TLSv1.3"`. Default: `true`. */
  readonly enforceDefaultMaxTls13?: boolean | undefined
  /** Reject insecure `rejectUnauthorized: false` configuration. Default: `true`. */
  readonly rejectUnauthorized?: boolean | undefined
  /** Instantiate a real `tls.createSecureContext` to verify OpenSSL/BoringSSL support. Default: `true`. */
  readonly testSecureContext?: boolean | undefined
  /** Injectable TLS adapter for testing. */
  readonly tlsModule?: {
    readonly getCiphers: () => string[]
    readonly createSecureContext: (opts: tls.SecureContextOptions) => unknown
    readonly DEFAULT_MIN_VERSION?: string
    readonly DEFAULT_MAX_VERSION?: string
    readonly DEFAULT_CIPHERS?: string
  }
}

export interface Tls13CipherPinReport {
  readonly status: "pass" | "fail"
  readonly passed: boolean
  readonly pinnedCiphers: readonly string[]
  readonly cipherString: string
  readonly supportedCiphers: readonly string[]
  readonly missingCiphers: readonly string[]
  readonly defaultMinVersion: string
  readonly defaultMaxVersion: string
  readonly secureContextVerified: boolean
  readonly error?: string | undefined
}

/**
 * Validate and build pinned TLS 1.3 client/server options (`minVersion: "TLSv1.3"`,
 * `maxVersion: "TLSv1.3"`, AEAD-only ciphers, `rejectUnauthorized: true`).
 * Throws `ERR_TLS_CIPHER_PIN_FAILED` on downgrade or weak-cipher overrides.
 */
export function createPinnedTlsOptions(
  overrides: {
    readonly minVersion?: tls.SecureVersion | undefined
    readonly maxVersion?: tls.SecureVersion | undefined
    readonly ciphers?: string | undefined
    readonly rejectUnauthorized?: boolean | undefined
    readonly servername?: string | undefined
  } = {},
): {
  readonly minVersion: "TLSv1.3"
  readonly maxVersion: "TLSv1.3"
  readonly ciphers: string
  readonly rejectUnauthorized: true
  readonly servername?: string | undefined
} {
  if (overrides.rejectUnauthorized === false) {
    throw new Error(
      `${ERR_TLS_CIPHER_PIN_FAILED}: rejectUnauthorized=false is prohibited under TLS 1.3 pinning`,
    )
  }
  if (overrides.minVersion && overrides.minVersion !== "TLSv1.3") {
    throw new Error(
      `${ERR_TLS_CIPHER_PIN_FAILED}: TLS minVersion downgrade to '${overrides.minVersion}' is prohibited (TLSv1.3 required)`,
    )
  }
  if (overrides.maxVersion && overrides.maxVersion !== "TLSv1.3") {
    throw new Error(
      `${ERR_TLS_CIPHER_PIN_FAILED}: TLS maxVersion '${overrides.maxVersion}' is below TLSv1.3`,
    )
  }

  const cipherString = (overrides.ciphers ?? PINNED_TLS13_CIPHER_STRING).trim()
  if (!cipherString) {
    throw new Error(`${ERR_TLS_CIPHER_PIN_FAILED}: cipher list must not be empty`)
  }

  const tokens = cipherString
    .split(":")
    .map((t) => t.trim())
    .filter(Boolean)
  const allowedSet = new Set<string>(PINNED_TLS13_CIPHERS)
  for (const token of tokens) {
    const upper = token.toUpperCase()
    if (
      FORBIDDEN_LEGACY_CIPHER_TOKENS.some((bad) => upper.includes(bad)) ||
      !allowedSet.has(upper)
    ) {
      throw new Error(
        `${ERR_TLS_CIPHER_PIN_FAILED}: non-TLS-1.3 or unpinned cipher '${token}' rejected`,
      )
    }
  }

  return {
    minVersion: "TLSv1.3",
    maxVersion: "TLSv1.3",
    ciphers: tokens.map((t) => t.toUpperCase()).join(":"),
    rejectUnauthorized: true,
    ...(overrides.servername !== undefined ? { servername: overrides.servername } : {}),
  }
}

/**
 * Verify that the active runtime TLS stack supports all pinned TLS 1.3 ciphers
 * and accepts a pinned `TLSv1.3` `SecureContext`.
 */
export function verifyTls13CipherPinning(
  options: Tls13CipherPinOptions = {},
): Tls13CipherPinReport {
  const tlsImpl = options.tlsModule ?? tls
  const requiredCiphers = options.requiredCiphers ?? PINNED_TLS13_CIPHERS
  const enforceDefaultMaxTls13 = options.enforceDefaultMaxTls13 ?? true
  const testSecureContext = options.testSecureContext ?? true
  const defaultMinVersion = tlsImpl.DEFAULT_MIN_VERSION ?? "unknown"
  const defaultMaxVersion = tlsImpl.DEFAULT_MAX_VERSION ?? "unknown"

  if (options.rejectUnauthorized === false) {
    return {
      status: "fail",
      passed: false,
      pinnedCiphers: requiredCiphers,
      cipherString: requiredCiphers.join(":"),
      supportedCiphers: [],
      missingCiphers: [...requiredCiphers],
      defaultMinVersion,
      defaultMaxVersion,
      secureContextVerified: false,
      error: `${ERR_TLS_CIPHER_PIN_FAILED}: rejectUnauthorized=false is prohibited`,
    }
  }

  let validatedOpts: ReturnType<typeof createPinnedTlsOptions>
  try {
    validatedOpts = createPinnedTlsOptions({
      ciphers: requiredCiphers.join(":"),
      rejectUnauthorized: options.rejectUnauthorized,
    })
  } catch (err) {
    return {
      status: "fail",
      passed: false,
      pinnedCiphers: requiredCiphers,
      cipherString: requiredCiphers.join(":"),
      supportedCiphers: [],
      missingCiphers: [...requiredCiphers],
      defaultMinVersion,
      defaultMaxVersion,
      secureContextVerified: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const runtimeCiphers = new Set(tlsImpl.getCiphers().map((c) => c.toLowerCase()))
  const supportedCiphers: string[] = []
  const missingCiphers: string[] = []
  for (const cipher of requiredCiphers) {
    if (runtimeCiphers.has(cipher.toLowerCase())) {
      supportedCiphers.push(cipher)
    } else {
      missingCiphers.push(cipher)
    }
  }

  if (enforceDefaultMaxTls13 && defaultMaxVersion !== "TLSv1.3") {
    return {
      status: "fail",
      passed: false,
      pinnedCiphers: requiredCiphers,
      cipherString: validatedOpts.ciphers,
      supportedCiphers,
      missingCiphers,
      defaultMinVersion,
      defaultMaxVersion,
      secureContextVerified: false,
      error: `${ERR_TLS_CIPHER_PIN_FAILED}: runtime DEFAULT_MAX_VERSION is '${defaultMaxVersion}' (expected 'TLSv1.3')`,
    }
  }

  if (missingCiphers.length > 0) {
    return {
      status: "fail",
      passed: false,
      pinnedCiphers: requiredCiphers,
      cipherString: validatedOpts.ciphers,
      supportedCiphers,
      missingCiphers,
      defaultMinVersion,
      defaultMaxVersion,
      secureContextVerified: false,
      error: `${ERR_TLS_CIPHER_PIN_FAILED}: missing pinned TLS 1.3 cipher(s): ${missingCiphers.join(", ")}`,
    }
  }

  let secureContextVerified = false
  if (testSecureContext) {
    try {
      const ctx = tlsImpl.createSecureContext({
        minVersion: validatedOpts.minVersion,
        maxVersion: validatedOpts.maxVersion,
        ciphers: validatedOpts.ciphers,
      })
      secureContextVerified = Boolean(ctx)
      if (!secureContextVerified) {
        throw new Error("createSecureContext returned nullish context")
      }
    } catch (err) {
      return {
        status: "fail",
        passed: false,
        pinnedCiphers: requiredCiphers,
        cipherString: validatedOpts.ciphers,
        supportedCiphers,
        missingCiphers,
        defaultMinVersion,
        defaultMaxVersion,
        secureContextVerified: false,
        error: `${ERR_TLS_CIPHER_PIN_FAILED}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  return {
    status: "pass",
    passed: true,
    pinnedCiphers: requiredCiphers,
    cipherString: validatedOpts.ciphers,
    supportedCiphers,
    missingCiphers,
    defaultMinVersion,
    defaultMaxVersion,
    secureContextVerified,
  }
}

// ── 3. Lazy Bun.file TypeError Checks ─────────────────────────────────────────

export function isLazyFileBlob(value: unknown): boolean {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true
  }
  if (!isObjectRecord(value)) return false
  return (
    typeof value.text === "function" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.stream === "function"
  )
}

/**
 * Guard helper for parser adapters: rejects lazy `Bun.file(...)` / `Blob`
 * handles with a deterministic `TypeError` (`ERR_LAZY_BUN_FILE_BLOB`) so callers
 * materialize text via `await file.text()` or `readFileSync()` first.
 */
export function assertTextNotLazyBunFile(input: unknown, parserLabel = "parser"): string {
  if (isLazyFileBlob(input)) {
    throw new TypeError(
      `${ERR_LAZY_BUN_FILE_BLOB}: ${parserLabel} cannot consume a lazy Bun.file() / Blob handle directly; await file.text() first.`,
    )
  }
  if (typeof input !== "string") {
    throw new TypeError(
      `${ERR_LAZY_BUN_FILE_BLOB}: ${parserLabel} expected string text input, got ${typeof input}.`,
    )
  }
  return input
}

export interface LazyBunFileParserProbeResult {
  readonly parser: BunNativeTextParserName
  readonly available: boolean
  readonly threwTypeError: boolean
  readonly textParseSucceeded: boolean
  readonly errorName?: string | undefined
  readonly errorMessage?: string | undefined
  readonly status: "pass" | "fail" | "skipped"
}

export interface LazyBunFileCheckReport {
  readonly status: "pass" | "fail" | "skipped"
  readonly passed: boolean
  readonly guardThrewTypeError: boolean
  readonly probes: readonly LazyBunFileParserProbeResult[]
  readonly reason?: string | undefined
  readonly error?: string | undefined
}

export interface LazyBunFileProbeOptions {
  /** Override target `Bun` namespace (for tests). */
  readonly bun?: BunRuntimeLike | null | undefined
  /** Non-existent probe path passed to `Bun.file(...)` (zero disk I/O). */
  readonly probePath?: string | undefined
  /** Subset of native parsers to probe. Defaults to `BUN_NATIVE_TEXT_PARSERS`. */
  readonly parsers?: readonly BunNativeTextParserName[] | undefined
  /** Also verify valid text parsing succeeds for each available parser. Default: `true`. */
  readonly validateSafeTextPath?: boolean | undefined
}

const SAFE_TEXT_FIXTURES: Record<BunNativeTextParserName, string> = {
  TOML: 'schema = "sportsdesk-preflight/v1"\n',
  YAML: "schema: sportsdesk-preflight/v1\n",
  JSON5: '{ schema: "sportsdesk-preflight/v1" }\n',
  XML: '<preflight schema="sportsdesk-preflight/v1" />\n',
}

/**
 * Probe both the defensive `assertTextNotLazyBunFile` guard and Bun's native
 * parsers (`TOML`, `YAML`, `JSON5`, `XML`) to verify lazy `Bun.file()` handles
 * fail with `TypeError` rather than silently coercing `[object Blob]`.
 */
export function probeLazyBunFileTypeErrors(
  options: LazyBunFileProbeOptions = {},
): LazyBunFileCheckReport {
  const targetBun = options.bun === undefined ? getGlobalBun() : options.bun
  const parsers = options.parsers ?? BUN_NATIVE_TEXT_PARSERS
  const validateSafeTextPath = options.validateSafeTextPath ?? true
  const probePath = options.probePath ?? "/nonexistent/__sportsdesk_lazy_file_probe__.toml"

  // 1. Always verify our defensive Blob/BunFile TypeError guard
  let guardThrewTypeError = false
  try {
    const syntheticBlob =
      typeof Blob !== "undefined"
        ? new Blob(['schema = "probe"\n'])
        : {
            text: async () => "",
            arrayBuffer: async () => new ArrayBuffer(0),
            stream: () => null,
          }
    assertTextNotLazyBunFile(syntheticBlob, "Bun.TOML.parse")
  } catch (err) {
    guardThrewTypeError = err instanceof TypeError && err.message.includes(ERR_LAZY_BUN_FILE_BLOB)
  }

  if (!guardThrewTypeError) {
    return {
      status: "fail",
      passed: false,
      guardThrewTypeError: false,
      probes: [],
      error: `${ERR_LAZY_BUN_FILE_BLOB}: assertTextNotLazyBunFile failed to reject lazy Blob input with TypeError`,
    }
  }

  // 2. If Bun.file is unavailable (Node.js runtime), report clean skip for native probes
  if (!targetBun || typeof targetBun.file !== "function") {
    return {
      status: "skipped",
      passed: true,
      guardThrewTypeError: true,
      probes: parsers.map((parser) => ({
        parser,
        available: false,
        threwTypeError: false,
        textParseSucceeded: false,
        status: "skipped",
      })),
      reason: "Bun.file unavailable on current runtime (guard verified)",
    }
  }

  const lazyHandle = targetBun.file(probePath)
  const probes: LazyBunFileParserProbeResult[] = []
  let anyFailed = false

  for (const parserName of parsers) {
    const parserObj = targetBun[parserName]
    if (!parserObj || typeof parserObj.parse !== "function") {
      probes.push({
        parser: parserName,
        available: false,
        threwTypeError: false,
        textParseSucceeded: false,
        status: "skipped",
      })
      continue
    }

    let threwTypeError = false
    let errorName: string | undefined
    let errorMessage: string | undefined
    try {
      parserObj.parse(lazyHandle)
    } catch (err) {
      threwTypeError = err instanceof TypeError
      errorName = err instanceof Error ? err.name : typeof err
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    let textParseSucceeded = !validateSafeTextPath
    if (validateSafeTextPath) {
      try {
        const parsed = parserObj.parse(SAFE_TEXT_FIXTURES[parserName])
        textParseSucceeded = parsed !== undefined && parsed !== null
      } catch {
        textParseSucceeded = false
      }
    }

    const passed = threwTypeError && textParseSucceeded
    if (!passed) anyFailed = true

    probes.push({
      parser: parserName,
      available: true,
      threwTypeError,
      textParseSucceeded,
      ...(errorName !== undefined ? { errorName } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      status: passed ? "pass" : "fail",
    })
  }

  return {
    status: anyFailed ? "fail" : "pass",
    passed: !anyFailed,
    guardThrewTypeError,
    probes,
    ...(anyFailed
      ? {
          error: `${ERR_LAZY_BUN_FILE_BLOB}: One or more Bun parsers failed lazy Bun.file TypeError contract`,
        }
      : {}),
  }
}

// ── 4. Composite Runtime Preflight Audit ──────────────────────────────────────

export interface RuntimePreflightAuditOptions {
  /** Override `process.execArgv` for `--env-file` bleed check. */
  readonly execArgv?: readonly string[] | undefined
  /** Override `process.env.BUN_OPTIONS` for `--env-file` bleed check. */
  readonly bunOptions?: string | undefined
  /** Options forwarded to `assertSafeExecArgv`. */
  readonly preflightGuard?: PreflightGuardOptions | undefined
  /** Whether to invoke `sealGlobalBunS3`. Default: `true`. */
  readonly sealS3?: boolean | undefined
  /** Options forwarded to `sealGlobalBunS3`. */
  readonly s3?: SealGlobalBunS3Options | undefined
  /** Options forwarded to `verifyTls13CipherPinning`. */
  readonly tls?: Tls13CipherPinOptions | undefined
  /** Options forwarded to `probeLazyBunFileTypeErrors`. */
  readonly lazyFile?: LazyBunFileProbeOptions | undefined
  /** Throw `ERR_RUNTIME_PREFLIGHT_FAILED` when any check fails. Default: `false`. */
  readonly throwOnFailure?: boolean | undefined
}

export interface RuntimePreflightAuditReport {
  readonly ok: boolean
  readonly runtime: "bun" | "node"
  readonly runtimeVersion: string
  readonly checkedAt: string
  readonly checks: {
    readonly execArgv: {
      readonly status: "pass" | "fail"
      readonly error?: string | undefined
    }
    readonly bunS3Seal: SealGlobalBunS3Result
    readonly tlsCipherPinning: Tls13CipherPinReport
    readonly lazyBunFile: LazyBunFileCheckReport
  }
  readonly failures: readonly string[]
}

/**
 * Execute all runtime security & contract preflight checks:
 * - `--env-file` token-bleed guard (`assertSafeExecArgv`)
 * - Global `Bun.s3` singleton sealing (`sealGlobalBunS3`)
 * - TLS 1.3 AEAD cipher pinning (`verifyTls13CipherPinning`)
 * - Lazy `Bun.file` `TypeError` contract checks (`probeLazyBunFileTypeErrors`)
 */
export function runRuntimePreflightAudit(
  options: RuntimePreflightAuditOptions = {},
): RuntimePreflightAuditReport {
  const processBunVersion =
    typeof process !== "undefined" && typeof process.versions?.bun === "string"
      ? process.versions.bun
      : null
  const globalBun = getGlobalBun()
  const isBun = Boolean(processBunVersion || globalBun)
  const failures: string[] = []

  // 1. ExecArgv / BUN_OPTIONS --env-file bleed guard
  let execArgvCheck: {
    readonly status: "pass" | "fail"
    readonly error?: string | undefined
  }
  try {
    assertSafeExecArgv(options.execArgv, options.bunOptions, options.preflightGuard)
    execArgvCheck = { status: "pass" }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    failures.push(`execArgv: ${message}`)
    execArgvCheck = { status: "fail", error: message }
  }

  // 2. Global Bun.s3 sealing
  let bunS3Seal: SealGlobalBunS3Result
  if (options.sealS3 === false) {
    const already = isGlobalBunS3Sealed(options.s3?.bun)
    bunS3Seal = {
      status: "skipped",
      sealed: already,
      alreadySealed: already,
      writableLocked: already,
      frozen: already,
      lockedMethods: [],
      reason: "sealS3 disabled by caller option",
    }
  } else {
    try {
      bunS3Seal = sealGlobalBunS3(options.s3)
      if (bunS3Seal.status === "fail") {
        failures.push(`bunS3Seal: ${bunS3Seal.reason ?? "failed to seal global Bun.s3"}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`bunS3Seal: ${message}`)
      bunS3Seal = {
        status: "fail",
        sealed: false,
        alreadySealed: false,
        writableLocked: false,
        frozen: false,
        lockedMethods: [],
        reason: message,
      }
    }
  }

  // 3. TLS 1.3 cipher pinning
  const tlsCipherPinning = verifyTls13CipherPinning(options.tls)
  if (!tlsCipherPinning.passed) {
    failures.push(`tlsCipherPinning: ${tlsCipherPinning.error ?? "TLS 1.3 cipher pinning failed"}`)
  }

  // 4. Lazy Bun.file TypeError contract
  const lazyBunFile = probeLazyBunFileTypeErrors(options.lazyFile)
  if (!lazyBunFile.passed) {
    failures.push(`lazyBunFile: ${lazyBunFile.error ?? "lazy Bun.file TypeError check failed"}`)
  }

  const ok = failures.length === 0
  const report: RuntimePreflightAuditReport = {
    ok,
    runtime: isBun ? "bun" : "node",
    runtimeVersion: isBun ? (processBunVersion ?? globalBun?.version ?? "unknown") : process.version,
    checkedAt: new Date().toISOString(),
    checks: {
      execArgv: execArgvCheck,
      bunS3Seal,
      tlsCipherPinning,
      lazyBunFile,
    },
    failures,
  }

  if (options.throwOnFailure && !ok) {
    throw new Error(`${ERR_RUNTIME_PREFLIGHT_FAILED}: ${failures.join(" | ")}`)
  }

  return report
}

/** Fail-closed wrapper around `runRuntimePreflightAudit({ ...options, throwOnFailure: true })`. */
export function assertRuntimePreflightAudit(
  options: Omit<RuntimePreflightAuditOptions, "throwOnFailure"> = {},
): RuntimePreflightAuditReport {
  return runRuntimePreflightAudit({ ...options, throwOnFailure: true })
}
