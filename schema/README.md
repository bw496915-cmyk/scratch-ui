# Schema & Data Contracts

Tracked schema contracts and telemetry matrices in `schema/`:

| Path                                                       | Role                                                               |
| :--------------------------------------------------------- | :----------------------------------------------------------------- |
| [`dod6-v54.schema.json`](dod6-v54.schema.json)             | DOD6 v5.4 columnar binary spine schema specification               |
| [`wagers_field_contract.json`](wagers_field_contract.json) | Canonical wager field contract & wire mapping                      |
| [`rsk06_telemetry_matrix.ts`](rsk06_telemetry_matrix.ts)   | RSK-06 telemetry matrix definitions                                |
| `migrations/`                                              | SQL migration stubs (`.gitkeep` placeholder for future migrations) |
| `preload/`                                                 | SQLite schema inspection preload helpers                           |

Verify repository schema, artifacts, and Markdown links via the unified Bun CLI:

```sh
bun run cli artifacts check
bun run cli check all
```
