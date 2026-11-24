import { describe, expect, test } from "bun:test"

import {
  type AudioContextLike,
  DEFAULT_RISK_BREACH_SOUND_PREFS,
  getBreachToneNotes,
  normalizeRiskBreachSoundPrefs,
  playRiskBreachTone,
  readStoredRiskBreachSoundPrefs,
  RISK_BREACH_SOUND_PREFS_STORAGE_KEY,
  shouldTriggerRiskBreachSound,
  writeStoredRiskBreachSoundPrefs,
} from "../../packages/ui/src/risk_breach_audio.ts"

function makeMemoryStorage(): Pick<Storage, "getItem" | "setItem"> & {
  map: Map<string, string>
} {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
  }
}

describe("risk_breach_audio", () => {
  test("persists and normalizes sound preferences safely in localStorage", () => {
    const store = makeMemoryStorage()
    expect(readStoredRiskBreachSoundPrefs(store)).toEqual(DEFAULT_RISK_BREACH_SOUND_PREFS)

    const saved = writeStoredRiskBreachSoundPrefs(
      {
        enabled: false,
        tone: "double-chime",
        volume: 0.75,
        cooldownSec: 120,
      },
      store,
    )
    expect(saved).toEqual({
      enabled: false,
      tone: "double-chime",
      volume: 0.75,
      cooldownSec: 120,
    })
    expect(readStoredRiskBreachSoundPrefs(store)).toEqual(saved)

    // Clamps out-of-range values and falls back on unknown tone or corrupt JSON
    expect(
      normalizeRiskBreachSoundPrefs({
        enabled: true,
        tone: "unknown-tone" as never,
        volume: 99,
        cooldownSec: 1,
      }),
    ).toEqual({
      enabled: true,
      tone: "subtle-ping",
      volume: 1,
      cooldownSec: 5,
    })

    store.setItem(RISK_BREACH_SOUND_PREFS_STORAGE_KEY, "{not-valid-json")
    expect(readStoredRiskBreachSoundPrefs(store)).toEqual(DEFAULT_RISK_BREACH_SOUND_PREFS)
  })

  test("triggers on breach entry and respects monotonic cooldown on continued breaches", () => {
    // Muted or non-breach never triggers
    expect(
      shouldTriggerRiskBreachSound({
        enabled: false,
        prevStatus: "warn",
        nextStatus: "breach",
        prevExcessUsd: 0,
        nextExcessUsd: 500,
        nowMonotonicMs: 1_000,
        lastPlayedMonotonicMs: null,
        cooldownSec: 60,
      }),
    ).toBe(false)

    expect(
      shouldTriggerRiskBreachSound({
        enabled: true,
        prevStatus: "ok",
        nextStatus: "warn",
        prevExcessUsd: 0,
        nextExcessUsd: 0,
        nowMonotonicMs: 1_000,
        lastPlayedMonotonicMs: null,
        cooldownSec: 60,
      }),
    ).toBe(false)

    // Transition from warn -> breach fires immediately
    expect(
      shouldTriggerRiskBreachSound({
        enabled: true,
        prevStatus: "warn",
        nextStatus: "breach",
        prevExcessUsd: 0,
        nextExcessUsd: 1_200,
        nowMonotonicMs: 10_000,
        lastPlayedMonotonicMs: null,
        cooldownSec: 60,
      }),
    ).toBe(true)

    // Staying in breach within cooldown suppresses spam even if excess grows
    expect(
      shouldTriggerRiskBreachSound({
        enabled: true,
        prevStatus: "breach",
        nextStatus: "breach",
        prevExcessUsd: 1_200,
        nextExcessUsd: 2_400,
        nowMonotonicMs: 45_000,
        lastPlayedMonotonicMs: 10_000,
        cooldownSec: 60,
      }),
    ).toBe(false)

    // Staying in breach past cooldown with flat excess does not re-trigger
    expect(
      shouldTriggerRiskBreachSound({
        enabled: true,
        prevStatus: "breach",
        nextStatus: "breach",
        prevExcessUsd: 2_400,
        nextExcessUsd: 2_400,
        nowMonotonicMs: 75_000,
        lastPlayedMonotonicMs: 10_000,
        cooldownSec: 60,
      }),
    ).toBe(false)

    // Staying in breach past cooldown WITH increased excess triggers again
    expect(
      shouldTriggerRiskBreachSound({
        enabled: true,
        prevStatus: "breach",
        nextStatus: "breach",
        prevExcessUsd: 2_400,
        nextExcessUsd: 3_100,
        nowMonotonicMs: 75_000,
        lastPlayedMonotonicMs: 10_000,
        cooldownSec: 60,
      }),
    ).toBe(true)
  })

  test("synthesizes Web Audio tones cleanly and degrades gracefully when audio is unavailable", () => {
    expect(playRiskBreachTone({ tone: "subtle-ping", volume: 0.4 }, { audioContext: null })).toEqual({
      played: false,
      reason: "audio_unavailable",
    })

    let resumed = false
    let startedCount = 0
    let stoppedCount = 0
    const mockCtx: AudioContextLike = {
      currentTime: 1.5,
      state: "suspended",
      destination: {},
      resume: async () => {
        resumed = true
      },
      createOscillator: () => ({
        type: "sine",
        frequency: {
          setValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
        start: () => {
          startedCount += 1
        },
        stop: () => {
          stoppedCount += 1
        },
      }),
      createGain: () => ({
        gain: {
          setValueAtTime: () => {},
          linearRampToValueAtTime: () => {},
          exponentialRampToValueAtTime: () => {},
        },
        connect: () => {},
      }),
    }

    const res = playRiskBreachTone({ tone: "double-chime", volume: 0.5 }, { audioContext: mockCtx })
    expect(res).toEqual({ played: true })
    expect(resumed).toBe(true)
    expect(startedCount).toBe(getBreachToneNotes("double-chime", 0.5).length)
    expect(stoppedCount).toBe(2)
  })
})
