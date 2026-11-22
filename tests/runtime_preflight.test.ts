/**
 * @file tests/runtime_preflight.test.ts
 * @description Tests for src/runtime-preflight.ts covering:
 *  - sealGlobalBunS3 (ambient Bun.s3 singleton lockdown + idempotency + S3Client isolation)
 *  - TLS 1.3 AEAD cipher pinning & downgrade rejection
 *  - Lazy Bun.file TypeError checks across native Bun parsers (TOML, YAML, JSON5, XML)
 *  - Composite runRuntimePreflightAudit & assertRuntimePreflightAudit
 */

import { describe, expect, test } from "bun:test"

import {
  assertRuntimePreflightAudit,
  assertTextNotLazyBunFile,
  createPinnedTlsOptions,
  ERR_AMBIENT_BUN_S3_SEALED,
  ERR_CF_TOKEN_BLEED_10000,
  ERR_LAZY_BUN_FILE_BLOB,
  ERR_RUNTIME_PREFLIGHT_FAILED,
  ERR_TLS_CIPHER_PIN_FAILED,
  isGlobalBunS3Sealed,
  isLazyFileBlob,
  PINNED_TLS13_CIPHER_STRING,
  PINNED_TLS13_CIPHERS,
  probeLazyBunFileTypeErrors,
  runRuntimePreflightAudit,
  sealGlobalBunS3,
  verifyTls13CipherPinning,
} from "../src/runtime-preflight.ts"

describe("sealGlobalBunS3", () => {
  test("skips gracefully when Bun.s3 is unavailable unless strict=true", () => {
    const skipped = sealGlobalBunS3({ bun: null })
    expect(skipped.status).toBe("skipped")
    expect(skipped.sealed).toBe(false)
    expect(skipped.lockedMethods).toEqual([])

    expect(() => sealGlobalBunS3({ bun: null, strict: true })).toThrow(ERR_AMBIENT_BUN_S3_SEALED)
  })

  test("seals mock Bun.s3 object, blocks methods & reassignment, and is idempotent", () => {
    const mockS3 = {
      file: (k: string) => ({ name: k }),
      write: async () => 0,
      delete: async () => {},
    }
    const mockBun = { s3: mockS3 as Record<string, unknown> }

    const first = sealGlobalBunS3({ bun: mockBun })
    expect(first.status).toBe("pass")
    expect(first.sealed).toBe(true)
    expect(first.alreadySealed).toBe(false)
    expect(first.writableLocked).toBe(true)
    expect(first.frozen).toBe(true)
    expect(first.lockedMethods).toContain("file")
    expect(first.lockedMethods).toContain("write")
    expect(isGlobalBunS3Sealed(mockBun)).toBe(true)

    expect(() => (mockBun.s3 as { file: (k: string) => unknown }).file("x")).toThrow(
      ERR_AMBIENT_BUN_S3_SEALED,
    )
    expect(() => {
      mockBun.s3 = {}
    }).toThrow(TypeError)

    // Idempotent second call
    const second = sealGlobalBunS3({ bun: mockBun })
    expect(second.status).toBe("pass")
    expect(second.sealed).toBe(true)
    expect(second.alreadySealed).toBe(true)
  })

  test("seals live Bun.s3 singleton while leaving explicit new Bun.S3Client() working", () => {
    const res = sealGlobalBunS3()
    expect(res.status).toBe("pass")
    expect(res.sealed).toBe(true)
    expect(res.writableLocked).toBe(true)
    expect(res.frozen).toBe(true)
    expect(isGlobalBunS3Sealed()).toBe(true)

    expect(() => Bun.s3.file("ambient-leak.json")).toThrow(ERR_AMBIENT_BUN_S3_SEALED)
    expect(() => {
      // @ts-expect-error deliberate runtime reassignment attempt
      Bun.s3 = {}
    }).toThrow(TypeError)

    // Explicit S3Client with injected credentials remains operational
    const explicit = new Bun.S3Client({
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
      bucket: "sportsdesk-explicit",
    })
    expect(explicit.file("explicit-ok.json").name).toBe("explicit-ok.json")
  })
})

describe("TLS 1.3 cipher pinning", () => {
  test("createPinnedTlsOptions returns TLSv1.3 AEAD-only defaults", () => {
    const opts = createPinnedTlsOptions({ servername: "api.telegram.org" })
    expect(opts.minVersion).toBe("TLSv1.3")
    expect(opts.maxVersion).toBe("TLSv1.3")
    expect(opts.ciphers).toBe(PINNED_TLS13_CIPHER_STRING)
    expect(opts.rejectUnauthorized).toBe(true)
    expect(opts.servername).toBe("api.telegram.org")
  })

  test("rejects rejectUnauthorized=false, TLS<1.3 downgrades, and legacy ciphers", () => {
    expect(() => createPinnedTlsOptions({ rejectUnauthorized: false })).toThrow(
      ERR_TLS_CIPHER_PIN_FAILED,
    )

    expect(() => createPinnedTlsOptions({ minVersion: "TLSv1.2" })).toThrow(
      ERR_TLS_CIPHER_PIN_FAILED,
    )

    expect(() => createPinnedTlsOptions({ maxVersion: "TLSv1.2" })).toThrow(
      ERR_TLS_CIPHER_PIN_FAILED,
    )

    expect(() => createPinnedTlsOptions({ ciphers: "ECDHE-RSA-AES128-GCM-SHA256" })).toThrow(
      ERR_TLS_CIPHER_PIN_FAILED,
    )

    expect(() => createPinnedTlsOptions({ ciphers: "RC4-MD5" })).toThrow(ERR_TLS_CIPHER_PIN_FAILED)

    expect(() => createPinnedTlsOptions({ ciphers: "" })).toThrow(ERR_TLS_CIPHER_PIN_FAILED)
  })

  test("verifyTls13CipherPinning passes against live runtime TLS stack", () => {
    const report = verifyTls13CipherPinning()
    expect(report.status).toBe("pass")
    expect(report.passed).toBe(true)
    expect(report.supportedCiphers).toEqual([...PINNED_TLS13_CIPHERS])
    expect(report.missingCiphers).toEqual([])
    expect(report.defaultMaxVersion).toBe("TLSv1.3")
    expect(report.secureContextVerified).toBe(true)
  })

  test("verifyTls13CipherPinning fails closed when required cipher or TLS 1.3 maxVersion is missing", () => {
    const missingCipherReport = verifyTls13CipherPinning({
      tlsModule: {
        getCiphers: () => ["tls_aes_128_gcm_sha256"],
        createSecureContext: () => ({}),
        DEFAULT_MIN_VERSION: "TLSv1.2",
        DEFAULT_MAX_VERSION: "TLSv1.3",
      },
    })
    expect(missingCipherReport.status).toBe("fail")
    expect(missingCipherReport.passed).toBe(false)
    expect(missingCipherReport.missingCiphers).toContain("TLS_AES_256_GCM_SHA384")

    const downgradedMaxReport = verifyTls13CipherPinning({
      tlsModule: {
        getCiphers: () => PINNED_TLS13_CIPHERS.map((c) => c.toLowerCase()),
        createSecureContext: () => ({}),
        DEFAULT_MIN_VERSION: "TLSv1.2",
        DEFAULT_MAX_VERSION: "TLSv1.2",
      },
    })
    expect(downgradedMaxReport.status).toBe("fail")
    expect(downgradedMaxReport.error).toContain(ERR_TLS_CIPHER_PIN_FAILED)
  })
})

describe("Lazy Bun.file TypeError checks", () => {
  test("isLazyFileBlob and assertTextNotLazyBunFile reject Blob / Bun.file handles with TypeError", () => {
    const lazyFile = Bun.file("config/slab.toml")
    expect(isLazyFileBlob(lazyFile)).toBe(true)
    expect(isLazyFileBlob(new Blob(["a = 1"]))).toBe(true)
    expect(isLazyFileBlob('a = "1"')).toBe(false)

    expect(() => assertTextNotLazyBunFile(lazyFile, "Bun.TOML.parse")).toThrow(TypeError)
    expect(() => assertTextNotLazyBunFile(lazyFile, "Bun.TOML.parse")).toThrow(
      ERR_LAZY_BUN_FILE_BLOB,
    )
    expect(assertTextNotLazyBunFile('a = "1"', "Bun.TOML.parse")).toBe('a = "1"')
  })

  test("probeLazyBunFileTypeErrors verifies TOML, YAML, JSON5, XML throw TypeError on lazy Bun.file()", () => {
    const report = probeLazyBunFileTypeErrors()
    expect(report.status).toBe("pass")
    expect(report.passed).toBe(true)
    expect(report.guardThrewTypeError).toBe(true)
    expect(report.probes.length).toBe(4)

    for (const probe of report.probes) {
      expect(probe.available).toBe(true)
      expect(probe.threwTypeError).toBe(true)
      expect(probe.textParseSucceeded).toBe(true)
      expect(probe.status).toBe("pass")
      expect(probe.errorName).toBe("TypeError")
    }
  })

  test("probeLazyBunFileTypeErrors fails if a mock parser silently accepts lazy Bun.file()", () => {
    const brokenBun = {
      file: (p: string) => Bun.file(p),
      TOML: {
        parse: () => ({ silentlyCoerced: true }),
      },
    }
    const report = probeLazyBunFileTypeErrors({
      bun: brokenBun,
      parsers: ["TOML"],
    })
    expect(report.status).toBe("fail")
    expect(report.passed).toBe(false)
    expect(report.probes[0]?.threwTypeError).toBe(false)
    expect(report.error).toContain(ERR_LAZY_BUN_FILE_BLOB)
  })
})

describe("runRuntimePreflightAudit", () => {
  test("returns ok=true with all checks passing on clean runtime", () => {
    const report = runRuntimePreflightAudit({
      execArgv: ["--smol"],
      bunOptions: "",
    })
    expect(report.ok).toBe(true)
    expect(report.runtime).toBe("bun")
    expect(report.failures).toEqual([])
    expect(report.checks.execArgv.status).toBe("pass")
    expect(report.checks.bunS3Seal.status).toBe("pass")
    expect(report.checks.bunS3Seal.sealed).toBe(true)
    expect(report.checks.tlsCipherPinning.status).toBe("pass")
    expect(report.checks.lazyBunFile.status).toBe("pass")

    expect(() =>
      assertRuntimePreflightAudit({ execArgv: ["--smol"], bunOptions: "" }),
    ).not.toThrow()
  })

  test("fails closed when --env-file token bleed is detected", () => {
    const report = runRuntimePreflightAudit({
      execArgv: ["--no-env-file", "--env-file=r2.env"],
      bunOptions: "",
    })
    expect(report.ok).toBe(false)
    expect(report.checks.execArgv.status).toBe("fail")
    expect(report.checks.execArgv.error).toContain(ERR_CF_TOKEN_BLEED_10000)

    expect(() =>
      assertRuntimePreflightAudit({
        execArgv: ["--no-env-file", "--env-file=r2.env"],
        bunOptions: "",
      }),
    ).toThrow(ERR_RUNTIME_PREFLIGHT_FAILED)
  })
})
