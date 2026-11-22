import { describe, expect, test } from "bun:test"
import type { IncomingMessage } from "node:http"
import { createHttpAuthController, isDevQuickLoginAllowed } from "../../lib/http_auth.ts"
import { adminGuard } from "../../packages/api/src/router.ts"

describe("Dev Quick Sign-In & Cross-Site Iframe Auth", () => {
  test("isDevQuickLoginAllowed is strictly gated to NODE_ENV=development + SPORTSDESK_DEV_SERVER=1", () => {
    expect(isDevQuickLoginAllowed({})).toBe(false)
    expect(isDevQuickLoginAllowed({ NODE_ENV: "production" })).toBe(false)
    expect(
      isDevQuickLoginAllowed({
        NODE_ENV: "production",
        SPORTSDESK_DEV_SERVER: "1",
      }),
    ).toBe(false)
    expect(isDevQuickLoginAllowed({ NODE_ENV: "development" })).toBe(false)
    expect(
      isDevQuickLoginAllowed({
        NODE_ENV: "development",
        SPORTSDESK_DEV_SERVER: "1",
      }),
    ).toBe(true)
  })

  test("rejects devQuickLogin in production even if requested in body", async () => {
    const auth = createHttpAuthController({
      env: {
        NODE_ENV: "production",
        SPORTSDESK_DEV_SERVER: "1",
        SPORTSDESK_DASHBOARD_TOKEN: "prod-secret",
      },
    })

    const meRes = await auth.auth.me(new Request("http://127.0.0.1:3000/api/auth/me"))
    const meJson = (await meRes.json()) as { devQuickLoginAvailable: boolean }
    expect(meJson.devQuickLoginAvailable).toBe(false)

    const loginRes = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devQuickLogin: true, role: "ADMIN" }),
      }),
    )
    expect(loginRes.status).toBe(401)
  })

  test("allows one-click Dev Operator & Dev Admin sign-in on dev server without configured tokens, sets iframe-safe cookies, and validates Bearer/WS fallback", async () => {
    const auth = createHttpAuthController({
      env: {
        NODE_ENV: "development",
        SPORTSDESK_DEV_SERVER: "1",
      },
    })

    const meBefore = await auth.auth.me(new Request("http://127.0.0.1:3000/api/auth/me"))
    const meBeforeJson = (await meBefore.json()) as {
      authenticated: boolean
      devQuickLoginAvailable: boolean
    }
    expect(meBeforeJson.authenticated).toBe(false)
    expect(meBeforeJson.devQuickLoginAvailable).toBe(true)

    // One-click Dev Admin sign-in behind HTTPS proxy (AI Studio preview iframe)
    const loginRes = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-proto": "https",
          "sec-fetch-site": "cross-site",
        },
        body: JSON.stringify({
          devQuickLogin: true,
          role: "ADMIN",
          operatorId: "dev-fast",
        }),
      }),
    )
    expect(loginRes.status).toBe(200)

    const cookies = loginRes.headers.getSetCookie()
    const sessionCookie = cookies.find((c) => c.startsWith("sd_session="))
    expect(sessionCookie).toContain("SameSite=None")
    expect(sessionCookie).toContain("Secure")
    expect(sessionCookie).toContain("Partitioned")

    const loginJson = (await loginRes.json()) as {
      authenticated: boolean
      operatorId: string
      role: string
      devSessionToken: string
      csrfToken: string
    }
    expect(loginJson.authenticated).toBe(true)
    expect(loginJson.operatorId).toBe("dev-fast")
    expect(loginJson.role).toBe("ADMIN")
    expect(loginJson.devSessionToken.startsWith("sd_dev_")).toBe(true)

    // Bearer fallback works even when cookies are completely stripped
    const denied = await auth.enforceAuth(
      new Request("http://127.0.0.1:3000/api/wagers", {
        headers: { Authorization: `Bearer ${loginJson.devSessionToken}` },
      }),
    )
    expect(denied).toBeNull()

    // Dev Admin session can execute admin routes when SPORTSDESK_ADMIN_TOKEN is unset
    const adminDenied = await auth.enforceAdminAuth(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: { Authorization: `Bearer ${loginJson.devSessionToken}` },
      }),
    )
    expect(adminDenied).toBeNull()

    // adminGuard honors verified Dev Admin session in dev-server mode without x-admin-token
    const devEnv = {
      NODE_ENV: "development",
      SPORTSDESK_DEV_SERVER: "1",
    }
    const guarded = adminGuard(
      (req) => auth.enforceAdminAuth(req),
      async () => Response.json({ ok: true, stdout: "terminal-ok" }),
      { env: devEnv },
    )
    const devAdminExecRes = await guarded(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: { Authorization: `Bearer ${loginJson.devSessionToken}` },
      }),
    )
    expect(devAdminExecRes.status).toBe(200)

    // Dev Operator is still denied by adminGuard / enforceAdminAuth
    const opLoginRes = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devQuickLogin: true, role: "OPERATOR" }),
      }),
    )
    const opJson = (await opLoginRes.json()) as { devSessionToken: string }
    const devOpExecRes = await guarded(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: { Authorization: `Bearer ${opJson.devSessionToken}` },
      }),
    )
    expect(devOpExecRes.status).toBe(503)

    // Anonymous requests remain fail-closed (401)
    const anonExecRes = await guarded(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
      }),
    )
    expect(anonExecRes.status).toBe(401)

    // When SPORTSDESK_ADMIN_TOKEN IS configured on the dev server (e.g. preview env),
    // Dev Admin session still executes allowlisted terminal commands without x-admin-token,
    // while an explicit invalid x-admin-token is rejected (403) and Dev Operator is rejected (403).
    const devWithTokenEnv = {
      NODE_ENV: "development",
      SPORTSDESK_DEV_SERVER: "1",
      SPORTSDESK_ADMIN_TOKEN: "explicit-dev-admin-secret",
    }
    const authWithToken = createHttpAuthController({ env: devWithTokenEnv })
    const adminLogin2 = await authWithToken.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devQuickLogin: true, role: "ADMIN" }),
      }),
    )
    const admin2Json = (await adminLogin2.json()) as { devSessionToken: string }
    const opLogin2 = await authWithToken.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ devQuickLogin: true, role: "OPERATOR" }),
      }),
    )
    const op2Json = (await opLogin2.json()) as { devSessionToken: string }
    const configuredGuarded = adminGuard(
      (req) => authWithToken.enforceAdminAuth(req),
      async () => Response.json({ ok: true }),
      { env: devWithTokenEnv },
    )

    const devAdminWithEnvTokenRes = await configuredGuarded(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: { Authorization: `Bearer ${admin2Json.devSessionToken}` },
      }),
    )
    expect(devAdminWithEnvTokenRes.status).toBe(200)

    const wrongAdminTokenRes = await configuredGuarded(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin2Json.devSessionToken}`,
          "x-admin-token": "wrong-secret",
        },
      }),
    )
    expect(wrongAdminTokenRes.status).toBe(403)

    const devOpMissingTokenRes = await configuredGuarded(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
        headers: { Authorization: `Bearer ${op2Json.devSessionToken}` },
      }),
    )
    expect(devOpMissingTokenRes.status).toBe(403)

    // Production NEVER allows dev-server bypass even if SPORTSDESK_DEV_SERVER=1 is set
    const prodGuarded = adminGuard(
      async () => null,
      async () => Response.json({ ok: true }),
      {
        env: {
          NODE_ENV: "production",
          SPORTSDESK_DEV_SERVER: "1",
          SPORTSDESK_ADMIN_TOKEN: "prod-secret",
        },
      },
    )
    const prodMissingTokenRes = await prodGuarded(
      new Request("http://127.0.0.1:3000/api/terminal/exec", {
        method: "POST",
      }),
    )
    expect(prodMissingTokenRes.status).toBe(403)

    // WebSocket upgrade authenticates via ?dev_session= fallback when cookies are absent
    const wsAuth = auth.verifyWebSocketUpgrade({
      url: `/ws?dev_session=${encodeURIComponent(loginJson.devSessionToken)}`,
      headers: { host: "127.0.0.1:3000" },
    } as IncomingMessage)
    expect(wsAuth.authenticated).toBe(true)

    // Logout revokes the dev session token
    await auth.auth.logout(
      new Request("http://127.0.0.1:3000/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${loginJson.devSessionToken}` },
      }),
    )
    const afterLogout = await auth.enforceAuth(
      new Request("http://127.0.0.1:3000/api/wagers", {
        headers: { Authorization: `Bearer ${loginJson.devSessionToken}` },
      }),
    )
    expect(afterLogout?.status).toBe(401)
  })
})
