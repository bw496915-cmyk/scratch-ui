# Local SportsDesk development

This checkout belongs to `bw496915-cmyk/Local-Sportsdesk-ops`. Its `dev` branch
tracks `origin/dev`. The full collector/daemon checkout is separately located at
`/Users/nolarose/code/sportsdesk-ops`; it has its own instructions and dirty files.

## Bun 1.4.4

`.bun-version`, `packageManager`, and `engines.bun` specify Bun 1.4.4.
Verify `command -v bun` and `bun --version` before installing.

```sh
bun install --frozen-lockfile
bun run hooks:install
bun run format
bun run format:check
bun run format:debug
bun run lint
bun run build
bun run check:runtime
bun run check:ci
```

Formatting uses the existing `[fmt]` settings in `bunfig.toml` (100 columns,
no semicolons). `format` writes files; `format:check` is read-only. Imported
files may have pre-existing formatting differences; do not sweep them into an
unrelated change. Check a bounded change with `bun fmt --check --changed=HEAD`.

`hooks:install` configures this checkout's local `core.hooksPath` to the tracked
`.githooks` directory. Run it after cloning; dependency installation does not
install hooks because lifecycle scripts are disabled. The pre-commit hook
requires the pinned Bun version, formats staged files, and re-stages them with
`bun fmt --staged`.

The repository baseline is formatted with Bun 1.4.4. `format:debug` checks parsed
meaning without writing files. CI runs both formatting checks on pushes to
`main` and `dev` and on pull requests; `check:ci` includes the same checks locally.

Verified on November 19, 2026 with Bun 1.4.4: all 226 supported files pass
formatting and semantic debug checks, including a debug check of the original
unformatted snapshot. A disposable Git commit confirmed the hook reformats and
re-stages an unformatted file. Offline frozen installation, dependency pruning,
dependency audit, TypeScript, production build, all 36 tests, route-surface and
bundle-hygiene checks passed. Both tracked lockfiles remain unchanged. The
route-surface checker accepts the configured semicolon-free style while still
rejecting false and identifier returns in the production authentication guard.

[Bun 1.4.4 release notes](https://bun.com/blog/bun-v1.4.4) describe native
`bun fmt`, `bun pm fetch`, cache packing, and recursive publication. The existing
CI keeps its frozen/offline install and lockfile checks. Bun's shared install
cache is separate from a package registry.

## Local package registry

The registry uses pinned Verdaccio 6.11.2 with Node 22 or newer and Bun for
dependency installation. Its separate manifest and lockfile keep registry tooling
out of the dashboard's production dependencies.

```sh
bun run registry:install
bun run registry:start
# In another terminal:
bun run registry:check
```

It listens only on `127.0.0.1:4873`. Storage and authentication state go under
gitignored `.local/registry/`. Stop the foreground server with Ctrl-C. No login
or startup service is installed.

Only `@sportsdesk-local/*` can be published anonymously. Other package names
are read-only proxies to npm. The local namespace never proxies to npm.
Do not expose this development configuration to a network.

The project-root `.npmrc` routes only `@sportsdesk-local` to this registry; ordinary
dependencies keep their existing registry. Existing workspaces remain private.
To publish a disposable development package, give it a unique version and this
configuration in its own `package.json`:

```json
{
  "name": "@sportsdesk-local/example",
  "version": "0.1.0-dev.1",
  "publishConfig": {
    "tag": "dev"
  }
}
```

```sh
bun publish --dry-run
bun publish
```

Bun requires a token even for anonymous publishing. The project-root `.npmrc`
supplies a non-secret placeholder. For an independent disposable publisher,
create a `.npmrc` next to its root `package.json` containing:

```ini
@sportsdesk-local:registry=http://127.0.0.1:4873/
//127.0.0.1:4873/:_authToken=local-development
```

This placeholder grants no authentication; the loopback registry's package
policy allows publication. Never put a real npm or production token here.

`bunfig.toml` contains no registry or scope overrides. It retains formatting,
install-script, shared-store, and release-age settings. Bun reads the user
`.npmrc` first and the project-root `.npmrc` second; Bun configuration,
environment variables, and command-line overrides can take precedence.
`NPM_CONFIG_USERCONFIG` selects the user file, not the project file.
See [which files Bun reads](https://bun.com/docs/pm/npmrc#which-files-are-read).

Verified on Bun 1.4.4 on November 19, 2026: an uncached `bun info` from this
checkout resolved a newly published `@sportsdesk-local/npmrc-verification`
version even with `NPM_CONFIG_USERCONFIG` pointing to a temporary user file
whose scope registry was the unreachable `http://127.0.0.1:1/`. An uncached
lookup of `react@19.3.1` still succeeded through the default registry. Independent
publisher/consumer projects with copies of this root `.npmrc` and `bunfig.toml`
completed publish/install/import without registry flags. The consumer used only
an exact release-age exclusion for that newly published verification version.
Both tracked lockfiles remained unchanged.

For HTTP loopback publishing, omit `publishConfig.registry` and let the scope
in `.npmrc` select the registry. Bun 1.4.4 does not attach `.npmrc` credentials
to an HTTP `publishConfig.registry` override; this was the cause of the earlier
authentication failure. Keep the root application and existing workspaces
private; publish a disposable package from its own project directory.

An independent consumer must also configure the scope. When resolving a newly
published local version, the existing three-day release quarantine can apply.
Use an exact `package@version` release-age exclusion in that disposable
consumer's configuration; do not disable the application's quarantine.

References: [Bun registries](https://bun.com/docs/pm/scopes-registries),
[Verdaccio installation](https://verdaccio.org/docs/installation/),
[Verdaccio configuration](https://verdaccio.org/docs/configuration/).

## Connectivity investigation — November 19, 2026

### Companion daemon and collector configuration

`bun run build && bun run check:runtime` starts the built production server
with authentication enforced and controlled loopback-only daemon/R2 services.
It supplies no live credentials. It verifies a healthy connection, failed capture
despite fresh publication, missing collector receipts, anonymous access denial,
and `/api/status` reachability. It saves a non-secret result summary in
`.local/runtime-verification.json`, then stops the test services. Hosted CI runs
this proof after its production build. This verifies the integration contract;
it does not verify vendor authentication, deployed connectivity, or real capture
freshness. Live end-to-end verification remains a separate acceptance step.

After `bun run build`, run `bun run check:runtime --chrome` with Google Chrome
installed, `bun run check:runtime --webkit` on macOS, or
`bun run check:runtime --edge` on Windows with `BUN_CHROME_PATH` set to the
installed `msedge.exe`. Hosted CI runs Chrome on Ubuntu, WebKit on macOS, and
Edge on Windows. Each check signs in
with a temporary operator token and verifies the measured account after a reload
and after reopening the same temporary profile directory. They also verify the
identity-only account and sign out through the dashboard. Reopening the signed-out
profile must show the login form and receive HTTP 401 on the protected profile API.
Chrome and Edge launch a new browser process for each reopen. The HTTP fixture client
also retries its previously successful request with the original cookie after logout.

`R2_PUBLIC_URL` selects the server's R2 public base. `SPORTSDESK_BIND_HOST`
defaults to `0.0.0.0` for hosting; the isolated verification binds `127.0.0.1`.

On Bun, the server redacts its global S3 client's inspection and JSON output
at startup. An administrator can check the explicit client at
`GET /api/r2/client/inspect?colors=false`. Configure it with `R2_ENDPOINT`,
`R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Supply
`R2_SESSION_TOKEN` for temporary credentials. The diagnostic shows the bucket
and endpoint host when configured. Its signing check runs offline, and the
pipeline continues to probe `R2_PUBLIC_URL`.

To verify private object access, set `R2_HEALTHCHECK_KEY` to an existing object
that the configured credentials can read. Request
`GET /api/r2/client/inspect?s3Check=1` as an administrator. The inspector
performs a signed HEAD request with a five-second timeout and reuses the result
for 30 seconds. It reports status, timing, and size when the service supplies
it. The object key and signed URL stay server-side. Without the query flag,
the report shows the last result if one exists. Inspect `source`, `freshness`,
and `ageMs` to tell when a result came from the cache and whether it is stale.
Cached checks also require the admin inspection scope.

Inspection outside the authenticated admin route redacts the endpoint host.
The route establishes an admin inspection scope after the existing
authentication checks. The R2 handle requires that scope to open a file or
run a probe. Use `colors=true` for TrueColor output. Setting `NO_COLOR`,
even to an empty value, suppresses requested colors unless `FORCE_COLOR`
is present with a value other than `0`. Both formats strip terminal controls from Markdown content and
omit signed S3 link destinations. Custom ANSI palette entries accept only
24-bit foreground colors.
The inspector reports the six native Bun DNS cache counters under
`runtimePreflight.dnsCache` at startup and under `runtimeDnsCache` when the
report is requested. Reading the counters does not start a DNS lookup.
`runtimePreflight.dnsErrorRatioBps` uses the startup sample. A startup
`totalCount` of zero means the runtime had observed no requests at that point.
Bun startup rejects an error ratio above 500 basis points (5%), mixed
Cloudflare API and R2 credentials, and implicit AWS or S3 credentials.
Set `SPORTSDESK_ALLOW_AWS_FALLBACK_ENV=1` only when those ambient credentials
are intentionally present. The offline signing check still verifies the
explicit R2 client's selected credentials.

The dashboard requires an explicit `SPORTSDESK_API_ORIGIN` for a companion
connection. With no value, the status is `unconfigured` and no loopback probe is
sent. For a dashboard and daemon on this computer, set
`SPORTSDESK_API_ORIGIN=http://127.0.0.1:4020` in the server environment. A hosted
dashboard needs the daemon's server-reachable private HTTP(S) base URL instead.
Origins with embedded credentials, query strings, or fragments are rejected.
The probe reports the daemon's own health, distinguishing unreachable transport
from reachable HTTP 503/auth-down. `/api/status` uses that same measured probe.

Mount a real collector cycle receipt and set `SPORTSDESK_BRIDGE_STATE_PATH` to
its server-side path. The fallback path is `scratch/bridge-rollup-state.json`.
The reader validates `updatedAt` and every job's `id`, `label`, `ok`,
`durationMs`, and optional `error`. It preserves the recorded cycle time and
failures; it does not infer that schedules run in the Node dashboard. Missing,
invalid, or future-dated receipts show unavailable execution evidence.
Ticket verification is also unavailable until implemented by this host.

R2 `freshCount` now requires a recent publication and a measured capture/data
window no older than 24 hours. `publishFreshCount` separately reports publication
freshness. A generation timestamp alone cannot establish data freshness.
Missing data timestamps or measured collector failures degrade the overall
pipeline status. Stale captures remain stale even after successful publication.
No deployment or upstream authentication change is included in this commit.

Local verification of the explicit origin `http://127.0.0.1:4020` on November 19
returned HTTP 200 with measured `degraded` health and `online: true`; the daemon
is reachable on this computer. This does not establish reachability from the
AI Studio container. The receipt reader was also exercised against the full
checkout's real bridge state file, preserving failed jobs rather than replacing
them with dashboard fixture success.

### Original evidence

Before this correction, the AI Studio Node/Vite server defaulted `SPORTSDESK_API_ORIGIN` to
`http://127.0.0.1:4020` in `server.ts`. In hosted AI Studio, loopback identifies
the hosting environment, not the operator's Mac. The local Mac has listeners on
both 4020 and 4022. A hosted daemon probe cannot reach those Mac listeners by
using its own loopback address. The deployed environment override has not been
inspected, so its exact effective origin remains unverified.

The original hosted automation display was misleading: `buildNodeAutomationsSnapshot`
in `server/adapters.ts` manufactured successful bridge jobs with fixed durations
(42/38/51 ms) and current timestamps. Those entries are not collector receipts.

The actual collector journal in the separate full checkout,
`Scratch/bridge-rollup-cron.jsonl`, records these failures through the
2026-11-19 23:45 UTC cycle:

- `bridge3c` and `wagers-by-state`: GSLive expired; the dual-auth prerequisite
  blocks capture before spawning the job.
- `wagers-publish`: succeeds despite the capture failure, explaining the fresh
  pointer over an old data window.
- `bridge3b`: fails with `rotation out of 20-bit range: 11291201`.
- `weblog`: fails in `R2S3Client.fromEnvOrSecrets()` at
  `scripts/f402_weblog_bridge.ts:446`. The persisted error contains only the
  final stack frame; it does not establish the underlying credential error.
- F402 session-refresh stderr separately reports an invalid service-account
  token format on November 17. Session-watch stderr reports missing Telegram
  bot token/chat configuration, preventing its alerts from being delivered.

These are local collector receipts, not logs from the AI Studio container.
No credentials have been copied or refreshed and no collectors or deployments
have been restarted. Fixes should keep failed capture distinct from successful
publication and replace synthetic automation success with measured status.

## Dashboard asset and telemetry verification

After `bun run build`, start the built dashboard on Bun with
`DOTENV_CONFIG_PATH=.local/local-runtime.env bun --no-env-file run start:local`.
The Telemetry tab reads `/api/telemetry` every 15 seconds while it is visible.
Each server process keeps up to 15 minutes of request counts and latency
histograms in memory. The p95 column displays the upper bound of its latency
bucket. Both telemetry reads require dashboard authentication and exclude
their own traffic. Dynamic paths appear as route templates and unmatched
paths share a single label.
The latest sample for each method and route includes the response ETag and
media type when present, a response type derived from the media type and HTTP
status, and path and recognized query parameter names. Parameter values are
never recorded.
The Body column compares declared request bytes with response payload bytes
observed by the server. Stream distinguishes a one-shot response, incremental
writes, and an empty response. Protocol shows the connection scheme and HTTP
version seen by the dashboard, plus the TLS version when the server exposes it.
Request Cookies lists the dashboard cookie names supplied on the latest request.
Bun reads the names using `CookieMap.keys()` and the meter keeps only
`sd_session` and `sd_csrf`.
Response Cookies reports these same dashboard cookie names when the server
issues or expires them, with `Secure`, `HttpOnly`, `SameSite`, and
`Max-Age` attributes. Telemetry discards cookie values.

Open **Bun inspect output** to change depth, row limit, width, color, and sort
order. The same settings work through
`/api/telemetry/inspect?depth=1&maxArrayLength=10&breakLength=96&showOptions=true`.
Bun serves both reads through `Bun.serve` on the authenticated dashboard path.
The Bun host uses native Fetch with `proxy: false` for that private loopback request.
The existing agent API aliases `/api/agent/:id` and `/api/agents/:id` also use
native routing under Bun. Express authorizes the request before the private
handler reads the typed `BunRequest.params.id`. The Node path uses the same
agent data service and decodes the ID once.
`bun run check:runtime --bun-server --webkit` exercises this path on macOS.
See [Bun routing](https://bun.com/docs/runtime/http/routing) and
[Bun custom inspection](https://bun.com/docs/runtime/utils#bun-inspect-custom).

`bun run check:runtime --webkit` now verifies that every file under `public/`
and `src/assets/` is served byte-for-byte by the production server, that the
operator-authenticated WebSocket answers a heartbeat, and that `/graph` and
`/status` redirect to their owning documents after authentication. The status
page uses `/static/status.js` so its measured daemon status renders under the
production `script-src 'self'` policy. The graph retains its static feed fallback;
daemon-only SSE, signals, and execution routes are not implemented by this host.

Telemetry reads Bun's native DNS cache and benchmarks c-ares, system, and
getaddrinfo when running on Bun. On Node it reads the dashboard's application
cache and benchmarks cached and system lookups. `SPORTSDESK_DNS_PREFETCH=1`
warms the R2 public and configured companion hostnames on Bun at startup.
To override the Bun cache TTL, set
`BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS` in the environment before launching Bun.
The panel displays the runtime's default TTL.

Image preview and transform paths resolve symlinks and require a regular file
within an allowed asset root.

Cloudflare assets remain at their owning locations: branding/operator files in
`public/assets`, imported images in `src/assets`, and authenticated graph
resources in `docs/assets`. The R2 pipeline reads its configured public base
server-side; a bucket CORS policy is not required for those server requests.
Do not copy operational graph data into `public/` to resolve an asset URL.

## Local dashboard sign-in

Open `https://127.0.0.1:3000` with the local TLS configuration below. For
loopback development without TLS, use `http://127.0.0.1:3000`.
Use your desk name as the operator ID. `SPORTSDESK_DASHBOARD_TOKEN` or
`SPORTSDESK_OPERATOR_PASSWORD` grants operator access. The distinct
`SPORTSDESK_ADMIN_TOKEN` grants admin access at sign-in, including the desk
terminal, image transforms, and weblog reset. The operator ID is a display and
audit label. The configured credential determines the role. Scripted callers
keep using Bearer authentication and the separate `x-admin-token` header for
privileged requests.

Set `SPORTSDESK_SESSION_DB_PATH=.local/dashboard-sessions.sqlite` in the server
environment to retain sessions and their profile themes across server restarts
(Bun 1.4.4 or Node 22.13 and newer).
Use the same dashboard URL on each visit. A session lasts eight hours from
sign-in. Sign-out revokes the session and its open WebSocket connections.
Changing the corresponding login credential invalidates sessions issued with it.
The private database contains hashed session identifiers and role records.
The browser holds the HttpOnly session cookie. Dashboard authentication is
separate from R2 reports and the collector's upstream credentials.

On Bun, sign-in issues a [`Bun.CSRF` token](https://bun.com/docs/runtime/csrf)
bound to the authenticated session ID and its lifetime. Set `CSRF_SECRET`
to supply the server-owned signing secret explicitly. With persistent
SQLite sessions, the local server can generate and store a signing key in the
same private database, so verification works across restarts. Protected
writes and sign-out verify `x-csrf-token` with Bun. Earlier tokens and the
Node entry point use the token recorded in the authenticated session.

The existing `POST /api/profile/theme` saves the validated theme in that
SQLite file under the digest of the authenticated session cookie. The same
session can read the theme through `GET /api/profile` and apply it in
`GET /api/profile/render.md`. Signing out removes the saved theme with the
session. Under Bun, profile reads and theme saves use the native route's
[`BunRequest.cookies`](https://bun.com/docs/runtime/http/cookies#reading-cookies)
on the protected loopback hop. Theme saves check the origin and verify the
session-bound CSRF token before updating SQLite.
Use `SPORTSDESK_ALLOWED_ORIGINS` for an external origin served through a
reverse proxy.
Bun also uses `CookieMap` to expire the browser cookies on sign-out.
Bun uses [`bun:sqlite`](https://bun.com/docs/runtime/sqlite#query)
and the Node entry point uses `node:sqlite` against the same schema.

### Bun cookie examples

The sign-in handler builds one cookie for the SQLite session and one for CSRF.
The HTTPS example below uses placeholders. The running controller generates its
own session ID and token.

```ts
const preference = new Bun.Cookie("theme", "dark", {
  path: "/",
  sameSite: "lax",
  secure: true,
})

const session = new Bun.Cookie({
  name: "sd_session",
  value: "example-session",
  path: "/",
  maxAge: 8 * 60 * 60,
  sameSite: "lax",
  secure: true,
  httpOnly: true,
})

const parsed = new Bun.Cookie(session.serialize())
console.log({ name: parsed.name, secure: parsed.secure, httpOnly: parsed.httpOnly })
```

See the [Bun Cookie constructor reference](https://bun.sh/reference/bun/Cookie/constructor).

If the credentials are already in `.local/local-runtime.env`, copy the desired
one directly to the macOS clipboard from the repository directory and paste it
into the sign-in form. For admin access, replace `SPORTSDESK_DASHBOARD_TOKEN`
with `SPORTSDESK_ADMIN_TOKEN` in the command:

```sh
node --input-type=module -e 'import {parse} from "dotenv"; import {readFileSync} from "node:fs"; process.stdout.write(parse(readFileSync(".local/local-runtime.env")).SPORTSDESK_DASHBOARD_TOKEN ?? "")' | pbcopy
```

## Local HTTPS and WebSockets

Keep `SPORTSDESK_BIND_HOST=127.0.0.1`. Generate a certificate with
[mkcert](https://github.com/FiloSottile/mkcert), trust its development CA in
macOS Keychain, and configure the server with both paths:

```dotenv
SPORTSDESK_TLS_CERT_PATH=.local/tls/dashboard.pem
SPORTSDESK_TLS_KEY_PATH=.local/tls/dashboard-key.pem
```

This checkout uses a certificate for `127.0.0.1` and `localhost`, with the CA
trusted for SSL in the macOS login keychain. The certificate and private keys
live under `.local/tls/`. Use `127.0.0.1` consistently because browser cookies
are scoped to the hostname. Start the built server from the repository root:

```sh
bun run build
DOTENV_CONFIG_PATH=.local/local-runtime.env bun --no-env-file run start:local
```

With both paths set, Bun negotiates HTTP/2 or HTTP/1.1 through ALPN on the
same port. WebSocket upgrades use HTTP/1.1 at `wss://127.0.0.1:3000/ws`.
The Node entry point continues to serve HTTPS and WSS over HTTP/1.1.
If only one TLS path is set, startup fails. Omitting both starts the
regular HTTP listener.

Bun serves the fixed status assets from memory and streams contained files
under `/static` and `/docs` with byte ranges. The native docs route validates
the existing Secure session cookie against the session store and reissues it
with the remaining session lifetime. API telemetry reports HTTPS for requests
that pass through Bun's loopback bridge. The HTTP and TLS versions are
unavailable to that telemetry on the pinned runtime.

Open [the document preview](https://127.0.0.1:3000/docs/live-customer-sources/ansi)
after signing in. The preview links admins to Terminal profiles and operators to
Customer profiles. Use **Download ANSI** for the file rendered with your saved
terminal theme. Terminal clients can fetch the same URL with `Accept: text/plain`.
Bun renders with [`Bun.markdown.ansi`](https://bun.sh/reference/bun/markdown/ansi)
and local image loading is disabled.

Repeat the protocol, asset, session, and WebSocket checks against an isolated
dashboard using the trusted local certificate:

```sh
NODE_EXTRA_CA_CERTS=.local/tls/ca/rootCA.pem \
  bun --env-file=.local/local-runtime.env run check:runtime --bun-server --tls --webkit
```

## Profile Radar sources

Open **Profiles → Profiles Output → ProfileRadarView** or run
`profile <CUSTOMER_ID> --radar --no-color` in the admin terminal. The radar
reads the aggregate configured by `SPORTSDESK_CUSTOMER_HISTORY_JSON` and the
private date-named Mode A JSONL directory configured by
`SPORTSDESK_PROFILE_WEBLOG_DIR`. It joins activity only through a unique exact
roster login. The access section shows counts and the provider's wall times.
The wager section reports eligible retained results with excluded and
conflicting counts. Both are limited to their retained source coverage.
`--wagers` adds the current ticker snapshot separately. System Logs reads the
same retained access capture and shows parsed operation labels and redacted
addresses. Clearing operator imports preserves the retained capture. Set
`SPORTSDESK_WEBLOG_BATCH_DIR` to include a separate private directory of
date-named Mode A captures. System Logs and Profile Radar deduplicate the
two directories together.

System Logs loads 100 rows per page. The Kind filter shows counts for
recognized operation families. The rows use the specific provider action
when it is recognized, such as viewing pending wagers, displaying parlay
lines, or changing a spread price. Unrecognized operation text stays private.
Source times retain milliseconds from `AccessDateTime`. The provider
capture omits a timezone offset. Cadence measures elapsed source time
between retained rows in the same IP and login group.

The dashboard displays IPv4 as a redacted /24 and
IPv6 as a redacted /48. The bot-block key supplies game ID, period, market,
pick and sequence when those fields appear in the source. Team-selection
messages supply their own game ID and selected team. API bet descriptions
can supply a listed number, period and pick. The listed number stays separate
from the game ID. API ticket references are searchable and appear in row
details. A blocked request
does not establish an accepted wager. The Severity key explains the score
assigned by the dashboard to the IP and login group. The provider marker
`Login successful Token` establishes a token-based login, with refresh
status unverified.

Open **System Logs → Action dictionary** for provider markers, their meanings,
and their counts. A suffix such as `[v1.0.288 | betolive.ag]` supplies logged
version and site values. `(M)` and `(D)` are source codes. Neither the tags
nor the `API LOG` prefix establishes where the action executed. The site and
version panel counts messages in each operation family. Select a group to
filter rows or use `weblogs --site=betolive.ag --version=v1.0.288 --depth=3`.

Open **Parlay comparison** in System Logs to compare account composition by
source date. The ticker view reads up to 16 MiB from the private JSONL archive
configured by `SPORTSDESK_PARLAY_TICKER_JSONL` when requested. It excludes
sentinel notices and conflicting identities and preserves agent, customer, and
login scope. The weblog view counts retained parlay descriptions separately.
Expand an API parlay description for its parsed legs and recorded prices, or
run `weblogs --kind=API_PARLAY_DESCRIPTION --depth=3 --max-array=6`.

Run `weblogs --kind=TEAM_CHOSEN --depth=3 --max-array=6 --break-length=76 --options`
for a narrow event report, or use `--json` to inspect parsed rows. System Logs
offers the same presentation controls and a Parsed JSON view. Parsed rows
contain redacted network metadata. The private Mode A JSONL files contain
the original retained provider fields.

Bun 1.4.4 forwards only depth, colors and its styling function to
`Bun.inspect.custom`. The dashboard passes the complete option set through
`inspectDeskValue`. For direct `Bun.inspect` calls, pass view defaults as
`inspectOptions` in the `WebLogView` or `WebLogVectorView` metadata.

## Shadow Pricing sources

Set `SPORTSDESK_SOURCE_ROOT` to the local SportsDesk companion checkout and
`SHADOW_PRICE_DB` to its retained SQLite snapshot. The dashboard runs the
companion's pricing engine in a Bun worker with read-only database access.
The panel reports the database filename and labels counterfactual calculations
as simulations. An unavailable database returns a source error.
