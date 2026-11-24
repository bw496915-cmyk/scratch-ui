import type { RiskThresholdStatus } from "./risk_threshold_alert.ts"

export const RISK_BREACH_SOUND_PREFS_STORAGE_KEY = "sd_risk_60m_breach_sound_prefs_v1"

export type RiskBreachSoundTone = "subtle-ping" | "double-chime" | "radar-pulse"

export interface RiskBreachSoundPrefs {
  readonly enabled: boolean
  readonly tone: RiskBreachSoundTone
  /** Normalized gain multiplier in [0.05, 1.0]. */
  readonly volume: number
  /** Minimum seconds between repeated breach notifications while already breached. */
  readonly cooldownSec: number
}

export const DEFAULT_RISK_BREACH_SOUND_PREFS: RiskBreachSoundPrefs = {
  enabled: true,
  tone: "subtle-ping",
  volume: 0.35,
  cooldownSec: 60,
}

export const RISK_BREACH_SOUND_TONE_OPTIONS: readonly {
  readonly id: RiskBreachSoundTone
  readonly label: string
  readonly description: string
}[] = [
  {
    id: "subtle-ping",
    label: "Subtle Ping",
    description: "Soft harmonic sine chime (A5 → D6)",
  },
  {
    id: "double-chime",
    label: "Double Chime",
    description: "Two-note desk alert (E5 · B5)",
  },
  {
    id: "radar-pulse",
    label: "Radar Pulse",
    description: "Low-register monitoring pulse (A4 → C5)",
  },
] as const

export const RISK_BREACH_SOUND_COOLDOWN_OPTIONS = [15, 30, 60, 120, 300] as const

const VALID_TONES = new Set<string>(RISK_BREACH_SOUND_TONE_OPTIONS.map((t) => t.id))

export function clampSoundVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RISK_BREACH_SOUND_PREFS.volume
  return Math.round(Math.min(1, Math.max(0.05, value)) * 100) / 100
}

export function clampSoundCooldownSec(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RISK_BREACH_SOUND_PREFS.cooldownSec
  return Math.round(Math.min(600, Math.max(5, value)))
}

export function normalizeRiskBreachSoundPrefs(
  raw: Partial<Record<keyof RiskBreachSoundPrefs, unknown>> | null | undefined,
): RiskBreachSoundPrefs {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_RISK_BREACH_SOUND_PREFS
  }
  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_RISK_BREACH_SOUND_PREFS.enabled
  const tone: RiskBreachSoundTone =
    typeof raw.tone === "string" && VALID_TONES.has(raw.tone)
      ? (raw.tone as RiskBreachSoundTone)
      : DEFAULT_RISK_BREACH_SOUND_PREFS.tone
  const volume =
    typeof raw.volume === "number"
      ? clampSoundVolume(raw.volume)
      : DEFAULT_RISK_BREACH_SOUND_PREFS.volume
  const cooldownSec =
    typeof raw.cooldownSec === "number"
      ? clampSoundCooldownSec(raw.cooldownSec)
      : DEFAULT_RISK_BREACH_SOUND_PREFS.cooldownSec

  return { enabled, tone, volume, cooldownSec }
}

export function readStoredRiskBreachSoundPrefs(
  storage?: Pick<Storage, "getItem"> | null,
): RiskBreachSoundPrefs {
  try {
    const store =
      storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null
    if (!store) return DEFAULT_RISK_BREACH_SOUND_PREFS
    const raw = store.getItem(RISK_BREACH_SOUND_PREFS_STORAGE_KEY)
    if (!raw) return DEFAULT_RISK_BREACH_SOUND_PREFS
    const parsed = JSON.parse(raw) as Partial<Record<keyof RiskBreachSoundPrefs, unknown>>
    return normalizeRiskBreachSoundPrefs(parsed)
  } catch {
    return DEFAULT_RISK_BREACH_SOUND_PREFS
  }
}

export function writeStoredRiskBreachSoundPrefs(
  prefs: RiskBreachSoundPrefs,
  storage?: Pick<Storage, "setItem"> | null,
): RiskBreachSoundPrefs {
  const normalized = normalizeRiskBreachSoundPrefs(prefs)
  try {
    const store =
      storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null
    if (store) {
      store.setItem(RISK_BREACH_SOUND_PREFS_STORAGE_KEY, JSON.stringify(normalized))
    }
  } catch {
    // Ignore storage quota / private-mode restrictions; in-memory state stays authoritative.
  }
  return normalized
}

export interface BreachSoundTriggerInput {
  readonly enabled: boolean
  readonly prevStatus: RiskThresholdStatus | null
  readonly nextStatus: RiskThresholdStatus
  readonly prevExcessUsd: number
  readonly nextExcessUsd: number
  /** Monotonic clock reading in milliseconds (e.g. performance.now()). */
  readonly nowMonotonicMs: number
  readonly lastPlayedMonotonicMs: number | null
  readonly cooldownSec: number
}

/**
 * Determines whether a breach sound cue should fire.
 *
 * - Fires immediately on fresh entry into "breach" (from idle, ok, warn, or initial load).
 * - While already in "breach", fires again only after `cooldownSec` has elapsed AND excess exposure
 *   increased (new breach risk arrived), avoiding repetitive audio spam.
 */
export function shouldTriggerRiskBreachSound(input: BreachSoundTriggerInput): boolean {
  if (!input.enabled || input.nextStatus !== "breach") {
    return false
  }
  if (input.prevStatus !== "breach") {
    return true
  }
  if (input.lastPlayedMonotonicMs === null) {
    return true
  }
  const elapsedMs = Math.max(0, input.nowMonotonicMs - input.lastPlayedMonotonicMs)
  const cooldownMs = clampSoundCooldownSec(input.cooldownSec) * 1000
  return elapsedMs >= cooldownMs && input.nextExcessUsd > input.prevExcessUsd
}

export interface AudioParamLike {
  setValueAtTime: (value: number, startTime: number) => unknown
  exponentialRampToValueAtTime: (value: number, endTime: number) => unknown
  linearRampToValueAtTime?: (value: number, endTime: number) => unknown
}

export interface OscillatorNodeLike {
  type: OscillatorType
  frequency: AudioParamLike
  connect: (destination: unknown) => unknown
  start: (when?: number) => unknown
  stop: (when?: number) => unknown
}

export interface GainNodeLike {
  gain: AudioParamLike
  connect: (destination: unknown) => unknown
}

export interface AudioContextLike {
  readonly currentTime: number
  readonly state?: string
  readonly destination: unknown
  resume?: () => Promise<void>
  createOscillator: () => OscillatorNodeLike
  createGain: () => GainNodeLike
}

export interface PlayToneResult {
  readonly played: boolean
  readonly reason?: string
}

let sharedAudioContext: AudioContextLike | null = null

function resolveBrowserAudioContext(): AudioContextLike | null {
  if (typeof window === "undefined") return null
  if (sharedAudioContext) return sharedAudioContext
  const w = window as unknown as {
    AudioContext?: new () => AudioContextLike
    webkitAudioContext?: new () => AudioContextLike
  }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) return null
  try {
    sharedAudioContext = new Ctor()
    return sharedAudioContext
  } catch {
    return null
  }
}

interface ToneNoteSpec {
  readonly offsetSec: number
  readonly durationSec: number
  readonly startHz: number
  readonly endHz: number
  readonly peakGain: number
  readonly waveform: OscillatorType
}

export function getBreachToneNotes(
  tone: RiskBreachSoundTone,
  volume: number,
): readonly ToneNoteSpec[] {
  const safeVol = clampSoundVolume(volume)
  if (tone === "double-chime") {
    return [
      {
        offsetSec: 0,
        durationSec: 0.22,
        startHz: 659.25,
        endHz: 659.25,
        peakGain: safeVol * 0.22,
        waveform: "sine",
      },
      {
        offsetSec: 0.14,
        durationSec: 0.34,
        startHz: 987.77,
        endHz: 987.77,
        peakGain: safeVol * 0.2,
        waveform: "sine",
      },
    ]
  }
  if (tone === "radar-pulse") {
    return [
      {
        offsetSec: 0,
        durationSec: 0.38,
        startHz: 440,
        endHz: 523.25,
        peakGain: safeVol * 0.24,
        waveform: "triangle",
      },
    ]
  }
  // Default: "subtle-ping"
  return [
    {
      offsetSec: 0,
      durationSec: 0.36,
      startHz: 880,
      endHz: 1174.66,
      peakGain: safeVol * 0.22,
      waveform: "sine",
    },
  ]
}

/**
 * Synthesizes a subtle Web Audio API breach notification tone with smooth gain envelopes
 * (click-free). Never throws if audio is unavailable or blocked.
 */
export function playRiskBreachTone(
  prefs: Pick<RiskBreachSoundPrefs, "tone" | "volume">,
  options?: {
    readonly audioContext?: AudioContextLike | null
  },
): PlayToneResult {
  const ctx =
    options && options.audioContext !== undefined
      ? options.audioContext
      : resolveBrowserAudioContext()

  if (!ctx) {
    return { played: false, reason: "audio_unavailable" }
  }

  try {
    if (ctx.state === "suspended" && typeof ctx.resume === "function") {
      void ctx.resume().catch(() => {
        // Autoplay policy may suspend audio until first operator gesture.
      })
    }

    const baseTime = ctx.currentTime
    const notes = getBreachToneNotes(prefs.tone, prefs.volume)
    for (const note of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const startAt = baseTime + note.offsetSec
      const attackEnd = startAt + 0.018
      const endAt = startAt + note.durationSec

      osc.type = note.waveform
      osc.frequency.setValueAtTime(note.startHz, startAt)
      if (note.endHz !== note.startHz) {
        osc.frequency.exponentialRampToValueAtTime(note.endHz, endAt)
      }

      gain.gain.setValueAtTime(0.0001, startAt)
      if (typeof gain.gain.linearRampToValueAtTime === "function") {
        gain.gain.linearRampToValueAtTime(Math.max(0.001, note.peakGain), attackEnd)
      } else {
        gain.gain.exponentialRampToValueAtTime(Math.max(0.001, note.peakGain), attackEnd)
      }
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt)

      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(startAt)
      osc.stop(endAt + 0.01)
    }

    return { played: true }
  } catch {
    return { played: false, reason: "audio_error" }
  }
}
