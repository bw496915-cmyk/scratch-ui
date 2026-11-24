/**
 * Zero-dependency lexical static checker enforcing Bun `bun:test` snapshot lint rules across
 * `tests/`:
 *
 * - `bun:test/prefer-snapshot-hint`: requires an explicit hint string when a single `test(...)` /
 *   `it(...)` block contains multiple `toMatchSnapshot` calls.
 * - `bun:test/no-large-snapshots`: enforces max 50 lines for inline snapshots.
 * - `bun:test/no-interpolation-in-snapshots`: bans `${...}` inside inline snapshots.
 * - Verifies every `.snap` file starts with a recognized runner header (`// Bun Snapshot v1`, `//
 *   Vitest Snapshot v1`, or `// Jest Snapshot v1`).
 *
 * @file Scripts/check_snapshot_hygiene.ts
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

export const MAX_INLINE_SNAPSHOT_LINES = 50

export interface SnapshotLintViolation {
  readonly rule:
    | "bun:test/prefer-snapshot-hint"
    | "bun:test/no-large-snapshots"
    | "bun:test/no-interpolation-in-snapshots"
    | "bun:test/valid-snapshot-header"
  readonly file: string
  readonly line: number
  readonly message: string
}

const VALID_SNAP_HEADER_RE = /^\/\/\s*(?:Bun|Vitest|Jest)\s+Snapshot\s+v\d+/

type TokenKind = "ident" | "string" | "template" | "punct"

interface LexToken {
  readonly kind: TokenKind
  readonly text: string
  readonly line: number
  readonly hasInterpolation?: boolean | undefined
}

/**
 * Lightweight JS/TS lexer skipping comments and tokenizing strings, template literals (with
 * `${...}` detection), identifiers, and punctuation.
 */
function tokenizeSource(source: string): readonly LexToken[] {
  const tokens: LexToken[] = []
  let i = 0
  let line = 1

  const advance = (count = 1): void => {
    for (let k = 0; k < count && i < source.length; k += 1) {
      if (source[i] === "\n") line += 1
      i += 1
    }
  }

  while (i < source.length) {
    const ch = source[i]!
    const next = i + 1 < source.length ? source[i + 1] : ""

    // Whitespace
    if (/\s/.test(ch)) {
      advance()
      continue
    }

    // Line comment
    if (ch === "/" && next === "/") {
      advance(2)
      while (i < source.length && source[i] !== "\n") advance()
      continue
    }

    // Block comment
    if (ch === "/" && next === "*") {
      advance(2)
      while (i + 1 < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        advance()
      }
      advance(2)
      continue
    }

    // Single or double quoted string
    if (ch === '"' || ch === "'") {
      const quote = ch
      const startLine = line
      let buf = ""
      advance()
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < source.length) {
          buf += source[i]! + source[i + 1]!
          advance(2)
        } else {
          buf += source[i]!
          advance()
        }
      }
      advance()
      tokens.push({ kind: "string", text: buf, line: startLine })
      continue
    }

    // Template literal (tracks nested `${ ... }` expressions accurately)
    if (ch === "`") {
      const startLine = line
      let buf = ""
      let hasInterpolation = false
      advance()
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\" && i + 1 < source.length) {
          buf += source[i]! + source[i + 1]!
          advance(2)
        } else if (source[i] === "$" && source[i + 1] === "{") {
          hasInterpolation = true
          buf += "${"
          advance(2)
          let depth = 1
          while (i < source.length && depth > 0) {
            const c = source[i]!
            if (c === "{") depth += 1
            else if (c === "}") depth -= 1
            buf += c
            advance()
          }
        } else {
          buf += source[i]!
          advance()
        }
      }
      advance()
      tokens.push({
        kind: "template",
        text: buf,
        line: startLine,
        hasInterpolation,
      })
      continue
    }

    // Identifier
    if (/[a-zA-Z_$]/.test(ch)) {
      const startLine = line
      let ident = ""
      while (i < source.length && /[a-zA-Z0-9_$]/.test(source[i]!)) {
        ident += source[i]!
        advance()
      }
      tokens.push({ kind: "ident", text: ident, line: startLine })
      continue
    }

    // Single punctuation character
    tokens.push({ kind: "punct", text: ch, line })
    advance()
  }

  return tokens
}

function findMatchingClose(
  tokens: readonly LexToken[],
  openIdx: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0
  for (let i = openIdx; i < tokens.length; i += 1) {
    const t = tokens[i]!
    if (t.kind === "punct" && t.text === openChar) depth += 1
    else if (t.kind === "punct" && t.text === closeChar) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return tokens.length - 1
}

/** Scan a test file source string for Bun snapshot lint rule violations. */
export function lintSnapshotTestSource(
  source: string,
  fileLabel: string,
): readonly SnapshotLintViolation[] {
  const tokens = tokenizeSource(source)
  const violations: SnapshotLintViolation[] = []

  const testRanges: { readonly start: number; readonly end: number }[] = []

  // Locate `test(...)` / `it(...)` call ranges
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!
    if (t.kind !== "ident" || (t.text !== "test" && t.text !== "it")) continue
    // Skip property access like `foo.test(...)`
    if (i > 0 && tokens[i - 1]!.kind === "punct" && tokens[i - 1]!.text === ".") {
      continue
    }
    let openParenIdx = i + 1
    if (
      openParenIdx + 2 < tokens.length &&
      tokens[openParenIdx]!.kind === "punct" &&
      tokens[openParenIdx]!.text === "." &&
      tokens[openParenIdx + 1]!.kind === "ident" &&
      ["only", "skip", "todo", "concurrent", "serial"].includes(tokens[openParenIdx + 1]!.text)
    ) {
      openParenIdx += 2
    }
    if (
      openParenIdx < tokens.length &&
      tokens[openParenIdx]!.kind === "punct" &&
      tokens[openParenIdx]!.text === "("
    ) {
      const closeParenIdx = findMatchingClose(tokens, openParenIdx, "(", ")")
      testRanges.push({ start: openParenIdx, end: closeParenIdx })
    }
  }

  // Inspect each test block for snapshot calls
  for (const range of testRanges) {
    const snapCalls: { readonly line: number; readonly hasHint: boolean }[] = []

    for (let i = range.start; i <= range.end; i += 1) {
      const t = tokens[i]!
      if (
        t.kind !== "ident" ||
        i === 0 ||
        tokens[i - 1]!.kind !== "punct" ||
        tokens[i - 1]!.text !== "."
      ) {
        continue
      }

      if (t.text === "toMatchInlineSnapshot") {
        const openIdx = i + 1
        if (
          openIdx <= range.end &&
          tokens[openIdx]!.kind === "punct" &&
          tokens[openIdx]!.text === "("
        ) {
          const closeIdx = findMatchingClose(tokens, openIdx, "(", ")")
          // Inspect string/template argument(s) inside `toMatchInlineSnapshot(...)`
          for (let a = openIdx + 1; a < closeIdx; a += 1) {
            const argTok = tokens[a]!
            if (argTok.kind === "template" || argTok.kind === "string") {
              const lineCount = argTok.text.split(/\r?\n/).length
              if (lineCount > MAX_INLINE_SNAPSHOT_LINES) {
                violations.push({
                  rule: "bun:test/no-large-snapshots",
                  file: fileLabel,
                  line: argTok.line,
                  message: `Inline snapshot is ${lineCount} lines (max ${MAX_INLINE_SNAPSHOT_LINES}); move to an external .snap file.`,
                })
              }
              if (argTok.kind === "template" && argTok.hasInterpolation) {
                violations.push({
                  rule: "bun:test/no-interpolation-in-snapshots",
                  file: fileLabel,
                  line: argTok.line,
                  message:
                    "Template interpolation (`${...}`) is disallowed inside inline snapshots.",
                })
              }
            }
          }
        }
      } else if (t.text === "toMatchSnapshot") {
        const openIdx = i + 1
        if (
          openIdx <= range.end &&
          tokens[openIdx]!.kind === "punct" &&
          tokens[openIdx]!.text === "("
        ) {
          const closeIdx = findMatchingClose(tokens, openIdx, "(", ")")
          // Ignore trailing commas when checking last argument
          let lastArgIdx = closeIdx - 1
          while (
            lastArgIdx > openIdx &&
            tokens[lastArgIdx]!.kind === "punct" &&
            tokens[lastArgIdx]!.text === ","
          ) {
            lastArgIdx -= 1
          }
          const lastArg = lastArgIdx > openIdx ? tokens[lastArgIdx] : null
          const hasHint =
            lastArg !== null &&
            (lastArg.kind === "string" ||
              (lastArg.kind === "template" && !lastArg.hasInterpolation)) &&
            lastArg.text.trim().length > 0
          snapCalls.push({ line: t.line, hasHint })
        }
      }
    }

    if (snapCalls.length > 1) {
      for (const call of snapCalls) {
        if (!call.hasHint) {
          violations.push({
            rule: "bun:test/prefer-snapshot-hint",
            file: fileLabel,
            line: call.line,
            message: `Test contains ${snapCalls.length} snapshots; pass an explicit hint string to toMatchSnapshot("hint").`,
          })
        }
      }
    }
  }

  return violations
}

export function validateSnapshotFileHeader(
  snapContent: string,
  fileLabel: string,
): SnapshotLintViolation | null {
  const firstLine = snapContent.split(/\r?\n/, 1)[0] ?? ""
  if (!VALID_SNAP_HEADER_RE.test(firstLine)) {
    return {
      rule: "bun:test/valid-snapshot-header",
      file: fileLabel,
      line: 1,
      message: `Expected Bun/Vitest/Jest snapshot header on line 1, got: ${JSON.stringify(firstLine)}`,
    }
  }
  return null
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walkFiles(full, out)
    } else {
      out.push(full)
    }
  }
  return out
}

export function runSnapshotHygieneCheck(rootDir: string): readonly SnapshotLintViolation[] {
  const testsDir = resolve(rootDir, "tests")
  const files = walkFiles(testsDir)
  const violations: SnapshotLintViolation[] = []

  for (const fullPath of files) {
    const rel = relative(rootDir, fullPath)
    if (/\.test\.tsx?$/.test(fullPath)) {
      const content = readFileSync(fullPath, "utf8")
      violations.push(...lintSnapshotTestSource(content, rel))
    } else if (fullPath.endsWith(".snap")) {
      const content = readFileSync(fullPath, "utf8")
      const headerViolation = validateSnapshotFileHeader(content, rel)
      if (headerViolation) violations.push(headerViolation)
    }
  }

  return violations
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  resolve(process.argv[1]).endsWith("check_snapshot_hygiene.ts")

if (isMain) {
  const violations = runSnapshotHygieneCheck(process.cwd())
  if (violations.length > 0) {
    console.error("FAIL: Bun snapshot lint violations detected:")
    for (const v of violations) {
      console.error(`  - [${v.rule}] ${v.file}:${v.line} — ${v.message}`)
    }
    process.exit(1)
  }
  console.log(
    "PASS: Bun snapshot lint rules verified (prefer-snapshot-hint, no-large-snapshots <=50 lines, no-interpolation-in-snapshots, runner header).",
  )
}
