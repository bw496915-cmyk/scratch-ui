/**
 * @file lib/bun_toml.ts
 * @description First-class `Bun.TOML.parse()` and `Bun.TOML.stringify()` runtime
 * wrapper with Node.js fallback (`smol-toml` for parsing and a pure-TypeScript
 * TOML v1.1.0 serializer for stringifying).
 */

import assert from "node:assert"

import { parse as parseTomlSmol } from "smol-toml"

export const MAX_TOML_INPUT_BYTES = 1_048_576
export const ERR_TOML_TOO_LARGE = "ERR_TOML_TOO_LARGE" as const
export const ERR_TOML_LAZY_FILE = "ERR_TOML_LAZY_FILE" as const

export type BunTomlParseEngine = "bun-native" | "smol-toml-fallback"
export type BunTomlStringifyEngine = "bun-native" | "ts-fallback"

export interface ParseBunTomlOptions {
    readonly forceFallback?: boolean | undefined
    readonly maxBytes?: number | undefined
}

export interface ParsedBunTomlResult<T = Record<string, unknown>> {
    readonly value: T
    readonly engine: BunTomlParseEngine
    readonly byteLength: number
}

export interface StringifyBunTomlOptions {
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
const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/
const FOUR_DIGIT_YEAR_RE = /^\d{4}-/
const TEXT_ENCODER = new TextEncoder()

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

const ESCAPE_TABLE: Record<number, string> = {
    0x08: "\\b",
    0x09: "\\t",
    0x0a: "\\n",
    0x0c: "\\f",
    0x0d: "\\r",
    0x22: '\\"',
    0x5c: "\\\\",
}

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
    if (typeof value !== "object" || value === null) {
        return ""
    }
    const tag = (value as { [Symbol.toStringTag]?: unknown })[Symbol.toStringTag]
    return typeof tag === "string" ? tag : ""
}

export function isTemporalTomlValue(value: unknown): boolean {
    return TEMPORAL_SUPPORTED_TAGS.has(getStringTag(value))
}

function sanitizeParsedValue(node: unknown): unknown {
    if (node === null || typeof node !== "object") {
        return node
    }
    const tag = getStringTag(node)
    if (
        node instanceof Date ||
        TEMPORAL_SUPPORTED_TAGS.has(tag) ||
        TEMPORAL_UNSUPPORTED_TAGS.has(tag)
    ) {
        return node
    }
    if (Array.isArray(node)) {
        return node.map(sanitizeParsedValue)
    }

    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
        if (UNSAFE_KEYS.has(key)) {
            continue
        }
        out[key] = sanitizeParsedValue(val)
    }
    return out
}

export function parseTomlWithMeta<T = Record<string, unknown>>(
    input: string,
    options: ParseBunTomlOptions = {},
): ParsedBunTomlResult<T> {
    if (typeof input !== "string") {
        const maybeFile = input as { text?: unknown; size?: unknown } | null
        if (
            typeof maybeFile === "object" &&
            maybeFile !== null &&
            typeof maybeFile.text === "function" &&
            typeof maybeFile.size === "number"
        ) {
            throw new TypeError(
                `${ERR_TOML_LAZY_FILE}: Bun.TOML.parse expects a string, ` +
                    "not a lazy Bun.file() / Blob — await file.text() first",
            )
        }
        throw new TypeError(
            `Bun.TOML.parse expects a TOML string (got ${typeof input})`,
        )
    }

    const byteLength = TEXT_ENCODER.encode(input).byteLength
    const maxBytes = options.maxBytes ?? MAX_TOML_INPUT_BYTES
    if (byteLength > maxBytes) {
        throw new RangeError(
            `${ERR_TOML_TOO_LARGE}: TOML input is ${byteLength} bytes ` +
                `(max ${maxBytes} bytes)`,
        )
    }

    const nativeApi = options.forceFallback ? null : getNativeBunToml()
    const engine: BunTomlParseEngine = nativeApi
        ? "bun-native"
        : "smol-toml-fallback"
    const parsed = nativeApi ? nativeApi.parse(input) : parseTomlSmol(input)
    return {
        value: sanitizeParsedValue(parsed) as T,
        engine,
        byteLength,
    }
}

export function parseToml<T = Record<string, unknown>>(
    input: string,
    options: ParseBunTomlOptions = {},
): T {
    return parseTomlWithMeta<T>(input, options).value
}

function formatTomlString(value: string): string {
    let out = '"'
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i)
        const mapped = ESCAPE_TABLE[code]
        if (mapped !== undefined) {
            out += mapped
        } else if (code < 0x20 || code === 0x7f) {
            out += `\\u${code.toString(16).padStart(4, "0")}`
        } else {
            out += value[i]!
        }
    }
    return `${out}"`
}

function formatTomlKey(key: string): string {
    return BARE_KEY_RE.test(key) ? key : formatTomlString(key)
}

export function formatTomlTemporalLiteral(value: unknown): string | null {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw new RangeError(
                "TOML.stringify cannot serialize an invalid Date",
            )
        }
        const iso = value.toISOString().replace(/\.000Z$/, "Z")
        if (!FOUR_DIGIT_YEAR_RE.test(iso)) {
            throw new RangeError(
                "TOML.stringify cannot serialize Date outside years 0000–9999",
            )
        }
        return iso
    }

    const tag = getStringTag(value)
    if (TEMPORAL_UNSUPPORTED_TAGS.has(tag)) {
        throw new TypeError(
            `TOML.stringify cannot serialize ${tag} ` +
                "(it has no TOML representation)",
        )
    }
    if (!TEMPORAL_SUPPORTED_TAGS.has(tag)) {
        return null
    }

    const temporal = value as {
        toString(opts?: Record<string, unknown>): string
    }
    if (tag === "Temporal.PlainTime") {
        return temporal.toString()
    }

    const iso =
        tag === "Temporal.Instant"
            ? temporal.toString()
            : tag === "Temporal.ZonedDateTime"
              ? temporal.toString({
                    timeZoneName: "never",
                    calendarName: "never",
                })
              : temporal.toString({ calendarName: "never" })

    if (!FOUR_DIGIT_YEAR_RE.test(iso)) {
        throw new RangeError(
            `TOML.stringify cannot serialize ${tag} outside years 0000–9999`,
        )
    }
    return iso
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
    if (
        typeof value !== "object" ||
        value === null ||
        Array.isArray(value) ||
        value instanceof Date
    ) {
        return false
    }
    const tag = getStringTag(value)
    return (
        !TEMPORAL_SUPPORTED_TAGS.has(tag) && !TEMPORAL_UNSUPPORTED_TAGS.has(tag)
    )
}

function isSkippedValue(value: unknown): boolean {
    return (
        value === undefined ||
        typeof value === "function" ||
        typeof value === "symbol"
    )
}

type SectionMode = "root" | "table" | "array-item"

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

    if (isSkippedValue(value)) {
        return { toml: undefined, engine: "ts-fallback" }
    }
    if (!isPlainTable(value)) {
        throw new TypeError(
            "TOML.stringify expects an object at the top level " +
                "(a TOML document is a table)",
        )
    }

    const active = new Set<object>()
    const blocks: string[] = []

    function formatInlineValue(val: unknown): string {
        if (val === null) {
            throw new TypeError(
                "TOML.stringify cannot serialize null (TOML has no null type)",
            )
        }
        if (typeof val === "bigint") {
            throw new TypeError("TOML.stringify cannot serialize BigInt")
        }
        if (isSkippedValue(val)) {
            throw new TypeError(`TOML cannot represent ${typeof val} in an array`)
        }
        if (typeof val === "boolean") {
            return val ? "true" : "false"
        }
        if (typeof val === "number") {
            if (Number.isNaN(val)) {
                return "nan"
            }
            if (!Number.isFinite(val)) {
                return val > 0 ? "inf" : "-inf"
            }
            return Object.is(val, -0) ? "-0.0" : String(val)
        }
        if (typeof val === "string") {
            return formatTomlString(val)
        }

        const temporal = formatTomlTemporalLiteral(val)
        if (temporal !== null) {
            return temporal
        }

        assert(typeof val === "object", "Remaining TOML inline value must be an object")
        if (active.has(val)) {
            throw new TypeError(
                "TOML.stringify cannot serialize circular structure",
            )
        }
        active.add(val)
        try {
            if (Array.isArray(val)) {
                return `[${val.map(formatInlineValue).join(", ")}]`
            }
            const pairs: string[] = []
            for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
                if (isSkippedValue(v)) {
                    continue
                }
                pairs.push(`${formatTomlKey(k)} = ${formatInlineValue(v)}`)
            }
            return `{ ${pairs.join(", ")} }`
        } finally {
            active.delete(val)
        }
    }

    function emitSection(
        table: Record<string, unknown>,
        path: readonly string[],
        mode: SectionMode,
    ): void {
        if (active.has(table)) {
            throw new TypeError(
                "TOML.stringify cannot serialize circular structure",
            )
        }
        active.add(table)

        const scalars: string[] = []
        const childTables: Array<readonly [string, Record<string, unknown>]> = []
        const childArrays: Array<
            readonly [string, readonly Record<string, unknown>[]]
        > = []

        try {
            for (const [key, val] of Object.entries(table)) {
                if (isSkippedValue(val)) {
                    continue
                }
                if (isPlainTable(val)) {
                    childTables.push([key, val])
                } else if (
                    Array.isArray(val) &&
                    val.length > 0 &&
                    val.every(isPlainTable)
                ) {
                    childArrays.push([key, val])
                } else {
                    scalars.push(`${formatTomlKey(key)} = ${formatInlineValue(val)}`)
                }
            }

            if (mode === "root") {
                if (scalars.length > 0) {
                    blocks.push(scalars.join("\n"))
                }
            } else {
                assert(path.length > 0, "Non-root TOML section requires a key path")
                const dotted = path.map(formatTomlKey).join(".")
                const header = mode === "array-item" ? `[[${dotted}]]` : `[${dotted}]`
                const hasOnlySubsections =
                    scalars.length === 0 &&
                    (childTables.length > 0 || childArrays.length > 0)
                if (mode === "array-item" || !hasOnlySubsections) {
                    blocks.push([header, ...scalars].join("\n"))
                }
            }

            for (const [key, child] of childTables) {
                emitSection(child, [...path, key], "table")
            }
            for (const [key, items] of childArrays) {
                const nextPath = [...path, key]
                for (const item of items) {
                    emitSection(item, nextPath, "array-item")
                }
            }
        } finally {
            active.delete(table)
        }
    }

    emitSection(value, [], "root")
    return {
        toml: blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "",
        engine: "ts-fallback",
    }
}

export function stringifyToml(
    value: unknown,
    options: StringifyBunTomlOptions = {},
): string | undefined {
    return stringifyTomlWithMeta(value, options).toml
}
