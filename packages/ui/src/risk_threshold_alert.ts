export const RISK_EXPOSURE_LIMIT_STORAGE_KEY = "sd_risk_60m_exposure_limit_usd"
export const RISK_EXPOSURE_WARNING_LIMIT_STORAGE_KEY = "sd_risk_60m_warning_limit_usd"

export const DEFAULT_RISK_EXPOSURE_LIMIT_USD = 25_000
export const MIN_RISK_EXPOSURE_LIMIT_USD = 500
export const MAX_RISK_EXPOSURE_LIMIT_USD = 50_000_000
export const MIN_RISK_EXPOSURE_WARNING_LIMIT_USD = 250
export const RISK_EXPOSURE_WARN_RATIO = 0.8
export const DEFAULT_RISK_EXPOSURE_WARNING_LIMIT_USD = Math.round(
  DEFAULT_RISK_EXPOSURE_LIMIT_USD * RISK_EXPOSURE_WARN_RATIO,
)

export const RISK_EXPOSURE_LIMIT_PRESETS = [10_000, 25_000, 50_000, 100_000, 250_000] as const

export type RiskThresholdStatus = "idle" | "ok" | "warn" | "breach"

export interface RiskExposureThresholds {
  /** Custom USD warning threshold (must be strictly below breachLimitUsd). */
  readonly warningLimitUsd: number
  /** Custom USD breach threshold for the rolling 60-minute aggregate risk alert. */
  readonly breachLimitUsd: number
}

export interface RiskThresholdEvaluation {
  readonly status: RiskThresholdStatus
  readonly totalRiskUsd: number
  readonly limitUsd: number
  /** Effective USD warning threshold used to classify "warn" status. */
  readonly warningLimitUsd: number
  /** Percentage of the configured limit currently utilized (0..∞). */
  readonly utilizationPct: number
  /** Dollar amount above the limit (> 0 only when breached). */
  readonly excessUsd: number
  /** Dollar headroom remaining before breaching (>= 0). */
  readonly remainingUsd: number
  readonly isBreached: boolean
  readonly isWarning: boolean
}

export function clampRiskExposureLimitUsd(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_RISK_EXPOSURE_LIMIT_USD
  }
  const rounded = Math.round(value)
  if (rounded < MIN_RISK_EXPOSURE_LIMIT_USD) return MIN_RISK_EXPOSURE_LIMIT_USD
  if (rounded > MAX_RISK_EXPOSURE_LIMIT_USD) return MAX_RISK_EXPOSURE_LIMIT_USD
  return rounded
}

export function clampRiskExposureWarningLimitUsd(
  warningUsd: number,
  breachLimitUsd: number,
): number {
  const safeBreach = clampRiskExposureLimitUsd(breachLimitUsd)
  const maxWarning = Math.max(MIN_RISK_EXPOSURE_WARNING_LIMIT_USD, safeBreach - 1)
  if (!Number.isFinite(warningUsd) || warningUsd <= 0) {
    return Math.min(
      maxWarning,
      Math.max(
        MIN_RISK_EXPOSURE_WARNING_LIMIT_USD,
        Math.round(safeBreach * RISK_EXPOSURE_WARN_RATIO),
      ),
    )
  }
  const rounded = Math.round(warningUsd)
  if (rounded < MIN_RISK_EXPOSURE_WARNING_LIMIT_USD) return MIN_RISK_EXPOSURE_WARNING_LIMIT_USD
  if (rounded > maxWarning) return maxWarning
  return rounded
}

function parseRawPositiveUsd(raw: string): number | null {
  const cleaned = raw
    .trim()
    .replace(/[$,\s_]/g, "")
    .toLowerCase()
  if (!cleaned) return null

  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(cleaned)
  if (!match) return null

  const numeric = Number(match[1])
  if (!Number.isFinite(numeric) || numeric <= 0) return null

  const suffix = match[2]
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1
  return Math.round(numeric * multiplier)
}

/**
 * Parse operator input such as "25000", "$25,000", "25k", "1.5m" into a valid USD limit. Returns
 * null when the input cannot be parsed into a positive finite dollar amount.
 */
export function parseRiskExposureLimitInput(raw: string): number | null {
  const parsed = parseRawPositiveUsd(raw)
  if (parsed === null) return null
  return clampRiskExposureLimitUsd(parsed)
}

export type ParseRiskThresholdPairResult =
  | { readonly ok: true; readonly value: RiskExposureThresholds }
  | { readonly ok: false; readonly field: "warning" | "breach"; readonly error: string }

/**
 * Strictly validate an operator-entered Warning USD and Breach USD threshold pair for the modal
 * configurator so invalid ranges produce explicit inline feedback.
 */
export function parseRiskThresholdPairInput(
  warningRaw: string,
  breachRaw: string,
): ParseRiskThresholdPairResult {
  const breachParsed = parseRawPositiveUsd(breachRaw)
  if (breachParsed === null) {
    return {
      ok: false,
      field: "breach",
      error: "Enter a positive USD amount (e.g. 25000, $50,000, or 75k).",
    }
  }
  if (breachParsed < MIN_RISK_EXPOSURE_LIMIT_USD) {
    return {
      ok: false,
      field: "breach",
      error: `Breach limit must be at least $${MIN_RISK_EXPOSURE_LIMIT_USD.toLocaleString()}.`,
    }
  }
  if (breachParsed > MAX_RISK_EXPOSURE_LIMIT_USD) {
    return {
      ok: false,
      field: "breach",
      error: `Breach limit cannot exceed $${MAX_RISK_EXPOSURE_LIMIT_USD.toLocaleString()}.`,
    }
  }

  const warningParsed = parseRawPositiveUsd(warningRaw)
  if (warningParsed === null) {
    return {
      ok: false,
      field: "warning",
      error: "Enter a positive USD warning threshold (e.g. 20000 or 20k).",
    }
  }
  if (warningParsed < MIN_RISK_EXPOSURE_WARNING_LIMIT_USD) {
    return {
      ok: false,
      field: "warning",
      error: `Warning limit must be at least $${MIN_RISK_EXPOSURE_WARNING_LIMIT_USD.toLocaleString()}.`,
    }
  }
  if (warningParsed >= breachParsed) {
    return {
      ok: false,
      field: "warning",
      error: "Warning limit must be strictly lower than the breach limit.",
    }
  }

  return {
    ok: true,
    value: {
      warningLimitUsd: warningParsed,
      breachLimitUsd: breachParsed,
    },
  }
}

export function readStoredRiskExposureLimitUsd(storage?: Pick<Storage, "getItem"> | null): number {
  try {
    const store =
      storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null
    if (!store) return DEFAULT_RISK_EXPOSURE_LIMIT_USD
    const raw = store.getItem(RISK_EXPOSURE_LIMIT_STORAGE_KEY)
    if (!raw) return DEFAULT_RISK_EXPOSURE_LIMIT_USD
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RISK_EXPOSURE_LIMIT_USD
    return clampRiskExposureLimitUsd(parsed)
  } catch {
    return DEFAULT_RISK_EXPOSURE_LIMIT_USD
  }
}

export function writeStoredRiskExposureLimitUsd(
  limitUsd: number,
  storage?: Pick<Storage, "setItem"> | null,
): number {
  const safe = clampRiskExposureLimitUsd(limitUsd)
  try {
    const store =
      storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null
    if (store) {
      store.setItem(RISK_EXPOSURE_LIMIT_STORAGE_KEY, String(safe))
    }
  } catch {
    // Ignore private-mode / quota errors; in-memory state still reflects the change.
  }
  return safe
}

export function readStoredRiskExposureThresholds(
  storage?: Pick<Storage, "getItem"> | null,
): RiskExposureThresholds {
  const breachLimitUsd = readStoredRiskExposureLimitUsd(storage)
  try {
    const store =
      storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null
    if (!store) {
      return {
        breachLimitUsd,
        warningLimitUsd: clampRiskExposureWarningLimitUsd(
          Math.round(breachLimitUsd * RISK_EXPOSURE_WARN_RATIO),
          breachLimitUsd,
        ),
      }
    }
    const rawWarn = store.getItem(RISK_EXPOSURE_WARNING_LIMIT_STORAGE_KEY)
    if (!rawWarn) {
      return {
        breachLimitUsd,
        warningLimitUsd: clampRiskExposureWarningLimitUsd(
          Math.round(breachLimitUsd * RISK_EXPOSURE_WARN_RATIO),
          breachLimitUsd,
        ),
      }
    }
    const parsedWarn = Number(rawWarn)
    return {
      breachLimitUsd,
      warningLimitUsd: clampRiskExposureWarningLimitUsd(parsedWarn, breachLimitUsd),
    }
  } catch {
    return {
      breachLimitUsd,
      warningLimitUsd: clampRiskExposureWarningLimitUsd(
        Math.round(breachLimitUsd * RISK_EXPOSURE_WARN_RATIO),
        breachLimitUsd,
      ),
    }
  }
}

export function writeStoredRiskExposureThresholds(
  thresholds: RiskExposureThresholds,
  storage?: Pick<Storage, "setItem"> | null,
): RiskExposureThresholds {
  const breachLimitUsd = writeStoredRiskExposureLimitUsd(thresholds.breachLimitUsd, storage)
  const warningLimitUsd = clampRiskExposureWarningLimitUsd(
    thresholds.warningLimitUsd,
    breachLimitUsd,
  )
  try {
    const store =
      storage !== undefined ? storage : typeof localStorage !== "undefined" ? localStorage : null
    if (store) {
      store.setItem(RISK_EXPOSURE_WARNING_LIMIT_STORAGE_KEY, String(warningLimitUsd))
    }
  } catch {
    // Ignore private-mode / quota errors; in-memory state still reflects the change.
  }
  return {
    breachLimitUsd,
    warningLimitUsd,
  }
}

export function evaluateRiskExposureThreshold(
  totalRiskUsd: number,
  limitUsd: number,
  options?: {
    readonly warnRatio?: number
    readonly warningLimitUsd?: number
    readonly hasData?: boolean
  },
): RiskThresholdEvaluation {
  const safeLimit = clampRiskExposureLimitUsd(limitUsd)
  const safeTotal = Number.isFinite(totalRiskUsd) && totalRiskUsd > 0 ? totalRiskUsd : 0
  const warnRatio =
    options?.warnRatio !== undefined && options.warnRatio > 0 && options.warnRatio < 1
      ? options.warnRatio
      : RISK_EXPOSURE_WARN_RATIO
  const effectiveWarningLimitUsd =
    options?.warningLimitUsd !== undefined && Number.isFinite(options.warningLimitUsd)
      ? clampRiskExposureWarningLimitUsd(options.warningLimitUsd, safeLimit)
      : clampRiskExposureWarningLimitUsd(Math.round(safeLimit * warnRatio), safeLimit)
  const hasData = options?.hasData ?? true

  const utilizationPct = safeLimit > 0 ? (safeTotal / safeLimit) * 100 : 0
  const excessUsd = Math.max(0, safeTotal - safeLimit)
  const remainingUsd = Math.max(0, safeLimit - safeTotal)

  if (!hasData) {
    return {
      status: "idle",
      totalRiskUsd: safeTotal,
      limitUsd: safeLimit,
      warningLimitUsd: effectiveWarningLimitUsd,
      utilizationPct: 0,
      excessUsd: 0,
      remainingUsd: safeLimit,
      isBreached: false,
      isWarning: false,
    }
  }

  const isBreached = safeTotal > safeLimit
  const isWarning = !isBreached && safeTotal >= effectiveWarningLimitUsd

  return {
    status: isBreached ? "breach" : isWarning ? "warn" : "ok",
    totalRiskUsd: safeTotal,
    limitUsd: safeLimit,
    warningLimitUsd: effectiveWarningLimitUsd,
    utilizationPct,
    excessUsd,
    remainingUsd,
    isBreached,
    isWarning,
  }
}
