import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import slabConfigDefault, { capacity as slabCapacity, meta as slabMeta } from "../../config/slab.toml"
import {
  ERR_TOML_LAZY_FILE,
  ERR_TOML_TOO_LARGE,
  formatTomlTemporalLiteral,
  isTemporalTomlValue,
  parseToml,
  parseTomlWithMeta,
  stringifyToml,
  stringifyTomlWithMeta,
} from "../../lib/bun_toml.ts"

const require = createRequire(import.meta.url)

describe("Bun.TOML.parse() & cross-runtime TOML v1.1.0 engine", () => {
  test("parses TOML tables, arrays, numbers, floats, dotted keys, and arrays-of-tables identically on Bun native and fallback", () => {
    const sample = `
# Application config
title = "My App"
version = "1.0.0"
debug = true
hex = 0xdead_beef
oct = 0o755
bin = 0b1101_0110
pos_inf = inf
neg_inf = -inf
not_num = nan
a.b.c = "dotted"

[owner]
name = "John Doe"

[database]
enabled = true
ports = [8000, 8001, 8002]
connection_max = 5000

[servers.alpha]
ip = "10.0.0.1"
role = "frontend"

[servers.beta]
ip = "10.0.0.2"
role = "backend"

[[points]]
x = 1
y = 2

[[points]]
x = 3
y = 4
`
    const nativeRes = parseTomlWithMeta<Record<string, unknown>>(sample)
    const fallbackRes = parseTomlWithMeta<Record<string, unknown>>(sample, {
      forceFallback: true,
    })

    expect(nativeRes.engine).toBe("bun-native")
    expect(fallbackRes.engine).toBe("smol-toml-fallback")
    expect(nativeRes.byteLength).toBe(fallbackRes.byteLength)

    expect(nativeRes.value.title).toBe("My App")
    expect(nativeRes.value.hex).toBe(0xdeadbeef)
    expect(nativeRes.value.oct).toBe(0o755)
    expect(nativeRes.value.bin).toBe(0b11010110)
    expect(nativeRes.value.pos_inf).toBe(Infinity)
    expect(nativeRes.value.neg_inf).toBe(-Infinity)
    expect(Number.isNaN(nativeRes.value.not_num)).toBe(true)
    expect(nativeRes.value.a).toEqual({ b: { c: "dotted" } })
    expect(nativeRes.value.servers).toEqual({
      alpha: { ip: "10.0.0.1", role: "frontend" },
      beta: { ip: "10.0.0.2", role: "backend" },
    })
    expect(nativeRes.value.points).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ])

    // Parity between native Bun.TOML.parse and Node fallback
    expect(fallbackRes.value).toEqual(nativeRes.value)
  })

  test("supports TOML v1.1.0 escapes (\\xHH, \\e) and multi-line inline tables on native Bun.TOML.parse", () => {
    const v11Doc = `
esc = "\\e[31mred\\x21"
point = {
  x = 10,
  y = 20,
}
`
    const res = parseTomlWithMeta<{ esc: string; point: { x: number; y: number } }>(v11Doc)
    expect(res.engine).toBe("bun-native")
    expect(res.value.esc).toBe("\x1b[31mred!")
    expect(res.value.point).toEqual({ x: 10, y: 20 })
  })

  test("maps all four TOML date/time types onto Temporal objects without stripping instances", () => {
    const doc = parseToml<{
      created: Temporal.Instant
      meeting: Temporal.PlainDateTime
      birthday: Temporal.PlainDate
      opens: Temporal.PlainTime
      truncated: Temporal.Instant
    }>(`
created = 1979-05-27T00:32:00-07:00
meeting = 1979-05-27T07:32:00
birthday = 1979-05-27
opens = 07:32:00
truncated = 1979-05-27T07:32:00.123456789999Z
`)

    expect(doc.created instanceof Temporal.Instant).toBe(true)
    expect(doc.created.toString()).toBe("1979-05-27T07:32:00Z")
    expect(doc.meeting instanceof Temporal.PlainDateTime).toBe(true)
    expect(doc.meeting.toString()).toBe("1979-05-27T07:32:00")
    expect(doc.birthday instanceof Temporal.PlainDate).toBe(true)
    expect(doc.birthday.toString()).toBe("1979-05-27")
    expect(doc.opens instanceof Temporal.PlainTime).toBe(true)
    expect(doc.opens.toString()).toBe("07:32:00")
    expect(doc.truncated.toString()).toBe("1979-05-27T07:32:00.123456789Z")
    expect(isTemporalTomlValue(doc.created)).toBe(true)
    expect(isTemporalTomlValue(doc.meeting)).toBe(true)
    expect(isTemporalTomlValue(doc.birthday)).toBe(true)
    expect(isTemporalTomlValue(doc.opens)).toBe(true)
  })

  test("enforces safe integer bounds, SyntaxError on malformed TOML, lazy Bun.file rejection, byte caps, and prototype sanitization", () => {
    expect(() => parseToml("too_big = 9007199254740992")).toThrow()
    expect(() => parseToml("invalid = = =")).toThrow(SyntaxError)

    const lazyFile = Bun.file("config/slab.toml")
    expect(() => parseToml(lazyFile as unknown as string)).toThrow(TypeError)
    expect(() => parseToml(lazyFile as unknown as string)).toThrow(ERR_TOML_LAZY_FILE)

    expect(() => parseToml('a = "hello"\n', { maxBytes: 4 })).toThrow(ERR_TOML_TOO_LARGE)

    const clean = parseToml<Record<string, unknown>>(
      `["__proto__"]\npolluted = true\n[safe]\nok = 1\n`,
    )
    expect(Object.prototype.hasOwnProperty.call(clean, "__proto__")).toBe(false)
    expect(clean.safe).toEqual({ ok: 1 })
  })

  test("parses all committed workspace TOML files identically on native Bun.TOML.parse and fallback", () => {
    const workspaceTomlFiles = [
      "bunfig.toml",
      "config/slab.toml",
      "config/wager_tiers.toml",
      "design/tokens.toml",
      "packages/ui/src/config/dashboard.toml",
      "packages/ui/src/config/wagers.toml",
    ]
    for (const relPath of workspaceTomlFiles) {
      const text = readFileSync(resolve(process.cwd(), relPath), "utf8")
      const nativeRes = parseTomlWithMeta(text)
      const fallbackRes = parseTomlWithMeta(text, { forceFallback: true })
      expect(nativeRes.engine).toBe("bun-native")
      expect(fallbackRes.engine).toBe("smol-toml-fallback")
      expect(nativeRes.value).toEqual(fallbackRes.value)
    }
  })
})

describe("Bun.TOML.stringify() & TS fallback parity", () => {
  test("serializes scalars first, followed by [table] and [[array-of-tables]], and round-trips cleanly", () => {
    const input = {
      name: "app",
      debug: true,
      tags: ["web", "api"],
      server: { host: "localhost", port: 8080 },
      points: [
        { x: 1, meta: { label: "a" } },
        { x: 2, meta: { label: "b" } },
      ],
    }

    const nativeRes = stringifyTomlWithMeta(input)
    const fallbackRes = stringifyTomlWithMeta(input, { forceFallback: true })

    expect(nativeRes.engine).toBe("bun-native")
    expect(fallbackRes.engine).toBe("ts-fallback")
    expect(nativeRes.toml).toBeDefined()
    expect(fallbackRes.toml).toBeDefined()

    expect(parseToml(nativeRes.toml!)).toEqual(input)
    expect(parseToml(fallbackRes.toml!)).toEqual(input)
    expect(fallbackRes.toml).toBe(nativeRes.toml)
  })

  test("round-trips Temporal date/times, ZonedDateTime, and Date across both engines", () => {
    const zdt = Temporal.ZonedDateTime.from("2026-11-22T14:30:00-08:00[America/Los_Angeles]")
    const input = {
      created: Temporal.Instant.from("1979-05-27T07:32:00Z"),
      meeting: Temporal.PlainDateTime.from("1979-05-27T07:32:00"),
      birthday: Temporal.PlainDate.from("1979-05-27"),
      opens: Temporal.PlainTime.from("07:32:00"),
      zoned: zdt,
      jsDate: new Date("2026-11-22T22:30:00.000Z"),
    }

    expect(formatTomlTemporalLiteral(zdt)).toBe("2026-11-22T14:30:00-08:00")

    for (const forceFallback of [false, true]) {
      const serialized = stringifyToml(input, { forceFallback })!
      expect(serialized).toContain("created = 1979-05-27T07:32:00Z")
      expect(serialized).toContain("meeting = 1979-05-27T07:32:00")
      expect(serialized).toContain("birthday = 1979-05-27")
      expect(serialized).toContain("opens = 07:32:00")
      expect(serialized).toContain("zoned = 2026-11-22T14:30:00-08:00")
      expect(serialized).toContain("jsDate = 2026-11-22T22:30:00Z")

      const reparsed = parseToml<{
        created: Temporal.Instant
        meeting: Temporal.PlainDateTime
        birthday: Temporal.PlainDate
        opens: Temporal.PlainTime
        zoned: Temporal.Instant
        jsDate: Temporal.Instant
      }>(serialized)
      expect(reparsed.created.equals(input.created)).toBe(true)
      expect(reparsed.meeting.equals(input.meeting)).toBe(true)
      expect(reparsed.birthday.equals(input.birthday)).toBe(true)
      expect(reparsed.opens.equals(input.opens)).toBe(true)
      expect(reparsed.zoned.equals(zdt.toInstant())).toBe(true)
      expect(reparsed.jsDate.epochMilliseconds).toBe(input.jsDate.getTime())
    }
  })

  test("enforces TOML.stringify edge cases identically on Bun native and TS fallback", () => {
    for (const forceFallback of [false, true]) {
      const opts = { forceFallback }

      // Top-level undefined, function, and symbol return undefined
      expect(stringifyToml(undefined, opts)).toBeUndefined()
      expect(stringifyToml(() => {}, opts)).toBeUndefined()
      expect(stringifyToml(Symbol("top"), opts)).toBeUndefined()

      // Object properties with undefined, function, or symbol values are skipped
      expect(
        stringifyToml(
          {
            keep: "yes",
            skipUndef: undefined,
            skipFn: () => 1,
            skipSym: Symbol("v"),
          },
          opts,
        ),
      ).toBe('keep = "yes"\n')

      // Special floats
      expect(stringifyToml({ a: Infinity, b: -Infinity, c: NaN }, opts)).toBe(
        "a = inf\nb = -inf\nc = nan\n",
      )

      // Top-level non-object throws
      expect(() => stringifyToml(null, opts)).toThrow()
      expect(() => stringifyToml(123, opts)).toThrow()
      expect(() => stringifyToml([1, 2], opts)).toThrow()

      // Unsupported values throw
      expect(() => stringifyToml({ x: null }, opts)).toThrow()
      expect(() => stringifyToml({ x: 1n }, opts)).toThrow()
      expect(() => stringifyToml({ x: [1, undefined] }, opts)).toThrow()
      expect(() => stringifyToml({ x: [() => {}] }, opts)).toThrow()
      expect(() => stringifyToml({ x: new Date("invalid") }, opts)).toThrow()
      expect(() => stringifyToml({ x: Temporal.PlainDate.from("+010000-01-01") }, opts)).toThrow()
      expect(() => stringifyToml({ x: Temporal.PlainYearMonth.from("2026-11") }, opts)).toThrow()
      expect(() => stringifyToml({ x: Temporal.PlainMonthDay.from("11-22") }, opts)).toThrow()
      expect(() => stringifyToml({ x: Temporal.Duration.from({ hours: 1 }) }, opts)).toThrow()

      // Circular structures throw
      const cyclic: Record<string, unknown> = { name: "loop" }
      cyclic.self = cyclic
      expect(() => stringifyToml(cyclic, opts)).toThrow()
    }
  })
})

describe("Bun native .toml module imports (ESM, CJS require, dynamic import, import attributes)", () => {
  test("supports static default & named ES imports from .toml files", () => {
    expect(slabConfigDefault.meta.schema).toBe("sportsdesk-slab/v1")
    expect(slabMeta.schema).toBe("sportsdesk-slab/v1")
    expect(slabCapacity.ticker_window_bytes).toBe(slabConfigDefault.capacity.ticker_window_bytes)
  })

  test("supports CommonJS require(), dynamic import(), and with { type: 'toml' } import attributes", async () => {
    const viaRequire = require("../../config/slab.toml") as {
      meta: { schema: string }
      capacity: { ticker_window_bytes: number }
    }
    expect(viaRequire.meta.schema).toBe("sportsdesk-slab/v1")
    expect(viaRequire.capacity.ticker_window_bytes).toBe(slabCapacity.ticker_window_bytes)

    const viaDynamic = await import("../../config/slab.toml")
    expect(viaDynamic.default.meta.schema).toBe("sportsdesk-slab/v1")
    expect(viaDynamic.meta.schema).toBe("sportsdesk-slab/v1")

    const dir = mkdtempSync(join(tmpdir(), "bun-toml-attr-"))
    try {
      const customPath = join(dir, "custom.cfg")
      writeFileSync(
        customPath,
        stringifyToml({
          service: "sportsdesk",
          limits: { maxRetries: 3, timeoutMs: 2500 },
        })!,
      )
      const viaAttr = await import(customPath, { with: { type: "toml" } })
      expect(viaAttr.default).toEqual({
        service: "sportsdesk",
        limits: { maxRetries: 3, timeoutMs: 2500 },
      })
      expect(viaAttr.limits).toEqual({ maxRetries: 3, timeoutMs: 2500 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
