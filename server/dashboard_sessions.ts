import { randomBytes } from "node:crypto"
import { closeSync, mkdirSync, openSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { digestSessionId, type SessionRecord, type SessionStore } from "../lib/http_auth.ts"
import type { ProfileStore } from "../src/profile/store.ts"
import { parseProfileTheme } from "../src/profile/validate.ts"

type SqlBinding = string | number

interface DashboardDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    get(...params: SqlBinding[]): Record<string, unknown> | null | undefined
    run(...params: SqlBinding[]): { changes: number | bigint }
  }
  close(): void
}

async function openDashboardDatabase(path: string): Promise<DashboardDatabase> {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite")
    const db = new Database(path, { strict: true })
    return {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => db.query<Record<string, unknown>, SqlBinding[]>(sql),
      close: () => db.close(),
    }
  }
  const { DatabaseSync } = await import("node:sqlite")
  return new DatabaseSync(path)
}

/** Store only the digest of the browser's session ID, including in the theme table. */
export async function openDashboardState(configuredPath: string) {
  const path = resolve(configuredPath)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  closeSync(openSync(path, "a", 0o600))
  const db = await openDashboardDatabase(path)
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS dashboard_sessions (
        id TEXT PRIMARY KEY,
        csrfToken TEXT NOT NULL,
        operatorId TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('OPERATOR', 'ADMIN')),
        credentialProof TEXT NOT NULL,
        expiresAtMs INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS dashboard_session_expiry ON dashboard_sessions (expiresAtMs);
      CREATE TABLE IF NOT EXISTS dashboard_profile_themes (
        session_id TEXT PRIMARY KEY REFERENCES dashboard_sessions (id) ON DELETE CASCADE,
        theme TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS dashboard_settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `)
    return {
      sessions: prepareSessions(db),
      profiles: prepareProfiles(db),
      getOrCreateCsrfSecret: () => getOrCreateCsrfSecret(db),
      close: () => db.close(),
    }
  } catch (error) {
    db.close()
    throw error
  }
}

function getOrCreateCsrfSecret(db: DashboardDatabase): string {
  const name = "csrf_secret"
  db.prepare("INSERT INTO dashboard_settings VALUES (?, ?) ON CONFLICT (name) DO NOTHING").run(
    name,
    randomBytes(32).toString("hex"),
  )
  const row = db.prepare("SELECT value FROM dashboard_settings WHERE name = ?").get(name)
  if (typeof row?.value !== "string" || !/^[0-9a-f]{64}$/.test(row.value)) {
    throw new Error("Invalid CSRF signing key in dashboard SQLite settings")
  }
  return row.value
}

function prepareSessions(db: DashboardDatabase): SessionStore {
  const read = db.prepare("SELECT * FROM dashboard_sessions WHERE id = ?")
  const insert = db.prepare("INSERT INTO dashboard_sessions VALUES (?, ?, ?, ?, ?, ?)")
  const remove = db.prepare("DELETE FROM dashboard_sessions WHERE id = ?")
  const purge = db.prepare("DELETE FROM dashboard_sessions WHERE expiresAtMs <= ?")
  return {
    get(id) {
      const row = read.get(id)
      if (!row) return undefined
      const { csrfToken, operatorId, role, credentialProof, expiresAtMs } = row
      if (
        typeof csrfToken !== "string" ||
        typeof operatorId !== "string" ||
        (role !== "ADMIN" && role !== "OPERATOR") ||
        typeof credentialProof !== "string" ||
        typeof expiresAtMs !== "number"
      )
        return undefined
      return { csrfToken, operatorId, role, credentialProof, expiresAtMs }
    },
    insert(id, record: SessionRecord) {
      insert.run(
        id,
        record.csrfToken,
        record.operatorId,
        record.role,
        record.credentialProof ?? "",
        record.expiresAtMs,
      )
    },
    delete(id) {
      remove.run(id)
    },
    purgeExpired(now) {
      return Number(purge.run(now).changes)
    },
  }
}

function prepareProfiles(db: DashboardDatabase): ProfileStore {
  const read = db.prepare(`
    SELECT theme, updated_at
    FROM dashboard_profile_themes
    JOIN dashboard_sessions ON dashboard_sessions.id = dashboard_profile_themes.session_id
    WHERE session_id = ? AND expiresAtMs > ?
  `)
  const upsert = db.prepare(`
    INSERT INTO dashboard_profile_themes (session_id, theme, updated_at)
    SELECT id, ?, ? FROM dashboard_sessions WHERE id = ? AND expiresAtMs > ?
    ON CONFLICT (session_id) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at
  `)
  return {
    get(sessionId) {
      const row = read.get(digestSessionId(sessionId), Date.now())
      if (typeof row?.theme !== "string" || typeof row.updated_at !== "string") return null
      let value: unknown
      try {
        value = JSON.parse(row.theme)
      } catch {
        return null
      }
      const parsed = parseProfileTheme(value)
      return parsed.ok ? { sessionId, theme: parsed.value, updatedAt: row.updated_at } : null
    },
    putTheme(sessionId, theme) {
      const now = Date.now()
      const updatedAt = new Date(now).toISOString()
      // Revocation or expiry may happen while the route is reading the request body.
      const result = upsert.run(JSON.stringify(theme), updatedAt, digestSessionId(sessionId), now)
      return Number(result.changes) > 0 ? { sessionId, theme, updatedAt } : null
    },
  }
}
