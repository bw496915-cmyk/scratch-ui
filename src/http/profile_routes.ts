/**
 * @file src/http/profile_routes.ts
 * @description Authenticated profile theme HTTP routes (`/api/profile`,
 * `/api/profile/theme`, `/api/profile/render.md`) reusing the CSRF/Origin guard.
 */

import { parseCookieHeader, SESSION_COOKIE_NAME } from "../../lib/http_auth.ts"
import { verifyPostOriginAndCsrf, type CsrfOriginGuardConfig } from "./csrf_origin_guard.ts"
import type { ProfileStore } from "../profile/store.ts"
import { profileOrDefault } from "../profile/store.ts"
import { parseProfileTheme } from "../profile/validate.ts"
import { renderMarkdownForTerminal } from "../profile/render.ts"

const NO_STORE = { "Cache-Control": "no-store", Vary: "Cookie" } as const
export const PROFILE_ROUTE = "/api/profile"
export const PROFILE_THEME_ROUTE = "/api/profile/theme"

type RequestWithOptionalCookies = Request & {
  readonly cookies?: {
    get(name: string): string | null
  }
}

export interface ProfileRoutesOptions {
  /**
   * Optional authoritative session resolver (e.g. backed by `httpAuth.authenticateHeaders`).
   * When omitted, falls back to reading `sd_session` or `session_id` cookie.
   */
  readonly resolveSessionId?: (req: Request) => string | null
}

function unauthenticated(): Response {
  return Response.json({ error: "ERR_UNAUTHENTICATED" }, { status: 401, headers: NO_STORE })
}

function extractSessionId(
  req: RequestWithOptionalCookies,
  options?: ProfileRoutesOptions,
): string | null {
  if (options?.resolveSessionId) {
    return options.resolveSessionId(req)
  }
  if (req.cookies && typeof req.cookies.get === "function") {
    const sd = req.cookies.get(SESSION_COOKIE_NAME)
    if (sd) return sd
    const sid = req.cookies.get("session_id")
    if (sid) return sid
    return null
  }
  const cookies = parseCookieHeader(req.headers.get("cookie"))
  return cookies[SESSION_COOKIE_NAME] ?? cookies["session_id"] ?? null
}

export function profileRoutes(
  store: ProfileStore,
  csrf: CsrfOriginGuardConfig,
  options?: ProfileRoutesOptions,
) {
  return {
    [PROFILE_ROUTE]: {
      GET(req: RequestWithOptionalCookies): Response {
        const sessionId = extractSessionId(req, options)
        if (sessionId === null) return unauthenticated()

        const profile = profileOrDefault(store, sessionId)
        return Response.json(
          { theme: profile.theme, updatedAt: profile.updatedAt },
          { headers: NO_STORE },
        )
      },
    },

    [PROFILE_THEME_ROUTE]: {
      async POST(req: RequestWithOptionalCookies): Promise<Response> {
        const sessionId = extractSessionId(req, options)
        if (sessionId === null) return unauthenticated()

        const guard = verifyPostOriginAndCsrf(req, sessionId, csrf)
        if (!guard.ok) return guard.response

        let body: unknown
        try {
          body = await req.json()
        } catch {
          return Response.json({ error: "ERR_INVALID_JSON" }, { status: 400, headers: NO_STORE })
        }

        const parsed = parseProfileTheme(body)
        if (!parsed.ok) {
          return Response.json({ error: parsed.error }, { status: 400, headers: NO_STORE })
        }

        const profile = store.putTheme(sessionId, parsed.value)
        if (!profile) return unauthenticated()
        return Response.json(
          { theme: profile.theme, updatedAt: profile.updatedAt },
          { headers: NO_STORE },
        )
      },
    },

    /** Verification hook: curl this to see the stored terminal theme applied. */
    "/api/profile/render.md": {
      GET(req: RequestWithOptionalCookies): Response {
        const sessionId = extractSessionId(req, options)
        if (sessionId === null) return unauthenticated()

        const { theme } = profileOrDefault(store, sessionId)
        const sample = [
          "# Profile theme preview",
          "",
          "**bold** and *italic* and `inline code`",
          "",
          "| key | value |",
          "| --- | --- |",
          `| ui | ${theme.ui} |`,
          `| columns | ${theme.terminal.columns} |`,
          "",
          "```ts",
          "const ok = true;",
          "```",
        ].join("\n")

        return new Response(renderMarkdownForTerminal(sample, theme), {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            ...NO_STORE,
          },
        })
      },
    },
  }
}
