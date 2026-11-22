import assert from "node:assert/strict"
import { readlink } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

const inspectorSchema = z.object({
  account: z.string(),
  text: z.string(),
  historyCount: z.number(),
  metrics: z.record(z.string(), z.string()),
})

const chromiumBrowserSchema = z.enum(["chrome", "edge"])
export type BrowserBackend = "webkit" | z.infer<typeof chromiumBrowserSchema>
const browserNames = { webkit: "WebKit", chrome: "Chrome", edge: "Edge" }
const phaseSchema = z.enum(["login", "logout", "signed-out"])
type BrowserPhase = z.infer<typeof phaseSchema>

/** Verify persistent browser authentication without accessing the user's browser profile. */
export async function verifyBrowserSession(
  appUrl: string,
  token: string,
  profileDirectory: string,
  backend: BrowserBackend,
): Promise<void> {
  assert.equal(Bun.version, "1.4.4", "Browser session verification requires pinned Bun 1.4.4")
  if (backend === "webkit") {
    assert.equal(process.platform, "darwin", "WebKit session verification requires macOS")
    await verifyBrowserPhase(appUrl, token, profileDirectory, backend, "all")
    return
  }
  if (backend === "edge") {
    assert.equal(process.platform, "win32", "Edge session verification requires Windows")
    assert.match(
      process.env.BUN_CHROME_PATH ?? "",
      /[\\/]msedge\.exe$/i,
      "Set BUN_CHROME_PATH to the installed Edge executable",
    )
  }
  // Bun owns one Chromium browser instance per process. Each phase must start a new Bun process
  // only after the preceding browser has flushed its profile and exited.
  for (const phase of phaseSchema.options) {
    const child: Bun.Subprocess<"ignore" | Blob, "inherit", "inherit"> = Bun.spawn(
      [process.execPath, import.meta.path, appUrl, profileDirectory, backend, phase],
      {
        stdin: phase === "login" ? new Blob([token]) : "ignore",
        stdout: "inherit",
        stderr: "inherit",
      },
    )
    const deadline = setTimeout(() => child.kill(), 110_000)
    try {
      assert.equal(await child.exited, 0, `${browserNames[backend]} ${phase} phase failed`)
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
    }
  }
}

async function verifyBrowserPhase(
  appUrl: string,
  token: string,
  profileDirectory: string,
  backend: BrowserBackend,
  phase: BrowserPhase | "all",
): Promise<void> {
  const openView = () =>
    new Bun.WebView({
      backend: backend === "webkit" ? "webkit" : { type: "chrome", url: false },
      dataStore: { directory: profileDirectory },
      width: 1440,
      height: 1000,
    })
  let view = openView()
  async function reopenProfile(url: URL): Promise<void> {
    view.close()
    view = openView()
    await view.navigate(url.href)
  }
  // A stuck native operation must also release the renderer and fail the check.
  const deadline = setTimeout(() => view.close(), 90_000)
  const browserName = browserNames[backend]
  const operatorId = `${backend}-runtime-check`
  const loginForm = 'form:has(input[type="password"][autocomplete="current-password"])'
  async function waitFor(expression: string, description: string): Promise<void> {
    const expiresAt = Date.now() + 15_000
    while (Date.now() < expiresAt) {
      if ((await view.evaluate(expression)) === true) return
      await Bun.sleep(50)
    }
    throw new Error(`Timed out waiting for ${description}`)
  }
  async function reloadDocument(): Promise<void> {
    await view.evaluate("document.documentElement.dataset.runtimeReloadMarker = 'before-reload'")
    await view.reload()
    await waitFor(
      "document.readyState === 'complete' && !document.documentElement.dataset.runtimeReloadMarker && performance.getEntriesByType('navigation')[0]?.type === 'reload'",
      "a completed real document reload",
    )
  }
  const signedOut = `fetch('/api/auth/me', {cache: 'no-store'}).then(async response =>
    response.status === 200 && (await response.json()).authenticated === false)`
  const visibleLogin = `document.querySelector(${JSON.stringify(loginForm)})?.checkVisibility() === true`
  const profileStatus =
    "fetch('/api/profiles/inspect?id=ACCOUNT1', {cache: 'no-store'}).then(r => r.status)"
  async function verifySignedOutProfile(): Promise<void> {
    await waitFor(visibleLogin, "the login form on the protected profile")
    assert.equal(await view.evaluate(signedOut), true)
    assert.equal(await view.evaluate(profileStatus), 401)
    assert.equal(
      await view.evaluate("!!document.querySelector('.detail-panel')?.checkVisibility()"),
      false,
    )
  }
  async function verifyOperator(): Promise<void> {
    // The page must authenticate this request using its own session cookie.
    const result = await view.evaluate(`(async () => {
      const response = await fetch('/api/auth/me', {credentials: 'same-origin', cache: 'no-store'});
      const body = await response.json();
      return {status: response.status, authenticated: body.authenticated, operatorId: body.operatorId};
    })()`)
    z.object({
      status: z.literal(200),
      authenticated: z.literal(true),
      operatorId: z.literal(operatorId),
    }).parse(result)
  }
  async function readInspector(account: string) {
    await waitFor(
      `document.querySelector('.detail-panel')?.checkVisibility() && document.querySelector('.detail-panel h2')?.textContent?.trim() === ${JSON.stringify(account)}`,
      `${account} selected inspector`,
    )
    return inspectorSchema.parse(
      await view.evaluate(`(() => {
        const panel = document.querySelector('.detail-panel');
        const history = panel.querySelector('section[aria-label="Retained wager history"]');
        return {
          account: panel.querySelector('h2').textContent.trim(),
          text: panel.innerText,
          historyCount: panel.querySelectorAll('section[aria-label="Retained wager history"]').length,
          metrics: Object.fromEntries(Array.from(history?.querySelectorAll('dt') ?? []).map(term =>
            [term.textContent.trim(), term.nextElementSibling.textContent.trim()]))
        };
      })()`),
    )
  }
  async function verifyRetainedHistory(): Promise<void> {
    const inspector = await readInspector("ACCOUNT1")
    assert.equal(inspector.account, "ACCOUNT1")
    assert.equal(inspector.historyCount, 1)
    assert.match(inspector.text, /2 eligible non-free-play W\/L wagers/)
    const expected = {
      "Retained eligible stake": "$300.00",
      "Mean / median stake": "$150.00 / $150.00",
      "Observed 95th percentile / maximum stake": "$200.00 / $200.00 (not forecast VaR)",
      "Stake Gini": "0.167",
      "Source-reported net (provisional)": "-$300.00",
      "Provisional ROI on eligible retained stakes": "-100.00%",
      "Source-reported wins / losses": "0 / 2",
    }
    for (const [label, value] of Object.entries(expected))
      assert.equal(inspector.metrics[label], value, label)
    assert.match(inspector.text, /partial history, not lifetime/)
  }
  try {
    const profileUrl = new URL(appUrl)
    profileUrl.searchParams.set("tab", "customers")
    profileUrl.searchParams.set("customer", "ACCOUNT1")
    if (phase === "all" || phase === "login") {
      await view.navigate(appUrl)
      await waitFor(visibleLogin, "login form")
      assert.equal(
        await view.evaluate(signedOut),
        true,
        "A fresh browser profile must start signed out",
      )
      await view.click(`${loginForm} input[type="text"]`, { clickCount: 3 })
      await view.press("Backspace")
      await view.type(operatorId)
      await view.click(`${loginForm} input[type="password"]`)
      try {
        await view.type(token)
      } catch {
        throw new Error("Browser could not fill the login token field")
      }
      await view.click(`${loginForm} button[type="submit"]`)
      await waitFor(
        `document.querySelector(${JSON.stringify(loginForm)}) === null`,
        "authenticated UI",
      )
      await verifyOperator()
      await view.navigate(`${appUrl}/status`)
      await waitFor(
        "document.getElementById('summary')?.textContent === '● serving'",
        "status telemetry under production CSP",
      )
      console.log(
        `PASS: ${browserName} status page runs its same-origin script under production CSP`,
      )
      assert.equal(
        await view.evaluate(
          "fetch('/agent/runtime-browser-check', {credentials: 'omit'}).then(response => response.status)",
        ),
        401,
      )
      assert.equal(
        await view.evaluate(
          "fetch('/agent/runtime-browser-check').then(response => response.status)",
        ),
        200,
      )
      assert.equal(
        await view.evaluate(
          "fetch('/api/customer/profile?id=ACCOUNT1&privateKey=browser-fixture').then(response => response.status)",
        ),
        200,
      )
      const telemetryUrl = new URL(appUrl)
      telemetryUrl.searchParams.set("tab", "surveillance")
      await view.navigate(telemetryUrl.href)
      const telemetryCard = "[data-api-telemetry]"
      const filter = `${telemetryCard} input[type="search"]`
      await waitFor(
        `document.querySelector('${telemetryCard} table')?.checkVisibility() === true`,
        "route telemetry table",
      )
      await view.click(filter)
      await view.type("get /agent/:id")
      await waitFor(
        `(() => {
          const rows = document.querySelectorAll('${telemetryCard} tbody tr');
          return rows.length === 1 && rows[0].cells[1].textContent === '/agent/:id'
            && rows[0].cells[2].textContent === ':id' && rows[0].cells[3].textContent === '—'
            && rows[0].innerText.includes('HTML');
        })()`,
        "filtered agent route with measured HTML response",
      )
      await view.click(`${telemetryCard} button[aria-label="Inspect GET /agent/:id"]`)
      await waitFor(
        `(() => {
          const route = document.querySelector('${telemetryCard} [aria-label="API route details"]');
          return route?.textContent.includes('200 ×') && route.textContent.includes('401 ×')
            && Array.from(route.querySelectorAll('meter')).reduce((total, meter) => total + meter.value, 0) >= 2;
        })()`,
        "the agent route's HTTP status counts and latency distribution",
      )
      await view.click(`${telemetryCard} > details > summary`)
      await waitFor(
        `(() => {
          const output = document.querySelector('${telemetryCard} [data-api-telemetry-inspect]')?.textContent;
          return Boolean(output?.includes('/agent/:id') && !output?.includes('/api/customer/profile'));
        })()`,
        "Bun inspect output scoped to the selected route",
      )
      await view.click(`${telemetryCard} > details > summary`)
      console.log(`PASS: ${browserName} opens a route's measured status and latency distributions`)
      await view.click(filter)
      await view.evaluate(`document.querySelector('${filter}').select()`)
      await view.type("?id")
      await waitFor(`document.querySelector('${filter}')?.value === '?id'`, "query filter input")
      await waitFor(
        `(() => {
          const rows = Array.from(document.querySelectorAll('${telemetryCard} tbody tr'));
          return rows.some(row => row.cells[1].textContent === '/api/customer/profile'
            && row.cells[2].textContent === '—' && row.cells[3].textContent === '?id')
            && rows.every(row => row.cells[3].textContent.includes('?id'));
        })()`,
        "telemetry filtered by the measured query parameter name",
      )
      console.log(`PASS: ${browserName} separates and filters path and query parameter names`)
      await view.navigate(profileUrl.href)
      await verifyRetainedHistory()
      await reloadDocument()
      await verifyOperator()
      await verifyRetainedHistory()
      assert.equal(
        await view.evaluate(`document.querySelector(${JSON.stringify(loginForm)}) === null`),
        true,
      )
      console.log(
        `PASS: native ${browserName} form login survives a real reload with the same cookie-authenticated operator`,
      )
      console.log(
        "PASS: selected ACCOUNT1 retains exact two-loss wager measurements before and after reload",
      )
    }
    if (phase === "all" || phase === "logout") {
      if (phase === "all") await reopenProfile(profileUrl)
      else await view.navigate(profileUrl.href)
      await verifyOperator()
      await verifyRetainedHistory()
      assert.equal(await view.evaluate(profileStatus), 200)
      console.log(
        `PASS: reopening the signed-in ${browserName} profile restores the operator session and measured account`,
      )
      profileUrl.searchParams.set("customer", "IDENTITY_ONLY")
      await view.navigate(profileUrl.href)
      const identity = await readInspector("IDENTITY_ONLY")
      assert.equal(identity.account, "IDENTITY_ONLY")
      assert.match(
        identity.text,
        /No unambiguous retained wager-history match is available for this account\./,
      )
      assert.match(identity.text, /classification are unmeasured/)
      assert.equal(identity.historyCount, 0)
      assert.deepEqual(identity.metrics, {})
      assert.doesNotMatch(identity.text, /\$|NaN|ACCOUNT1|eligible non-free-play W\/L wagers/)
      console.log(
        "PASS: selected IDENTITY_ONLY shows unavailable history without retained measurements",
      )
      assert.equal(await view.evaluate(profileStatus), 200)
      await view.click('[data-operator-menu-trigger="true"]')
      await view.click('[data-operator-logout="true"]')
      await waitFor(visibleLogin, "the login form after operator sign-out")
      await waitFor(signedOut, "the server to confirm browser sign-out")
      await reloadDocument()
      await verifySignedOutProfile()
      console.log(
        `PASS: ${browserName} sign-out returns to the login form after reload and protected profile access changes from 200 to 401`,
      )
    }
    if (phase === "all" || phase === "signed-out") {
      profileUrl.searchParams.set("customer", "IDENTITY_ONLY")
      if (phase === "all") await reopenProfile(profileUrl)
      else await view.navigate(profileUrl.href)
      await verifySignedOutProfile()
      console.log(
        `PASS: reopening the same ${browserName} profile after sign-out shows the login form and protected profile access remains 401`,
      )
    }
    if (backend !== "webkit") await closeChromiumProfile(view, profileDirectory, backend)
  } finally {
    clearTimeout(deadline)
    view.close()
  }
}

async function findBrowserProcess(
  profileDirectory: string,
  backend: "chrome" | "edge",
): Promise<number> {
  if (process.platform === "win32") {
    // Chromium on Windows has no POSIX SingletonLock. Identify the browser for this
    // temporary profile and exclude its renderer and utility subprocesses.
    const executable = backend === "edge" ? "msedge.exe" : "chrome.exe"
    const query = Bun.spawn(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "Name = '${executable}'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:SPORTSDESK_TEST_PROFILE) -and $_.CommandLine -notmatch ' --type=' } | Select-Object -ExpandProperty ProcessId`,
      ],
      {
        env: { ...process.env, SPORTSDESK_TEST_PROFILE: profileDirectory },
        stdout: "pipe",
        stderr: "inherit",
      },
    )
    const output = await new Response(query.stdout).text()
    assert.equal(await query.exited, 0, "Could not query the Windows browser process")
    return z.coerce.number().int().positive().parse(output.trim())
  }
  // Chrome's POSIX singleton link identifies this isolated profile's owning process.
  // Waiting for process exit, rather than a fixed delay, lets Chrome finish writing cookies.
  const singleton = await readlink(join(profileDirectory, "SingletonLock"))
  return z.coerce.number().int().positive().parse(singleton.split("-").at(-1))
}

async function closeChromiumProfile(
  view: Bun.WebView,
  profileDirectory: string,
  backend: "chrome" | "edge",
): Promise<void> {
  const browserProcessId = await findBrowserProcess(profileDirectory, backend)
  await view.cdp("Browser.close")
  const expiresAt = Date.now() + 15_000
  while (Date.now() < expiresAt) {
    try {
      process.kill(browserProcessId, 0)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return
      throw error
    }
    await Bun.sleep(50)
  }
  throw new Error(`${browserNames[backend]} did not finish closing its isolated profile`)
}

if (import.meta.main) {
  assert.equal(Bun.version, "1.4.4", "Browser session verification requires pinned Bun 1.4.4")
  const argumentsSchema = z.tuple([z.url(), z.string().min(1), chromiumBrowserSchema, phaseSchema])
  const [appUrl, profileDirectory, backend, phase] = argumentsSchema.parse(Bun.argv.slice(2))
  const token = phase === "login" ? await Bun.stdin.text() : ""
  if (phase === "login") assert.ok(token, "The login phase requires a fixture token on stdin")
  await verifyBrowserPhase(appUrl, token, profileDirectory, backend, phase)
}
