import { describe, expect, test } from "bun:test"
import { assertNoSecretLeak, isR2ObjectProbeKey } from "../src/s3/sealed_r2_handle.ts"

describe("Bun R2 inspection", () => {
  test("checks object key size in UTF-8 bytes and rejects malformed keys", () => {
    expect(isR2ObjectProbeKey("a".repeat(1_024))).toBe(true)
    expect(isR2ObjectProbeKey("東".repeat(341) + "a")).toBe(true)
    for (const key of [
      "",
      "a".repeat(1_025),
      "東".repeat(342),
      "a\\b",
      "a/./b",
      "a/../b",
      "a\nb",
    ]) {
      expect(isR2ObjectProbeKey(key)).toBe(false)
    }
  })

  test("rejects an already-sealed singleton with foreign diagnostic hooks", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `
        import assert from "node:assert/strict"
        import { isGlobalBunS3Sealed, sealGlobalBunS3 } from "./src/s3/sealed_r2_handle.ts"

        const foreignInspect = () => "foreign inspection"
        Object.defineProperty(Bun.s3, Bun.inspect.custom, { value: foreignInspect })
        Object.seal(Bun.s3)
        assert.equal(isGlobalBunS3Sealed(), false)
        assert.throws(() => sealGlobalBunS3(), /ERR_BUN_S3_SEAL_CONFLICT/)
        assert.equal(isGlobalBunS3Sealed(), false)
        assert.equal(Bun.s3[Bun.inspect.custom], foreignInspect)
      `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exit, stderr).toBe(0)
  })

  test("rejects raw credentials, including ANSI-separated bearer and cookie values", () => {
    const secret = "inspection-only-canary-value"
    for (const surface of [
      "Bearer opaque.fixture",
      "bEaReR \x1b[31mopaque.fixture\x1b[0m",
      "GSLIVE_SESSION_ID=opaque.fixture",
      "GSLIVE_SESSION_ID=$opaque.fixture",
      'sd_session="opaque.fixture"',
      "sd_csrf=opaque.fixture",
      "Bearer REDACTED-but-still-a-token",
      "AKIA0000000000000000",
      "ASIA0000000000000000",
      "https://fixture.invalid/object?x-amz-signature=fixture",
      secret,
    ]) {
      expect(() => assertNoSecretLeak(surface, [secret])).toThrow("ERR_INSP_SECRET_REDACTION_LEAK")
    }
    expect(() =>
      assertNoSecretLeak("Bearer REDACTED; GSLIVE_SESSION_ID=[REDACTED_SECRET]; sd_session="),
    ).not.toThrow()
  })

  test("seals Bun.s3 and keeps explicitly selected S3 credentials out of every diagnostic view", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `
        import assert from "node:assert/strict"
        import { inspect } from "node:util"
        import { createR2ObjectCheck, runRuntimePreflightAudit } from "./server/bun_r2_inspect.ts"
        import { assertNoSecretLeak, getInspectRole, isGlobalBunS3Sealed, sealGlobalBunS3, SealedR2Handle, withInspectRole } from "./src/s3/sealed_r2_handle.ts"
        import { renderThemedMarkdown } from "./src/theme/markdown_ansi.ts"
        import { readBunDnsCacheStats } from "./server/bun_dns.ts"

        const access = "fixture-explicit-r2-access"
        const secret = "fixture-explicit-r2-secret"
        const token = "fixture-explicit-r2-session"
        const options = { endpoint: "https://inspection.invalid", bucket: "inspection-fixture", accessKeyId: access, secretAccessKey: secret }
        for (const code of [10, 27, 157]) {
          const bucket = options.bucket + String.fromCharCode(code)
          assert.throws(() => new SealedR2Handle({ ...options, bucket, sessionToken: token }), /Invalid explicit R2 client configuration/)
        }
        const handle = new SealedR2Handle({ ...options, sessionToken: token })

        assert.equal(isGlobalBunS3Sealed(), false)
        Object.defineProperty(Bun.s3, Bun.inspect.custom, {
          value: () => "third-party inspection",
          configurable: true,
        })
        assert.equal(isGlobalBunS3Sealed(), false)
        assert.equal(handle.toJSON().globalS3Sealed, false)
        assert.match(Bun.inspect(handle, { colors: false }), /Global Bun\\.s3\\s+UNSEALED/)
        assert.equal(getInspectRole(), "ROLE_VIEWER")
        assert.throws(() => runRuntimePreflightAudit(), /Implicit AWS and S3 credentials are disabled/)
        process.env.CLOUDFLARE_API_TOKEN = "fixture-cloudflare-management-token"
        process.env.CLOUDFLARE_R2_API_TOKEN = "fixture-cloudflare-r2-token"
        assert.throws(() => runRuntimePreflightAudit({ allowAwsFallbackEnv: true }), /Separate Cloudflare API and R2/)
        delete process.env.CLOUDFLARE_API_TOKEN
        delete process.env.CLOUDFLARE_R2_API_TOKEN
        const audit = runRuntimePreflightAudit({ allowAwsFallbackEnv: true })
        assert.equal(audit.sealedGlobalS3, true)
        assert.equal(audit.bunVersion, Bun.version)
        assert.equal(audit.dnsRequestCount, 0)
        assert.equal(audit.dnsErrorRatioBps, 0)
        assert.deepEqual(audit.dnsCache, {
          cacheHitsCompleted: 0, cacheHitsInflight: 0, cacheMisses: 0,
          size: 0, errors: 0, totalCount: 0,
        })
        const sealedInspect = Bun.s3[Bun.inspect.custom]
        assert.equal(sealGlobalBunS3(), true)
        assert.equal(Bun.s3[Bun.inspect.custom], sealedInspect)
        assert.equal(isGlobalBunS3Sealed(), true)
        assert.match(Bun.inspect(handle, { colors: false }), /Global Bun\\.s3\\s+Sealed/)
        assert.equal(Object.isSealed(Bun.s3), true)
        assert.deepEqual(Object.keys(Bun.s3), [])
        const summary = JSON.parse(JSON.stringify(Bun.s3))
        assert.equal(summary.implicitCredentialsConfigured, true)
        assert.equal(summary.credentials, "[REDACTED_SECRET]")
        assert.throws(() => assertNoSecretLeak(Bun.env.S3_SESSION_TOKEN), /ERR_INSP_SECRET_REDACTION_LEAK/)

        assert.throws(() => new SealedR2Handle(options), /unexpected credential/)
        assert.deepEqual(Reflect.ownKeys(Object.getOwnPropertyDescriptors(handle)), [])
        assert.throws(() => handle.file("diagnostic.json"), /ERR_INSP_ROLE_DENIED/)
        await assert.rejects(handle.probeObject("diagnostic.json"), /ERR_INSP_ROLE_DENIED/)
        const check = createR2ObjectCheck({ state: "configured", handle }, "diagnostic.json")
        await assert.rejects(check(false), /ERR_INSP_ROLE_DENIED/)
        assert.deepEqual(await withInspectRole("ROLE_OPS_ADMIN", () => check(false)), { state: "not-requested" })
        assert.deepEqual(
          await withInspectRole("ROLE_OPS_ADMIN", () => handle.probeObject("broken/../diagnostic.json")),
          { state: "request-rejected", httpStatus: null, sizeBytes: null },
        )
        const view = JSON.parse(JSON.stringify(handle))
        assert.deepEqual(view, { bucket: "inspection-fixture", endpointHost: "[REDACTED_HOST]", credentials: "[REDACTED_SECRET]", globalS3Sealed: true })
        const terminal = Bun.inspect(handle, { colors: true, depth: Infinity, showHidden: true })
        assert.match(terminal, /SealedR2Handle/)
        assert.match(terminal, /\\[REDACTED_HOST\\]/)
        assert.doesNotMatch(terminal, /inspection\\.invalid/)
        assert.doesNotMatch(terminal, /\\x1b/)
        const readView = () => JSON.parse(JSON.stringify(handle)).endpointHost
        const [adminHost, viewerHost] = await Promise.all([
          withInspectRole("ROLE_OPS_ADMIN", async () => { await Promise.resolve(); return readView() }),
          withInspectRole("ROLE_VIEWER", async () => { await Promise.resolve(); return readView() }),
        ])
        assert.equal(adminHost, "inspection.invalid")
        assert.equal(viewerHost, "[REDACTED_HOST]")
        assert.equal(readView(), "[REDACTED_HOST]")
        delete process.env.NO_COLOR
        const styled = withInspectRole("ROLE_OPS_ADMIN", () => Bun.inspect(handle, { colors: true }))
        assert.match(styled, /\\x1b\\[38;2;/)
        assert.match(styled, /inspection\\.invalid/)
        assert.match(styled, /ROLE_OPS_ADMIN/)
        assert.doesNotMatch(Bun.inspect(handle, { showHidden: true, depth: Infinity, customInspect: false }), /inspection\\.invalid/)
        const help = "### [Bun](https://bun.com/)"
        assert.match(renderThemedMarkdown(help, { colors: true, hyperlinks: true }), /\\x1b\\]8;;https:\\/\\/bun\\.com\\//)
        assert.doesNotMatch(renderThemedMarkdown(help, { colors: false, hyperlinks: true }), /\\x1b/)
        const file = withInspectRole("ROLE_OPS_ADMIN", () => handle.file("diagnostic.json"))
        const presigned = new URL(file.presign())
        assert.ok(presigned.searchParams.get("X-Amz-Credential").startsWith(access + "/"))
        assert.equal(presigned.searchParams.get("X-Amz-Security-Token") === token, true)

        for (const value of [Bun.s3, handle, file]) {
          for (const surface of [
            Bun.inspect(value, { showHidden: true, depth: Infinity }),
            Bun.inspect(value, { showHidden: true, depth: Infinity, customInspect: false }),
            inspect(value, { showHidden: true, depth: Infinity }),
            JSON.stringify(value),
          ]) {
            assertNoSecretLeak(surface, [access, secret, token])
          }
        }
        const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
        const port = listener.port
        await listener.stop(true)
        await assert.rejects(fetch("http://localhost:" + port, { proxy: false, signal: AbortSignal.timeout(3000) }))
        const current = readBunDnsCacheStats()
        assert.deepEqual(current, Bun.dns.getCacheStats())
        assert.ok(current.errors > audit.dnsCache.errors)
        assert.ok(current.totalCount > audit.dnsCache.totalCount)
        assert.equal(audit.dnsCache.totalCount, 0)
        assert.throws(() => runRuntimePreflightAudit({ allowAwsFallbackEnv: true }), /ERR_DNS_CACHE_THRASH_OR_ERR_SPIKE/)
      `,
      ],
      {
        env: {
          PATH: process.env.PATH,
          NO_COLOR: "1",
          S3_ACCESS_KEY_ID: "fixture-ambient-s3-access",
          S3_SECRET_ACCESS_KEY: "fixture-ambient-s3-secret",
          S3_SESSION_TOKEN: "fixture-ambient-s3-session",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(exit, stderr).toBe(0)
  })
})
