export const WEBLOG_SEVERITY_RULES = [
  { severity: "CRITICAL", minimum: 78, range: "78–100" },
  { severity: "HIGH", minimum: 56, range: "56–77" },
  { severity: "WATCH", minimum: 32, range: "32–55" },
  { severity: "NORMAL", minimum: 0, range: "0–31" },
] as const

export type WebLogSeverity = (typeof WEBLOG_SEVERITY_RULES)[number]["severity"]
