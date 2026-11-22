# Static HTML Surfaces

Static HTML and client script surfaces served under `/static/*` by [`server.ts`](../server.ts):

- [`status.html`](status.html) + [`status.js`](status.js) — authenticated `/status` daemon probe page compliant with production `script-src 'self'` CSP
- [`customer-churn-simulation-dashboard.html`](customer-churn-simulation-dashboard.html) — customer churn simulation static snapshot
- [`telegram-miniapp-dashboard.html`](telegram-miniapp-dashboard.html) — Telegram Mini App static dashboard snapshot
- [`live-bets.html`](live-bets.html) — live wager tape static snapshot

Design tokens are compiled from [`design/tokens.toml`](../design/tokens.toml) (`v1.5.0`) via the unified Bun CLI:

```sh
bun run gen:tokens          # regenerate token TS registry & Houdini CSS
bun run gen:tokens:gate     # fail-closed zero-drift check
```
