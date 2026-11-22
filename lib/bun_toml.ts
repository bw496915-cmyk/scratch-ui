/**
 * @file lib/bun_toml.ts
 * @description First-class `Bun.TOML.parse()` & `Bun.TOML.stringify()` runtime wrapper
 * with seamless Node.js fallback (`smol-toml` for parsing, spec-faithful pure-TS
 * TOML v1.1.0 serializer for stringifying).
 *
 * Parity with Bun 1.4.4's native TOML v1.1.0 engine (`import { TOML } from "bun"`):
 * - Prefers native `Bun.TOML.parse()` and `Bun.TOML.stringify()` under Bun.
 * - Preserves `Temporal.Instant`, `Temporal.PlainDateTime`, `Temporal.PlainDate`,
 *   and `Temporal.PlainTime` instances intact (never strips or corrupts them during
 *   prototype-pollution sanitization).
 * - Rejects lazy `Bun.file(...)` blobs cleanly before parsing (Bun's `TOML.parse`
 *   expects a string, not a file-backed `BunFile` blob).
 * - Matches `Bun.TOML.stringify()` semantics across both native Bun and Node.js:
 *   scalar keys first, `[table]` and `[[array-of-tables]]` sections, Temporal &
 *   Date round-tripping, skipping `undefined`/function/symbol object properties,
 *   returning `undefined` for top-level `undefined`/function/symbol, and throwing on
 *   `null`, `BigInt`, cycles, invalid `Date`s, out-of-range years, unsupported
 *   Temporal types (`PlainYearMonth`, `PlainMonthDay`, `Duration`), and array holes.
 */

import { parse as parseTomlSmol } from "smol-toml"

export const MAX_TOML_INPUT_BYTES = 1_048_576 // 1 MiB

export const ERR_TOML_TOO_LARGE = "ERR_TOML_TOO_LARGE" as const
export const ERR_TOML_LAZY_FILE = "ERR_TOML_LAZY_FILE" as const

export type BunTomlParseEngine = "bun-native" | "smol-toml-fallback"
export type BunTomlStringifyEngine = "bun-native" | "ts-fallback"

export interface ParseBunTomlOptions {
  /** Force the `smol-toml` fallback even when running on Bun (useful for parity tests). */
  readonly forceFallback?: boolean | undefined
  /** Maximum accepted UTF-8 input size in bytes (default 1 MiB). */
  readonly maxBytes?: number | undefined
}

export interface ParsedBunTomlResult<T = Record<string, unknown>> {
  readonly value: T
  readonly engine: BunTomlParseEngine
  readonly byteLength: number
}

export interface StringifyBunTomlOptions {
  /** Force the pure-TypeScript TOML serializer even when running on Bun. */
  readonly forceFallback?: boolean | undefined
}

export interface StringifiedBunTomlResult {
  readonly toml: string | undefined
  readonly engine: BunTomlStringifyEngine
}

interface NativeBunTomlApi {
  readonly parse: (input: string) => unknown
  readonly stringify?: (value: unknown) => string | undefined
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

const TEMPORAL_SUPPORTED_TAGS = new Set([
  "Temporal.Instant",
  "Temporal.PlainDateTime",
  "Temporal.PlainDate",
  "Temporal.PlainTime",
  "Temporal.ZonedDateTime",
])

const TEMPORAL_UNSUPPORTED_TAGS = new Set([
  "Temporal.PlainYearMonth",
  "Temporal.PlainMonthDay",
  "Temporal.Duration",
])

function getNativeBunToml(): NativeBunTomlApi | null {
  const bunObj = (globalThis as Record<string, unknown>).Bun as
    | { readonly TOML?: NativeBunTomlApi }
    | undefined
  if (typeof bunObj?.TOML?.parse === "function") {
    return bunObj.TOML
  }
  return null
}

function getStringTag(value: unknown): string {
  if (typeof value !== "object" || value === null) return ""
  const tag = (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag]
  return typeof tag === "string" ? tag : ""
}

/**
 * Returns `true` if `value` is a Temporal object that maps onto a TOML date/time literal
 * (`Temporal.Instant`, `Temporal.PlainDateTime`, `Temporal.PlainDate`, `Temporal.PlainTime`,
 * or `Temporal.ZonedDateTime`).
 */
export function isTemporalTomlValue(value: unknown): boolean {
  return TEMPORAL_SUPPORTED_TAGS.has(getStringTag(value))
}

function isOpaqueDateOrTemporal(value: unknown): boolean {
  if (value instanceof Date) return true
  const tag = getStringTag(value)
  return TEMPORAL_SUPPORTED_TAGS.has(tag) || TEMPORAL_UNSUPPORTED_TAGS.has(tag)
}

function assertTextInput(input: unknown): string {
  if (typeof input === "string") return input
  if (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { text?: unknown }).text === "function" &&
    typeof (input as { size?: unknown }).size === "number"
  ) {
    throw new TypeError(
      `${ERR_TOML_LAZY_FILE}: Bun.TOML.parse expects a string, not a lazy Bun.file() / Blob — await file.text() first`,
    )
  }
  throw new TypeError(`Bun.TOML.parse expects a TOML string (got ${typeof input})`)
}

function sanitizeParsedValue(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node
  if (isOpaqueDateOrTemporal(node)) return node

  if (Array.isArray(node)) {
    return node.map((item) => sanitizeParsedValue(item))
  }

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (UNSAFE_KEYS.has(key)) continue
    out[key] = sanitizeParsedValue(val)
  }
  return out
}

/**
 * Parse a TOML document with engine metadata, preferring Bun's native TOML v1.1.0
 * parser (`Bun.TOML.parse`) and falling back to `smol-toml` under Node.js.
 */
export function parseTomlWithMeta<T = Record<string, unknown>>(
  input: string,
  options: ParseBunTomlOptions = {},
): ParsedBunTomlResult<T> {
  const text = assertTextInput(input)
  const byteLength = new TextEncoder().encode(text).byteLength
  const maxBytes = options.maxBytes ?? MAX_TOML_INPUT_BYTES
  if (byteLength > maxBytes) {
    throw new RangeError(
      `${ERR_TOML_TOO_LARGE}: TOML input is ${byteLength} bytes (max ${maxBytes} bytes)`,
    )
  }

  const nativeApi = options.forceFallback ? null : getNativeBunToml()
  if (nativeApi) {
    const parsed = nativeApi.parse(text)
    return {
      value: sanitizeParsedValue(parsed) as T,
      engine: "bun-native",
      byteLength,
    }
  }

  const parsed = parseTomlSmol(text)
  return {
    value: sanitizeParsedValue(parsed) as T,
    engine: "smol-toml-fallback",
    byteLength,
  }
}

/**
 * Parse a TOML string into a JavaScript object using native `Bun.TOML.parse()`
 * under Bun (with `smol-toml` fallback under Node.js).
 */
export function parseToml<T = Record<string, unknown>>(
  input: string,
  options: ParseBunTomlOptions = {},
): T {
  return parseTomlWithMeta<T>(input, options).value
}

// ── TOML v1.1.0 Serializer (`Bun.TOML.stringify` + pure-TS fallback) ─────────

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/

function formatTomlKey(key: string): string {
  return BARE_KEY_RE.test(key) ? key : formatTomlString(key)
}

function formatTomlString(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    const code = value.charCodeAt(i)
    if (ch === "\\") out += "\\\\"
    else if (ch === '"') out += '\\"'
    else if (code === 0x08) out += "\\b"
    else if (code === 0x09) out += "\\t"
    else if (code === 0x0a) out += "\\n"
    else if (code === 0x0c) out += "\\f"
    else if (code === 0x0d) out += "\\r"
    else if (code < 0x20 || code === 0x7f) {
      out += `\\u${code.toString(16).padStart(4, "0")}`
    } else {
      out += ch
    }
  }
  return `${out}"`
}

function assertFourDigitYear(year: number, label: string): void {
  if (!Number.isInteger(year) || year < 0 || year > 9999) {
    throw new RangeError(
      `TOML.stringify cannot serialize ${label} with year ${year} (TOML requires 0000–9999)`,
    )
  }
}

/**
 * Formats a supported `Date` or `Temporal.*` object into its canonical TOML
 * date/time literal (dropping timezone/calendar bracket annotations per TOML 1.1).
 */
export function formatTomlTemporalLiteral(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RangeError("TOML.stringify cannot serialize an invalid Date")
    }
    assertFourDigitYear(value.getUTCFullYear(), "Date")
    return value.toISOString().replace(/\.000Z$/, "Z")
  }

  const tag = getStringTag(value)
  if (TEMPORAL_UNSUPPORTED_TAGS.has(tag)) {
    throw new TypeError(
      `TOML.stringify cannot serialize ${tag} (it has no TOML representation)`,
    )
  }
  if (!TEMPORAL_SUPPORTED_TAGS.has(tag)) return null

  const obj = value as {
    readonly year?: number
    readonly epochMilliseconds?: number
    toString(opts?: Record<string, unknown>): string
  }

  if (tag === "Temporal.Instant") {
    const ms = typeof obj.epochMilliseconds === "number" ? obj.epochMilliseconds : NaN
    if (Number.isFinite(ms)) {
      const year = new Date(ms).getUTCFullYear()
      assertFourDigitYear(year, tag)
    }
    const iso = obj.toString()
    if (!/^\d{4}-/.test(iso)) {
      throw new RangeError(`TOML.stringify cannot serialize ${tag} outside years 0000–9999`)
    }
    return iso
  }

  if (tag === "Temporal.ZonedDateTime") {
    if (typeof obj.year === "number") assertFourDigitYear(obj.year, tag)
    // Strip bracketed [TimeZone] and [u-ca=...] annotations; keep ISO offset date-time.
    const iso = obj.toString({ timeZoneName: "never", calendarName: "never" })
    if (!/^\d{4}-/.test(iso)) {
      throw new RangeError(`TOML.stringify cannot serialize ${tag} outside years 0000–9999`)
    }
    return iso
  }

  if (tag === "Temporal.PlainDateTime" || tag === "Temporal.PlainDate") {
    if (typeof obj.year === "number") assertFourDigitYear(obj.year, tag)
    const iso = obj.toString({ calendarName: "never" })
    if (!/^\d{4}-/.test(iso)) {
      throw new RangeError(`TOML.stringify cannot serialize ${tag} outside years 0000–9999`)
    }
    return iso
  }

  // Temporal.PlainTime
  return obj.toString()
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  if (value instanceof Date) return false
  const tag = getStringTag(value)
  if (TEMPORAL_SUPPORTED_TAGS.has(tag) || TEMPORAL_UNSUPPORTED_TAGS.has(tag)) return false
  return true
}

function isSkippedPropertyValue(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol"
}

function isArrayOfTables(value: unknown): value is readonly Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => isPlainTable(item))
}

function stringifyTomlFallback(root: unknown): string | undefined {
  if (isSkippedPropertyValue(root)) {
    return undefined
  }
  if (!isPlainTable(root)) {
    throw new TypeError(
      "TOML.stringify expects an object at the top level (a TOML document is a table)",
    )
  }

  const active = new Set<object>()

  function formatInlineValue(val: unknown): string {
    if (val === null) {
      throw new TypeError("TOML.stringify cannot serialize null (TOML has no null type)")
    }
    if (typeof val === "bigint") {
      throw new TypeError("TOML.stringify cannot serialize BigInt")
    }
    if (isSkippedPropertyValue(val)) {
      throw new TypeError(`TOML cannot represent ${typeof val} in an array`)
    }
    if (typeof val === "boolean") {
      return val ? "true" : "false"
    }
    if (typeof val === "number") {
      if (Number.isNaN(val)) return "nan"
      if (val === Infinity) return "inf"
      if (val === -Infinity) return "-inf"
      return Object.is(val, -0) ? "-0.0" : String(val)
    }
    if (typeof val === "string") {
      return formatTomlString(val)
    }

    const temporalLiteral = formatTomlTemporalLiteral(val)
    if (temporalLiteral !== null) return temporalLiteral

    if (Array.isArray(val)) {
      if (active.has(val)) {
        throw new TypeError("TOML.stringify cannot serialize circular structure")
      }
      active.add(val)
      const items = val.map((item) => formatInlineValue(item))
      active.delete(val)
      return `[${items.join(", ")}]`
    }

    if (isPlainTable(val)) {
      if (active.has(val)) {
        throw new TypeError("TOML.stringify cannot serialize circular structure")
      }
      active.add(val)
      const pairs: string[] = []
      for (const [k, v] of Object.entries(val)) {
        if (isSkippedPropertyValue(v)) continue
        pairs.push(`${formatTomlKey(k)} = ${formatInlineValue(v)}`)
      }
      active.delete(val)
      return `{ ${pairs.join(", ")} }`
    }

    throw new TypeError(`TOML.stringify cannot serialize value of type ${typeof val}`)
  }

  const blocks: string[] = []

  function emitTable(table: Record<string, unknown>, path: readonly string[], emitHeader: boolean) {
    if (active.has(table)) {
      throw new TypeError("TOML.stringify cannot serialize circular structure")
    }
    active.add(table)

    const scalars: string[] = []
    const childTables: Array<{ key: string; value: Record<string, unknown> }> = []
    const childTableArrays: Array<{ key: string; value: readonly Record<string, unknown>[] }> = []

    for (const [key, val] of Object.entries(table)) {
      if (isSkippedPropertyValue(val)) continue
      if (val === null) {
        throw new TypeError("TOML.stringify cannot serialize null (TOML has no null type)")
      }
      if (typeof val === "bigint") {
        throw new TypeError("TOML.stringify cannot serialize BigInt")
      }
      const temporalLiteral = formatTomlTemporalLiteral(val)
      if (temporalLiteral !== null) {
        scalars.push(`${formatTomlKey(key)} = ${temporalLiteral}`)
      } else if (isPlainTable(val)) {
        childTables.push({ key, value: val })
      } else if (isArrayOfTables(val)) {
        childTableArrays.push({ key, value: val })
      } else {
        scalars.push(`${formatTomlKey(key)} = ${formatInlineValue(val)}`)
      }
    }

    if (emitHeader && path.length > 0) {
      const header = `[${path.map(formatTomlKey).join(".")}]`
      if (scalars.length > 0 || (childTables.length === 0 && childTableArrays.length === 0)) {
        blocks.push([header, ...scalars].join("\n"))
      }
    } else if (scalars.length > 0) {
      blocks.push(scalars.join("\n"))
    }

    for (const child of childTables) {
      emitTable(child.value, [...path, child.key], true)
    }

    for (const arrChild of childTableArrays) {
      emitArrayOfTables(arrChild.value, [...path, arrChild.key])
    }

    active.delete(table)
  }

  function emitArrayOfTables(
    items: readonly Record<string, unknown>[],
    path: readonly string[],
  ) {
    const header = `[[${path.map(formatTomlKey).join(".")}]]`
    for (const item of items) {
      if (active.has(item)) {
        throw new TypeError("TOML.stringify cannot serialize circular structure")
      }
      active.add(item)
      const itemScalars: string[] = []
      const itemTables: Array<{ key: string; value: Record<string, unknown> }> = []
      const itemArrays: Array<{ key: string; value: readonly Record<string, unknown>[] }> = []

      for (const [k, v] of Object.entries(item)) {
        if (isSkippedPropertyValue(v)) continue
        if (v === null) {
          throw new TypeError("TOML.stringify cannot serialize null (TOML has no null type)")
        }
        if (typeof v === "bigint") {
          throw new TypeError("TOML.stringify cannot serialize BigInt")
        }
        const temporalLiteral = formatTomlTemporalLiteral(v)
        if (temporalLiteral !== null) {
          itemScalars.push(`${formatTomlKey(k)} = ${temporalLiteral}`)
        } else if (isPlainTable(v)) {
          itemTables.push({ key: k, value: v })
        } else if (isArrayOfTables(v)) {
          itemArrays.push({ key: k, value: v })
        } else {
          itemScalars.push(`${formatTomlKey(k)} = ${formatInlineValue(v)}`)
        }
      }

      blocks.push([header, ...itemScalars].join("\n"))
      for (const sub of itemTables) {
        emitTable(sub.value, [...path, sub.key], true)
      }
      for (const subArr of itemArrays) {
        emitArrayOfTables(subArr.value, [...path, subArr.key])
      }
      active.delete(item)
    }
  }

  emitTable(root, [], false)
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : ""
}

/**
 * Serialize a JS object to TOML with engine metadata, preferring native
 * `Bun.TOML.stringify()` under Bun and falling back to a spec-faithful pure-TS
 * serializer under Node.js.
 */
export function stringifyTomlWithMeta(
  value: unknown,
  options: StringifyBunTomlOptions = {},
): StringifiedBunTomlResult {
  const nativeApi = options.forceFallback ? null : getNativeBunToml()
  if (typeof nativeApi?.stringify === "function") {
    return {
      toml: nativeApi.stringify(value),
      engine: "bun-native",
    }
  }
  return {
    toml: stringifyTomlFallback(value),
    engine: "ts-fallback",
  }
}

/**
 * Serialize a JavaScript object to a TOML document using native `Bun.TOML.stringify()`
 * under Bun (with pure-TS fallback under Node.js).
 */
export function stringifyToml(
  value: unknown,
  options: StringifyBunTomlOptions = {},
): string | undefined {
  return stringifyTomlWithMeta(value, options).toml
}
