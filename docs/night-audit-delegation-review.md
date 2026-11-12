# Night Audit delegation and Finance review

> Historical V1 reference. The workflow and permission details below were
> superseded on 2026-11-12 by [Night Audit V2](NIGHT_AUDIT_V2.md), including
> Owner/Admin verification, single-run close and the accounting correction.

Implemented on 2026-10-30. This supersedes the earlier Finance read-only Night Audit screen in `finance-role.md`.

## Permissions and workflow

- Owner and Administrator can run Night Audit using the existing detailed screen and approve documented blocker overrides.
- Owner/Admin can enable **Run Night Audit** on an existing Front Desk member in **Settings → Users & access**. It is property-specific, defaults off, and is cleared when the member changes role or loses access.
- A designated Front Desk employee gets the same detailed audit screen, including evidence, exceptions, notes, revenue posting, report generation and completion. They cannot override blockers. Ordinary Front Desk employees cannot open or run Night Audit.
- Finance gets the same detailed layout, with operational changes disabled. They select a completed date under **Previous Closes** and save **Reviewed** or **Flagged**, with notes. A flagged review requires an explanation.
- Housekeeping, Demo and legacy General member accounts cannot run Night Audit. General member broad legacy access no longer bypasses Night Audit's explicit permission boundary.
- No new role was added. Finance cannot close, post through Night Audit, override, reopen or edit a closed day. Owner/Admin see review outcomes but Finance records the review.

Audit status stays **Open / Closed**. Finance review is independently **Pending Review / Reviewed / Flagged**. Completing an audit advances the property's business date in the same transaction; pending or flagged review never delays the next day.

The closed audit stores who completed it and when, its close summary, reports and handover note. Review events append outcome, note, verified actor and timestamp; the latest outcome and reviewer are also shown. Re-review preserves earlier review events.

## Safeguards

Audit writes, permission toggles and membership changes use the existing per-property inventory transaction guard. Audit actions submit the displayed `audit_id`. Retrying an old close receives a conflict instead of closing the next day. Revenue and report creation are serialized so duplicate requests do not create duplicate batches. Permissions and the current day are checked again inside the transaction; the response is sent only after commit.

Finance reviews only closed audits of the authorized property and submits the displayed document version. An outdated review receives a conflict; reopen the completed date and review again. Review does not update the property's date, completion identity, close summary, close notes, revenue or underlying money records.

## Step-by-step manual test

Use a disposable test property. Completing an audit advances its business date.

1. Sign in as Owner/Admin. Open **Settings → Users & access**. Give a registered account the Front Desk role, then tick **Run Night Audit** on that member. Give a different registered account the Finance role.
2. In another browser profile/private window, sign in as that Front Desk employee and reload the workspace. **Night Audit** should appear in the sidebar. A Front Desk employee without the checkbox should not see it and a direct URL should show restricted access.
3. Open Night Audit. Confirm its business date and compare the detailed layout with Owner/Admin. Evidence, exceptions, metrics, reports, notes and history should match the same property/day.
4. Try completing an unfinished audit: completion stays disabled. Resolve overdue arrivals/no-shows and due departures through reservation operations, and complete dirty/in-progress housekeeping work through authorized staff. Front Desk cannot bypass blockers; Owner/Admin alone can approve a documented override when appropriate.
5. Mark Front Desk and payment reconciliation checks reviewed, acknowledge any warnings, post room revenue, review housekeeping and generate reports. The disconnected Channel Manager check remains disabled and not required. No live OTA reconciliation is implied.
6. Enter a handover note and save it. Complete the audit and confirm the date. The property should immediately open the next business day. The completed date appears in **Previous Closes** with the runner and **Finance: Pending Review**.
7. Open the same audit in two tabs before closing if testing concurrency. Once one tab closes it, the second tab's stale action must receive a refresh/conflict message. The business date must advance only once. Repeat report/post actions before close and confirm there is only one report pack/revenue posting for that audit.
8. Sign in as Finance. Open **Night Audit**, select the completed date under **Previous Closes**, inspect the same evidence and download the stored audit snapshot. There should be no posting, completion, override or close-note editing controls.
9. Select **Flagged**, explain a discrepancy and save. Owner/Admin should see the flag in that date's detail/history after reload. The next business day remains usable.
10. After resolving the discrepancy through the appropriate authorized workflow, reopen that completed audit as Finance, select **Reviewed**, add a note and save. The reviewer/time and both events should appear under **Review history**. The closed summary, completion actor and business date must remain unchanged.
11. Test stale review: open the same completed audit in two Finance tabs. Save in one, then save the other. The second receives a conflict and must reopen the record.
12. Untick the employee's permission as Owner/Admin. Their next audit request must be denied, even with the old page open. Reload hides Night Audit. Changing that employee to another role and back does not restore the checkbox automatically.
13. Repeat a full close as Owner/Admin on another test date. The same required checks, report pack and next-day advancement should work. Test an Owner/Admin override with a meaningful reason; verify Front Desk cannot perform it.

## Automated checks

Verified: **253 backend tests**, **63 live MongoDB/API checks**, frontend
TypeScript compilation and isolated desktop/mobile browser checks passed.
Disposable database fixtures were removed. Existing user/property records were
not used for these tests.

- `npm test -- --test-reporter=dot`: includes model and role permission coverage.
- `node scripts/live-night-audit-smoke.js`: creates disposable users/property, exercises actual authenticated API routes and MongoDB transactions, concurrent reports/closes, positive revenue once, permission grant/revocation/role reset, owner/admin overrides, immutable Finance review and cleanup. Requires configured MongoDB transaction support.
- Frontend: `node node_modules/typescript/bin/tsc --noEmit --incremental false` from `D:\DMS new\new-pms`.
- Isolated browser helper under ignored `tmp/night-audit-preview.cjs` uses mocked API responses to check checkbox, shared Front Desk/Finance screens, controls and mobile overflow. Live API checks are separate.

## Scope and remaining limitations

This implements authorization, shared presentation, day closing and independent Finance review. Existing reservation-derived room revenue, balance calculations and report definitions were not redesigned into a general ledger, payment-gateway settlement or bank reconciliation system. Finance must still compare actual supporting records; a successful software close is not proof that every accounting figure is correct. The audit snapshot download is JSON and contains report references, not a new PDF report bundle. Real Channel Manager reconciliation remains unavailable.

Industry reference supplied by the user: [SiteMinder: Hotel night auditor](https://www.siteminder.com/r/hotel-night-auditor/) describes the combined overnight Front Desk, posting/checking and daily reporting responsibilities. The separate Finance review and delegated checkbox are this project's chosen workflow.
