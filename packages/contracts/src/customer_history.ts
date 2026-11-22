/** Descriptive retained-wager statistics; never a predictive risk rating or lifetime claim. */
export interface CustomerRetainedHistory {
  readonly basis: "source-reported-retained-wagers"
  readonly wholeAccountHistory: false
  readonly currency: "USD"
  readonly retainedWagers: number
  readonly eligibleWagers: number
  readonly excludedWagers: number
  readonly conflictingWagers: number
  readonly wins: number
  readonly losses: number
  readonly firstSourceTime: string | null
  readonly lastSourceTime: string | null
  readonly sourceTimeZone: "unverified-provider-wall-time"
  readonly sourceDays: number
  readonly stakeUsd: number | null
  readonly meanStakeUsd: number | null
  readonly medianStakeUsd: number | null
  readonly p95StakeUsd: number | null
  readonly maxStakeUsd: number | null
  readonly stakeGini: number | null
  readonly reportedNetUsd: number | null
  readonly provisionalRoiPct: number | null
  readonly reportedWinPct: number | null
}
export function parseCustomerRetainedHistory(value: unknown): CustomerRetainedHistory | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (
    v.basis !== "source-reported-retained-wagers" ||
    v.wholeAccountHistory !== false ||
    v.currency !== "USD" ||
    v.sourceTimeZone !== "unverified-provider-wall-time"
  )
    return null
  for (const k of [
    "retainedWagers",
    "eligibleWagers",
    "excludedWagers",
    "conflictingWagers",
    "wins",
    "losses",
    "sourceDays",
  ])
    if (typeof v[k] !== "number" || !Number.isSafeInteger(v[k]) || Number(v[k]) < 0) return null
  for (const k of [
    "stakeUsd",
    "meanStakeUsd",
    "medianStakeUsd",
    "p95StakeUsd",
    "maxStakeUsd",
    "stakeGini",
    "reportedNetUsd",
    "provisionalRoiPct",
    "reportedWinPct",
  ])
    if (v[k] !== null && (typeof v[k] !== "number" || !Number.isFinite(v[k]))) return null
  for (const k of ["firstSourceTime", "lastSourceTime"])
    if (v[k] !== null && typeof v[k] !== "string") return null
  if (
    Number(v.eligibleWagers) + Number(v.excludedWagers) + Number(v.conflictingWagers) !==
      v.retainedWagers ||
    Number(v.wins) + Number(v.losses) !== v.eligibleWagers
  )
    return null
  if (
    Number(v.eligibleWagers) === 0 &&
    [
      "stakeUsd",
      "meanStakeUsd",
      "medianStakeUsd",
      "p95StakeUsd",
      "maxStakeUsd",
      "stakeGini",
      "reportedNetUsd",
      "provisionalRoiPct",
      "reportedWinPct",
    ].some((k) => v[k] !== null)
  )
    return null
  if (v.stakeGini !== null && (Number(v.stakeGini) < 0 || Number(v.stakeGini) > 1)) return null
  if (
    Number(v.eligibleWagers) > 0 &&
    [
      "stakeUsd",
      "meanStakeUsd",
      "medianStakeUsd",
      "p95StakeUsd",
      "maxStakeUsd",
      "reportedNetUsd",
      "provisionalRoiPct",
      "reportedWinPct",
    ].some((k) => v[k] === null)
  )
    return null
  for (const k of ["stakeUsd", "meanStakeUsd", "medianStakeUsd", "p95StakeUsd", "maxStakeUsd"])
    if (v[k] !== null && Number(v[k]) <= 0) return null
  if (v.reportedWinPct !== null && (Number(v.reportedWinPct) < 0 || Number(v.reportedWinPct) > 100))
    return null
  return value as CustomerRetainedHistory
}
