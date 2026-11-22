import { describe, expect, test } from "bun:test"

import {
  createHttpAuthController,
  FAST_SIGNIN_QUERY_PARAM,
  FAST_SIGNIN_TOKEN_PREFIX,
  isPublicApiRoute,
  MAX_FAST_SIGNIN_TTL_MS,
  MIN_FAST_SIGNIN_TTL_MS,
} from "../../lib/http_auth.ts"
import {
  buildFastSignInBookmarkUrl,
  buildFastSignInQrMatrix,
  extractAndScrubFastSignInToken,
  extractFastSignInTokenFromInput,
  resolveFastSignInBookmarkUrl,
} from "../../packages/ui/src/fast_signin.ts"
import { buildFastSignInQrSvgMarkup } from "../../packages/ui/src/panels/FastSignInQrCode.tsx"
import { buildDashboardSearch } from "../../packages/ui/src/url_state.ts"

describe("Hidden Fast Sign-In URL Parameter & Temporary Token Auth", () => {
  test("extractAndScrubFastSignInToken reads ?fast_signin=, scrubs URL immediately, and preserves dashboard params", () => {
    let replacedUrl: string | null = null
    const mockWin = {
      location: {
        href: "https://desk.example.com/?tab=wagers&wSport=NCAAB&fast_signin=sdfast_abc123#top",
        pathname: "/",
        search: "?tab=wagers&wSport=NCAAB&fast_signin=sdfast_abc123",
        hash: "#top",
      },
      history: {
        replaceState: (_data: unknown, _unused: string, url: string) => {
          replacedUrl = url
        },
      },
    }

    const extracted = extractAndScrubFastSignInToken(mockWin)
    expect(extracted.hadParam).toBe(true)
    expect(extracted.token).toBe("sdfast_abc123")
    expect(extracted.scrubbedUrl).toBe("/?tab=wagers&wSport=NCAAB#top")
    expect(replacedUrl).toBe("/?tab=wagers&wSport=NCAAB#top")

    // Routine URL state writes must never re-emit fast_signin
    const builtSearch = buildDashboardSearch(
      {
        tab: "wagers",
        matrix: false,
        agent: "",
        wSport: "NCAAB",
        wAlert: "ALL",
        wType: "ALL",
        wChannel: "ALL",
        wSort: "time",
        wDir: "desc",
      },
      "?tab=wagers&wSport=NCAAB&fast_signin=sdfast_leak",
      "/",
    )
    expect(builtSearch).not.toContain("fast_signin")
  })

  test("buildFastSignInBookmarkUrl preserves active route and dashboard params", () => {
    const bookmark = buildFastSignInBookmarkUrl(
      "https://desk.example.com/?tab=wagers&wSport=NBA#live",
      "sdfast_token_value",
    )
    const parsed = new URL(bookmark)
    expect(parsed.origin).toBe("https://desk.example.com")
    expect(parsed.searchParams.get("tab")).toBe("wagers")
    expect(parsed.searchParams.get("wSport")).toBe("NBA")
    expect(parsed.searchParams.get(FAST_SIGNIN_QUERY_PARAM)).toBe("sdfast_token_value")
    expect(parsed.hash).toBe("#live")
  })

  test("resolveFastSignInBookmarkUrl, extractFastSignInTokenFromInput, and client-side SVG QR matrix work offline without external URLs", () => {
    const href = "https://desk.example.com/?tab=alerts"

    // Raw token resolves onto current view
    const fromToken = resolveFastSignInBookmarkUrl(href, "sdfast_raw987")
    expect(fromToken).toBe("https://desk.example.com/?tab=alerts&fast_signin=sdfast_raw987")
    expect(extractFastSignInTokenFromInput("sdfast_raw987")).toBe("sdfast_raw987")

    // Full URL preserves its query param and extracts token cleanly
    const fullUrl = "https://ais-dev.run.app/?tab=wagers&fast_signin=sdfast_mobile123"
    expect(resolveFastSignInBookmarkUrl(href, fullUrl)).toBe(fullUrl)
    expect(extractFastSignInTokenFromInput(fullUrl)).toBe("sdfast_mobile123")

    // Non-HTTP schemes and URLs lacking fast_signin are rejected
    expect(resolveFastSignInBookmarkUrl(href, "javascript:alert(1)//fast_signin=x")).toBeNull()
    expect(resolveFastSignInBookmarkUrl(href, "https://desk.example.com/?tab=alerts")).toBeNull()

    // Pure client-side QR matrix + SVG generation
    expect(buildFastSignInQrMatrix("")).toBeNull()
    const matrix = buildFastSignInQrMatrix(fullUrl)
    expect(matrix).not.toBeNull()
    expect(matrix!.size).toBeGreaterThanOrEqual(21)
    expect(matrix!.pathData.startsWith("M")).toBe(true)

    const svg = buildFastSignInQrSvgMarkup(fullUrl)
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('fill="#070b14"')
    expect(svg).not.toContain("<image")
    expect(svg).not.toContain("https://")
  })

  test("/api/auth/fast-signin is NOT a public route (requires authenticated session)", () => {
    expect(isPublicApiRoute("/api/auth/fast-signin", "GET")).toBe(false)
    expect(isPublicApiRoute("/api/auth/fast-signin", "POST")).toBe(false)
    expect(isPublicApiRoute("/api/auth/fast-signin", "DELETE")).toBe(false)
  })

  test("authenticated operator can mint, redeem repeatedly within TTL, expire, and revoke temporary Fast Sign-In tokens without privilege escalation", async () => {
    let nowMs = Date.parse("2026-11-20T12:00:00.000Z")
    const auth = createHttpAuthController({
      env: {
        NODE_ENV: "production",
        SPORTSDESK_DASHBOARD_TOKEN: "prod-operator-secret",
        SPORTSDESK_ADMIN_TOKEN: "prod-admin-secret",
      },
      now: () => nowMs,
    })

    // Unauthenticated callers cannot mint fast sign-in tokens
    const unauthMint = await auth.auth.fastSignInCreate(
      new Request("http://127.0.0.1:3000/api/auth/fast-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlMinutes: 60 }),
      }),
    )
    expect(unauthMint.status).toBe(401)

    // Operator mints a token (and attempts to request ADMIN role -> must be clamped to OPERATOR)
    const mintRes = await auth.auth.fastSignInCreate(
      new Request("http://127.0.0.1:3000/api/auth/fast-signin", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer prod-operator-secret",
        },
        body: JSON.stringify({
          ttlMinutes: 60,
          role: "ADMIN",
          operatorId: "alice",
        }),
      }),
    )
    expect(mintRes.status).toBe(201)
    const mintJson = (await mintRes.json()) as {
      ok: boolean
      paramName: string
      token: string
      tokenId: string
      operatorId: string
      role: string
      ttlSeconds: number
    }
    expect(mintJson.ok).toBe(true)
    expect(mintJson.paramName).toBe(FAST_SIGNIN_QUERY_PARAM)
    expect(mintJson.token.startsWith(FAST_SIGNIN_TOKEN_PREFIX)).toBe(true)
    expect(mintJson.operatorId).toBe("alice")
    expect(mintJson.role).toBe("OPERATOR")
    expect(mintJson.ttlSeconds).toBe(3600)

    // Redeem the bookmark token via POST /api/auth/login -> establishes real HttpOnly session + CSRF
    const redeemRes = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: mintJson.token }),
      }),
    )
    expect(redeemRes.status).toBe(200)
    const redeemJson = (await redeemRes.json()) as {
      ok: boolean
      authenticated: boolean
      fastSignIn: boolean
      operatorId: string
      role: string
    }
    expect(redeemJson.ok).toBe(true)
    expect(redeemJson.authenticated).toBe(true)
    expect(redeemJson.fastSignIn).toBe(true)
    expect(redeemJson.operatorId).toBe("alice")
    expect(redeemJson.role).toBe("OPERATOR")

    const cookies = redeemRes.headers.getSetCookie()
    const sessionCookie = cookies.find((c) => c.startsWith("sd_session="))
    const csrfCookie = cookies.find((c) => c.startsWith("sd_csrf="))
    expect(sessionCookie).toContain("HttpOnly")
    expect(csrfCookie).toBeDefined()

    // Session established by fast sign-in works for protected API requests
    const sidPair = sessionCookie!.split(";")[0]!
    const denied = await auth.enforceAuth(
      new Request("http://127.0.0.1:3000/api/wagers", {
        headers: { Cookie: sidPair },
      }),
    )
    expect(denied).toBeNull()

    // Saved bookmark remains reusable before TTL expiry
    nowMs += 30 * 60 * 1000
    const secondRedeem = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: mintJson.token }),
      }),
    )
    expect(secondRedeem.status).toBe(200)

    // Listing active tokens never leaks raw token secret
    const listRes = await auth.auth.fastSignInList(
      new Request("http://127.0.0.1:3000/api/auth/fast-signin", {
        headers: { Cookie: sidPair },
      }),
    )
    expect(listRes.status).toBe(200)
    const listText = await listRes.text()
    expect(listText).not.toContain(mintJson.token)
    expect(listText).toContain(mintJson.tokenId)

    // Revoking via DELETE requires CSRF for cookie sessions and invalidates bookmark immediately
    const csrfToken = decodeURIComponent(csrfCookie!.split(";")[0]!.split("=")[1]!)
    const revokeNoCsrf = await auth.auth.fastSignInRevoke(
      new Request("http://127.0.0.1:3000/api/auth/fast-signin", {
        method: "DELETE",
        headers: { Cookie: sidPair },
      }),
    )
    expect(revokeNoCsrf.status).toBe(403)

    const revokeRes = await auth.auth.fastSignInRevoke(
      new Request("http://127.0.0.1:3000/api/auth/fast-signin", {
        method: "DELETE",
        headers: { Cookie: sidPair, "x-csrf-token": csrfToken },
      }),
    )
    expect(revokeRes.status).toBe(200)
    const revokeJson = (await revokeRes.json()) as { revokedCount: number }
    expect(revokeJson.revokedCount).toBe(1)

    const afterRevoke = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: mintJson.token }),
      }),
    )
    expect(afterRevoke.status).toBe(401)
  })

  test("mintFastSignInOnly via /api/auth/login enforces production auth while permitting dev QR minting on dev server", async () => {
    const prodAuth = createHttpAuthController({
      env: {
        NODE_ENV: "production",
        SPORTSDESK_DEV_SERVER: "1",
        SPORTSDESK_DASHBOARD_TOKEN: "prod-operator-secret",
      },
    })

    // Production rejects devQuickLogin + mintFastSignInOnly
    const prodDevAttempt = await prodAuth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          devQuickLogin: true,
          mintFastSignInOnly: true,
          ttlMinutes: 15,
        }),
      }),
    )
    expect(prodDevAttempt.status).toBe(401)

    // Production mints QR token when valid Desk Access Token is supplied (without setting session cookies)
    const prodCredMint = await prodAuth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "prod-operator-secret",
          operatorId: "mobile-op",
          mintFastSignInOnly: true,
          ttlMinutes: 15,
        }),
      }),
    )
    expect(prodCredMint.status).toBe(201)
    expect(prodCredMint.headers.getSetCookie().length).toBe(0)
    const prodMintJson = (await prodCredMint.json()) as {
      ok: boolean
      authenticated: boolean
      mintFastSignInOnly: boolean
      fastToken: string
      operatorId: string
      role: string
      ttlSeconds: number
    }
    expect(prodMintJson.ok).toBe(true)
    expect(prodMintJson.authenticated).toBe(false)
    expect(prodMintJson.mintFastSignInOnly).toBe(true)
    expect(prodMintJson.operatorId).toBe("mobile-op")
    expect(prodMintJson.role).toBe("OPERATOR")
    expect(prodMintJson.ttlSeconds).toBe(900)

    // Redeeming the minted token logs in desktop session
    const desktopLogin = await prodAuth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: prodMintJson.fastToken }),
      }),
    )
    expect(desktopLogin.status).toBe(200)

    // Explicit dev server can mint QR bookmark directly from sign-in modal
    const devAuth = createHttpAuthController({
      env: {
        NODE_ENV: "development",
        SPORTSDESK_DEV_SERVER: "1",
      },
    })
    const devMintRes = await devAuth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          devQuickLogin: true,
          mintFastSignInOnly: true,
          role: "OPERATOR",
          ttlMinutes: 60,
        }),
      }),
    )
    expect(devMintRes.status).toBe(201)
    const devMintJson = (await devMintRes.json()) as {
      ok: boolean
      fastToken: string
    }
    expect(devMintJson.ok).toBe(true)
    expect(devMintJson.fastToken.startsWith(FAST_SIGNIN_TOKEN_PREFIX)).toBe(true)
  })

  test("enforces TTL clamping, expiration, rate limiting, and optional env temporary token", async () => {
    let nowMs = Date.parse("2026-11-20T12:00:00.000Z")
    const auth = createHttpAuthController({
      env: {
        NODE_ENV: "production",
        SPORTSDESK_DASHBOARD_TOKEN: "prod-op",
        SPORTSDESK_FAST_SIGNIN_TOKEN: "env-temp-bookmark-token-256bit",
        SPORTSDESK_FAST_SIGNIN_EXPIRES_AT: "2026-11-20T13:00:00.000Z",
      },
      rateLimitMaxAttempts: 3,
      now: () => nowMs,
    })

    // TTL clamping bounds (min 5m, max 7d)
    const tooShort = auth.mintFastSignInToken({
      operatorId: "op1",
      role: "OPERATOR",
      ttlMs: 1000,
    })
    expect(tooShort.ttlMs).toBe(MIN_FAST_SIGNIN_TTL_MS)

    const tooLong = auth.mintFastSignInToken({
      operatorId: "op1",
      role: "OPERATOR",
      ttlMs: 365 * 24 * 60 * 60 * 1000,
    })
    expect(tooLong.ttlMs).toBe(MAX_FAST_SIGNIN_TTL_MS)

    // Env temporary token works before SPORTSDESK_FAST_SIGNIN_EXPIRES_AT
    const envOk = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: "env-temp-bookmark-token-256bit" }),
      }),
    )
    expect(envOk.status).toBe(200)

    // Advance past expiration for both short minted token and env token
    nowMs = Date.parse("2026-11-20T13:05:00.000Z")

    const expiredMinted = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: tooShort.token }),
      }),
    )
    expect(expiredMinted.status).toBe(401)
    const expiredMintedJson = (await expiredMinted.json()) as { code: string }
    expect(expiredMintedJson.code).toBe("FAST_SIGNIN_EXPIRED")

    const expiredEnv = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: "env-temp-bookmark-token-256bit" }),
      }),
    )
    expect(expiredEnv.status).toBe(401)

    // Rate limiting kicks in after 3 failed fast sign-in attempts
    const thirdFail = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: "sdfast_wrong_token" }),
      }),
    )
    expect(thirdFail.status).toBe(401)

    const rateLimited = await auth.auth.login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fastToken: tooLong.token }),
      }),
    )
    expect(rateLimited.status).toBe(429)
  })
})
