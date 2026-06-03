# STATIS shared memory - Codex / Claude

This file is the handoff memory for agents working on STATIS.

## Mandatory handoff protocol

Before taking over:
- Read this file completely.
- Check the latest Git status and current branch.
- Check whether the previous agent left pending work, failing checks, or known risks.

After working:
- Add a dated entry in "Work log".
- Document files changed, commands run, results, remaining issues, and next recommended step.
- Do not remove previous entries unless the user explicitly asks for cleanup.

## Project snapshot

- Workspace: `C:\Users\Administrator\Documents\STATIS_V2`
- GitHub repo: `https://github.com/guyak89/STATIS_V3`
- Working branch created by Codex: `codex/statis-v3`
- Initial pushed commit: `bbed8c2` (`Initial STATIS V3 project`)
- App: Next.js / TypeScript dashboard for SQL Server `BASE_INTERCO`
- Local settings DB: `data/app-settings.sqlite` (ignored by Git)
- Local Node runtime: `.tools/node-v22.16.0-win-x64/node.exe` (ignored by Git)

## Known baseline before hardening

- Production build passed with:
  `.\.tools\node-v22.16.0-win-x64\node.exe .\node_modules\next\dist\bin\next build`
- Lint failed in `components/resultat-ledger-client.tsx`:
  - unstable `detailHref` dependency
  - synchronous `setState` in effect
  - unescaped apostrophe in JSX
- Security risk identified:
  - Some settings mutations were not protected by the admin PIN at API level.
  - Routes to review include SQL settings, central agency settings, and branding settings.
- Performance risk identified:
  - Dashboard endpoint is optimized with split SQL blocks and cache.
  - Generic/detail endpoints still need cache and SQL-level agency scope where possible.

## SQL performance knowledge (STATISDATA)

Durable facts shared from Claude's project memory — read before touching any heavy SQL.

- Live DB is SQL Server **STATISDATA** (connection in `data/app-settings.sqlite`: host `localhost,53195`, user `statis`). The code default is `BASE_INTERCO`, but the configured/live DB is STATISDATA.
- Table sizes: **HDPM ≈ 28.6M rows**, OPERATION ≈ 2.5M, SOLDPERI ≈ 25M, REMBOURS ≈ 930k, TABAMOR ≈ 688k, PRETS ≈ 81k.
- **Rule 1 — never put `COLLATE DATABASE_DEFAULT` on join/where keys.** Every string column is already `French_CI_AS` (= the DB default), so these COLLATE clauses are no-ops that make predicates non-SARGable and defeat index seeks → full scans. Removing them on the HDPM join cut treasury 45s → 26s, identical result.
- **Rule 2 — materialize shared CTEs into `#temp` (+ `CREATE CLUSTERED INDEX`).** SQL Server re-evaluates a CTE on every reference; loan-portfolio CTEs referenced 2-3× exploded (>5 min). `#temp` single-pass → ~22-28s.
- **No live balance column exists** (`MONTANT_CLOTURE` is the closure amount, not the running balance; `SOLDJOUR` is empty). Account balances are obtained by replaying the HDPM ledger (signed sum: C = +MONTANT_TRANS, D = −MONTANT_TRANS, excluding `COD_TYP_OPERAT='REPR'`). `SOLDPERI` (periodic balances) is ~38k off (dormant accounts) and NOT faster — do not use it.
- **Validation anchors** (openDate snapshot 2026-05-12, no active profile, central agency code empty → all agencies in scope):
  - overview `totalLoanAmount` = `3,168,068,640`
  - overview `totalSavingsAmount` = `3,287,594,852`
  - A07 savings detail total = `689,974,992`
  - `agencyPerformance` must match the original query row-for-row (per agency).

## Work log

### 2026-06-03 - Codex

- Created this shared memory file and handoff protocol.
- Current task from user:
  - Secure all settings mutations with admin PIN.
  - Fix the three lint issues.
  - Apply cache and SQL scope to heavy detail routes.
  - Document all work here for Claude/Codex handoff.

### 2026-06-03 - Codex - hardening pass

- Read shared memory first, then checked Git status on branch `codex/statis-v3`.
- Secured persistent settings mutations with the admin unlock cookie:
  - `app/api/settings/agency-profiles/route.ts`
  - `app/api/settings/sql/route.ts`
  - `app/api/settings/agence-faitiere/route.ts`
  - `app/api/settings/branding/route.ts`
  - shared helper added in `lib/agency-profiles.ts`
- Scope note:
  - `app/api/settings/admin-pin/route.ts` already protects PIN changes when a PIN exists.
  - `app/api/settings/agency-profiles/activate/route.ts` was left under profile PIN protection because it only changes the active profile cookie and does not persist settings.
- Fixed the three lint issues in `components/resultat-ledger-client.tsx`:
  - stabilized `detailHref` with `useCallback`
  - removed the synchronous state update in `useEffect`
  - escaped the JSX apostrophe.
- Added SQL cache and SQL-level agency perimeter to heavy detail routes:
  - generic `app/api/detail/[indicator]/route.ts` now caches by indicator, agency scope, and historical date.
  - generic detail SQL now applies agency scope in heavy CTEs/final agency selects where possible.
  - per-agency heavy routes `encours-credit` and `encours-epargne` now use `sqlCache` with `refresh` bypass support.
- Verification commands run successfully:
  - `git diff --check`
  - `.\.tools\node-v22.16.0-win-x64\node.exe .\node_modules\eslint\bin\eslint.js .`
  - `.\.tools\node-v22.16.0-win-x64\node.exe .\node_modules\next\dist\bin\next build`
- No known failing checks remain after this pass.

### 2026-06-03 - Claude - dashboard indicators not loading + savings + savings detail

User report: the dashboard could not load any indicator (it showed the "Connexion impossible" panel).

Root cause: the `/api/dashboard` `overview` query was a ~25-CTE monolith that timed out at the 300s requestTimeout. Because the endpoint ran all queries under `Promise.all`, that single failure 500'd the whole response, so NO indicator rendered even though the 4 other indicators succeeded. Contributing factors: CTE re-evaluation and no-op `COLLATE` on join keys (see "SQL performance knowledge" above).

Changes (all committed in `2d4dcc2` together with Codex's hardening; working tree clean):
- `lib/dashboard-overview.ts` (NEW): split `overview` into 8 independent parallel blocks; #temp materialization for the loan portfolio (>5min → ~22s); de-collated treasury/result/tontine. Exports `OVERVIEW_PARTS`, `OVERVIEW_DEFAULTS`, `SAVINGS_SQL`.
- `app/api/dashboard/route.ts`: resilient parallel runner `runQueryBlock` (per-block timeout + `request.cancel()`, graceful degradation, partial results NOT cached); `agencyPerformance` rewritten with #temp (95s → ~28s); savings computed **non-blocking in the background** via `triggerSavingsCompute` and overlaid from its own 6h cache via `sqlCachePeek` (so the dashboard stays ~25-30s and never waits ~170s on savings).
- `lib/sql-cache.ts`: added `{ forceRefresh }` option to `sqlCache` (anti-stampede — concurrent `refresh=1` now coalesce onto one in-flight run) and `sqlCachePeek` (read cache without triggering a compute).
- `app/api/detail/encours-epargne/[agencyCode]/route.ts`: was ALSO timing out at 300s. Rewrote the query — universe materialized once in #temp (was recomputed 3×), single HDPM scan for monthly movements (was two: balance + trend), de-collated. Kept the `sqlCache` wrapper Codex added.

Results (validated against STATISDATA):
- `/api/dashboard`: 200 with all indicators, ~25-30s cold then cached 4 min (was 500/timeout).
- Savings card: shows `3,287,594,852` after the first ~3 min background compute, then instant (cached 6h). Shows "À calculer" only until that first compute lands (or after server restart / 6h expiry).
- A07 savings detail: 200 in ~62s cold (largest agency, 33k accounts) then ~2.5s cached (was 300s timeout). total 689,974,992 = sum of its 7 product rows.
- `tsc --noEmit` and `eslint` on the changed files: clean.

Remaining / next steps:
- Detail savings cold load is ~62s for the largest agency (inherent HDPM replay over 33k accounts); cached afterward. Could add a longer detail TTL or a nightly precompute of savings balances if a faster first paint is wanted.
- Other generic/detail endpoints not yet audited for the COLLATE / #temp rules above.
- Verified via the running dev server on :3000 (Turbopack hot-reloaded the changes); did not re-run `next build` this pass — recommend a `next build` before any release.
