# Local live customer identities

Set `SPORTSDESK_CUSTOMER_ROSTER_JSON` to a private projected manager roster with
`schemaVersion: 1`, `agents`, and `players` arrays. The collector's
`scratch/agent-feed/roster.projected.json` is the supported structural source. It contains account
and assigned-agent identities, not a complete risk or performance profile. Refresh it through the
collector's existing projected hierarchy capture; never point the dashboard at raw provider rows,
which may contain passwords or personal information.

The dashboard projects only customer ID, login and assigned agent. It deduplicates customer IDs,
rejects synthetic sentinels, and caches by file modification stamp. `/api/customers` returns these
as `bookRows`, with no fixture/backtest rows in the production server adapter. The same source owns
individual profile lookups. Unconfigured sources remain unavailable; invalid configured sources
fail instead of falling back to fixtures. The source's `capturedAt` is preferred; older projections
without it use the file observation time, not evidence of a fresh provider capture.

All roster accounts are searchable. The table renders 100 matching accounts per page. Identity-only
rows are classified as Unmeasured; the individual profile/rating APIs return null metrics, and the
inspector does not invent bankroll, lifetime volume, sharpness, CLV, limits, Bayesian ratings or
trading directives. These need separate measured sources. Keep the roster and local environment
file private and untracked. Existing dashboard authentication still protects the API.

The R2 monitor accepts the ticker's `data_window_max_epoch_ms` as its covered-event timestamp.
It never substitutes generation or publication time for an unmeasured data window. GSLive-derived
pipelines still require a valid GSLive sign-in independently of these sources.

## Retained wager observations

Generate a private projection with the pinned Bun runtime:

```sh
bun --no-env-file run scripts/project_customer_history.ts \
  --source /private/graded-export.json \
  --out .local/customer-history.json
```

Repeat `--source` for additional retained exports. Set
`SPORTSDESK_CUSTOMER_HISTORY_JSON` to the absolute output path. Regenerate after source
exports change; this command does not schedule collection or authenticate upstreams.
The output records source hashes and observation generation time, not fresh capture proof.
Keep exports, projection and environment file untracked. The command writes the projection
with owner-only permissions.

Metrics join exact customer ID or login aliases to the current roster. Ambiguous aliases,
multiple history keys resolving to one account, and conflicting native ticket/wager copies
are withheld. `/api/customers` reports `historyCoverage`; unmatched accounts retain unknown
metrics. Roster assignment does not establish historical agent assignment.

The native ticket-plus-wager grain prevents repeated legs from multiplying stake. Provider
money is cents; reported net is AmountWon minus AmountLost. Only W/L observations with
known financial fields, positive stake, explicit non-free-play status and zero refunds
enter financial denominators. ALERT/BLOCKED mirrors, refunds, unknown statuses, missing
money and conflicts do not. Counts, stake distribution, empirical Gini, reported W/L,
source-reported net and provisional ROI describe only the eligible retained slice.
Source wall times have an unverified timezone. This is not complete account history or
independently verified settlement performance; fees and corrections remain unverified.

The inspector labels these denominators and exclusions. Mean stake and Gini are populated
where measured. Lifetime totals, predictive sharpness, CLV, Bayesian/Kelly ratings, limits,
syndicate membership and forecast VaR remain unavailable. Empirical p95 stake is not VaR.

## Collector scheduling

The collector's existing webview scheduler owns `sched_customer_history_15m` at
minutes 12, 27, 42 and 57 (`America/Chicago`). Configure its process with
`SPORTSDESK_CUSTOMER_HISTORY_PROJECTOR` pointing to this repository's absolute
`scripts/project_customer_history.ts`, `SPORTSDESK_CUSTOMER_HISTORY_SOURCES` as a JSON
array of absolute retained-export paths, and `SPORTSDESK_CUSTOMER_HISTORY_JSON` as
the same private output path the dashboard reads. The collector wrapper runs the
pinned Bun executable with `--no-env-file`; it needs no GSLive session or API key.

The wrapper passes `--if-changed`. Source content hashes and projector code hashes
invalidate the projection; unchanged exports leave both `generatedAt` and the output
modification time intact. This schedules projection of retained files, not upstream
capture. Existing export producers must still refresh those inputs. The source-event
window remains historical even after a successful rebuild.

The wrapper serializes refreshes with an exclusive lock and writes a private
`<output>.status.json` attempt receipt (`updated`, `unchanged`, or `failed`), separately
from the last good projection. Invalid/missing inputs fail without replacing that
projection. A daemon crash can leave `<output>.refresh-lock`; remove it only after
confirming no refresh process is running. Restart the collector after configuring the
schedule; restart the dashboard if its output-path configuration changes. File-content
updates are picked up by the dashboard cache without a restart.
