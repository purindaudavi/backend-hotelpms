# Live property activity history

Implemented 2026-11-12. Settings → Activity Logs now reads existing MongoDB
`booking_audit_logs` records instead of the seven hardcoded sample events.

## Access and behavior

- Only the property's Owner and Administrator can open the page or use either
  API. Front Desk, Housekeeping, Finance, general members and public Demo cannot.
- Each API call checks authenticated membership in an active hotel. Query/header
  property conflicts are rejected by the existing property access middleware.
  Removing staff access takes effect on subsequent requests, including exports.
- Records show the saved actor's name/email, timestamp in the hotel's timezone,
  module, action, description and expandable before/after field comparisons.
  Historical actor snapshots remain available after a user changes or leaves.
- Missing comparisons are identified; the page does not invent them. Platform
  (WEB/API) and actor role are not consistently stored, so neither is fabricated.
- Search matches description/action/actor name/email as literal text; the User
  filter matches saved name/email/user ID. Module, exact action (API) and inclusive
  hotel-local From/To date filters are supported. From/To validates real dates.
- Newest first with `_id` as a deterministic timestamp tie breaker. The page loads
  50 events at a time; the API allows 1–100 and bounded page numbers. A compound
  `{property_id, created_at: -1, _id: -1}` index supports browsing.
- Refresh is manual or every 30 seconds while the tab is visible. Focus/visibility
  return refreshes too; requests do not overlap and are aborted when filters or
  the property change. Auto-refresh can be switched off.
  A denied/expired session clears previously displayed history.
- CSV exports **all matching events**, independent of the displayed page, up to
  5,000. Larger exports require narrower filters and return an explicit error.
  CSV includes UTC and hotel-local timestamps and escapes spreadsheet formulas.
- The page/API offers no edit/delete endpoint. Browsing/exporting does not alter
  bookings, finances or history. Responses are private/no-store. Field details
  omit credential keys and uploaded binary content and bound nested snapshots.
- Open Night Audit now navigates to the actual Night Audit page; the former
  inactive “Night Audit Process” button was removed.

## Coverage boundary

The page reads events **already written by the application**: reservations,
business blocks, invoices/credits/refunds, financial transactions, bills/expenses,
withdrawals, money requests/opening balances, housekeeping, travel agents,
financial targets, property changes/access and Night Audit, where the relevant
workflow writes an audit event. Document creation and its financial transaction
can be separate, valid events; this is activity history, not a cash/revenue sum.

This change does not add logging to every system action, including all room/rate
edits, logins, failed attempts or local-only Employee/Data Import screens. It does
not reconstruct missing historical activity or connect production OTA services.
It preserves the application-written audit history; it is not an externally
tamper-evident compliance archive.

## Manual testing

1. Restart the backend (`npm run dev`) and refresh the frontend. Sign in as an
   Owner/Admin and open **Settings → Activity Logs**.
2. On a test property, edit an existing reservation's remarks and save. Return to
   Activity Logs and press Refresh (or wait up to 30 seconds). Check the actor,
   description, timestamp and expandable saved changes.
3. Perform a housekeeping request/assignment/completion with authorized staff.
   Filter Module to Housekeeping and verify the user who performed each action.
4. Search by a reservation/document reference in its description, then by the
   actor's email. Select From/To to the same hotel-local calendar date. Clear
   filters to restore the list; try a search with no matches.
5. If there are more than 50 events, test Next/Previous. Events with identical
   timestamps should retain their order. CSV exports all matches, not just page 1.
6. Download CSV and confirm the current filters and hotel timezone match. Open
   Night Audit to confirm navigation without running/closing an audit.
7. In a private browser session, use Front Desk/Housekeeping/Finance/member access
   and paste the Activity Logs URL. Expect Access restricted. Another hotel's
   Owner cannot access this hotel's API or export either.
8. Create a recorded action in another tab. The visible log page should refresh
   automatically; disable Auto-refresh to stop polling. Disconnect/reconnect the
   backend and use Refresh to verify the error/retry state.

## Files and automated verification

- Backend: `routes/activity-logs.js`, `services/activity-log.service.js`, route
  registration, role middleware and audit model index.
- Frontend: `app/components/modules/settings/activitylogs.tsx`, ModuleContent
  property ID wiring and `app/lib/property-permissions.ts`.
- `node --test`: 280 passed, including literal search, date boundaries/DST,
  redaction, formula-safe CSV, role isolation, pagination and export bounds.
- `node scripts/live-activity-logs-smoke.js`: 41 authenticated MongoDB/API checks
  passed. All prefixed disposable users/properties/attendants/logs removed and
  cleanup verified. No existing hotel records changed.
- Frontend TypeScript passed. Isolated Chrome checks and visual inspection passed
  for desktop/light/dark/mobile, pagination, user/search/module filters, saved
  comparisons, CSV download/limit error, empty/error/retry states, hidden-tab and
  disabled polling, refresh on visibility return, revoked-access clearing and
  Owner/Admin versus four denied staff roles. Screenshots are in
  `tmp/activity-logs-preview/`; mocked API only, no existing hotel data changed.
