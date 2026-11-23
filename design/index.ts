/**
 * @file design/index.ts
 * @description Unified Design System Facade using Bun's built-in `.toml` imports,
 * `Bun.color` cross-artifact normalization, and zero-drift parity validation.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { bunFileURLToPath } from "../lib/bun_url_gzip.ts"
import brandingToml from "./branding.toml"
import { colorsEqual, normalizeColorHex } from "./color.ts"
import {
    BET_LEG_BIT_POSITIONS,
    INGESTION_CHANNELS,
    OPERATOR_KEYMAP,
    ROUTE_CIRCUITS,
    SLA_STATES,
    SOURCE_BRIDGE_IDS,
    TELEMETRY_SURFACES,
    TOKEN_GATES,
    UI_STATE_BIT_POSITIONS,
    UI_TOKENS,
} from "./domain-branded-types.ts"
import tokensToml from "./tokens.toml"

export * from "./color.ts"
export * from "./domain-branded-types.ts"

export const DESIGN_SYSTEM_VERSION = "1.5.0" as const

export interface DesignParityIssue {
    readonly scope: string
    readonly message: string
}

export interface DesignSystemParityReport {
    readonly ok: boolean
    readonly version: string
    readonly checksRun: number
    readonly issues: readonly DesignParityIssue[]
}

const DEFAULT_ROOT = resolve(dirname(bunFileURLToPath(import.meta.url)), "..")

function asRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`Expected TOML table for '${label}'`)
    }
    return value as Record<string, unknown>
}

function parseTomlNative(source: string): Record<string, unknown> {
    return Bun.TOML.parse(source) as Record<string, unknown>
}

export function loadDesignTokensToml(rootDir?: string): Record<string, unknown> {
    if (!rootDir || resolve(rootDir) === DEFAULT_ROOT) {
        return tokensToml as Record<string, unknown>
    }
    const filePath = resolve(rootDir, "design/tokens.toml")
    return parseTomlNative(readFileSync(filePath, "utf8"))
}

export function loadDesignBrandingToml(rootDir?: string): Record<string, unknown> {
    if (!rootDir || resolve(rootDir) === DEFAULT_ROOT) {
        return brandingToml as Record<string, unknown>
    }
    const filePath = resolve(rootDir, "design/branding.toml")
    return parseTomlNative(readFileSync(filePath, "utf8"))
}

export function validateDesignSystemParity(rootDir?: string): DesignSystemParityReport {
    const issues: DesignParityIssue[] = []
    let checksRun = 0

    const checkEq = (scope: string, label: string, actual: unknown, expected: unknown): void => {
        checksRun += 1
        if (actual !== expected) {
            issues.push({
                scope,
                message: `${label} mismatch: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
            })
        }
    }

    const checkColor = (scope: string, label: string, actual: unknown, expected: unknown): void => {
        checksRun += 1
        if (
            typeof actual !== "string" ||
            typeof expected !== "string" ||
            !colorsEqual(actual, expected)
        ) {
            issues.push({
                scope,
                message: `${label} color mismatch: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
            })
        }
    }

    const tokensDoc = loadDesignTokensToml(rootDir)
    const brandingDoc = loadDesignBrandingToml(rootDir)

    const tokensMeta = asRecord(tokensDoc.meta, "tokens.meta")
    const brandingMeta = asRecord(brandingDoc.meta, "branding.meta")
    const version = String(tokensMeta.version ?? "")

    checkEq("meta", "tokens.meta.version", version, DESIGN_SYSTEM_VERSION)
    checkEq("meta", "branding.meta.tokens_version", brandingMeta.tokens_version, version)
    checkEq("meta", "branding.meta.tokens_spec", brandingMeta.tokens_spec, "design/tokens.toml")

    const gates = asRecord(tokensDoc.gates, "tokens.gates")
    checkEq(
        "gates",
        "min_body_contrast_ratio_milli",
        TOKEN_GATES.minBodyContrastRatioMilli,
        gates.min_body_contrast_ratio_milli,
    )
    checkEq(
        "gates",
        "min_aaa_slate_contrast_milli",
        TOKEN_GATES.minAaaSlateContrastMilli,
        gates.min_aaa_slate_contrast_milli,
    )
    checkEq(
        "gates",
        "min_ui_component_contrast_milli",
        TOKEN_GATES.minUiComponentContrastMilli,
        gates.min_ui_component_contrast_milli,
    )
    checkEq(
        "gates",
        "min_cross_state_delta_e00_milli",
        TOKEN_GATES.minCrossStateDeltaE00Milli,
        gates.min_cross_state_delta_e00_milli,
    )
    checkEq(
        "gates",
        "min_fresh_vs_stale_delta_e00_milli",
        TOKEN_GATES.minFreshVsStaleDeltaE00Milli,
        gates.min_fresh_vs_stale_delta_e00_milli,
    )
    checkEq(
        "gates",
        "min_adjacent_channel_delta_e00_milli",
        TOKEN_GATES.minAdjacentChannelDeltaE00Milli,
        gates.min_adjacent_channel_delta_e00_milli,
    )

    const tokenMap = asRecord(tokensDoc.tokens, "tokens.tokens")
    const brandingPalette = asRecord(brandingDoc.palette, "branding.palette")
    const paletteBindings: readonly [string, string][] = [
        ["canvas_bg", "sd-surface-bg"],
        ["surface_elevated", "sd-surface-card"],
        ["border_subtle", "sd-surface-border"],
        ["accent_primary", "sd-focus-ring"],
        ["accent_emerald", "sd-provenance-live-fg"],
        ["accent_amber", "sd-provenance-stale-fg"],
        ["accent_danger", "sd-danger"],
        ["text_primary", "sd-text-primary"],
        ["text_muted", "sd-text-muted"],
    ]
    for (const [paletteKey, tokenKey] of paletteBindings) {
        checkColor(
            "branding.palette",
            `branding.palette.${paletteKey} === tokens["${tokenKey}"]`,
            brandingPalette[paletteKey],
            tokenMap[tokenKey],
        )
    }

    const surfaces = asRecord(tokensDoc.surfaces, "tokens.surfaces")
    const surfaceEntries = Object.values(surfaces).map((entry) => asRecord(entry, "surface"))
    checkEq("surfaces", "TELEMETRY_SURFACES.length", TELEMETRY_SURFACES.length, surfaceEntries.length)
    for (const surface of TELEMETRY_SURFACES) {
        const match = surfaceEntries.find((s) => s.layer_id === surface.layerId)
        checkEq("surfaces", `${surface.layerId}.token_name`, surface.tokenName, match?.token_name)
        checkColor("surfaces", `${surface.layerId}.hex`, surface.hex, match?.hex)
        const lookupKey = surface.tokenName.replace(/^--/, "")
        checkColor("tokens", `tokens["${lookupKey}"]`, tokenMap[lookupKey], surface.hex)
    }

    const uiTable = asRecord(tokensDoc.ui, "tokens.ui")
    const uiEntries = Object.values(uiTable).map((entry) => asRecord(entry, "ui"))
    checkEq("ui", "UI_TOKENS.length", UI_TOKENS.length, uiEntries.length)
    for (const uiToken of UI_TOKENS) {
        const match = uiEntries.find((u) => u.token_name === uiToken.tokenName)
        checkColor("ui", `${uiToken.tokenName}.hex`, uiToken.hex, match?.hex)
        checkEq("ui", `${uiToken.tokenName}.role`, uiToken.role, match?.role)
        const lookupKey = uiToken.tokenName.replace(/^--/, "")
        checkColor("tokens", `tokens["${lookupKey}"]`, tokenMap[lookupKey], uiToken.hex)
    }

    const slaTable = asRecord(tokensDoc.sla, "tokens.sla")
    const slaEntries = Object.values(slaTable).map((entry) => asRecord(entry, "sla"))
    checkEq("sla", "SLA_STATES.length", SLA_STATES.length, slaEntries.length)
    for (const slaState of SLA_STATES) {
        const match = slaEntries.find((s) => s.state_id === slaState.stateId)
        checkEq("sla", `${slaState.stateId}.token_name`, slaState.tokenName, match?.token_name)
        checkColor("sla", `${slaState.stateId}.fg_hex`, slaState.fgHex, match?.fg_hex)
        checkColor("sla", `${slaState.stateId}.bg_hex`, slaState.bgHex, match?.bg_hex)
        checkColor("sla", `${slaState.stateId}.border_hex`, slaState.borderHex, match?.border_hex)
    }

    const casTable = asRecord(tokensDoc.cas_states, "tokens.cas_states")
    for (const [casKey, rawEntry] of Object.entries(casTable)) {
        const entry = asRecord(rawEntry, `cas_states.${casKey}`)
        const baseName = String(entry.token_name ?? "").replace(/^--/, "")
        checkColor("cas_states", `${baseName}-fg`, tokenMap[`${baseName}-fg`], entry.fg_hex)
        checkColor("cas_states", `${baseName}-bg`, tokenMap[`${baseName}-bg`], entry.bg_hex)
        checkColor(
            "cas_states",
            `${baseName}-border`,
            tokenMap[`${baseName}-border`],
            entry.border_hex,
        )
    }

    const bridges = asRecord(tokensDoc.bridges, "tokens.bridges")
    for (const [bridgeKey, bridgeId] of Object.entries(SOURCE_BRIDGE_IDS)) {
        checkEq("bridges", bridgeKey, bridgeId, bridges[bridgeKey])
    }

    const ingestionTable = asRecord(tokensDoc.ingestion, "tokens.ingestion")
    const ingestionEntries = Object.values(ingestionTable).map((entry) =>
        asRecord(entry, "ingestion"),
    )
    checkEq(
        "ingestion",
        "INGESTION_CHANNELS.length",
        INGESTION_CHANNELS.length,
        ingestionEntries.length,
    )
    for (const channel of INGESTION_CHANNELS) {
        const match = ingestionEntries.find((c) => c.channel_id === channel.channelId)
        checkEq("ingestion", `ch${channel.channelId}.layer_id`, channel.layerId, match?.layer_id)
        checkEq(
            "ingestion",
            `ch${channel.channelId}.token_name`,
            channel.tokenName,
            match?.token_name,
        )
        checkColor("ingestion", `ch${channel.channelId}.hex`, channel.hex, match?.hex)
        checkEq(
            "ingestion",
            `ch${channel.channelId}.channel_code`,
            channel.channelCode,
            match?.channel_code,
        )
        checkEq(
            "ingestion",
            `ch${channel.channelId}.sla_tens_of_ms`,
            channel.slaTensOfMs,
            match?.sla_tens_of_ms,
        )
    }

    const routesTable = asRecord(tokensDoc.routes, "tokens.routes")
    const routeEntries = Object.values(routesTable).map((entry) => asRecord(entry, "route"))
    checkEq("routes", "ROUTE_CIRCUITS.length", ROUTE_CIRCUITS.length, routeEntries.length)
    for (const route of ROUTE_CIRCUITS) {
        const match = routeEntries.find((r) => r.route_id === route.routeId)
        checkEq("routes", `route${route.routeId}.layer_id`, route.layerId, match?.layer_id)
        checkEq("routes", `route${route.routeId}.token_name`, route.tokenName, match?.token_name)
        checkColor("routes", `route${route.routeId}.hex`, route.hex, match?.hex)
        checkEq("routes", `route${route.routeId}.move_flag`, route.moveFlag, match?.move_flag)
    }

    const bitmasks = asRecord(tokensDoc.bitmasks, "tokens.bitmasks")
    const betLegMasks = asRecord(bitmasks.bet_legs, "bitmasks.bet_legs")
    for (const [name, bit] of Object.entries(BET_LEG_BIT_POSITIONS)) {
        checkEq("bitmasks.bet_legs", name, bit, betLegMasks[name])
    }
    const uiStateMasks = asRecord(bitmasks.ui_state, "bitmasks.ui_state")
    for (const [name, bit] of Object.entries(UI_STATE_BIT_POSITIONS)) {
        checkEq("bitmasks.ui_state", name, bit, uiStateMasks[name])
    }

    const keymapTable = asRecord(tokensDoc.keymap, "tokens.keymap")
    const keymapEntries = Object.values(keymapTable).map((entry) => asRecord(entry, "keymap"))
    checkEq("keymap", "OPERATOR_KEYMAP.length", OPERATOR_KEYMAP.length, keymapEntries.length)
    for (const slot of OPERATOR_KEYMAP) {
        const match = keymapEntries.find((k) => k.slot_index === slot.slotIndex)
        checkEq("keymap", `slot${slot.slotIndex}.key_code`, slot.keyCode, match?.key_code)
        checkEq("keymap", `slot${slot.slotIndex}.bit_mask`, slot.bitMask, match?.bit_mask)
        checkEq(
            "keymap",
            `slot${slot.slotIndex}.forensic_mode`,
            slot.forensicMode,
            match?.forensic_mode,
        )
        checkEq("keymap", `slot${slot.slotIndex}.label`, slot.label, match?.label)
    }

    const canonicalHexEntries = Object.entries(tokenMap).filter(
        ([, val]) => typeof val === "string",
    )
    for (const [key, val] of canonicalHexEntries) {
        checkEq(
            "tokens.canonical_hex",
            `tokens["${key}"] normalized`,
            normalizeColorHex(val as string),
            (val as string).toLowerCase(),
        )
    }

    return {
        ok: issues.length === 0,
        version,
        checksRun,
        issues,
    }
}
