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
