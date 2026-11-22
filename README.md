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

```sh
# Regenerate all managed artifacts (design tokens + manifest + CLI/artifact docs)
bun run cli artifacts generate

# Fail-closed drift gate (tokens, pipeline SHA-256 checksums, manifest, docs)
bun run cli artifacts check

# Audit all Markdown files for broken local links and stale references
bun run cli docs check

# Render any Markdown file in the terminal via Bun.markdown.render() / AnsiTheme
bun run cli docs render dashboard.md --mode render --preset obsidian-desk --columns 88
bun run cli docs render dashboard.md --mode ansi --light --columns 80

# Live read-only Bun Runtime Surface audit (Bun.* kinds, bun:* modules, classes)
bun run cli surface --kinds
bun run cli surface --deep

# Run repository verification gates under Bun
bun run cli check all
bun run cli scripts
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

[`design/tokens.toml`](design/tokens.toml) (`v1.5.0`) is the single source of truth for dashboard surfaces, SLA states, ingestion channels, risk routes, and `:root` aliases.

- `bun run gen:tokens` compiles `design/tokens.toml` into:
  - [`packages/ui/src/tokens.registry.generated.ts`](packages/ui/src/tokens.registry.generated.ts)
  - [`src/dashboard/tokens.generated.css`](src/dashboard/tokens.generated.css)
- `bun run gen:tokens:gate` verifies zero drift against `design/tokens.toml`.
- `bun run artifacts:generate` compiles tokens, verifies all 12 vector/raster hashes in [`docs/assets/pipeline-artifacts-metadata.json`](docs/assets/pipeline-artifacts-metadata.json), audits all Markdown files, and emits [`docs/generated/artifacts-manifest.json`](docs/generated/artifacts-manifest.json) and [`docs/generated/ARTIFACTS_AND_CLI.md`](docs/generated/ARTIFACTS_AND_CLI.md).
- `bun run artifacts:check` fails closed on any generated file drift, pipeline asset mismatch, or broken documentation link.

See [`design/README.md`](design/README.md) for token and alias rules.

## Security & Runtime Hardening

- **No Implicit `.env` Bleed**: [`bunfig.toml`](bunfig.toml) sets `env = false`, `[install].ignoreScripts = true`, and `minimumReleaseAge = "3d"`. CLI entrypoints call `assertSafeExecArgv()` from [`src/cli/preflight_guard.ts`](src/cli/preflight_guard.ts) to block unallowlisted `--env-file` flags.
- **Read-Only Runtime Surface Introspection**: The **Status & Config → Bun Runtime Surface** panel and `bun run cli surface` classify `Bun.*` exports (`class`, `namespace`, `function`, `constant`, `object`) and inspect `bun:*` built-in modules (`bun:sqlite`, `bun:ffi`, `bun:jsc`, `bun:test`, `bun:bundle`) while strictly redacting `Bun.env` and `Bun.secrets`.
- **Safe Markdown & ANSI Rendering**: `Bun.markdown.render()` and `Bun.markdown.ansi(md, AnsiTheme)` strip terminal control sequences, tint `[REDACTED*]` tokens, and block `javascript:`, `data:`, and signed S3 URLs from OSC-8 hyperlinks.
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

- [`LOCAL_DEVELOPMENT.md`](LOCAL_DEVELOPMENT.md) — Local Bun 1.4.4 workflow, TLS/HTTPS, Verdaccio registry, R2 inspection, and Profile Radar sources.
- [`docs/generated/ARTIFACTS_AND_CLI.md`](docs/generated/ARTIFACTS_AND_CLI.md) — Auto-generated artifacts manifest, SHA-256 table, and unified Bun CLI reference.
- [`dashboard.md`](dashboard.md) — Live surveillance brief rendered by `/api/brief` and `bun run cli docs render dashboard.md`.
- [`docs/live-customer-sources.md`](docs/live-customer-sources.md) — Private roster projection, retained wager history projector, and collector scheduling.
- [`design/README.md`](design/README.md) — Design token SSOT (`design/tokens.toml`) and `:root` alias contract.
- [`packages/contracts/README.md`](packages/contracts/README.md) — `@sportsdesk-ops/contracts` workspace package exports.
- [`schema/README.md`](schema/README.md) — Data contracts, DOD6 v5.4 schema, and telemetry matrix.
- [`static/README.md`](static/README.md) — Static HTML dashboards served by `server.ts`.
