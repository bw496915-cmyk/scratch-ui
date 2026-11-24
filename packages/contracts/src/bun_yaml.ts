/**
 * First-class `Bun.YAML.parse` / `Bun.YAML.stringify` wrapper with a zero-dependency YAML 1.2
 * pure-TypeScript fallback for Node.js (`tsx`) and browser runtimes (Status & Config Dashboard).
 * Parity with Bun's native Rust YAML 1.2 engine (`import { YAML } from "bun"`):
 *
 * - Multi-document streams (`---`) automatically return an array of documents.
 * - Anchors (`&name`) and aliases (`*name`) preserve object reference identity (`===`), support merge
 *   keys (`<<`), and safely represent cyclic structures.
 * - Supports YAML 1.2 Core Schema scalars, block/flow mappings & sequences (including multi-line flow
 *   collections), literal/folded block scalars (`|`, `|-`, `|+`, `>`, `>-`, `>+`), and explicit
 *   tags (`!!str`, `!!int`, `!!float`, `!!bool`, `!!null`).
 * - `stringifyBunYaml(value, space?)` emits single-line flow YAML when `space` is omitted and
 *   multi-line block YAML when `space` is provided. Security invariants:
 * - Enforces byte-length caps, nesting depth limits, and alias expansion caps.
 * - Strips prototype-polluting keys (`__proto__`, `constructor`, `prototype`) on both native
 *   `Bun.YAML.parse` and pure-TS fallback outputs while keeping object identity and cyclic
 *   references intact.
 * - Provides cycle-safe JSON preview serialization and recursive secret key redaction for HTTP/UI
 *   telemetry.
 *
 * @file Packages/contracts/src/bun_yaml.ts
 */

export const MAX_YAML_INPUT_BYTES = 262_144 // 256 KiB
export const MAX_YAML_DEPTH = 64
export const MAX_YAML_ALIAS_EXPANSIONS = 1_000

export const ERR_YAML_TOO_LARGE = "ERR_YAML_TOO_LARGE" as const
export const ERR_YAML_SYNTAX = "ERR_YAML_SYNTAX" as const
export const ERR_YAML_LIMIT_EXCEEDED = "ERR_YAML_LIMIT_EXCEEDED" as const

export type BunYamlEngine = "bun-native" | "ts-fallback"

export interface ParseBunYamlOptions {
  /** Force the pure-TypeScript YAML 1.2 fallback even when running on Bun. */
  readonly forceFallback?: boolean | undefined
  /** Maximum accepted UTF-8 input size in bytes (default 256 KiB). */
  readonly maxBytes?: number | undefined
  /** Maximum nesting depth for the fallback parser (default 64). */
  readonly maxDepth?: number | undefined
  /** Maximum alias expansions for the fallback parser (default 1000). */
  readonly maxAliasExpansions?: number | undefined
}

export interface ParsedBunYamlResult<T = unknown> {
  readonly value: T
  readonly engine: BunYamlEngine
  readonly isMultiDocument: boolean
  readonly documentCount: number
  readonly hasCircularRefs: boolean
  readonly byteLength: number
}

export interface StringifyBunYamlOptions {
  /** Indentation spaces (number) or prefix string; omit for compact flow YAML. */
  readonly space?: number | string | undefined
  /** Force pure-TypeScript serializer even when running on Bun. */
  readonly forceFallback?: boolean | undefined
}

export interface BetFlagRuleSummary {
  readonly id: string
  readonly title: string
  readonly severity: "info" | "low" | "medium" | "high" | "critical" | string
  readonly enabled: boolean
  readonly tags: readonly string[]
  readonly hasAggregate: boolean
  readonly aggregateGroupBy: string | null
  readonly aggregateWindowSeconds: number | null
  readonly description: string | null
}

export interface WorkspaceYamlConfigSummary {
  readonly filePath: string
  readonly detected: boolean
  readonly engine: BunYamlEngine
  readonly byteLength: number
  readonly schemaVersion: number | null
  readonly totalRules: number
  readonly enabledRules: number
  readonly disabledRules: number
  readonly aggregateRules: number
  readonly severityCounts: Readonly<Record<string, number>>
  readonly tags: readonly string[]
  readonly rules: readonly BetFlagRuleSummary[]
  readonly parseError?: string | undefined
}

interface BunGlobalYamlApi {
  readonly parse?: (input: string | Uint8Array | ArrayBuffer) => unknown
  readonly stringify?: (value: unknown, replacer?: unknown, space?: number | string) => string
}

function getNativeBunYaml(): BunGlobalYamlApi | null {
  const g = globalThis as {
    readonly Bun?: { readonly YAML?: BunGlobalYamlApi }
  }
  const api = g.Bun?.YAML
  if (api && typeof api.parse === "function") {
    return api
  }
  return null
}

export function isNativeBunYamlAvailable(): boolean {
  return getNativeBunYaml() !== null
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength
  }
  return text.length * 2
}

function normalizeYamlInput(input: string | Uint8Array | ArrayBuffer): string {
  if (typeof input === "string") return input
  if (typeof TextDecoder !== "undefined") {
    if (input instanceof ArrayBuffer) {
      return new TextDecoder("utf-8").decode(new Uint8Array(input))
    }
    return new TextDecoder("utf-8").decode(input)
  }
  throw new TypeError(`${ERR_YAML_SYNTAX}: Binary YAML input requires TextDecoder`)
}

const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"])

function isSafeObjectKey(key: string): boolean {
  return !FORBIDDEN_OBJECT_KEYS.has(key)
}

/**
 * Strip prototype-polluting keys in-place across parsed YAML structures while preserving object
 * reference identity and handling cyclic graphs safely.
 */
function sanitizeParsedYamlGraph<T>(root: T): {
  readonly value: T
  readonly hasCircularRefs: boolean
} {
  const active = new Set<object>()
  const visited = new Set<object>()
  let hasCircularRefs = false

  function visit(node: unknown): void {
    if (node === null || typeof node !== "object") return
    if (active.has(node)) {
      hasCircularRefs = true
      return
    }
    if (visited.has(node)) return

    visited.add(node)
    active.add(node)

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        visit(node[i])
      }
    } else {
      const record = node as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (!isSafeObjectKey(key)) {
          delete record[key]
          continue
        }
        visit(record[key])
      }
    }

    active.delete(node)
  }

  visit(root)
  return { value: root, hasCircularRefs }
}

/** Detect whether a YAML text stream contains multiple explicit documents (`---`). */
export function countYamlDocuments(rawText: string): number {
  const docs = splitYamlDocuments(rawText)
  return docs.length
}

function splitYamlDocuments(rawText: string): readonly string[] {
  const lines = rawText.replace(/^\uFEFF/, "").split(/\r?\n/)
  const docs: string[][] = []
  let current: string[] = []
  let sawExplicitStart = false
  let inBlockScalar = false
  let blockScalarIndent = -1

  const hasContent = (buf: readonly string[]): boolean =>
    buf.some((line) => {
      const trimmed = line.trim()
      return trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("%")
    })

  for (const line of lines) {
    const trimmed = line.trim()

    if (inBlockScalar) {
      if (trimmed === "") {
        current.push(line)
        continue
      }
      const indent = countLeadingSpaces(line)
      if (indent > blockScalarIndent) {
        current.push(line)
        continue
      }
      inBlockScalar = false
      blockScalarIndent = -1
    }

    if (/^---(?:\s|$)/.test(line)) {
      if (hasContent(current) || sawExplicitStart) {
        docs.push(current)
        current = []
      }
      sawExplicitStart = true
      const remainder = line.slice(3).trim()
      if (remainder !== "" && !remainder.startsWith("#")) {
        current.push(remainder)
      }
      continue
    }

    if (/^\.\.\.(?:\s|$)/.test(line)) {
      if (hasContent(current) || sawExplicitStart) {
        docs.push(current)
        current = []
      }
      sawExplicitStart = false
      continue
    }

    // Track entering a block scalar so `---` inside literal text isn't split
    const stripped = stripInlineComment(line).trimEnd()
    if (/(?::|-)\s*[|>][+-]?\d*$/.test(stripped)) {
      inBlockScalar = true
      blockScalarIndent = countLeadingSpaces(line)
    }

    current.push(line)
  }

  if (hasContent(current) || sawExplicitStart) {
    docs.push(current)
  }

  if (docs.length === 0) {
    return [""]
  }

  return docs.map((buf) => buf.join("\n"))
}

function countLeadingSpaces(line: string): number {
  let count = 0
  while (count < line.length && line[count] === " ") {
    count += 1
  }
  return count
}

function stripInlineComment(raw: string): string {
  let inSingle = false
  let inDouble = false
  let escaped = false

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!
    if (inDouble) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inDouble = false
      }
      continue
    }
    if (inSingle) {
      if (ch === "'" && raw[i + 1] === "'") {
        i += 1
      } else if (ch === "'") {
        inSingle = false
      }
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) {
      return raw.slice(0, i)
    }
  }
  return raw
}

function unescapeDoubleQuotedYaml(inner: string): string {
  let out = ""
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!
    if (ch !== "\\" || i + 1 >= inner.length) {
      out += ch
      continue
    }
    const next = inner[i + 1]!
    i += 1
    switch (next) {
      case "n":
        out += "\n"
        break
      case "r":
        out += "\r"
        break
      case "t":
        out += "\t"
        break
      case "b":
        out += "\b"
        break
      case "f":
        out += "\f"
        break
      case "0":
        out += "\0"
        break
      case "\\":
        out += "\\"
        break
      case '"':
        out += '"'
        break
      case "/":
        out += "/"
        break
      case "x": {
        const hex = inner.slice(i + 1, i + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 2
        } else {
          out += `\\x`
        }
        break
      }
      case "u": {
        const hex = inner.slice(i + 1, i + 5)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else {
          out += `\\u`
        }
        break
      }
      default:
        out += next
        break
    }
  }
  return out
}

function parseYamlScalar(rawToken: string, explicitTag: string | null): unknown {
  const token = rawToken.trim()

  // Quoted string literals
  if (token.startsWith('"') && token.endsWith('"') && token.length >= 2) {
    const str = unescapeDoubleQuotedYaml(token.slice(1, -1))
    return applyExplicitYamlTag(str, explicitTag, true)
  }
  if (token.startsWith("'") && token.endsWith("'") && token.length >= 2) {
    const str = token.slice(1, -1).replace(/''/g, "'")
    return applyExplicitYamlTag(str, explicitTag, true)
  }

  if (explicitTag) {
    return applyExplicitYamlTag(token, explicitTag, false)
  }

  // YAML 1.2 Core Schema scalar resolution
  if (token === "" || token === "null" || token === "Null" || token === "NULL" || token === "~") {
    return null
  }
  if (token === "true" || token === "True" || token === "TRUE") return true
  if (token === "false" || token === "False" || token === "FALSE") return false

  if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(token)) {
    const num = Number.parseInt(token, 10)
    if (Number.isSafeInteger(num)) return num
  }
  if (/^0x[0-9a-fA-F]+$/.test(token)) {
    return Number.parseInt(token.slice(2), 16)
  }
  if (/^0o[0-7]+$/.test(token)) {
    return Number.parseInt(token.slice(2), 8)
  }
  if (token === ".inf" || token === "+.inf" || token === ".Inf" || token === ".INF") {
    return Number.POSITIVE_INFINITY
  }
  if (token === "-.inf" || token === "-.Inf" || token === "-.INF") {
    return Number.NEGATIVE_INFINITY
  }
  if (token === ".nan" || token === ".NaN" || token === ".NAN") {
    return Number.NaN
  }
  if (
    /^[-+]?(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(token) ||
    /^[-+]?\d+[eE][-+]?\d+$/.test(token)
  ) {
    const num = Number.parseFloat(token)
    if (!Number.isNaN(num)) return num
  }

  return token
}

function applyExplicitYamlTag(rawValue: string, tag: string | null, wasQuoted: boolean): unknown {
  if (!tag) return rawValue
  switch (tag) {
    case "!!str":
      return rawValue
    case "!!null":
      return null
    case "!!bool": {
      const lower = rawValue.toLowerCase()
      if (lower === "true") return true
      if (lower === "false") return false
      throw new SyntaxError(`${ERR_YAML_SYNTAX}: Invalid !!bool value "${rawValue}"`)
    }
    case "!!int": {
      const trimmed = rawValue.trim()
      const parsed = trimmed.startsWith("0x")
        ? Number.parseInt(trimmed.slice(2), 16)
        : trimmed.startsWith("0o")
          ? Number.parseInt(trimmed.slice(2), 8)
          : Number.parseInt(trimmed, 10)
      if (Number.isNaN(parsed)) {
        throw new SyntaxError(`${ERR_YAML_SYNTAX}: Invalid !!int value "${rawValue}"`)
      }
      return parsed
    }
    case "!!float": {
      const lower = rawValue.trim().toLowerCase()
      if (lower === ".inf" || lower === "+.inf") return Number.POSITIVE_INFINITY
      if (lower === "-.inf") return Number.NEGATIVE_INFINITY
      if (lower === ".nan") return Number.NaN
      const parsed = Number.parseFloat(rawValue)
      if (Number.isNaN(parsed)) {
        throw new SyntaxError(`${ERR_YAML_SYNTAX}: Invalid !!float value "${rawValue}"`)
      }
      return parsed
    }
    default:
      return wasQuoted ? rawValue : parseYamlScalar(rawValue, null)
  }
}

interface ExtractedPrefixDecorators {
  readonly anchor: string | null
  readonly tag: string | null
  readonly rest: string
}

function extractAnchorAndTag(raw: string): ExtractedPrefixDecorators {
  let rest = raw.trimStart()
  let anchor: string | null = null
  let tag: string | null = null

  for (let pass = 0; pass < 2; pass += 1) {
    if (rest.startsWith("&")) {
      const match = /^&([^\s,[\]{}]+)(?:\s+|$)/.exec(rest)
      if (match) {
        anchor = match[1]!
        rest = rest.slice(match[0].length)
        continue
      }
    }
    if (rest.startsWith("!!")) {
      const match = /^(!![a-zA-Z0-9_-]+)(?:\s+|$)/.exec(rest)
      if (match) {
        tag = match[1]!
        rest = rest.slice(match[0].length)
        continue
      }
    }
    break
  }

  return { anchor, tag, rest: rest.trim() }
}

interface FallbackParserState {
  readonly anchors: Map<string, unknown>
  readonly maxDepth: number
  readonly maxAliasExpansions: number
  aliasExpansions: number
}

function findUnquotedMappingColon(line: string): number {
  let inSingle = false
  let inDouble = false
  let escaped = false
  let flowDepth = 0

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (inDouble) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === "'" && line[i + 1] === "'") i += 1
      else if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === "{" || ch === "[") {
      flowDepth += 1
      continue
    }
    if (ch === "}" || ch === "]") {
      flowDepth = Math.max(0, flowDepth - 1)
      continue
    }
    if (flowDepth === 0 && ch === ":") {
      const next = line[i + 1]
      if (next === undefined || next === " " || next === "\t") {
        return i
      }
    }
  }
  return -1
}

function unquoteKey(rawKey: string): string {
  const trimmed = rawKey.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return unescapeDoubleQuotedYaml(trimmed.slice(1, -1))
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function resolveAliasToken(token: string, state: FallbackParserState): unknown {
  const name = token.slice(1).trim()
  if (!state.anchors.has(name)) {
    throw new SyntaxError(`${ERR_YAML_SYNTAX}: Unknown YAML alias "*${name}"`)
  }
  state.aliasExpansions += 1
  if (state.aliasExpansions > state.maxAliasExpansions) {
    throw new RangeError(
      `${ERR_YAML_LIMIT_EXCEEDED}: YAML alias expansion limit (${state.maxAliasExpansions}) exceeded`,
    )
  }
  return state.anchors.get(name)
}

function isFlowBalanced(text: string): boolean {
  let inSingle = false
  let inDouble = false
  let escaped = false
  let braceDepth = 0
  let bracketDepth = 0

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (inDouble) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === "'" && text[i + 1] === "'") i += 1
      else if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') inDouble = true
    else if (ch === "'") inSingle = true
    else if (ch === "{") braceDepth += 1
    else if (ch === "}") braceDepth -= 1
    else if (ch === "[") bracketDepth += 1
    else if (ch === "]") bracketDepth -= 1
  }

  return !inSingle && !inDouble && braceDepth === 0 && bracketDepth === 0
}

function parseFlowCollection(
  raw: string,
  state: FallbackParserState,
  depth: number,
  preRegisteredAnchor: string | null,
): unknown {
  if (depth > state.maxDepth) {
    throw new RangeError(
      `${ERR_YAML_LIMIT_EXCEEDED}: YAML nesting depth (${state.maxDepth}) exceeded`,
    )
  }

  let pos = 0
  const src = raw.trim()

  function skipWs(): void {
    while (pos < src.length && /\s/.test(src[pos]!)) {
      pos += 1
    }
  }

  function parseFlowValue(curDepth: number, anchorOverride: string | null): unknown {
    if (curDepth > state.maxDepth) {
      throw new RangeError(
        `${ERR_YAML_LIMIT_EXCEEDED}: YAML nesting depth (${state.maxDepth}) exceeded`,
      )
    }
    skipWs()

    let anchor: string | null = anchorOverride
    let tag: string | null = null
    for (let p = 0; p < 2; p += 1) {
      skipWs()
      if (src[pos] === "&") {
        const m = /^&([^\s,[\]{}]+)/.exec(src.slice(pos))
        if (m) {
          anchor = m[1]!
          pos += m[0].length
          continue
        }
      }
      if (src.startsWith("!!", pos)) {
        const m = /^(!![a-zA-Z0-9_-]+)/.exec(src.slice(pos))
        if (m) {
          tag = m[1]!
          pos += m[0].length
          continue
        }
      }
      break
    }
    skipWs()

    const ch = src[pos]
    if (ch === "[") {
      pos += 1
      const arr: unknown[] = []
      if (anchor) state.anchors.set(anchor, arr)
      skipWs()
      while (pos < src.length && src[pos] !== "]") {
        arr.push(parseFlowValue(curDepth + 1, null))
        skipWs()
        if (src[pos] === ",") {
          pos += 1
          skipWs()
          if (src[pos] === "]") break // trailing comma tolerance
        } else if (src[pos] !== "]") {
          throw new SyntaxError(`${ERR_YAML_SYNTAX}: Expected ',' or ']' in flow sequence`)
        }
      }
      if (src[pos] !== "]") {
        throw new SyntaxError(`${ERR_YAML_SYNTAX}: Unterminated flow sequence '['`)
      }
      pos += 1
      return arr
    }

    if (ch === "{") {
      pos += 1
      const obj: Record<string, unknown> = {}
      if (anchor) state.anchors.set(anchor, obj)
      skipWs()
      while (pos < src.length && src[pos] !== "}") {
        const keyToken = readFlowScalarToken(true)
        const key = unquoteKey(keyToken)
        skipWs()
        if (src[pos] !== ":") {
          throw new SyntaxError(`${ERR_YAML_SYNTAX}: Expected ':' after flow mapping key "${key}"`)
        }
        pos += 1
        const val = parseFlowValue(curDepth + 1, null)
        if (key === "<<") {
          applyMergeKey(obj, val)
        } else if (isSafeObjectKey(key)) {
          obj[key] = val
        }
        skipWs()
        if (src[pos] === ",") {
          pos += 1
          skipWs()
          if (src[pos] === "}") break // trailing comma tolerance (used in bet-flags.yml!)
        } else if (src[pos] !== "}") {
          throw new SyntaxError(`${ERR_YAML_SYNTAX}: Expected ',' or '}' in flow mapping`)
        }
      }
      if (src[pos] !== "}") {
        throw new SyntaxError(`${ERR_YAML_SYNTAX}: Unterminated flow mapping '{'`)
      }
      pos += 1
      return obj
    }

    const token = readFlowScalarToken(false)
    let val: unknown
    if (token.startsWith("*") && !tag) {
      val = resolveAliasToken(token, state)
    } else {
      val = parseYamlScalar(token, tag)
    }
    if (anchor) state.anchors.set(anchor, val)
    return val
  }

  function readFlowScalarToken(isKey: boolean): string {
    skipWs()
    if (pos >= src.length) return ""
    const start = pos
    const ch = src[pos]!

    if (ch === '"') {
      pos += 1
      let escaped = false
      while (pos < src.length) {
        const c = src[pos]!
        pos += 1
        if (escaped) escaped = false
        else if (c === "\\") escaped = true
        else if (c === '"') break
      }
      return src.slice(start, pos)
    }

    if (ch === "'") {
      pos += 1
      while (pos < src.length) {
        const c = src[pos]!
        pos += 1
        if (c === "'" && src[pos] === "'") {
          pos += 1
        } else if (c === "'") {
          break
        }
      }
      return src.slice(start, pos)
    }

    while (pos < src.length) {
      const c = src[pos]!
      if (c === "," || c === "]" || c === "}") break
      if (isKey && c === ":") break
      pos += 1
    }
    return src.slice(start, pos).trim()
  }

  return parseFlowValue(depth, preRegisteredAnchor)
}

function applyMergeKey(target: Record<string, unknown>, source: unknown): void {
  const sources = Array.isArray(source) ? source : [source]
  for (const item of sources) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (isSafeObjectKey(k) && !(k in target)) {
          target[k] = v
        }
      }
    }
  }
}

interface LogicalLine {
  readonly indent: number
  readonly text: string
  readonly rawLine: string
  readonly lineNo: number
}

function parseSingleYamlDocumentFallback(docText: string, state: FallbackParserState): unknown {
  const rawLines = docText.split(/\r?\n/)
  const lines: LogicalLine[] = []

  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i]!
    const trimmed = rawLine.trim()
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("%")) {
      lines.push({ indent: -1, text: "", rawLine, lineNo: i + 1 })
      continue
    }
    const indent = countLeadingSpaces(rawLine)
    const withoutComment = stripInlineComment(rawLine.slice(indent)).trimEnd()
    lines.push({ indent, text: withoutComment, rawLine, lineNo: i + 1 })
  }

  let cursor = 0

  function skipEmpty(): void {
    while (cursor < lines.length && lines[cursor]!.text === "") {
      cursor += 1
    }
  }

  function collectMultiLineFlow(firstChunk: string): string {
    let acc = firstChunk
    while (!isFlowBalanced(acc) && cursor + 1 < lines.length) {
      cursor += 1
      const nextLine = lines[cursor]!
      if (nextLine.text !== "") {
        acc += ` ${nextLine.text}`
      }
    }
    return acc
  }

  function parseBlockScalar(header: string, parentIndent: number): string {
    const style = header[0] as "|" | ">"
    const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip"

    const collected: string[] = []
    let contentIndent: number | null = null
    cursor += 1

    while (cursor < lines.length) {
      const rawLine = lines[cursor]!.rawLine
      if (rawLine.trim() === "") {
        collected.push("")
        cursor += 1
        continue
      }
      const lineIndent = countLeadingSpaces(rawLine)
      if (lineIndent <= parentIndent) {
        break
      }
      if (contentIndent === null) {
        contentIndent = lineIndent
      }
      collected.push(rawLine.slice(Math.min(contentIndent, lineIndent)))
      cursor += 1
    }

    // Trim trailing empty lines according to chomp indicator
    let trailingEmptyCount = 0
    while (collected.length > 0 && collected[collected.length - 1] === "") {
      collected.pop()
      trailingEmptyCount += 1
    }

    let body: string
    if (style === "|") {
      body = collected.join("\n")
    } else {
      // Folded scalar (>): join adjacent non-empty lines with space, preserve blank lines
      const foldedParts: string[] = []
      for (let i = 0; i < collected.length; i += 1) {
        const cur = collected[i]!
        if (cur === "") {
          foldedParts.push("\n")
        } else {
          if (foldedParts.length > 0 && foldedParts[foldedParts.length - 1] !== "\n") {
            foldedParts.push(" ")
          }
          foldedParts.push(cur)
        }
      }
      body = foldedParts.join("")
    }

    if (chomp === "strip") return body
    if (chomp === "keep") {
      return `${body}\n${"\n".repeat(trailingEmptyCount)}`
    }
    return body.length > 0 ? `${body}\n` : ""
  }

  function parseNode(minIndent: number, depth: number, inheritedAnchor: string | null): unknown {
    if (depth > state.maxDepth) {
      throw new RangeError(
        `${ERR_YAML_LIMIT_EXCEEDED}: YAML nesting depth (${state.maxDepth}) exceeded`,
      )
    }

    skipEmpty()
    if (cursor >= lines.length) return null

    const first = lines[cursor]!
    if (first.indent < minIndent) return null

    // Sequence at current indent?
    if (first.text === "-" || first.text.startsWith("- ")) {
      return parseSequence(first.indent, depth, inheritedAnchor)
    }

    // Flow collection at top/block position?
    const dec = extractAnchorAndTag(first.text)
    const activeAnchor = dec.anchor ?? inheritedAnchor
    if (dec.rest.startsWith("{") || dec.rest.startsWith("[")) {
      const fullFlow = collectMultiLineFlow(dec.rest)
      cursor += 1
      return parseFlowCollection(fullFlow, state, depth, activeAnchor)
    }

    // Mapping at current indent?
    if (findUnquotedMappingColon(first.text) !== -1) {
      return parseMapping(first.indent, depth, inheritedAnchor)
    }

    // Scalar or alias line
    cursor += 1
    if (dec.rest.startsWith("*") && !dec.tag) {
      const resolved = resolveAliasToken(dec.rest, state)
      if (activeAnchor) state.anchors.set(activeAnchor, resolved)
      return resolved
    }
    const scalarVal = parseYamlScalar(dec.rest, dec.tag)
    if (activeAnchor) state.anchors.set(activeAnchor, scalarVal)
    return scalarVal
  }

  function parseSequence(seqIndent: number, depth: number, anchorName: string | null): unknown[] {
    const arr: unknown[] = []
    if (anchorName) state.anchors.set(anchorName, arr)

    while (cursor < lines.length) {
      skipEmpty()
      if (cursor >= lines.length) break
      const line = lines[cursor]!
      if (line.indent < seqIndent) break
      if (line.indent > seqIndent) {
        throw new SyntaxError(`${ERR_YAML_SYNTAX}: Unexpected indentation at line ${line.lineNo}`)
      }
      if (line.text !== "-" && !line.text.startsWith("- ")) break

      const afterDash = line.text === "-" ? "" : line.text.slice(2).trimStart()
      if (afterDash === "") {
        cursor += 1
        arr.push(parseNode(seqIndent + 1, depth + 1, null))
        continue
      }

      const dec = extractAnchorAndTag(afterDash)

      // Block scalar directly after `- |` or `- >`
      if (/^[|>][+-]?\d*$/.test(dec.rest)) {
        const text = parseBlockScalar(dec.rest, seqIndent)
        const val = applyExplicitYamlTag(text, dec.tag, true)
        if (dec.anchor) state.anchors.set(dec.anchor, val)
        arr.push(val)
        continue
      }

      // Flow collection directly after `- { ... }` or `- [ ... ]`
      if (dec.rest.startsWith("{") || dec.rest.startsWith("[")) {
        const fullFlow = collectMultiLineFlow(dec.rest)
        cursor += 1
        arr.push(parseFlowCollection(fullFlow, state, depth + 1, dec.anchor))
        continue
      }

      // Inline mapping inside sequence item: `- id: foo` followed by `  title: bar`
      const colonIdx = findUnquotedMappingColon(afterDash)
      if (colonIdx !== -1) {
        const inlineIndent = seqIndent + 2
        const itemObj: Record<string, unknown> = {}
        if (dec.anchor) state.anchors.set(dec.anchor, itemObj)
        parseInlineMappingEntry(itemObj, afterDash, colonIdx, inlineIndent, depth + 1)
        // Continue consuming sibling mapping keys aligned at `inlineIndent`
        parseMappingBody(itemObj, inlineIndent, depth + 1)
        arr.push(itemObj)
        continue
      }

      // Alias or scalar item
      cursor += 1
      if (dec.rest.startsWith("*") && !dec.tag) {
        const resolved = resolveAliasToken(dec.rest, state)
        if (dec.anchor) state.anchors.set(dec.anchor, resolved)
        arr.push(resolved)
      } else {
        const val = parseYamlScalar(dec.rest, dec.tag)
        if (dec.anchor) state.anchors.set(dec.anchor, val)
        arr.push(val)
      }
    }

    return arr
  }

  function parseInlineMappingEntry(
    target: Record<string, unknown>,
    entryText: string,
    colonIdx: number,
    mapIndent: number,
    depth: number,
  ): void {
    const rawKey = entryText.slice(0, colonIdx).trim()
    const key = unquoteKey(rawKey)
    const rawVal = entryText.slice(colonIdx + 1).trim()
    const val = parseMappingValue(rawVal, mapIndent, depth)

    if (key === "<<") {
      applyMergeKey(target, val)
    } else if (isSafeObjectKey(key)) {
      target[key] = val
    }
  }

  function parseMappingValue(rawVal: string, mapIndent: number, depth: number): unknown {
    if (rawVal === "") {
      cursor += 1
      skipEmpty()
      if (cursor >= lines.length) return null
      const next = lines[cursor]!
      // Allow sequence at same indent as parent mapping key (valid YAML 1.2)
      if (next.indent === mapIndent && (next.text === "-" || next.text.startsWith("- "))) {
        return parseSequence(next.indent, depth + 1, null)
      }
      if (next.indent <= mapIndent) {
        return null
      }
      return parseNode(next.indent, depth + 1, null)
    }

    const dec = extractAnchorAndTag(rawVal)

    if (dec.rest === "") {
      // Anchor or tag on key line, value on indented child block (e.g. `defaults: &def`)
      cursor += 1
      skipEmpty()
      if (cursor >= lines.length) return null
      const next = lines[cursor]!
      if (next.indent === mapIndent && (next.text === "-" || next.text.startsWith("- "))) {
        return parseSequence(next.indent, depth + 1, dec.anchor)
      }
      if (next.indent <= mapIndent) return null
      return parseNode(next.indent, depth + 1, dec.anchor)
    }

    if (/^[|>][+-]?\d*$/.test(dec.rest)) {
      const text = parseBlockScalar(dec.rest, mapIndent)
      const val = applyExplicitYamlTag(text, dec.tag, true)
      if (dec.anchor) state.anchors.set(dec.anchor, val)
      return val
    }

    if (dec.rest.startsWith("{") || dec.rest.startsWith("[")) {
      const fullFlow = collectMultiLineFlow(dec.rest)
      cursor += 1
      return parseFlowCollection(fullFlow, state, depth + 1, dec.anchor)
    }

    cursor += 1
    if (dec.rest.startsWith("*") && !dec.tag) {
      const resolved = resolveAliasToken(dec.rest, state)
      if (dec.anchor) state.anchors.set(dec.anchor, resolved)
      return resolved
    }

    const scalar = parseYamlScalar(dec.rest, dec.tag)
    if (dec.anchor) state.anchors.set(dec.anchor, scalar)
    return scalar
  }

  function parseMappingBody(
    target: Record<string, unknown>,
    mapIndent: number,
    depth: number,
  ): void {
    while (cursor < lines.length) {
      skipEmpty()
      if (cursor >= lines.length) break
      const line = lines[cursor]!
      if (line.indent < mapIndent) break
      if (line.indent > mapIndent) {
        throw new SyntaxError(`${ERR_YAML_SYNTAX}: Unexpected indentation at line ${line.lineNo}`)
      }
      if (line.text === "-" || line.text.startsWith("- ")) break

      const colonIdx = findUnquotedMappingColon(line.text)
      if (colonIdx === -1) {
        throw new SyntaxError(`${ERR_YAML_SYNTAX}: Expected ':' in mapping at line ${line.lineNo}`)
      }
      parseInlineMappingEntry(target, line.text, colonIdx, mapIndent, depth)
    }
  }

  function parseMapping(
    mapIndent: number,
    depth: number,
    anchorName: string | null,
  ): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    if (anchorName) state.anchors.set(anchorName, obj)
    parseMappingBody(obj, mapIndent, depth)
    return obj
  }

  return parseNode(0, 0, null)
}

function parseYamlWithFallback(
  rawText: string,
  options: ParseBunYamlOptions,
): { readonly value: unknown; readonly documentCount: number } {
  const docSlices = splitYamlDocuments(rawText)
  const maxDepth = options.maxDepth ?? MAX_YAML_DEPTH
  const maxAliasExpansions = options.maxAliasExpansions ?? MAX_YAML_ALIAS_EXPANSIONS

  if (docSlices.length > 1) {
    const docs = docSlices.map((slice) => {
      const state: FallbackParserState = {
        anchors: new Map(),
        maxDepth,
        maxAliasExpansions,
        aliasExpansions: 0,
      }
      return parseSingleYamlDocumentFallback(slice, state)
    })
    return { value: docs, documentCount: docs.length }
  }

  const state: FallbackParserState = {
    anchors: new Map(),
    maxDepth,
    maxAliasExpansions,
    aliasExpansions: 0,
  }
  return {
    value: parseSingleYamlDocumentFallback(docSlices[0] ?? "", state),
    documentCount: 1,
  }
}

/**
 * Parse YAML using Bun's native `Bun.YAML.parse` when running under Bun, or the YAML 1.2
 * pure-TypeScript fallback in Node.js / browser runtimes, returning parsed output plus execution
 * metadata.
 */
export function parseBunYamlWithMeta<T = unknown>(
  input: string | Uint8Array | ArrayBuffer,
  options: ParseBunYamlOptions = {},
): ParsedBunYamlResult<T> {
  const rawText = normalizeYamlInput(input)
  const maxBytes = options.maxBytes ?? MAX_YAML_INPUT_BYTES
  const byteLength = utf8ByteLength(rawText)
  if (byteLength > maxBytes) {
    throw new RangeError(
      `${ERR_YAML_TOO_LARGE}: YAML payload (${byteLength} bytes) exceeds max allowed size (${maxBytes} bytes)`,
    )
  }

  const nativeApi = options.forceFallback ? null : getNativeBunYaml()
  const documentCount = countYamlDocuments(rawText)
  let rawParsed: unknown
  let engine: BunYamlEngine

  if (nativeApi?.parse) {
    rawParsed = nativeApi.parse(rawText)
    engine = "bun-native"
  } else {
    const fallback = parseYamlWithFallback(rawText, options)
    rawParsed = fallback.value
    engine = "ts-fallback"
  }

  const { value, hasCircularRefs } = sanitizeParsedYamlGraph(rawParsed)
  const isMultiDocument = documentCount > 1 && Array.isArray(value)

  return {
    value: value as T,
    engine,
    isMultiDocument,
    documentCount: isMultiDocument ? (value as unknown[]).length : 1,
    hasCircularRefs,
    byteLength,
  }
}

/**
 * Convenience wrapper matching `Bun.YAML.parse(input)` with prototype-pollution sanitization and
 * cross-runtime fallback support.
 */
export function parseBunYaml<T = unknown>(
  input: string | Uint8Array | ArrayBuffer,
  options: ParseBunYamlOptions = {},
): T {
  return parseBunYamlWithMeta<T>(input, options).value
}

// ── Stringify (`Bun.YAML.stringify` + pure-TS fallback) ───────────────────────

function formatYamlStringScalar(value: string): string {
  if (value === "") return '""'
  const needsQuotes =
    /^[\s#&*!|>'"%@`,[\]{}?:-]|[\s:]$|[\n\r\t]|^(?:true|false|null|~|yes|no|on|off)$/i.test(
      value,
    ) || /^[-+]?(?:0x[0-9a-f]+|0o[0-7]+|\d+(?:\.\d+)?(?:e[-+]?\d+)?|\.(?:inf|nan))$/i.test(value)
  return needsQuotes ? JSON.stringify(value) : value
}

function stringifyYamlFallback(root: unknown, space: number | string | undefined): string {
  const indentUnit =
    typeof space === "number"
      ? " ".repeat(Math.max(0, Math.min(10, space)))
      : typeof space === "string"
        ? space
        : ""
  const isBlockMode = indentUnit.length > 0
  const active = new Set<object>()

  function renderFlow(val: unknown): string {
    if (val === null || val === undefined) return "null"
    if (typeof val === "boolean") return val ? "true" : "false"
    if (typeof val === "number") {
      if (Number.isNaN(val)) return ".nan"
      if (val === Number.POSITIVE_INFINITY) return ".inf"
      if (val === Number.NEGATIVE_INFINITY) return "-.inf"
      return String(val)
    }
    if (typeof val === "string") return formatYamlStringScalar(val)
    if (typeof val === "object") {
      if (active.has(val)) return '"[Circular]"'
      active.add(val)
      let rendered: string
      if (Array.isArray(val)) {
        rendered = `[${val.map((item) => renderFlow(item)).join(", ")}]`
      } else {
        const pairs = Object.entries(val as Record<string, unknown>)
          .filter(([k, v]) => isSafeObjectKey(k) && v !== undefined)
          .map(([k, v]) => `${formatYamlStringScalar(k)}: ${renderFlow(v)}`)
        rendered = `{${pairs.join(", ")}}`
      }
      active.delete(val)
      return rendered
    }
    return JSON.stringify(String(val))
  }

  function renderBlock(val: unknown, level: number): string {
    const pad = indentUnit.repeat(level)
    if (val === null || val === undefined) return "null"
    if (typeof val === "boolean") return val ? "true" : "false"
    if (typeof val === "number") {
      if (Number.isNaN(val)) return ".nan"
      if (val === Number.POSITIVE_INFINITY) return ".inf"
      if (val === Number.NEGATIVE_INFINITY) return "-.inf"
      return String(val)
    }
    if (typeof val === "string") {
      if (val.includes("\n")) {
        const innerPad = indentUnit.repeat(level + 1)
        const body = val
          .replace(/\n$/, "")
          .split("\n")
          .map((line) => `${innerPad}${line}`)
          .join("\n")
        return `${val.endsWith("\n") ? "|" : "|-"}\n${body}`
      }
      return formatYamlStringScalar(val)
    }
    if (typeof val === "object") {
      if (active.has(val)) return '"[Circular]"'
      active.add(val)
      let out: string
      if (Array.isArray(val)) {
        if (val.length === 0) {
          out = "[]"
        } else {
          out = val
            .map((item) => {
              if (item !== null && typeof item === "object") {
                const nested = renderBlock(item, level + 1)
                if (nested === "{}" || nested === "[]" || nested === '"[Circular]"') {
                  return `${pad}- ${nested}`
                }
                return `${pad}-\n${nested}`
              }
              return `${pad}- ${renderBlock(item, level + 1)}`
            })
            .join("\n")
        }
      } else {
        const entries = Object.entries(val as Record<string, unknown>).filter(
          ([k, v]) => isSafeObjectKey(k) && v !== undefined,
        )
        if (entries.length === 0) {
          out = "{}"
        } else {
          out = entries
            .map(([k, v]) => {
              const keyStr = formatYamlStringScalar(k)
              if (v !== null && typeof v === "object") {
                const nested = renderBlock(v, level + 1)
                if (nested === "{}" || nested === "[]" || nested === '"[Circular]"') {
                  return `${pad}${keyStr}: ${nested}`
                }
                return `${pad}${keyStr}:\n${nested}`
              }
              return `${pad}${keyStr}: ${renderBlock(v, level + 1)}`
            })
            .join("\n")
        }
      }
      active.delete(val)
      return out
    }
    return JSON.stringify(String(val))
  }

  return isBlockMode ? renderBlock(root, 0) : renderFlow(root)
}

/**
 * Serialize a JS value to YAML via `Bun.YAML.stringify` when running on Bun (or pure-TS fallback
 * otherwise). Omit `space` for single-line flow YAML; pass a number/string (e.g. `2`) for
 * multi-line block YAML.
 */
export function stringifyBunYaml(value: unknown, options: StringifyBunYamlOptions = {}): string {
  const nativeApi = options.forceFallback ? null : getNativeBunYaml()
  if (nativeApi?.stringify) {
    return options.space !== undefined
      ? nativeApi.stringify(value, null, options.space)
      : nativeApi.stringify(value)
  }
  return stringifyYamlFallback(value, options.space)
}

// ── Cycle-Safe JSON Preview & Secret Redaction ────────────────────────────────

const SENSITIVE_YAML_KEY_RE =
  /(secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|salt|authorization|cookie)/i

/**
 * Return a deep copy of a parsed YAML value with any sensitive keys redacted (`"[REDACTED]"`), safe
 * against circular object references.
 */
export function redactYamlSensitiveValues(root: unknown): unknown {
  const seen = new WeakMap<object, unknown>()

  function clone(node: unknown): unknown {
    if (node === null || typeof node !== "object") return node
    if (seen.has(node)) return "[Circular]"

    if (Array.isArray(node)) {
      const out: unknown[] = []
      seen.set(node, out)
      for (const item of node) {
        out.push(clone(item))
      }
      return out
    }

    const out: Record<string, unknown> = {}
    seen.set(node, out)
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (!isSafeObjectKey(key)) continue
      if (SENSITIVE_YAML_KEY_RE.test(key) && val !== null && val !== undefined && val !== "") {
        out[key] = "[REDACTED]"
      } else {
        out[key] = clone(val)
      }
    }
    return out
  }

  return clone(root)
}

/**
 * Cycle-safe JSON pretty printer for displaying parsed YAML structures (including cyclic `&self` /
 * `*self` aliases supported by `Bun.YAML.parse`).
 */
export function safeJsonPreview(value: unknown, space = 2): string {
  const ancestors: object[] = []
  return JSON.stringify(
    value,
    function (_key, val: unknown) {
      if (typeof val === "number") {
        if (Number.isNaN(val)) return ".nan"
        if (val === Number.POSITIVE_INFINITY) return ".inf"
        if (val === Number.NEGATIVE_INFINITY) return "-.inf"
      }
      if (val !== null && typeof val === "object") {
        while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
          ancestors.pop()
        }
        if (ancestors.includes(val)) {
          return "[Circular]"
        }
        ancestors.push(val)
      }
      return val
    },
    space,
  )
}

// ── Workspace Bet-Flags YAML Summarizer ───────────────────────────────────────

export function summarizeBetFlagsYamlDocument(
  parsed: unknown,
  meta: {
    readonly filePath: string
    readonly engine: BunYamlEngine
    readonly byteLength: number
  },
): WorkspaceYamlConfigSummary {
  const doc =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}

  const schemaVersion = typeof doc.schemaVersion === "number" ? doc.schemaVersion : null

  const rawRules = Array.isArray(doc.rules) ? doc.rules : []
  const rules: BetFlagRuleSummary[] = []
  const severityCounts: Record<string, number> = {}
  const tagSet = new Set<string>()
  let enabledRules = 0
  let disabledRules = 0
  let aggregateRules = 0

  for (const rawRule of rawRules) {
    if (!rawRule || typeof rawRule !== "object" || Array.isArray(rawRule)) {
      continue
    }
    const r = rawRule as Record<string, unknown>
    const id = typeof r.id === "string" ? r.id : "unnamed_rule"
    const title = typeof r.title === "string" ? r.title : id
    const severity = typeof r.severity === "string" ? r.severity : "info"
    const enabled = r.enabled === true
    const tags = Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === "string")
      : []
    const aggregate =
      r.aggregate && typeof r.aggregate === "object" && !Array.isArray(r.aggregate)
        ? (r.aggregate as Record<string, unknown>)
        : null

    if (enabled) enabledRules += 1
    else disabledRules += 1
    if (aggregate) aggregateRules += 1

    severityCounts[severity] = (severityCounts[severity] ?? 0) + 1
    for (const tag of tags) tagSet.add(tag)

    rules.push({
      id,
      title,
      severity,
      enabled,
      tags,
      hasAggregate: Boolean(aggregate),
      aggregateGroupBy:
        aggregate && typeof aggregate.groupBy === "string" ? aggregate.groupBy : null,
      aggregateWindowSeconds:
        aggregate && typeof aggregate.windowSeconds === "number" ? aggregate.windowSeconds : null,
      description: typeof r.description === "string" ? r.description : null,
    })
  }

  return {
    filePath: meta.filePath,
    detected: true,
    engine: meta.engine,
    byteLength: meta.byteLength,
    schemaVersion,
    totalRules: rules.length,
    enabledRules,
    disabledRules,
    aggregateRules,
    severityCounts,
    tags: Array.from(tagSet).sort((a, b) => a.localeCompare(b)),
    rules,
  }
}
