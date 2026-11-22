import { AlertTriangle, RotateCcw, ShieldCheck, Sliders, Volume2, VolumeX, X } from "lucide-react"
import type React from "react"
import { useEffect, useMemo, useRef, useState } from "react"

import {
  DEFAULT_RISK_BREACH_SOUND_PREFS,
  playRiskBreachTone,
  RISK_BREACH_SOUND_COOLDOWN_OPTIONS,
  RISK_BREACH_SOUND_TONE_OPTIONS,
  type RiskBreachSoundPrefs,
} from "../risk_breach_audio.ts"
import { formatRiskCompactUsd } from "../risk_exposure_series.ts"
import "../web_mcp.ts"
import {
  DEFAULT_RISK_EXPOSURE_LIMIT_USD,
  DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD,
  evaluateRiskExposureThreshold,
  MAX_RISK_EXPOSURE_LIMIT_USD,
  MIN_RISK_EXPOSURE_LIMIT_USD,
  MIN_RISK_EXPOSURE_WARNING_LIMIT_USD,
  parseRiskThresholdPairInput,
  RISK_EXPOSURE_LIMIT_PRESETS,
  RISK_EXPOSURE_WARN_RATIO,
  type RiskExposureThresholds,
} from "../risk_threshold_alert.ts"

export interface RiskThresholdModalProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly currentThresholds: RiskExposureThresholds
  readonly currentExposureUsd: number
  readonly hasLiveData: boolean
  readonly onSave: (next: RiskExposureThresholds) => void
  readonly soundPrefs?: RiskBreachSoundPrefs | undefined
  readonly onSaveSoundPrefs?: ((next: RiskBreachSoundPrefs) => void) | undefined
}

const WARNING_RATIO_SNAPS = [
  { label: "70%", ratio: 0.7 },
  { label: "80%", ratio: 0.8 },
  { label: "90%", ratio: 0.9 },
] as const

function formatUsdFull(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

export function RiskThresholdModal({
  open,
  onClose,
  currentThresholds,
  currentExposureUsd,
  hasLiveData,
  onSave,
  soundPrefs = DEFAULT_RISK_BREACH_SOUND_PREFS,
  onSaveSoundPrefs,
}: RiskThresholdModalProps): React.ReactElement | null {
  const [breachDraft, setBreachDraft] = useState<string>(() =>
    String(currentThresholds.breachLimitUsd),
  )
  const [warningDraft, setWarningDraft] = useState<string>(() =>
    String(currentThresholds.warningLimitUsd),
  )
  const [soundDraft, setSoundDraft] = useState<RiskBreachSoundPrefs>(soundPrefs)
  const [soundTestStatus, setSoundTestStatus] = useState<string | null>(null)
  const [submittedError, setSubmittedError] = useState<{
    readonly field: "warning" | "breach"
    readonly error: string
  } | null>(null)

  const breachInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setBreachDraft(String(currentThresholds.breachLimitUsd))
    setWarningDraft(String(currentThresholds.warningLimitUsd))
    setSoundDraft(soundPrefs)
    setSoundTestStatus(null)
    setSubmittedError(null)
    const frame = requestAnimationFrame(() => {
      breachInputRef.current?.focus()
      breachInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, currentThresholds.breachLimitUsd, currentThresholds.warningLimitUsd, soundPrefs])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [open, onClose])

  const parsedDraft = useMemo(
    () => parseRiskThresholdPairInput(warningDraft, breachDraft),
    [warningDraft, breachDraft],
  )

  const previewEval = useMemo(() => {
    const activePair = parsedDraft.ok ? parsedDraft.value : currentThresholds
    return evaluateRiskExposureThreshold(currentExposureUsd, activePair.breachLimitUsd, {
      warningLimitUsd: activePair.warningLimitUsd,
      hasData: hasLiveData,
    })
  }, [parsedDraft, currentThresholds, currentExposureUsd, hasLiveData])

  if (!open) return null

  const activeError = submittedError ?? (!parsedDraft.ok ? parsedDraft : null)
  const breachFieldError = activeError?.field === "breach" ? activeError.error : null
  const warningFieldError = activeError?.field === "warning" ? activeError.error : null

  const effectiveBreachForRatio = parsedDraft.ok
    ? parsedDraft.value.breachLimitUsd
    : currentThresholds.breachLimitUsd
  const effectiveWarningRatioPct =
    parsedDraft.ok && parsedDraft.value.breachLimitUsd > 0
      ? Math.round((parsedDraft.value.warningLimitUsd / parsedDraft.value.breachLimitUsd) * 100)
      : null

  const isSoundDirty =
    soundDraft.enabled !== soundPrefs.enabled ||
    soundDraft.tone !== soundPrefs.tone ||
    soundDraft.volume !== soundPrefs.volume ||
    soundDraft.cooldownSec !== soundPrefs.cooldownSec

  const isDirty =
    (parsedDraft.ok &&
      (parsedDraft.value.breachLimitUsd !== currentThresholds.breachLimitUsd ||
        parsedDraft.value.warningLimitUsd !== currentThresholds.warningLimitUsd)) ||
    isSoundDirty

  const isAlreadyDefault =
    parsedDraft.ok &&
    parsedDraft.value.breachLimitUsd === DEFAULT_RISK_EXPOSURE_LIMIT_USD &&
    parsedDraft.value.warningLimitUsd === DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD &&
    soundDraft.enabled === DEFAULT_RISK_BREACH_SOUND_PREFS.enabled &&
    soundDraft.tone === DEFAULT_RISK_BREACH_SOUND_PREFS.tone &&
    soundDraft.volume === DEFAULT_RISK_BREACH_SOUND_PREFS.volume &&
    soundDraft.cooldownSec === DEFAULT_RISK_BREACH_SOUND_PREFS.cooldownSec

  const handleApplyPreset = (presetBreachUsd: number) => {
    setBreachDraft(String(presetBreachUsd))
    setWarningDraft(String(Math.round(presetBreachUsd * RISK_EXPOSURE_WARN_RATIO)))
    setSubmittedError(null)
  }

  const handleSnapWarningRatio = (ratio: number) => {
    const baseBreach = parsedDraft.ok
      ? parsedDraft.value.breachLimitUsd
      : currentThresholds.breachLimitUsd
    const nextWarn = Math.max(
      MIN_RISK_EXPOSURE_WARNING_LIMIT_USD,
      Math.min(baseBreach - 1, Math.round(baseBreach * ratio)),
    )
    setWarningDraft(String(nextWarn))
    setSubmittedError(null)
  }

  const handleResetDefaults = () => {
    setBreachDraft(String(DEFAULT_RISK_EXPOSURE_LIMIT_USD))
    setWarningDraft(String(DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD))
    setSoundDraft(DEFAULT_RISK_BREACH_SOUND_PREFS)
    setSoundTestStatus(null)
    setSubmittedError(null)
  }

  const handleTestSound = () => {
    const result = playRiskBreachTone(soundDraft)
    setSoundTestStatus(result.played ? "Played preview" : "Audio blocked or unavailable")
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const validated = parseRiskThresholdPairInput(warningDraft, breachDraft)
    if (!validated.ok) {
      setSubmittedError({ field: validated.field, error: validated.error })
      return
    }
    setSubmittedError(null)
    onSave(validated.value)
    onSaveSoundPrefs?.(soundDraft)
    onClose()
  }

  const previewStatusLabel =
    previewEval.status === "breach"
      ? "Breach Alert"
      : previewEval.status === "warn"
        ? "Warning Active"
        : previewEval.status === "ok"
          ? "Within Limit"
          : "Armed (Idle)"

  return (
    <div
      className="sd-threshold-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
      data-risk-threshold-modal-backdrop="true"
    >
      <div
        className="sd-threshold-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sd-risk-threshold-modal-title"
        aria-describedby="sd-risk-threshold-modal-desc"
        data-risk-threshold-modal="true"
      >
        {/* Header */}
        <div className="sd-threshold-modal-header">
          <div className="sd-threshold-modal-title-group">
            <div className="sd-threshold-modal-title-row">
              <Sliders size={16} className="sd-threshold-modal-title-icon" aria-hidden="true" />
              <h3 id="sd-risk-threshold-modal-title" className="sd-threshold-modal-title">
                60-Minute Aggregate Risk Alert Thresholds
              </h3>
            </div>
            <p id="sd-risk-threshold-modal-desc" className="sd-threshold-modal-subtitle">
              Set custom warning and breach limits in USD for the rolling 60-minute exposure alert.
              Saved locally in browser storage and synced across the header indicator and chart.
            </p>
          </div>
          <button
            type="button"
            className="sd-threshold-modal-close"
            onClick={onClose}
            aria-label="Close threshold configuration modal"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {/* Live Impact Preview Strip */}
        <div
          className={`sd-threshold-modal-preview sd-threshold-modal-preview--${previewEval.status}`}
          data-risk-threshold-preview-status={previewEval.status}
        >
          <div className="sd-threshold-modal-preview-cell">
            <span className="sd-threshold-modal-preview-label">Current 60m Exposure</span>
            <span className="sd-threshold-modal-preview-val">
              {hasLiveData ? formatUsdFull(currentExposureUsd) : "—"}
            </span>
          </div>
          <div className="sd-threshold-modal-preview-cell">
            <span className="sd-threshold-modal-preview-label">Projected Alert State</span>
            <span className="sd-threshold-modal-preview-status">
              {previewEval.isBreached || previewEval.isWarning ? (
                <AlertTriangle size={13} aria-hidden="true" />
              ) : (
                <ShieldCheck size={13} aria-hidden="true" />
              )}
              <span>{previewStatusLabel}</span>
            </span>
          </div>
          <div className="sd-threshold-modal-preview-cell">
            <span className="sd-threshold-modal-preview-label">
              {previewEval.isBreached ? "Projected Excess" : "Projected Headroom"}
            </span>
            <span className="sd-threshold-modal-preview-val">
              {!hasLiveData
                ? `${formatRiskCompactUsd(previewEval.limitUsd)} cap`
                : previewEval.isBreached
                  ? `+${formatUsdFull(previewEval.excessUsd)} (${previewEval.utilizationPct.toFixed(0)}%)`
                  : `${formatUsdFull(previewEval.remainingUsd)} (${previewEval.utilizationPct.toFixed(0)}%)`}
            </span>
          </div>
        </div>

        {/* Form Body */}
        <form
          onSubmit={handleSubmit}
          className="sd-threshold-modal-form"
          noValidate
          toolname="desk_configure_risk_thresholds_form"
          tooldescription="Configure custom 60-minute aggregate risk Warning and Breach USD thresholds in the Risk Overview panel."
        >
          <div className="sd-threshold-modal-grid">
            {/* Breach Limit Input */}
            <div className="sd-threshold-modal-field">
              <div className="sd-threshold-modal-label-row">
                <label htmlFor="sd-modal-breach-limit" className="sd-threshold-modal-label">
                  Breach Alert Limit (USD)
                </label>
                <span className="sd-threshold-modal-hint">Triggers header alert</span>
              </div>
              <div
                className={`sd-threshold-modal-input-wrap${breachFieldError ? " sd-threshold-modal-input-wrap--error" : ""}`}
              >
                <span className="sd-threshold-modal-prefix" aria-hidden="true">
                  $
                </span>
                <input
                  ref={breachInputRef}
                  id="sd-modal-breach-limit"
                  name="breachLimitUsd"
                  type="text"
                  inputMode="decimal"
                  value={breachDraft}
                  onChange={(e) => {
                    setBreachDraft(e.target.value)
                    setSubmittedError(null)
                  }}
                  placeholder="25000 or 25k"
                  toolparamdescription="Custom 60-minute aggregate risk breach limit in USD (e.g. 25000 or 25k)."
                  aria-invalid={breachFieldError ? "true" : "false"}
                  aria-describedby={
                    breachFieldError ? "sd-modal-breach-error" : "sd-modal-breach-help"
                  }
                  className="sd-threshold-modal-input"
                />
              </div>
              {breachFieldError ? (
                <div id="sd-modal-breach-error" className="sd-threshold-modal-error" role="alert">
                  {breachFieldError}
                </div>
              ) : (
                <div id="sd-modal-breach-help" className="sd-threshold-modal-help">
                  Accepts exact USD or shorthand (e.g. 50k, 1.2m). Range{" "}
                  {formatRiskCompactUsd(MIN_RISK_EXPOSURE_LIMIT_USD)}–
                  {formatRiskCompactUsd(MAX_RISK_EXPOSURE_LIMIT_USD)}.
                </div>
              )}
            </div>

            {/* Warning Limit Input */}
            <div className="sd-threshold-modal-field">
              <div className="sd-threshold-modal-label-row">
                <label htmlFor="sd-modal-warning-limit" className="sd-threshold-modal-label">
                  Warning Threshold (USD)
                </label>
                <div
                  className="sd-threshold-modal-ratio-group"
                  role="group"
                  aria-label="Quick warning ratio presets"
                >
                  {WARNING_RATIO_SNAPS.map((snap) => {
                    const target = Math.round(effectiveBreachForRatio * snap.ratio)
                    const isActive = parsedDraft.ok && parsedDraft.value.warningLimitUsd === target
                    return (
                      <button
                        key={snap.label}
                        type="button"
                        onClick={() => handleSnapWarningRatio(snap.ratio)}
                        className={`sd-threshold-modal-ratio-btn${isActive ? " sd-threshold-modal-ratio-btn--active" : ""}`}
                        title={`Set warning threshold to ${snap.label} of breach limit (${formatUsdFull(target)})`}
                      >
                        {snap.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div
                className={`sd-threshold-modal-input-wrap${warningFieldError ? " sd-threshold-modal-input-wrap--error" : ""}`}
              >
                <span className="sd-threshold-modal-prefix" aria-hidden="true">
                  $
                </span>
                <input
                  id="sd-modal-warning-limit"
                  name="warningLimitUsd"
                  type="text"
                  inputMode="decimal"
                  value={warningDraft}
                  onChange={(e) => {
                    setWarningDraft(e.target.value)
                    setSubmittedError(null)
                  }}
                  placeholder="20000 or 20k"
                  toolparamdescription="Custom 60-minute aggregate risk warning threshold in USD (must be strictly below breachLimitUsd)."
                  aria-invalid={warningFieldError ? "true" : "false"}
                  aria-describedby={
                    warningFieldError ? "sd-modal-warning-error" : "sd-modal-warning-help"
                  }
                  className="sd-threshold-modal-input"
                />
              </div>
              {warningFieldError ? (
                <div id="sd-modal-warning-error" className="sd-threshold-modal-error" role="alert">
                  {warningFieldError}
                </div>
              ) : (
                <div id="sd-modal-warning-help" className="sd-threshold-modal-help">
                  {effectiveWarningRatioPct !== null
                    ? `${effectiveWarningRatioPct}% of breach limit · triggers approaching-limit warning.`
                    : "Must be strictly lower than the breach limit."}
                </div>
              )}
            </div>
          </div>

          {/* Quick Desk Limit Presets */}
          <div className="sd-threshold-modal-presets">
            <span className="sd-threshold-modal-presets-label">Quick Desk Presets</span>
            <div className="sd-threshold-modal-presets-list">
              {RISK_EXPOSURE_LIMIT_PRESETS.map((preset) => {
                const active = parsedDraft.ok && parsedDraft.value.breachLimitUsd === preset
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => handleApplyPreset(preset)}
                    className={`sd-threshold-modal-preset-btn${active ? " sd-threshold-modal-preset-btn--active" : ""}`}
                  >
                    {formatRiskCompactUsd(preset)}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Breach Sound Notification Configuration */}
          <div className="sd-threshold-modal-sound" data-risk-breach-sound-config="true">
            <div className="sd-threshold-modal-sound-header">
              <div className="sd-threshold-modal-sound-title-group">
                <span className="sd-threshold-modal-label">Breach Sound Alert</span>
                <span className="sd-threshold-modal-help">
                  Plays a subtle acoustic cue when 60m aggregate risk breaches the configured limit.
                </span>
              </div>
              <div className="sd-threshold-modal-sound-header-actions">
                <button
                  type="button"
                  onClick={handleTestSound}
                  className="sd-threshold-modal-preset-btn"
                  data-test-breach-sound="true"
                  title="Preview the selected breach sound alert"
                >
                  Test Sound
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={soundDraft.enabled}
                  onClick={() => setSoundDraft((prev) => ({ ...prev, enabled: !prev.enabled }))}
                  className={`sd-threshold-modal-sound-toggle${soundDraft.enabled ? " sd-threshold-modal-sound-toggle--on" : ""}`}
                  data-toggle-breach-sound-modal="true"
                >
                  {soundDraft.enabled ? (
                    <>
                      <Volume2 size={13} aria-hidden="true" />
                      <span>Enabled</span>
                    </>
                  ) : (
                    <>
                      <VolumeX size={13} aria-hidden="true" />
                      <span>Muted</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {soundTestStatus ? (
              <div className="sd-threshold-modal-help" role="status">
                {soundTestStatus}
              </div>
            ) : null}

            <div
              className="sd-threshold-modal-sound-controls"
              data-sound-disabled={soundDraft.enabled ? undefined : "true"}
            >
              <div className="sd-threshold-modal-sound-row">
                <span className="sd-threshold-modal-presets-label">Tone Profile</span>
                <div
                  className="sd-threshold-modal-presets-list"
                  role="radiogroup"
                  aria-label="Breach notification tone profile"
                >
                  {RISK_BREACH_SOUND_TONE_OPTIONS.map((opt) => {
                    const active = soundDraft.tone === opt.id
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={!soundDraft.enabled}
                        onClick={() => {
                          const next = { ...soundDraft, tone: opt.id }
                          setSoundDraft(next)
                          playRiskBreachTone(next)
                        }}
                        className={`sd-threshold-modal-preset-btn${active ? " sd-threshold-modal-preset-btn--active" : ""}`}
                        title={opt.description}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="sd-threshold-modal-sound-row">
                <label htmlFor="sd-modal-sound-volume" className="sd-threshold-modal-presets-label">
                  Volume ({Math.round(soundDraft.volume * 100)}%)
                </label>
                <input
                  id="sd-modal-sound-volume"
                  type="range"
                  min={5}
                  max={100}
                  step={5}
                  disabled={!soundDraft.enabled}
                  value={Math.round(soundDraft.volume * 100)}
                  onChange={(e) => {
                    const pct = Number(e.target.value)
                    setSoundDraft((prev) => ({
                      ...prev,
                      volume: Math.round(pct) / 100,
                    }))
                  }}
                  className="sd-threshold-modal-volume-slider"
                />
              </div>

              <div className="sd-threshold-modal-sound-row">
                <span className="sd-threshold-modal-presets-label">Repeat Cooldown</span>
                <div
                  className="sd-threshold-modal-presets-list"
                  role="radiogroup"
                  aria-label="Minimum cooldown between repeated breach pings"
                >
                  {RISK_BREACH_SOUND_COOLDOWN_OPTIONS.map((sec) => {
                    const active = soundDraft.cooldownSec === sec
                    const label = sec >= 60 ? `${sec / 60}m` : `${sec}s`
                    return (
                      <button
                        key={sec}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={!soundDraft.enabled}
                        onClick={() => setSoundDraft((prev) => ({ ...prev, cooldownSec: sec }))}
                        className={`sd-threshold-modal-preset-btn${active ? " sd-threshold-modal-preset-btn--active" : ""}`}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <div className="sd-threshold-modal-footer">
            <button
              type="button"
              onClick={handleResetDefaults}
              disabled={isAlreadyDefault}
              className="sd-threshold-modal-reset-btn"
              title={`Reset to default limits (${formatUsdFull(DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD)} warn / ${formatUsdFull(DEFAULT_RISK_EXPOSURE_LIMIT_USD)} breach)`}
            >
              <RotateCcw size={13} aria-hidden="true" />
              <span>Reset Defaults</span>
            </button>

            <div className="sd-threshold-modal-actions">
              <button type="button" onClick={onClose} className="sd-threshold-modal-cancel-btn">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!parsedDraft.ok}
                className="sd-threshold-modal-save-btn"
                data-save-risk-thresholds="true"
              >
                {isDirty ? "Save Thresholds" : "Done"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
