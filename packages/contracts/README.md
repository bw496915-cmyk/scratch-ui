# `@sportsdesk-ops/contracts`

Private Bun workspace package (`packages/contracts`) providing shared browser- and runtime-safe TypeScript contracts across `@sportsdesk-ops/api`, `@sportsdesk-ops/backend`, `@sportsdesk-ops/ui`, and the unified Bun CLI (`scripts/sportsdesk_cli.ts`).

## Usage

```ts
import { CONTRACTS_PACKAGE, runBunSurfaceAudit } from "@sportsdesk-ops/contracts"
import { FEATURES } from "@sportsdesk-ops/contracts/features"
import { parseWagerToken } from "@sportsdesk-ops/contracts/wager-tokens"
```

All entrypoints resolve directly to TypeScript sources under `src/` via Bun and Vite workspace resolution.

## Subpath Exports (`package.json`)

| Export Path             | Source Module                     | Purpose                                                             |
| :---------------------- | :-------------------------------- | :------------------------------------------------------------------ |
| `.`                     | `src/index.ts`                    | Aggregate surface (`CONTRACTS_PACKAGE` and all contract modules)    |
| `./wager-tokens`        | `src/wager_tokens.ts`             | Wager token vocabulary and parsing                                  |
| `./slice-metrics`       | `src/slice_metrics.ts`            | Slice metric definitions                                            |
| `./slice-registry`      | `src/slice_registry.ts`           | Slice registry contracts                                            |
| `./slice-data-table`    | `src/slice_data_table.ts`         | Data-table contracts                                                |
| `./slice-diff-view`     | `src/slice_diff_view.ts`          | Diff-view contracts                                                 |
| `./shadow-pricing`      | `src/shadow_pricing.ts`           | Shadow pricing contracts                                            |
| `./features`            | `src/features.ts`                 | Feature flags and build targets                                     |
| `./dashboard-hydration` | `src/dashboard_hydration.ts`      | Dashboard hydration types                                           |

## Additional Modules Exported from `.` (`src/index.ts`)

| Source Module                 | Purpose                                                                           |
| :---------------------------- | :-------------------------------------------------------------------------------- |
| `src/bun_runtime_surface.ts`  | Bun 1.4.4 globals, utilities, core APIs, deep `bun:*`/class/kind audit, and `Bun.markdown.render` / `AnsiTheme` studio |
| `src/bun_syntax_highlight.ts` | Cross-runtime `Bun.color`, `Bun.stringWidth`, `Bun.stripANSI`, `Bun.escapeHTML`   |
| `src/bun_yaml.ts`             | Cross-runtime `Bun.YAML` parse/stringify helpers                                  |
| `src/bun_lockfile.ts`         | `bun.lock` parser & supply-chain metadata contracts                               |
| `src/npmrc.ts`                | `.npmrc` scoped registry config parser                                            |
| `src/markdown_telemetry.ts`   | Markdown brief telemetry types                                                    |
| `src/wager_channels.ts`       | Wager channel provenance and SLA tokens                                           |
| `src/agent_hierarchy.ts`      | Downline agent tree contracts                                                     |
| `src/api_telemetry.ts`        | HTTP & WebSocket API telemetry contracts                                          |
| `src/customer_history.ts`     | Retained customer wager history contracts                                         |
| `src/parlay_comparison.ts`    | Parlay leg and ticker comparison contracts                                        |
| `src/terminal_commands.ts`    | Allowed operator terminal command grammar                                         |
| `src/weblog_operation.ts`     | Parsed weblog operation family taxonomy                                           |
| `src/weblog_severity.ts`      | Weblog IP/login severity scoring rules                                            |
