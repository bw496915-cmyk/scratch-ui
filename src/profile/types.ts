/**
 * Profile theme types spanning web UI (`ui`), terminal markdown ANSI (`terminal`), object
 * inspection (`inspect`), and explicit escape depth (`colorDepth`).
 *
 * @file Src/profile/types.ts
 */

export type ThemeMode = "light" | "dark"
export type ColorDepth = "auto" | "ansi-16" | "ansi-256" | "ansi-16m"

export interface ProfileTheme {
  /** Web dashboard — same domain as the existing theme cookie */
  readonly ui: ThemeMode
  /** Bun.markdown.ansi / stdout */
  readonly terminal: {
    readonly colors: boolean
    /** `"auto"` => omit key so `COLORFGBG` probing decides */
    readonly light: ThemeMode | "auto"
    readonly hyperlinks: boolean
    /** `0` disables wrapping */
    readonly columns: number
    readonly kittyGraphics: boolean
  }
  /** Bun.inspect */
  readonly inspect: {
    readonly colors: boolean
    readonly compact: boolean
    readonly depth: number
    readonly sorted: boolean
  }
  /** Bun.color output format for explicit escape generation */
  readonly colorDepth: ColorDepth
}

export interface Profile {
  readonly sessionId: string
  readonly theme: ProfileTheme
  readonly updatedAt: string
}

export const DEFAULT_PROFILE_THEME: ProfileTheme = {
  ui: "light",
  terminal: {
    colors: true,
    light: "auto",
    hyperlinks: false,
    columns: 80,
    kittyGraphics: false,
  },
  inspect: {
    colors: true,
    compact: false,
    depth: 4,
    sorted: false,
  },
  colorDepth: "auto",
}
