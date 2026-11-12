# Night Audit V2 — 2026-11-12

This replaces the old checklist UI and retired mutation API. Existing closed
audits are retained. The user approved **Run now only**, with scheduling deferred,
and **staff decisions for no-shows**, not automatic no-show/cancellation/fees.

## Workflow

1. Open Night Audit and confirm the business date. The page previews existing
   stay invoices, actual payments on that date, operational blockers and warnings.
2. Resolve arrivals/checkouts and housekeeping. Due arrivals remain blockers until
   staff decide what happened; the audit never changes reservation status itself.
3. Compare actual guest receipts against external cash-receipt counts, successful
   terminal receipts/batch reports and bank evidence. Enter verified amounts by
   payment method and currency, a note/reference and confirmation. No card numbers,
   CVV, bank login or statement import is required or implemented.
4. Unchecked receipt groups block close. Differences require an explanation and
   remain blockers; only Owner/Admin can approve an eligible exception with a
   reason. Missing accommodation invoices cannot be overridden. Complimentaries
   also need a zero-value issued accommodation line for traceability.
5. Confirm readiness and select **Run Night Audit**. One per-property MongoDB
   transaction rechecks permissions/day/blockers, records allocations of existing
   billed stay charges, saves six reports and closes the day/advances by one day.
   A blocked run returns the fix list without closing. A technical failure rolls
   back the pack and close. There is no live progress claim for uncommitted work.
6. Finance or Owner/Admin opens a completed day, checks its reports/evidence and
   saves Reviewed or Flagged. Completion and verification remain separate. Review
   does not reopen, edit or postpone hotel operations. The runner/reviewer/time,
   latest note and append-only review history are visible. Owner/Admin may verify
   their own run as expressly requested; the UI identifies the same person.

## Roles

| Role | Run / save receipt checks | Override eligible blockers | Verify completed day |
|---|---|---|---|
| Owner / Administrator | Yes | Yes, reason required | Yes |
| Front Desk with Run Night Audit permission | Yes | No | No |
| Finance | No | No | Yes |
| Ordinary Front Desk, Housekeeping, general member, Demo | No | No | No |

Permissions are checked server-side and again inside the transaction using fresh
membership. Existing Front Desk permission grant/removal UI is retained. Old
`review`, `post-room-revenue`, `generate-reports`, `notes`, `complete`, etc. URLs
cannot bypass the new runner. `routes/night-audit.js` is only a compatibility
import of V2; app.js mounts V2 directly.

## Charge accounting and boundaries

- Existing issued guest invoices remain the **single billing/accounting source**.
  The audit does not append the full stay or a second night's bill to those
  invoices and creates no `night_audit` Money In/revenue transaction.
- The new service-day report allocates the accommodation and meal components of
  those invoices across their invoiced stay dates. Day-use gets one allocation on
  its arrival date. Net/tax/remainder cents are retained; invoice-level credits
  are apportioned proportionally, with deterministic cent distribution. These
  are **allocations of already billed amounts**, not a second ledger or new
  earned-revenue journal. Invoice dates/recognized-revenue timing elsewhere in the
  PMS are not migrated to a new accrual/general-ledger model by this change.
- No full-bill fallback is used when rates/invoices are missing. A missing issued
  accommodation invoice blocks close. An extension outside the invoiced stay
  therefore needs the appropriate invoice correction/additional invoice first.
- An old artificial Night Audit transaction on the **current open day** is voided
  inside a successful replacement run, with a reason/audit trail. No direct edit
  of the original amount is made. Previously closed legacy days/reports are not
  silently rewritten or mass-corrected. They are labeled historical in the UI.
- This fixes new Night Audit double posting and fake-cash behavior. It is not a
  historical ledger migration or a complete redesign of other financial reports.

## Payments and housekeeping

- Receipts come from actual payment `posted_at` dates within the hotel's local
  calendar day. They are grouped by currency/method; currencies are never summed
  together. Original received payments later marked refunded remain receipts;
  completed refund/outflow transactions are shown separately.
- Recorded payments out and unused advance returns are separate totals, not
  guest deposits or revenue. All-date unpaid issued-invoice balances include
  checked-out guests and future bookings and are labeled accordingly. They are
  not today's receipts; an unpaid balance alone is not a blocker.
- Manual verification compares **receipts**, not total cash-drawer/bank balances.
  Opening funds, cash withdrawals and payouts must also be considered for an
  external drawer/bank reconciliation. No live bank/POS reconciliation is claimed.
- Payment evidence is fingerprinted. New/changed payments invalidate previous
  checks. Overrides bind to the issue context; changed payment evidence invalidates
  financial exceptions too. Actual amounts are never auto-filled as checked.
- Dirty/in-progress housekeeping is a blocker; out-of-order/maintenance is a
  warning. Owner/Admin may document a dirty-room exception; this never marks a
  room clean or changes its availability. Reservation exceptions likewise do not
  check guests in/out or mark them no-show.
- Backlogged business dates close one at a time. Receipt dates are historical;
  operational checks use the reservation/invoice/room records currently saved.
  Missing historical room-state changes cannot be reconstructed automatically.
  A future business date cannot close.

## Frozen report pack

Six reports are persisted with rows, metadata, audit ID and generation identity:
Daily overview; Payments received; Billed stay charges by service day; Room and
housekeeping status; Reservation status; Outstanding guest invoices. These reuse
the existing report-type catalog, while their audit-specific titles and source
rows make their scope explicit. Reports are viewable and exportable as CSV.

The pack and close summary are frozen at commit. Reading a report never regenerates
it from changed reservations/payments. Historical V1 packs may only contain their
original summary metadata. Scoped audit-report access lets Finance inspect the
whole audit pack without granting unrelated operational module access.

## API

- GET `/api/night-audit/current`, `/history`, `/:auditId`
- POST `/current/reconciliation`: audit_id, payment fingerprint, every receipt
  group's key/actual/note/confirmed
- POST `/current/override`: audit_id, exception_id, context_hash, reason
- POST `/current/run`: audit_id, confirmed:true, optional close_note
- POST `/:auditId/finance-review`: version, reviewed/flagged, note, confirmed:true
- GET `/:auditId/reports/:reportId`

All calls use the existing JWT/property context. Run/reconciliation/override
submit the displayed audit ID, so a stale retry cannot close the next business
date. Concurrent runs serialize via the inventory guard. Report rows, audit
closure and date advance commit together. Verification uses document versioning
and preserves review history.

## Manual acceptance walkthrough

Use a test hotel: running an audit advances its actual business date.

1. Restart backend and refresh frontend. Owner/Admin opens Night Audit. Grant a
   test Front Desk account Run Night Audit, then use a private browser to log in.
2. Create/check in a test stay with an issued accommodation invoice. Create a
   same-day checked-out day-use stay if testing that path. Confirm the charge
   summary uses invoice lines/tax, and has no new Money In entry.
3. Record a guest payment today with a receipt reference. Refresh audit. Under
   Payment checks enter the actual receipt amount, note/reference and confirmation.
   Save; a matching amount clears that blocker. No payment means no manual check.
4. Enter a different amount plus a reason. Save; the difference blocks close.
   Front Desk cannot approve it. Owner/Admin can document an exception.
5. Leave an arrival unresolved or a room dirty. Confirm the fix list, relevant-page
   links and Owner/Admin-only exception control. Completing/approving a room
   exception must not magically clean that room.
6. Confirm the date, add an optional handover note and Run Night Audit. If blocked,
   fix and retry. When successful, inspect Completed/Pending review, six saved
   reports, runner/time and the next business date. Try a stale second-tab run:
   it must fail rather than close the next day or duplicate reports/charges.
7. Log in as Finance; open the completed day. Review the frozen reports, then save
   Reviewed or Flagged with confirmation (flag requires a note). Owner/Admin can
   also do this. Front Desk cannot verify. Confirm verification history and that
   the business date/closed figures do not change.
8. Change a live payment after close and reopen its saved audit report: the frozen
   rows must remain unchanged. For an open audit, add a new payment after checks:
   refresh and confirm the verification is required again.

## Validation

- Full backend suite: **282 passed**, including V2 allocation/rounding/currency
  tests and the updated Owner/Admin verification permission expectations.
- `node scripts/live-night-audit-v2-smoke.js`: **66 authenticated MongoDB/API
  checks passed**. Operational blockers, non-overridable missing accommodation
  invoices, manual receipt evidence, stale evidence, differences/overrides,
  timezone/currencies, tax/day-use allocation, failed-report rollback, concurrent
  close, no duplicate billing/cash, frozen rows, stale/repeated requests,
  Owner/Admin/Finance verification, access revocation, legacy open-day correction
  and future-day rejection are covered. All disposable fixtures were removed and
  cleanup verified. The injected report failure in its output is intentional.
- Frontend TypeScript and diff whitespace checks passed.
- Isolated browser walkthrough passed using mocked API responses (no existing
  hotel records changed): receipt checks, Owner exception, Front Desk run,
  failure/retry, frozen-report display, Finance/Admin verification, role controls
  and desktop/light/dark/mobile layout. Screenshots/harness are in
  `tmp/night-audit-v2-preview/` and `tmp/night-audit-v2-preview.cjs`.

The old `scripts/live-night-audit-smoke.js` and V1 documentation describe retired
endpoints. Use the V2 script and this guide for current acceptance testing.
