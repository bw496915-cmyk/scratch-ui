/**
 * @file quick_jump_feed.ts
 * @description Feed freshness for the Desk Quick-Jump ribbon.
 *
 * The ribbon prints wager counts; without an age next to them a stale snapshot
 * reads as live. These helpers are pure so the honesty rule is testable: a
 * missing timestamp is `pending`, never `0s`.
 */

import { formatRelativeAge } from "./relative_time.ts"

export { formatRelativeAge } from "./relative_time.ts"

/** A feed older than this is reported stale rather than as a live number. */
export const QUICK_JUMP_STALE_MS = 60_000

export interface QuickJumpFeedState {
  /** False until the first successful feed update. */
  readonly known: boolean
  /** True when the feed age exceeds the stale budget. */
  readonly stale: boolean
  /** `pending`, `just now`, `12s ago`, … */
  readonly label: string
}

/**
 * Freshness of the live wager feed behind the ribbon's counts. A missing
 * timestamp reports `pending` (unknown), not `just now`.
 */
export function quickJumpFeedState(
  feedUpdatedAt: number | null,
  nowMs: number,
  staleMs: number = QUICK_JUMP_STALE_MS,
): QuickJumpFeedState {
  const age = formatRelativeAge(nowMs, feedUpdatedAt)
  if (age === null || (feedUpdatedAt !== null && feedUpdatedAt > nowMs + 5_000)) {
    return { known: false, stale: false, label: "capture time unknown" }
  }
  const ageMs = nowMs - (feedUpdatedAt ?? nowMs)
  return {
    known: true,
    stale: ageMs > staleMs,
    label: age,
  }
}

/** Tooltip text for the age chip; states what the number is and where it came from. */
export function feedFreshnessTitle(state: QuickJumpFeedState, feedLabel: string): string {
  if (!state.known) {
    return `Capture time unavailable (${feedLabel})`
  }
  if (state.stale) {
    return `Latest wager capture is stale (${feedLabel}, ${state.label})`
  }
  return `${feedLabel} · captured ${state.label}`
}
