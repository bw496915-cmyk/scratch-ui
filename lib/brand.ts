/**
 * Nominal Branded Type Engine, `Bun.CryptoHasher("sha256")` Digest Backing, and Live `bun:sqlite`
 * Schema-Verified SQL Identifier Brands (SSOT for `design/domain-branded-types.ts` and runtime
 * domain guardrails).
 *
 * @file Lib/brand.ts
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

declare const __brand: unique symbol

export type Brand<T, Tag extends string> = T & { readonly [__brand]: Tag }

export type IsoTime = Brand<string, "IsoTime">
export type Sha256Hex = Brand<string, "Sha256Hex">
export type JsonText = Brand<string, "JsonText">
export type SqlTableName = Brand<string, "SqlTableName">
export type SqlColumnName = Brand<string, "SqlColumnName">
export type SqlIndexName = Brand<string, "SqlIndexName">
export type SqlDomain = Brand<string, "SqlDomain">

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const SQL_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/
const SQL_DOMAIN_RE = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/

interface BunHasherRuntime {
  readonly CryptoHasher?: new (algorithm: string) => {
    update(data: string | Uint8Array | ArrayBuffer): unknown
    digest(encoding: "hex"): string
  }
  readonly file?: (path: string) => {
    bytes(): Promise<Uint8Array>
  }
}

export interface SqliteStatementLike {
  all(...params: unknown[]): unknown[]
}

export interface SqliteDatabaseLike {
  query(sql: string): SqliteStatementLike
}

export interface SqliteSchemaCatalog {
  readonly tables: ReadonlySet<string>
  readonly columnsByTable: ReadonlyMap<string, ReadonlySet<string>>
  readonly indexes: ReadonlySet<string>
}

function getBunRuntime(): BunHasherRuntime | undefined {
  return (globalThis as { readonly Bun?: BunHasherRuntime }).Bun
}

export function isIsoTime(value: unknown): value is IsoTime {
  if (typeof value !== "string" || !ISO_UTC_RE.test(value)) {
    return false
  }
  return !Number.isNaN(Date.parse(value))
}

export function isoTime(value?: string | Date | number): IsoTime {
  if (value === undefined) {
    return new Date().toISOString() as IsoTime
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!isIsoTime(trimmed)) {
      throw new TypeError(`Invalid ISO-8601 timestamp: '${value}'`)
    }
    return trimmed
  }
  const ms = value instanceof Date ? value.getTime() : value
  if (!Number.isFinite(ms)) {
    throw new TypeError(`Invalid epoch/Date for IsoTime: '${String(value)}'`)
  }
  return new Date(ms).toISOString() as IsoTime
}

export function isSha256Hex(value: unknown): value is Sha256Hex {
  return typeof value === "string" && SHA256_HEX_RE.test(value)
}

export function sha256FromDigest(digest: string | Uint8Array): Sha256Hex {
  if (typeof digest === "string") {
    const normalized = digest.trim().toLowerCase()
    if (!isSha256Hex(normalized)) {
      throw new TypeError(`Expected 64-char hex SHA-256 digest, received: '${digest}'`)
    }
    return normalized
  }
  if (digest.byteLength !== 32) {
    throw new RangeError(
      `Expected 32-byte SHA-256 digest Uint8Array, received ${digest.byteLength} bytes`,
    )
  }
  let hex = ""
  for (let i = 0; i < digest.length; i += 1) {
    hex += digest[i]!.toString(16).padStart(2, "0")
  }
  return hex as Sha256Hex
}

export function sha256Hex(input: string | Uint8Array | ArrayBuffer): Sha256Hex {
  const bun = getBunRuntime()
  if (bun?.CryptoHasher) {
    const hasher = new bun.CryptoHasher("sha256")
    hasher.update(input)
    return hasher.digest("hex") as Sha256Hex
  }
  const payload = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  return createHash("sha256").update(payload).digest("hex") as Sha256Hex
}

export function sha256FileHexSync(filePath: string): Sha256Hex {
  return sha256Hex(readFileSync(filePath))
}

export async function sha256FileHex(filePath: string): Promise<Sha256Hex> {
  const bun = getBunRuntime()
  if (bun?.file) {
    return sha256Hex(await bun.file(filePath).bytes())
  }
  return sha256FileHexSync(filePath)
}

export function jsonText(value: unknown): JsonText {
  if (typeof value === "string") {
    try {
      JSON.parse(value)
    } catch (err) {
      throw new TypeError(
        `Invalid JSON string for JsonText: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return value as JsonText
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError("Cannot serialize undefined/function into JsonText")
  }
  return serialized as JsonText
}

function assertSqlIdent(kind: string, raw: string, pattern: RegExp): string {
  const trimmed = raw.trim()
  if (!pattern.test(trimmed)) {
    throw new TypeError(`Unsafe or invalid SQL ${kind} identifier: '${raw}'`)
  }
  return trimmed
}

export function sqlTable(name: string): SqlTableName {
  return assertSqlIdent("table", name, SQL_IDENT_RE) as SqlTableName
}

export function sqlCol(name: string): SqlColumnName {
  return assertSqlIdent("column", name, SQL_IDENT_RE) as SqlColumnName
}

export function sqlIndex(name: string): SqlIndexName {
  return assertSqlIdent("index", name, SQL_IDENT_RE) as SqlIndexName
}

export function sqlDomain(name: string): SqlDomain {
  return assertSqlIdent("domain", name, SQL_DOMAIN_RE) as SqlDomain
}

function isSchemaCatalog(
  dbOrSchema: SqliteDatabaseLike | SqliteSchemaCatalog,
): dbOrSchema is SqliteSchemaCatalog {
  return "tables" in dbOrSchema && "columnsByTable" in dbOrSchema && "indexes" in dbOrSchema
}

export function introspectSqliteSchema(db: SqliteDatabaseLike): SqliteSchemaCatalog {
  const masterRows = db
    .query(
      "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view', 'index') AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { readonly name: string; readonly type: string }[]

  const tables = new Set<string>()
  const indexes = new Set<string>()
  const columnsByTable = new Map<string, Set<string>>()

  for (const row of masterRows) {
    if (row.type === "table" || row.type === "view") {
      const safeTable = sqlTable(row.name)
      tables.add(safeTable)
      const pragmaRows = db.query(`PRAGMA table_info("${safeTable}")`).all() as {
        readonly name: string
      }[]
      const cols = new Set<string>()
      for (const colRow of pragmaRows) {
        cols.add(sqlCol(colRow.name))
      }
      columnsByTable.set(safeTable, cols)
    } else if (row.type === "index") {
      indexes.add(sqlIndex(row.name))
    }
  }

  return { tables, columnsByTable, indexes }
}

function resolveSchema(dbOrSchema: SqliteDatabaseLike | SqliteSchemaCatalog): SqliteSchemaCatalog {
  return isSchemaCatalog(dbOrSchema) ? dbOrSchema : introspectSqliteSchema(dbOrSchema)
}

export function sqlTableFromSchema(
  dbOrSchema: SqliteDatabaseLike | SqliteSchemaCatalog,
  name: string,
): SqlTableName {
  const safe = sqlTable(name)
  const schema = resolveSchema(dbOrSchema)
  if (!schema.tables.has(safe)) {
    throw new RangeError(`SQL table '${safe}' does not exist in live bun:sqlite schema`)
  }
  return safe
}

export function sqlColFromSchema(
  dbOrSchema: SqliteDatabaseLike | SqliteSchemaCatalog,
  table: string,
  column: string,
): SqlColumnName {
  const safeTable = sqlTableFromSchema(dbOrSchema, table)
  const safeCol = sqlCol(column)
  const schema = resolveSchema(dbOrSchema)
  const cols = schema.columnsByTable.get(safeTable)
  if (!cols || !cols.has(safeCol)) {
    throw new RangeError(
      `SQL column '${safeCol}' does not exist on table '${safeTable}' in live bun:sqlite schema`,
    )
  }
  return safeCol
}

export function sqlIndexFromSchema(
  dbOrSchema: SqliteDatabaseLike | SqliteSchemaCatalog,
  name: string,
): SqlIndexName {
  const safe = sqlIndex(name)
  const schema = resolveSchema(dbOrSchema)
  if (!schema.indexes.has(safe)) {
    throw new RangeError(`SQL index '${safe}' does not exist in live bun:sqlite schema`)
  }
  return safe
}
