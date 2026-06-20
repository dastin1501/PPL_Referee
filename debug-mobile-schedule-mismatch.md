# Debug Session: mobile-schedule-mismatch

- Status: OPEN
- Scope: `PPL Referee` mobile app schedule/match mismatch against website source of truth
- Tournament sample: `PPL Pampanga LIGLIGAN 2026`

## Symptoms

- Mobile app shows matches that do not match the website schedule/brackets.
- Mobile app may show wrong date, court, or match list for the selected filters.
- Expected behavior: mobile must only show the same matches as the website/backend for the selected tournament, date, court, venue, and status.

## Hypotheses

1. Mobile fetches referee matches with wrong or incomplete request params.
2. Mobile cache or merge logic reintroduces stale matches after fresh fetch.
3. Mobile date normalization or timezone parsing maps matches to the wrong day.
4. Raw tournament match data overrides the scheduled endpoint response.
5. Status filtering logic allows ghost matches to appear in the wrong tab.

## Investigation Plan

1. Identify exact mobile API calls and request params.
2. Instrument request/response and local merge/filter path.
3. Reproduce and collect runtime evidence.
4. Confirm root cause from logs.
5. Apply minimal fix.
6. Verify post-fix behavior against website/backend.

## Evidence Collected

- `ApiService.getScheduledMatches()` uses:
  - `GET /api/tournaments/<tournamentId>/referee/matches`
  - query params: `date`, `court`, hardcoded `status=Scheduled`, `page`, `limit`
  - no `venue` param
- Backend probe against local API for tournament `6950d3443835511ba7ab13a8` returned:
  - `Cannot GET /api/tournaments/6950d3443835511ba7ab13a8/referee/matches`
- Tournament detail payload for `PPL Pampanga LIGLIGAN 2026 (Luzon Leg)` shows:
  - active `courtAssignments.scheduleDate = 2026-03-15`
  - historical `courtAssignmentsByDate` keys include `2026-02-28`, `2026-03-01`, `2026-03-15`
- Mobile code previously auto-picked the earliest available date for a court and also allowed raw match schedule fields to survive even when the website schedule grid was authoritative.

## Confirmed Root Cause

1. Mobile tried to use a filtered referee matches endpoint that is not available in the current local backend.
2. When that endpoint failed, mobile silently fell back to the full tournament detail payload already in memory.
3. In that fallback path, stale schedule fields and earliest-date auto-pick caused ghost matches and wrong date/court views.

## Fix Applied

1. Treat website `courtAssignments` / `courtAssignmentsByDate` as authoritative in mobile parsing.
2. Clear stale schedule fields from matches not present in the authoritative website schedule grid.
3. Prefer the website's active `scheduleDate` as the mobile default selected date.
4. Reset scheduled queue ETag when tournament/date/court changes to avoid stale reuse across contexts.
