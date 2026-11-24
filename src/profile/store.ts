/**
 * Session-scoped profile theme store and in-memory implementation.
 *
 * @file Src/profile/store.ts
 */

import type { Profile, ProfileTheme } from "./types.ts"
import { DEFAULT_PROFILE_THEME } from "./types.ts"

export interface ProfileStore {
  get(sessionId: string): Profile | null
  putTheme(sessionId: string, theme: ProfileTheme): Profile | null
}

export function createMemoryProfileStore(): ProfileStore {
  const rows = new Map<string, Profile>()
  return {
    get(sessionId) {
      return rows.get(sessionId) ?? null
    },
    putTheme(sessionId, theme) {
      const next: Profile = {
        sessionId,
        theme,
        updatedAt: new Date().toISOString(),
      }
      rows.set(sessionId, next)
      return next
    },
  }
}

export function profileOrDefault(store: ProfileStore, sessionId: string): Profile {
  return (
    store.get(sessionId) ?? {
      sessionId,
      theme: DEFAULT_PROFILE_THEME,
      updatedAt: new Date(0).toISOString(),
    }
  )
}
