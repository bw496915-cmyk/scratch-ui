# SportsDesk Ops — Generated Artifacts & Unified Bun CLI

> **Generated file — do not edit by hand.**
> Regenerate with `bun run artifacts:generate` · Verify zero drift with `bun run artifacts:check`
> Pinned runtime: **Bun 1.4.4** · Design tokens SSOT: **`design/tokens.toml` v1.5.0** (41 canonical tokens, 25 aliases, 4 CAS states)

## Unified Bun CLI (`bun run cli`)

| Command | Purpose |
| :------ | :------ |
| `bun run cli help` | Display unified Bun CLI command reference and pinned runtime version |
| `bun run cli artifacts generate` | Compile design/tokens.toml and regenerate docs/generated/artifacts-manifest.json + ARTIFACTS_AND_CLI.md |
| `bun run cli artifacts check` | Fail-closed drift gate for generated token outputs, pipeline asset hashes, and generated artifact docs |
| `bun run cli docs check` | Verify zero broken local links and zero stale legacy references across all .md files |
| `bun run cli docs list` | List all tracked repository Markdown documents with line counts and link status |
| `bun run cli docs render <file>` | Render a Markdown file via Bun.markdown.render() / Bun.markdown.ansi(AnsiTheme) in the terminal |
| `bun run cli surface [--kinds|--deep|--json]` | Run read-only live Bun Runtime Surface audit (Bun.* kinds, bun:* modules, namespaces, classes) |
| `bun run cli check [gate|all]` | Execute repository integrity gates under Bun (lockfile, route-surface, bundle-hygiene, shell-boundary, snapshots, artifacts, docs) |
| `bun run cli scripts [filter]` | Inspect grouped package.json scripts using Bun.inspect.table |

## Generated & Managed Artifacts

| Artifact Path | Role | Source | Size | SHA-256 (12) |
| :------------ | :--- | :----- | ---: | :----------- |
| `packages/ui/src/tokens.registry.generated.ts` | Generated TypeScript design token registry & aliases | `design/tokens.toml` | 7,308 B | `6698daa6543d` |
| `src/dashboard/tokens.generated.css` | Generated CSS Houdini @property + :root token stylesheet | `design/tokens.toml` | 9,651 B | `0f923d447d57` |
| `design/domain-branded-types.ts` | Nominal branded primitives & neuron registry contracts | `design/tokens.toml` | 44,143 B | `d98fab5bf45b` |

## Pipeline Diagram Integrity (`docs/assets/pipeline-artifacts-metadata.json`)

Verified **12** raster/vector assets across **4** pipeline diagrams:

| Artifact ID | Slug | SVG SHA-256 | PNG SHA-256 | WebP SHA-256 |
| :---------- | :--- | :---------- | :---------- | :----------- |
| `SD-ARTIFACT-01-10MODE-PIPELINE` | `pipeline-10-mode-architecture` | `9f0a5297e506` | `7bdbe1422caf` | `8b0332f59a67` |
| `SD-ARTIFACT-02-6LAYER-CLEANING` | `pipeline-6-layer-data-cleaning` | `0eb4f0d17326` | `bf8529ec45de` | `e093a1eb874e` |
| `SD-ARTIFACT-03-IP-AND-RECONCILIATION` | `pipeline-per-office-ip-and-reconciliation` | `b49d2f7340a9` | `2b6a0868154d` | `1fa2411ca6d0` |
| `SD-ARTIFACT-04-DUAL-SURFACE-GSLIVE` | `pipeline-dual-surface-gslive-model` | `b26b3298b115` | `c42d873dd4a6` | `c8624edd41e3` |

## Verified Markdown Documentation Inventory

Every local link across all **10** tracked Markdown documents is checked by `bun run docs:check`:

| Document | Title | Lines | Local Links | SHA-256 (12) |
| :------- | :---- | ----: | ----------: | :----------- |
| [`dashboard.md`](../../dashboard.md) | 📊 SportsDesk & Fantasy402 Real-Time Surveillance Dashboard | 176 | 3 | `d8d12427b7ff` |
| [`design/README.md`](../../design/README.md) | Design Token SSOT | 27 | 8 | `b845052bf706` |
| [`docs/live-customer-sources.md`](../../docs/live-customer-sources.md) | Local live customer identities | 85 | 0 | `bbd69062bfb8` |
| [`LOCAL_DEVELOPMENT.md`](../../LOCAL_DEVELOPMENT.md) | Local SportsDesk development | 537 | 0 | `77030b6e8e26` |
| [`packages/contracts/README.md`](../../packages/contracts/README.md) | `@sportsdesk-ops/contracts` | 47 | 0 | `e07ad566999f` |
| [`README.md`](../../README.md) | SportsDesk Ops Dashboard | 125 | 22 | `fa8cc3416676` |
| [`schema/README.md`](../../schema/README.md) | Schema & Data Contracts | 19 | 3 | `8cedb0dc6cff` |
| [`static/README.md`](../../static/README.md) | Static HTML Surfaces | 16 | 7 | `88b5a5e4f32e` |
| [`tests/fixtures/backtest/README.md`](../../tests/fixtures/backtest/README.md) | Synthetic backtest fixture (P1.1) | 70 | 0 | `f8a885a7e441` |
| [`tests/fixtures/verify-load/FIXTURES.md`](../../tests/fixtures/verify-load/FIXTURES.md) | verify-load pinned artifacts (CI) | 14 | 0 | `c6092f7cc138` |

## Unified `package.json` Scripts

| Script | Command |
| :----- | :------ |
| `bun run format` | `bun fmt` |
| `bun run format:check` | `bun fmt --check` |
| `bun run format:debug` | `bun fmt --debug-check` |
| `bun run hooks:install` | `git config --local core.hooksPath .githooks` |
| `bun run registry:install` | `bun install --cwd tools/registry --frozen-lockfile` |
| `bun run registry:start` | `bun run --cwd tools/registry start` |
| `bun run registry:check` | `bun scripts/check_local_registry.ts` |
| `bun run cli` | `bun scripts/sportsdesk_cli.ts` |
| `bun run gen:tokens` | `bun scripts/gen_artifacts.ts --tokens-only` |
| `bun run gen:tokens:gate` | `bun scripts/gen_artifacts.ts --tokens-only --check` |
| `bun run artifacts:generate` | `bun scripts/gen_artifacts.ts` |
| `bun run artifacts:check` | `bun scripts/gen_artifacts.ts --check` |
| `bun run docs:check` | `bun scripts/sportsdesk_cli.ts docs check` |
| `bun run dev` | `NODE_ENV=development SPORTSDESK_DEV_SERVER=1 tsx server.ts` |
| `bun run start` | `node server.mjs` |
| `bun run start:local` | `bun --no-env-file server.mjs` |
| `bun run build` | `vite build && esbuild server.ts --bundle --platform=node --format=esm --packages=external --external:bun:sqlite --outfile=server.mjs` |
| `bun run preview` | `vite preview --host 0.0.0.0 --port 3000` |
| `bun run clean` | `rm -rf dist server.js server.mjs` |
| `bun run lint` | `tsc --noEmit && tsc --noEmit --project scripts/tsconfig.runtime.json && tsc --noEmit --project packages/ui/tsconfig.json` |
| `bun run test` | `bun test` |
| `bun run test:update-snapshots` | `TZ=UTC bun test --update-snapshots` |
| `bun run check:lockfile` | `bun scripts/check_lockfile_integrity.ts` |
| `bun run check:route-surface` | `bun scripts/check_route_surface.ts` |
| `bun run check:bundle-hygiene` | `bun scripts/check_bundle_hygiene.ts` |
| `bun run check:runtime` | `bun scripts/verify_runtime_connections.ts` |
| `bun run check:shell-boundary` | `bun scripts/check_shell_boundary.ts` |
| `bun run check:snapshots` | `bun scripts/check_snapshot_hygiene.ts` |
| `bun run check:ci` | `bun run format:check && bun run format:debug && bun run check:lockfile && bun run artifacts:check && bun run docs:check && bun test && bun run check:snapshots && bun run check:route-surface && bun run check:bundle-hygiene && bun run check:shell-boundary` |
