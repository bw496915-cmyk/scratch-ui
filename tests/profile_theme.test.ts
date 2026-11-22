/**
 * @file tests/profile_theme.test.ts
 * @description Bun-native unit & route tests for profile theme validation,
 * Bun.markdown.ansi / Bun.inspect / Bun.color rendering, and CSRF/Origin-guarded
 * `/api/profile`, `/api/profile/theme`, and `/api/profile/render.md` routes.
 */

import { Database } from "bun:sqlite"
import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createHttpAuthController, digestSessionId, type SessionRecord } from "../lib/http_auth.ts"
import { ApiTelemetry } from "../server/api_telemetry.ts"
import { openDashboardState } from "../server/dashboard_sessions.ts"
import { createPrivateDashboardRoutes } from "../server/private_dashboard_routes.ts"
import { profileRoutes } from "../src/http/profile_routes.ts"
import {
  ansiThemeFor,
  colorize,
  inspectFor,
  renderMarkdownForTerminal,
} from "../src/profile/render.ts"
import { createMemoryProfileStore, profileOrDefault } from "../src/profile/store.ts"
import { DEFAULT_PROFILE_THEME, type ProfileTheme } from "../src/profile/types.ts"
import { parseProfileTheme } from "../src/profile/validate.ts"

const ALLOWED_ORIGIN = "https://desk.bookdeskops.com"

describe("SQLite profile themes", () => {
  it("reopens a theme and cascades session removal with digest-only keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sportsdesk-profile-theme-"))
    const file = join(directory, "state.sqlite")
    const session = "private-session-cookie"
    const sessionKey = digestSessionId(session)
    const record = {
      csrfToken: "csrf-probe",
      operatorId: "theme-probe",
      role: "OPERATOR",
      credentialProof: "proof",
      expiresAtMs: Date.now() + 60_000,
    } satisfies SessionRecord
    const theme: ProfileTheme = { ...DEFAULT_PROFILE_THEME, ui: "dark" }
    try {
      const first = await openDashboardState(file)
      const signingKey = first.getOrCreateCsrfSecret()
      try {
        first.sessions.insert(sessionKey, record)
        expect(first.profiles.putTheme(session, theme)?.theme).toEqual(theme)
        expect(first.profiles.putTheme("unissued-session", theme)).toBeNull()
        first.sessions.insert(digestSessionId("expired-session"), {
          ...record,
          expiresAtMs: Date.now() - 1,
        })
        expect(first.profiles.putTheme("expired-session", theme)).toBeNull()
      } finally {
        first.close()
      }

      const second = await openDashboardState(file)
      const reader = new Database(file, { readonly: true })
      try {
        expect(second.getOrCreateCsrfSecret()).toBe(signingKey)
        expect(second.profiles.get(session)?.theme).toEqual(theme)
        expect(reader.query("SELECT session_id FROM dashboard_profile_themes").all()).toEqual([
          { session_id: sessionKey },
        ])
        second.sessions.delete(sessionKey)
        expect(second.profiles.get(session)).toBeNull()
        expect(reader.query("SELECT session_id FROM dashboard_profile_themes").all()).toEqual([])
      } finally {
        reader.close()
        second.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe("Profile Theme Validation (allowlist, no coercion)", () => {
  it("accepts a valid ProfileTheme payload", () => {
    const parsed = parseProfileTheme(DEFAULT_PROFILE_THEME)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.value).toEqual(DEFAULT_PROFILE_THEME)
    }
  })

  it("rejects non-object, bad shapes, and out-of-range values with exact error codes", () => {
    expect(parseProfileTheme(null)).toEqual({
      ok: false,
      error: "ERR_THEME_NOT_OBJECT",
    })
    expect(parseProfileTheme([])).toEqual({
      ok: false,
      error: "ERR_THEME_NOT_OBJECT",
    })
    expect(parseProfileTheme({ ui: "light" })).toEqual({
      ok: false,
      error: "ERR_THEME_SHAPE",
    })
    expect(
      parseProfileTheme({
        ...DEFAULT_PROFILE_THEME,
        ui: "neon",
      }),
    ).toEqual({ ok: false, error: "ERR_THEME_UI" })
    expect(
      parseProfileTheme({
        ...DEFAULT_PROFILE_THEME,
        colorDepth: "ansi-64",
      }),
    ).toEqual({ ok: false, error: "ERR_THEME_DEPTH" })
    expect(
      parseProfileTheme({
        ...DEFAULT_PROFILE_THEME,
        terminal: { ...DEFAULT_PROFILE_THEME.terminal, light: "sepia" },
      }),
    ).toEqual({ ok: false, error: "ERR_THEME_T_LIGHT" })
    expect(
      parseProfileTheme({
        ...DEFAULT_PROFILE_THEME,
        terminal: { ...DEFAULT_PROFILE_THEME.terminal, columns: -1 },
      }),
    ).toEqual({ ok: false, error: "ERR_THEME_T_COLUMNS" })
    expect(
      parseProfileTheme({
        ...DEFAULT_PROFILE_THEME,
        terminal: { ...DEFAULT_PROFILE_THEME.terminal, columns: 501 },
      }),
    ).toEqual({ ok: false, error: "ERR_THEME_T_COLUMNS" })
    expect(
      parseProfileTheme({
        ...DEFAULT_PROFILE_THEME,
        terminal: { ...DEFAULT_PROFILE_THEME.terminal, columns: 80.5 },
      }),
    ).toEqual({ ok: false, error: "ERR_THEME_T_COLUMNS" })
    expect(
      parseProfileTheme({
        ...DEFAULT_PROFILE_THEME,
        inspect: { ...DEFAULT_PROFILE_THEME.inspect, depth: 21 },
      }),
    ).toEqual({ ok: false, error: "ERR_THEME_I_DEPTH" })
    expect(
      parseProfileTheme({
        ...DEFAULT_PROFILE_THEME,
        inspect: { ...DEFAULT_PROFILE_THEME.inspect, depth: -1 },
      }),
    ).toEqual({ ok: false, error: "ERR_THEME_I_DEPTH" })
  })
})

describe("Profile Store & Bun Terminal Surfaces", () => {
  it("omits `light` from AnsiTheme when set to 'auto' and maps explicit light/dark booleans", () => {
    const autoTheme = ansiThemeFor(DEFAULT_PROFILE_THEME)
    expect("light" in autoTheme).toBe(false)

    const explicitLight = ansiThemeFor({
      ...DEFAULT_PROFILE_THEME,
      terminal: { ...DEFAULT_PROFILE_THEME.terminal, light: "light" },
    })
    expect(explicitLight.light).toBe(true)

    const explicitDark = ansiThemeFor({
      ...DEFAULT_PROFILE_THEME,
      terminal: { ...DEFAULT_PROFILE_THEME.terminal, light: "dark" },
    })
    expect(explicitDark.light).toBe(false)
  })

  it("renders markdown ANSI, inspects objects, and generates color escapes per profile", () => {
    const darkTheme: ProfileTheme = {
      ui: "dark",
      colorDepth: "ansi-256",
      terminal: {
        colors: true,
        light: "dark",
        hyperlinks: true,
        columns: 100,
        kittyGraphics: false,
      },
      inspect: {
        colors: false,
        compact: true,
        depth: 2,
        sorted: true,
      },
    }

    const md = renderMarkdownForTerminal("# Heading\n\n**bold** and `code`", darkTheme)
    expect(md).toContain("\x1b[")

    const noColorTheme: ProfileTheme = {
      ...darkTheme,
      terminal: { ...darkTheme.terminal, colors: false },
    }
    const plainMd = renderMarkdownForTerminal("# Heading\n\n**bold**", noColorTheme)
    expect(plainMd).not.toContain("\x1b[")
    expect(colorize("#38bdf8", noColorTheme)).toBe("")

    const esc256 = colorize("#38bdf8", darkTheme)
    expect(esc256).toContain("\x1b[38;5;")

    const esc16m = colorize("#38bdf8", { ...darkTheme, colorDepth: "ansi-16m" })
    expect(esc16m).toContain("\x1b[38;2;")

    const inspected = inspectFor({ b: 2, a: 1 }, darkTheme)
    expect(inspected.indexOf("a")).toBeLessThan(inspected.indexOf("b"))
    expect(inspected).not.toContain("\x1b[")
  })

  it("returns default profile for unknown sessionId and persists updates", () => {
    const store = createMemoryProfileStore()
    const def = profileOrDefault(store, "missing-sid")
    expect(def.theme).toEqual(DEFAULT_PROFILE_THEME)
    expect(def.updatedAt).toBe(new Date(0).toISOString())
  })

  it("applies native GFM, background, width and hyperlink settings to terminal Markdown", () => {
    const theme: ProfileTheme = {
      ...DEFAULT_PROFILE_THEME,
      terminal: {
        ...DEFAULT_PROFILE_THEME.terminal,
        light: "light",
        columns: 0,
        hyperlinks: true,
      },
    }
    const markdown = [
      "# Terminal preview",
      "",
      "| Key | Value |",
      "| --- | --- |",
      "| Enabled | true |",
      "",
      "- [x] done",
      "",
      "Use `value` here.",
      "",
      "[Bun](https://bun.com/)",
    ].join("\n")
    const light = renderMarkdownForTerminal(markdown, theme)
    expect(light).toContain("\x1b[48;5;254m")
    expect(light).toContain("\x1b]8;;https://bun.com/")
    expect(light).toContain("┌")
    expect(light).toContain("☒")
    const dark = renderMarkdownForTerminal(markdown, {
      ...theme,
      terminal: { ...theme.terminal, light: "dark" },
    })
    expect(dark).toContain("\x1b[48;5;236m")
    const plain = {
      ...theme,
      terminal: { ...theme.terminal, colors: false, columns: 10 },
    }
    const plainMarkdown = renderMarkdownForTerminal(markdown, plain)
    expect(plainMarkdown).not.toContain("\x1b")
    expect(plainMarkdown).toContain("[x] done")
    expect(renderMarkdownForTerminal("one two three four", plain)).toBe("one two\nthree four\n")
    expect(renderMarkdownForTerminal("one two three four", theme)).toContain("one two three four")
  })
})

describe("Profile Routes (/api/profile, /api/profile/theme, /api/profile/render.md)", () => {
  async function setupAuthenticatedFixture() {
    const httpAuth = createHttpAuthController({
      env: {
        NODE_ENV: "production",
        SPORTSDESK_DASHBOARD_TOKEN: "profile-op-token",
      },
    })
    const store = createMemoryProfileStore()
    const resolveSessionId = (req: Request): string | null => {
      const auth = httpAuth.authenticateHeaders(req.headers, "GET")
      return auth.authenticated ? (auth.sessionId ?? null) : null
    }
    const routes = profileRoutes(
      store,
      {
        allowedOrigins: [ALLOWED_ORIGIN],
        verifyCsrfToken: httpAuth.verifySessionCsrfToken,
      },
      { resolveSessionId },
    )

    const loginRes = await httpAuth.auth.login(
      new Request("https://desk.bookdeskops.com/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operatorId: "theme-tester",
          token: "profile-op-token",
        }),
      }),
    )
    expect(loginRes.status).toBe(200)
    const setCookies = loginRes.headers.getSetCookie()
    const sdSession = setCookies.find((c) => c.startsWith("sd_session="))
    const sdCsrf = setCookies.find((c) => c.startsWith("sd_csrf="))
    expect(sdSession).toContain("HttpOnly")
    expect(sdCsrf).toBeDefined()

    const sessionCookieHeader = sdSession!.split(";")[0]!
    const csrfToken = decodeURIComponent(sdCsrf!.split(";")[0]!.split("=")[1]!)

    return { routes, sessionCookieHeader, csrfToken, resolveSessionId }
  }

  it("reads the authenticated profile through Bun's cookie map", async () => {
    const { routes, sessionCookieHeader, resolveSessionId } = await setupAuthenticatedFixture()
    const readProfile = routes["/api/profile"].GET
    const native = createPrivateDashboardRoutes(new ApiTelemetry(), {
      profile: {
        resolveSessionId,
        read(request) {
          expect(request.headers.get("cookie")).toBe(sessionCookieHeader)
          return readProfile(request)
        },
      },
    })
    try {
      const url = `${ALLOWED_ORIGIN}/api/profile`
      const request = new Request(url, {
        headers: { cookie: `${sessionCookieHeader}; theme=dark; user_id=someone-else` },
      })
      const response = await native.dispatchProfile(request)
      expect(response?.status).toBe(200)
      expect(response?.headers.get("set-cookie")).toBeNull()
      expect(await response?.json()).toMatchObject({ theme: DEFAULT_PROFILE_THEME })
      const bearer = new Request(url, {
        headers: { cookie: sessionCookieHeader, authorization: "Bearer profile-op-token" },
      })
      expect(native.dispatchProfile(bearer)).toBeNull()
      expect(native.dispatchProfile(new Request(url))).toBeNull()
      expect(native.dispatchProfile(new Request(url, { method: "POST" }))).toBeNull()
    } finally {
      await native.stop()
    }
  })

  it("verifies origin and session CSRF before a native Bun profile write", async () => {
    const { routes, sessionCookieHeader, csrfToken, resolveSessionId } =
      await setupAuthenticatedFixture()
    const native = createPrivateDashboardRoutes(new ApiTelemetry(), {
      profile: {
        read: routes["/api/profile"].GET,
        write: routes["/api/profile/theme"].POST,
        resolveSessionId,
      },
    })
    try {
      const theme = { ...DEFAULT_PROFILE_THEME, ui: "dark" }
      function submit(csrf: string, origin = ALLOWED_ORIGIN) {
        return native.dispatchProfileTheme(
          new Request(`${ALLOWED_ORIGIN}/api/profile/theme`, {
            method: "POST",
            headers: {
              cookie: sessionCookieHeader,
              "content-type": "application/json",
              origin,
              "x-csrf-token": csrf,
            },
            body: JSON.stringify(theme),
          }),
        )
      }
      const invalidToken = await submit("forged-token")
      expect(invalidToken?.status).toBe(403)
      const invalidOrigin = await submit(csrfToken, "https://other.test")
      expect(invalidOrigin?.status).toBe(403)
      const saved = await submit(csrfToken)
      expect(saved?.status).toBe(200)
      expect(await saved?.json()).toMatchObject({ theme })
    } finally {
      await native.stop()
    }
  })

  it("rejects unauthenticated GET /api/profile and GET /api/profile/render.md with 401 ERR_UNAUTHENTICATED", async () => {
    const { routes } = await setupAuthenticatedFixture()

    const pRes = routes["/api/profile"].GET(new Request("https://desk.bookdeskops.com/api/profile"))
    expect(pRes.status).toBe(401)
    expect((await pRes.json()) as { error: string }).toEqual({
      error: "ERR_UNAUTHENTICATED",
    })
    expect(pRes.headers.get("cache-control")).toBe("no-store")
    expect(pRes.headers.get("vary")).toBe("Cookie")

    const rRes = routes["/api/profile/render.md"].GET(
      new Request("https://desk.bookdeskops.com/api/profile/render.md"),
    )
    expect(rRes.status).toBe(401)
    expect((await rRes.json()) as { error: string }).toEqual({
      error: "ERR_UNAUTHENTICATED",
    })
  })

  it("enforces Origin allowlist and CSRF token on POST /api/profile/theme", async () => {
    const { routes, sessionCookieHeader, csrfToken } = await setupAuthenticatedFixture()

    const badOrigin = await routes["/api/profile/theme"].POST(
      new Request("https://desk.bookdeskops.com/api/profile/theme", {
        method: "POST",
        headers: {
          cookie: sessionCookieHeader,
          origin: "https://evil.attacker.example",
          "x-csrf-token": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(DEFAULT_PROFILE_THEME),
      }),
    )
    expect(badOrigin.status).toBe(403)
    expect(((await badOrigin.json()) as { error: string }).error).toBe("ERR_CSRF_ORIGIN")

    const badCsrf = await routes["/api/profile/theme"].POST(
      new Request("https://desk.bookdeskops.com/api/profile/theme", {
        method: "POST",
        headers: {
          cookie: sessionCookieHeader,
          origin: ALLOWED_ORIGIN,
          "x-csrf-token": "wrong-csrf-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(DEFAULT_PROFILE_THEME),
      }),
    )
    expect(badCsrf.status).toBe(403)
    expect(((await badCsrf.json()) as { error: string }).error).toBe("ERR_CSRF_TOKEN")
  })

  it("persists profile theme through the CSRF-guarded POST, rejects invalid payloads, and renders ANSI markdown", async () => {
    const { routes, sessionCookieHeader, csrfToken } = await setupAuthenticatedFixture()

    const payload: ProfileTheme = {
      ui: "dark",
      colorDepth: "ansi-256",
      terminal: {
        colors: true,
        light: "dark",
        hyperlinks: true,
        columns: 100,
        kittyGraphics: false,
      },
      inspect: {
        colors: false,
        compact: true,
        depth: 2,
        sorted: true,
      },
    }

    const post = await routes["/api/profile/theme"].POST(
      new Request("https://desk.bookdeskops.com/api/profile/theme", {
        method: "POST",
        headers: {
          cookie: sessionCookieHeader,
          origin: ALLOWED_ORIGIN,
          "x-csrf-token": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }),
    )
    expect(post.status).toBe(200)
    expect(post.headers.get("cache-control")).toBe("no-store")
    expect(post.headers.get("vary")).toBe("Cookie")

    const get = routes["/api/profile"].GET(
      new Request("https://desk.bookdeskops.com/api/profile", {
        headers: { cookie: sessionCookieHeader },
      }),
    )
    expect(get.status).toBe(200)
    const { theme } = (await get.json()) as { theme: ProfileTheme }
    expect(theme).toEqual(payload)

    // Invalid JSON returns 400 ERR_INVALID_JSON
    const malformed = await routes["/api/profile/theme"].POST(
      new Request("https://desk.bookdeskops.com/api/profile/theme", {
        method: "POST",
        headers: {
          cookie: sessionCookieHeader,
          origin: ALLOWED_ORIGIN,
          "x-csrf-token": csrfToken,
          "content-type": "application/json",
        },
        body: "{not-json",
      }),
    )
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: string }).error).toBe("ERR_INVALID_JSON")

    // Invalid theme payload returns 400 ERR_THEME_UI without overwriting stored theme
    const bad = await routes["/api/profile/theme"].POST(
      new Request("https://desk.bookdeskops.com/api/profile/theme", {
        method: "POST",
        headers: {
          cookie: sessionCookieHeader,
          origin: ALLOWED_ORIGIN,
          "x-csrf-token": csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ui: "neon",
          colorDepth: "ansi-256",
          terminal: {},
          inspect: {},
        }),
      }),
    )
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toBe("ERR_THEME_UI")

    // Stored theme remains intact after rejected POST
    const afterBad = routes["/api/profile"].GET(
      new Request("https://desk.bookdeskops.com/api/profile", {
        headers: { cookie: sessionCookieHeader },
      }),
    )
    expect(((await afterBad.json()) as { theme: ProfileTheme }).theme).toEqual(payload)

    // Renders ANSI markdown as text/plain (never text/html) using stored terminal theme
    const renderRes = routes["/api/profile/render.md"].GET(
      new Request("https://desk.bookdeskops.com/api/profile/render.md", {
        headers: { cookie: sessionCookieHeader },
      }),
    )
    expect(renderRes.status).toBe(200)
    expect(renderRes.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    const text = await renderRes.text()
    expect(text).toContain("\x1b[")
    expect(text).toContain("dark")
    expect(text).toContain("100")
  })
})
