import { readdir, readFile, stat } from "node:fs/promises"
import { isIP } from "node:net"
import { join } from "node:path"

export interface ProfileAccessEvidence {
  readonly retainedRows: number
  readonly sourceDays: number
  readonly firstSourceTime: string
  readonly lastSourceTime: string
  readonly observedAddresses: number
}

export type ProfileWeblogEvidence =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "retained-mode-a"
      readonly byAccount: ReadonlyMap<string, ProfileAccessEvidence>
      readonly ambiguousLogins?: ReadonlySet<string>
      readonly filesRead: number
      readonly skippedFiles: number
      readonly invalidRows: number
      readonly duplicateRows: number
      readonly retainedRows: number
    }

const MAX_FILES = 31
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_CORPUS_BYTES = 64 * 1024 * 1024
const CAPTURE_FILENAME = /^(\d{2})-(\d{2})-(\d{4})\.jsonl$/
const SOURCE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/

export interface RetainedWeblogRow {
  readonly account: string
  readonly time: string
  readonly operation: string
  readonly address: string
}

function readActivityRecord(value: unknown): RetainedWeblogRow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  if (!("LoginID" in value) || !("AccessDateTime" in value) || !("Operation" in value)) return null
  if (
    typeof value.LoginID !== "string" ||
    typeof value.AccessDateTime !== "string" ||
    typeof value.Operation !== "string"
  )
    return null
  const account = value.LoginID.trim().toUpperCase()
  const time = value.AccessDateTime.trim().replace("T", " ")
  const operation = value.Operation.trim()
  if (
    !/^[A-Z0-9_.-]{1,64}$/.test(account) ||
    !SOURCE_TIME.test(time) ||
    !operation ||
    !Number.isFinite(Date.parse(time.replace(" ", "T") + "Z"))
  )
    return null
  const address =
    "IPAddress" in value && typeof value.IPAddress === "string" ? value.IPAddress.trim() : ""
  return { account, time, operation, address }
}

interface RetainedWeblogSnapshot {
  readonly evidence: ProfileWeblogEvidence
  readonly rows: readonly RetainedWeblogRow[]
}

const UNAVAILABLE_WEBLOG: RetainedWeblogSnapshot = { evidence: { kind: "unavailable" }, rows: [] }

/** Load the same bounded, deduplicated capture for System Logs and profile summaries. */
export function createRetainedWeblogReader(root: string | undefined, batchRoot?: string) {
  let cached: { readonly key: string; readonly result: RetainedWeblogSnapshot } | undefined
  let inFlight: Promise<RetainedWeblogSnapshot> | undefined
  async function readRetainedWeblogs(): Promise<RetainedWeblogSnapshot> {
    const roots = new Set([root, batchRoot])
    const candidates = (
      await Promise.all(
        [...roots].map(async (directory) => {
          if (!directory) return []
          const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
          return entries.flatMap((entry) => {
            const match = CAPTURE_FILENAME.exec(entry.name)
            return entry.isFile() && match
              ? [{ file: join(directory, entry.name), day: `${match[3]}-${match[1]}-${match[2]}` }]
              : []
          })
        }),
      )
    )
      .flat()
      .sort((a, b) => b.day.localeCompare(a.day))
    const files = await Promise.all(
      candidates.slice(0, MAX_FILES).map(async ({ file }) => {
        const info = await stat(file).catch(() => null)
        return { file, info }
      }),
    )
    const key = JSON.stringify([
      candidates.length,
      ...files.map(({ file, info }) => [file, info?.ino, info?.size, info?.mtimeMs]),
    ])
    if (cached?.key === key) return cached.result

    const records = new Map<string, Set<string>>()
    const accounts = new Map<
      string,
      { count: number; times: Set<string>; first: string; last: string; addresses: Set<string> }
    >()
    let filesRead = 0
    let skippedFiles = Math.max(0, candidates.length - MAX_FILES)
    let bytesRead = 0
    let invalidRows = 0
    let duplicateRows = 0
    const rows: RetainedWeblogRow[] = []
    for (const { file, info } of files) {
      if (
        !info?.isFile() ||
        info.size > MAX_FILE_BYTES ||
        bytesRead + info.size > MAX_CORPUS_BYTES
      ) {
        skippedFiles++
        continue
      }
      const body = await readFile(file, "utf8").catch(() => null)
      const actualBytes = body === null ? 0 : Buffer.byteLength(body)
      if (
        body === null ||
        actualBytes > MAX_FILE_BYTES ||
        bytesRead + actualBytes > MAX_CORPUS_BYTES
      ) {
        skippedFiles++
        continue
      }
      bytesRead += actualBytes
      filesRead++
      for (const line of body.split(/\r?\n/)) {
        if (line.trim() === "") continue
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          invalidRows++
          continue
        }
        const row = readActivityRecord(raw)
        if (!row) {
          invalidRows++
          continue
        }
        const identity = JSON.stringify([row.time, row.operation, row.address])
        const seen = records.get(row.account) ?? new Set<string>()
        if (seen.has(identity)) {
          duplicateRows++
          continue
        }
        seen.add(identity)
        records.set(row.account, seen)
        const summary = accounts.get(row.account) ?? {
          count: 0,
          times: new Set<string>(),
          first: row.time,
          last: row.time,
          addresses: new Set<string>(),
        }
        summary.count++
        summary.times.add(row.time.slice(0, 10))
        if (row.time < summary.first) summary.first = row.time
        if (row.time > summary.last) summary.last = row.time
        if (isIP(row.address)) summary.addresses.add(row.address)
        accounts.set(row.account, summary)
        rows.push(row)
      }
    }
    if (filesRead === 0) return UNAVAILABLE_WEBLOG
    const byAccount = new Map<string, ProfileAccessEvidence>()
    for (const [account, summary] of accounts) {
      byAccount.set(account, {
        retainedRows: summary.count,
        sourceDays: summary.times.size,
        firstSourceTime: summary.first,
        lastSourceTime: summary.last,
        observedAddresses: summary.addresses.size,
      })
    }
    const evidence: ProfileWeblogEvidence = {
      kind: "retained-mode-a",
      byAccount,
      filesRead,
      skippedFiles,
      invalidRows,
      duplicateRows,
      retainedRows: rows.length,
    }
    const result = { evidence, rows }
    cached = { key, result }
    return result
  }
  return function loadRetainedWeblogs(): Promise<RetainedWeblogSnapshot> {
    inFlight ??= readRetainedWeblogs().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }
}

/** Index retained actor rows by exact login without returning IPs or operation text. */
export function createProfileWeblogReader(root: string | undefined) {
  const read = createRetainedWeblogReader(root)
  return async () => (await read()).evidence
}

/** A roster login must have one account owner before a radar may show actor evidence. */
export function restrictWeblogEvidenceToUniqueLogins(
  evidence: ProfileWeblogEvidence,
  roster: readonly Record<string, unknown>[],
): ProfileWeblogEvidence {
  if (evidence.kind === "unavailable") return evidence
  const loginCounts = new Map<string, number>()
  for (const row of roster) {
    if (typeof row.login !== "string") continue
    const login = row.login.trim().toUpperCase()
    if (evidence.byAccount.has(login)) loginCounts.set(login, (loginCounts.get(login) ?? 0) + 1)
  }
  const byAccount = new Map<string, ProfileAccessEvidence>()
  const ambiguousLogins = new Set<string>()
  for (const [login, access] of evidence.byAccount) {
    const count = loginCounts.get(login) ?? 0
    if (count === 1) byAccount.set(login, access)
    if (count > 1) ambiguousLogins.add(login)
  }
  return { ...evidence, byAccount, ambiguousLogins }
}
