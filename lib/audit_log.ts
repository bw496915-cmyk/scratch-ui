/**
 * @file lib/audit_log.ts
 * @description In-memory audit log adapter for AI Studio Node.js runtime.
 */

export interface AuditEntry {
  readonly timestamp: string
  readonly action: string
  readonly configPath?: string | undefined
  readonly details?: Record<string, unknown> | undefined
}

const auditHistory: AuditEntry[] = []

export function auditConfig(entry: Omit<AuditEntry, "timestamp">): void {
  auditHistory.push({
    timestamp: new Date().toISOString(),
    ...entry,
  })
  if (auditHistory.length > 200) {
    auditHistory.shift()
  }
}

export function getAuditHistory(): readonly AuditEntry[] {
  return auditHistory
}
