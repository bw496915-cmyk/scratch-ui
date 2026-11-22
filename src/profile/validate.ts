/**
 * @file src/profile/validate.ts
 * @description Strict allowlist validation for incoming ProfileTheme payloads.
 * Nothing from the request body is coerced or written raw.
 */

import type { ColorDepth, ProfileTheme, ThemeMode } from "./types.ts"

const THEMES = new Set<ThemeMode>(["light", "dark"])
const DEPTHS = new Set<ColorDepth>(["auto", "ansi-16", "ansi-256", "ansi-16m"])

const isTheme = (v: unknown): v is ThemeMode => typeof v === "string" && THEMES.has(v as ThemeMode)

const isDepth = (v: unknown): v is ColorDepth =>
  typeof v === "string" && DEPTHS.has(v as ColorDepth)

export type ParseResult =
  | { readonly ok: true; readonly value: ProfileTheme }
  | { readonly ok: false; readonly error: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export function parseProfileTheme(input: unknown): ParseResult {
  if (!isObj(input)) return { ok: false, error: "ERR_THEME_NOT_OBJECT" }

  const t = input.terminal
  const i = input.inspect
  if (!isObj(t) || !isObj(i)) return { ok: false, error: "ERR_THEME_SHAPE" }

  if (!isTheme(input.ui)) return { ok: false, error: "ERR_THEME_UI" }
  if (!isDepth(input.colorDepth)) return { ok: false, error: "ERR_THEME_DEPTH" }

  if (typeof t.colors !== "boolean") {
    return { ok: false, error: "ERR_THEME_T_COLORS" }
  }
  if (typeof t.hyperlinks !== "boolean") {
    return { ok: false, error: "ERR_THEME_T_LINKS" }
  }
  if (typeof t.kittyGraphics !== "boolean") {
    return { ok: false, error: "ERR_THEME_T_KITTY" }
  }
  if (!(t.light === "auto" || isTheme(t.light))) {
    return { ok: false, error: "ERR_THEME_T_LIGHT" }
  }
  if (
    typeof t.columns !== "number" ||
    !Number.isInteger(t.columns) ||
    t.columns < 0 ||
    t.columns > 500
  ) {
    return { ok: false, error: "ERR_THEME_T_COLUMNS" }
  }

  if (typeof i.colors !== "boolean") {
    return { ok: false, error: "ERR_THEME_I_COLORS" }
  }
  if (typeof i.compact !== "boolean") {
    return { ok: false, error: "ERR_THEME_I_COMPACT" }
  }
  if (typeof i.sorted !== "boolean") {
    return { ok: false, error: "ERR_THEME_I_SORTED" }
  }
  if (typeof i.depth !== "number" || !Number.isInteger(i.depth) || i.depth < 0 || i.depth > 20) {
    return { ok: false, error: "ERR_THEME_I_DEPTH" }
  }

  return {
    ok: true,
    value: {
      ui: input.ui,
      terminal: {
        colors: t.colors,
        light: t.light,
        hyperlinks: t.hyperlinks,
        columns: t.columns,
        kittyGraphics: t.kittyGraphics,
      },
      inspect: {
        colors: i.colors,
        compact: i.compact,
        depth: i.depth,
        sorted: i.sorted,
      },
      colorDepth: input.colorDepth,
    },
  }
}
