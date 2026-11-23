import { computeDeskExposureModel } from "./profile_formulas.ts"
import type {
  CustomerProfileClassification,
  ProfileTag,
  ProfileTagCategory,
  ProfileTagTone,
  ProfileTypeId,
  ProfileTypeSpec,
  ShowcaseCustomer,
} from "./types.ts"

export const PROFILE_TYPE_SPECS: Readonly<Record<ProfileTypeId, ProfileTypeSpec>> = {
  UNMEASURED: {
    id: "UNMEASURED",
    label: "Unmeasured",
    shortLabel: "Unmeasured",
    icon: "○",
    description: "Account identity observed; risk classification has not been measured.",
    riskBand: "UNMEASURED",
    defaultAction: "UNMEASURED",
    defaultDelaySec: 0,
    defaultShadeCents: 0,
    limitMultiplier: 1.0,
    fg: "#cbd5e1",
    bg: "rgba(148, 163, 184, 0.14)",
    border: "rgba(148, 163, 184, 0.34)",
  },
  ORIGINATOR: {
    id: "ORIGINATOR",
    label: "Elite Originator",
    shortLabel: "Originator",
    icon: "🎯",
    description:
      "Primary market-moving sharp originating opening/key-number steam before broader consensus.",
    riskBand: "CRITICAL",
    defaultAction: "SHADOW_AND_SHADE",
    defaultDelaySec: 8,
    defaultShadeCents: 15,
    limitMultiplier: 0.35,
    fg: "#fca5a5",
    bg: "rgba(239, 68, 68, 0.16)",
    border: "rgba(248, 113, 113, 0.45)",
  },
  STEAM_SYNDICATE: {
    id: "STEAM_SYNDICATE",
    label: "Steam / Syndicate",
    shortLabel: "Syndicate",
    icon: "⚡",
    description:
      "Coordinated multi-seat syndicate or rapid steam-chasing flow exploiting stale lines.",
    riskBand: "CRITICAL",
    defaultAction: "ALERT_OPERATOR",
    defaultDelaySec: 8,
    defaultShadeCents: 12,
    limitMultiplier: 0.4,
    fg: "#fbbf24",
    bg: "rgba(245, 158, 11, 0.16)",
    border: "rgba(251, 191, 36, 0.42)",
  },
  CORRELATED_PARLAY_EXPLOITER: {
    id: "CORRELATED_PARLAY_EXPLOITER",
    label: "Correlated Parlay",
    shortLabel: "Parlay-Corr",
    icon: "🧩",
    description:
      "Exploits correlated same-game, alt-spread, or Probit-linked parlay subsets against static pricing.",
    riskBand: "CRITICAL",
    defaultAction: "PROBIT_GUARD_BLOCK",
    defaultDelaySec: 6,
    defaultShadeCents: 10,
    limitMultiplier: 0.35,
    fg: "#fb7185",
    bg: "rgba(244, 63, 94, 0.16)",
    border: "rgba(251, 113, 133, 0.44)",
  },
  SHARP_DISCIPLINED: {
    id: "SHARP_DISCIPLINED",
    label: "Sharp Disciplined",
    shortLabel: "Sharp",
    icon: "📐",
    description:
      "Consistent positive-CLV specialist with disciplined stake sizing and controlled variance.",
    riskBand: "HIGH",
    defaultAction: "THROTTLE_LIMIT",
    defaultDelaySec: 5,
    defaultShadeCents: 8,
    limitMultiplier: 0.65,
    fg: "#7dd3fc",
    bg: "rgba(56, 189, 248, 0.15)",
    border: "rgba(56, 189, 248, 0.42)",
  },
  BONUS_ARB_SCALPER: {
    id: "BONUS_ARB_SCALPER",
    label: "Arb / Latency Scalper",
    shortLabel: "Arb/Scalp",
    icon: "⏱",
    description:
      "Targets cross-book arbitrage, court-siding latency gaps, or promo/derivative pricing lags.",
    riskBand: "ELEVATED",
    defaultAction: "INPLAY_DELAY_THROTTLE",
    defaultDelaySec: 6,
    defaultShadeCents: 6,
    limitMultiplier: 0.55,
    fg: "#f472b6",
    bg: "rgba(236, 72, 153, 0.14)",
    border: "rgba(244, 114, 182, 0.4)",
  },
  SEMI_SHARP: {
    id: "SEMI_SHARP",
    label: "Semi-Sharp Hybrid",
    shortLabel: "Semi-Sharp",
    icon: "⚖️",
    description:
      "Selective edge in niche markets or live derivatives mixed with recreational action.",
    riskBand: "MODERATE",
    defaultAction: "MONITOR",
    defaultDelaySec: 3,
    defaultShadeCents: 4,
    limitMultiplier: 1.0,
    fg: "#c4b5fd",
    bg: "rgba(167, 139, 250, 0.15)",
    border: "rgba(167, 139, 250, 0.4)",
  },
  HIGH_HOLD_WHALE: {
    id: "HIGH_HOLD_WHALE",
    label: "High-Hold Whale",
    shortLabel: "Whale",
    icon: "🐋",
    description:
      "High-volume VIP or positive-hold account generating strong desk LTV with low CLV toxicity.",
    riskBand: "LOW",
    defaultAction: "ACCEPT_VIP_FULL",
    defaultDelaySec: 0,
    defaultShadeCents: 0,
    limitMultiplier: 2.5,
    fg: "#34d399",
    bg: "rgba(16, 185, 129, 0.16)",
    border: "rgba(52, 211, 153, 0.42)",
  },
  RECREATIONAL: {
    id: "RECREATIONAL",
    label: "Recreational",
    shortLabel: "Rec",
    icon: "✅",
    description:
      "Standard recreational profile suitable for full limits and promotional retention.",
    riskBand: "LOW",
    defaultAction: "ACCEPT_NORMAL",
    defaultDelaySec: 0,
    defaultShadeCents: 0,
    limitMultiplier: 2.0,
    fg: "#cbd5e1",
    bg: "rgba(148, 163, 184, 0.14)",
    border: "rgba(148, 163, 184, 0.34)",
  },
}

export const PROFILE_TYPE_ORDER: readonly ProfileTypeId[] = [
  "UNMEASURED",
  "ORIGINATOR",
  "STEAM_SYNDICATE",
  "CORRELATED_PARLAY_EXPLOITER",
  "SHARP_DISCIPLINED",
  "BONUS_ARB_SCALPER",
  "SEMI_SHARP",
  "HIGH_HOLD_WHALE",
  "RECREATIONAL",
]

export const PROFILE_TAG_CATEGORY_META: Readonly<
  Record<
    ProfileTagCategory,
    {
      readonly label: string
      readonly fg: string
      readonly bg: string
      readonly border: string
    }
  >
> = {
  RISK: {
    label: "Risk",
    fg: "#fca5a5",
    bg: "rgba(239, 68, 68, 0.14)",
    border: "rgba(248, 113, 113, 0.38)",
  },
  BEHAVIOR: {
    label: "Behavior",
    fg: "#7dd3fc",
    bg: "rgba(56, 189, 248, 0.14)",
    border: "rgba(56, 189, 248, 0.38)",
  },
  NETWORK: {
    label: "Network",
    fg: "#fbbf24",
    bg: "rgba(245, 158, 11, 0.14)",
    border: "rgba(251, 191, 36, 0.38)",
  },
  POLICY: {
    label: "Policy",
    fg: "#34d399",
    bg: "rgba(16, 185, 129, 0.14)",
    border: "rgba(52, 211, 153, 0.38)",
  },
  CUSTOM: {
    label: "Operator",
    fg: "#c4b5fd",
    bg: "rgba(167, 139, 250, 0.16)",
    border: "rgba(167, 139, 250, 0.42)",
  },
}

export const PROFILE_TAG_TONE_STYLES: Readonly<
  Record<ProfileTagTone, { readonly fg: string; readonly bg: string; readonly border: string }>
> = {
  red: {
    fg: "#fca5a5",
    bg: "rgba(239, 68, 68, 0.15)",
    border: "rgba(248, 113, 113, 0.38)",
  },
  amber: {
    fg: "#fbbf24",
    bg: "rgba(245, 158, 11, 0.15)",
    border: "rgba(251, 191, 36, 0.38)",
  },
  sky: {
    fg: "#7dd3fc",
    bg: "rgba(56, 189, 248, 0.14)",
    border: "rgba(56, 189, 248, 0.38)",
  },
  emerald: {
    fg: "#34d399",
    bg: "rgba(16, 185, 129, 0.15)",
    border: "rgba(52, 211, 153, 0.38)",
  },
  violet: {
    fg: "#c4b5fd",
    bg: "rgba(167, 139, 250, 0.16)",
    border: "rgba(167, 139, 250, 0.42)",
  },
  slate: {
    fg: "#cbd5e1",
    bg: "rgba(148, 163, 184, 0.13)",
    border: "rgba(148, 163, 184, 0.32)",
  },
}

export const SUGGESTED_OPERATOR_TAGS: readonly string[] = [
  "VIP-WATCH",
  "STEAM-WATCH",
  "LIMIT-REVIEW",
  "PROXY-AUDIT",
  "SHADOW-FOLLOW",
  "HOLD-PROTECT",
]

const CUSTOM_TAGS_STORAGE_KEY = "sportsdesk_profile_custom_tags_v1"

export function normalizeCustomTagLabel(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 28)
    .toUpperCase()
}

export function customTagIdFromLabel(label: string): string {
  return `custom:${normalizeCustomTagLabel(label).toLowerCase()}`
}

export function loadCustomProfileTagsMap(): Record<string, readonly string[]> {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(CUSTOM_TAGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }
    const out: Record<string, readonly string[]> = {}
    for (const [custId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const cleaned = Array.from(
        new Set(
          list
            .filter((item): item is string => typeof item === "string")
            .map(normalizeCustomTagLabel)
            .filter(Boolean),
        ),
      )
      if (cleaned.length > 0) {
        out[custId.toUpperCase()] = cleaned
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveCustomProfileTagsMap(map: Readonly<Record<string, readonly string[]>>): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(CUSTOM_TAGS_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // ignore storage quota failures
  }
}

export function classifyCustomerProfileType(cust: ShowcaseCustomer): ProfileTypeSpec {
  const unknown = cust.unknown ?? []
  if (cust.source === "book" && unknown.includes("sharpness") && unknown.includes("holdPct")) {
    return PROFILE_TYPE_SPECS.UNMEASURED
  }
  if (cust.tier === "TIER_1_ELITE_ORIGINATOR") {
    return PROFILE_TYPE_SPECS.ORIGINATOR
  }
  if (cust.syndicateRisk === "HIGH" || cust.syndicateProb >= 0.7) {
    return PROFILE_TYPE_SPECS.STEAM_SYNDICATE
  }
  const probitRho = cust.forensicDossier?.parlayBacktest?.probitRho ?? null
  const hasCriticalParlay =
    !unknown.includes("correlation") &&
    (cust.correlatedRisk === "CRITICAL" || (probitRho !== null && probitRho >= 0.65))
  if (hasCriticalParlay && (cust.holdPct < 0 || unknown.includes("holdPct"))) {
    return PROFILE_TYPE_SPECS.CORRELATED_PARLAY_EXPLOITER
  }
  if (cust.tier === "TIER_2_STEAM_SYNDICATE") {
    return PROFILE_TYPE_SPECS.STEAM_SYNDICATE
  }
  const timingUpper = cust.timingArchetype.toUpperCase()
  const specUpper = cust.specialization.toUpperCase()
  if (
    timingUpper.includes("ARB") ||
    timingUpper.includes("SCALP") ||
    timingUpper.includes("LATENCY") ||
    timingUpper.includes("BONUS") ||
    (cust.clvScore >= 1.8 && !unknown.includes("gini") && cust.gini <= 0.14 && specUpper.includes("LIVE"))
  ) {
    return PROFILE_TYPE_SPECS.BONUS_ARB_SCALPER
  }
  if (cust.tier === "TIER_3_SHARP_DISCIPLINED") {
    return PROFILE_TYPE_SPECS.SHARP_DISCIPLINED
  }
  if (cust.tier === "TIER_4_SEMI_SHARP") {
    return PROFILE_TYPE_SPECS.SEMI_SHARP
  }
  const hasHold = !unknown.includes("holdPct")
  const hasMeanStake = !unknown.includes("meanStake")
  const hasLtv = !unknown.includes("ltv")
  if (
    (hasHold && cust.holdPct >= 5.0) ||
    (hasMeanStake && cust.meanStake >= 1200) ||
    (hasLtv && cust.ltvUsd >= 12000)
  ) {
    return PROFILE_TYPE_SPECS.HIGH_HOLD_WHALE
  }
  return PROFILE_TYPE_SPECS.RECREATIONAL
}

function extractDomainSportTag(specialization: string): string | null {
  const upper = specialization.toUpperCase()
  const patterns: readonly [RegExp, string][] = [
    [/\bNFL\b/, "NFL"],
    [/\bNBA\b/, "NBA"],
    [/\bMLB\b/, "MLB"],
    [/\bNHL\b/, "NHL"],
    [/\bNCAA|CFB|CBB\b/, "NCAA"],
    [/\bUFC|MMA\b/, "MMA"],
    [/\bTENNIS|ATP|WTA\b/, "TENNIS"],
    [/\bSOCCER|EPL|UCL\b/, "SOCCER"],
    [/\bPROP/, "PROPS"],
    [/\bLIVE|IN-PLAY\b/, "LIVE"],
  ]
  for (const [regex, tag] of patterns) {
    if (regex.test(upper)) return tag
  }
  return null
}

export function deriveCustomerProfileTags(
  cust: ShowcaseCustomer,
  customLabels: readonly string[] = [],
): readonly ProfileTag[] {
  const tags: ProfileTag[] = []
  const seen = new Set<string>()
  const unknown = cust.unknown ?? []

  const pushTag = (tag: ProfileTag) => {
    if (seen.has(tag.id)) return
    seen.add(tag.id)
    tags.push(tag)
  }

  // RISK tags
  if (cust.score >= 8.5 || cust.clvScore >= 2.2) {
    pushTag({
      id: "risk:clv-leader",
      label: "CLV-LEADER",
      category: "RISK",
      tone: "red",
      description: `Elevated unified sharpness (${cust.score.toFixed(1)}) or CLV beat margin (${cust.clvScore.toFixed(2)}).`,
    })
  }
  if (cust.syndicateRisk === "HIGH" || cust.syndicateProb >= 0.7) {
    pushTag({
      id: "risk:syndicate-cluster",
      label: "SYNDICATE-LINK",
      category: "RISK",
      tone: "amber",
      description: `High downline syndicate probability (${Math.round(cust.syndicateProb * 100)}%).`,
    })
  }
  if (
    !unknown.includes("correlation") &&
    (cust.correlatedRisk === "CRITICAL" || cust.correlatedRisk === "HIGH")
  ) {
    pushTag({
      id: "risk:correlated-parlay",
      label: `PARLAY-${cust.correlatedRisk}`,
      category: "RISK",
      tone: cust.correlatedRisk === "CRITICAL" ? "red" : "amber",
      description: `Correlated parlay exploit rate ${Math.round(cust.correlatedExploitRate * 100)}%.`,
    })
  }
  if (!unknown.includes("holdPct") && cust.holdPct < 0) {
    pushTag({
      id: "risk:negative-hold",
      label: "NEG-HOLD",
      category: "RISK",
      tone: "red",
      description: `Lifetime hold is negative (${cust.holdPct}%) against the desk.`,
    })
  } else if (!unknown.includes("holdPct") && cust.holdPct >= 5) {
    pushTag({
      id: "risk:high-hold",
      label: "HIGH-HOLD",
      category: "RISK",
      tone: "emerald",
      description: `Positive desk hold (${cust.holdPct}%) contributing favorable LTV.`,
    })
  }
  if (
    !unknown.includes("var95") &&
    !unknown.includes("limit") &&
    cust.recommendedLimitUsd > 0 &&
    cust.var95Usd > cust.recommendedLimitUsd
  ) {
    pushTag({
      id: "risk:var-breach",
      label: "VAR-EXCEEDS-CAP",
      category: "RISK",
      tone: "red",
      description: `7d 95% VaR ($${cust.var95Usd.toLocaleString()}) exceeds recommended cap ($${cust.recommendedLimitUsd.toLocaleString()}).`,
    })
  }

  // BEHAVIOR tags
  const timingUpper = cust.timingArchetype.toUpperCase()
  if (timingUpper.includes("STEAM")) {
    pushTag({
      id: "behavior:steam-chaser",
      label: "STEAM-CHASER",
      category: "BEHAVIOR",
      tone: "amber",
      description: `Timing fingerprint classified as ${cust.timingArchetype}.`,
    })
  } else if (timingUpper.includes("ORIGIN") || timingUpper.includes("OPEN")) {
    pushTag({
      id: "behavior:early-originator",
      label: "EARLY-OPENER",
      category: "BEHAVIOR",
      tone: "sky",
      description: `Timing fingerprint classified as ${cust.timingArchetype}.`,
    })
  }
  if (!unknown.includes("sizing") && cust.sizingStrategy.toUpperCase().includes("KELLY")) {
    pushTag({
      id: "behavior:kelly-sizing",
      label: "KELLY-SIZER",
      category: "BEHAVIOR",
      tone: "sky",
      description: `Sizing discipline follows ${cust.sizingStrategy}.`,
    })
  }
  if (!unknown.includes("gini") && cust.gini >= 0.45) {
    pushTag({
      id: "behavior:high-gini",
      label: "HIGH-GINI",
      category: "BEHAVIOR",
      tone: "sky",
      description: `Concentrated stake inequality (Gini ${cust.gini.toFixed(3)}).`,
    })
  }
  const sportTag = extractDomainSportTag(cust.specialization)
  if (sportTag) {
    pushTag({
      id: `behavior:sport-${sportTag.toLowerCase()}`,
      label: sportTag,
      category: "BEHAVIOR",
      tone: "slate",
      description: `Primary market specialization: ${cust.specialization}.`,
    })
  }

  // NETWORK tags
  if (cust.subAccountIndex !== null) {
    pushTag({
      id: "network:subaccount-seat",
      label: `SEAT-#${cust.subAccountIndex}`,
      category: "NETWORK",
      tone: "amber",
      description: `Linked downline sub-account seat #${cust.subAccountIndex}.`,
    })
  }
  if (cust.source) {
    pushTag({
      id: `network:source-${cust.source}`,
      label: `SRC:${cust.source.toUpperCase()}`,
      category: "NETWORK",
      tone: "slate",
      description: `Cohort profile hydrated from ${cust.source} pipeline.`,
    })
  }
  if (
    cust.ipAddress &&
    (cust.ipAddress.startsWith("102.128.") ||
      cust.ipAddress.startsWith("45.") ||
      cust.ipAddress.startsWith("185."))
  ) {
    pushTag({
      id: "network:proxy-watch",
      label: "PROXY-WATCH",
      category: "NETWORK",
      tone: "amber",
      description: `Observed IP ${cust.ipAddress} matches datacenter/VPN prefix watch.`,
    })
  }

  // POLICY tags
  if (cust.action.toUpperCase().includes("ALERT")) {
    pushTag({
      id: "policy:alert-directive",
      label: "ALERT-ACTION",
      category: "POLICY",
      tone: "red",
      description: `Desk directive requires immediate attention: ${cust.action}.`,
    })
  }
  if (!unknown.includes("delay") && cust.inPlayDelaySec > 0) {
    pushTag({
      id: "policy:inplay-delay",
      label: `DELAY-${cust.inPlayDelaySec}S`,
      category: "POLICY",
      tone: "emerald",
      description: `In-play bet submission delay of ${cust.inPlayDelaySec}s recommended.`,
    })
  }
  if (cust.lineShadeCents > 0) {
    pushTag({
      id: "policy:line-shade",
      label: `SHADE-${cust.lineShadeCents}C`,
      category: "POLICY",
      tone: "emerald",
      description: `Line shading of ${cust.lineShadeCents}¢ against incoming action.`,
    })
  }
  if (cust.shadowCopyMultiplier > 0) {
    pushTag({
      id: "policy:shadow-copy",
      label: `SHADOW-${cust.shadowCopyMultiplier.toFixed(1)}X`,
      category: "POLICY",
      tone: "sky",
      description: `Shadow copy multiplier ${cust.shadowCopyMultiplier.toFixed(2)}x active.`,
    })
  }
  const exposure = computeDeskExposureModel(cust)
  if (exposure.tailSeverity === "EXTREME" && exposure.cvarToVarRatio !== null) {
    pushTag({
      id: "risk:tail-heavy",
      label: "TAIL-HEAVY",
      category: "RISK",
      tone: "amber",
      description: `CVaR95/VaR95 tail ratio ${exposure.cvarToVarRatio.toFixed(2)}x indicates heavy upper-tail stake risk.`,
    })
  }
  if (exposure.policyGapCount >= 2 && cust.score >= 7.0) {
    pushTag({
      id: "policy:countermeasure-gap",
      label: `POLICY-GAP(${exposure.policyGapCount})`,
      category: "POLICY",
      tone: "amber",
      description: `${exposure.policyGapCount} desk countermeasures (cap/delay/shade) are looser than formula targets.`,
    })
  }
  if (cust.portalReconciliation?.postureFlags) {
    for (const flag of cust.portalReconciliation.postureFlags) {
      const normalized = normalizeCustomTagLabel(flag)
      if (!normalized) continue
      pushTag({
        id: `policy:flag-${normalized.toLowerCase()}`,
        label: normalized,
        category: "POLICY",
        tone:
          normalized === "LINE_MOVER_WEIGHT_ACTIVE"
            ? "red"
            : normalized === "BETTING_ALERTS_DISABLED"
              ? "amber"
              : "sky",
        description: `Portal reconciliation posture flag: ${flag}.`,
      })
    }
  }

  // FORENSIC DOSSIER tags (Backtest Guards, Cross-Office Beard Bridge, Polymarket, Telemetry Gaps)
  const dossier = cust.forensicDossier
  if (dossier) {
    const guard = dossier.parlayBacktest?.primaryGuardTriggered ?? ""
    const hasProbitBlock =
      guard.toUpperCase().includes("PROBIT") ||
      dossier.flaggedTickets.some((t) => t.deskVerdict.toUpperCase().includes("PROBIT"))
    if (hasProbitBlock) {
      const rho = dossier.parlayBacktest?.probitRho
      pushTag({
        id: "risk:probit-guard-block",
        label: "PROBIT-BLOCK",
        category: "RISK",
        tone: "red",
        description: `Blocked by Probit alt-subset guard${rho !== null && rho !== undefined ? ` (ρ=${rho.toFixed(3)})` : ""}.`,
      })
    }
    if (dossier.beardBridge?.matchClassification === "CROSS_OFFICE_BEARD_BRIDGE") {
      const twinSummary = dossier.beardBridge.crossOfficeTwins
        .map((t) => `${t.officeAgentId}/${t.loginId}`)
        .join(", ")
      pushTag({
        id: "network:cross-office-beard-bridge",
        label: "BEARD-BRIDGE",
        category: "NETWORK",
        tone: "amber",
        description: `Cross-office beard bridge${twinSummary ? ` linked to ${twinSummary}` : ""} on ${dossier.beardBridge.sharedIpOrSubnet}.`,
      })
    }
    const wallet =
      dossier.parlayBacktest?.shortWallet ??
      dossier.telemetryOverview?.polymarketWallet ??
      dossier.parlayBacktest?.proxyWallet
    if (wallet) {
      pushTag({
        id: "network:polymarket-linked",
        label: "POLYMARKET-LINK",
        category: "NETWORK",
        tone: "sky",
        description: `Linked Polymarket proxy wallet ${wallet}.`,
      })
    }
    const warnings = dossier.telemetryOverview?.missingDataWarnings ?? []
    if (warnings.length > 0) {
      pushTag({
        id: "policy:telemetry-gap",
        label: "TELEMETRY-GAP",
        category: "POLICY",
        tone: "amber",
        description: `Mode 1 telemetry warnings: ${warnings.join(", ")}.`,
      })
    }
  }

  // CUSTOM operator tags
  for (const rawLabel of customLabels) {
    const label = normalizeCustomTagLabel(rawLabel)
    if (!label) continue
    pushTag({
      id: customTagIdFromLabel(label),
      label,
      category: "CUSTOM",
      tone: "violet",
      description: "Operator-assigned custom surveillance tag (saved locally).",
      isCustom: true,
    })
  }

  return tags
}

export function classifyCustomerProfile(
  cust: ShowcaseCustomer,
  customTagsMap?: Readonly<Record<string, readonly string[]>>,
): CustomerProfileClassification {
  const type = classifyCustomerProfileType(cust)
  const customLabels = customTagsMap?.[cust.id.toUpperCase()] ?? []
  const tags = deriveCustomerProfileTags(cust, customLabels)
  return {
    type,
    tags,
    tagIds: new Set(tags.map((t) => t.id)),
  }
}

export function matchesProfileTypeFilter(
  cust: ShowcaseCustomer,
  filterTier: string,
  profileTypeId: ProfileTypeId,
): boolean {
  if (filterTier === "ALL") return true
  if (filterTier === profileTypeId) return true
  // Preserve compatibility with KPI cards & matrix tier filters
  if (filterTier === "ELITE") {
    return (
      profileTypeId === "ORIGINATOR" ||
      profileTypeId === "STEAM_SYNDICATE" ||
      cust.tier === "TIER_1_ELITE_ORIGINATOR" ||
      cust.tier === "TIER_2_STEAM_SYNDICATE"
    )
  }
  if (filterTier === "SYNDICATE") {
    return cust.syndicateRisk === "HIGH" || profileTypeId === "STEAM_SYNDICATE"
  }
  if (filterTier === "PARLAY") {
    return (
      profileTypeId === "CORRELATED_PARLAY_EXPLOITER" ||
      cust.correlatedRisk === "CRITICAL" ||
      cust.correlatedRisk === "HIGH"
    )
  }
  if (filterTier === "ARB") {
    return profileTypeId === "BONUS_ARB_SCALPER"
  }
  if (filterTier === "STEAM") {
    return cust.timingArchetype.toUpperCase().includes("STEAM")
  }
  if (filterTier === "RECREATIONAL") {
    return (
      profileTypeId === "RECREATIONAL" ||
      profileTypeId === "HIGH_HOLD_WHALE" ||
      cust.tier === "TIER_5_RECREATIONAL" ||
      cust.tier.includes("TIER_5")
    )
  }
  if (filterTier.startsWith("TIER_")) {
    return cust.tier.includes(filterTier) || cust.tierLabel?.includes(filterTier) === true
  }
  return true
}

export function customerMatchesSearch(
  cust: ShowcaseCustomer,
  rawQuery: string,
  classification: CustomerProfileClassification,
): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true
  if (
    cust.id.toLowerCase().includes(q) ||
    cust.name.toLowerCase().includes(q) ||
    cust.specialization.toLowerCase().includes(q) ||
    cust.agentId.toLowerCase().includes(q) ||
    cust.masterAgent.toLowerCase().includes(q) ||
    cust.timingArchetype.toLowerCase().includes(q) ||
    cust.ipAddress.toLowerCase().includes(q) ||
    classification.type.label.toLowerCase().includes(q) ||
    classification.type.id.toLowerCase().includes(q)
  ) {
    return true
  }
  const dossier = cust.forensicDossier
  if (dossier) {
    const forensicHaystack = [
      dossier.parlayBacktest?.dominantComboFamily,
      dossier.parlayBacktest?.primaryGuardTriggered,
      dossier.parlayBacktest?.proxyWallet,
      dossier.parlayBacktest?.shortWallet,
      dossier.parlayBacktest?.ipSubnet,
      dossier.beardBridge?.groupId,
      dossier.beardBridge?.normalizedIp,
      dossier.beardBridge?.sharedIpOrSubnet,
      ...(dossier.beardBridge?.crossOfficeTwins.flatMap((t) => [t.loginId, t.officeAgentId]) ?? []),
      ...(dossier.flaggedTickets.flatMap((t) => [t.ticketId, t.canonicalMarket, t.deskVerdict]) ??
        []),
      ...(dossier.telemetryOverview?.missingDataWarnings ?? []),
    ]
      .filter((v): v is string => Boolean(v))
      .join(" ")
      .toLowerCase()
    if (forensicHaystack.includes(q)) return true
  }
  return classification.tags.some(
    (tag) => tag.label.toLowerCase().includes(q) || tag.category.toLowerCase().includes(q),
  )
}
