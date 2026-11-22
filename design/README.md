# Design Token SSOT

- [`tokens.toml`](tokens.toml) — authoritative neuron tokens, surfaces, ingestion lanes, routes, SLA/CAS states, and UI chrome (`v1.5.0`)
- [`domain-branded-types.ts`](domain-branded-types.ts) — nominal branded primitives and domain registry sections
- [`packages/ui/src/tokens.registry.generated.ts`](../packages/ui/src/tokens.registry.generated.ts) — generated palette/alias data consumed by the Build-Matrix drawer and dashboard footer
- [`src/dashboard/tokens.generated.css`](../src/dashboard/tokens.generated.css) — generated CSS Houdini `@property` declarations and `:root` custom properties

Regenerate and verify zero drift through the unified Bun CLI:

```sh
bun run gen:tokens          # compile design/tokens.toml -> TS registry + Houdini CSS
bun run gen:tokens:gate     # fail non-zero on token output drift
bun run artifacts:generate  # regenerate tokens + docs/generated manifest & CLI guide
bun run artifacts:check     # full artifact & documentation drift gate
```

## `:root` alias layer

`[aliases.legacy]` and `[aliases.dashboard]` hold every non-token custom property the generated stylesheets emit, as `<alias> = "<target token>"`:

- `legacy` is emitted into every generated stylesheet (`--sd-theme-emerald`). Each ingestion channel's `legacy_token_name` must appear here and point back at that channel's canonical token so the two sources cannot drift.
- `dashboard` is emitted into [`src/dashboard/tokens.generated.css`](../src/dashboard/tokens.generated.css).

Aliases are never emitted as `@property` and never introduce a new color. [`scripts/gen_artifacts.ts`](../scripts/gen_artifacts.ts) fails closed if an alias targets an unknown token, shadows a canonical token, is defined twice, or if a `legacy_token_name` is missing or mismatched.

The UI token drawer rebuilds the served `:root` block from the generated registry (41 canonical tokens + 25 aliases + 4 CAS states at `v1.5.0`), keeping [`packages/ui/src/tokens.registry.generated.ts`](../packages/ui/src/tokens.registry.generated.ts) and [`src/dashboard/tokens.generated.css`](../src/dashboard/tokens.generated.css) strictly in lockstep.
