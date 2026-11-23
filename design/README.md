# Design Token SSOT

SportsDesk & Fantasy402 maintains a single, zero-drift design system rooted in
declarative TOML specifications (`v1.5.0`) and Bun-native compilation &
verification primitives. Every color, elevation slot, WCAG/CIEDE2000 gate,
SLA/CAS badge, operator keymap slot, and branded image derivative is compiled
and verified from this directory.

## Architecture & Compilation Flow

```text
  design/tokens.toml (v1.5.0)       design/branding.toml (sportsdesk-branding/v1)
  ├─ [gates] [layout] [motion]      ├─ [brand] [context] [palette] [sources]
  ├─ [surfaces.*] [ui.*]            └─ [[assets]] (6 derivatives, 5 XMP-stamped)
  ├─ [sla.*] [cas_states.*]                       │
  ├─ [ingestion.*] [routes.*]                     ▼
  ├─ [cli.markdown_ansi.*]          scripts/gen_branding_assets.ts
  ├─ [bitmasks.*] [keymap.*]        ├─ public/assets/branding/*.{webp,png,jpg}
  ├─ [aliases.*] [tokens]           ├─ public/assets/branding/branding-metadata.json
  │                                 └─ public/manifest.webmanifest
  ▼
  scripts/gen_artifacts.ts (Bun.TOML + Bun.CryptoHasher + Bun.Glob + HTMLRewriter)
  ├─ packages/ui/src/tokens.registry.generated.ts  (41 canonical + 25 aliases + 4 CAS)
  ├─ src/dashboard/tokens.generated.css            (CSS Houdini @property + :root)
  └─ docs/generated/artifacts-manifest.json        (SHA-256 lock + HTMLRewriter doc audit)

  lib/brand.ts (CryptoHasher + bun:sqlite schema guard)
       └─▶ design/domain-branded-types.ts ──▶ design/index.ts (Bun.color + native .toml)
                                                   └─▶ design/macros.ts ──▶ design/baked.ts
                                                       (with { type: "macro" } compile-time bake)
```

## Authoritative Files & Generated Outputs

| Artifact | Role | Status |
| --- | --- | --- |
| [`tokens.toml`](tokens.toml) | Authoritative design tokens, surfaces, ingestion lanes, routes, SLA/CAS states, bitmasks, keymap, and UI chrome (`v1.5.0`) | Source (SSOT) |
| [`branding.toml`](branding.toml) | Brand identity, palette bindings, operational context, and derivative matrix (`sportsdesk-branding/v1`) | Source (SSOT) |
| [`color.ts`](color.ts) | `Bun.color` normalizer (`hex`, `number`, `{rgb}`, `hsl`) for cross-artifact palette comparison | Source (SSOT) |
| [`domain-branded-types.ts`](domain-branded-types.ts) | 16 core nominal domain brands, transport bit layouts, and typed token registries | Source (SSOT) |
| [`index.ts`](index.ts) | Unified facade using Bun built-in `.toml` imports, `Bun.color`, and `validateDesignSystemParity()` | Source (SSOT) |
| [`macros.ts`](macros.ts) | Bun compile-time macros (`bakeDesignSystemSnapshot()`, `bakeCanonicalColorHex()`) | Source (SSOT) |
| [`baked.ts`](baked.ts) | Zero-runtime-TOML baked bundle entrypoint (`with { type: "macro" }`) | Source (SSOT) |
| [`lib/brand.ts`](../lib/brand.ts) | Canonical `Brand<T, Tag>` engine, `Bun.CryptoHasher("sha256")`, and live `bun:sqlite` schema-verified SQL brands | Source (SSOT) |
| [`packages/ui/src/tokens.registry.generated.ts`](../packages/ui/src/tokens.registry.generated.ts) | Compiled palette, alias, and CAS registry consumed by the Build-Matrix drawer and dashboard footer | Generated |
| [`src/dashboard/tokens.generated.css`](../src/dashboard/tokens.generated.css) | Compiled CSS Houdini `@property` declarations, `:root` tokens, and `prefers-contrast: more` overrides | Generated |
| [`public/assets/branding/branding-metadata.json`](../public/assets/branding/branding-metadata.json) | Generated brand asset catalog with `Sha256Hex` digests and embedded XMP context verification | Generated |
| [`public/manifest.webmanifest`](../public/manifest.webmanifest) | Generated Web App Manifest synchronized with `design/branding.toml` palette and icons | Generated |

## Bun-Native Pipeline Architecture

1. **Built-in `.toml` Imports & `Bun.TOML.parse`**: [`index.ts`](index.ts) loads
   `tokens.toml` and `branding.toml` via static Bun `.toml` imports with zero
   third-party TOML library dependency.
2. **Compile-Time Macros (`with { type: "macro" }`)**: [`baked.ts`](baked.ts)
   invokes [`macros.ts`](macros.ts) during bundling so
   `validateDesignSystemParity()` runs once at compile time and production
   bundles ship pre-baked JSON objects with no runtime TOML parsing.
3. **Color Normalization (`Bun.color`)**: [`color.ts`](color.ts) normalizes
   every color across hex, 24-bit integer, `{ r, g, b }`, and HSL formats with
   `Bun.color` while keeping WCAG contrast and CIEDE2000 math independent.
4. **SHA-256 Hash-Backed Checks (`Bun.CryptoHasher("sha256")`)**:
   [`lib/brand.ts`](../lib/brand.ts) backs `Sha256Hex` with `Bun.CryptoHasher`,
   and [`scripts/gen_artifacts.ts`](../scripts/gen_artifacts.ts) compares
   `Sha256Hex` digests rather than diffing raw text.
5. **DOM Link Auditing (`Bun.Glob` + `HTMLRewriter` + `Bun.file().exists()`)**:
   `auditMarkdownDocs()` and `auditMarkdownDocsAsync()` discover Markdown files
   with `Bun.Glob`, render CommonMark via `Bun.markdown.html()`, extract
   `a[href]` tags via `HTMLRewriter`, and verify targets with
   `Bun.file().exists()`.
6. **Live `bun:sqlite` Schema SQL Brands**: [`lib/brand.ts`](../lib/brand.ts)
   introspects live `sqlite_master` tables/indexes and `PRAGMA table_info(...)`
   columns so `sqlTableFromSchema()`, `sqlColFromSchema()`, and
   `sqlIndexFromSchema()` reject both SQL injection and unknown schema symbols.
7. **Snapshot Pinning (`bun:test` `toMatchSnapshot()`)**:
   [`tests/unit/design_system_parity.test.ts`](../tests/unit/design_system_parity.test.ts)
   pins compiled manifests and XMP-stamped asset digests so
   `bun run test:update-snapshots` updates all snapshots in one command.

## Four-Axis Design Token Architecture

[`tokens.toml`](tokens.toml) organizes visual semantics and operational telemetry
into four decoupled axes plus shared structural primitives:

1. **Surfaces, Chrome & Layout Geometry (`[surfaces.*]`, `[ui.*]`, `[layout]`, `[motion]`)**
   - Two rendering canvases: `SURFACE.DOM` (`--sd-surface-bg: #070b14`) and
     `SURFACE.CLI` (`--sd-surface-cli: #04070e`, 24-bit TrueColor ANSI).
   - Five luminance-stepped elevation surfaces (`card` `#0b1120` → `elevated`
     `#121c31` → `hover` `#19263d` → `raised` `#202f4a` → `selected` `#0f3a5d`)
     plus hairline/interactive borders (`#243247` / `#7085a1`), focus ring
     (`#38bdf8`), and three text tiers (`#f1f5f9`, `#cbd5e1`, `#94a3b8`).
   - Zero-float integer geometry (`4px` grid unit, `2px` focus ring + offset) and
     motion cadence (`500ms` ARIA-live coalesce latch, `140ms` drawer transition).
2. **Ingestion Signal Channels & Risk Route Circuits (`[ingestion.*]`, `[routes.*]`)**
   - **Axis 1 (Layers 17–24D)**: 11 ingestion lanes (`NON_SPORTS`, `Internet`,
     `BLOCKED`, `GATEWAY`, `ALERT`, `GSBUILDER`, `GSLIVE`, `CSLEVEL2`,
     `LIVEBETTINGCWS`, `PHONE`, `HOUSE`) packed into `ChannelPackedHandle32`
     (`[4b channelId | 8b slaTensOfMs | 20b rowIndex]`).
   - **Axis 2 (Layers 25–28)**: 4 risk decision circuits (`--sd-route-devig`,
     `--sd-route-sharp`, `--sd-route-pending`, `--sd-route-manager`) with typed
     thresholds and mitigation kinds.
3. **Dual-Clock SLA, R2 CAS States & Deterministic Bitsets (`[sla.*]`, `[cas_states.*]`, `[bitmasks.*]`)**
   - Four freshness/poison states (`SLA_FRESH`, `SLA_WARN`, `SLA_STALE`,
     `SLA_POISON`) and four R2 ETag CAS commit states (`CAS_COMMITTED`,
     `CAS_RETRY_BACKOFF`, `CAS_CONFLICT_412`, `CAS_QUARANTINED`), each pairing
     color tokens with non-color WCAG 1.4.1 glyphs and border styles.
   - Unsigned `BitSet32` masks (`bit <= 30`, `>>> 0`) for bet-leg classification
     and UI state latches (including `STALE_SNAPSHOT_POISON_BIT = 0x40000000`).
4. **10-Key Bijective Operator Keymap & Deterministic CLI Themes (`[keymap.*]`, `[cli.markdown_ansi.*]`)**
   - Bijective `Digit1..Digit0` (`slot_index 0..9` ↔ `1 << slot_index` ↔
     `forensic_mode 1..10`) exported as `OPERATOR_KEYMAP` and `KEYMAP_SLOTS`.
   - Four `Bun.markdown.AnsiTheme` profiles (`ghostty_interactive`,
     `tty_narrow`, `r2_telemetry_stream`, `pipe_ascii`) locked to `light = false`
     so ambient `COLORFGBG` never drifts contrast on `#04070e`.

## Perceptual & Accessibility Gates (`[gates]`)

Every palette change must satisfy integer milli-unit perceptual and contrast
gates mirrored between `[gates]` in [`tokens.toml`](tokens.toml) and
`TOKEN_GATES` in [`domain-branded-types.ts`](domain-branded-types.ts):

| Gate Key | Floor | Standard |
| --- | --- | --- |
| `min_body_contrast_ratio_milli` | `4.50:1` (`4500`) | WCAG 2.1 AA body copy on all dashboard surfaces |
| `min_aaa_slate_contrast_milli` | `7.00:1` (`7000`) | WCAG 2.1 AAA muted slate (`#94a3b8` on `#0b1120`) |
| `min_ui_component_contrast_milli` | `3.00:1` (`3000`) | WCAG 1.4.11 focus rings, active borders, and badges |
| `min_cross_state_delta_e00_milli` | `7.00 ΔE00` (`7000`) | Perceptual separation across `card → hover → selected` |
| `min_fresh_vs_stale_delta_e00_milli` | `40.00 ΔE00` (`40000`) | High-contrast separation between `SLA_FRESH` and `SLA_STALE` |
| `min_adjacent_channel_delta_e00_milli` | `10.00 ΔE00` (`10000`) | Distinctiveness between adjacent ingestion channel badges |

## `:root` Alias Layer

`[aliases.legacy]`, `[aliases.dashboard]`, and `[aliases.accessibility]` hold
every non-token custom property emitted in generated stylesheets as
`<alias> = "<target token>"`:

- `legacy` is emitted into every generated stylesheet (`--sd-theme-emerald`).
  Each ingestion channel's `legacy_token_name` must appear here and point back
  at that channel's canonical token so the two sources cannot drift.
- `dashboard` is emitted into [`src/dashboard/tokens.generated.css`](../src/dashboard/tokens.generated.css)
  for component state slots (`--sd-state-ok`, `--sd-state-warn`,
  `--sd-state-danger`, `--sd-state-info`, `--sd-state-accent`) and concise
  layout shortcuts (`--bg`, `--card`, `--border`, `--text`, `--muted`).
- `accessibility` elevates `--border` → `--sd-border-strong` and `--muted` →
  `--sd-text-secondary` inside `@media (prefers-contrast: more)`.

Aliases are never emitted as `@property` and never introduce a new color.
[`scripts/gen_artifacts.ts`](../scripts/gen_artifacts.ts) fails closed if an
alias targets an unknown token, shadows a canonical token, is defined twice, or
if a `legacy_token_name` is missing or mismatched.

The UI token drawer rebuilds the served `:root` block from the generated
registry (41 canonical tokens + 25 aliases + 4 CAS states at `v1.5.0`), keeping
[`packages/ui/src/tokens.registry.generated.ts`](../packages/ui/src/tokens.registry.generated.ts)
and [`src/dashboard/tokens.generated.css`](../src/dashboard/tokens.generated.css)
strictly in lockstep.

## Brand Identity & Contextual XMP Asset Pipeline

[`branding.toml`](branding.toml) binds SportsDesk brand metadata and artwork
directly to [`tokens.toml`](tokens.toml) (`tokens_version = "1.5.0"`):

- **Palette Lock**: Every `[palette]` hex in `branding.toml` (and `BRAND_ASSETS`
  in [`packages/ui/src/operator_profiles.ts`](../packages/ui/src/operator_profiles.ts))
  is strictly validated against canonical `[tokens]` hexes via `Bun.color` in
  [`index.ts`](index.ts).
- **Contextual Asset Stamping**: [`scripts/gen_branding_assets.ts`](../scripts/gen_branding_assets.ts)
  reads studio masters via native `Bun.TOML.parse` and stamps 5 WebP/PNG
  derivatives with Dublin Core (`dc:*`), XMP Core (`xmp:*`), and `sportsdesk:*`
  provenance fields via [`lib/image_provenance.ts`](../lib/image_provenance.ts),
  plus a universal `1200x630` JPEG OpenGraph card for social crawlers.

## Verification & Regeneration Workflow

Regenerate and verify zero drift through the unified Bun CLI:

```sh
bun run gen:tokens            # compile design/tokens.toml -> TS registry + Houdini CSS
bun run gen:tokens:gate       # fail non-zero on token output SHA-256 drift
bun run branding:generate     # compile design/branding.toml -> XMP-stamped assets + manifest
bun run branding:check        # audit branding assets, XMP context & SHA-256 digests
bun run artifacts:generate    # regenerate tokens + docs/generated manifest & CLI guide
bun run artifacts:check       # full artifact, branding & HTMLRewriter doc drift gate
bun run docs:check            # verify local Markdown links via Bun.Glob + HTMLRewriter
bun run test:update-snapshots # refresh bun:test snapshots for generated manifests
```
