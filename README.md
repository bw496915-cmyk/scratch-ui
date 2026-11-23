# SportsDesk Ops Dashboard

Real-time sportsbook operations dashboard, sharp-bettor surveillance, downline agent hierarchy, Cloudflare R2 pipeline telemetry, WebLogs & Profile Radar forensics, and **Bun 1.4.4** runtime surface inspector.

## Pinned Runtime & Quick Start

`.bun-version`, `packageManager`, and `engines.bun` pin **Bun 1.4.4**. All CLI commands, artifact generators, formatting, tests, and integrity gates are unified under the Bun CLI (`bun run cli`).

```sh
# Verify pinned Bun version and install locked dependencies
bun --version
bun install --frozen-lockfile

# Unified Bun CLI help & command catalog
bun run cli help

# Start the development server (Express + Vite on :3000)
bun run dev

# Build production SPA + server bundle (dist/ + server.mjs)
bun run build

# Run the built production server locally under Bun (no implicit .env bleed)
DOTENV_CONFIG_PATH=.local/local-runtime.env bun --no-env-file run start:local
```

## Unified Bun CLI (`bun run cli`)

The repository entrypoint is [`scripts/sportsdesk_cli.ts`](scripts/sportsdesk_cli.ts), backed by the deterministic artifact generator [`scripts/gen_artifacts.ts`](scripts/gen_artifacts.ts) and startup `--env-file` preflight guard [`src/cli/preflight_guard.ts`](src/cli/preflight_guard.ts).

| Command                                  | Purpose                                            | GFM / ANSI Options                                |
| :--------------------------------------- | :------------------------------------------------- | :------------------------------------------------ |
| `bun run cli help`                       | Command catalog & pinned Bun runtime               | `--md`, `--ansi`, `--profile <name>`              |
| `bun run cli docs list`                  | Tracked docs with `SD-DOC-*` meta IDs & SHA-256    | `--ids`, `--json`, `--md`, `--ansi`               |
| `bun run cli docs ids [file\|metaId]`    | List GFM heading anchor meta IDs (`#id`)           | `--json`, `--md`, `--ansi`, `--profile`           |
| `bun run cli docs render <file\|metaId>` | Terminal/HTML rendering via `Bun.markdown`         | `--mode render\|ansi\|html`, `--profile`, `--ids` |
| `bun run cli artifacts status\|check`    | Generated token/diagram/docs drift & hashes        | `--md`, `--ansi`, `--tokens-only`                 |
| `bun run cli version status\|check`      | Unified `Bun.semver` matrix & workspace bump       | `--json`, `--md`, `--ansi`                        |
| `bun run cli surface [--kinds\|--deep]`  | Live read-only `Bun.*` & `bun:*` surface audit     | `--json`                                          |
| `bun run cli check [gate\|all]`          | Integrity gates (versions, lockfile, parity, docs) | `versions`, `artifacts`, `docs`                   |

```sh
# Regenerate all managed artifacts (design tokens + manifest + CLI/artifact docs)
bun run cli artifacts generate

# List tracked docs with canonical SD-DOC-* meta IDs and GFM heading counts
bun run cli docs list --ids --ansi --profile ghostty_interactive

# List extracted GFM heading meta IDs (#id) for design/README.md or its SD-DOC-* ID
bun run cli docs ids SD-DOC-DESIGN-TOKENS --ansi

# Render any Markdown file or SD-DOC-* ID via Bun.markdown.ansi(AnsiTheme) + listed IDs
bun run cli docs render dashboard.md --mode ansi --profile tty_narrow --ids
bun run cli docs render SD-DOC-DESIGN-TOKENS --mode render --preset obsidian-desk --columns 88

# Audit all Markdown files for broken local links and stale references
bun run cli docs check

# Live read-only Bun Runtime Surface audit (Bun.* kinds, bun:* modules, classes)
bun run cli surface --kinds
bun run cli surface --deep

# Run repository verification gates under Bun
bun run cli check all
bun run cli scripts --ansi --profile tty_narrow
```

For the full generated artifact inventory, checksums, and script matrix, see the auto-generated reference [`docs/generated/ARTIFACTS_AND_CLI.md`](docs/generated/ARTIFACTS_AND_CLI.md) and machine-readable [`docs/generated/artifacts-manifest.json`](docs/generated/artifacts-manifest.json).

## Workspace Architecture

```text
├── server.ts                          # Express + Vite dev / Node & Bun production entrypoint (:3000)
├── packages/
│   ├── contracts/                     # Shared TypeScript contracts & Bun runtime surface catalog
│   ├── api/                           # HTTP API router, Config/Status store & Bun surface loader
│   ├── backend/                       # Parsers, cohort aggregators, Bun.markdown renderer
│   └── ui/                            # React 19 dashboard UI, panels & generated token registry
├── server/                            # Adapters, telemetry, R2/DNS/profile/weblog inspectors
├── src/                               # CLI preflight guard, ANSI/Markdown themes, Houdini CSS tokens
├── design/                            # design/tokens.toml SSOT & branded domain types
├── schema/                            # Field contracts, DOD6 v5.4 schema & telemetry matrix
├── static/                            # Token-compiled static HTML surfaces & /status script
├── docs/                              # Pipeline diagrams, live customer sources & generated artifacts
├── scripts/                           # Unified Bun CLI, artifact generator & CI integrity gates
└── tests/                             # bun:test unit, security, snapshot & SSR suites
```

## Design Tokens & Generated Artifacts (Zero-Drift SSOT)

[`design/tokens.toml`](design/tokens.toml) (`v1.5.0`) is the single source of truth for dashboard surfaces, SLA states, ingestion channels, risk routes, `:root` aliases, and deterministic `[cli.markdown_ansi.*]` `Bun.markdown.AnsiTheme` terminal profiles.

- `bun run gen:tokens` compiles `design/tokens.toml` into:
  - [`packages/ui/src/tokens.registry.generated.ts`](packages/ui/src/tokens.registry.generated.ts)
  - [`src/dashboard/tokens.generated.css`](src/dashboard/tokens.generated.css)
- `bun run gen:tokens:gate` verifies zero drift against `design/tokens.toml`.
- `bun run artifacts:generate` compiles tokens, verifies all 12 vector/raster hashes in [`docs/assets/pipeline-artifacts-metadata.json`](docs/assets/pipeline-artifacts-metadata.json), audits all Markdown files (extracting `SD-DOC-*` & GFM heading meta IDs), and emits [`docs/generated/artifacts-manifest.json`](docs/generated/artifacts-manifest.json) and [`docs/generated/ARTIFACTS_AND_CLI.md`](docs/generated/ARTIFACTS_AND_CLI.md).
- `bun run artifacts:check` fails closed on any generated file drift, pipeline asset mismatch, or broken documentation link.

See [`design/README.md`](design/README.md) for token, alias, and `AnsiTheme` profile rules.

## Security & Runtime Hardening

- **No Implicit `.env` Bleed**: [`bunfig.toml`](bunfig.toml) sets `env = false`, `[install].ignoreScripts = true`, and `minimumReleaseAge = "3d"`. CLI entrypoints call `assertSafeExecArgv()` from [`src/cli/preflight_guard.ts`](src/cli/preflight_guard.ts) to block unallowlisted `--env-file` flags.
- **Read-Only Runtime Surface Introspection**: The **Status & Config → Bun Runtime Surface** panel and `bun run cli surface` classify `Bun.*` exports (`class`, `namespace`, `function`, `constant`, `object`) and inspect `bun:*` built-in modules (`bun:sqlite`, `bun:ffi`, `bun:jsc`, `bun:test`, `bun:bundle`) while strictly redacting `Bun.env` and `Bun.secrets`.
- **Safe Markdown & ANSI Rendering**: `Bun.markdown.render()` (with `{ headings: { ids: true }, tables: true, tasklists: true }`) and `Bun.markdown.ansi(md, AnsiTheme)` strip terminal control sequences, align Unicode/ASCII GFM tables, tint `[REDACTED*]` tokens, and block `javascript:`, `data:`, and signed S3 URLs from OSC-8 hyperlinks.
- **Session, CSRF & Origin Guards**: Protected APIs enforce operator/admin tokens or SQLite-backed `HttpOnly` session cookies, `Bun.CSRF` tokens on mutations, strict `SPORTSDESK_ALLOWED_ORIGINS` validation, and zero raw shell execution (verified by `bun run check:shell-boundary`).

## Verification & Quality Gates

```sh
# Format & semantic check (Bun 1.4.4 native formatter)
bun run format:check
bun run format:debug

# TypeScript typecheck across root, runtime scripts, and UI workspace
bun run lint

# Full test suite
bun test

# Composite local CI gate
bun run check:ci

# Isolated production runtime verification (HTTP + auth + R2 + optional browser session)
bun run build && bun run check:runtime
```

## Documentation Index

| Doc Meta ID               | Document                                                                     | Primary Role & Render Shortcut                                                             |
| :------------------------ | :--------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| `SD-DOC-LOCAL-DEV`        | [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md)                               | Local Bun 1.4.4 workflow, TLS/HTTPS, Verdaccio, R2, and Profile Radar sources              |
| `SD-DOC-GEN-ARTIFACTS`    | [`docs/generated/ARTIFACTS_AND_CLI.md`](docs/generated/ARTIFACTS_AND_CLI.md) | Auto-generated artifacts manifest, `SD-DOC-*` index, SHA-256 table & Unified CLI guide     |
| `SD-DOC-DASHBOARD`        | [`dashboard.md`](dashboard.md)                                               | Live surveillance brief rendered by `/api/brief` and `cli docs render SD-DOC-DASHBOARD`    |
| `SD-DOC-CUSTOMER-SOURCES` | [`docs/live-customer-sources.md`](docs/live-customer-sources.md)             | Private roster projection, retained wager history projector, and collector scheduling      |
| `SD-DOC-DESIGN-TOKENS`    | [`design/README.md`](design/README.md)                                       | Design token SSOT (`design/tokens.toml`), `AnsiTheme` profiles, and `:root` alias contract |
| `SD-DOC-CONTRACTS`        | [`packages/contracts/README.md`](packages/contracts/README.md)               | `@sportsdesk-ops/contracts` workspace package exports & `Bun.markdown` engine              |
| `SD-DOC-SCHEMA`           | [`schema/README.md`](schema/README.md)                                       | Data contracts, DOD6 v5.4 schema, and telemetry matrix                                     |
| `SD-DOC-STATIC`           | [`static/README.md`](static/README.md)                                       | Static HTML dashboards served by `server.ts`                                               |
